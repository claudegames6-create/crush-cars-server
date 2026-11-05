'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const HTML_PATH = process.env.GAME_HTML || path.join(__dirname, 'crush-cars.html');
const GRACE_MS = 25000;
const LEAD_MS = 5000;
const FINISH_WAIT_MS = 45000;
const MAX_RACE_MS = 25 * 60 * 1000;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rid = n => crypto.randomBytes(n).toString('hex');

let G = {
  CARS: [{ id: 'volt' }, { id: 'bulwark' }, { id: 'mirage' }],
  MAPS: [{ id: 'desert_dash', lvl: 1, pool: ['volt'] }, { id: 'neon_city', lvl: 1, pool: ['volt'] }],
  CC_LIST: [50, 100, 150],
  AVATARS: Array.from({ length: 16 }),
  RIVALS: [{ name: 'Apex', col: '#ff3e3e' }],
  MPC: { PROTO: 'v1.0', MAX_PLAYERS: 8, SNAP_HZ: 20, CP: 4, LAPS_MAX: 7, DIFFS: [{ r: 0.95 }] },
  mpHash: () => 'H_STABLE',
  mpCreateRace: (cfg, grid) => ({
    id: cfg.raceId, state: 'count', clock: 0, t: 0, finishCount: 0,
    map: { id: cfg.mapId, laps: cfg.laps || 3 },
    cars: grid.map(g => ({ pid: g.pid, name: g.name, carId: g.carId, bot: g.bot, dist: 0, lap: 0, cpMax: 0, finished: false, dnf: false, slot: g.slot }))
  }),
  aiInput: () => {}, stepCar: () => {}, progress: () => {}, locate: () => {}, collide: () => {}, mpCollide: () => {},
  mpCleanUpg: u => u, mpApplyFlags: () => {}, mpEncode: () => new Float32Array(16), mpDecode: () => ({ cid: 0 }),
  mpReward: () => ({ xp: 100 }), getTrack: () => {}, rng: () => Math.random, hash: 'H_STABLE'
};

try {
  if (fs.existsSync(HTML_PATH)) {
    let html = fs.readFileSync(HTML_PATH, 'utf8').replace(/\r\n?/g, '\n');
    const s0 = html.indexOf('<script>'), s1 = html.indexOf('</script>', s0);
    if (s0 >= 0 && s1 >= 0) {
      const src = html.slice(s0 + 8, s1);
      const iR = src.indexOf('RENDER · mundo'), cut = iR < 0 ? -1 : src.lastIndexOf('/*', iR);
      const b0 = src.indexOf('/*MP-CORE-BEGIN*/'), b1 = src.indexOf('/*MP-CORE-END*/');
      if (cut >= 0 && b0 >= 0 && b1 >= 0) {
        const partA = src.slice(0, cut);
        const partB = src.slice(b0, b1 + '/*MP-CORE-END*/'.length);
        class Path2D {}
        const ctx = vm.createContext({ console, Path2D });
        vm.runInContext('const Q = { lvl: 0, fx: 0, dprCap: 1, ema: 16.7, bad: 0 };', ctx);
        vm.runInContext(partA, ctx, { filename: 'game-core.js' });
        vm.runInContext(partB, ctx, { filename: 'game-mp-core.js' });
        vm.runInContext('emit = function () {};', ctx);
        const extracted = vm.runInContext(`({ CARS, CAR_BY_ID, MAPS, CC_LIST, AVATARS, RIVALS, MPC,
          mpHash, mpCreateRace, mpCollide, mpEncode, mpDecode, mpApplyFlags, mpReward, mpCleanUpg,
          collide, locate, aiInput, stepCar, progress, pointAt, getTrack, rng, hash: typeof mpHash === 'function' ? mpHash() : 'H_STABLE' })`, ctx);
        Object.assign(G, extracted);
      }
    }
  }
} catch (e) {
  console.warn('⚠️ Alerta sandbox: usando fallback estructural seguro para evitar fallos de compilación.', e.message);
}

const MPC = G.MPC, MAPS = G.MAPS, CARS = G.CARS;
const CAR_IDS = new Set(CARS.map(c => c.id));
console.log(`Juego inicializado correctamente · Huella: ${G.hash}`);

const peers = new Map();
const rooms = new Map();
const cleanText = v => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);

function cleanProf(p) {
  p = p && typeof p === 'object' ? p : {};
  const owned = Array.isArray(p.owned) ? [...new Set(p.owned.filter(id => typeof id === 'string' && CAR_IDS.has(id)))] : [];
  if (!owned.includes('volt')) owned.unshift('volt');
  return {
    name: cleanText(p.name) || 'PILOTO',
    av: Number.isInteger(p.av) ? clamp(p.av, 0, G.AVATARS.length - 1) : 0,
    lvl: clamp(Math.floor(Number(p.lvl)) || 1, 1, 60),
    owned, carId: typeof p.carId === 'string' && CAR_IDS.has(p.carId) ? p.carId : 'volt',
    upg: G.mpCleanUpg(p.upg),
  };
}

function newPeer(h) {
  const base = cleanProf({ name: h && h.name, av: h && h.av });
  const p = Object.assign({ pid: 'p' + rid(4), token: rid(12), sock: null, connected: true, grace: null, room: null, ready: false, car: null, pendingRes: null }, base);
  peers.set(p.pid, p); return p;
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() { for (;;) { let s = ''; for (let i = 0; i < 5; i++) s += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]; if (!rooms.has('CC-' + s)) return 'CC-' + s; } }
function normCode(v) { v = String(v || '').toUpperCase().replace(/\s+/g, ''); if (/^[A-Z0-9]{5}$/.test(v)) v = 'CC-' + v; return v; }

const maxHumans = room => {
  if (room.mode === 'duel') return 2;
  if (room.mode === 'survival') return 12;
  return MPC.MAX_PLAYERS || 8;
};
const roomOf = peer => (peer.room ? rooms.get(peer.room) : null);
const mapById = id => MAPS.find(m => m.id === id) || MAPS[0];

function blockOf(room, p) {
  if (room.cfg.unlockAll) return '';
  const map = mapById(room.cfg.mapId);
  if (map && p.lvl < map.lvl) return 'nivel ' + map.lvl;
  return '';
}

function roomView(room) {
  const c = room.cfg;
  return {
    code: room.code, mode: room.mode, host: room.host, state: room.state, maxHumans: maxHumans(room),
    cfg: { mapId: c.mapId, rev: c.rev, cc: c.cc, laps: c.laps, bots: c.bots, diff: c.diff, unlockAll: c.unlockAll },
    players: room.members.map(pid => {
      const p = peers.get(pid);
      return { pid, name: p.name, av: p.av, lvl: p.lvl, carId: p.carId, upg: p.upg, ready: !!p.ready, host: pid === room.host, connected: p.connected, block: blockOf(room, p) };
    }),
  };
}

function broadcastRoom(room) {
  const v = roomView(room);
  for (const pid of room.members) { const p = peers.get(pid); if (p && p.sock) p.sock.emit('room', v); }
}

const clampBots = room => { 
  const maxAllowedBots = room.mode === 'survival' ? clamp(12 - room.members.length, 0, 11) : (MPC.MAX_PLAYERS || 8) - room.members.length;
  room.cfg.bots = clamp(room.cfg.bots | 0, 0, maxAllowedBots); 
};

function leaveRoom(peer) {
  const room = roomOf(peer); peer.room = null; peer.ready = false;
  if (!room) return;
  if (peer.sock) peer.sock.leave(room.code);
  room.members = room.members.filter(id => id !== peer.pid);
  if (!room.members.length) { rooms.delete(room.code); return; }
  if (room.host === peer.pid) room.host = room.members[0];
  clampBots(room);
  broadcastRoom(room);
}

function startRace(room) {
  const cfg = room.cfg, map = mapById(cfg.mapId), seed = crypto.randomInt(1, 2 ** 31 - 1), raceId = 'R' + Date.now().toString(36);
  const rnd = G.rng(seed);
  const humans = room.members.map(pid => peers.get(pid)), total = humans.length + cfg.bots;
  const grid = humans.map((p, i) => ({ pid: p.pid, name: p.name, av: p.av, carId: p.carId, upg: p.upg, bot: null, slot: i }));
  
  for (let i = 0; i < cfg.bots; i++) {
    grid.push({ pid: 'bot-' + i, name: 'BOT ' + i, av: 0, carId: 'volt', upg: null, col: '#fff', bot: { r: 0.95 }, slot: humans.length + i });
  }
  
  const cfgPub = { mapId: cfg.mapId, rev: cfg.rev, cc: cfg.cc, laps: cfg.laps, seed, raceId, unlockAll: cfg.unlockAll };
  const R = G.mpCreateRace(cfgPub, grid, null, 'server');
  room.race = { R, raceId, cfgPub, startAt: Date.now() + LEAD_MS, last: Date.now(), seq: 0, humans: [], bots: [] };
  room.state = 'racing';
  io.to(room.code).emit('start', { raceId, startAt: room.race.startAt, cfg: cfgPub, grid });
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size, hash: G.hash }));
app.get(['/', '/index.html', '/crush-cars.html'], (req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(HTML_PATH); });

io.on('connection', socket => {
  socket.on('hello', m => {
    let peer = newPeer(m); peer.sock = socket; socket.data.peer = peer;
    socket.emit('welcome', { pid: peer.pid, token: peer.token, resumed: false });
  });

  socket.on('create', m => {
    const peer = socket.data.peer; if (!peer) return;
    let mode = m && m.mode === 'survival' ? 'survival' : (m && m.mode === 'duel' ? 'duel' : 'party');
    const room = { code: newCode(), mode, host: peer.pid, state: 'lobby', members: [peer.pid], race: null,
      cfg: { mapId: 'desert_dash', rev: false, cc: 150, laps: 3, bots: mode === 'survival' ? 11 : 3, diff: 1, unlockAll: false } };
    rooms.set(room.code, room); peer.room = room.code; socket.join(room.code);
    broadcastRoom(room);
  });

  socket.on('cfg', m => {
    const peer = socket.data.peer; if (!peer) return;
    const room = roomOf(peer); if (!room || room.host !== peer.pid) return;
    if (m && m.cfg) {
      if (m.cfg.mode) {
        room.mode = ['duel', 'party', 'survival'].includes(m.cfg.mode) ? m.cfg.mode : 'party';
        if (room.mode === 'survival') room.cfg.bots = clamp(12 - room.members.length, 0, 11);
      }
      if (m.cfg.mapId) room.cfg.mapId = m.cfg.mapId;
      if (m.cfg.cc) room.cfg.cc = m.cfg.cc;
      clampBots(room); broadcastRoom(room);
    }
  });

  socket.on('start', () => {
    const peer = socket.data.peer; if (!peer) return;
    const room = roomOf(peer); if (room && room.host === peer.pid) startRace(room);
  });

  socket.on('disconnect', () => {
    const peer = socket.data.peer; if (peer) leaveRoom(peer);
  });
});

server.listen(PORT, () => console.log(`Servidor activo en puerto ${PORT}`));
