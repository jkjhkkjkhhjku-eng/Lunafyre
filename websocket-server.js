// ============================================================
//  LUNAFYRE SERVER v4.1
// ============================================================

const express   = require('express');
const cors      = require('cors');
const http      = require('http');
const WebSocket = require('ws');

const app  = express();
const PORT = process.env.PORT || 8080;
app.use(cors());
app.use(express.json());

// Serve the game client (index.html) as static files
app.use(express.static(__dirname));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, perMessageDeflate: false });

// ── CONSTANTS ─────────────────────────────────────────────────
const MAX_PER_TEAM   = 25;
const TDM_TIME       = 1200;
const CTF_TIME       = 1080;
const TDM_WIN_SCORE  = 300;
const CTF_WIN_SCORE  = 10;

// ── DEMOLITION MODE ────────────────────────────────────────────
const DEMO_BOMB_TILE_X = 56, DEMO_BOMB_TILE_Y = 40; // mid-map between A/B sites
const DEMO_ROUNDS      = 8;       // max rounds
const DEMO_SIDE_SWITCH = 4;       // swap attack/defend after round 4
const DEMO_WIN_ROUNDS  = 5;       // first to 5 round-wins takes the match
const DEMO_BUY_MS      = 15000;   // buy/prep phase
const DEMO_LIVE_MS     = 100000;  // live round phase
const DEMO_POST_MS     = 5000;    // post-round phase
const DEMO_PLANT_MS    = 4000;    // bomb plant channel time
const DEMO_DEFUSE_MS   = 5000;    // defuse channel time
const DEMO_FUSE_MS     = 35000;   // planted-bomb fuse
const TICK_MS        = 1000;
const STATE_THROTTLE = 8;   // ~120fps cap for high-refresh displays

const STREAK_LABELS = {
  2 : 'DOUBLE KILL', 3 : 'TRIPLE KILL', 4 : 'QUAD KILL',
  5 : 'PENTA KILL', 7 : 'RAMPAGE', 10: 'GODLIKE',
};
const STREAK_RESET_MS = 4500;

// ── CTF MATCHMAKING (5v5) ────────────────────────────────────
const MM_PER_TEAM   = 5;
const MM_FILL_S     = 240;              // 4 min lobby-fill window
const MM_TOTAL_S    = 1800;             // 30 min max search time
const mm = {
  red: new Map(), blue: new Map(),
  startedAt: 0, interval: null,
  phase: 'idle',                        // 'idle' | 'fill' | 'wait_opponent'
};

function mmSnapshot() {
  const elapsed = Math.floor((Date.now() - mm.startedAt) / 1000);
  return {
    type: 'mm_state',
    phase: mm.phase,
    red: mm.red.size, blue: mm.blue.size,
    perTeam: MM_PER_TEAM,
    fillLeft: Math.max(0, MM_FILL_S - elapsed),
    totalLeft: Math.max(0, MM_TOTAL_S - elapsed),
    serverTime: Date.now(),
  };
}
function mmBroadcast(msgObj) {
  const str = JSON.stringify(msgObj);
  for (const [, c] of mm.red) if (c.ws.readyState === WebSocket.OPEN) c.ws.send(str);
  for (const [, c] of mm.blue) if (c.ws.readyState === WebSocket.OPEN) c.ws.send(str);
}
function mmStartClock() {
  if (mm.interval) return;
  mm.startedAt = Date.now();
  mm.interval = setInterval(mmTick, 1000);
}
function mmStopClockIfEmpty() {
  if (mm.red.size === 0 && mm.blue.size === 0) {
    clearInterval(mm.interval); mm.interval = null; mm.phase = 'idle';
  }
}
function mmTick() {
  const elapsed = Math.floor((Date.now() - mm.startedAt) / 1000);
  if (mm.phase === 'fill' && elapsed >= MM_FILL_S) {
    if (mm.red.size > 0 && mm.blue.size > 0) return mmLaunch();
    mm.phase = 'wait_opponent';         // one side empty — keep searching
  }
  if (mm.phase === 'wait_opponent' && mm.red.size > 0 && mm.blue.size > 0) {
    return mmLaunch();                  // an opponent showed up — start now
  }
  if (elapsed >= MM_TOTAL_S && !(mm.red.size > 0 && mm.blue.size > 0)) {
    mmBroadcast({ type: 'mm_failed', text: "Sorry we couldn't find any opponents for you :(" });
    clearInterval(mm.interval); mm.interval = null; mm.phase = 'idle';
    mm.red.clear(); mm.blue.clear();
    return;
  }
  mmBroadcast(mmSnapshot());
}
function mmJoin(sid, c) {
  removePlayerFromRoom(sid);            // leave any current room
  mm.red.delete(sid); mm.blue.delete(sid);
  c.playerId = c.playerId || sid;
  (c.team === 'blue' ? mm.blue : mm.red).set(sid, c);
  if (mm.phase === 'idle') mm.phase = 'fill';
  mmStartClock();
  if (mm.red.size >= MM_PER_TEAM && mm.blue.size >= MM_PER_TEAM) return mmLaunch();
  if (mm.phase === 'wait_opponent' && mm.red.size > 0 && mm.blue.size > 0) return mmLaunch();
  mmBroadcast(mmSnapshot());
}
function mmLeave(sid) {
  mm.red.delete(sid); mm.blue.delete(sid);
  mmBroadcast(mmSnapshot());
  mmStopClockIfEmpty();
}
function mmLaunch() {
  clearInterval(mm.interval); mm.interval = null;
  const room = createRoom('ctf');
  const queued = [...mm.red.entries(), ...mm.blue.entries()];
  mm.red.clear(); mm.blue.clear(); mm.phase = 'idle';
  mmBroadcast({ type: 'mm_started', roomId: room.id });
  for (const [sid, c] of queued) {
    c.lastStateMs = 0;
    c.kills = 0; c.deaths = 0; c.captures = 0; c.streak = 0; c.lastKillMs = 0;
    addPlayerToRoom(room, sid, c);
    sendTo(c.ws, {
      type: 'match_joined', roomId: room.id, team: c.team,
      timeLeft: room.timeLeft, rScore: room.rScore, bScore: room.bScore,
      mode: room.mode, redCount: room.red.size, blueCount: room.blue.size,
      leaderboard: buildLeaderboard(room),
    });
    broadcastRoom(room.id, {
      type: 'player_joined', playerId: c.playerId, name: c.name, team: c.team, skin: c.skin || 0,
      redCount: room.red.size, blueCount: room.blue.size,
    }, sid);
  }
  console.log(`🚩 CTF 5v5 launched: ${room.id} (${room.red.size}v${room.blue.size})`);
}


// ── DATA ──────────────────────────────────────────────────────
const rooms   = new Map();
const clients = new Map();
const parties = new Map();
let roomSeq = 0;


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
    demo: null, dead: null, timeout: null,
  };
  if (mode === 'demo') demoInit(room);
  rooms.set(id, room);
  room.interval = setInterval(() => tickRoom(room), TICK_MS);
  console.log(`🏟  Room created: ${id}`);
  return room;
}

function tickRoom(room) {
  if (room.over) return;
  if (room.mode === 'demo') { demoTick(room); return; }
  room.timeLeft = Math.max(0, room.timeLeft - 1);
  broadcastRoom(room.id, { type: 'tick', t: room.timeLeft, rs: room.rScore, bs: room.bScore });
  if (room.timeLeft <= 0) endRoom(room, null);
}

function endRoom(room, winner) {
  if (room.over) return;
  room.over = true;
  clearInterval(room.interval);
  if (room.timeout) { try { clearTimeout(room.timeout); } catch (e) {} room.timeout = null; } // no orphaned demo round timers
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

// ══ DEMOLITION STATE MACHINE (server-authoritative) ═══════════
function demoAtkTeam(round) {
  // Red attacks first half; teams swap roles after DEMO_SIDE_SWITCH rounds
  return (round <= DEMO_SIDE_SWITCH) ? 'red' : 'blue';
}

function demoBroadcast(room, obj) { broadcastRoom(room.id, obj); }

function demoInit(room) {
  room.demo = {
    round: 1, atk: 'red', phase: 'BUY', phaseEndsAt: Date.now() + DEMO_BUY_MS,
    bomb: {
      state: 'idle', x: 0, y: 0, site: null, carrier: null,
      fuseEndsAt: 0, actionKind: null, actionBy: null, actionStart: 0,
    },
  };
  room.dead = new Set();
  room.rScore = 0; room.bScore = 0; // repurpose demo scores → round wins
  demoBroadcast(room, { type: 'demo_event', ev: 'match_start', round: 1, atk: 'red' });
  demoBroadcast(room, demoSnapshot(room));
}

function demoSnapshot(room) {
  const d = room.demo, b = d.bomb;
  return {
    type: 'demo_state',
    phase: d.phase,
    phaseLeft: Math.max(0, Math.ceil((d.phaseEndsAt - Date.now()) / 1000)),
    round: d.round, atk: d.atk, rWins: room.rScore, bWins: room.bScore,
    bomb: {
      state: b.state, x: b.x, y: b.y, site: b.site, carrier: b.carrier,
      by: b.actionBy, prog: demoActionProg(room),
      fuseLeft: b.state === 'planted' ? Math.max(0, Math.ceil((b.fuseEndsAt - Date.now()) / 1000)) : 0,
    },
  };
}

function demoActionProg(room) {
  const d = room.demo;
  if (!d || !d.bomb.actionKind) return 0;
  const dur = d.bomb.actionKind === 'plant' ? DEMO_PLANT_MS : DEMO_DEFUSE_MS;
  return Math.max(0, Math.min(1, (Date.now() - d.bomb.actionStart) / dur));
}

function demoEvent(room, ev, extra = {}) {
  demoBroadcast(room, { type: 'demo_event', ev, ...extra });
}

function demoCancelAction(room, tag) {
  const b = room.demo && room.demo.bomb;
  if (!b || !b.actionKind) return;
  demoEvent(room, b.actionKind === 'plant' ? 'plant_cancel' : 'defuse_cancel',
    { id: b.actionBy, why: tag || '' });
  b.actionKind = null; b.actionBy = null; b.actionStart = 0;
  demoBroadcast(room, demoSnapshot(room));
}

function demoBombDrop(room, x, y) {
  const b = room.demo.bomb;
  b.state = 'dropped'; b.carrier = null; b.x = x; b.y = y;
  demoEvent(room, 'bomb_drop', { x, y });
}

function demoAlive(room, team) {
  const teamMap = team === 'red' ? room.red : room.blue;
  let n = 0;
  for (const [sid, c] of teamMap) if (!room.dead.has(c.playerId)) n++;
  return n;
}

function demoAwardRound(room, winnerTeam, why) {
  if (room.over || room.demo.phase !== 'LIVE') return;
  // Revalidate: the score winner can't award a round to an empty server
  if (room.players.size === 0) return void endRoom(room, null);
  const loserTeam = winnerTeam === 'red' ? 'blue' : 'red';
  if (winnerTeam === 'red') room.rScore++; else room.bScore++;
  demoEvent(room, 'round_end', { winner: winnerTeam, why, round: room.demo.round });
  broadcastLeaderboard(room);
  demoBroadcast(room, demoSnapshot(room));
  demoCheckMatch(room);
  if (room.over) return;
  room.demo.phase = 'POST';
  room.demo.phaseEndsAt = Date.now() + DEMO_POST_MS;
  room.timeout = setTimeout(() => demoNextRound(room, winnerTeam, loserTeam), DEMO_POST_MS);
  console.log(`💣 ${room.id} round ${room.demo.round} → ${winnerTeam} (${why}) [${room.rScore}-${room.bScore}]`);
}

function demoCheckMatch(room) {
  if (room.rScore >= DEMO_WIN_ROUNDS) return void endRoom(room, 'red');
  if (room.bScore >= DEMO_WIN_ROUNDS) return void endRoom(room, 'blue');
  if (room.demo.round < DEMO_ROUNDS) return;
  // All 8 rounds played — race to the remaining round-win target or draw
  if (room.rScore > room.bScore) return void endRoom(room, 'red');
  if (room.bScore > room.rScore) return void endRoom(room, 'blue');
  // Tie-breaker: total kills across the match decide; equal kills → draw
  let rk = 0, bk = 0;
  for (const [, c] of room.players) {
    if (c.team === 'red') rk += c.kills || 0; else bk += c.kills || 0;
  }
  const winner = rk > bk ? 'red' : bk > rk ? 'blue' : 'draw';
  if (winner !== 'draw') demoEvent(room, 'tiebreak', { winner, rk, bk });
  endRoom(room, winner);
}

function demoNextRound(room, winnerTeam, loserTeam) {
  if (room.over) return;
  if (room.players.size === 0) return void endRoom(room, null); // empty room — do not spin up another round
  // Per-round elimination tallies persist for spectators; wipe for next round
  winnerTeam = null; loserTeam = null;
  room.dead.clear();
  room.timeout = null;
  const d = room.demo;
  d.round++;
  if (d.round === DEMO_SIDE_SWITCH + 1) {
    demoEvent(room, 'side_switch', { atk: demoAtkTeam(d.round) });
  }
  d.atk = demoAtkTeam(d.round);
    d.phase = 'BUY';
  d.phaseEndsAt = Date.now() + DEMO_BUY_MS;
  d.bomb = {
    state: 'dropped', x: DEMO_BOMB_TILE_X * 32 + 16, y: DEMO_BOMB_TILE_Y * 32 + 16, site: null, carrier: null,
    fuseEndsAt: 0, actionKind: null, actionBy: null, actionStart: 0,
  };
  demoEvent(room, 'bomb_spawn', { x: d.bomb.x, y: d.bomb.y }); // bomb on the ground for pick-up
  demoEvent(room, 'round_start', { round: d.round, atk: d.atk });
  demoBroadcast(room, demoSnapshot(room));
}

function demoTick(room) {
  const d = room.demo;
  if (!d) return;
  const now = Date.now();
  if (room.players.size === 0) return; // room teardown is imminent — no more demo work

  // Live plant / defuse channel resolution
  if (d.phase === 'LIVE' && d.bomb.actionKind) {
    const actor = [...room.players.values()].find(p => p.playerId === d.bomb.actionBy);
    if (!actor || room.dead.has(actor.playerId)) {
      demoCancelAction(room, 'actor_gone');
    } else {
      const dur = d.bomb.actionKind === 'plant' ? DEMO_PLANT_MS : DEMO_DEFUSE_MS;
      const frac = (now - d.bomb.actionStart) / dur;
      if (frac >= 1) {
        if (d.bomb.actionKind === 'plant') {
          d.bomb.state = 'planted'; d.bomb.carrier = null;
          d.bomb.fuseEndsAt = now + DEMO_FUSE_MS;
          d.bomb.actionKind = null; d.bomb.actionBy = null; d.bomb.actionStart = 0;
          demoEvent(room, 'planted', { site: d.bomb.site, by: actor.playerId, x: d.bomb.x, y: d.bomb.y });
        } else {
          d.bomb.actionKind = null; d.bomb.actionBy = null; d.bomb.actionStart = 0;
          demoEvent(room, 'defused', { by: actor.playerId });
          demoSnapshot(room); // keep payload fresh before round award
          return demoAwardRound(room, d.atk === 'red' ? 'blue' : 'red', 'defuse');
        }
      }
    }
  }

  // Fuse detonation
  if (d.phase === 'LIVE' && d.bomb.state === 'planted' && now >= d.bomb.fuseEndsAt) {
    d.bomb.state = 'exploded';
    demoEvent(room, 'explode', { site: d.bomb.site });
    return demoAwardRound(room, d.atk, 'explode');
  }

  // Phase transitions
  if (now >= d.phaseEndsAt) {
    if (d.phase === 'BUY') {
      d.phase = 'LIVE';
      d.phaseEndsAt = now + DEMO_LIVE_MS;
      demoEvent(room, 'live', { round: d.round, atk: d.atk });
      demoBroadcast(room, demoSnapshot(room));
    } else if (d.phase === 'LIVE') {
      // Time expired — defenders hold the site
      return demoAwardRound(room, d.atk === 'red' ? 'blue' : 'red', 'time');
    }
    // POST transitions are driven by the endRound timeout
  }

  // 1 Hz authoritative sync (phaseLeft / fuseLeft) — piggybacks the normal tick slot
  broadcastRoom(room.id, { type: 'tick', t: Math.max(0, Math.ceil((d.phaseEndsAt - now) / 1000)), rs: room.rScore, bs: room.bScore });
  demoBroadcast(room, demoSnapshot(room));
}

function demoOnKill(room, victimSid) {
  if (!room.demo || room.demo.phase !== 'LIVE') return;
  room.dead.add(victimSid);
  const b = room.demo.bomb;
  if (b.carrier === victimSid) {
    const v = [...room.players.values()].find(p => p.playerId === victimSid);
    demoBombDrop(room, v && v.lastX ? v.lastX : b.x, v && v.lastY ? v.lastY : b.y);
  }
  demoResolveElim(room); // single elimination source-of-truth (kill or leave)
  if (room.demo.phase === 'LIVE') demoBroadcast(room, demoSnapshot(room));
}

function demoOnDisconnect(room, playerId) {
  if (!room.demo || room.over) return;
  demoCancelAction(room, 'disconnect');
  const b = room.demo.bomb;
  if (b.carrier === playerId) demoBombDrop(room, b.x, b.y);
  room.dead.delete(playerId); // departed — no longer dead-flagged
  if (room.demo.phase === 'LIVE') {
    demoResolveElim(room); // re-run elimination state check while the round is live
    demoBroadcast(room, demoSnapshot(room));
  }
}
// Draw live elimination state back to a round award when a side is empty.
function demoResolveElim(room) {
  const atkT = room.demo.atk, defT = atkT === 'red' ? 'blue' : 'red';
  const atkAlive = demoAlive(room, atkT), defAlive = demoAlive(room, defT);
  if (defAlive === 0 && atkAlive === 0) return demoAwardRound(room, defT, 'draw_team_wipe');
  if (defAlive === 0) return demoAwardRound(room, atkT, 'elim');
  if (atkAlive === 0 && room.demo.bomb.state !== 'planted') return demoAwardRound(room, defT, 'elim');
}
// ══ END DEMOLITION ════════════════════════════════════════════

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
  const demoHook = room.mode === 'demo' ? room : null;
  room.players.delete(sid); room.red.delete(sid); room.blue.delete(sid);
  if (demoHook) demoOnDisconnect(demoHook, c.playerId);
  broadcastRoom(room.id, {
    type: 'player_left', playerId: c.playerId,
    redCount: room.red.size, blueCount: room.blue.size,
  });
  if (!room.over && room.players.size > 0) broadcastLeaderboard(room);
  c.roomId = null;
  if (room.players.size === 0 && !room.over) {
    clearInterval(room.interval);
    if (room.timeout) { try { clearTimeout(room.timeout); } catch (e) {} room.timeout = null; } // demo round-end timer
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
// NOTE: '/' is now served by express.static (index.html) above.
app.get('/api/status', (req, res) => res.json({
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
    ws, sid, roomId: null, playerId: null, name: 'PLAYER', team: 'red', skin: 0,
    lastStateMs: 0, kills: 0, deaths: 0, captures: 0,
    streak: 0, lastKillMs: 0,
  });
  sendTo(ws, { type: 'connected', sid });
  ws.on('message', raw => { try { handleMsg(ws, sid, JSON.parse(raw)); } catch (e) {} });
  ws.on('close', () => { mmLeave(sid); removePlayerFromRoom(sid); clients.delete(sid); });
  ws.on('error', () => { mmLeave(sid); removePlayerFromRoom(sid); clients.delete(sid); });
});

// ── MESSAGE HANDLER ───────────────────────────────────────────
function handleMsg(ws, sid, msg) {
  const c = clients.get(sid);
  if (!c) return;

  switch (msg.type) {
    case 'mm_join_ctf': {
      const { team = 'red', name = 'PLAYER', playerId, skin = 0 } = msg;
      if (c.roomId) {
        const room = rooms.get(c.roomId);
        if (room && !room.over && room.mode === 'ctf') {
          // Already in a CTF match — rejoin directly
          sendTo(ws, {
            type: 'match_joined', roomId: room.id, team: c.team,
            timeLeft: room.timeLeft, rScore: room.rScore, bScore: room.bScore,
            mode: room.mode, redCount: room.red.size, blueCount: room.blue.size,
            leaderboard: buildLeaderboard(room),
          });
          return;
        }
      }
      c.playerId = playerId || sid;
      c.name = (name || 'PLAYER').slice(0, 16);
      c.team = team === 'blue' ? 'blue' : 'red';
      c.skin = Math.max(0, Math.min(8, parseInt(skin) || 0));
      mmJoin(sid, c);
      break;
    }
    case 'mm_cancel': {
      mmLeave(sid);
      sendTo(ws, { type: 'mm_cancelled' });
      break;
    }
    case 'quick_join': {
      const { mode = 'tdm', team = 'red', name = 'PLAYER', playerId, partyCode, skin = 0 } = msg;
      mmLeave(sid);
      // BUG FIX: Check if player is in a room AND if that room matches the requested mode
      if (c.roomId) {
        const room = rooms.get(c.roomId);
        if (room && !room.over && room.mode === mode) {
          // Only rejoin if mode matches!
          sendTo(ws, {
            type: 'match_joined', roomId: room.id, team: c.team,
            timeLeft: room.timeLeft, rScore: room.rScore, bScore: room.bScore,
            mode: room.mode, redCount: room.red.size, blueCount: room.blue.size,
            leaderboard: buildLeaderboard(room),
          });
          return;
        }
        // Mode changed or room is over — leave old room
        removePlayerFromRoom(sid);
      }
      c.playerId = playerId || sid;
      c.name = (name || 'PLAYER').slice(0, 16);
      c.team = team === 'blue' ? 'blue' : 'red';
      c.skin = Math.max(0, Math.min(8, parseInt(skin) || 0));
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
      const dj = (mode === 'demo' && room.demo)
        ? { demo: demoSnapshot(room), atkTeam: room.demo.atk }
        : {};
      sendTo(ws, {
        type: 'match_joined', roomId: room.id, team: c.team,
        timeLeft: room.timeLeft, rScore: room.rScore, bScore: room.bScore,
        mode: room.mode, redCount: room.red.size, blueCount: room.blue.size,
        leaderboard: buildLeaderboard(room), ...dj,
      });
      broadcastRoom(room.id, {
        type: 'player_joined', playerId: c.playerId, name: c.name, team: c.team, skin: c.skin || 0,
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
      const isDemo = room.mode === 'demo';
      if (!isDemo) { if (msg.team === 'red') room.rScore++; else room.bScore++; }
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
      if (isDemo) {
        if (victim) demoOnKill(room, victim.playerId);
      } else {
        const winScore = room.mode === 'ctf' ? CTF_WIN_SCORE : TDM_WIN_SCORE;
        if (room.rScore >= winScore) endRoom(room, 'red');
        else if (room.bScore >= winScore) endRoom(room, 'blue');
      }
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
      broadcastRoom(c.roomId, msg, sid);
      break;
    }
    case 'bullet': {
      if (!c.roomId) break;
      broadcastRoom(c.roomId, msg, sid);
      break;
    }
    case 'hit': {
      if (!c.roomId) break;
      broadcastRoom(c.roomId, msg, sid);
      break;
    }
    case 'leave':
    case 'bye': {
      mmLeave(sid);
      removePlayerFromRoom(sid);
      break;
    }
    case 'chat': {
      if (!c.roomId) break;
      const room = rooms.get(c.roomId);
      if (!room || room.over) break;
      // Sanitise
      const chatText = (msg.text || '').slice(0, 120).trim();
      if (!chatText) break;
      const scope = msg.scope === 'team' ? 'team' : 'all';
      const chatPayload = {
        type: 'chat',
        id: c.playerId,
        name: c.name,
        team: c.team,
        scope,
        text: chatText,
      };
      if (scope === 'team') {
        // Send only to same-team players
        const teamMap = c.team === 'red' ? room.red : room.blue;
        const str = JSON.stringify(chatPayload);
        for (const [tsid, tc] of teamMap) {
          if (tsid === sid) continue; // sender already has their own message
          if (tc.ws.readyState === WebSocket.OPEN) tc.ws.send(str);
        }
      } else {
        // Broadcast to whole room, excluding sender (they already showed locally)
        broadcastRoom(c.roomId, chatPayload, sid);
      }
      break;
    }
    case 'emoji': {
      if (!c.roomId) break;
      const ALLOWED_EMOJIS = ['😂','😢','💀','❤️'];
      if (!ALLOWED_EMOJIS.includes(msg.emoji)) break;
      broadcastRoom(c.roomId, { type: 'emoji', id: c.playerId, emoji: msg.emoji }, sid);
      break;
    }
    case 'demo_plant_start': {
      if (!c.roomId) break;
      const room = rooms.get(c.roomId);
      if (!room || room.over || room.mode !== 'demo' || !room.demo) break;
      const d = room.demo;
      if (d.phase !== 'LIVE' || d.bomb.state !== 'carried') break;
      if (d.bomb.carrier !== c.playerId) break;
      if (d.bomb.actionKind) break;
      const site = msg.site === 'B' ? 'B' : 'A';
      d.bomb.site = site; d.bomb.x = msg.x || d.bomb.x; d.bomb.y = msg.y || d.bomb.y;
      d.bomb.actionKind = 'plant'; d.bomb.actionBy = c.playerId; d.bomb.actionStart = Date.now();
      demoEvent(room, 'plant_start', { id: c.playerId, site, x: d.bomb.x, y: d.bomb.y });
      demoBroadcast(room, demoSnapshot(room));
      break;
    }
    case 'demo_plant_cancel': {
      if (!c.roomId) break;
      const room = rooms.get(c.roomId);
      if (!room || room.over || room.mode !== 'demo' || !room.demo) break;
      if (room.demo.bomb.actionKind === 'plant' && room.demo.bomb.actionBy === c.playerId)
        demoCancelAction(room, 'cancel');
      break;
    }
    case 'demo_defuse_start': {
      if (!c.roomId) break;
      const room = rooms.get(c.roomId);
      if (!room || room.over || room.mode !== 'demo' || !room.demo) break;
      const d = room.demo;
      if (d.phase !== 'LIVE' || d.bomb.state !== 'planted') break;
      if (c.team === d.atk) break; // attackers cannot defuse
      if (d.bomb.actionKind) break;
      d.bomb.actionKind = 'defuse'; d.bomb.actionBy = c.playerId; d.bomb.actionStart = Date.now();
      demoEvent(room, 'defuse_start', { id: c.playerId });
      demoBroadcast(room, demoSnapshot(room));
      break;
    }
    case 'demo_defuse_cancel': {
      if (!c.roomId) break;
      const room = rooms.get(c.roomId);
      if (!room || room.over || room.mode !== 'demo' || !room.demo) break;
      if (room.demo.bomb.actionKind === 'defuse' && room.demo.bomb.actionBy === c.playerId)
        demoCancelAction(room, 'cancel');
      break;
    }
    case 'demo_bomb_pickup': {
      if (!c.roomId) break;
      const room = rooms.get(c.roomId);
      if (!room || room.over || room.mode !== 'demo' || !room.demo) break;
      const d = room.demo;
      if (d.phase !== 'LIVE' || d.bomb.state !== 'dropped') break;
      if (c.team !== d.atk) break; // only attackers carry the bomb
      if (room.dead.has(c.playerId)) break;
      d.bomb.state = 'carried'; d.bomb.carrier = c.playerId;
      demoEvent(room, 'bomb_pickup', { id: c.playerId });
      demoBroadcast(room, demoSnapshot(room));
      break;
    }
    case 'demo_bomb_drop_voluntary': {
      if (!c.roomId) break;
      const room = rooms.get(c.roomId);
      if (!room || room.over || room.mode !== 'demo' || !room.demo) break;
      if (room.demo.bomb.state === 'carried' && room.demo.bomb.carrier === c.playerId)
        demoBombDrop(room, msg.x || 0, msg.y || 0);
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
║    LUNAFYRE SERVER v4.2                           ║
║  Port      : ${PORT.toString().padEnd(4)} │ State Hz  : 120hz         ║
╚═══════════════════════════════════════════════════╝
  `);
});

process.on('SIGTERM', () => {
  wss.clients.forEach(c => c.close());
  server.close(() => process.exit(0));
});
