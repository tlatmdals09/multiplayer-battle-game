const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling']
});

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const GAME_CONFIG = {
  MAX_PLAYERS_PER_ROOM: 2,
  SYNC_INTERVAL: 50,
  DAMAGE_VALUES: { basic: 5, skill1: 15, skill2: 20, skill3: 25 },
  MANA_COSTS: { skill1: 20, skill2: 30, skill3: 40 },
  ULT_DURATIONS: { cloak: 3000, freeze: 2000, summon: 5000 }
};

const gameRooms = {};
const playerSessions = {};
const serverStartTime = Date.now();

function getServerTime() {
  return Date.now() - serverStartTime;
}

class GameRoom {
  constructor(roomId) {
    this.id = roomId;
    this.players = {};
    this.playerCount = 0;
    this.gameStarted = false;
    this.projectiles = [];
  }

  addPlayer(socketId, playerNum) {
    this.players[socketId] = {
      socketId, playerNum,
      x: playerNum === 1 ? 50 : 350, y: 150,
      hp: 100, maxHp: 100, mp: 100, maxMp: 100, ult: 0, maxUlt: 100,
      frozen: false, frozenUntil: 0, cloaked: false, cloakedUntil: 0, alive: true
    };
    this.playerCount++;
  }

  removePlayer(socketId) {
    delete this.players[socketId];
    this.playerCount--;
  }

  getPlayer(socketId) {
    return this.players[socketId];
  }

  getOpponent(socketId) {
    const playerNum = this.players[socketId]?.playerNum;
    if (!playerNum) return null;
    const opponentSocketId = Object.keys(this.players).find(
      sid => this.players[sid].playerNum !== playerNum
    );
    return opponentSocketId ? this.players[opponentSocketId] : null;
  }

  isReady() {
    return this.playerCount === GAME_CONFIG.MAX_PLAYERS_PER_ROOM;
  }

  startGame() {
    if (!this.isReady()) return false;
    this.gameStarted = true;
    return true;
  }

  addProjectile(projectileData) {
    this.projectiles.push(projectileData);
  }

  updateProjectiles(now) {
    this.projectiles = this.projectiles.filter(p => now - p.createdAt < 5000);
  }
}

io.on('connection', (socket) => {
  console.log(`✅ 클라이언트 연결: ${socket.id}`);

  socket.on('time-sync-request', (data) => {
    socket.emit('time-sync-response', {
      serverTime: getServerTime(),
      clientSendTime: data.clientTime
    });
  });

  socket.on('join-room', (data, callback) => {
    const { roomId } = data;

    if (!gameRooms[roomId]) {
      gameRooms[roomId] = new GameRoom(roomId);
    }

    const room = gameRooms[roomId];

    if (room.playerCount >= GAME_CONFIG.MAX_PLAYERS_PER_ROOM) {
      callback({ success: false, error: '방이 가득 찼습니다.' });
      return;
    }

    const playerNum = room.playerCount + 1;
    room.addPlayer(socket.id, playerNum);
    socket.join(roomId);

    playerSessions[socket.id] = { roomId, playerNum };

    callback({
      success: true,
      playerNum,
      roomId,
      serverTime: getServerTime()
    });

    io.to(roomId).emit('player-joined', {
      playerNum,
      totalPlayers: room.playerCount,
      timestamp: getServerTime()
    });

    if (room.isReady()) {
      io.to(roomId).emit('game-ready', {
        message: '모든 플레이어가 입장했습니다!',
        timestamp: getServerTime()
      });
    }
  });

  socket.on('game-start', () => {
    const session = playerSessions[socket.id];
    if (!session) return;

    const room = gameRooms[session.roomId];
    if (!room || !room.isReady()) return;

    if (!room.startGame()) return;

    io.to(session.roomId).emit('game-started', {
      timestamp: getServerTime()
    });

    startGameSync(session.roomId);
  });

  socket.on('player-move', (data) => {
    const session = playerSessions[socket.id];
    if (!session) return;

    const room = gameRooms[session.roomId];
    if (!room || !room.gameStarted) return;

    const player = room.getPlayer(socket.id);
    if (!player) return;

    player.x = Math.max(0, Math.min(400, data.x));
    player.y = Math.max(0, Math.min(300, data.y));

    socket.broadcast.to(session.roomId).emit('opponent-moved', {
      playerNum: session.playerNum,
      x: player.x,
      y: player.y
    });
  });

  socket.on('cast-skill', (data, callback) => {
    const session = playerSessions[socket.id];
    if (!session) return;

    const room = gameRooms[session.roomId];
    if (!room || !room.gameStarted) return;

    const player = room.getPlayer(socket.id);
    if (!player || player.hp <= 0) {
      callback({ success: false });
      return;
    }

    const skillType = data.skillType;
    const manaCost = GAME_CONFIG.MANA_COSTS[skillType] || 0;
    const shortfall = Math.max(0, manaCost - player.mp);

    if (shortfall > 0) {
      if (player.hp <= shortfall) {
        callback({ success: false });
        return;
      }
      player.hp -= shortfall;
      player.mp = 0;
    } else {
      player.mp -= manaCost;
    }

    const projectileId = `proj_${getServerTime()}_${Math.random().toString(36).substr(2, 9)}`;
    const projectile = {
      id: projectileId,
      skillType,
      owner: session.playerNum,
      x: data.x,
      y: data.y,
      vx: data.vx || 0,
      vy: data.vy || -5,
      createdAt: getServerTime(),
      hits: {}
    };

    room.addProjectile(projectile);

    io.to(session.roomId).emit('skill-cast', {
      projectileId,
      playerNum: session.playerNum,
      skillType,
      x: data.x,
      y: data.y,
      vx: data.vx || 0,
      vy: data.vy || -5
    });

    callback({ success: true, projectileId });
  });

  socket.on('damage-hit', (data) => {
    const session = playerSessions[socket.id];
    if (!session) return;

    const room = gameRooms[session.roomId];
    if (!room) return;

    const projectile = room.projectiles.find(p => p.id === data.projectileId);
    if (!projectile) return;

    const opponent = room.getOpponent(socket.id);
    if (!opponent) return;

    if (projectile.hits[opponent.socketId]) return;
    projectile.hits[opponent.socketId] = true;

    const baseDamage = GAME_CONFIG.DAMAGE_VALUES[projectile.skillType] || 5;
    const damage = baseDamage * data.hitCount;

    opponent.hp = Math.max(0, opponent.hp - damage);
    opponent.ult = Math.min(opponent.maxUlt, opponent.ult + damage * 0.3);

    io.to(session.roomId).emit('damage-applied', {
      projectileId: data.projectileId,
      targetPlayerNum: opponent.playerNum,
      damage,
      targetHp: opponent.hp,
      targetUlt: opponent.ult
    });

    if (opponent.hp <= 0) {
      opponent.alive = false;
      io.to(session.roomId).emit('player-died', {
        playerNum: opponent.playerNum
      });
    }
  });

  socket.on('use-ultimate', (data, callback) => {
    const session = playerSessions[socket.id];
    if (!session) return;

    const room = gameRooms[session.roomId];
    if (!room || !room.gameStarted) return;

    const player = room.getPlayer(socket.id);
    if (!player || player.ult < 100) {
      callback({ success: false });
      return;
    }

    player.ult = 0;
    const ultType = data.type;
    const duration = GAME_CONFIG.ULT_DURATIONS[ultType] || 0;
    const endTime = getServerTime() + duration;

    if (ultType === 'cloak') {
      player.cloaked = true;
      player.cloakedUntil = endTime;
    } else if (ultType === 'freeze') {
      const opponent = room.getOpponent(socket.id);
      if (opponent) {
        opponent.frozen = true;
        opponent.frozenUntil = endTime;
      }
    }

    io.to(session.roomId).emit('ultimate-used', {
      playerNum: session.playerNum,
      type: ultType,
      duration
    });

    callback({ success: true });
  });

  socket.on('disconnect', () => {
    const session = playerSessions[socket.id];
    if (session) {
      const room = gameRooms[session.roomId];
      if (room) {
        room.removePlayer(socket.id);
        io.to(session.roomId).emit('player-disconnected', {
          playerNum: session.playerNum
        });
        if (room.playerCount === 0) {
          delete gameRooms[session.roomId];
        }
      }
      delete playerSessions[socket.id];
    }
  });
});

function startGameSync(roomId) {
  const room = gameRooms[roomId];
  if (!room) return;

  const syncInterval = setInterval(() => {
    if (!room.gameStarted) {
      clearInterval(syncInterval);
      return;
    }

    const now = getServerTime();
    room.updateProjectiles(now);

    Object.values(room.players).forEach(player => {
      if (player.frozen && now > player.frozenUntil) player.frozen = false;
      if (player.cloaked && now > player.cloakedUntil) player.cloaked = false;
    });

    io.to(roomId).emit('game-state-sync', {
      timestamp: now,
      players: Object.values(room.players).map(p => ({
        playerNum: p.playerNum,
        hp: p.hp,
        mp: p.mp,
        ult: p.ult,
        frozen: p.frozen,
        cloaked: p.cloaked
      }))
    });
  }, GAME_CONFIG.SYNC_INTERVAL);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎮 게임 서버 실행: http://localhost:${PORT}`);
});
