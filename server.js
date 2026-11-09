#!/usr/bin/env node
'use strict';
// Ego Futsal - regional room gateway (phase 1).
// The gateway hosts rooms and relays compact controls/poses/snapshots. The current
// browser game still runs match physics on the room creator; full server-side
// simulation is a separate engine port and is NOT claimed by this gateway.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const GAME_FILE = path.join(__dirname, 'Ego-Futsal-Neutral-Server.html');
const rooms = new Map();
const MAX_FRAME = 64 * 1024;

function send(ws, obj) {
  if (!ws || ws.destroyed || !ws.send) return false;
  try { return ws.send(JSON.stringify(obj)); } catch (_) { return false; }
}
function codeOf(v) { return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12); }
function finite(v, d=0) { const n=Number(v); return Number.isFinite(n) ? n : d; }
function leave(ws) {
  const room=ws.room; if (!room) return;
  ws.room=null;
  if (ws.slot===0) room.h=null; else room.g=null;
  const other=ws.slot===0 ? room.g : room.h;
  if (other) { other.room=null; send(other,{t:'bye'}); }
  if (!room.h && !room.g) rooms.delete(room.code);
}
function clamp(v,lo,hi) { return Math.max(lo,Math.min(hi,v)); }
function onMessage(ws, raw) {
  let m; try { m=JSON.parse(raw); } catch (_) { return; }
  if (!m || typeof m!=='object' || Array.isArray(m)) return;
  if (m.t==='h' || m.t==='g') {
    if (ws.room) return send(ws,{t:'err',m:'Bạn đã ở trong một phòng khác.'});
    const code=codeOf(m.pin);
    if (code.length<3) return send(ws,{t:'err',m:'Mã phòng cần ít nhất 3 ký tự.'});
    let room=rooms.get(code);
    if (m.t==='h') {
      if (room && room.h) return send(ws,{t:'err',m:'Mã phòng đã được sử dụng. Hãy tạo mã khác.'});
      if (!room) { room={code,h:null,g:null,createdAt:Date.now(),seq:[0,0],poseAt:[0,0]}; rooms.set(code,room); }
      room.h=ws; ws.room=room; ws.slot=0;
      send(ws,{t:'ok',server:1,slot:0});
      if (room.g) send(ws,{t:'j',sel:room.gSel||0});
      return;
    }
    if (!room || !room.h) return send(ws,{t:'err',m:'Không tìm thấy phòng. Hãy kiểm tra mã phòng.'});
    if (room.g) return send(ws,{t:'err',m:'Phòng đã đủ 2 người.'});
    room.g=ws; room.gSel=clamp(Math.floor(finite(m.sel,0)),0,5); ws.room=room; ws.slot=1;
    send(ws,{t:'ok',server:1,slot:1});
    send(room.h,{t:'j',sel:room.gSel});
    return;
  }
  const room=ws.room; if (!room) return;
  const peer=ws.slot===0 ? room.g : room.h;
  if (m.t==='hb') return send(ws,{t:'hp',s:finite(m.s,Date.now())});
  if (m.t==='pos') {
    const slot=ws.slot, seq=Math.floor(finite(m.n,-1));
    if (seq<=room.seq[slot]) return;
    const now=Date.now();
    if (now-room.poseAt[slot]<28) return; // about 35Hz max; browser sends 30Hz
    room.seq[slot]=seq; room.poseAt[slot]=now;
    // Strict numeric bounds; no executable payload or arbitrary object forwarding.
    return send(peer,{
      t:'pos',p:slot,n:seq,
      x:clamp(finite(m.x),-33.5,33.5),y:clamp(finite(m.y),0,4),z:clamp(finite(m.z),-51.5,51.5),
      a:clamp(finite(m.a),-1000,1000),vx:clamp(finite(m.vx),-20,20),vy:clamp(finite(m.vy),-12,12),vz:clamp(finite(m.vz),-20,20),
      sl:m.sl?1:0,st:m.st?1:0,hd:m.hd?1:0,lz:clamp(finite(m.lz),-1.5,1.5)
    });
  }
  // Match actions, compact snapshots, and chat are forwarded only to the other player.
  if (m.t==='c') m.x=String(m.x||'').slice(0,120);
  if (peer) send(peer,m);
}
function frame(payload, opcode=1) {
  const b=Buffer.isBuffer(payload)?payload:Buffer.from(String(payload)); const n=b.length;
  let h;
  if(n<126) h=Buffer.from([0x80|opcode,n]);
  else if(n<=65535){h=Buffer.alloc(4);h[0]=0x80|opcode;h[1]=126;h.writeUInt16BE(n,2);}
  else {h=Buffer.alloc(10);h[0]=0x80|opcode;h[1]=127;h.writeBigUInt64BE(BigInt(n),2);}
  return Buffer.concat([h,b]);
}
function reject(s,status='400 Bad Request'){try{s.write('HTTP/1.1 '+status+'\r\nConnection: close\r\n\r\n');}catch(_){}s.destroy();}
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/health'){
    const list=[...rooms.values()].map(r=>({code:r.code,players:Number(!!r.h)+Number(!!r.g)}));
    const players=list.reduce((a,r)=>a+r.players,0);
    res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Access-Control-Allow-Origin':'*'});
    return res.end(JSON.stringify({ok:true,mode:'regional-room-gateway',rooms:list.length,activePlayers:players,serverPhysics:false}));
  }
  if(url.pathname==='/status'){
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
    return res.end(`<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ego Futsal - Server Status</title><style>*{box-sizing:border-box}body{margin:0;background:#08111f;color:#edf5ff;font:16px system-ui,Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px}.card{width:min(620px,100%);background:#101e32;border:1px solid #29415f;border-radius:18px;padding:26px;box-shadow:0 18px 60px #0008}h1{margin:0 0 8px;font-size:24px}.muted{color:#9bb0c9}.status{display:flex;gap:10px;align-items:center;margin:18px 0;padding:12px;background:#0b1728;border-radius:12px}.dot{width:12px;height:12px;border-radius:50%;background:#eab308}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.metric{background:#0b1728;border-radius:12px;padding:14px}.metric b{display:block;font-size:27px}.metric span{color:#9bb0c9;font-size:13px}a{color:#7dd3fc}.links{display:flex;gap:18px;flex-wrap:wrap;margin-top:20px;font-size:14px}</style><main class="card"><h1>Ego Futsal · Máy chủ trung tâm</h1><div class="muted">Trang kiểm tra trạng thái máy chủ</div><div class="status"><span id="dot" class="dot"></span><b id="state">Đang kiểm tra...</b><span id="time" class="muted"></span></div><div class="grid"><div class="metric"><b id="rooms">—</b><span>Phòng đang mở</span></div><div class="metric"><b id="players">—</b><span>Người chơi kết nối</span></div><div class="metric"><b id="mode">—</b><span>Chế độ</span></div></div><p class="muted" id="note" style="line-height:1.6">Trang này chỉ hiển thị tình trạng tiến trình server. Để mở game, dùng liên kết bên dưới.</p><div class="links"><a href="/">Mở game</a><a href="/health">Xem health API</a></div></main><script>async function tick(){try{const r=await fetch('/health',{cache:'no-store'});if(!r.ok)throw Error('HTTP '+r.status);const d=await r.json();document.getElementById('dot').style.background='#22c55e';document.getElementById('state').textContent='Máy chủ đang hoạt động';document.getElementById('rooms').textContent=d.rooms??0;document.getElementById('players').textContent=d.activePlayers??0;document.getElementById('mode').textContent=d.mode??'—';document.getElementById('note').textContent=d.serverPhysics?'Máy chủ có mô phỏng trận đấu.':'Lưu ý: hiện đây là máy chủ quản lý phòng/chuyển tiếp; vật lý trận đấu chưa chạy hoàn toàn trên server.';document.getElementById('time').textContent=new Date().toLocaleTimeString()}catch(e){document.getElementById('dot').style.background='#ef4444';document.getElementById('state').textContent='Không kết nối được server';document.getElementById('note').textContent=String(e)}}tick();setInterval(tick,2000)</script></html>`);
  }
  if(url.pathname!=='/' && url.pathname!='/index.html' && url.pathname!='/game'){
    res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'}); return res.end('Not found');
  }
  fs.readFile(GAME_FILE,(err,data)=>{
    if(err){res.writeHead(500,{'Content-Type':'text/plain; charset=utf-8'});return res.end('Không tìm thấy Ego-Futsal-Neutral-Server.html cạnh server.js.');}
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(data);
  });
});
server.on('upgrade',(req,socket)=>{
  let pathname;try{pathname=new URL(req.url,'http://localhost').pathname;}catch(_){return reject(socket);}
  const key=req.headers['sec-websocket-key'];
  if(pathname!=='/ws'||!key||req.headers.upgrade?.toLowerCase()!=='websocket'||req.headers['sec-websocket-version']!=='13')return reject(socket);
  const accept=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  socket.setNoDelay(true);socket.setKeepAlive(true,15000);socket.lastSeen=Date.now();
  socket.send=value=>{if(socket.destroyed)return false;const buf=frame(value);if(socket.writableLength>256*1024){socket.destroy();return false;}return socket.write(buf);};
  let buffer=Buffer.alloc(0);
  socket.on('data',chunk=>{
    socket.lastSeen=Date.now();buffer=Buffer.concat([buffer,chunk]);
    while(buffer.length>=2){
      const opcode=buffer[0]&0x0f,masked=!!(buffer[1]&0x80);let len=buffer[1]&0x7f,off=2;
      if(len===126){if(buffer.length<4)return;len=buffer.readUInt16BE(2);off=4;}
      else if(len===127){if(buffer.length<10)return;const big=buffer.readBigUInt64BE(2);if(big>BigInt(MAX_FRAME))return socket.destroy();len=Number(big);off=10;}
      if(!masked||len>MAX_FRAME)return socket.destroy();
      if(buffer.length<off+4+len)return;
      const mask=buffer.subarray(off,off+4);off+=4;const data=Buffer.from(buffer.subarray(off,off+len));buffer=buffer.subarray(off+len);
      for(let i=0;i<data.length;i++)data[i]^=mask[i&3];
      if(opcode===8){try{socket.write(frame(data,8));}catch(_){}return socket.end();}
      if(opcode===9){try{socket.write(frame(data,10));}catch(_){}continue;}
      if(opcode===10)continue;
      if(opcode!==1)return socket.destroy();
      onMessage(socket,data.toString('utf8'));
    }
  });
  socket.on('close',()=>leave(socket));socket.on('error',()=>leave(socket));
});
const heartbeat=setInterval(()=>{
  const now=Date.now();
  // Drop dead sockets so room slots are not stuck forever.
  for(const room of rooms.values())for(const ws of [room.h,room.g])if(ws && now-(ws.lastSeen||now)>45000)ws.destroy();
},15000);heartbeat.unref();
server.listen(PORT,HOST,()=>console.log(`Ego Futsal regional gateway listening on ${HOST}:${PORT}; health: /health`));
server.on('error',e=>{console.error('Server error:',e.message);process.exitCode=1;});
