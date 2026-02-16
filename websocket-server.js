// ============================================================
//  LUNAFYRE SERVER v3.0 — MATCHMAKING EDITION
//  Server-authoritative timer, scores, auto-room, party system
// ============================================================

const express = require('express');
const cors    = require('cors');
const http    = require('http');
const WebSocket = require('ws');

const app  = express();
const PORT = process.env.PORT || 8080;
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
// perMessageDeflate: false — lower CPU, lower latency for small frames
const wss = new WebSocket.Server({ server, perMessageDeflate: false });

// ── CONSTANTS ─────────────────────────────────────────────────
const MAX_PER_TEAM   = 25;
const TDM_TIME       = 1200;   // 20 min in seconds
const CTF_TIME       = 1080;   // 18 min in seconds
const TDM_WIN_SCORE  = 300;
const CTF_WIN_SCORE  = 10;
const TICK_MS        = 1000;   // server timer tick
const STATE_THROTTLE = 50;     // ms between state relays per player (anti-flood)

// ── DATA ──────────────────────────────────────────────────────
// rooms: id → { id, mode, red, blue, players, timeLeft, rScore, bScore, interval, over, startTs }
const rooms   = new Map();
// clients: sid → { ws, sid, roomId, playerId, name, team, lastStateMs }
const clients = new Map();
// parties: code → { roomId }   (set when first member joins a room)
const parties = new Map();

let roomSeq = 0;

// ── ROOM LIFECYCLE ────────────────────────────────────────────
function createRoom(mode) {
  const id   = `${mode.toUpperCase()}_${++roomSeq}`;
  const room = {
    id, mode,
    timeLeft : mode === 'ctf' ? CTF_TIME : TDM_TIME,
    rScore: 0, bScore: 0,
    red    : new Map(),   // sid → client ref
    blue   : new Map(),
    players: new Map(),   // sid → client ref (all)
    interval: null,
    over    : false,
    startTs : Date.now(),
  };
  rooms.set(id, room);
  room.interval = setInterval(() => tickRoom(room), TICK_MS);
  console.log(`🏟  Room created: ${id}`);
  return room;
}

function tickRoom(room) {
  if (room.over) return;
  room.timeLeft = Math.max(0, room.timeLeft - 1);
  broadcastRoom(room.id, {
    type: 'tick',
    t : room.timeLeft,
    rs: room.rScore,
    bs: room.bScore
  });
  if (room.timeLeft <= 0) endRoom(room, null);
}

function endRoom(room, winner) {
  if (room.over) return;
  room.over = true;
  clearInterval(room.interval);
  broadcastRoom(room.id, {
    type  : 'game_over',
    winner,
    rs    : room.rScore,
    bs    : room.bScore
  });
  console.log(`🏁  Room ended: ${room.id} winner=${winner} R:${room.rScore} B:${room.bScore}`);
  // Disassociate players, then remove room after 30 s
  setTimeout(() => {
    room.players.forEach((_, sid) => {
      const c = clients.get(sid);
      if (c) c.roomId = null;
    });
    rooms.delete(room.id);
    console.log(`🗑   Room removed: ${room.id}`);
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

  room.players.delete(sid);
  room.red.delete(sid);
  room.blue.delete(sid);

  broadcastRoom(room.id, {
    type     : 'player_left',
    playerId : c.playerId,
    redCount : room.red.size,
    blueCount: room.blue.size,
  });

  c.roomId = null;

  if (room.players.size === 0 && !room.over) {
    clearInterval(room.interval);
    rooms.delete(room.id);
    console.log(`🗑   Empty room removed: ${room.id}`);
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

// ── HTTP ROUTES ───────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status : 'online',
  rooms  : rooms.size,
  players: clients.size,
  uptime : process.uptime(),
  time   : new Date().toISOString(),
}));

app.get('/api/stats', (req, res) => {
  const list = [];
  for (const [, r] of rooms) {
    list.push({
      id: r.id, mode: r.mode,
      red: r.red.size, blue: r.blue.size,
      timeLeft: r.timeLeft, rScore: r.rScore, bScore: r.bScore,
    });
  }
  res.json({ success: true, rooms: list, totalPlayers: clients.size });
});

// ── WEBSOCKET ─────────────────────────────────────────────────
wss.on('connection', ws => {
  const sid = Math.random().toString(36).slice(2, 12);
  clients.set(sid, { ws, sid, roomId: null, playerId: null, name: 'PLAYER', team: 'red', lastStateMs: 0 });

  sendTo(ws, { type: 'connected', sid });

  ws.on('message', raw => {
    try { handleMsg(ws, sid, JSON.parse(raw)); }
    catch (e) { /* ignore malformed */ }
  });

  ws.on('close', () => {
    removePlayerFromRoom(sid);
    clients.delete(sid);
  });

  ws.on('error', () => {
    removePlayerFromRoom(sid);
    clients.delete(sid);
  });
});

// ── MESSAGE HANDLER ───────────────────────────────────────────
function handleMsg(ws, sid, msg) {
  const c = clients.get(sid);
  if (!c) return;

  switch (msg.type) {

    // ── MATCHMAKING ─────────────────────────────────────────
    case 'quick_join': {
      if (c.roomId) {
        // Re-join after reconnect — just confirm and resend match state
        const room = rooms.get(c.roomId);
        if (room && !room.over) {
          sendTo(ws, {
            type    : 'match_joined',
            roomId  : room.id,
            team    : c.team,
            timeLeft: room.timeLeft,
            rScore  : room.rScore,
            bScore  : room.bScore,
            mode    : room.mode,
            redCount : room.red.size,
            blueCount: room.blue.size,
          });
          return;
        }
        removePlayerFromRoom(sid);
      }

      const { mode = 'tdm', team = 'red', name = 'PLAYER', playerId, partyCode } = msg;
      c.playerId   = playerId || sid;
      c.name       = (name || 'PLAYER').slice(0, 16);
      c.team       = team === 'blue' ? 'blue' : 'red';
      c.lastStateMs = 0;

      // Party matching
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

      // Register party if code given
      if (partyCode) parties.set(partyCode, { roomId: room.id });

      addPlayerToRoom(room, sid, c);

      sendTo(ws, {
        type    : 'match_joined',
        roomId  : room.id,
        team    : c.team,
        timeLeft: room.timeLeft,
        rScore  : room.rScore,
        bScore  : room.bScore,
        mode    : room.mode,
        redCount : room.red.size,
        blueCount: room.blue.size,
      });

      broadcastRoom(room.id, {
        type     : 'player_joined',
        playerId : c.playerId,
        name     : c.name,
        team     : c.team,
        redCount : room.red.size,
        blueCount: room.blue.size,
      }, sid);

      console.log(`✅ ${c.name} [${c.team}] → ${room.id}  R:${room.red.size} B:${room.blue.size}`);
      break;
    }

    // ── PARTY ───────────────────────────────────────────────
    case 'create_party': {
      const code = Math.random().toString(36).slice(2, 8).toUpperCase();
      // Register without a room yet; room is assigned on quick_join
      parties.set(code, { roomId: c.roomId || null });
      sendTo(ws, { type: 'party_created', code });
      break;
    }

    // ── LATENCY PROBE ───────────────────────────────────────
    case 'ping': {
      sendTo(ws, { type: 'pong', ct: msg.ct });
      break;
    }

    // ── SCORE AUTHORITY ─────────────────────────────────────
    case 'kill': {
      if (!c.roomId) break;
      const room = rooms.get(c.roomId);
      if (!room || room.over) break;
      if (msg.team === 'red') room.rScore++;
      else room.bScore++;
      // Broadcast the kill + authoritative scores to EVERYONE (including killer)
      broadcastRoom(room.id, {
        type  : 'kill',
        kname : msg.kname,
        vname : msg.vname,
        team  : msg.team,
        rs    : room.rScore,
        bs    : room.bScore,
      });
      const winScore = room.mode === 'ctf' ? CTF_WIN_SCORE : TDM_WIN_SCORE;
      if (room.rScore >= winScore) endRoom(room, 'red');
      else if (room.bScore >= winScore) endRoom(room, 'blue');
      break;
    }

    case 'ctf_score': {
      if (!c.roomId) break;
      const room = rooms.get(c.roomId);
      if (!room || room.over) break;
      if (msg.team === 'red') room.rScore++;
      else room.bScore++;
      broadcastRoom(room.id, {
        ...msg,
        rs: room.rScore,
        bs: room.bScore,
      });
      if (room.rScore >= CTF_WIN_SCORE) endRoom(room, 'red');
      else if (room.bScore >= CTF_WIN_SCORE) endRoom(room, 'blue');
      break;
    }

    // ── STATE — throttled relay ─────────────────────────────
    case 'state': {
      if (!c.roomId) break;
      const now = Date.now();
      if (now - c.lastStateMs < STATE_THROTTLE) break;  // drop if too frequent
      c.lastStateMs = now;
      broadcastRoom(c.roomId, msg, sid);
      break;
    }

    // ── LEAVE ───────────────────────────────────────────────
    case 'leave':
    case 'bye': {
      removePlayerFromRoom(sid);
      break;
    }

    // ── RELAY EVERYTHING ELSE ───────────────────────────────
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
║     LUNAFYRE SERVER v3.0 — MATCHMAKING EDITION    ║
║                                                   ║
║  Port  : ${PORT}                                   ║
║  TDM   : ${TDM_WIN_SCORE} kills  /  20 min                  ║
║  CTF   : ${CTF_WIN_SCORE}  caps  /  18 min                  ║
║  Teams : ${MAX_PER_TEAM} red + ${MAX_PER_TEAM} blue per room              ║
╚═══════════════════════════════════════════════════╝
  `);
});

process.on('SIGTERM', () => {
  wss.clients.forEach(c => c.close());
  server.close(() => process.exit(0));
});
