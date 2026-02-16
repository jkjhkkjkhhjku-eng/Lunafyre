// ============================================
// LUNAFYRE WEBSOCKET GAME SERVER v3.0
// Server-authoritative time, permanent rooms, 50-player cap, friend squads
// ============================================

const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ─────────────────────────────────────────────────────────────
// PERMANENT ROOM CONFIGURATION
// ─────────────────────────────────────────────────────────────
const MAX_PLAYERS_PER_ROOM = 50;
const MAX_PER_TEAM = 25;

const GAME_CONFIG = {
  tdm: {
    winScore: 300,
    duration: 20 * 60,  // 20 minutes in seconds
    label: 'TEAM DEATHMATCH'
  },
  ctf: {
    winScore: 10,
    duration: 18 * 60,  // 18 minutes in seconds
    label: 'CAPTURE THE FLAG'
  }
};

// Permanent rooms (auto-created, never deleted)
// Each mode has a pool of rooms. When a room fills up (50 players), a new overflow room is created.
const roomPools = {
  tdm: [],
  ctf: []
};

// All active players: socketId -> { ws, roomId, playerId, name, team, data, ping, lastPing }
const players = new Map();

// Squad codes: squadCode -> [playerSocketId, ...]
const squads = new Map();

// ─────────────────────────────────────────────────────────────
// ROOM MANAGEMENT
// ─────────────────────────────────────────────────────────────
function createRoom(mode) {
  const config = GAME_CONFIG[mode];
  const roomId = `${mode.toUpperCase()}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const room = {
    id: roomId,
    mode,
    players: new Map(),       // socketId -> playerData
    redCount: 0,
    blueCount: 0,
    startTime: Date.now(),
    timeLeft: config.duration,
    timerInterval: null,
    rScore: 0,
    bScore: 0,
    gameOver: false,
    ctfFlags: {
      red: { x: 0, y: 0, homeX: 0, homeY: 0, carriedBy: null },
      blue: { x: 0, y: 0, homeX: 0, homeY: 0, carriedBy: null }
    }
  };

  // Start server-side timer
  room.timerInterval = setInterval(() => {
    if (room.gameOver) return;
    room.timeLeft--;
    
    // Broadcast authoritative time every second to all players in room
    broadcastToRoom(room.id, {
      type: 'server_time',
      t: room.timeLeft,
      rScore: room.rScore,
      bScore: room.bScore
    });

    if (room.timeLeft <= 0) {
      endRoom(room);
    }
  }, 1000);

  roomPools[mode].push(room);
  console.log(`🏟️ Created room: ${roomId} (${mode})`);
  return room;
}

function getOrCreateRoom(mode, squadCode) {
  const pool = roomPools[mode];
  
  // If player has a squad code, try to join the same room as squad members
  if (squadCode && squads.has(squadCode)) {
    const squadMembers = squads.get(squadCode);
    for (const memberId of squadMembers) {
      const member = players.get(memberId);
      if (member && member.roomId) {
        const room = getRoomById(member.roomId);
        if (room && !room.gameOver && room.players.size < MAX_PLAYERS_PER_ROOM) {
          return room;
        }
      }
    }
  }

  // Find first non-full, active room
  for (const room of pool) {
    if (!room.gameOver && room.players.size < MAX_PLAYERS_PER_ROOM) {
      return room;
    }
  }

  // All rooms full — create overflow room
  return createRoom(mode);
}

function getRoomById(roomId) {
  for (const pool of Object.values(roomPools)) {
    for (const room of pool) {
      if (room.id === roomId) return room;
    }
  }
  return null;
}

function endRoom(room) {
  room.gameOver = true;
  clearInterval(room.timerInterval);

  let winner = 'DRAW';
  let winTeam = null;
  if (room.rScore > room.bScore) { winner = 'RED TEAM WINS'; winTeam = 'red'; }
  else if (room.bScore > room.rScore) { winner = 'BLUE TEAM WINS'; winTeam = 'blue'; }

  broadcastToRoom(room.id, {
    type: 'game_over',
    winner,
    winTeam,
    rScore: room.rScore,
    bScore: room.bScore,
    mode: room.mode
  });

  console.log(`🏁 Room ${room.id} ended: ${winner}`);

  // After 15s, reset room instead of deleting it (keeps pool stable)
  setTimeout(() => resetRoom(room), 15000);
}

function resetRoom(room) {
  const config = GAME_CONFIG[room.mode];
  room.timeLeft = config.duration;
  room.rScore = 0;
  room.bScore = 0;
  room.gameOver = false;
  room.startTime = Date.now();
  room.ctfFlags = {
    red: { x: 0, y: 0, homeX: 0, homeY: 0, carriedBy: null },
    blue: { x: 0, y: 0, homeX: 0, homeY: 0, carriedBy: null }
  };

  clearInterval(room.timerInterval);
  room.timerInterval = setInterval(() => {
    if (room.gameOver) return;
    room.timeLeft--;
    broadcastToRoom(room.id, {
      type: 'server_time',
      t: room.timeLeft,
      rScore: room.rScore,
      bScore: room.bScore
    });
    if (room.timeLeft <= 0) endRoom(room);
  }, 1000);

  console.log(`🔄 Room ${room.id} reset`);

  // Notify existing players room restarted
  broadcastToRoom(room.id, { type: 'room_reset', mode: room.mode });
}

// Initialize two permanent rooms per mode at startup
function initPermanentRooms() {
  createRoom('tdm');
  createRoom('ctf');
  console.log('🎮 Permanent rooms initialized');
}

// ─────────────────────────────────────────────────────────────
// WEBSOCKET HANDLER
// ─────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  const socketId = Math.random().toString(36).slice(2, 11);
  const connectedAt = Date.now();
  
  ws.socketId = socketId;
  ws.pingTime = 0;
  ws.lastPong = Date.now();

  // Send pings every 2s to measure latency
  const pingInterval = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) { clearInterval(pingInterval); return; }
    ws.pingTime = Date.now();
    ws.send(JSON.stringify({ type: 'ping_req', t: ws.pingTime }));
  }, 2000);

  ws.on('pong', () => { ws.lastPong = Date.now(); });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      handleMessage(ws, socketId, msg);
    } catch (err) {
      console.error('Parse error:', err.message);
    }
  });

  ws.on('close', () => {
    clearInterval(pingInterval);
    handleDisconnect(socketId);
  });

  ws.on('error', (err) => {
    console.error('WS error:', err.message);
  });

  ws.send(JSON.stringify({ type: 'connected', socketId }));
  console.log(`🔌 [${socketId}] connected`);
});

function handleMessage(ws, socketId, msg) {
  switch (msg.type) {

    case 'pong_resp':
      // Client sent pong response, calculate RTT
      if (players.has(socketId)) {
        const rtt = Date.now() - (msg.t || 0);
        players.get(socketId).ping = rtt;
        // Send ping back to client for HUD display
        ws.send(JSON.stringify({ type: 'ping_update', ping: rtt }));
      }
      break;

    case 'squad_create': {
      const code = generateSquadCode();
      squads.set(code, [socketId]);
      ws.send(JSON.stringify({ type: 'squad_created', code }));
      break;
    }

    case 'squad_join': {
      const code = msg.code?.toUpperCase();
      if (!code || !squads.has(code)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Squad not found' }));
        return;
      }
      const squad = squads.get(code);
      if (!squad.includes(socketId)) squad.push(socketId);
      ws.send(JSON.stringify({ type: 'squad_joined', code, members: squad.length }));
      break;
    }

    case 'join_match': {
      const mode = msg.mode === 'ctf' ? 'ctf' : 'tdm';
      const room = getOrCreateRoom(mode, msg.squadCode);

      // Balance team assignment: auto-assign to smaller team or respect preference
      let team = msg.team;
      if (team !== 'red' && team !== 'blue') team = 'red';
      
      // Auto-balance: if preferred team is full, switch
      if (team === 'red' && room.redCount >= MAX_PER_TEAM) team = 'blue';
      else if (team === 'blue' && room.blueCount >= MAX_PER_TEAM) team = 'red';
      
      // If both full (shouldn't happen but safety check)
      if (room.redCount >= MAX_PER_TEAM && room.blueCount >= MAX_PER_TEAM) {
        ws.send(JSON.stringify({ type: 'error', message: 'All rooms are full! Try again in a moment.' }));
        return;
      }

      // Register player
      const playerData = {
        ws,
        roomId: room.id,
        socketId,
        playerId: msg.playerId || socketId,
        name: (msg.name || 'PLAYER').substring(0, 14),
        team,
        ping: 0,
        squadCode: msg.squadCode || null,
        joinTime: Date.now()
      };
      
      players.set(socketId, playerData);
      room.players.set(socketId, playerData);
      if (team === 'red') room.redCount++;
      else room.blueCount++;

      console.log(`👋 [${playerData.name}] joined ${room.id} as ${team} (${room.players.size} players)`);

      // Confirm join with current server state
      ws.send(JSON.stringify({
        type: 'match_joined',
        roomId: room.id,
        mode: room.mode,
        team,                       // final team (may differ if balanced)
        playerId: playerData.playerId,
        timeLeft: room.timeLeft,    // ← AUTHORITATIVE server time
        rScore: room.rScore,
        bScore: room.bScore,
        playerCount: room.players.size,
        redCount: room.redCount,
        blueCount: room.blueCount,
        gameOver: room.gameOver
      }));

      // Tell others about new player
      broadcastToRoom(room.id, {
        type: 'player_joined',
        playerId: playerData.playerId,
        name: playerData.name,
        team
      }, socketId);

      // Update player counts to everyone
      broadcastRoomInfo(room);
      break;
    }

    case 'state':
      relayToRoom(socketId, msg);
      break;

    case 'bullet':
      relayToRoom(socketId, msg);
      break;

    case 'hit':
      relayToRoom(socketId, msg);
      break;

    case 'kill': {
      const player = players.get(socketId);
      if (!player) break;
      const room = getRoomById(player.roomId);
      if (!room || room.gameOver) break;

      const config = GAME_CONFIG[room.mode];
      if (msg.team === 'red') room.rScore = Math.min(room.rScore + 1, config.winScore + 100);
      else room.bScore = Math.min(room.bScore + 1, config.winScore + 100);

      // Broadcast kill event + updated score
      broadcastToRoom(room.id, {
        type: 'kill',
        kname: msg.kname,
        vname: msg.vname,
        team: msg.team,
        rScore: room.rScore,
        bScore: room.bScore
      });

      // Check win condition
      if (room.rScore >= config.winScore || room.bScore >= config.winScore) {
        endRoom(room);
      }
      break;
    }

    case 'ctf_score': {
      const player = players.get(socketId);
      if (!player) break;
      const room = getRoomById(player.roomId);
      if (!room || room.gameOver) break;

      if (msg.team === 'red') room.rScore++;
      else room.bScore++;

      broadcastToRoom(room.id, {
        type: 'ctf_score',
        team: msg.team,
        flagTeam: msg.flagTeam,
        name: msg.name,
        pid: msg.pid,
        rScore: room.rScore,
        bScore: room.bScore
      });

      if (room.rScore >= GAME_CONFIG.ctf.winScore || room.bScore >= GAME_CONFIG.ctf.winScore) {
        endRoom(room);
      }
      break;
    }

    case 'leave':
      handleDisconnect(socketId);
      break;

    // Relay everything else
    default:
      relayToRoom(socketId, msg);
      break;
  }
}

function handleDisconnect(socketId) {
  const player = players.get(socketId);
  if (!player) return;

  const room = getRoomById(player.roomId);
  if (room) {
    room.players.delete(socketId);
    if (player.team === 'red') room.redCount = Math.max(0, room.redCount - 1);
    else room.blueCount = Math.max(0, room.blueCount - 1);

    broadcastToRoom(room.id, {
      type: 'player_left',
      playerId: player.playerId
    });

    broadcastRoomInfo(room);
  }

  // Remove from squad
  if (player.squadCode && squads.has(player.squadCode)) {
    const squad = squads.get(player.squadCode);
    const idx = squad.indexOf(socketId);
    if (idx > -1) squad.splice(idx, 1);
    if (squad.length === 0) squads.delete(player.squadCode);
  }

  players.delete(socketId);
  console.log(`🔌 [${player.name}] disconnected`);
}

function broadcastToRoom(roomId, msg, excludeSocketId = null) {
  const room = getRoomById(roomId);
  if (!room) return;
  const msgStr = JSON.stringify(msg);
  room.players.forEach((player, sid) => {
    if (sid === excludeSocketId) return;
    const ws = player.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(msgStr);
    }
  });
}

function broadcastRoomInfo(room) {
  broadcastToRoom(room.id, {
    type: 'room_info',
    playerCount: room.players.size,
    redCount: room.redCount,
    blueCount: room.blueCount
  });
}

function relayToRoom(socketId, msg) {
  const player = players.get(socketId);
  if (!player) return;
  broadcastToRoom(player.roomId, msg, socketId);
}

function generateSquadCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  if (squads.has(code)) return generateSquadCode();
  return code;
}

// ─────────────────────────────────────────────────────────────
// HTTP ROUTES
// ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const roomInfo = {};
  for (const [mode, pool] of Object.entries(roomPools)) {
    roomInfo[mode] = pool.map(r => ({
      id: r.id,
      players: r.players.size,
      red: r.redCount,
      blue: r.blueCount,
      timeLeft: r.timeLeft,
      gameOver: r.gameOver
    }));
  }
  res.json({ status: 'online', totalPlayers: players.size, rooms: roomInfo, timestamp: new Date().toISOString() });
});

app.get('/api/rooms', (req, res) => {
  const result = {};
  for (const [mode, pool] of Object.entries(roomPools)) {
    result[mode] = pool.map(r => ({
      id: r.id, players: r.players.size, maxPlayers: MAX_PLAYERS_PER_ROOM,
      red: r.redCount, blue: r.blueCount, timeLeft: r.timeLeft, gameOver: r.gameOver
    }));
  }
  res.json({ success: true, rooms: result, totalPlayers: players.size });
});

app.get('/api/stats', (req, res) => {
  res.json({
    success: true,
    stats: { activePlayers: players.size, activeSquads: squads.size, uptime: process.uptime(), serverTime: new Date().toISOString() }
  });
});

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────
initPermanentRooms();

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║   LUNAFYRE SERVER v3.0 ONLINE                ║
║                                              ║
║   Port: ${PORT}                                 ║
║   Modes: TDM (300pts/20min) | CTF (10pts/18min) ║
║   Per room: 50 players max (25 per team)     ║
║   Time sync: SERVER-AUTHORITATIVE            ║
╚══════════════════════════════════════════════╝
  `);
});

process.on('SIGTERM', () => {
  console.log('Shutting down...');
  wss.clients.forEach(c => c.close());
  server.close(() => process.exit(0));
});
