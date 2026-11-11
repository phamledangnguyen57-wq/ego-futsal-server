#!/usr/bin/env node
'use strict';
// Ego Futsal - regional room gateway (stability update).
// This gateway manages rooms and relays player poses/snapshots. Match physics
// still runs on the room creator; this is not yet a fully authoritative game server.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const GAME_FILE = path.join(__dirname, 'Ego-Futsal-Neutral-Server.html');
const rooms = new Map();
const MAX_FRAME = 64 * 1024;
const MAX_BUFFERED = 48 * 1024;
const DROP_SNAPSHOT_AT = 4 * 1024;
const DROP_POSE_AT = 1024;
const FORWARD_TYPES = new Set(['i', 'sl', 'sh', 'pa', 'sk', 'bt', 'bta', 'c', 's', 'go', 'resetPose', 'end', 'skno']);

function codeOf(v) {
  return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}
function finite(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
function frame(payload, opcode = 1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const n = body.length;
  let header;
  if (n < 126) header = Buffer.from([0x80 | opcode, n]);
  else if (n <= 65535) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(n, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([header, body]);
}
function send(ws, obj) {
  if (!ws || ws.destroyed || !ws.writable || typeof ws.send !== 'function') return false;
  try {
    const json = JSON.stringify(obj);
    if (Buffer.byteLength(json) > MAX_FRAME) return false;
    const transient = obj && (obj.t === 'pos' || obj.t === 's' || obj.t === 'i');
    // Keep a much shorter queue: snapshots are comparatively large, while
    // pose/input packets are small. Prefer current state over stale backlog.
    const dropAt = obj && obj.t === 's' ? DROP_SNAPSHOT_AT : DROP_POSE_AT;
    if (transient && ws.writableLength > dropAt) return false;
    if (ws.writableLength > MAX_BUFFERED) {
      ws.destroy();
      return false;
    }
    return ws.send(json);
  } catch (_) {
    return false;
  }
}
function reject(socket, status = '400 Bad Request') {
  try { socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); } catch (_) {}
  socket.destroy();
}
function dropRoom(room) {
  if (room && rooms.get(room.code) === room) rooms.delete(room.code);
}
function leave(ws) {
  const room = ws.room;
  if (!room) return;
  const slot = ws.slot;
  ws.room = null;
  ws.slot = -1;

  if (slot === 0 && room.h === ws) {
    // Host departure ends this room. Notify and release the guest as well.
    room.h = null;
    const guest = room.g;
    room.g = null;
    dropRoom(room);
    if (guest && guest !== ws) {
      guest.room = null;
      guest.slot = -1;
      send(guest, { t: 'bye', reason: 'host-left' });
    }
    return;
  }

  if (slot === 1 && room.g === ws) {
    // Guest departure frees only the guest slot. The host remains in the room
    // and can accept another guest with the same room code.
    room.g = null;
    if (room.h) send(room.h, { t: 'bye', reason: 'guest-left' });
  }

  if (!room.h && !room.g) dropRoom(room);
}
function onMessage(ws, raw) {
  let m;
  try { m = JSON.parse(raw); } catch (_) { return; }
  if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string') return;

  if (m.t === 'h' || m.t === 'g') {
    if (ws.room) return send(ws, { t: 'err', m: 'Bạn đã ở trong một phòng khác.' });
    const code = codeOf(m.pin);
    if (code.length < 3) return send(ws, { t: 'err', m: 'Mã phòng cần ít nhất 3 ký tự.' });
    let room = rooms.get(code);

    if (m.t === 'h') {
      if (room && room.h) return send(ws, { t: 'err', m: 'Mã phòng đã được sử dụng. Hãy tạo mã khác.' });
      if (!room) {
        room = { code, h: null, g: null, createdAt: Date.now(), seq: [0, 0], poseAt: [0, 0], inputSeq: [0, 0], inputAt: [0, 0], gSel: 0 };
        rooms.set(code, room);
      }
      room.h = ws;
      room.seq[0] = 0;
      room.poseAt[0] = 0;
      ws.room = room;
      ws.slot = 0;
      send(ws, { t: 'ok', server: 1, slot: 0 });
      if (room.g) send(ws, { t: 'j', sel: room.gSel || 0 });
      return;
    }

    if (!room || !room.h) return send(ws, { t: 'err', m: 'Không tìm thấy phòng. Hãy kiểm tra mã phòng.' });
    if (room.g) return send(ws, { t: 'err', m: 'Phòng đã đủ 2 người.' });
    room.g = ws;
    room.gSel = clamp(Math.floor(finite(m.sel, 0)), 0, 5);
    // Reset the sequence window for every new socket in this slot. Otherwise
    // a reconnecting player starting its counter at 1 can be rejected forever.
    room.seq[1] = 0;
    room.poseAt[1] = 0;
    room.inputSeq[1] = 0;
    room.inputAt[1] = 0;
    ws.room = room;
    ws.slot = 1;
    send(ws, { t: 'ok', server: 1, slot: 1 });
    send(room.h, { t: 'j', sel: room.gSel });
    return;
  }

  const room = ws.room;
  if (!room || (ws.slot !== 0 && ws.slot !== 1)) return;
  const peer = ws.slot === 0 ? room.g : room.h;

  if (m.t === 'hb') return send(ws, { t: 'hp', s: finite(m.s, Date.now()) });

  if (m.t === 'pos') {
    const slot = ws.slot;
    const seq = Math.floor(finite(m.n, -1));
    if (seq <= room.seq[slot]) return;
    const now = Date.now();
    // Client cadence is 30 Hz. Keep a little tolerance for timer jitter.
    if (room.poseAt[slot] && now - room.poseAt[slot] < 20) return;
    room.seq[slot] = seq;
    room.poseAt[slot] = now;
    if (!peer) return;
    return send(peer, {
      t: 'pos', p: slot, n: seq,
      x: clamp(finite(m.x), -33.5, 33.5),
      y: clamp(finite(m.y), 0, 4),
      z: clamp(finite(m.z), -51.5, 51.5),
      a: clamp(finite(m.a), -1000, 1000),
      vx: clamp(finite(m.vx), -20, 20),
      vy: clamp(finite(m.vy), -12, 12),
      vz: clamp(finite(m.vz), -20, 20),
      svx: clamp(finite(m.svx), -15, 15),
      svz: clamp(finite(m.svz), -15, 15),
      sl: m.sl ? 1 : 0, slt: clamp(finite(m.slt), 0, .65), sid: Math.max(0, Math.floor(finite(m.sid))),
      st: m.st ? 1 : 0, hd: m.hd ? 1 : 0,
      lz: clamp(finite(m.lz), -1.5, 1.5)
    });
  }

  // Guest control input is the source of movement for the host simulation.
  // It is small and frequent; sequence it and drop stale/duplicate packets.
  if (m.t === 'i') {
    if (ws.slot !== 1 || !peer) return;
    const seq = Math.floor(finite(m.n, -1));
    if (seq <= room.inputSeq[1]) return;
    const now = Date.now();
    if (room.inputAt[1] && now - room.inputAt[1] < 8) return;
    room.inputSeq[1] = seq;
    room.inputAt[1] = now;
    return send(peer, {
      t: 'i', n: seq,
      k: Math.floor(clamp(finite(m.k), 0, 63)),
      y: clamp(finite(m.y), -Math.PI, Math.PI)
    });
  }

  if (!peer || !FORWARD_TYPES.has(m.t)) return;
  // Only the host may publish match snapshots, start/end the match, or reset it.
  if (['s', 'go', 'resetPose', 'end'].includes(m.t) && ws.slot !== 0) return;
  // Only the guest may send direct player actions to the host.
  if (['i', 'sl', 'sh', 'pa', 'sk', 'bt'].includes(m.t) && ws.slot !== 1) return;
  if (m.t === 'bta' && ws.slot !== 0) return;
  if (m.t === 'bt') { m.id = Math.max(0, Math.floor(finite(m.id))); m.kind = m.kind === 'slide' ? 'slide' : 'foot'; m.svx = clamp(finite(m.svx), -15, 15); m.svz = clamp(finite(m.svz), -15, 15); }
  if (m.t === 'bta') { m.id = Math.max(0, Math.floor(finite(m.id))); m.ok = m.ok ? 1 : 0; }
  if (m.t === 'c') m.x = String(m.x || '').slice(0, 120);
  if (m.t === 'sh') { m.c = clamp(finite(m.c), 0, 1); m.m = Math.floor(clamp(finite(m.m), 0, 3)); if (Number.isFinite(Number(m.y))) m.y = clamp(finite(m.y), -Math.PI, Math.PI); if (Number.isFinite(Number(m.k))) m.k = Math.floor(clamp(finite(m.k), 0, 63)); }
  if (m.t === 'sk') { m.which = m.which === 'rain' ? 'rain' : 'main'; if (Number.isFinite(Number(m.y))) m.y = clamp(finite(m.y), -Math.PI, Math.PI); if (Number.isFinite(Number(m.k))) m.k = Math.floor(clamp(finite(m.k), 0, 63)); }
  send(peer, m);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') {
    const list = [...rooms.values()].map(r => ({ code: r.code, players: Number(!!r.h) + Number(!!r.g) }));
    const activePlayers = list.reduce((sum, room) => sum + room.players, 0);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, mode: 'regional-room-gateway', rooms: list.length, activePlayers, serverPhysics: false }));
  }
  if (url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(`<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ego Futsal - Server Status</title><style>*{box-sizing:border-box}body{margin:0;background:#08111f;color:#edf5ff;font:16px system-ui,Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px}.card{width:min(620px,100%);background:#101e32;border:1px solid #29415f;border-radius:18px;padding:26px;box-shadow:0 18px 60px #0008}h1{margin:0 0 8px;font-size:24px}.muted{color:#9bb0c9}.status{display:flex;gap:10px;align-items:center;margin:18px 0;padding:12px;background:#0b1728;border-radius:12px}.dot{width:12px;height:12px;border-radius:50%;background:#eab308}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.metric{background:#0b1728;border-radius:12px;padding:14px}.metric b{display:block;font-size:27px}.metric span{color:#9bb0c9;font-size:13px}a{color:#7dd3fc}.links{display:flex;gap:18px;flex-wrap:wrap;margin-top:20px;font-size:14px}</style><main class="card"><h1>Ego Futsal · Máy chủ trung tâm</h1><div class="muted">Trang kiểm tra trạng thái máy chủ</div><div class="status"><span id="dot" class="dot"></span><b id="state">Đang kiểm tra...</b><span id="time" class="muted"></span></div><div class="grid"><div class="metric"><b id="rooms">—</b><span>Phòng đang mở</span></div><div class="metric"><b id="players">—</b><span>Người chơi kết nối</span></div><div class="metric"><b id="mode">—</b><span>Chế độ</span></div></div><p class="muted" id="note" style="line-height:1.6">Trang này chỉ hiển thị tình trạng tiến trình server. Để mở game, dùng liên kết bên dưới.</p><div class="links"><a href="/">Mở game</a><a href="/health">Xem health API</a></div></main><script>async function tick(){try{const r=await fetch('/health',{cache:'no-store'});if(!r.ok)throw Error('HTTP '+r.status);const d=await r.json();document.getElementById('dot').style.background='#22c55e';document.getElementById('state').textContent='Máy chủ đang hoạt động';document.getElementById('rooms').textContent=d.rooms??0;document.getElementById('players').textContent=d.activePlayers??0;document.getElementById('mode').textContent=d.mode??'—';document.getElementById('note').textContent=d.serverPhysics?'Máy chủ có mô phỏng trận đấu.':'Lưu ý: hiện đây là máy chủ quản lý phòng/chuyển tiếp; vật lý trận đấu chưa chạy hoàn toàn trên server.';document.getElementById('time').textContent=new Date().toLocaleTimeString()}catch(e){document.getElementById('dot').style.background='#ef4444';document.getElementById('state').textContent='Không kết nối được server';document.getElementById('note').textContent=String(e)}}tick();setInterval(tick,2000)</script></html>`);
  }
  if (!['/', '/index.html', '/game'].includes(url.pathname)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  fs.readFile(GAME_FILE, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Không tìm thấy Ego-Futsal-Neutral-Server.html cạnh server.js.');
    }
    const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Accept-Encoding' };
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      zlib.gzip(data, (gzipErr, compressed) => {
        if (gzipErr) { res.writeHead(200, headers); return res.end(data); }
        headers['Content-Encoding'] = 'gzip';
        res.writeHead(200, headers);
        res.end(compressed);
      });
    } else {
      res.writeHead(200, headers);
      res.end(data);
    }
  });
});

server.on('upgrade', (req, socket) => {
  let pathname;
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (_) { return reject(socket); }
  const key = req.headers['sec-websocket-key'];
  if (pathname !== '/ws' || !key || req.headers.upgrade?.toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13') return reject(socket);
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 15000);
  socket.lastSeen = Date.now();
  socket.send = value => {
    if (socket.destroyed || !socket.writable) return false;
    const buf = frame(value);
    if (socket.writableLength > MAX_BUFFERED) { socket.destroy(); return false; }
    return socket.write(buf);
  };

  let buffer = Buffer.alloc(0);
  socket.on('data', chunk => {
    socket.lastSeen = Date.now();
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const first = buffer[0];
      const second = buffer[1];
      const fin = !!(first & 0x80);
      const rsv = first & 0x70;
      const opcode = first & 0x0f;
      const masked = !!(second & 0x80);
      let len = second & 0x7f;
      let offset = 2;
      if (rsv || !fin || !masked) return socket.destroy();
      if (len === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME)) return socket.destroy();
        len = Number(big);
        offset = 10;
      }
      if (len > MAX_FRAME) return socket.destroy();
      if (buffer.length < offset + 4 + len) return;
      const mask = buffer.subarray(offset, offset + 4);
      offset += 4;
      const data = Buffer.from(buffer.subarray(offset, offset + len));
      buffer = buffer.subarray(offset + len);
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];

      if (opcode === 8) {
        try { socket.write(frame(data, 8)); } catch (_) {}
        socket.end();
        return;
      }
      if (opcode === 9) { try { socket.write(frame(data, 10)); } catch (_) {} continue; }
      if (opcode === 10) continue;
      if (opcode !== 1) return socket.destroy();
      onMessage(socket, data.toString('utf8'));
    }
  });
  socket.on('close', () => leave(socket));
  socket.on('error', () => leave(socket));
});

const heartbeat = setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    for (const ws of [room.h, room.g]) {
      if (ws && now - (ws.lastSeen || now) > 30000) ws.destroy();
    }
  }
}, 10000);
heartbeat.unref();

server.listen(PORT, HOST, () => {
  console.log(`Ego Futsal regional gateway listening on ${HOST}:${PORT}; health: /health`);
});
server.on('error', err => {
  console.error('Server error:', err.message);
  process.exitCode = 1;
});
