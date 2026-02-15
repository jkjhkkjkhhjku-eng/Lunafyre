// ============================================
// LUNAFYRE WEBSOCKET GAME SERVER
// Reliable multiplayer without P2P bullshit
// ============================================

const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(express.json());

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Game state
const rooms = new Map(); // roomId -> { host, players: Map(socketId -> playerData) }
const players = new Map(); // socketId -> { roomId, playerId, name, data }

// ============================================
// HTTP ROUTES (same as before)
// ============================================

app.get('/', (req, res) => {
  res.json({ 
    status: 'online', 
    activeRooms: rooms.size,
    activePlayers: players.size,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/rooms', (req, res) => {
  const roomList = Array.from(rooms.entries()).map(([id, room]) => ({
    id,
    hostId: room.host,
    players: room.players.size,
    maxPlayers: room.maxPlayers || 10
  }));
  
  res.json({
    success: true,
    rooms: roomList
  });
});

app.get('/api/stats', (req, res) => {
  res.json({
    success: true,
    stats: {
      activeRooms: rooms.size,
      totalActivePlayers: players.size,
      uptime: process.uptime(),
      serverTime: new Date().toISOString()
    }
  });
});

// ============================================
// WEBSOCKET HANDLERS
// ============================================

wss.on('connection', (ws) => {
  console.log('🔌 Client connected');
  
  const socketId = Math.random().toString(36).slice(2);
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      handleMessage(ws, socketId, msg);
    } catch (err) {
      console.error('Error parsing message:', err);
    }
  });
  
  ws.on('close', () => {
    console.log('🔌 Client disconnected:', socketId);
    handleDisconnect(socketId);
  });
  
  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
  
  // Send connection confirmation
  ws.send(JSON.stringify({ 
    type: 'connected', 
    socketId 
  }));
});

function handleMessage(ws, socketId, msg) {
  switch (msg.type) {
    case 'host':
      handleHost(ws, socketId, msg);
      break;
    case 'join':
      handleJoin(ws, socketId, msg);
      break;
    case 'state':
      handleState(socketId, msg);
      break;
    case 'shoot':
      handleShoot(socketId, msg);
      break;
    case 'hit':
      handleHit(socketId, msg);
      break;
    case 'leave':
      handleDisconnect(socketId);
      break;
    default:
      // Relay any other messages to room
      relayToRoom(socketId, msg);
  }
}

function handleHost(ws, socketId, msg) {
  const roomId = msg.roomId || generateRoomCode();
  
  rooms.set(roomId, {
    host: socketId,
    hostSocket: ws,
    players: new Map(),
    maxPlayers: msg.maxPlayers || 10
  });
  
  players.set(socketId, {
    roomId,
    playerId: msg.playerId,
    name: msg.name,
    socket: ws,
    isHost: true
  });
  
  console.log(`🎮 Room created: ${roomId} by ${msg.name}`);
  
  ws.send(JSON.stringify({
    type: 'hosted',
    roomId,
    success: true
  }));
}

function handleJoin(ws, socketId, msg) {
  const room = rooms.get(msg.roomId);
  
  if (!room) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Room not found'
    }));
    return;
  }
  
  if (room.players.size >= room.maxPlayers) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Room is full'
    }));
    return;
  }
  
  room.players.set(socketId, {
    playerId: msg.playerId,
    name: msg.name,
    socket: ws
  });
  
  players.set(socketId, {
    roomId: msg.roomId,
    playerId: msg.playerId,
    name: msg.name,
    socket: ws,
    isHost: false
  });
  
  console.log(`👋 ${msg.name} joined room: ${msg.roomId}`);
  
  // Tell joiner they're in
  ws.send(JSON.stringify({
    type: 'joined',
    roomId: msg.roomId,
    success: true
  }));
  
  // Tell everyone in room about new player
  broadcastToRoom(msg.roomId, {
    type: 'player_joined',
    playerId: msg.playerId,
    name: msg.name
  }, socketId);
}

function handleState(socketId, msg) {
  const player = players.get(socketId);
  if (!player) return;
  
  // Broadcast state to everyone else in room
  broadcastToRoom(player.roomId, {
    type: 'state',
    ...msg
  }, socketId);
}

function handleShoot(socketId, msg) {
  const player = players.get(socketId);
  if (!player) return;
  
  broadcastToRoom(player.roomId, {
    type: 'bullet',
    ...msg
  }, socketId);
}

function handleHit(socketId, msg) {
  const player = players.get(socketId);
  if (!player) return;
  
  broadcastToRoom(player.roomId, {
    type: 'hit',
    ...msg
  }, socketId);
}

function handleDisconnect(socketId) {
  const player = players.get(socketId);
  if (!player) return;
  
  const room = rooms.get(player.roomId);
  if (room) {
    // Remove from room
    room.players.delete(socketId);
    
    // Notify others
    broadcastToRoom(player.roomId, {
      type: 'player_left',
      playerId: player.playerId
    });
    
    // If host left, delete room
    if (player.isHost) {
      console.log(`🗑️ Room deleted: ${player.roomId} (host left)`);
      rooms.delete(player.roomId);
      
      // Kick everyone
      room.players.forEach((p) => {
        if (p.socket && p.socket.readyState === WebSocket.OPEN) {
          p.socket.send(JSON.stringify({
            type: 'room_closed',
            message: 'Host left the game'
          }));
        }
      });
    }
  }
  
  players.delete(socketId);
}

function broadcastToRoom(roomId, msg, excludeSocketId = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  const msgStr = JSON.stringify(msg);
  
  // Send to host
  if (room.hostSocket && room.hostSocket.readyState === WebSocket.OPEN && room.host !== excludeSocketId) {
    room.hostSocket.send(msgStr);
  }
  
  // Send to all players
  room.players.forEach((player, sid) => {
    if (sid !== excludeSocketId && player.socket && player.socket.readyState === WebSocket.OPEN) {
      player.socket.send(msgStr);
    }
  });
}

function relayToRoom(socketId, msg) {
  const player = players.get(socketId);
  if (!player) return;
  
  broadcastToRoom(player.roomId, msg, socketId);
}

function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  
  if (rooms.has(code)) return generateRoomCode();
  return code;
}

// ============================================
// START SERVER
// ============================================

server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════╗
║   LUNAFYRE WEBSOCKET SERVER ONLINE       ║
║                                           ║
║   Port: ${PORT}                            ║
║   WebSocket: ENABLED                      ║
║   Time: ${new Date().toLocaleString()}    ║
╚═══════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing connections...');
  wss.clients.forEach((client) => {
    client.close();
  });
  server.close(() => {
    console.log('Server shut down');
    process.exit(0);
  });
});
