// ============================================
// LUNAFYRE MATCHMAKING SERVER
// Ready to deploy on Railway.app or any Node.js host
// ============================================

const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// In-memory storage (replace with database for production)
const rooms = new Map();
const players = new Map();

// Clean up old rooms every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms.entries()) {
    // Remove rooms older than 30 minutes with no players
    if (room.players === 0 && now - room.createdAt > 1800000) {
      rooms.delete(id);
      console.log(`Cleaned up inactive room: ${id}`);
    }
  }
}, 300000);

// ============================================
// ROUTES
// ============================================

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'online', 
    activeRooms: rooms.size,
    activePlayers: players.size,
    timestamp: new Date().toISOString()
  });
});

// Get all active rooms
app.get('/api/rooms', (req, res) => {
  const activeRooms = Array.from(rooms.values())
    .filter(room => room.players < room.maxPlayers)
    .sort((a, b) => b.players - a.players); // Sort by player count
  
  res.json({
    success: true,
    rooms: activeRooms,
    total: activeRooms.length
  });
});

// Get specific room details
app.get('/api/rooms/:id', (req, res) => {
  const room = rooms.get(req.params.id);
  
  if (!room) {
    return res.status(404).json({ 
      success: false, 
      error: 'Room not found' 
    });
  }
  
  res.json({
    success: true,
    room
  });
});

// Create new room
app.post('/api/rooms', (req, res) => {
  const { name, hostId, mode = 'tdm', maxPlayers = 10 } = req.body;
  
  // Validation
  if (!name || !hostId) {
    return res.status(400).json({ 
      success: false, 
      error: 'Name and hostId required' 
    });
  }
  
  // Generate room code
  const roomId = generateRoomCode();
  
  const room = {
    id: roomId,
    name: name.substring(0, 30), // Limit name length
    hostId,
    mode,
    players: 1,
    maxPlayers: Math.min(maxPlayers, 20), // Cap at 20 players
    createdAt: Date.now(),
    playerList: [{ id: hostId, name }]
  };
  
  rooms.set(roomId, room);
  
  console.log(`Room created: ${roomId} by ${name}`);
  
  res.json({
    success: true,
    room
  });
});

// Join existing room
app.post('/api/rooms/:id/join', (req, res) => {
  const { playerId, playerName } = req.body;
  const room = rooms.get(req.params.id);
  
  if (!room) {
    return res.status(404).json({ 
      success: false, 
      error: 'Room not found' 
    });
  }
  
  if (room.players >= room.maxPlayers) {
    return res.status(400).json({ 
      success: false, 
      error: 'Room is full' 
    });
  }
  
  // Check if player already in room
  const alreadyInRoom = room.playerList.some(p => p.id === playerId);
  
  if (!alreadyInRoom) {
    room.players++;
    room.playerList.push({ id: playerId, name: playerName });
  }
  
  console.log(`${playerName} joined room: ${req.params.id}`);
  
  res.json({
    success: true,
    room
  });
});

// Leave room
app.post('/api/rooms/:id/leave', (req, res) => {
  const { playerId } = req.body;
  const room = rooms.get(req.params.id);
  
  if (!room) {
    return res.status(404).json({ 
      success: false, 
      error: 'Room not found' 
    });
  }
  
  // Remove player from room
  const index = room.playerList.findIndex(p => p.id === playerId);
  if (index !== -1) {
    room.playerList.splice(index, 1);
    room.players = Math.max(0, room.players - 1);
  }
  
  // If host left, assign new host or delete room
  if (room.hostId === playerId) {
    if (room.players > 0) {
      room.hostId = room.playerList[0].id;
      console.log(`New host assigned for room ${req.params.id}`);
    } else {
      rooms.delete(req.params.id);
      console.log(`Room deleted: ${req.params.id} (empty)`);
    }
  }
  
  res.json({
    success: true,
    room: room.players > 0 ? room : null
  });
});

// Delete room (host only)
app.delete('/api/rooms/:id', (req, res) => {
  const { hostId } = req.body;
  const room = rooms.get(req.params.id);
  
  if (!room) {
    return res.status(404).json({ 
      success: false, 
      error: 'Room not found' 
    });
  }
  
  // Verify host
  if (room.hostId !== hostId) {
    return res.status(403).json({ 
      success: false, 
      error: 'Only host can delete room' 
    });
  }
  
  rooms.delete(req.params.id);
  console.log(`Room deleted: ${req.params.id}`);
  
  res.json({ success: true });
});

// Player stats (basic implementation)
app.get('/api/players/:id/stats', (req, res) => {
  const stats = players.get(req.params.id) || {
    kills: 0,
    deaths: 0,
    wins: 0,
    gamesPlayed: 0,
    level: 1
  };
  
  res.json({
    success: true,
    stats
  });
});

// Update player stats
app.post('/api/players/:id/stats', (req, res) => {
  const { kills, deaths, won } = req.body;
  const playerId = req.params.id;
  
  let stats = players.get(playerId) || {
    kills: 0,
    deaths: 0,
    wins: 0,
    gamesPlayed: 0,
    level: 1
  };
  
  stats.kills += kills || 0;
  stats.deaths += deaths || 0;
  stats.wins += won ? 1 : 0;
  stats.gamesPlayed += 1;
  
  // Simple level calculation
  const totalXP = stats.kills * 10 + stats.wins * 50;
  stats.level = Math.floor(totalXP / 100) + 1;
  
  players.set(playerId, stats);
  
  res.json({
    success: true,
    stats
  });
});

// Leaderboard
app.get('/api/leaderboard', (req, res) => {
  const { sortBy = 'kills', limit = 100 } = req.query;
  
  const leaderboard = Array.from(players.entries())
    .map(([id, stats]) => ({ id, ...stats }))
    .sort((a, b) => b[sortBy] - a[sortBy])
    .slice(0, parseInt(limit));
  
  res.json({
    success: true,
    leaderboard,
    sortBy
  });
});

// Server stats
app.get('/api/stats', (req, res) => {
  const now = Date.now();
  const activeRooms = Array.from(rooms.values()).filter(r => r.players > 0);
  const totalActivePlayers = activeRooms.reduce((sum, r) => sum + r.players, 0);
  
  res.json({
    success: true,
    stats: {
      activeRooms: activeRooms.length,
      totalRooms: rooms.size,
      totalActivePlayers,
      registeredPlayers: players.size,
      uptime: process.uptime(),
      serverTime: new Date().toISOString()
    }
  });
});

// ============================================
// HELPER FUNCTIONS
// ============================================

function generateRoomCode() {
  // Generate 6-character alphanumeric code
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  
  // Ensure uniqueness
  if (rooms.has(code)) {
    return generateRoomCode();
  }
  
  return code;
}

// ============================================
// ERROR HANDLING
// ============================================

app.use((req, res) => {
  res.status(404).json({ 
    success: false, 
    error: 'Endpoint not found' 
  });
});

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ 
    success: false, 
    error: 'Internal server error' 
  });
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════╗
║   LUNAFYRE MATCHMAKING SERVER ONLINE     ║
║                                           ║
║   Port: ${PORT}                            ║
║   Environment: ${process.env.NODE_ENV || 'development'}           ║
║   Time: ${new Date().toLocaleString()}    ║
╚═══════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});
