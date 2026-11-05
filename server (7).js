'use strict';
/* =====================================================================
   CRUSH CARS · servidor multijugador (Express + Socket.io)

   - Carga el propio HTML del juego (crush-cars.html, junto a este archivo) y ejecuta
     en un sandbox su lógica pura: coches, circuitos, física, IA de bots, recompensas.
     Así los bots y las recompensas usan EXACTAMENTE las mismas reglas que el cliente.
   - La huella (hash) del juego debe coincidir entre cliente y servidor: sube a Render
     la MISMA versión del HTML que usan los jugadores.
   - Protocolo: cada mensaje del cliente es un evento Socket.io con el nombre del tipo
     (hello, create, join, ...) y el objeto original como dato. El servidor responde con
     eventos (welcome, room, start, snap, res, ...). El adaptador del cliente añade `t`.
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
const GRACE_MS = 25000;            // tiempo para reconectar tras perder la conexión
const LEAD_MS = 5000;              // margen entre "start" y el semáforo
const FINISH_WAIT_MS = 45000;      // tras cruzar la meta el primero, se espera a los demás este tiempo
const MAX_RACE_MS = 25 * 60 * 1000;
const BETWEEN_MS = 12000;          // supervivencia: pausa entre rondas (resultados) antes de la siguiente
const SURV_END_DELAY = 1200;       // supervivencia: margen desde que cruza el último clasificado hasta cerrar la ronda
const EV_MODES = ['off', 'one', 'chaos'];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rid = n => crypto.randomBytes(n).toString('hex');

/* =====================================================================
   CARGA DEL JUEGO (lógica pura) EN UN SANDBOX
   ===================================================================== */
function loadGame() {
  let html;
  try { html = fs.readFileSync(HTML_PATH, 'utf8'); }
  catch (e) { console.error(`✖ No encuentro el juego en ${HTML_PATH}\n  Copia tu HTML junto a server.js con el nombre crush-cars.html (o define GAME_HTML).`); process.exit(1); }
  html = html.replace(/\r\n?/g, '\n');   // el navegador normaliza los saltos de línea; el hash debe coincidir

  const s0 = html.indexOf('<script>'), s1 = html.indexOf('</script>', s0);
  if (s0 < 0 || s1 < 0) { console.error('✖ No encuentro el <script> principal en el HTML.'); process.exit(1); }
  const src = html.slice(s0 + 8, s1);

  const iR = src.indexOf('RENDER · mundo'), cut = iR < 0 ? -1 : src.lastIndexOf('/*', iR);
  const b0 = src.indexOf('/*MP-CORE-BEGIN*/'), b1 = src.indexOf('/*MP-CORE-END*/');
  if (cut < 0 || b0 < 0 || b1 < 0) { console.error('✖ El HTML no tiene los marcadores esperados (sección RENDER y MP-CORE).'); process.exit(1); }
  const partA = src.slice(0, cut);                        // datos, utilidades, circuitos, física, IA
  const partB = src.slice(b0, b1 + '/*MP-CORE-END*/'.length);   // núcleo multijugador compartido

  class Path2D { moveTo() {} lineTo() {} closePath() {} }   // buildTrack sólo necesita que existan
  const ctx = vm.createContext({ console, Path2D });
  vm.runInContext('const Q = { lvl: 0, fx: 0, dprCap: 1, ema: 16.7, bad: 0 };', ctx);
  vm.runInContext(partA, ctx, { filename: 'game-core.js' });
  vm.runInContext(partB, ctx, { filename: 'game-mp-core.js' });
  vm.runInContext('emit = function () {};', ctx);               // sin partículas en el servidor
  return vm.runInContext(`({ CARS, CAR_BY_ID, MAPS, CC_LIST, AVATARS, RIVALS, MPC,
    mpHash, mpCreateRace, mpCollide, mpEncode, mpDecode, mpApplyFlags, mpReward, mpCleanUpg,
    collide, locate, aiInput, stepCar, progress, pointAt, getTrack, rng, CC, SURV_MAPS, SURV_ROUNDS, SURV_NAMES, hash: mpHash() })`, ctx);
}
const G = loadGame();
const MPC = G.MPC, MAPS = G.MAPS, CARS = G.CARS;
const CAR_IDS = new Set(CARS.map(c => c.id));
console.log(`Juego cargado · ${CARS.length} coches · ${MAPS.length} circuitos · huella ${G.hash}`);

/* prueba rápida de arranque: 3 bots corren 10 s simulados; si algo del sandbox falla, se avisa ya */
(function selfTest() {
  const grid = [0, 1, 2].map(i => ({ pid: 'bot-' + i, name: 'T' + i, av: 0, carId: CARS[i].id, upg: null, col: '#fff', bot: { r: 0.95, pace: 1, skill: 0.6 }, slot: i }));
  const R = G.mpCreateRace({ mapId: MAPS[0].id, rev: false, cc: 150, laps: 1, seed: 7, raceId: 'test' }, grid, null, 'server');
  R.state = 'racing'; R.t = 0;
  for (let i = 0; i < 600; i++) {
    for (const c of R.cars) { G.aiInput(c, R, 1 / 60); G.stepCar(c, c.inp, 1 / 60, R); }
    for (const c of R.cars) G.progress(c, R, 1 / 60);
    R.t += 1 / 60;
  }
  if (!R.cars.every(c => c.dist > 500)) { console.error('✖ Autotest fallido: los bots no avanzan.'); process.exit(1); }
  console.log('Autotest OK');
})();
{ const t0 = Date.now(); for (const m of MAPS) { G.getTrack(m, false); G.getTrack(m, true); } for (const m of G.SURV_MAPS) G.getTrack(m, false); console.log(`Circuitos precargados en ${Date.now() - t0} ms`); }

/* =====================================================================
   ESTADO: jugadores (peers) y salas
   ===================================================================== */
const peers = new Map();   // pid -> peer
const rooms = new Map();   // código -> sala

const cleanText = v => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);

/* perfil enviado por el cliente: se sanea todo (nunca se confía en lo que llega) */
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
const applyProf = (peer, pr) => Object.assign(peer, pr);

function newPeer(h) {
  const base = cleanProf({ name: h && h.name, av: h && h.av });
  const p = Object.assign({ pid: 'p' + rid(4), token: rid(12), sock: null, connected: true, grace: null, room: null, ready: false, car: null, pendingRes: null }, base);
  peers.set(p.pid, p); return p;
}

/* ---------- salas ---------- */
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() { for (;;) { let s = ''; for (let i = 0; i < 5; i++) s += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]; if (!rooms.has('CC-' + s)) return 'CC-' + s; } }
function normCode(v) { v = String(v || '').toUpperCase().replace(/\s+/g, ''); if (/^[A-Z0-9]{5}$/.test(v)) v = 'CC-' + v; return v; }
const maxHumans = room => (room.mode === 'duel' ? 2 : MPC.MAX_PLAYERS);
const roomOf = peer => (peer.room ? rooms.get(peer.room) : null);
const mapById = id => MAPS.find(m => m.id === id);
const isSurv = room => room.kind === 'surv';

function blockOf(room, p) {
  if (room.cfg.unlockAll) return '';
  const map = mapById(room.cfg.mapId);
  if (!isSurv(room) && p.lvl < map.lvl) return 'nivel ' + map.lvl;      // el cliente muestra "NIVEL n"
  if (!p.owned.includes(p.carId)) return 'coche';
  return '';
}
function roomView(room) {
  const c = room.cfg;
  return {
    code: room.code, mode: room.mode, kind: room.kind, host: room.host, state: room.state, maxHumans: maxHumans(room),
    cfg: { mapId: c.mapId, rev: c.rev, cc: c.cc, laps: c.laps, bots: c.bots, diff: c.diff, unlockAll: c.unlockAll, ev: c.ev },
    surv: room.surv ? { round: room.surv.round, alive: room.surv.alive.filter(a => a.pid).map(a => a.pid) } : null,
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
const resetReady = room => { for (const pid of room.members) { const p = peers.get(pid); if (p) p.ready = false; } };
const clampBots = room => { room.cfg.bots = isSurv(room) ? Math.max(0, G.SURV_ROUNDS[0].n - room.members.length) : clamp(room.cfg.bots | 0, 0, MPC.MAX_PLAYERS - room.members.length); };   // supervivencia: 12 participantes siempre
const sendErr = (peer, msg, code) => { if (peer.sock) peer.sock.emit('err', { msg, code }); };

function fixCars(room) {      // al apagar el modo prueba, quien tenga un coche que no posee vuelve al VOLT
  for (const pid of room.members) { const p = peers.get(pid); if (p && !p.owned.includes(p.carId)) p.carId = 'volt'; }
}

function closeRoom(room) { room.race = null; if (room.surv) clearTimeout(room.surv.timer); rooms.delete(room.code); }

function leaveRoom(peer) {
  const room = roomOf(peer); peer.room = null; peer.ready = false;
  const car = peer.car; peer.car = null;
  if (!room) return;
  if (peer.sock) peer.sock.leave(room.code);
  if (room.race && car) { car.dnf = true; car.ghost = true; car.vx = car.vy = 0; }
  room.members = room.members.filter(id => id !== peer.pid);
  if (!room.members.length) { closeRoom(room); return; }
  if (room.host === peer.pid) room.host = room.members.find(id => peers.get(id).connected) || room.members[0];
  if (room.surv) {      // supervivencia: quien se va deja de contar; sin humanos vivos el torneo se cancela
    room.surv.alive = room.surv.alive.filter(a => a.pid !== peer.pid);
    if (!room.race && !room.surv.alive.some(a => a.pid)) abortSurv(room);
  }
  clampBots(room);
  broadcastRoom(room);
}
function dropPeer(peer) { leaveRoom(peer); clearTimeout(peer.grace); peers.delete(peer.pid); }

/* =====================================================================
   CARRERA (servidor autoritativo para los bots; los humanos simulan su coche)
   ===================================================================== */
function shuffle(a, rnd) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function startRace(room) {
  const cfg = room.cfg, map = mapById(cfg.mapId), seed = crypto.randomInt(1, 2 ** 31 - 1), raceId = 'R' + Date.now().toString(36) + rid(3);
  const rnd = G.rng(seed);
  const humans = room.members.map(pid => peers.get(pid)), total = humans.length + cfg.bots;
  const slots = shuffle([...Array(total).keys()], rnd);
  const grid = humans.map((p, i) => ({ pid: p.pid, name: p.name, av: p.av, carId: p.carId, upg: p.upg, bot: null, slot: slots[i] }));
  const baseR = MPC.DIFFS[cfg.diff].r;
  for (let i = 0; i < cfg.bots; i++) {
    const base = CARS[map.pool[i % map.pool.length]], riv = G.RIVALS[i % G.RIVALS.length];
    const r = clamp(baseR + (rnd() - 0.5) * 0.04, 0.8, 1.1);
    grid.push({ pid: 'bot-' + i, name: riv.name + (i >= G.RIVALS.length ? ' 2' : ''), av: 0, carId: base.id, upg: null, col: riv.col,
      bot: { r, pace: 0.985 + rnd() * 0.03, skill: clamp(lerp(0.3, 1, clamp((r - 0.86) / 0.21, 0, 1)), 0, 1) }, slot: slots[humans.length + i] });
  }
  const cfgPub = { mapId: cfg.mapId, rev: cfg.rev, cc: cfg.cc, laps: cfg.laps, seed, raceId, unlockAll: cfg.unlockAll, ev: cfg.ev };
  beginRace(room, cfgPub, grid, null);
}
/* crea la carrera en el servidor y avisa a los participantes (targets: pids que la juegan; null = toda la sala) */
function beginRace(room, cfgPub, grid, targets, surv) {
  const R = G.mpCreateRace(cfgPub, grid, null, 'server');
  const startAt = Date.now() + LEAD_MS;
  const rc = { R, raceId: cfgPub.raceId, cfgPub, startAt, last: Date.now(), snapAcc: 0, seq: 0, firstFin: 0, humans: [], bots: [], surv: surv || null, kT: 0 };
  for (const c of R.cars) {
    if (c.bot) { c.stuckT = 0; rc.bots.push(c); }
    else { rc.humans.push(c); const p = peers.get(c.pid); if (p) p.car = c; }
  }
  room.race = rc; room.state = 'racing'; resetReady(room);
  const msg = { raceId: cfgPub.raceId, startAt, cfg: cfgPub, grid };
  if (targets) { for (const pid of targets) { const p = peers.get(pid); if (p && p.sock) p.sock.emit('start', msg); } }
  else io.to(room.code).emit('start', msg);
  broadcastRoom(room);
}

/* =====================================================================
   SUPERVIVENCIA ONLINE · 12→9→6→3→1 (el servidor decide quién avanza)
   ===================================================================== */
function survBot(S) {      // piloto bot nuevo con identidad propia (se conserva entre rondas mientras siga vivo)
  const names = G.SURV_NAMES; let i = 0; while (i < names.length && S.used.has(i)) i++;
  const rid2 = i < names.length ? i : 100 + S.used.size;
  S.used.add(rid2);
  const nm = i < names.length ? names[i] : ['BOT ' + (rid2 - 99), '#cfd8ff'];
  const e = { rid: rid2, name: nm[0], col: nm[1], bi: rid2 % CARS.length, q: Math.random() };
  S.bots['bot-' + rid2] = e; return e;
}
function startSurvRound(room) {
  const S = room.surv; if (!S) return;
  clearTimeout(S.timer);
  const rd = G.SURV_ROUNDS[S.round], map = G.SURV_MAPS[S.round];
  const humans = S.alive.filter(a => a.pid).map(a => peers.get(a.pid)).filter(p => p && p.connected && p.room === room.code);
  if (!humans.length) return abortSurv(room);
  S.alive = humans.map(p => ({ pid: p.pid })).concat(S.alive.filter(a => !a.pid));
  let bots = S.alive.filter(a => !a.pid);
  while (humans.length + bots.length < rd.n) bots.push(survBot(S));
  bots = bots.slice(0, rd.n - humans.length); S.alive = humans.map(p => ({ pid: p.pid })).concat(bots);
  const seed = crypto.randomInt(1, 2 ** 31 - 1), raceId = 'R' + Date.now().toString(36) + rid(3), rnd = G.rng(seed);
  const slots = shuffle([...Array(rd.n).keys()], rnd);
  const grid = humans.map((p, i) => ({ pid: p.pid, name: p.name, av: p.av, carId: p.carId, upg: p.upg, bot: null, slot: slots[i] }));
  const [lo, hi] = map.ai, dd = (room.cfg.diff - 1) * 0.02;       // la dificultad elegida ajusta ligeramente el ritmo (NORMAL = el de la pista)
  bots.forEach((e, i) => {
    const r = clamp(lo + (hi - lo) * e.q + (rnd() - 0.5) * 0.02 + dd, 0.8, 1.1);
    grid.push({ pid: 'bot-' + e.rid, name: e.name, av: 0, carId: CARS[e.bi % CARS.length].id, upg: null, col: e.col,
      bot: { r, pace: 0.985 + rnd() * 0.03, skill: clamp(lerp(0.3, 1, clamp((r - 0.86) / 0.21, 0, 1)), 0, 1) }, slot: slots[humans.length + i] });
  });
  const surv = { round: S.round, k: rd.k, n: rd.n };
  const cfgPub = { mapId: map.id, rev: false, cc: room.cfg.cc, laps: map.laps, seed, raceId, unlockAll: false, ev: room.cfg.ev, surv };
  room.cfg.mapId = map.id; room.cfg.laps = map.laps;
  beginRace(room, cfgPub, grid, humans.map(p => p.pid), surv);
}
function abortSurv(room) {
  const S = room.surv; if (S) clearTimeout(S.timer);
  room.surv = null; room.race = null; room.state = 'lobby'; room.cfg.mapId = G.SURV_MAPS[0].id; room.cfg.laps = G.SURV_MAPS[0].laps; resetReady(room);
  for (const pid of room.members) { const p = peers.get(pid); if (p) p.car = null; }
}
const SURV_PAY = [[120, 50], [200, 80], [320, 120], [900, 300]];   // monedas y XP por ronda (como en solitario): [clasificado], eliminado = 30/12 × (ronda+1)
function endSurvRound(room) {
  const rc = room.race, S = room.surv; room.race = null;
  const R = rc.R, order = rank(R), rd = G.SURV_ROUNDS[S.round], k = rd.k, last = S.round === G.SURV_ROUNDS.length - 1;
  const qual = order.slice(0, k), qset = new Set(qual.map(c => c.pid));
  const rows = order.map(c => ({ pos: c.pos, pid: c.pid, name: c.name, av: c.av || 0, human: !c.bot, carId: c.carId, fin: !!c.finished, finT: c.finished ? c.finishT : null, best: c.bestLap == null ? null : c.bestLap, dnf: !!c.dnf && !c.finished, q: c.pos <= k }));
  const humansLeft = qual.filter(c => !c.bot && peers.get(c.pid) && peers.get(c.pid).room === room.code);
  const over = last || !humansLeft.length;
  const champ = last ? { pid: order[0].pid, name: order[0].name, human: !order[0].bot } : null;
  const nextMap = !over ? G.SURV_MAPS[S.round + 1] : null, nextRd = !over ? G.SURV_ROUNDS[S.round + 1] : null, nextAt = Date.now() + BETWEEN_MS;
  const base = { raceId: rc.raceId, n: R.cars.length, test: false, cfg: { mapId: rc.cfgPub.mapId, rev: false, cc: R.cc, laps: R.map.laps }, order: rows,
    surv: { round: S.round, k, n: rd.n, last, over, champ, nextAt: over ? 0 : nextAt, nextMap: nextMap ? { id: nextMap.id, name: nextMap.name } : null, nextN: nextRd ? nextRd.n : 0, nextK: nextRd ? nextRd.k : 0 } };
  const f = G.CC[R.cc] ? G.CC[R.cc].rw : 1;
  for (const pid of room.members) {
    const p = peers.get(pid); if (!p) continue;
    const car = R.cars.find(x => x.pid === pid); let mine;
    if (car) { const ok = qset.has(car.pid), t = SURV_PAY[S.round]; mine = { raceId: rc.raceId, pos: car.pos, n: R.cars.length, surv: true, coins: Math.round((ok ? t[0] : 30 * (S.round + 1)) * f), xp: Math.round((ok ? t[1] : 12 * (S.round + 1)) * f) }; }
    const payload = Object.assign({}, base, { mine });
    if (p.sock) p.sock.emit('res', payload); else if (car) p.pendingRes = payload;
    p.car = null; p.ready = false;
  }
  if (over) { room.surv = null; room.state = 'lobby'; room.cfg.mapId = G.SURV_MAPS[0].id; room.cfg.laps = G.SURV_MAPS[0].laps; }
  else {
    S.alive = qual.map(c => (c.bot ? S.bots[c.pid] : { pid: c.pid })).filter(Boolean); S.round++; S.nextAt = nextAt;
    S.timer = setTimeout(() => { try { startSurvRound(room); } catch (e) { console.error(e); abortSurv(room); broadcastRoom(room); } }, BETWEEN_MS);
  }
  broadcastRoom(room);
}

function rank(R) {
  const grp = c => (c.finished ? 0 : c.dnf ? 2 : 1);
  const order = R.cars.slice().sort((a, b) => grp(a) - grp(b) || (grp(a) === 0 ? a.finishT - b.finishT : b.dist - a.dist));
  order.forEach((c, i) => { c.pos = i + 1; });
  return order;
}

function tickRoom(room, now) {
  const rc = room.race, R = rc.R;
  let dt = (now - rc.last) / 1000; if (dt < 0.004) return;
  rc.last = now; dt = Math.min(dt, 0.05); R.clock += dt;
  const want = (now - rc.startAt) / 1000;
  if (R.state === 'count') { R.t = want; if (want >= 0) { R.state = 'racing'; R.t = 0; } }
  else {
    R.t = Math.max(0, want);
    const bots = rc.bots, n = Math.max(1, Math.ceil(dt / 0.011)), h = dt / n;
    for (let s = 0; s < n; s++) {
      for (const c of bots) { G.aiInput(c, R, h); G.stepCar(c, c.inp, h, R); }
      for (const c of bots) G.progress(c, R, h);
      for (let i = 0; i < bots.length; i++) {
        for (let j = i + 1; j < bots.length; j++) G.collide(bots[i], bots[j], R);     // bot-bot: simétrico
        for (const o of rc.humans) G.mpCollide(bots[i], o, R);                          // bot-humano: sólo mueve al bot
      }
      R.t += h;
    }
    for (const c of bots) {      // rescate de bots atascados
      if (c.finished) continue;
      if (Math.hypot(c.vx, c.vy) < 30 && R.t > 1) c.stuckT += dt; else c.stuckT = 0;
      if (c.stuckT > 2.2) { const p = G.pointAt(R.T, c.s, 0); c.x = p.x; c.y = p.y; c.a = p.a; c.vx = c.vy = 0; c.spin = 0; c.stuckT = 0; }
    }
  }
  rank(R);
  rc.snapAcc += dt;
  if (rc.snapAcc >= 1 / MPC.SNAP_HZ - 0.002) {
    rc.snapAcc = 0; rc.seq++;
    const snap = { q: rc.seq, rt: want, c: R.cars.map(c => Array.from(G.mpEncode(c))) };
    if (rc.surv) { for (const c of rc.humans) { const p = peers.get(c.pid); if (p && p.sock) p.sock.volatile.emit('snap', snap); } }   // supervivencia: los eliminados no reciben la carrera
    else io.to(room.code).volatile.emit('snap', snap);
  }
  // fin de carrera
  const hs = R.cars.filter(c => !c.bot);
  if (!rc.firstFin && hs.some(c => c.finished)) rc.firstFin = now;
  if (rc.surv) {       // la ronda acaba cuando han cruzado los k clasificados (o ya nadie humano corre)
    if (!rc.kT && R.cars.filter(c => c.finished).length >= rc.surv.k) rc.kT = now;
    if (rc.kT && now - rc.kT > SURV_END_DELAY) return endRace(room);
  }
  if (!hs.some(c => !c.finished && !c.dnf) || (rc.firstFin && now - rc.firstFin > FINISH_WAIT_MS) || now - rc.startAt > MAX_RACE_MS) endRace(room);
}

/* progreso de un coche humano a partir de las posiciones que envía su cliente (con checkpoints anti-atajo) */
function humanProgress(c, R, tNow, claimedFinT) {
  const T = R.T, sPrev = c.s;
  G.locate(c, T);
  const d = c.s - sPrev;
  if (d < -T.L / 2) {                                   // cruza la meta hacia delante
    if (c.cpMax >= MPC.CP - 1) {                        // sólo vale si ha pasado por todos los sectores
      c.lap++; c.cpMax = 0;
      if (c.lap > c.maxLap) {
        c.maxLap = c.lap;
        if (c.lap >= 1) { const lt = tNow - c.lapStart; c.lapTimes.push(lt); if (c.bestLap == null || lt < c.bestLap) c.bestLap = lt; }
        c.lapStart = tNow;
        if (c.lap >= R.map.laps && !c.finished) {
          c.finished = true; c.finishPos = ++R.finishCount;
          c.finishT = claimedFinT > 0 && claimedFinT <= tNow + 0.15 && claimedFinT >= tNow - 1.0 ? claimedFinT : tNow;
        }
      }
    }
  } else if (d > T.L / 2) { c.lap--; c.cpMax = MPC.CP - 1; }   // cruza hacia atrás
  else {
    const sec = Math.floor(c.s / (T.L / MPC.CP));
    if (c.cpMax < MPC.CP - 1 && sec > c.cpMax && sec <= c.cpMax + 2) c.cpMax = Math.min(sec, MPC.CP - 1);
  }
  c.dist = c.lap * T.L + c.s;
}

function onState(peer, m) {
  const room = roomOf(peer), rc = room && room.race, c = peer.car;
  if (!rc || !c || c.dnf) return;
  const a = m && m.s;
  if (!Array.isArray(a) || a.length !== 16) return;
  for (let i = 0; i < 16; i++) if (typeof a[i] !== 'number' || !isFinite(a[i])) return;
  const d = G.mpDecode(a); if (d.cid !== c.cid) return;
  const R = rc.R, now = Date.now();
  if (R.state === 'count') { c.lastPkt = now; return; }         // nadie se mueve antes de la salida
  const dtp = c.lastPkt ? clamp((now - c.lastPkt) / 1000, 0.01, 1.0) : 0.05;
  if (c.live && Math.hypot(d.x - c.x, d.y - c.y) > c.maxV * dtp * 1.2 + 150) {   // salto imposible: se ignora
    if (++c.strikes > 15) { c.dnf = true; c.ghost = true; if (peer.sock) peer.sock.emit('kick', { msg: 'Expulsado de la carrera: datos no válidos.' }); leaveRoom(peer); }
    return;
  }
  c.strikes = Math.max(0, c.strikes - 0.02);
  const vmx = c.maxV * 1.1; let vx = d.vx, vy = d.vy; const sp = Math.hypot(vx, vy);
  if (sp > vmx) { vx *= vmx / sp; vy *= vmx / sp; }
  c.x = clamp(d.x, -1e6, 1e6); c.y = clamp(d.y, -1e6, 1e6); c.a = d.a; c.vx = vx; c.vy = vy;
  G.mpApplyFlags(c, d.fl);
  c.abT = clamp(d.abT, 0, 20); c.abCd = clamp(d.abCd, 0, 80); c.nitro = clamp(d.nitro, 0, 400);
  c.spin = clamp(d.spin, -5, 5); c.steer = clamp(d.steer, -1, 1);
  c.ghost = c.ghost && c.carId === 'mirage' && c.abT > 0;       // habilidades: sólo cuentan si el coche las tiene
  c.shield = c.shield && c.carId === 'bulwark' && c.abT > 0;
  c.gone = false; c.live = true; c.lastPkt = now;
  const tNow = (now - rc.startAt) / 1000;
  if (!c.finished) humanProgress(c, R, tNow, d.fl & 64 ? d.finT : 0); else G.locate(c, R.T);
}

function endRace(room) {
  const rc = room.race; if (!rc) return;
  if (room.surv) return endSurvRound(room);
  room.race = null; room.state = 'lobby';
  const R = rc.R, order = rank(R), n = R.cars.length, test = !!rc.cfgPub.unlockAll;
  const rows = order.map(c => ({ pos: c.pos, pid: c.pid, name: c.name, av: c.av || 0, human: !c.bot, carId: c.carId, fin: !!c.finished, finT: c.finished ? c.finishT : null, best: c.bestLap == null ? null : c.bestLap, dnf: !!c.dnf && !c.finished }));
  const base = { raceId: rc.raceId, n, test, cfg: { mapId: rc.cfgPub.mapId, rev: R.rev, cc: R.cc, laps: R.map.laps }, order: rows };
  for (const pid of room.members) {
    const p = peers.get(pid); if (!p) continue;
    const car = R.cars.find(x => x.pid === pid); let mine;
    if (!test && car && car.finished) mine = Object.assign({ raceId: rc.raceId }, G.mpReward(car.pos, n, R.map, R.cc, R.rev));
    const payload = Object.assign({}, base, { mine });
    if (p.sock) p.sock.emit('res', payload); else p.pendingRes = payload;   // si está reconectando, se entrega al volver
    p.car = null; p.ready = false;
  }
  broadcastRoom(room);
}

/* =====================================================================
   SERVIDOR HTTP + SOCKET.IO
   ===================================================================== */
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 1e5, pingInterval: 10000, pingTimeout: 15000 });

app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size, peers: peers.size, hash: G.hash }));
app.get(['/', '/index.html', '/crush-cars.html'], (req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(HTML_PATH); });

const safe = fn => (...a) => { try { fn(...a); } catch (e) { console.error(e); } };

io.on('connection', socket => {
  socket.data.w = Date.now(); socket.data.n = 0; socket.data.peer = null;
  socket.use((pkt, next) => {      // límite de mensajes por segundo
    const now = Date.now(); if (now - socket.data.w > 1000) { socket.data.w = now; socket.data.n = 0; }
    if (++socket.data.n > 240) return; next();
  });
  const P = () => socket.data.peer;

  socket.on('hello', safe(m => {
    if (socket.data.peer) return;
    if (!m || m.proto !== MPC.PROTO || m.hash !== G.hash) {
      socket.emit('err', { code: 'version', msg: 'La versión del juego no coincide con la del servidor. Recarga la página o sube al servidor el mismo HTML.' });
      setTimeout(() => socket.disconnect(true), 300); return;
    }
    let peer = null, resumed = false;
    if (m.resume && typeof m.resume.pid === 'string') { const p = peers.get(m.resume.pid); if (p && p.token === m.resume.token) { peer = p; resumed = true; } }
    if (!peer) peer = newPeer(m);
    else {
      const old = peer.sock; if (old && old !== socket) { old.data.peer = null; old.disconnect(true); }
      clearTimeout(peer.grace); peer.connected = true;
    }
    peer.sock = socket; socket.data.peer = peer;
    socket.emit('welcome', { pid: peer.pid, token: peer.token, resumed });
    if (resumed) {
      const room = roomOf(peer);
      if (room) {
        socket.join(room.code);
        if (peer.car) peer.car.gone = false;
        broadcastRoom(room);
      }
      if (peer.pendingRes) { socket.emit('res', peer.pendingRes); peer.pendingRes = null; }
    }
  }));

  socket.on('ping', safe(m => socket.emit('pong', { c: m && m.c, s: Date.now() })));

  socket.on('create', safe(m => {
    const peer = P(); if (!peer) return;
    if (peer.room) leaveRoom(peer);
    applyProf(peer, cleanProf(m && m.prof)); peer.ready = false;
    const kind = m && m.kind === 'surv' ? 'surv' : 'race', mode = kind === 'surv' || (m && m.mode === 'party') ? 'party' : 'duel', c = (m && m.cfg) || {};
    let map = kind === 'surv' ? G.SURV_MAPS[0] : (mapById(c.mapId) || MAPS[0]); if (kind !== 'surv' && peer.lvl < map.lvl) map = MAPS[0];
    const room = { code: newCode(), mode, kind, surv: null, host: peer.pid, state: 'lobby', members: [peer.pid], race: null,
      cfg: { mapId: map.id, rev: kind === 'surv' ? false : c.rev === true, cc: G.CC_LIST.includes(Number(c.cc)) ? Number(c.cc) : 150, laps: map.laps, bots: mode === 'party' ? 3 : 0, diff: 1, unlockAll: false, ev: EV_MODES.includes(c.ev) ? c.ev : 'chaos' } };
    clampBots(room); rooms.set(room.code, room); peer.room = room.code; socket.join(room.code);
    broadcastRoom(room);
  }));

  socket.on('join', safe(m => {
    const peer = P(); if (!peer) return;
    const code = normCode(m && m.code), room = rooms.get(code);
    if (!room) return sendErr(peer, 'La sala no existe.');
    if (peer.room === code) return broadcastRoom(room);
    if (room.state === 'racing') return sendErr(peer, 'La carrera ya ha empezado.');
    if (room.members.length >= maxHumans(room)) return sendErr(peer, 'La sala está llena.');
    if (peer.room) leaveRoom(peer);
    applyProf(peer, cleanProf(m && m.prof)); peer.ready = false;
    room.members.push(peer.pid); peer.room = code; socket.join(code);
    clampBots(room); broadcastRoom(room);
  }));

  socket.on('leave', safe(() => { const peer = P(); if (peer) leaveRoom(peer); }));

  socket.on('prof', safe(m => {
    const peer = P(), room = peer && roomOf(peer); if (!room || room.state !== 'lobby') return;
    applyProf(peer, cleanProf(m && m.prof)); peer.ready = false; broadcastRoom(room);
  }));

  socket.on('ready', safe(m => {
    const peer = P(), room = peer && roomOf(peer); if (!room || room.state !== 'lobby' || room.host === peer.pid) return;
    peer.ready = !!(m && m.v) && !blockOf(room, peer); broadcastRoom(room);
  }));

  socket.on('kick', safe(m => {
    const peer = P(), room = peer && roomOf(peer); if (!room || room.host !== peer.pid || room.state !== 'lobby') return;
    const t = m && peers.get(m.pid); if (!t || t === peer || t.room !== room.code) return;
    if (t.sock) t.sock.emit('kick', { msg: 'El anfitrión te ha expulsado de la sala.' });
    leaveRoom(t);
  }));

  socket.on('cfg', safe(m => {
    const peer = P(), room = peer && roomOf(peer); if (!room || room.host !== peer.pid || room.state !== 'lobby') return;
    const p = m && m.cfg; if (!p || typeof p !== 'object') return;
    const cfg = room.cfg; let changed = false, err = '';
    if ('ev' in p && EV_MODES.includes(p.ev) && p.ev !== cfg.ev) { cfg.ev = p.ev; changed = true; }
    const sv = isSurv(room);      // supervivencia: pistas, vueltas, sentido, bots y modo de prueba son fijos
    if ('mode' in p && !sv) {
      const md = p.mode === 'party' ? 'party' : 'duel';
      if (md === 'duel' && room.members.length > 2) err = 'Hay más de 2 jugadores: usa AMIGOS + BOTS.';
      else if (md !== room.mode) { room.mode = md; changed = true; }
    }
    if ('unlockAll' in p && !sv) { const v = p.unlockAll === true; if (v !== cfg.unlockAll) { cfg.unlockAll = v; changed = true; if (!v) fixCars(room); } }
    if ('mapId' in p && !sv) {
      const mp = mapById(p.mapId);
      if (!mp) err = 'Circuito no válido.';
      else if (!cfg.unlockAll && peer.lvl < mp.lvl) err = 'Circuito bloqueado: necesitas nivel ' + mp.lvl + '.';
      else if (mp.id !== cfg.mapId) { cfg.mapId = mp.id; changed = true; }
    }
    if ('rev' in p && !sv) { const v = p.rev === true; if (v !== cfg.rev) { cfg.rev = v; changed = true; } }
    if ('cc' in p && G.CC_LIST.includes(Number(p.cc)) && Number(p.cc) !== cfg.cc) { cfg.cc = Number(p.cc); changed = true; }
    if ('laps' in p && !sv) { const v = clamp(Math.floor(Number(p.laps)) || 1, 1, MPC.LAPS_MAX); if (v !== cfg.laps) { cfg.laps = v; changed = true; } }
    if ('diff' in p) { const v = clamp(Math.floor(Number(p.diff)) || 0, 0, MPC.DIFFS.length - 1); if (v !== cfg.diff) { cfg.diff = v; changed = true; } }
    if ('bots' in p && !sv) { const v = clamp(Math.floor(Number(p.bots)) || 0, 0, MPC.MAX_PLAYERS - room.members.length); if (v !== cfg.bots) { cfg.bots = v; changed = true; } }
    if (err) sendErr(peer, err);
    if (changed) { clampBots(room); resetReady(room); broadcastRoom(room); }
  }));

  socket.on('start', safe(() => {
    const peer = P(), room = peer && roomOf(peer); if (!room || room.host !== peer.pid || room.state !== 'lobby') return;
    const ps = room.members.map(id => peers.get(id));
    if (ps.some(p => !p.connected)) return sendErr(peer, 'Hay jugadores desconectados.');
    if (ps.some(p => blockOf(room, p))) return sendErr(peer, 'Algún jugador no cumple los requisitos (nivel o coche).');
    if (!isSurv(room) && ps.length + room.cfg.bots < 2) return sendErr(peer, 'Hacen falta al menos 2 participantes (añade bots o espera a un amigo).');
    if (!ps.every(p => p.pid === room.host || p.ready)) return sendErr(peer, 'Faltan jugadores por marcar "LISTO".');
    if (isSurv(room)) { room.surv = { round: 0, alive: room.members.map(pid => ({ pid })), bots: {}, used: new Set(), timer: null, nextAt: 0 }; startSurvRound(room); }
    else startRace(room);
  }));

  socket.on('st', safe(m => { const peer = P(); if (peer) onState(peer, m); }));

  socket.on('disconnect', safe(() => {
    const peer = P(); if (!peer || peer.sock !== socket) return;
    peer.sock = null; peer.connected = false;
    const room = roomOf(peer);
    if (!room) { peers.delete(peer.pid); return; }
    if (peer.car) { peer.car.gone = true; peer.car.ghost = true; }
    broadcastRoom(room);
    peer.grace = setTimeout(() => { if (!peer.connected) dropPeer(peer); }, GRACE_MS);   // si no vuelve a tiempo, abandona
  }));
});

/* bucle de simulación de las carreras activas (~60 Hz) */
setInterval(() => {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    if (!room.race) continue;
    try { tickRoom(room, now); } catch (e) { console.error('Error en la carrera', room.code, e); try { endRace(room); } catch (e2) { closeRoom(room); } }
  }
}, 16);

process.on('uncaughtException', e => console.error('uncaughtException', e));
process.on('unhandledRejection', e => console.error('unhandledRejection', e));
server.listen(PORT, () => console.log(`Servidor CRUSH CARS escuchando en el puerto ${PORT}`));
