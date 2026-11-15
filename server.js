#!/usr/bin/env node
'use strict';

// Ego Futsal: server-authoritative lobby, matchmaking and match simulation.
// No browser-to-browser WebRTC connection is used by the new Online Queue flow.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const GAME_FILE = path.join(__dirname, 'Ego-Futsal-Neutral-Server.html');
const MAX_FRAME = 64 * 1024;
const MAX_BUFFERED = 128 * 1024;
const rooms = new Map(); // Legacy Render room gateway retained for old clients.
const hubPlayers = new Map();
const waitingQueue = [];
const matches = new Map();

const FIELD = { halfX: 34, halfZ: 52, goalHalf: 3.66, goalHeight: 2.44, ballR: 0.4 };
const CHAR_STATS = [
  [10, 6, 7, 5, 4], [5, 10, 6, 6, 5], [7, 6, 10, 4, 5],
  [6, 5, 4, 10, 7], [6, 6, 5, 5, 10], [7, 6, 7, 6, 6]
];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const finite = (v, d = 0) => Number.isFinite(Number(v)) ? Number(v) : d;
const rid = (n = 12) => crypto.randomBytes(n).toString('hex');
const angDiff = (a, b) => ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
function cleanName(v) { return String(v || 'EGO PLAYER').replace(/[<>\x00-\x1f]/g, '').trim().slice(0, 18) || 'EGO PLAYER'; }
function charIndex(v) { return clamp(Math.floor(finite(v)), 0, 5); }

function frame(payload, opcode = 1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const n = body.length;
  let header;
  if (n < 126) header = Buffer.from([0x80 | opcode, n]);
  else if (n <= 65535) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(n, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([header, body]);
}
function send(ws, obj) {
  if (!ws || ws.destroyed || !ws.writable || typeof ws.send !== 'function') return false;
  try {
    const json = JSON.stringify(obj);
    if (Buffer.byteLength(json) > MAX_FRAME) return false;
    const transient = obj && (obj.t === 'matchState' || obj.t === 'hubPose');
    if (transient && ws.writableLength > (obj.t === 'matchState' ? 18 * 1024 : 3 * 1024)) return false;
    if (ws.writableLength > MAX_BUFFERED) { ws.destroy(); return false; }
    return ws.send(json);
  } catch (_) { return false; }
}
function reject(socket, status = '400 Bad Request') {
  try { socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); } catch (_) {}
  socket.destroy();
}

function hubPublic(p) {
  return { id: p.id, name: p.name, sel: p.sel, x: p.x, z: p.z, a: p.a, moving: !!p.moving };
}
function hubCount() { return hubPlayers.size; }
function hubBroadcast(except, message) {
  for (const p of hubPlayers.values()) if (p.ws !== except) send(p.ws, message);
}
function queueUpdatePositions() {
  waitingQueue.forEach((p, i) => send(p.ws, { t: 'queueStatus', position: i + 1, total: waitingQueue.length }));
}
function removeFromQueue(p) {
  const i = waitingQueue.indexOf(p);
  if (i >= 0) waitingQueue.splice(i, 1);
  queueUpdatePositions();
}

function createPlayer(index, selected, name) {
  const team = index < 5 ? 0 : 1;
  const local = index === 0 || index === 5;
  const selectedChar = local ? charIndex(selected) : ((index * 3 + 1) % 6);
  const sx = [0, -5, 5, 0, 0, -2.2, 2.2, -5, 5, 0][index] * FIELD.halfX / 9;
  const sd = [13.8, 10.5, 10.5, 6.5, 1.1, 13.8, 13.8, 9, 9, 1.1][index] * FIELD.halfZ / 15;
  const z = team === 0 ? FIELD.halfZ - sd : -FIELD.halfZ + sd;
  const st = CHAR_STATS[selectedChar];
  return {
    id: index, team, role: index === 4 || index === 9 ? 'gk' : 'f', human: local,
    name: local ? cleanName(name) : '', sel: selectedChar,
    x: sx, y: 0, z, vx: 0, vy: 0, vz: 0,
    a: team === 0 ? 0 : Math.PI, homeX: sx, homeZ: z,
    stamina: 100, cd: 0, slide: 0, slideCd: 0, stun: 0, jumpLatch: false,
    boost: 0, skillCd: 0, touchCd: 0, aiThink: 0,
    input: { k: 0, y: team === 0 ? 0 : Math.PI, seq: 0 },
    stats: { spd: st[0], sht: st[1], tec: st[2], def: st[3], air: st[4] }
  };
}
function makeMatch(a, b) {
  const id = rid(10);
  const slots = [a, b].map((p, slot) => ({
    id: p.id, token: rid(18), slot, name: p.name, sel: p.sel,
    ws: null, connected: false, lastSeen: Date.now()
  }));
  const m = {
    id, slots, createdAt: Date.now(), started: false, phase: 'waiting',
    phaseTimer: 0, time: 180, score: [0, 0], tickAt: Date.now(), snapshotAt: 0,
    players: Array.from({ length: 10 }, (_, i) => createPlayer(i, i === 0 ? a.sel : i === 5 ? b.sel : 0, i === 0 ? a.name : i === 5 ? b.name : '')),
    ball: { x: 0, y: FIELD.ballR, z: 0, vx: 0, vy: 0, vz: 0, curve: 0, curveTime: 0, spin: 0, touchLock: 0 },
    lastGoal: null, endSent: false
  };
  matches.set(id, m);
  slots.forEach((slot, index) => {
    const opponent = slots[1 - index];
    send(index === 0 ? a.ws : b.ws, {
      t: 'queueFound', matchId: id, token: slot.token, slot: index,
      role: index === 0 ? 'h' : 'g', players: slots.map(s => ({ name: s.name, sel: s.sel })),
      opponent: { name: opponent.name, sel: opponent.sel }
    });
  });
  return m;
}
function pumpQueue() {
  while (waitingQueue.length >= 2) {
    const a = waitingQueue.shift();
    const b = waitingQueue.shift();
    if (!a || !b || a.ws.destroyed || b.ws.destroyed) continue;
    a.queued = b.queued = false;
    makeMatchFromHub(a, b);
  }
  queueUpdatePositions();
}
function makeMatchFromHub(a, b) {
  // Each browser receives a one-time token and reconnects directly to this same server process.
  const id = rid(10);
  const slots = [a, b].map((p, slot) => ({ id: p.id, token: rid(18), slot, name: p.name, sel: p.sel, ws: null, connected: false, lastSeen: Date.now() }));
  const m = {
    id, slots, createdAt: Date.now(), started: false, phase: 'waiting', phaseTimer: 0,
    time: 180, score: [0, 0], tickAt: Date.now(), snapshotAt: 0,
    players: Array.from({ length: 10 }, (_, i) => createPlayer(i, i === 0 ? a.sel : i === 5 ? b.sel : 0, i === 0 ? a.name : i === 5 ? b.name : '')),
    ball: { x: 0, y: FIELD.ballR, z: 0, vx: 0, vy: 0, vz: 0, curve: 0, curveTime: 0, spin: 0, touchLock: 0 },
    lastGoal: null, endSent: false
  };
  matches.set(id, m);
  const list = slots.map(s => ({ name: s.name, sel: s.sel }));
  slots.forEach((slot, index) => send(index === 0 ? a.ws : b.ws, {
    t: 'queueFound', matchId: id, token: slot.token, slot: index,
    role: index === 0 ? 'h' : 'g', players: list, opponent: list[1 - index]
  }));
}
function hubJoin(ws, msg) {
  if (ws.hubPlayer) return send(ws, { t: 'hubWelcome', id: ws.hubPlayer.id, count: hubCount(), players: [...hubPlayers.values()].filter(p => p !== ws.hubPlayer).map(hubPublic) });
  const p = {
    id: rid(8), ws, name: cleanName(msg.name), sel: charIndex(msg.sel),
    x: clamp(finite(msg.x), -28, 28), z: clamp(finite(msg.z, 19.2), -28, 28),
    a: clamp(finite(msg.a), -20, 20), moving: false, lastPose: 0, lastSeen: Date.now(), queued: false
  };
  ws.hubPlayer = p;
  hubPlayers.set(p.id, p);
  send(ws, { t: 'hubWelcome', id: p.id, count: hubCount(), players: [...hubPlayers.values()].filter(q => q !== p).map(hubPublic) });
  hubBroadcast(ws, { t: 'hubEnter', player: hubPublic(p), count: hubCount() });
}
function hubLeave(ws) {
  const p = ws && ws.hubPlayer;
  if (!p) return;
  removeFromQueue(p);
  hubPlayers.delete(p.id);
  ws.hubPlayer = null;
  hubBroadcast(ws, { t: 'hubExit', id: p.id, count: hubCount() });
  hubBroadcast(null, { t: 'hubCount', count: hubCount() });
}
function joinQueue(ws) {
  const p = ws.hubPlayer;
  if (!p) return send(ws, { t: 'queueError', message: 'Hãy kết nối sảnh trước khi tìm trận.' });
  if (ws.match) return send(ws, { t: 'queueError', message: 'Bạn đang ở trong một trận đấu.' });
  if (waitingQueue.includes(p)) return queueUpdatePositions();
  p.queued = true;
  waitingQueue.push(p);
  queueUpdatePositions();
  pumpQueue();
}
function matchJoin(ws, msg) {
  const m = matches.get(String(msg.matchId || ''));
  if (!m) return send(ws, { t: 'matchError', message: 'Trận đấu không còn tồn tại. Hãy tìm trận mới.' });
  const slot = m.slots.find(s => s.token === String(msg.token || ''));
  if (!slot) return send(ws, { t: 'matchError', message: 'Mã kết nối trận đấu không hợp lệ.' });
  if (slot.ws && slot.ws !== ws && !slot.ws.destroyed) slot.ws.destroy();
  slot.ws = ws; slot.connected = true; slot.lastSeen = Date.now();
  const controlled = m.players[slot.slot === 0 ? 0 : 5];
  if (controlled) { controlled.human = true; controlled.input.k = 0; controlled.input.seq = 0; }
  ws.match = m; ws.matchSlot = slot.slot; ws.hubPlayer = null;
  send(ws, { t: 'matchWelcome', matchId: m.id, slot: slot.slot, players: m.slots.map(s => ({ name: s.name, sel: s.sel })), serverTime: Date.now() });
  if (m.slots.every(s => s.connected)) {
    m.started = true; m.phase = 'play'; m.tickAt = Date.now();
    for (const s of m.slots) send(s.ws, { t: 'matchStart', matchId: m.id, slot: s.slot, players: m.slots.map(q => ({ name: q.name, sel: q.sel })), state: matchState(m) });
  } else {
    send(ws, { t: 'matchWaiting', message: 'Đang chờ người chơi còn lại kết nối...' });
  }
}
function matchLeave(ws) {
  const m = ws && ws.match;
  if (!m) return;
  const slot = m.slots[ws.matchSlot];
  let detached = false;
  if (slot && slot.ws === ws) {
    detached = true;
    slot.ws = null; slot.connected = false; slot.lastSeen = Date.now();
    const controlled = m.players[slot.slot === 0 ? 0 : 5];
    if (controlled) { controlled.human = false; controlled.input.k = 0; controlled.input.seq = 0; }
  }
  ws.match = null; ws.matchSlot = -1;
  const other = m.slots.find(s => s !== slot);
  if (detached && other && other.ws) send(other.ws, { t: 'matchOpponentLeft', message: 'Đối thủ đã rời trận. AI sẽ tiếp quản cầu thủ.' });
  if (!m.slots.some(s => s.connected)) matches.delete(m.id);
}
function matchState(m) {
  return {
    t: 'matchState', time: Math.max(0, m.time), phase: m.phase, phaseTimer: m.phaseTimer,
    score: m.score, goal: m.lastGoal,
    players: m.players.map(p => [p.x, p.y, p.z, p.a, p.vx, p.vy, p.vz, p.stamina, p.slide, p.stun, p.cd, p.boost, p.skillCd, p.sel]),
    ball: [m.ball.x, m.ball.y, m.ball.z, m.ball.vx, m.ball.vy, m.ball.vz, m.ball.curve, m.ball.curveTime, m.ball.spin]
  };
}
function publishMatch(m, force = false) {
  const now = Date.now();
  if (!force && now - m.snapshotAt < 50) return;
  m.snapshotAt = now;
  const packet = matchState(m);
  for (const s of m.slots) if (s.ws && !s.ws.destroyed) send(s.ws, packet);
}
function resetKickoff(m) {
  for (const p of m.players) {
    const team = p.team, i = p.id;
    const sx = [0, -5, 5, 0, 0, -2.2, 2.2, -5, 5, 0][i] * FIELD.halfX / 9;
    const sd = [13.8, 10.5, 10.5, 6.5, 1.1, 13.8, 13.8, 9, 9, 1.1][i] * FIELD.halfZ / 15;
    p.x = sx; p.y = 0; p.z = team === 0 ? FIELD.halfZ - sd : -FIELD.halfZ + sd;
    p.vx = p.vy = p.vz = 0; p.slide = p.stun = 0; p.cd = 0; p.touchCd = 0;
    p.a = team === 0 ? 0 : Math.PI; p.homeX = sx; p.homeZ = p.z;
  }
  Object.assign(m.ball, { x: 0, y: FIELD.ballR, z: 0, vx: 0, vy: 0, vz: 0, curve: 0, curveTime: 0, spin: 0, touchLock: .7 });
  m.phase = 'play'; m.phaseTimer = 0;
}
function handleAction(m, slot, msg) {
  if (!m.started || m.phase !== 'play') return;
  const p = m.players[slot === 0 ? 0 : 5];
  const b = m.ball;
  const action = String(msg.action || '');
  if (action === 'slide') {
    if (p.slide <= 0 && p.slideCd <= 0 && p.stun <= 0) {
      const dx = Math.sin(p.a), dz = -Math.cos(p.a), speed = 10.5 * (.8 + .04 * p.stats.def);
      p.slide = .55; p.slideCd = 1.7 - .08 * p.stats.def; p.vx = dx * speed; p.vz = dz * speed;
    }
    return;
  }
  if (action === 'shoot') {
    const gap = Math.hypot(b.x - p.x, b.z - p.z);
    if (p.cd > 0 || p.slide > 0 || p.stun > 0 || gap > 2.25 || b.y > 1.8) return;
    const charge = clamp(finite(msg.charge), 0, 1), mode = clamp(Math.floor(finite(msg.mode)), 0, 3);
    const yaw = clamp(finite(msg.yaw, p.a), -100, 100), pitch = clamp(finite(msg.pitch), -.2, .62);
    const fx = Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = Math.sin(yaw);
    const stats = p.stats, powerMul = (p.sel === 1 ? 1.7 : 1);
    let vx, vy, vz;
    if (mode === 0) {
      const ego = charge > .95;
      const power = Math.min(56, (ego ? 42 : 12 + charge * 24) * (.7 + .06 * stats.sht)) * powerMul;
      vx = fx * power; vz = fz * power; vy = 1.2 + charge * 3.5 + power * Math.tan(pitch);
    } else {
      const curve = mode === 1 ? .22 : mode === 2 ? .3 : 0;
      const side = finite(msg.k) & 8 ? 1 : (finite(msg.k) & 2 ? -1 : (p.x < 0 ? 1 : -1));
      const base = mode === 3 ? 18 + charge * 13 : (mode === 1 ? 16 : 19) + charge * 14;
      const power = Math.min(mode === 3 ? 38 : 52, base * (.7 + .06 * stats.sht)) * powerMul;
      const dx = fx - rx * side * curve, dz = fz - rz * side * curve, l = Math.hypot(dx, dz) || 1;
      vx = dx / l * power; vz = dz / l * power;
      vy = (mode === 3 ? 7.8 + charge * 5.2 : mode === 1 ? 2.2 + charge * 5.2 : 1.3 + charge * 6) + power * Math.tan(pitch);
      b.curve = mode === 1 ? side * 10 : mode === 2 ? side * 16 : 0; b.curveTime = mode === 3 ? 0 : 1.25;
    }
    const drift = (Math.random() - .5) * (10 - stats.tec) * .022;
    const c = Math.cos(drift), s = Math.sin(drift), oldX = vx;
    vx = oldX * c - vz * s; vz = oldX * s + vz * c;
    b.vx = vx; b.vy = clamp(vy, 1, 32); b.vz = vz; b.touchLock = .2;
    p.cd = .42; p.a = yaw;
    return;
  }
  if (action === 'pass') {
    if (p.cd > .1 || p.slide > 0 || p.stun > 0 || Math.hypot(b.x - p.x, b.z - p.z) > 2.1 || b.y > 1.5) return;
    const teammates = m.players.filter(q => q.team === p.team && q.id !== p.id && q.role !== 'gk');
    let best = null, bestScore = -Infinity;
    for (const q of teammates) {
      const dx = q.x - p.x, dz = q.z - p.z, d = Math.hypot(dx, dz);
      if (d < 2.5 || d > 25) continue;
      const forward = p.team === 0 ? -dz / d : dz / d;
      const score = forward * 7 - d * .12;
      if (score > bestScore) { bestScore = score; best = q; }
    }
    const tx = best ? best.x + best.vx * .25 : p.x + Math.sin(p.a) * 8;
    const tz = best ? best.z + best.vz * .25 : p.z - Math.cos(p.a) * 8;
    const dx = tx - b.x, dz = tz - b.z, d = Math.hypot(dx, dz) || 1, speed = clamp(12 + d * .65, 15, 25);
    b.vx = dx / d * speed; b.vy = .85; b.vz = dz / d * speed; b.curve = b.curveTime = 0; b.touchLock = .25; p.cd = .4;
    return;
  }
  if (action === 'skill') {
    const skill = msg.which === 'rain' ? 'rain' : 'main';
    if (p.skillCd > 0 || p.slide > 0 || p.stun > 0 || p.role === 'gk') return;
    const distance = Math.hypot(b.x - p.x, b.z - p.z);
    const needBall = p.sel === 1 || p.sel === 2 ? 2.8 : 3.0;
    if ([1, 2, 4, 5].includes(p.sel) && (distance > needBall || b.y > 1.6)) return;
    if (p.sel === 0) { p.boost = 3.2; p.skillCd = 12; }
    else if (p.sel === 1) { const fx = Math.sin(p.a), fz = -Math.cos(p.a), power = 42 * (.7 + .06 * p.stats.sht) * 1.7; b.vx = fx * power; b.vy = 4.2; b.vz = fz * power; b.curve = b.curveTime = 0; p.cd = .45; p.skillCd = 16; }
    else if (p.sel === 2) { const fx = Math.sin(p.a), fz = -Math.cos(p.a); p.boost = 1.2; b.vx = fx * 6; b.vy = skill === 'rain' ? 10.4 : 4.5; b.vz = fz * 6; b.curve = skill === 'rain' ? 9 : 4; b.curveTime = 1.4; p.skillCd = skill === 'rain' ? 24 : 15; }
    else if (p.sel === 3) { p.boost = 1.2; p.skillCd = 18; }
    else if (p.sel === 4) { p.vy = 7.2; b.vx = Math.sin(p.a) * 5.4; b.vy = 10.4; b.vz = -Math.cos(p.a) * 5.4; b.curve = b.curveTime = 0; p.skillCd = 20; }
    else if (p.sel === 5) { p.boost = 7; p.skillCd = 25; if (distance < 2.2) { b.x = p.x + Math.sin(p.a) * .8; b.z = p.z - Math.cos(p.a) * .8; b.vx = p.vx; b.vz = p.vz; b.vy = 0; b.touchLock = .2; } }
  }
}
function updateHuman(p, dt) {
  const k = p.input.k | 0, y = p.input.y;
  p.a += clamp(angDiff(p.a, y), -10 * dt, 10 * dt);
  const ix = ((k & 8) ? 1 : 0) - ((k & 2) ? 1 : 0);
  const iz = ((k & 1) ? 1 : 0) - ((k & 4) ? 1 : 0);
  const length = Math.hypot(ix, iz);
  const sprint = !!((k & 16) && length > .05 && p.stamina > 0 && p.slide <= 0 && p.stun <= 0);
  p.stamina = clamp(p.stamina + (sprint ? -27 : 18) * dt, 0, 100);
  const speed = (sprint ? 1.31 : 1) * (6.6 + .28 * p.stats.spd) * (p.boost > 0 ? 1.5 : 1);
  let tx = 0, tz = 0;
  if (length > 0) { const fx = Math.sin(y), fz = -Math.cos(y), rx = Math.cos(y), rz = Math.sin(y); tx = (fx * iz + rx * ix) / length * speed; tz = (fz * iz + rz * ix) / length * speed; }
  if (p.slide > 0) { tx = p.vx * (.4 + p.slide); tz = p.vz * (.4 + p.slide); }
  else if (p.stun > 0) { tx = tz = 0; }
  const accel = p.slide > 0 ? 30 : p.stun > 0 ? 10 : 7 + .4 * p.stats.tec;
  const blend = clamp(accel * dt, 0, 1);
  p.vx += (tx - p.vx) * blend; p.vz += (tz - p.vz) * blend;
  p.x = clamp(p.x + p.vx * dt, -FIELD.halfX + .5, FIELD.halfX - .5);
  p.z = clamp(p.z + p.vz * dt, -FIELD.halfZ + .5, FIELD.halfZ - .5);
  if ((k & 32) && p.y <= .001 && !p.jumpLatch && p.slide <= 0 && p.stun <= 0) p.vy = 7.4 * (.85 + .03 * p.stats.air);
  p.jumpLatch = !!(k & 32);
}
function updateAI(m, p, dt) {
  const b = m.ball, team = p.team, ownSign = team === 0 ? 1 : -1;
  const field = m.players.filter(q => q.team === team && q.role !== 'gk');
  const nearest = field.reduce((best, q) => Math.hypot(q.x - b.x, q.z - b.z) < Math.hypot(best.x - b.x, best.z - b.z) ? q : best, field[0]);
  let tx, tz, speed = 5.8 + .22 * p.stats.spd;
  if (p.role === 'gk') {
    tx = clamp(b.x * .55, -3.4, 3.4); tz = team === 0 ? 48.5 : -48.5; speed = 8.5;
    if (Math.abs(b.z - tz) < 7) tz = clamp(b.z, team === 0 ? 43 : -50, team === 0 ? 50 : -43);
  } else if (nearest === p && Math.hypot(p.x - b.x, p.z - b.z) < 26) {
    tx = b.x + b.vx * .18; tz = b.z + b.vz * .18; speed += 1.5;
  } else {
    tx = p.homeX + clamp(b.x * .13, -3, 3);
    tz = p.homeZ + ownSign * clamp((b.z - p.homeZ) * .18, -5, 5);
    if (team === 0) tz = clamp(tz, 4, 48); else tz = clamp(tz, -48, -4);
  }
  const dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz) || 1, desired = Math.min(speed, d * 2.8);
  const blend = clamp(8 * dt, 0, 1);
  p.vx += (dx / d * desired - p.vx) * blend; p.vz += (dz / d * desired - p.vz) * blend;
  p.x = clamp(p.x + p.vx * dt, -FIELD.halfX + .5, FIELD.halfX - .5);
  p.z = clamp(p.z + p.vz * dt, -FIELD.halfZ + .5, FIELD.halfZ - .5);
  if (Math.hypot(p.vx, p.vz) > .4) p.a = Math.atan2(p.vx, p.vz);
  if (nearest === p && Math.hypot(p.x - b.x, p.z - b.z) < 1.25 && b.y < 1.45 && p.cd <= 0 && b.touchLock <= 0) {
    const dir = team === 0 ? -1 : 1;
    const distToGoal = Math.abs((team === 0 ? -FIELD.halfZ : FIELD.halfZ) - b.z);
    if (distToGoal < 19) {
      b.vx = clamp((Math.random() - .5) * 7, -3.5, 3.5);
      b.vy = 3 + Math.random() * 3;
      b.vz = dir * (17 + Math.random() * 5);
      p.cd = 1.1;
    } else {
      b.vx = p.vx * .65; b.vz = p.vz * .65 + dir * 2.5; b.vy = Math.max(0, b.vy * .2); p.cd = .35;
    }
    b.touchLock = .28;
  }
}
function stepBall(m, dt) {
  const b = m.ball;
  b.touchLock = Math.max(0, b.touchLock - dt);
  b.curveTime = Math.max(0, b.curveTime - dt);
  b.vy -= 20 * dt;
  if (b.curveTime > 0 && b.curve) {
    const speed = Math.hypot(b.vx, b.vz) || 1;
    b.vx += (-b.vz / speed) * b.curve * dt;
    b.vz += (b.vx / speed) * b.curve * dt;
  }
  b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
  if (b.y < FIELD.ballR) {
    b.y = FIELD.ballR;
    if (b.vy < -1.5) b.vy *= -.55; else b.vy = 0;
    const drag = Math.max(0, 1 - .7 * dt); b.vx *= drag; b.vz *= drag;
  }
  const az = Math.abs(b.z), mouth = Math.abs(b.x) < FIELD.goalHalf - .05 && b.y < FIELD.goalHeight;
  if (az > FIELD.halfZ && mouth && m.phase === 'play') {
    const scorer = b.z < 0 ? 0 : 1;
    m.score[scorer]++; m.lastGoal = { team: scorer, at: Date.now() };
    m.phase = 'goal'; m.phaseTimer = 2.0; b.vx = b.vy = b.vz = 0;
    publishMatch(m, true);
    return;
  }
  if (az > FIELD.halfZ - FIELD.ballR && !mouth) { b.z = Math.sign(b.z) * (FIELD.halfZ - FIELD.ballR); b.vz *= -.6; }
  const xLim = az > FIELD.halfZ ? FIELD.goalHalf : FIELD.halfX;
  if (Math.abs(b.x) > xLim - FIELD.ballR) { b.x = Math.sign(b.x) * (xLim - FIELD.ballR); b.vx *= -.6; }
  if (b.y > 12) b.vy = Math.min(b.vy, 5);
  // Server-side player-to-ball contact and simple player blocking.
  if (b.touchLock <= 0 && b.y < 1.45) {
    let nearest = null, dMin = 1.05;
    for (const p of m.players) {
      if (p.stun > 0 || p.slide > .18) continue;
      const d = Math.hypot(p.x - b.x, p.z - b.z);
      if (d < dMin) { nearest = p; dMin = d; }
    }
    if (nearest) {
      const fx = Math.sin(nearest.a), fz = -Math.cos(nearest.a);
      const moving = Math.hypot(nearest.vx, nearest.vz);
      b.vx = nearest.vx * .8 + fx * (moving > 1 ? 2.5 : 1.2);
      b.vz = nearest.vz * .8 + fz * (moving > 1 ? 2.5 : 1.2);
      b.vy = Math.max(0, b.vy * .25); b.touchLock = .2;
    }
  }
  // Slide tackles are validated and resolved by the server.
  for (const p of m.players) {
    if (p.slide > 0 && Math.hypot(p.x - b.x, p.z - b.z) < 1.25 && b.y < 1.2) {
      b.vx = p.vx * .9; b.vz = p.vz * .9; b.vy = 1.5; b.touchLock = .18;
    }
  }
}
function tickMatch(m, dt) {
  if (!m.started) return;
  if (m.phase === 'end') { publishMatch(m); return; }
  if (m.phase === 'goal') {
    m.phaseTimer -= dt;
    if (m.phaseTimer <= 0) resetKickoff(m);
    publishMatch(m); return;
  }
  m.time = Math.max(0, m.time - dt);
  if (m.time <= 0) { m.phase = 'end'; publishMatch(m, true); return; }
  for (const p of m.players) {
    p.cd = Math.max(0, p.cd - dt); p.slide = Math.max(0, p.slide - dt); p.slideCd = Math.max(0, p.slideCd - dt);
    p.stun = Math.max(0, p.stun - dt); p.boost = Math.max(0, p.boost - dt); p.skillCd = Math.max(0, p.skillCd - dt);
    if (p.human) updateHuman(p, dt); else updateAI(m, p, dt);
    if (p.y > 0 || p.vy > 0) { p.vy -= 20 * dt; p.y = Math.max(0, p.y + p.vy * dt); if (p.y === 0) p.vy = 0; }
  }
  // Opponent contact/stun resolution.
  for (let i = 0; i < m.players.length; i++) for (let j = i + 1; j < m.players.length; j++) {
    const a = m.players[i], b = m.players[j];
    if (a.team === b.team) continue;
    const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz) || .001;
    if (d < .72 && a.slide > 0 && b.slide <= 0) { b.stun = Math.max(b.stun, .65); b.vx += dx / d * 2.2; b.vz += dz / d * 2.2; }
    else if (d < .72 && b.slide > 0 && a.slide <= 0) { a.stun = Math.max(a.stun, .65); a.vx -= dx / d * 2.2; a.vz -= dz / d * 2.2; }
  }
  stepBall(m, dt);
  publishMatch(m);
}

function onMessage(ws, raw) {
  let m;
  try { m = JSON.parse(raw); } catch (_) { return; }
  if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string') return;

  // Shared lobby and server-side matchmaking.
  if (m.t === 'hubJoin') return hubJoin(ws, m);
  if (m.t === 'hubPose') {
    const p = ws.hubPlayer; if (!p) return;
    const now = Date.now(); if (now - p.lastPose < 70) return; p.lastPose = now; p.lastSeen = now;
    p.x = clamp(finite(m.x), -28, 28); p.z = clamp(finite(m.z), -28, 28); p.a = clamp(finite(m.a), -100, 100);
    p.sel = charIndex(m.sel); p.moving = !!m.moving;
    hubBroadcast(ws, { t: 'hubPose', player: hubPublic(p) }); return;
  }
  if (m.t === 'hubBeat') { if (ws.hubPlayer) ws.hubPlayer.lastSeen = Date.now(); return; }
  if (m.t === 'queueJoin') return joinQueue(ws);
  if (m.t === 'queueCancel') { if (ws.hubPlayer) { removeFromQueue(ws.hubPlayer); ws.hubPlayer.queued = false; send(ws, { t: 'queueCancelled' }); } return; }
  if (m.t === 'hubLeave') { hubLeave(ws); return; }
  if (m.t === 'matchJoin') return matchJoin(ws, m);
  if (m.t === 'matchInput') {
    const match = ws.match; if (!match || !match.started || match.phase === 'end') return;
    const slot = ws.matchSlot, player = match.players[slot === 0 ? 0 : 5];
    const seq = Math.floor(finite(m.seq, -1)); if (seq <= player.input.seq) return;
    player.input = { seq, k: Math.floor(clamp(finite(m.k), 0, 63)), y: clamp(finite(m.y), -100, 100) };
    match.slots[slot].lastSeen = Date.now(); return;
  }
  if (m.t === 'matchAction') {
    const match = ws.match; if (!match) return;
    handleAction(match, ws.matchSlot, m); return;
  }
  if (m.t === 'matchLeave') { matchLeave(ws); return; }
  if (m.t === 'hb') return send(ws, { t: 'hp', s: finite(m.s, Date.now()) });

  // Legacy two-player room gateway kept for older builds; the new queue does not use it.
  if (m.t === 'h' || m.t === 'g') {
    if (ws.room) return send(ws, { t: 'err', m: 'Bạn đã ở trong một phòng khác.' });
    const code = String(m.pin || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    if (code.length < 3) return send(ws, { t: 'err', m: 'Mã phòng cần ít nhất 3 ký tự.' });
    let room = rooms.get(code);
    if (m.t === 'h') {
      if (room && room.h) return send(ws, { t: 'err', m: 'Mã phòng đã được sử dụng.' });
      if (!room) { room = { code, h: null, g: null, createdAt: Date.now() }; rooms.set(code, room); }
      room.h = ws; ws.room = room; ws.slot = 0; send(ws, { t: 'ok', server: 1, slot: 0 }); return;
    }
    if (!room || !room.h) return send(ws, { t: 'err', m: 'Không tìm thấy phòng.' });
    if (room.g) return send(ws, { t: 'err', m: 'Phòng đã đủ 2 người.' });
    room.g = ws; ws.room = room; ws.slot = 1; room.gSel = charIndex(m.sel);
    send(ws, { t: 'ok', server: 1, slot: 1 }); send(room.h, { t: 'j', sel: room.gSel }); return;
  }
  const room = ws.room;
  if (!room) return;
  const peer = ws.slot === 0 ? room.g : room.h;
  if (m.t === 'pos' && peer) return send(peer, { ...m, p: ws.slot });
  if (peer && ['i', 'sl', 'sh', 'pa', 'sk', 'bt', 'bta', 'c', 's', 'go', 'resetPose', 'end', 'skno'].includes(m.t)) {
    if (['s', 'go', 'resetPose', 'end'].includes(m.t) && ws.slot !== 0) return;
    send(peer, m);
  }
}
function leaveRoom(ws) {
  const room = ws && ws.room; if (!room) return;
  ws.room = null;
  if (ws.slot === 0 && room.h === ws) {
    room.h = null; const guest = room.g; room.g = null; rooms.delete(room.code);
    if (guest && !guest.destroyed) { guest.room = null; send(guest, { t: 'bye', reason: 'host-left' }); }
  } else if (ws.slot === 1 && room.g === ws) {
    room.g = null; if (room.h) send(room.h, { t: 'bye', reason: 'guest-left' });
    if (!room.h) rooms.delete(room.code);
  }
  ws.slot = -1;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') {
    const activeMatchPlayers = [...matches.values()].reduce((n, m) => n + m.slots.filter(s => s.connected).length, 0);
    const activeHub = hubPlayers.size;
    const activePlayers = activeHub + activeMatchPlayers;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, mode: 'server-authoritative-matchmaking', rooms: matches.size, hubPlayers: activeHub, queuedPlayers: waitingQueue.length, matches: matches.size, activeMatchPlayers, activePlayers, serverPhysics: true, tickRate: 60, snapshotRate: 20 }));
  }
  if (url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(`<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ego Futsal Server</title><style>*{box-sizing:border-box}body{margin:0;background:#08111f;color:#edf5ff;font:16px system-ui;display:grid;place-items:center;min-height:100vh;padding:24px}.card{width:min(620px,100%);background:#101e32;border:1px solid #29415f;border-radius:18px;padding:26px}h1{margin:0 0 8px}.muted{color:#9bb0c9}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:20px 0}.metric{background:#0b1728;border-radius:12px;padding:14px}.metric b{display:block;font-size:27px}.metric span{font-size:13px;color:#9bb0c9}a{color:#7dd3fc}</style><main class="card"><h1>Ego Futsal · Server trung tâm</h1><p class="muted">Ghép cặp tự động · WebSocket · Vật lý trận đấu chạy trên server</p><div class="grid"><div class="metric"><b id="hub">—</b><span>Người ở sảnh</span></div><div class="metric"><b id="queue">—</b><span>Đang chờ ghép</span></div><div class="metric"><b id="matches">—</b><span>Trận đang chạy</span></div></div><p id="state">Đang kiểm tra...</p><p><a href="/">Mở game</a> · <a href="/health">Health API</a></p></main><script>async function tick(){try{const d=await(await fetch('/health',{cache:'no-store'})).json();hub.textContent=d.hubPlayers;queue.textContent=d.queuedPlayers;matches.textContent=d.matches;state.textContent=d.serverPhysics?'Máy chủ hoạt động · Vật lý server-authoritative · '+d.tickRate+' Hz':'Server chưa sẵn sàng'}catch(e){state.textContent='Không kết nối được server'}}tick();setInterval(tick,2000)</script></html>`);
  }
  if (!['/', '/index.html', '/game'].includes(url.pathname)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
  fs.readFile(GAME_FILE, (err, data) => {
    if (err) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Không tìm thấy Ego-Futsal-Neutral-Server.html cạnh server.js.'); }
    const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Accept-Encoding' };
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) zlib.gzip(data, (e, zipped) => { if (e) { res.writeHead(200, headers); return res.end(data); } headers['Content-Encoding'] = 'gzip'; res.writeHead(200, headers); res.end(zipped); });
    else { res.writeHead(200, headers); res.end(data); }
  });
});

server.on('upgrade', (req, socket) => {
  let pathname; try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (_) { return reject(socket); }
  const key = req.headers['sec-websocket-key'];
  if (pathname !== '/ws' || !key || req.headers.upgrade?.toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13') return reject(socket);
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true); socket.setKeepAlive(true, 15000); socket.lastSeen = Date.now();
  socket.send = value => { if (socket.destroyed || !socket.writable) return false; const buf = frame(value); if (socket.writableLength > MAX_BUFFERED) { socket.destroy(); return false; } return socket.write(buf); };
  let buffer = Buffer.alloc(0);
  socket.on('data', chunk => {
    socket.lastSeen = Date.now(); buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const first = buffer[0], second = buffer[1], fin = !!(first & 0x80), rsv = first & 0x70, opcode = first & 0x0f, masked = !!(second & 0x80);
      let len = second & 0x7f, offset = 2;
      if (rsv || !fin || !masked) return socket.destroy();
      if (len === 126) { if (buffer.length < 4) return; len = buffer.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (buffer.length < 10) return; const big = buffer.readBigUInt64BE(2); if (big > BigInt(MAX_FRAME)) return socket.destroy(); len = Number(big); offset = 10; }
      if (len > MAX_FRAME) return socket.destroy();
      if (buffer.length < offset + 4 + len) return;
      const mask = buffer.subarray(offset, offset + 4); offset += 4;
      const data = Buffer.from(buffer.subarray(offset, offset + len)); buffer = buffer.subarray(offset + len);
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      if (opcode === 8) { try { socket.write(frame(data, 8)); } catch (_) {} socket.end(); return; }
      if (opcode === 9) { try { socket.write(frame(data, 10)); } catch (_) {} continue; }
      if (opcode === 10) continue;
      if (opcode !== 1) return socket.destroy();
      onMessage(socket, data.toString('utf8'));
    }
  });
  socket.on('close', () => { hubLeave(socket); leaveRoom(socket); matchLeave(socket); });
  socket.on('error', () => { hubLeave(socket); leaveRoom(socket); matchLeave(socket); });
});

setInterval(() => {
  const now = Date.now();
  for (const m of [...matches.values()]) {
    if (!m.started) continue;
    const dt = clamp((now - m.tickAt) / 1000, 0, .05); m.tickAt = now;
    // Fixed-step accumulator limits physics drift if the Node event loop stalls.
    m.acc = (m.acc || 0) + dt;
    let steps = 0;
    while (m.acc >= 1 / 60 && steps < 3) { tickMatch(m, 1 / 60); m.acc -= 1 / 60; steps++; }
    if (m.acc > .08) m.acc = .08;
  }
  for (const p of [...hubPlayers.values()]) if (now - p.lastSeen > 35000 && p.ws && !p.ws.destroyed) p.ws.destroy();
  for (const m of [...matches.values()]) {
    if (!m.started && now - m.createdAt > 30000) {
      for (const s of m.slots) if (s.ws && !s.ws.destroyed) send(s.ws, { t: 'matchError', message: 'Đối thủ chưa kết nối kịp thời gian. Hãy tìm trận lại.' });
      matches.delete(m.id);
    } else if (now - m.createdAt > 60 * 60 * 1000) {
      for (const s of m.slots) if (s.ws && !s.ws.destroyed) s.ws.destroy(); matches.delete(m.id);
    } else if (!m.slots.some(s => s.connected) && now - Math.max(...m.slots.map(s => s.lastSeen)) > 30000) matches.delete(m.id);
  }
}, 1000 / 60).unref();

server.listen(PORT, HOST, () => console.log(`Ego Futsal authoritative server listening on ${HOST}:${PORT}; health: /health`));
server.on('error', err => { console.error('Server error:', err.message); process.exitCode = 1; });
