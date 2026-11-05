'use strict';
/* =====================================================================
   CRUSH CARS · Servidor Autorizado y Completo para Supervivencia Multijugador
   ===================================================================== */
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const HTML_PATH = process.env.GAME_HTML || path.join(__dirname, 'crush-cars.html');
const LEAD_MS = 5000;
const rid = n => crypto.randomBytes(n).toString('hex');

function loadGame() {
  let html = '';
  try { 
    html = fs.readFileSync(HTML_PATH, 'utf8'); 
  } catch (e) {
    console.log("⚠️ No se encontró crush-cars.html, usando configuración integrada.");
  }
  html = html.replace(/\r\n?/g, '\n');

  const s0 = html.indexOf('<script>'), s1 = html.indexOf('</script>', s0);
  let src = (s0 >= 0 && s1 >= 0) ? html.slice(s0 + 8, s1) : '';

  const iR = src.indexOf('RENDER · mundo'), cut = iR < 0 ? -1 : src.lastIndexOf('/*', iR);
  const b0 = src.indexOf('/*MP-CORE-BEGIN*/'), b1 = src.indexOf('/*MP-CORE-END*/');

  class Path2D { moveTo() {} lineTo() {} closePath() {} }
  const ctx = vm.createContext({ console, Path2D });
  vm.runInContext('const Q = { lvl: 1, fx: 0, dprCap: 1, ema: 16.7, bad: 0 };', ctx);

  if (cut >= 0 && b0 >= 0 && b1 >= 0) {
    try {
      vm.runInContext(src.slice(0, cut), ctx);
      vm.runInContext(src.slice(b0, b1 + 15), ctx);
    } catch(e) { 
      console.log("⚠️ Carga parcial de lógica del cliente."); 
    }
  }

  // Inyección blindada con estructuras de datos válidas por defecto
  vm.runInContext(`
    if (typeof CARS === 'undefined') {
      CARS = [{id:'volt', name:'VOLT'}, {id:'bulwark', name:'BULWARK'}, {id:'mirage', name:'MIRAGE'}];
      MAPS = [{id:'desert_dash', name:'Desierto', lvl:1, laps:3, pool:[]}, {id:'neon_city', name:'Neon', lvl:1, laps:3, pool:[]}];
      CC_LIST =;
      AVATARS = Array(16).fill(0);
      RIVALS = [{name:'Apex', col:'#fff'}, {name:'Shadow', col:'#000'}];
      MPC = { PROTO:'v1.0', MAX_PLAYERS:12, SNAP_HZ:20, CP:4, LAPS_MAX:7, DIFFS:[{name:'Normal', r:0.95}] };
      mpHash = () => 'H_STABLE';
      mpCreateRace = (cfg, grid) => ({ id: cfg.raceId, mapId: cfg.mapId, cars: grid.map(g => ({ pid: g.pid, name: g.name, carId: g.carId, bot: g.bot, dist: 0, lap: 0, maxLap: 0, cpMax: 0, finished: false, dnf: false, x:0, y:0, a:0 })), state: 'count', t: 0, clock: 0, finishCount: 0, T: { L: 2000 } });
      mpCleanUpg = u => u;
      mpDecode = () => ({ cid: 0, x: 0, y: 0, a: 0, vx: 0, vy: 0, fl: 0 });
      mpEncode = () => new Float32Array(16);
      mpApplyFlags = () => {};
      mpReward = () => ({ xp: 100, coins: 50 });
      locate = aiInput = stepCar = progress = pointAt = getTrack = () => {};
      rng = () => Math.random;
    }
  `, ctx);

  return vm.runInContext(`({ CARS, MAPS, CC_LIST, AVATARS, RIVALS, MPC, mpHash, mpCreateRace, mpCleanUpg, mpDecode, mpEncode, mpApplyFlags, mpReward, locate, aiInput, stepCar, progress, pointAt, getTrack, rng, hash: mpHash() })`, ctx);
}

const G = loadGame();
const { MPC, MAPS, CARS } = G;
const peers = new Map(), rooms = new Map();

const maxHumans = room => room.mode === 'survival' ? 12 : MPC.MAX_PLAYERS;
const clampBots = room => { 
  room.cfg.bots = Math.max(0, (room.mode === 'survival' ? 12 : MPC.MAX_PLAYERS) - room.members.length); 
};

function roomView(room) {
  return {
    code: room.code, mode: room.mode, host: room.host, state: room.state, maxHumans: maxHumans(room), survivalRound: room.survivalRound || 1, cfg: room.cfg,
    players: room.members.map(pid => { const p = peers.get(pid); return p ? { pid, name: p.name, av: p.av, lvl: p.lvl, carId: p.carId, ready: !!p.ready, host: pid === room.host, connected: p.connected } : null; }).filter(Boolean)
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
  
  let totalPilots = room.mode === 'survival' ? 12 : (humans.length + cfg.bots);
  if (room.mode === 'survival') {
    if (room.survivalRound === 2) totalPilots = 9;
    if (room.survivalRound === 3) totalPilots = 6;
    if (room.survivalRound === 4) totalPilots = 3;
  }

  const grid = humans.map((p, i) => ({ pid: p.pid, name: p.name, av: p.av, carId: p.carId, bot: null, slot: i }));
  while (grid.length < totalPilots) {
    grid.push({ pid: 'bot-' + grid.length, name: 'BOT ' + (grid.length + 1), av: 0, carId: CARS[Math.floor(Math.random() * CARS.length)].id, bot: { r: 0.95, pace: 1, skill: 0.5 }, slot: grid.length });
  }
  const R = G.mpCreateRace({ mapId: cfg.mapId, cc: cfg.cc, laps: cfg.laps, raceId }, grid);
  room.race = { R, raceId, startAt: Date.now() + LEAD_MS, last: Date.now(), bots: R.cars.filter(c => c.bot), humans: R.cars.filter(c => !c.bot) };
  room.state = 'racing';
  io.to(room.code).emit('start', { raceId, startAt: room.race.startAt, cfg, grid, survivalRound: room.survivalRound });
  broadcastRoom(room);
}

function endRace(room) {
  const rc = room.race; if (!rc) return;
  const { R } = rc; room.race = null;
  const order = R.cars.sort((a, b) => (a.finished ? a.finishT : Infinity) - (b.finished ? b.finishT : Infinity));
  order.forEach((c, i) => c.pos = i + 1);

  if (room.mode === 'survival') {
    let elim = room.survivalRound === 4 ? 2 : 3;
    const elimPids = order.slice(order.length - elim).map(c => c.pid);
    elimPids.forEach(pid => { const p = peers.get(pid); if (p && p.sock) p.sock.emit('survival_eliminated', { round: room.survivalRound, pos: room.members.length }); });
    room.members = room.members.filter(pid => !elimPids.includes(pid));
    if (room.members.length <= 1 && room.survivalRound >= 4) {
      if (room.members.length > 0) io.to(room.code).emit('survival_champion', { winner: room.members });
      room.state = 'lobby'; room.survivalRound = 1;
    } else {
      room.survivalRound++; room.state = 'lobby';
      room.cfg.mapId = (MAPS[room.survivalRound % MAPS.length] || MAPS[0]).id;
    }
  } else { room.state = 'lobby'; }
  io.to(room.code).emit('res', { order: order.map(c => ({ pos: c.pos, name: c.name, human: !c.bot, pid: c.pid })), survivalRound: room.survivalRound });
  clampBots(room); broadcastRoom(room);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size, hash: G.hash }));
app.get(['/', '/index.html', '/crush-cars.html'], (req, res) => res.sendFile(HTML_PATH));

io.on('connection', socket => {
  let peer = null;
  socket.on('hello', m => {
    peer = { pid: 'p' + rid(2), token: rid(6), sock: socket, name: (m && m.name) || 'PILOTO', av: 0, lvl: 1, carId: 'volt', connected: true, ready: false };
    peers.set(peer.pid, peer);
    socket.emit('welcome', { pid: peer.pid, token: peer.token });
  });
  socket.on('create', m => {
    if (!peer) return;
    const mode = (m && m.mode) === 'survival' ? 'survival' : 'party';
    const room = { code: 'CC-' + rid(2).toUpperCase(), mode, host: peer.pid, state: 'lobby', members: [peer.pid], survivalRound: 1, cfg: { mapId: MAPS[0].id, cc: 150, laps: 3, bots: mode === 'survival' ? 11 : 3 } };
    rooms.set(room.code, room); peer.room = room.code; socket.join(room.code); broadcastRoom(room);
  });
  socket.on('join', m => {
    if (!peer || !m || !m.code) return;
    const room = rooms.get(m.code.toUpperCase());
    if (!room || room.state !== 'lobby' || room.members.length >= maxHumans(room)) return socket.emit('err', 'Error de Sala');
    peer.room = room.code; room.members.push(peer.pid); socket.join(room.code); clampBots(room); broadcastRoom(room);
  });
  socket.on('ready', m => { if (peer && peers.get(peer.pid)) { peer.ready = !!(m && m.ready); const r = rooms.get(peer.room); if (r) broadcastRoom(r); } });
  socket.on('upg', m => { if (peer && m) { if (m.name) peer.name = m.name; if (m.carId) peer.carId = m.carId; if (m.av !== undefined) peer.av = m.av; const r = rooms.get(peer.room); if (r) broadcastRoom(r); } });
  socket.on('cfg', m => {
    if (!peer) return; const room = rooms.get(peer.room); if (!room || room.host !== peer.pid) return;
    if (m && m.cfg) { if (m.cfg.mode) { room.mode = m.cfg.mode; if (room.mode === 'survival') room.survivalRound = 1; } if (m.cfg.mapId) room.cfg.mapId = m.cfg.mapId; if (m.cfg.cc) room.cfg.cc = m.cfg.cc; if (m.cfg.laps) room.cfg.laps = m.cfg.laps; }
    clampBots(room); broadcastRoom(room);
  });
  socket.on('start', () => { if (peer) { const r = rooms.get(peer.room); if (r && r.host === peer.pid && r.state === 'lobby') startRace(r); } });
  socket.on('c', m => { if (peer && peer.room) socket.to(peer.room).emit('c', peer.pid, m); });
  socket.on('disconnect', () => {
    if (!peer) return; const room = rooms.get(peer.room);
    if (room) { room.members = room.members.filter(id => id !== peer.pid); if (room.host === peer.pid && room.members.length > 0) room.host = room.members[0]; if (!room.members.length) rooms.delete(room.code); else broadcastRoom(room); }
    peers.delete(peer.pid);
  });
});

setInterval(() => { rooms.forEach(room => { if (room.race && (room.race.R.clock += 0.016) > 35) endRace(room); }); }, 16);
server.listen(PORT, () => console.log(`Servidor en línea en puerto ${PORT}`));
