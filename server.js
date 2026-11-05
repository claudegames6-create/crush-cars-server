'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const HTML_PATH = process.env.GAME_HTML || path.join(__dirname, 'crush-cars.html');
const LEAD_MS = 5000;

// Constantes globales autorizadas del juego directas y estables
const CARS = [{id:'volt', name:'VOLT'}, {id:'bulwark', name:'BULWARK'}, {id:'mirage', name:'MIRAGE'}];
const MAPS = [{id:'desert_dash', name:'Desierto'}, {id:'neon_city', name:'Neon'}];
const MPC = { MAX_PLAYERS: 12 };

const peers = new Map();
const rooms = new Map();

const maxHumans = room => room.mode === 'survival' ? 12 : MPC.MAX_PLAYERS;
const clampBots = room => { 
  room.cfg.bots = Math.max(0, (room.mode === 'survival' ? 12 : MPC.MAX_PLAYERS) - room.members.length); 
};

function roomView(room) {
  return {
    code: room.code, mode: room.mode, host: room.host, state: room.state, maxHumans: maxHumans(room), survivalRound: room.survivalRound || 1, cfg: room.cfg,
    players: room.members.map(pid => { 
      const p = peers.get(pid); 
      return p ? { pid, name: p.name, av: p.av, lvl: p.lvl, carId: p.carId, ready: !!p.ready, host: pid === room.host, connected: p.connected } : null; 
    }).filter(Boolean)
  };
}

function broadcastRoom(room) {
  const v = roomView(room);
  room.members.forEach(pid => { const p = peers.get(pid); if (p && p.sock) p.sock.emit('room', v); });
}

function startRace(room) {
  const { cfg } = room;
  const raceId = 'R' + Date.now().toString(36);
  const humans = room.members.map(pid => peers.get(pid)).filter(Boolean);
  
  let totalPilots = 12;
  if (room.mode === 'survival') {
    if (room.survivalRound === 2) totalPilots = 9;
    if (room.survivalRound === 3) totalPilots = 6;
    if (room.survivalRound === 4) totalPilots = 3;
  } else {
    totalPilots = humans.length + cfg.bots;
  }

  const grid = humans.map((p, i) => ({ pid: p.pid, name: p.name, av: p.av, carId: p.carId, bot: null, slot: i }));
  while (grid.length < totalPilots) {
    grid.push({ pid: 'bot-' + grid.length, name: 'BOT ' + (grid.length + 1), av: 0, carId: CARS[Math.floor(Math.random() * CARS.length)].id, bot: { r: 0.95 }, slot: grid.length });
  }

  room.race = { id: raceId, clock: 0, cars: grid.map(g => ({ pid: g.pid, name: g.name, finished: false, finishT: 0 })) };
  room.state = 'racing';
  io.to(room.code).emit('start', { raceId, startAt: Date.now() + LEAD_MS, cfg, grid, survivalRound: room.survivalRound });
  broadcastRoom(room);
}

function endRace(room) {
  const rc = room.race; if (!rc) return;
  room.race = null;
  
  const order = rc.cars;
  order.forEach((c, i) => { 
    c.pos = i + 1; 
    if(!c.finished) { c.finished = true; c.finishT = 30; }
  });

  if (room.mode === 'survival') {
    let elim = room.survivalRound === 4 ? 2 : 3;
    const elimPids = order.slice(order.length - elim).map(c => c.pid);
    elimPids.forEach(pid => { const p = peers.get(pid); if (p && p.sock) p.sock.emit('survival_eliminated', { round: room.survivalRound, pos: room.members.length }); });
    room.members = room.members.filter(pid => !elimPids.includes(pid));
    
    if (room.members.length <= 1 && room.survivalRound >= 4) {
      if (room.members.length > 0) io.to(room.code).emit('survival_champion', { winner: room.members[0] });
      room.state = 'lobby'; room.survivalRound = 1;
    } else {
      room.survivalRound++; room.state = 'lobby';
      room.cfg.mapId = MAPS[room.survivalRound % MAPS.length].id;
    }
  } else { 
    room.state = 'lobby'; 
  }
  
  io.to(room.code).emit('res', { order: order.map(c => ({ pos: c.pos, name: c.name, human: !c.pid.startsWith('bot-'), pid: c.pid })), survivalRound: room.survivalRound });
  clampBots(room); 
  broadcastRoom(room);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));
app.get(['/', '/index.html', '/crush-cars.html'], (req, res) => {
  if (fs.existsSync(HTML_PATH)) res.sendFile(HTML_PATH);
  else res.send("Servidor Activo (HTML no encontrado en ruta)");
});

io.on('connection', socket => {
  let peer = null;
  
  socket.on('hello', m => {
    peer = { pid: 'p' + Math.random().toString(36).substring(2, 6), sock: socket, name: (m && m.name) || 'PILOTO', av: 0, lvl: 1, carId: 'volt', connected: true, ready: false };
    peers.set(peer.pid, peer);
    socket.emit('welcome', { pid: peer.pid });
  });

  socket.on('create', m => {
    if (!peer) return;
    const mode = (m && m.mode) === 'survival' ? 'survival' : 'party';
    const room = { code: 'CC-' + Math.random().toString(36).substring(2, 6).toUpperCase(), mode, host: peer.pid, state: 'lobby', members: [peer.pid], survivalRound: 1, cfg: { mapId: MAPS[0].id, cc: 150, laps: 3, bots: mode === 'survival' ? 11 : 3 } };
    rooms.set(room.code, room); peer.room = room.code; socket.join(room.code); broadcastRoom(room);
  });

  socket.on('join', m => {
    if (!peer || !m || !m.code) return;
    const room = rooms.get(m.code.toUpperCase());
    if (!room || room.state !== 'lobby' || room.members.length >= maxHumans(room)) return socket.emit('err', 'Error');
    peer.room = room.code; room.members.push(peer.pid); socket.join(room.code); clampBots(room); broadcastRoom(room);
  });

  socket.on('ready', m => { if (peer) { peer.ready = !!(m && m.ready); const r = rooms.get(peer.room); if (r) broadcastRoom(r); } });
  
  socket.on('cfg', m => {
    if (!peer) return; const room = rooms.get(peer.room); if (!room || room.host !== peer.pid) return;
    if (m && m.cfg) { 
      if (m.cfg.mode) { room.mode = m.cfg.mode; if (room.mode === 'survival') room.survivalRound = 1; } 
      if (m.cfg.mapId) room.cfg.mapId = m.cfg.mapId; 
      if (m.cfg.cc) room.cfg.cc = m.cfg.cc; 
      if (m.cfg.laps) room.cfg.laps = m.cfg.laps; 
    }
    clampBots(room); broadcastRoom(room);
  });

  socket.on('start', () => { if (peer) { const r = rooms.get(peer.room); if (r && r.host === peer.pid && r.state === 'lobby') startRace(r); } });
  socket.on('c', m => { if (peer && peer.room) socket.to(peer.room).emit('c', peer.pid, m); });

  socket.on('disconnect', () => {
    if (!peer) return; const room = rooms.get(peer.room);
    if (room) { 
      room.members = room.members.filter(id => id !== peer.pid); 
      if (room.host === peer.pid && room.members.length > 0) room.host = room.members[0]; 
      if (!room.members.length) rooms.delete(room.code); else broadcastRoom(room); 
    }
    peers.delete(peer.pid);
  });
});

setInterval(() => { rooms.forEach(room => { if (room.race && (room.race.clock += 0.016) > 35) endRace(room); }); }, 16);
server.listen(PORT, () => console.log(`Active:${PORT}`));
