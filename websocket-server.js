// ============================================================
//  LUNAFYRE SERVER v4.1 — SECURE EDITION
//  Server-authoritative validation, anti-cheat, rate limiting
// ============================================================

const express   = require('express');
const cors      = require('cors');
const http      = require('http');
const WebSocket = require('ws');

const app  = express();
const PORT = process.env.PORT || 8080;
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, perMessageDeflate: false });

// ── CONSTANTS ─────────────────────────────────────────────────
const MAX_PER_TEAM   = 25;
const TDM_TIME       = 1200;
const CTF_TIME       = 1080;
const TDM_WIN_SCORE  = 300;
const CTF_WIN_SCORE  = 10;
const TICK_MS        = 1000;
const STATE_THROTTLE = 33;

const STREAK_LABELS = {
  2 : 'DOUBLE KILL', 3 : 'TRIPLE KILL', 4 : 'QUAD KILL',
  5 : 'PENTA KILL', 7 : 'RAMPAGE', 10: 'GODLIKE',
};
const STREAK_RESET_MS = 4500;

// ── SECURITY CONSTANTS ────────────────────────────────────────
const MAX_KILL_RATE = 15;          // kills per 10s
const MAX_DAMAGE_PER_HIT = 200;
const MAX_SPEED = 5;               // tiles/frame
const MAX_BULLETS_PER_SEC = 20;
const CHEAT_BAN_THRESHOLD = 5;

// ── DATA ──────────────────────────────────────────────────────
const rooms   = new Map();
const clients = new Map();
const parties = new Map();
let roomSeq = 0;

// ── SECURITY ──────────────────────────────────────────────────
function createSecurityProfile() {
  return {
    killTimestamps: [], bulletTimestamps: [],
    lastPosition: null, lastPosTime: 0,
    violations: 0, banned: false,
  };
}

function checkKillRate(p) {
  const now = Date.now();
  p.killTimestamps = p.killTimestamps.filter(t => now - t < 10000);
  if (p.killTimestamps.length >= MAX_KILL_RATE) { p.violations++; return false; }
  p.killTimestamps.push(now);
  return true;
}

function checkBulletRate(p) {
  const now = Date.now();
  p.bulletTimestamps = p.bulletTimestamps.filter(t => now - t < 1000);
  if (p.bulletTimestamps.length >= MAX_BULLETS_PER_SEC) { p.violations++; return false; }
  p.bulletTimestamps.push(now);
  return true;
}

function checkSpeed(p, x, y) {
  const now = Date.now();
  if (!p.lastPosition || !p.lastPosTime) {
    p.lastPosition = { x, y }; p.lastPosTime = now; return true;
  }
  const dt = now - p.lastPosTime;
  if (dt < 16) return true;
  const dx = x - p.lastPosition.x, dy = y - p.lastPosition.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const speed = dist / (dt / 16);
  p.lastPosition = { x, y }; p.lastPosTime = now;
  if (speed > MAX_SPEED) { p.violations++; return false; }
  return true;
}

function checkDamage(dmg) {
  return dmg <= MAX_DAMAGE_PER_HIT;
}

function kickCheater(ws, sid, reason) {
  const c = clients.get(sid);
  if (!c) return;
  console.log(`🚫 KICKED: ${c.name} — ${reason}`);
  sendTo(ws, { type: 'kicked', reason });
  ws.close();
  removePlayerFromRoom(sid);
  clients.delete(sid);
}

// ── LEADERBOARD ───────────────────────────────────────────────
function buildLeaderboard(room) {
  const rows = [];
  for (const [, c] of room.players) {
    rows.push({
      id: c.playerId, name: c.name, team: c.team,
      kills: c.kills || 0, deaths: c.deaths || 0, captures: c.captures || 0,
    });
  }
  rows.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  return rows;
}

function broadcastLeaderboard(room) {
  broadcastRoom(room.id, {
    type: 'leaderboard', rows: buildLeaderboard(room),
    rScore: room.rScore, bScore: room.bScore,
  });
}

// ── ROOM LIFECYCLE ────────────────────────────────────────────
function createRoom(mode) {
  const id = `${mode.toUpperCase()}_${++roomSeq}`;
  const room = {
    id, mode, timeLeft: mode === 'ctf' ? CTF_TIME : TDM_TIME,
    rScore: 0, bScore: 0, red: new Map(), blue: new Map(),
    players: new Map(), interval: null, over: false, startTs: Date.now(),
  };
  rooms.set(id, room);
  room.interval = setInterval(() => tickRoom(room), TICK_MS);
  console.log(`🏟  Room created: ${id}`);
  return room;
}

function tickRoom(room) {
  if (room.over) return;
  room.timeLeft = Math.max(0, room.timeLeft - 1);
  broadcastRoom(room.id, { type: 'tick', t: room.timeLeft, rs: room.rScore, bs: room.bScore });
  if (room.timeLeft <= 0) endRoom(room, null);
}

function endRoom(room, winner) {
  if (room.over) return;
  room.over = true;
  clearInterval(room.interval);
  broadcastRoom(room.id, {
    type: 'game_over', winner, rs: room.rScore, bs: room.bScore,
    leaderboard: buildLeaderboard(room),
  });
  console.log(`🏁  ${room.id} ended: ${winner} R:${room.rScore} B:${room.bScore}`);
  setTimeout(() => {
    room.players.forEach((_, sid) => {
      const c = clients.get(sid);
      if (c) c.roomId = null;
    });
    rooms.delete(room.id);
  }, 30_000);
}

function findOrCreateRoom(mode, team) {
  for (const [, r] of rooms) {
    if (r.mode !== mode || r.over) continue;
    const tMap = team === 'red' ? r.red : r.blue;
    if (tMap.size < MAX_PER_TEAM) return r;
  }
  return createRoom(mode);
}

function addPlayerToRoom(room, sid, client) {
  room.players.set(sid, client);
  (client.team === 'red' ? room.red : room.blue).set(sid, client);
  client.roomId = room.id;
}

function removePlayerFromRoom(sid) {
  const c = clients.get(sid);
  if (!c || !c.roomId) return;
  const room = rooms.get(c.roomId);
  if (!room) { c.roomId = null; return; }
  room.players.delete(sid); room.red.delete(sid); room.blue.delete(sid);
  broadcastRoom(room.id, {
    type: 'player_left', playerId: c.playerId,
    redCount: room.red.size, blueCount: room.blue.size,
  });
  if (!room.over && room.players.size > 0) broadcastLeaderboard(room);
  c.roomId = null;
  if (room.players.size === 0 && !room.over) {
    clearInterval(room.interval);
    rooms.delete(room.id);
  }
}

// ── BROADCAST ─────────────────────────────────────────────────
function broadcastRoom(roomId, msg, excludeSid = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  const str = JSON.stringify(msg);
  for (const [sid, c] of room.players) {
    if (sid === excludeSid) continue;
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(str);
  }
}

function sendTo(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ── HTTP ──────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status: 'online', rooms: rooms.size, players: clients.size,
  uptime: process.uptime(), time: new Date().toISOString(),
}));

app.get('/api/stats', (req, res) => {
  const list = [];
  for (const [, r] of rooms) {
    list.push({
      id: r.id, mode: r.mode, red: r.red.size, blue: r.blue.size,
      timeLeft: r.timeLeft, rScore: r.rScore, bScore: r.bScore,
    });
  }
  res.json({ success: true, rooms: list, totalPlayers: clients.size });
});

// ── WEBSOCKET ─────────────────────────────────────────────────
wss.on('connection', ws => {
  const sid = Math.random().toString(36).slice(2, 12);
  clients.set(sid, {
    ws, sid, roomId: null, playerId: null, name: 'PLAYER', team: 'red',
    lastStateMs: 0, kills: 0, deaths: 0, captures: 0,
    streak: 0, lastKillMs: 0, security: createSecurityProfile(),
  });
  sendTo(ws, { type: 'connected', sid });
  ws.on('message', raw => { try { handleMsg(ws, sid, JSON.parse(raw)); } catch (e) {} });
  ws.on('close', () => { removePlayerFromRoom(sid); clients.delete(sid); });
  ws.on('error', () => { removePlayerFromRoom(sid); clients.delete(sid); });
});

// ── MESSAGE HANDLER ───────────────────────────────────────────
function handleMsg(ws, sid, msg) {
  const c = clients.get(sid);
  if (!c) return;
  if (c.security.banned) { ws.close(); return; }
  if (c.security.violations >= CHEAT_BAN_THRESHOLD) {
    c.security.banned = true;
    kickCheater(ws, sid, 'Multiple cheat detections');
    return;
  }

  switch (msg.type) {
    case 'quick_join': {
      if (c.roomId) {
        const room = rooms.get(c.roomId);
        if (room && !room.over) {
          sendTo(ws, {
            type: 'match_joined', roomId: room.id, team: c.team,
            timeLeft: room.timeLeft, rScore: room.rScore, bScore: room.bScore,
            mode: room.mode, redCount: room.red.size, blueCount: room.blue.size,
            leaderboard: buildLeaderboard(room),
          });
          return;
        }
        removePlayerFromRoom(sid);
      }
      const { mode = 'tdm', team = 'red', name = 'PLAYER', playerId, partyCode } = msg;
      c.playerId = playerId || sid;
      c.name = (name || 'PLAYER').slice(0, 16);
      c.team = team === 'blue' ? 'blue' : 'red';
      c.lastStateMs = 0;
      c.kills = 0; c.deaths = 0; c.captures = 0; c.streak = 0; c.lastKillMs = 0;
      let room = null;
      if (partyCode && parties.has(partyCode)) {
        const { roomId } = parties.get(partyCode);
        const pr = rooms.get(roomId);
        if (pr && !pr.over) {
          const tMap = c.team === 'red' ? pr.red : pr.blue;
          if (tMap.size < MAX_PER_TEAM) room = pr;
        }
      }
      if (!room) room = findOrCreateRoom(mode, c.team);
      if (partyCode) parties.set(partyCode, { roomId: room.id });
      addPlayerToRoom(room, sid, c);
      sendTo(ws, {
        type: 'match_joined', roomId: room.id, team: c.team,
        timeLeft: room.timeLeft, rScore: room.rScore, bScore: room.bScore,
        mode: room.mode, redCount: room.red.size, blueCount: room.blue.size,
        leaderboard: buildLeaderboard(room),
      });
      broadcastRoom(room.id, {
        type: 'player_joined', playerId: c.playerId, name: c.name, team: c.team,
        redCount: room.red.size, blueCount: room.blue.size,
      }, sid);
      console.log(`✅ ${c.name} [${c.team}] → ${room.id}`);
      break;
    }
    case 'create_party': {
      const code = Math.random().toString(36).slice(2, 8).toUpperCase();
      parties.set(code, { roomId: c.roomId || null });
      sendTo(ws, { type: 'party_created', code });
      break;
    }
    case 'ping': {
      sendTo(ws, { type: 'pong', ct: msg.ct });
      break;
    }
    case 'kill': {
      if (!c.roomId) break;
      const room = rooms.get(c.roomId);
      if (!room || room.over) break;
      if (!checkKillRate(c.security)) {
        kickCheater(ws, sid, 'Abnormal kill rate');
        break;
      }
      if (msg.team === 'red') room.rScore++; else room.bScore++;
      c.kills++;
      const now = Date.now();
      if (now - c.lastKillMs < STREAK_RESET_MS) c.streak++; else c.streak = 1;
      c.lastKillMs = now;
      const victim = [...room.players.values()].find(p => p.playerId === msg.vid);
      if (victim) { victim.deaths++; victim.streak = 0; }
      const streakLabel = STREAK_LABELS[c.streak] || null;
      broadcastRoom(room.id, {
        type: 'kill', kname: msg.kname, vname: msg.vname,
        kid: c.playerId, vid: msg.vid, team: msg.team,
        rs: room.rScore, bs: room.bScore, streak: c.streak, streakLabel,
      });
      broadcastLeaderboard(room);
      const winScore = room.mode === 'ctf' ? CTF_WIN_SCORE : TDM_WIN_SCORE;
      if (room.rScore >= winScore) endRoom(room, 'red');
      else if (room.bScore >= winScore) endRoom(room, 'blue');
      break;
    }
    case 'ctf_score': {
      if (!c.roomId) break;
      const room = rooms.get(c.roomId);
      if (!room || room.over) break;
      if (msg.team === 'red') room.rScore++; else room.bScore++;
      c.captures = (c.captures || 0) + 1;
      broadcastRoom(room.id, { ...msg, rs: room.rScore, bs: room.bScore });
      broadcastLeaderboard(room);
      if (room.rScore >= CTF_WIN_SCORE) endRoom(room, 'red');
      else if (room.bScore >= CTF_WIN_SCORE) endRoom(room, 'blue');
      break;
    }
    case 'player_died': {
      if (!c.roomId) break;
      c.deaths = (c.deaths || 0) + 1; c.streak = 0;
      const room = rooms.get(c.roomId);
      if (room && !room.over) broadcastLeaderboard(room);
      break;
    }
    case 'state': {
      if (!c.roomId) break;
      const now = Date.now();
      if (now - c.lastStateMs < STATE_THROTTLE) break;
      c.lastStateMs = now;
      if (msg.x !== undefined && msg.y !== undefined) {
        if (!checkSpeed(c.security, msg.x, msg.y)) {
          if (c.security.violations < 3) break;
          kickCheater(ws, sid, 'Speed hack detected');
          break;
        }
      }
      broadcastRoom(c.roomId, msg, sid);
      break;
    }
    case 'bullet': {
      if (!c.roomId) break;
      if (!checkBulletRate(c.security)) {
        kickCheater(ws, sid, 'Rapid fire detected');
        break;
      }
      if (msg.dmg && !checkDamage(msg.dmg)) {
        kickCheater(ws, sid, 'Invalid damage value');
        break;
      }
      broadcastRoom(c.roomId, msg, sid);
      break;
    }
    case 'hit': {
      if (!c.roomId) break;
      if (msg.dmg && !checkDamage(msg.dmg)) {
        c.security.violations++;
        break;
      }
      broadcastRoom(c.roomId, msg, sid);
      break;
    }
    case 'leave':
    case 'bye': {
      removePlayerFromRoom(sid);
      break;
    }
    default: {
      if (c.roomId) broadcastRoom(c.roomId, msg, sid);
      break;
    }
  }
}

// ── START ─────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════╗
║    LUNAFYRE SERVER v4.1 — SECURE EDITION          ║
║  Port      : ${PORT.toString().padEnd(4)} │ Anti-Cheat: ENABLED       ║
║  Max Speed : ${MAX_SPEED} t/f │ Max Damage: ${MAX_DAMAGE_PER_HIT}            ║
╚═══════════════════════════════════════════════════╝
  `);
});

process.on('SIGTERM', () => {
  wss.clients.forEach(c => c.close());
  server.close(() => process.exit(0));
});
