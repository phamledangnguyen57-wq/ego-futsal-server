'use strict';
/*
 * ============================================================================
 *  EGO FUTSAL 3D — MÁY CHỦ TRUNG TÂM (chạy trên Render)
 * ============================================================================
 *  Ý tưởng: KHÔNG để 2 máy tự nói chuyện với nhau (dễ lag, dễ lệch).
 *  Cả 2 người cùng "đứng" trên MỘT máy chủ:
 *
 *    1) Vào game  -> kết nối WebSocket /ws  -> xuất hiện trong SẢNH (hub).
 *    2) Đi vào cổng "ONLINE DUO"            -> vào HÀNG CHỜ (queue).
 *    3) Đủ 2 người                          -> server tạo trận, "dịch chuyển"
 *       (teleport) cả 2 sang sân.
 *    4) Trong trận: client chỉ gửi PHÍM BẤM (30 lần/giây). Server tự tính
 *       toàn bộ vật lý (người, bóng, va chạm, bàn thắng, đồng hồ, 8 NPC)
 *       rồi gửi ảnh chụp trạng thái về cho cả 2 người (30 lần/giây).
 *
 *  Giao thức khớp 100% với file game HTML:
 *    sảnh   : hubJoin / hubPose / hubBeat / hubLeave
 *    hàng chờ: queueJoin / queueCancel  ->  queueFound
 *    trận   : matchJoin / matchInput / matchAction / matchLeave
 *             -> matchWelcome / matchWaiting / matchStart / matchState ...
 *
 *  Chạy:  npm install   rồi   npm start        (Render tự đặt biến PORT)
 *  Đặt file game HTML cạnh server.js (nên đặt tên index.html).
 * ============================================================================
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

// ----------------------------------------------------------------------------
//  Cấu hình (đổi bằng biến môi trường trên Render nếu muốn)
// ----------------------------------------------------------------------------
function clamp(v, a, z) { return Math.max(a, Math.min(z, v)); }
const PORT = Number(process.env.PORT) || 3000;
const SIM_HZ = 60;                                              // tốc độ mô phỏng vật lý
const NET_HZ = clamp(Number(process.env.NET_HZ) || 30, 10, 60); // tốc độ gửi trạng thái cho client
const MATCH_SECONDS = clamp(Number(process.env.MATCH_SECONDS) || 180, 30, 900);
const AI_DIFF = clamp(process.env.AI_DIFFICULTY && Number.isFinite(Number(process.env.AI_DIFFICULTY)) ? Number(process.env.AI_DIFFICULTY) : 0.6, 0, 1); // độ khó NPC 0–1
const HUB_MAX = Number(process.env.HUB_MAX) || 80;             // số người tối đa trong sảnh
const MATCH_MAX = Number(process.env.MATCH_MAX) || 40;         // số trận chạy cùng lúc
const JOIN_TIMEOUT_MS = 20000;                                  // chờ người thứ 2 nối vào trận
const END_KEEP_MS = 45000;                                      // giữ trận sau khi kết thúc
const MATCH_MAX_MS = 20 * 60 * 1000;                            // trần an toàn cho 1 trận
const HUMAN_TOUCH = 1.25;                                       // bán kính chạm bóng của người chơi (bù độ trễ mạng)

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const rid = n => crypto.randomBytes(n).toString('hex');

// ----------------------------------------------------------------------------
//  Hằng số sân — GIỐNG HỆT file game
// ----------------------------------------------------------------------------
const HX = 34, HZ = 52, GW = 7.32, GH = 2.44, R = 0.4;
const KNUCKLE_SWAY = 36, KNUCKLE_FREQ = 10.5;
const CH_NAMES = ['Kaze', 'Goro', 'Sora', 'Tetsu', 'Haru', 'Mio'];
// [tốc độ, lực sút, kỹ thuật, tranh chấp, không chiến]
const CH_STATS = [[10, 6, 7, 5, 4], [5, 10, 6, 6, 5], [7, 6, 10, 4, 5], [6, 5, 4, 10, 7], [6, 6, 5, 5, 10], [7, 6, 7, 6, 6]];
const SKL = { Kaze: { cd: 45, du: 30 }, Goro: { cd: 100, du: 0 }, Sora: { cd: 20, du: 0 }, Haru: { cd: 50, du: 0 }, Mio: { cd: 25, du: 7 }, Tetsu: { cd: 50, du: 0 } };
const SORA_RAIN = { cd: 20, du: 0 };
const FB_STAT = 15, SPN = 0.9, RAIN_DUR = 1.05;
// [đội, vai trò, sx, sd]   (đội 0 = Xanh, đội 1 = Đỏ). Người chơi: chỉ số 0 (Xanh) và 5 (Đỏ)
const LAYOUT = [
  [0, 'f', 0, 13.8], [0, 'f', -5, 10.5], [0, 'f', 5, 10.5], [0, 'f', 0, 6.5], [0, 'gk', 0, 1.1],
  [1, 'f', -2.2, 13.8], [1, 'f', 2.2, 13.8], [1, 'f', -5, 9], [1, 'f', 5, 9], [1, 'gk', 0, 1.1]
];
const HUMAN_IDX = [0, 5];
const AX = [-3.25, -2.75, -2.25, -1.7, -1.15, -.6, 0, .6, 1.15, 1.7, 2.25, 2.75, 3.25], AY = [.55, 1.25, 1.95];

const ang = (a, t, k) => { const d = (((t - a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; return a + d * k; };
const r2 = v => Math.round(v * 100) / 100;
const num = (v, d = 0) => { v = Number(v); return Number.isFinite(v) ? v : d; };

function makePlayer(i, t, role, sx, sd) {
  return {
    i, t, role, sx: sx * HX / 9, sd: sd * HZ / 15, human: false, slot: -1, charIndex: -1, stamina: 100,
    p: { x: 0, y: 0, z: 0 }, v: { x: 0, z: 0 }, vy: 0, a: 0, cd: 0, sl: 0, slc: 0, stun: 0, hd: 0, hit: 0, hold: 0, pw: 0,
    gx: 0, gn: 0, imm: 0, spin: 0, spinType: '', sa: 0, dr: { x: 0, z: 1 }, sv: { x: 0, z: 0 },
    s: { spd: 5, sht: 5, tec: 5, def: 5, air: 5 }, rf: { x: 0, z: -1 }, ego: false,
    skMainCd: 0, skRainCd: 0, skBoost: 0, haruMeteor: 0, mioTouch: 0, mioBallLock: false, tetsuWall: 0, tetsuUsed: 0,
    wantSlide: false, in: { k: 0, y: 0, t: -9 }
  };
}

// ============================================================================
//  MÔ PHỎNG TRẬN ĐẤU (vật lý chạy hoàn toàn trên server)
// ============================================================================
class Sim {
  /** humans: [{sel,name},{sel,name}] — slot 0 = Xanh (P[0]), slot 1 = Đỏ (P[5]) */
  constructor(humans) {
    this.P = LAYOUT.map((l, i) => makePlayer(i, ...l));
    this.b = {
      p: { x: 0, y: R, z: 0 }, v: { x: 0, y: 0, z: 0 }, cv: 0, ct: 0, cd: 0, knuckle: 0, knuckleT: 0, knucklePhase: 0,
      rainVolley: 0, rainPhase: 0, rainBounces: 0, soraShield: 0, soraShieldTeam: 0
    };
    this.s0 = 0; this.s1 = 0; this.tl = MATCH_SECONDS; this.ph = 'play'; this.gt = 0; this.clock = 0;
    this.dt = 1 / SIM_HZ; this.kteam = Math.random() < 0.5 ? 0 : 1; this.klock = 0;
    const q = 4 + AI_DIFF * 6;                      // chỉ số NPC (như game gốc: 4–10 theo độ khó)
    for (const o of this.P) o.s = { spd: q, sht: q, tec: q, def: q, air: q };
    HUMAN_IDX.forEach((idx, slot) => {
      const o = this.P[idx], sel = clamp(num(humans[slot] && humans[slot].sel) | 0, 0, 5), s = CH_STATS[sel];
      o.human = true; o.slot = slot; o.charIndex = sel;
      o.s = { spd: s[0], sht: s[1], tec: s[2], def: s[3], air: s[4] };
      o.in = { k: 0, y: slot ? Math.PI : 0, t: -9 };
    });
    this.reset();
  }

  human(slot) { return this.P[HUMAN_IDX[slot]]; }
  setHuman(slot, on) { const o = this.human(slot); o.human = !!on; if (!on) { o.in.k = 0; o.wantSlide = false; } }

  setInput(slot, k, y) { const o = this.human(slot); if (!o || !o.human) return; o.in.k = k & 63; o.in.y = y; o.in.t = this.clock; }

  // ---------------------------------------------------------------- khởi tạo
  reset() {
    for (const o of this.P) {
      const dz = o.t ? 1 : -1;
      o.p.x = o.sx; o.p.y = 0; o.p.z = -dz * HZ + dz * o.sd; o.v.x = o.v.z = 0; o.a = o.t ? 0 : Math.PI;
      o.cd = 0; o.sl = o.slc = o.stun = 0; o.hit = 0; o.sv.x = o.sv.z = 0; o.vy = o.hd = 0; o.hold = 0; o.gx = 0;
      o.spin = 0; o.spinType = ''; o.imm = 0; o.sa = 0; o.haruMeteor = 0; o.mioTouch = 0; o.mioBallLock = false;
      o.tetsuWall = 0; o.tetsuUsed = 0; o.wantSlide = false;
    }
    const b = this.b;
    b.p.x = 0; b.p.y = R; b.p.z = 0; b.v.x = b.v.y = b.v.z = 0; b.cv = b.ct = b.cd = 0; b.knuckle = b.knuckleT = 0;
    b.rainVolley = b.rainPhase = b.rainBounces = 0; b.soraShield = 0;
    this.klock = 5;
    this.kickerSet();
  }

  kickerSet() {
    let k = null, m = 1e9;
    for (const o of this.P) {
      if (o.t !== this.kteam || o.role === 'gk') continue;
      const d = Math.hypot(o.p.x, o.p.z);
      if (d < m) { m = d; k = o; }
    }
    if (k) { k.p.x = 0; k.p.z = (k.t ? -1 : 1) * 1.1; k.a = k.t ? 0 : Math.PI; }
  }

  // -------------------------------------------------------------- vòng lặp
  step(dt) {
    this.dt = dt; this.clock += dt;
    if (this.ph === 'play') this.stepPlay(dt);
    else if (this.ph === 'goal') { this.ball(dt); this.gt -= dt; if (this.gt <= 0) { this.reset(); this.ph = 'play'; } }
  }

  stepPlay(dt) {
    const P = this.P, b = this.b;
    // 1) người chơi (điều khiển bằng phím gửi lên)
    for (const o of P) if (o.human) this.control(o, dt);

    // 2) NPC: chọn người đuổi bóng cho mỗi đội
    const ch = [null, null], cd = [1e9, 1e9];
    for (const o of P) {
      if (o.human || o.role === 'gk') continue;
      const d = Math.hypot(b.p.x - o.p.x, b.p.z - o.p.z);
      if (d < cd[o.t]) { cd[o.t] = d; ch[o.t] = o; }
    }
    for (const h of P) if (h.human && h.role !== 'gk' && Math.hypot(b.p.x - h.p.x, b.p.z - h.p.z) < cd[h.t] - 1) ch[h.t] = null;
    for (const o of P) if (!o.human) this.ai(o, ch, dt);

    // 3) cập nhật từng cầu thủ: hồi chiêu, trượt tắc bóng, thủ môn, đánh đầu, chạm bóng
    const spinner = P.find(q => q.spin > 0) || null;
    for (const o of P) {
      o.cd -= dt; o.haruMeteor = Math.max(0, o.haruMeteor - dt); o.mioTouch = Math.max(0, o.mioTouch - dt);
      if (o.mioTouch <= 0) o.mioBallLock = false;
      o.tetsuWall = Math.max(0, o.tetsuWall - dt);
      o.skMainCd = Math.max(0, o.skMainCd - dt); o.skRainCd = Math.max(0, o.skRainCd - dt); o.skBoost = Math.max(0, o.skBoost - dt);
      const ex = b.p.x - o.p.x, ez = b.p.z - o.p.z, d = Math.hypot(ex, ez);
      o.sl -= dt; o.slc -= dt; o.stun -= dt; o.hd -= dt; o.imm -= dt;
      if (o.p.y > 0 || o.vy > 0) { o.vy -= 20 * dt; o.p.y = Math.max(0, o.p.y + o.vy * dt); if (o.p.y <= 0) o.vy = 0; }

      if (o.sl > 0 && !o.hit) {
        let h = 0;
        if (!(b.soraShield > 0 && o.t !== b.soraShieldTeam) && !P.some(q => q.mioTouch > 0 && q.t !== o.t && Math.hypot(q.p.x - o.p.x, q.p.z - o.p.z) < 1.35) && d < 1.3 && b.p.y < 1) {
          b.v.x = o.sv.x * 0.9; b.v.y = 1.5; b.v.z = o.sv.z * 0.9; b.ct = 0; h = 1;
        }
        for (const q of P) {
          if (q.t !== o.t && q.role !== 'gk' && q.sl <= 0 && !(q.imm > 0) && !(q.mioTouch > 0) && Math.hypot(q.p.x - o.p.x, q.p.z - o.p.z) < 1.1) {
            q.stun = 0.8 * (0.8 + 0.04 * o.s.def) * (1.35 - 0.07 * q.s.def); q.cd = 0.8; h = 1;
          }
        }
        if (h) o.hit = 1;
      }
      if (o.role === 'gk') { if (d < this.gkReach() && b.p.y < 2.2 && o.cd <= 0) this.gkHit(o); continue; }

      // Sora: khi đang xoay/hất bóng thì bóng được che chắn
      if (b.soraShield > 0 && o.t !== b.soraShieldTeam) {
        if (spinner && Math.hypot(o.p.x - spinner.p.x, o.p.z - spinner.p.z) < 1.55 && o.stun <= 0) {
          const sx = o.p.x - spinner.p.x, sz = o.p.z - spinner.p.z, side = Math.sign(sx * spinner.dr.z - sz * spinner.dr.x) || 1;
          o.stun = 0.78; o.cd = Math.max(o.cd, 0.8);
          o.v.x += spinner.dr.x * 1.3 + spinner.dr.z * side * 2.2; o.v.z += spinner.dr.z * 1.3 - spinner.dr.x * side * 2.2;
        }
        continue;
      }
      // Mio: Phantom Touch bảo vệ bóng gần
      const phantom = P.find(q => q.mioTouch > 0 && q.t !== o.t && Math.hypot(b.p.x - q.p.x, b.p.z - q.p.z) < 1.35);
      if (phantom && d < 1.15) {
        if (o.stun <= 0) { const sx = o.p.x - phantom.p.x, sz = o.p.z - phantom.p.z, L = Math.hypot(sx, sz) || 1; o.v.x += sx / L * 1.1; o.v.z += sz / L * 1.1; }
        continue;
      }
      // Tetsu: Iron Wall
      if (o.tetsuWall > 0) {
        for (const q of P) {
          if (q.t !== o.t && q.role !== 'gk' && q.stun <= 0 && Math.hypot(q.p.x - o.p.x, q.p.z - o.p.z) < 1.35) {
            const sx = q.p.x - o.p.x, sz = q.p.z - o.p.z, L = Math.hypot(sx, sz) || 1; q.stun = 0.48; q.v.x += sx / L * 2.5; q.v.z += sz / L * 2.5;
          }
        }
        if (!o.tetsuUsed && d < 1.55 && b.p.y < 1.35) {
          const fx = Math.sin(o.a), fz = Math.cos(o.a);
          b.p.x = o.p.x + fx * 0.72; b.p.z = o.p.z + fz * 0.72; b.p.y = R; b.v.x = fx * 8.2; b.v.y = 1.0; b.v.z = fz * 8.2;
          b.ct = 0; b.cv = 0; b.knuckle = 0; o.tetsuUsed = 1;
        }
        continue;
      }
      // đánh đầu
      const meteorHead = o.haruMeteor > 0 && o.charIndex === 4 && d < 0.95 && Math.abs(b.p.y - (o.p.y + 1.6)) < 0.82;
      if (!(o.human && b.rainVolley > 0) && (meteorHead || (d < 0.7 + 0.05 * o.s.air && o.cd <= 0 && o.sl <= 0 && o.stun <= 0 && b.p.y - o.p.y > 1.15 && b.p.y - o.p.y < 2.4))) {
        const f = o.rf;
        this.head(o, o.human ? f.x : this.aiHeadX(o) - o.p.x, o.human ? f.z : (o.t ? HZ : -HZ) - o.p.z,
          o.human ? 12 + Math.min(8, Math.hypot(b.v.x, b.v.z) * 0.3) : 17 + Math.random() * 8);
        continue;
      }
      // chạm bóng (rê bóng)
      const touchRadius = o.human ? HUMAN_TOUCH : 0.8;
      if (!(spinner && o !== spinner && o.t !== spinner.t && Math.hypot(o.p.x - spinner.p.x, o.p.z - spinner.p.z) < 1.5) && d < touchRadius && b.p.y < 1 && o.cd <= 0) {
        const n = d || 1;
        b.v.x = o.v.x * 1.15 + ex / n * 1.6; b.v.z = o.v.z * 1.15 + ez / n * 1.6; b.v.y *= 0.3;
        if (!o.human) { const af = o.t ? 1 : -1; if (b.v.z * af < 0.5) b.v.z = af * (Math.abs(b.v.z) + 1.5); }
        b.ct = 0;
      }
    }
    // 4) cầu thủ không xuyên qua nhau
    for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
      const A = P[i], B = P[j];
      if ((A.mioTouch > 0 || B.mioTouch > 0) && A.t !== B.t) continue;
      if (A.spin > 0 || B.spin > 0) continue;
      const ex = B.p.x - A.p.x, ez = B.p.z - A.p.z, d = Math.hypot(ex, ez);
      if (d < 0.7 && d > 0) { const u = (0.7 - d) / 2 / d; A.p.x -= ex * u; A.p.z -= ez * u; B.p.x += ex * u; B.p.z += ez * u; }
    }
    // 5) giao bóng, kỹ năng xoay bóng, bóng, đồng hồ
    this.koTick(dt);
    for (const o of P) if (o.spin > 0) this.skillBallTick(o, dt);
    this.ball(dt);
    this.tl -= dt;
    if (this.tl <= 0 && this.ph === 'play') { this.tl = 0; this.ph = 'end'; for (const o of P) { o.v.x = o.v.z = 0; } }
  }

  koTick(dt) {
    if (this.klock <= 0) return;
    const b = this.b;
    this.klock -= dt;
    if (this.klock <= 0 || Math.hypot(b.p.x, b.p.z) > 0.5) { this.klock = 0; return; }
    for (const o of this.P) {
      if (o.t === this.kteam) continue;
      const s = o.t ? -1 : 1;
      let x = o.p.x, z = s * Math.max(0.4, o.p.z * s);
      const d = Math.hypot(x, z);
      if (d < 4.5) { x *= 4.5 / d; z *= 4.5 / d; }
      if (x !== o.p.x || z !== o.p.z) { o.p.x = x; o.p.z = z; o.v.x *= 0.2; o.v.z *= 0.2; }
    }
  }

  // ------------------------------------------------------------ di chuyển
  move(o, tx, tz, dt, acc) {
    if (o.sl > 0) { tx = o.sv.x * (0.4 + o.sl); tz = o.sv.z * (0.4 + o.sl); acc = 30; }
    else if (o.stun > 0) { tx = tz = 0; acc = 10; }
    const k = Math.min(1, acc * dt);
    o.v.x += (tx - o.v.x) * k; o.v.z += (tz - o.v.z) * k;
    o.p.x = clamp(o.p.x + o.v.x * dt, -HX + 0.5, HX - 0.5);
    o.p.z = clamp(o.p.z + o.v.z * dt, -HZ + 0.5, HZ - 0.5);
  }

  slide(o, dx, dz) {
    if (o.sl > 0 || o.slc > 0 || o.stun > 0) return;
    const n = Math.hypot(dx, dz) || 1, sv = 10.5 * (0.8 + 0.04 * o.s.def);
    o.sl = 0.55; o.slc = 1.7 - 0.08 * o.s.def; o.hit = 0; o.sv.x = dx / n * sv; o.sv.z = dz / n * sv; o.a = Math.atan2(dx, dz);
  }

  /** Điều khiển người chơi từ phím: bit 1=W 2=A 4=S 8=D 16=Shift 32=Z(nhảy) */
  control(o, dt) {
    const I = o.in, k = (this.clock - I.t) < 0.45 ? I.k : 0;
    const f = { x: Math.sin(I.y), z: -Math.cos(I.y) }, r = { x: Math.cos(I.y), z: Math.sin(I.y) };
    o.rf = f;
    if (o.spin > 0) { const dash = o.spinType === 'rain' ? 5.2 : 2.2; this.move(o, o.dr.x * dash, o.dr.z * dash, dt, 34); o.wantSlide = false; return; }
    const S = o.s;
    const ix = ((k >> 3) & 1) - ((k >> 1) & 1), iz = (k & 1) - ((k >> 2) & 1), l = Math.hypot(ix, iz);
    const sprinting = !!((k & 16) && l > 0.05 && o.stamina > 0 && o.sl <= 0 && o.stun <= 0);
    if (sprinting) o.stamina = Math.max(0, o.stamina - 27 * dt); else o.stamina = Math.min(100, o.stamina + 18 * dt);
    const boost = o.skBoost > 0 ? 1.5 : 1, mio = o.mioTouch > 0 ? 1.28 : 1;
    const sp = (sprinting ? 1.31 : 1) * boost * mio * (6.6 + 0.28 * S.spd);
    let dx = 0, dz = 0;
    if (l) {
      dx = (f.x * iz + r.x * ix) / l; dz = (f.z * iz + r.z * ix) / l;
      if (o.sl <= 0 && o.stun <= 0) o.a = ang(o.a, Math.atan2(dx, dz), 1 - Math.exp(-12 * dt));
    }
    if (o.wantSlide) { o.wantSlide = false; this.slide(o, l ? dx : f.x, l ? dz : f.z); }
    if ((k & 32) && o.p.y <= 0 && o.sl <= 0 && o.stun <= 0) o.vy = 7.4 * (0.85 + 0.03 * S.air);
    this.move(o, dx * sp, dz * sp, dt, (7 + 0.4 * S.tec) * boost);
  }

  // ------------------------------------------------------------ hành động
  action(slot, m) {
    const o = this.human(slot);
    if (!o || !o.human || this.ph !== 'play') return;
    switch (m.action) {
      case 'slide': if (!(o.spin > 0)) o.wantSlide = true; break;
      case 'shoot': this.shoot(o, m); break;
      case 'pass': this.passPlayer(o); break;
      case 'skill': this.skillApply(o, m.which === 'rain' ? 'rain' : 'main', num(m.yaw, o.in.y), num(m.k) & 15); break;
    }
  }

  shoot(o, m) {
    const b = this.b;
    if (o.role === 'gk' || o.sl > 0 || o.stun > 0 || o.spin > 0 || o.cd > 0.25) return;
    const c = clamp(num(m.charge), 0, 1), mode = clamp(num(m.mode) | 0, 0, 3), yaw = num(m.yaw, o.in.y), km = num(m.k) | 0;
    const locked = o.charIndex === 5 && o.mioBallLock;
    const gap = locked ? 0 : Math.hypot(b.p.x - o.p.x, b.p.z - o.p.z);
    if (locked) o.mioBallLock = false;
    const S = o.s, pm = 0.7 + 0.06 * S.sht, cm = 0.6 + 0.08 * S.tec, shotMul = o.charIndex === 1 ? 1.7 : 1;
    const f = { x: Math.sin(yaw), z: -Math.cos(yaw) }, rr = { x: Math.cos(yaw), z: Math.sin(yaw) };
    const pitch = clamp(num(m.pitch), -0.2, 0.62), aimFlat = Math.cos(pitch), aimLift = Math.tan(pitch);
    let sd = ((km >> 3) & 1) - ((km >> 1) & 1);
    if (!sd) sd = ((-o.p.x) * rr.x + (HZ * Math.sign(f.z) - o.p.z) * rr.z) > 0 ? 1 : -1;
    const er = (Math.random() - 0.5) * (10 - S.tec) * 0.022;

    // Sora: Rain Volley
    if (mode === 0 && o.charIndex === 2 && b.rainVolley > 0 && b.rainPhase === 2 && gap < 3.1 && b.p.y > R + 0.12 && b.p.y < R + 1.55) {
      o.spin = 0; o.spinType = ''; o.sa = 0; b.knuckle = 0; b.knuckleT = 0;
      const power = Math.min(56, (29 + c * 12) * pm) * shotMul;
      b.v.x = f.x * power * aimFlat; b.v.y = 5.2 + c * 2.8 + power * aimLift; b.v.z = f.z * power * aimFlat;
      b.cv = sd * 6.5 * cm * (0.8 + c * 1.25); b.ct = 0.5; b.cd = 0.12; b.rainVolley = 0; b.rainPhase = 0; b.rainBounces = 0; b.soraShield = 0;
      o.v.x += f.x * 1.8; o.v.z += f.z * 1.8; o.cd = 0.42; o.a = Math.atan2(f.x, f.z);
      return;
    }
    if (gap > 2.05 || b.p.y > 1.65) return;
    o.spin = 0; o.spinType = ''; o.sa = 0; b.knuckle = 0; b.knuckleT = 0;
    if (mode === 0) {
      const ego = c > 0.95, s = Math.min(56, (ego ? 42 : 12 + c * 24) * pm) * shotMul;
      b.v.x = f.x * s * aimFlat; b.v.y = 1.2 + c * 3.5 + s * aimLift; b.v.z = f.z * s * aimFlat; b.ct = 0;
    } else if (mode === 1 || mode === 2) {
      const off = mode === 1 ? 0.22 : 0.3, s = Math.min(52, ((mode === 1 ? 16 : 19) + c * 14) * pm) * shotMul;
      const x = f.x - rr.x * sd * off, z = f.z - rr.z * sd * off, n = Math.hypot(x, z) || 1;
      const curveCharge = 1 + c * 0.72, loft = (mode === 1 ? 2.2 : 1.3) + c * (mode === 1 ? 5.2 : 6.0) + s * aimLift;
      b.v.x = x / n * s * aimFlat; b.v.y = loft; b.v.z = z / n * s * aimFlat;
      b.cv = sd * (mode === 1 ? 10 : 16) * cm * curveCharge; b.ct = 1.25 + c * 0.35; b.cd = mode === 1 ? 0 : 0.16;
    } else {
      const s = Math.min(38, (18 + c * 13) * pm) * shotMul;
      b.v.x = f.x * s * aimFlat; b.v.y = 7.8 + c * 5.2 + s * aimLift; b.v.z = f.z * s * aimFlat; b.ct = 0; b.cv = 0;
    }
    const ce = Math.cos(er), se = Math.sin(er), vx = b.v.x, vz = b.v.z;
    b.v.x = vx * ce - vz * se; b.v.z = vx * se + vz * ce;
    o.cd = 0.4; o.a = Math.atan2(f.x, f.z);
  }

  passPlayer(o) {
    const b = this.b, P = this.P;
    if (this.ph !== 'play' || o.role === 'gk' || o.sl > 0 || o.stun > 0 || o.spin > 0) return false;
    const gap = o.charIndex === 5 && o.mioBallLock ? 0 : Math.hypot(b.p.x - o.p.x, b.p.z - o.p.z);
    if (gap > 2.1 || b.p.y > 1.35) return false;
    const f = { x: Math.sin(o.a), z: Math.cos(o.a) }, team = o.t;
    let best = null, bestScore = -1e9;
    for (const q of P) {
      if (q === o || q.t !== team || q.role === 'gk') continue;
      const dx = q.p.x - o.p.x, dz = q.p.z - o.p.z, L = Math.hypot(dx, dz);
      if (L < 3 || L > 23) continue;
      const forward = (dx * f.x + dz * f.z) / L;
      let lane = 0;
      for (const e of P) {
        if (e.t === team || e.role === 'gk') continue;
        const u = clamp(((e.p.x - o.p.x) * dx + (e.p.z - o.p.z) * dz) / (L * L), 0, 1);
        if (Math.hypot(o.p.x + dx * u - e.p.x, o.p.z + dz * u - e.p.z) < 1.35) lane += 1.4;
      }
      let open = 8;
      for (const e of P) if (e.t !== team && e.role !== 'gk') open = Math.min(open, Math.hypot(e.p.x - q.p.x, e.p.z - q.p.z));
      const score = forward * 7 + open * 0.65 - L * 0.11 - lane;
      if (score > bestScore) { bestScore = score; best = q; }
    }
    if (!best) return false;
    if (o.charIndex === 5) o.mioBallLock = false;
    const dx = best.p.x + best.v.x * 0.32 - b.p.x, dz = best.p.z + best.v.z * 0.32 - b.p.z, L = Math.hypot(dx, dz) || 1, speed = clamp(12 + L * 0.65, 15, 25);
    b.v.x = dx / L * speed; b.v.y = 0.85; b.v.z = dz / L * speed; b.ct = 0; b.cv = 0; b.cd = 0; o.cd = 0.4; o.a = Math.atan2(dx, dz);
    return true;
  }

  // ----------------------------------------------------------------- kỹ năng
  skillApply(o, which, angle, keyMask) {
    const b = this.b, name = CH_NAMES[o.charIndex];
    const k = which === 'rain' ? (name === 'Sora' ? SORA_RAIN : null) : SKL[name];
    if (!k || this.ph !== 'play' || o.role === 'gk' || o.sl > 0 || o.stun > 0 || o.spin > 0) return false;
    if ((which === 'rain' ? o.skRainCd : o.skMainCd) > 0) return false;
    const f = { x: Math.sin(angle), z: -Math.cos(angle) }, r = { x: Math.cos(angle), z: Math.sin(angle) };
    const ix = ((keyMask >> 3) & 1) - ((keyMask >> 1) & 1), iz = (keyMask & 1) - ((keyMask >> 2) & 1), l = Math.hypot(ix, iz);
    const x = l ? (f.x * iz + r.x * ix) / l : f.x, z = l ? (f.z * iz + r.z * ix) / l : f.z;
    const near = m => Math.hypot(b.p.x - o.p.x, b.p.z - o.p.z) <= m + 0.35 && b.p.y <= 1.4;
    if ((name === 'Goro' || name === 'Sora') && !near(name === 'Goro' ? 1.7 : 2.8)) return false;
    if (name === 'Mio' && !near(2.25)) return false;
    if (name === 'Haru' && !near(3.0)) return false;
    const setCd = () => { if (which === 'rain') o.skRainCd = k.cd; else o.skMainCd = k.cd; };
    if (name === 'Kaze') { o.skBoost = k.du; setCd(); return true; }
    if (name === 'Goro') {
      const power = 42 * (0.7 + 0.06 * FB_STAT) * 1.7;
      b.v.x = f.x * power; b.v.y = 4.2; b.v.z = f.z * power; b.ct = 0; b.cv = 0; b.knuckle = 1.8; b.knuckleT = 0; b.knucklePhase = Math.random() * Math.PI * 2;
      o.cd = 0.45; o.a = Math.atan2(f.x, f.z); setCd(); return true;
    }
    if (name === 'Sora') {
      o.dr = { x, z }; o.spin = which === 'rain' ? RAIN_DUR : SPN; o.spinType = which === 'rain' ? 'rain' : 'spin'; o.imm = o.spin + 0.55; o.sa = 0; o.a = Math.atan2(x, z);
      b.ct = 0; b.cv = 0; b.knuckle = 0; b.knuckleT = 0; b.soraShield = o.spin + 0.4; b.soraShieldTeam = o.t; b.rainVolley = 0; b.rainPhase = 0; b.rainBounces = 0;
      setCd(); return true;
    }
    if (name === 'Haru') {
      o.a = Math.atan2(f.x, f.z); o.vy = Math.max(o.vy || 0, 7.2); o.haruMeteor = 3.2; o.imm = Math.max(o.imm || 0, 1.8);
      b.v.x = f.x * 5.4; b.v.y = 10.4; b.v.z = f.z * 5.4; b.ct = 0; b.cv = 0; b.knuckle = 0; b.rainVolley = 0; b.rainPhase = 0;
      o.cd = 0.25; setCd(); return true;
    }
    if (name === 'Mio') {
      o.dr = { x, z }; o.a = Math.atan2(x, z); o.mioTouch = k.du; o.mioBallLock = true; o.imm = Math.max(o.imm || 0, k.du); o.v.x += x * 2.4; o.v.z += z * 2.4;
      setCd(); return true;
    }
    if (name === 'Tetsu') {
      o.tetsuWall = 3.2; o.tetsuUsed = 0; o.imm = Math.max(o.imm || 0, 3.2); o.v.x *= 0.35; o.v.z *= 0.35; o.a = Math.atan2(f.x, f.z);
      setCd(); return true;
    }
    return false;
  }

  skillBallTick(o, dt) {
    const b = this.b, type = o.spinType || 'spin', dur = type === 'rain' ? RAIN_DUR : SPN;
    const p = clamp(1 - o.spin / dur, 0, 1), k = 1 - Math.exp(-28 * dt);
    if (type === 'rain') {
      const turn = p * Math.PI * 4.2, rad = 0.025 + 0.34 * p, ease = p * p * (3 - 2 * p), lead = 0.18 + 0.58 * p;
      const tx = o.p.x + o.dr.x * lead + Math.cos(turn) * rad, tz = o.p.z + o.dr.z * lead + Math.sin(turn) * rad, ty = R + 0.05 + 0.48 * ease;
      b.p.x += (tx - b.p.x) * k; b.p.z += (tz - b.p.z) * k; b.p.y += (ty - b.p.y) * k; b.v.x = b.v.y = b.v.z = 0; b.ct = 0; b.cv = 0;
    } else {
      const turn = p * Math.PI * 2, bodyA = o.a + turn, tx = o.p.x + Math.sin(bodyA) * 0.52, tz = o.p.z + Math.cos(bodyA) * 0.52;
      b.p.x += (tx - b.p.x) * k; b.p.z += (tz - b.p.z) * k; b.p.y += (R - b.p.y) * k; b.v.x = b.v.y = b.v.z = 0; b.ct = 0; b.cv = 0;
    }
    o.spin -= dt;
    if (o.spin <= 0) {
      const rain = type === 'rain';
      o.spin = 0; o.spinType = ''; o.sa = 0; o.imm = 0.25; b.soraShield = 0.28; b.soraShieldTeam = o.t;
      if (rain) {
        const L = Math.hypot(o.dr.x, o.dr.z) || 1, rx = o.dr.x / L, rz = o.dr.z / L;
        b.p.x = o.p.x + rx * 0.82; b.p.y = R + 0.48; b.p.z = o.p.z + rz * 0.82; b.v.x = rx * 7.0; b.v.y = 10.2; b.v.z = rz * 7.0; b.cv = 0; b.ct = 0; b.cd = 0.1;
        b.rainVolley = 2.5; b.rainPhase = 1; b.rainBounces = 0; o.v.x = rx * 4.5; o.v.z = rz * 4.5; o.cd = 0.45;
      } else {
        b.p.x = o.p.x + o.dr.x * 0.72; b.p.y = R; b.p.z = o.p.z + o.dr.z * 0.72; b.v.x = o.dr.x * 9.5; b.v.y = 0.55; b.v.z = o.dr.z * 9.5; b.ct = 0; b.cv = 0;
        o.v.x = o.dr.x * 3.2; o.v.z = o.dr.z * 3.2; o.cd = 0.35;
      }
    }
  }

  head(o, dx, dz, pw) {
    const b = this.b, n = Math.hypot(dx, dz) || 1, hy = b.p.y - o.p.y, meteor = o.haruMeteor > 0 && o.charIndex === 4;
    const k = pw * (0.8 + 0.04 * o.s.air) * (meteor ? 1.75 : 1);
    b.v.x = dx / n * k * (meteor ? 1.18 : 1); b.v.y = meteor ? -1.0 : (hy > 1.9 ? -1.5 : 2.2); b.v.z = dz / n * k * (meteor ? 1.18 : 1);
    b.ct = 0; o.cd = 0.45; o.hd = 0.35;
    if (meteor) o.haruMeteor = 0;
  }

  // ------------------------------------------------------------------- bóng
  ball(dt) {
    const b = this.b, p = b.p, v = b.v;
    b.rainVolley = Math.max(0, b.rainVolley - dt); b.soraShield = Math.max(0, b.soraShield - dt);
    if (b.rainVolley <= 0 && b.rainPhase !== 0) b.rainPhase = 0;
    // Mio đang "giữ" bóng: khóa bóng ngay trước chân
    const carrier = this.P.find(o => o.charIndex === 5 && o.mioTouch > 0 && o.mioBallLock);
    if (carrier) {
      const a = carrier.a;
      p.x = carrier.p.x + Math.sin(a) * 0.47; p.y = carrier.p.y + R; p.z = carrier.p.z + Math.cos(a) * 0.47;
      v.x = carrier.v.x; v.y = 0; v.z = carrier.v.z; b.ct = 0; b.cv = 0; b.cd = 0; b.knuckle = 0; b.knuckleT = 0; b.rainVolley = 0; b.rainPhase = 0; b.soraShield = 0;
      return;
    }
    v.y -= 20 * dt;
    if (b.knuckle > 0) {
      const speed = Math.hypot(v.x, v.z) || 1, side = Math.sin(b.knuckleT * KNUCKLE_FREQ + b.knucklePhase) * KNUCKLE_SWAY, nx = -v.z / speed, nz = v.x / speed;
      v.x += nx * side * dt; v.z += nz * side * dt; b.knuckle = Math.max(0, b.knuckle - dt); b.knuckleT += dt;
    } else if (b.ct > 0) {
      b.ct -= dt;
      if (b.cd > 0) b.cd -= dt;
      else { const s = Math.hypot(v.x, v.z) || 1, vx = v.x; v.x += -v.z / s * b.cv * dt; v.z += vx / s * b.cv * dt; }
    }
    p.x += v.x * dt; p.y += v.y * dt; p.z += v.z * dt;
    if (p.y < R) {
      p.y = R;
      if (b.rainVolley > 0 && b.rainPhase === 1 && b.rainBounces === 0 && v.y < 0) { v.y = Math.abs(v.y) * 0.62; b.rainPhase = 2; b.rainBounces = 1; v.x *= 0.88; v.z *= 0.88; b.ct = 0; b.cv = 0; }
      else if (b.rainVolley > 0 && b.rainPhase === 2 && b.rainBounces === 1) { v.y = 0; b.rainVolley = 0; b.rainPhase = 0; v.x *= 0.72; v.z *= 0.72; }
      else { if (v.y < -1.5) v.y *= -0.55; else v.y = 0; b.rainVolley = 0; b.rainPhase = 0; const k = Math.max(0, 1 - 0.7 * dt); v.x *= k; v.z *= k; }
    }
    const az = Math.abs(p.z), sg = Math.sign(p.z), mouth = Math.abs(p.x) < GW / 2 - 0.05 && p.y < GH;
    if (this.ph === 'play') {
      if (az > HZ && mouth) this.goal(p.z < 0 ? 0 : 1);
      else if (az > HZ - R && !mouth) { p.z = sg * (HZ - R); v.z *= -0.6; }
    }
    if (this.ph === 'goal' && az > HZ + 2 - R) { p.z = sg * (HZ + 2 - R); v.z *= -0.4; }
    const lim = Math.abs(p.z) > HZ ? GW / 2 : HX;
    if (Math.abs(p.x) > lim - R) { p.x = Math.sign(p.x) * (lim - R); v.x *= -0.6; }
  }

  goal(t) {
    this.ph = 'goal'; this.gt = 2.8;
    if (t) this.s1++; else this.s0++;
    this.kteam = t ? 0 : 1;
  }

  // ------------------------------------------------------------- NPC (AI)
  aiRun(o, k) { const D = AI_DIFF; return k === 'gk' ? 7.6 + 2.2 * D : k === 'chase' ? 7.6 + 3.4 * D : k === 'carry' ? 7.3 + 3.3 * D : 6.8 + 2.2 * D; }
  gkReach() { return 1.15 + 0.3 * AI_DIFF; }
  gkHit(o) {
    const b = this.b;
    b.v.x = (Math.random() - 0.5) * 14; b.v.y = 3; b.v.z = (o.t ? 1 : -1) * 18; b.ct = 0; b.knuckle = 0; b.knuckleT = 0; o.cd = 0.6;
  }
  aiHeadX(o) {
    const gk = this.P.find(q => q.t !== o.t && q.role === 'gk'), s = gk ? (gk.p.x > 0 ? -1 : 1) : (Math.random() < 0.5 ? -1 : 1);
    return s * (1.6 + Math.random() * 1.4);
  }
  aiSpd(o, L0) {
    const D = AI_DIFF, pm = 0.7 + 0.06 * o.s.sht;
    o.ego = L0 > 11 && o.pw < 0.05 + 0.45 * D * D;
    return Math.min(56, pm * (o.ego ? 42 : 24 + 7 * D + Math.min(L0, 20) * 0.3));
  }
  aiPlan(o, spd) {
    const b = this.b, P = this.P, dz2 = o.t ? 1 : -1, gz = dz2 * HZ, sx = b.p.x, sz = b.p.z, sy = Math.max(R, b.p.y);
    const gk = P.find(q => q.t !== o.t && q.role === 'gk'), bl = P.filter(q => q !== o && q.role !== 'gk');
    const rch = gk ? this.gkReach() : 1.3, gs = gk ? this.aiRun(gk, 'gk') : 8, sg = 0.55 - 0.045 * o.s.tec, best = { sc: -9, tx: 0, ty: 1.2, sg, m: 0 }, lag = 0.2;
    for (const tx of AX) for (const ty of AY) {
      const dx = tx - sx, dz = gz - sz, L = Math.hypot(dx, dz);
      if (L < 1.5) continue;
      const Tt = L / spd, vy = (ty - sy + 10 * Tt * Tt + 10 * this.dt * Tt) / Tt, sig = sg * (0.35 + L / 30);
      let m = 3, pen = 0;
      if (gk) m = Math.abs(tx - gk.p.x) - rch - gs * Math.max(0, Tt - lag);
      for (const q of bl) {
        const u = clamp(((q.p.x - sx) * dx + (q.p.z - sz) * dz) / (L * L), 0, 1), t = u * Tt, y = sy + vy * t - 10 * t * t;
        if (u * L > 0.8 && Math.hypot(sx + dx * u - q.p.x, sz + dz * u - q.p.z) < 0.95 && y < 2.35) { pen = 3; break; }
      }
      const risk = Math.max(0, 1.8 * sig - (GW / 2 - 0.1 - Math.abs(tx))) * 2 + Math.max(0, 1.8 * sig - (GH - 0.1 - ty)) * 2;
      const sc = Math.min(m, 2) - pen - risk - 0.01 * Math.abs(ty - 1.2);
      if (sc > best.sc) { best.sc = sc; best.tx = tx; best.ty = ty; best.m = m; }
    }
    return best;
  }
  aiShoot(o, pl, spd) {
    const b = this.b, dz2 = o.t ? 1 : -1, gz = dz2 * HZ, sx = b.p.x, sz = b.p.z, sy = Math.max(R, b.p.y);
    const L = Math.hypot(pl.tx - sx, gz - sz), sig = pl.sg * (0.35 + L / 30), rn = () => Math.random() + Math.random() - 1;
    const tx = pl.tx + rn() * sig * 1.3, ty = clamp(pl.ty + rn() * sig * 0.9, 0.45, 2.25), dx = tx - sx, dz = gz - sz, Tt = (Math.hypot(dx, dz) / spd) || 1;
    b.v.x = dx / Tt; b.v.y = (ty - sy + 10 * Tt * Tt + 10 * this.dt * Tt) / Tt; b.v.z = dz / Tt;
    b.ct = 0; o.cd = 0.9; o.a = Math.atan2(dx, dz); o.hold = 0;
  }
  aiPass(o) {
    const b = this.b, P = this.P, f = o.t ? 1 : -1;
    let best = null, bs = 2.6;
    for (const q of P) {
      if (q === o || q.t !== o.t || q.role === 'gk') continue;
      const dx = q.p.x - o.p.x, dz = q.p.z - o.p.z, L = Math.hypot(dx, dz);
      if (L < 4 || L > 15 || dz * f < -0.5) continue;
      let free = 9, blk = 0;
      for (const e of P) {
        if (e.t === o.t || e.role === 'gk') continue;
        free = Math.min(free, Math.hypot(e.p.x - q.p.x, e.p.z - q.p.z));
        const u = clamp(((e.p.x - o.p.x) * dx + (e.p.z - o.p.z) * dz) / (L * L), 0, 1);
        if (Math.hypot(o.p.x + dx * u - e.p.x, o.p.z + dz * u - e.p.z) < 1) blk = 1;
      }
      const sc = free + dz * f * 0.15;
      if (!blk && sc > bs) { bs = sc; best = q; }
    }
    if (!best) return false;
    const dx = best.p.x + best.v.x * 0.4 - b.p.x, dz = best.p.z + best.v.z * 0.4 - b.p.z, L = Math.hypot(dx, dz) || 1, s = Math.min(24, 9 + L * 0.9);
    b.v.x = dx / L * s; b.v.y = 0.8; b.v.z = dz / L * s; b.ct = 0; o.cd = 0.7; o.hold = 0; o.a = Math.atan2(dx, dz);
    return true;
  }

  ai(o, ch, dt) {
    const b = this.b, P = this.P, D = AI_DIFF;
    const dz2 = o.t ? 1 : -1, own = -dz2 * HZ, opp = dz2 * HZ, d = Math.hypot(b.p.x - o.p.x, b.p.z - o.p.z), isCh = o === ch[o.t];
    let tx, tz, sp2 = this.aiRun(o, 'run');
    if (!isCh || d > 2.2) o.hold = 0;
    if (o.role === 'gk') {
      // Thủ môn: dự đoán điểm bóng cắt vạch rồi lao tới (có độ trễ + sai số)
      const gl = own + dz2, vt = -b.v.z * dz2;
      let px = b.p.x * 0.6, run = 1;
      sp2 = this.aiRun(o, 'gk');
      if (vt > 3) {
        const tt = (gl - b.p.z) / b.v.z;
        if (tt > 0 && tt < 1.6) { if (!o.gn) o.gn = (Math.random() - 0.5) * 2 * (1.1 - 0.7 * D); px = clamp(b.p.x + b.v.x * tt + o.gn, -3.8, 3.8); if (tt < 0.5) run = 1.1; }
      } else o.gn = 0;
      o.gx += (px - o.gx) * (1 - Math.exp(-(4.5 + 5 * D) * dt));
      tx = clamp(o.gx, -3.8, 3.8); tz = gl; sp2 *= run;
      if (d < 5 && Math.abs(b.p.z - own) < 8 && vt <= 3) { tx = b.p.x; tz = b.p.z; }
    } else if (isCh) {
      sp2 = this.aiRun(o, 'chase');
      const lead = Math.min(0.55, d / sp2 * 0.9);
      tx = b.p.x + b.v.x * lead; tz = b.p.z + b.v.z * lead;
      // bóng sau lưng: vòng ra sau bóng rồi mới chạm
      const bk = (b.p.z - o.p.z) * dz2 < -0.3 && b.v.z * dz2 < 4 && d < 4.5;
      if (bk) {
        let sd = Math.abs(b.p.x - o.p.x) > 0.3 ? Math.sign(o.p.x - b.p.x) : (o.p.x > 0 ? 1 : -1);
        if (Math.abs(b.p.x + sd * 2.2) > HX - 1) sd = -sd;
        tx = clamp(b.p.x + sd * 2.2, -HX + 1, HX - 1); tz = b.p.z - dz2 * 1.2;
      }
      if ((b.p.z - o.p.z) * dz2 > -0.4 && d > 0.9 && d < 2.2 && Math.random() < (0.007 + 0.01 * D)) this.slide(o, b.p.x - o.p.x, b.p.z - o.p.z);
      if (b.p.y > 1.4 && d < 2.5 && o.p.y <= 0 && Math.random() < 0.08) o.vy = 7.2;
      if (!bk && d < 1.3 && b.p.y < 1.6) {
        const L0 = Math.hypot(b.p.x, opp - b.p.z);
        if (!o.hold) o.pw = Math.random();
        o.hold += dt;
        if (L0 < 17 + 9 * D) {
          const spd = this.aiSpd(o, L0), pl = this.aiPlan(o, spd);
          const press = P.some(q => q.t !== o.t && q.role !== 'gk' && Math.hypot(q.p.x - o.p.x, q.p.z - o.p.z) < 2.4);
          const need = (L0 < 9 ? -0.2 : L0 < 16 ? 0.15 : 0.45) - (press ? 0.4 : 0);
          if (o.cd <= 0 && o.hold > 0.3 - 0.2 * D && (pl.sc > need || o.hold > 1.6 || L0 < 4)) this.aiShoot(o, pl, spd);
          else if (press && L0 > 9 && o.cd <= 0 && o.hold > 0.25 && this.aiPass(o)) { /* đã chuyền */ }
          else { tx = o.p.x * 0.55 + pl.tx * 0.5; tz = opp; sp2 = this.aiRun(o, 'carry'); }
        } else { tx = o.p.x * 0.6; tz = opp; sp2 = this.aiRun(o, 'carry'); }
      }
    } else {
      const db = (b.p.z - own) * dz2;
      tz = own + dz2 * clamp(o.sd + (db - HZ) * 0.6, 3, HZ * 2 - 3);
      tx = clamp(o.sx + b.p.x * 0.3, -HX + 1.5, HX - 1.5);
    }
    const ex = tx - o.p.x, ez = tz - o.p.z, dd = Math.hypot(ex, ez) || 1, s = Math.min(sp2, dd * 3);
    this.move(o, ex / dd * s, ez / dd * s, dt, o.role === 'gk' ? 11 : 7 + 3 * D);
    if (Math.hypot(o.v.x, o.v.z) > 0.6) o.a = ang(o.a, Math.atan2(o.v.x, o.v.z), 1 - Math.exp(-10 * dt));
  }

  // ------------------------------------------------------- ảnh chụp trạng thái
  snapshot() {
    const b = this.b;
    return {
      players: this.P.map(o => [
        r2(o.p.x), r2(o.p.y), r2(o.p.z), r2(o.a), r2(o.v.x), r2(o.vy), r2(o.v.z), r2(o.stamina),
        r2(Math.max(0, o.sl)), r2(Math.max(0, o.stun)), r2(Math.max(0, o.cd)), r2(o.skBoost), r2(o.skMainCd),
        o.i === 0 || o.i === 5 ? o.charIndex : -1
      ]),
      ball: [r2(b.p.x), r2(b.p.y), r2(b.p.z), r2(b.v.x), r2(b.v.y), r2(b.v.z), r2(b.cv), r2(b.ct), r2(b.knuckle)],
      score: [this.s0, this.s1], time: r2(this.tl), phase: this.ph
    };
  }
}

// ============================================================================
//  PHỤC VỤ FILE GAME (HTTP)
// ============================================================================
let page = null;                       // { file, mtime, raw, etag, gz, br }
function findGameFile() {
  if (process.env.GAME_FILE) { const f = path.resolve(__dirname, process.env.GAME_FILE); if (fs.existsSync(f)) return f; }
  const idx = path.join(__dirname, 'index.html');
  if (fs.existsSync(idx)) return idx;
  let list = [];
  try { list = fs.readdirSync(__dirname).filter(n => /\.html?$/i.test(n)); } catch (_) { }
  if (!list.length) return null;
  list.sort((a, b) => (/ego|futsal/i.test(b) ? 1 : 0) - (/ego|futsal/i.test(a) ? 1 : 0) || a.localeCompare(b));
  return path.join(__dirname, list[0]);
}
function loadPage() {
  const file = findGameFile();
  if (!file) { page = null; return null; }
  let st; try { st = fs.statSync(file); } catch (_) { page = null; return null; }
  if (page && page.file === file && page.mtime === st.mtimeMs) return page;
  const raw = fs.readFileSync(file);
  const cur = page = { file, mtime: st.mtimeMs, raw, etag: '"' + raw.length.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"', gz: null, br: null };
  log('Phục vụ file game:', path.basename(file), '(' + (raw.length / 1048576).toFixed(2) + ' MB)');
  zlib.gzip(raw, { level: 9 }, (e, out) => { if (!e && page === cur) cur.gz = out; });
  zlib.brotliCompress(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }, (e, out) => { if (!e && page === cur) cur.br = out; });
  return cur;
}

const stats = { started: Date.now(), matchesPlayed: 0 };
function handleHttp(req, res) {
  const url = (req.url || '/').split('?')[0];
  const base = { 'X-Content-Type-Options': 'nosniff' };
  if (url === '/health' || url === '/healthz') {
    res.writeHead(200, { ...base, 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); return res.end('ok');
  }
  if (url === '/status') {
    res.writeHead(200, { ...base, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, uptime: Math.round((Date.now() - stats.started) / 1000), hub: hub.size, queue: queue.length, matches: matches.size, matchesPlayed: stats.matchesPlayed }));
  }
  if (url === '/favicon.ico') { res.writeHead(204, base); return res.end(); }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, base); return res.end(); }
  if (url === '/' || url === '/index.html' || /\.html?$/i.test(url)) {
    const pg = loadPage();
    if (!pg) {
      res.writeHead(500, { ...base, 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Chưa tìm thấy file game .html. Hãy đặt file game cạnh server.js (nên đặt tên index.html).');
    }
    if (req.headers['if-none-match'] === pg.etag) { res.writeHead(304, { ...base, ETag: pg.etag }); return res.end(); }
    const ae = String(req.headers['accept-encoding'] || '');
    let body = pg.raw, enc = null;
    if (pg.br && /\bbr\b/.test(ae)) { body = pg.br; enc = 'br'; }
    else if (pg.gz && /\bgzip\b/.test(ae)) { body = pg.gz; enc = 'gzip'; }
    const h = { ...base, 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, ETag: pg.etag, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' };
    if (enc) h['Content-Encoding'] = enc;
    res.writeHead(200, h);
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
  res.writeHead(404, { ...base, 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

// ============================================================================
//  SẢNH (HUB) · HÀNG CHỜ · TRẬN ĐẤU
// ============================================================================
const hub = new Map();        // id -> người trong sảnh
const queue = [];             // hàng chờ ghép cặp (người trong sảnh)
const matches = new Map();    // matchId -> trận
let wss = null;

function send(ws, obj) {
  if (!ws || ws.readyState !== 1) return false;
  try { ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); return true; } catch (_) { return false; }
}
function cleanName(n) {
  const s = String(n == null ? '' : n).replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, 18);
  return s || 'EGO PLAYER';
}
const pubPlayer = p => ({ id: p.id, name: p.name, sel: p.sel, x: p.x, z: p.z, a: p.a, moving: p.moving });

// ----------------------------------------------------------------- Sảnh
function hubJoin(ws, m) {
  if (ws.ctx.kind) return;
  if (hub.size >= HUB_MAX) { send(ws, { t: 'queueError', message: 'Sảnh đang đầy, thử lại sau ít phút.' }); ws.close(1013, 'hub full'); return; }
  const p = {
    id: rid(4), ws, name: cleanName(m.name), sel: clamp(num(m.sel) | 0, 0, 5),
    x: clamp(num(m.x), -28, 28), z: clamp(num(m.z, 19.2), -28, 28), a: num(m.a), moving: false, dirty: false, inQueue: false
  };
  ws.ctx = { kind: 'hub', player: p };
  hub.set(p.id, p);
  send(ws, { t: 'hubWelcome', id: p.id, count: hub.size, players: [...hub.values()].filter(q => q !== p).map(pubPlayer) });
  hubBroadcast({ t: 'hubEnter', player: pubPlayer(p), count: hub.size }, p);
}
function hubPose(ws, m) {
  const p = ws.ctx.player; if (ws.ctx.kind !== 'hub' || !p) return;
  p.x = clamp(num(m.x, p.x), -28, 28); p.z = clamp(num(m.z, p.z), -28, 28); p.a = num(m.a, p.a);
  p.moving = !!m.moving; if (m.sel != null) p.sel = clamp(num(m.sel) | 0, 0, 5);
  p.dirty = true;
}
function hubBroadcast(obj, except) {
  const s = JSON.stringify(obj);
  for (const q of hub.values()) if (q !== except) send(q.ws, s);
}
function hubRemove(p) {
  if (!p || !hub.has(p.id)) return;
  hub.delete(p.id);
  queueRemove(p);
  hubBroadcast({ t: 'hubExit', id: p.id, count: hub.size });
}
// gửi vị trí gom lại ~10 lần/giây (giảm tải khi nhiều người trong sảnh)
function hubFlush() {
  if (hub.size < 2) { for (const p of hub.values()) p.dirty = false; return; }
  for (const p of hub.values()) {
    if (!p.dirty) continue;
    p.dirty = false;
    hubBroadcast({ t: 'hubPose', player: { id: p.id, x: p.x, z: p.z, a: p.a, moving: p.moving, sel: p.sel } }, p);
  }
}

// -------------------------------------------------------------- Hàng chờ
function queueRemove(p) { const i = queue.indexOf(p); if (i >= 0) queue.splice(i, 1); if (p) p.inQueue = false; }
function queueJoin(ws) {
  const p = ws.ctx.player;
  if (ws.ctx.kind !== 'hub' || !p) { send(ws, { t: 'queueError', message: 'Hãy kết nối vào sảnh trước.' }); return; }
  if (!p.inQueue) { queue.push(p); p.inQueue = true; }
  tryMatch();
  if (p.inQueue) send(ws, { t: 'queueStatus', position: queue.indexOf(p) + 1 });
}
function queueCancel(ws) {
  const p = ws.ctx.player; if (!p) return;
  const was = p.inQueue; queueRemove(p);
  if (was) send(ws, { t: 'queueCancelled' });
}
function tryMatch() {
  while (queue.length >= 2) {
    if (matches.size >= MATCH_MAX) {
      for (const q of queue) { send(q.ws, { t: 'queueError', message: 'Máy chủ đang đầy trận, thử lại sau ít phút.' }); q.inQueue = false; }
      queue.length = 0; return;
    }
    const a = queue.shift(), b = queue.shift();
    a.inQueue = b.inQueue = false;
    if (!a.ws || a.ws.readyState !== 1) { if (b.ws && b.ws.readyState === 1) queue.unshift(b); continue; }
    if (!b.ws || b.ws.readyState !== 1) { queue.unshift(a); continue; }
    createMatch(a, b);
  }
}

// ----------------------------------------------------------------- Trận
function createMatch(a, b) {
  const id = rid(6), tokens = [rid(12), rid(12)];
  const players = [{ sel: a.sel, name: a.name }, { sel: b.sel, name: b.name }];
  const mt = { id, tokens, players, sockets: [null, null], sim: null, acc: 0, steps: 0, createdAt: Date.now(), startedAt: 0, endedAt: 0, closing: false, joinTimer: null };
  mt.joinTimer = setTimeout(() => {
    if (mt.sim) return;
    mt.sockets.forEach(s => s && send(s, { t: 'matchError', message: 'Đối thủ không kết nối được vào trận. Hãy tìm trận lại.' }));
    destroyMatch(mt, 'join timeout');
  }, JOIN_TIMEOUT_MS);
  matches.set(id, mt);
  log('Ghép cặp:', a.name, 'vs', b.name, '→ trận', id);
  send(a.ws, { t: 'queueFound', matchId: id, token: tokens[0], slot: 0, players });
  send(b.ws, { t: 'queueFound', matchId: id, token: tokens[1], slot: 1, players });
  hubRemove(a); hubRemove(b);   // 2 người rời sảnh để "dịch chuyển" sang sân
}
function tokenOk(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function matchError(ws, message) { send(ws, { t: 'matchError', message }); }
function matchJoin(ws, m) {
  if (ws.ctx.kind) return;
  const mt = matches.get(String(m.matchId || ''));
  if (!mt || mt.closing) return matchError(ws, 'Trận đấu không tồn tại hoặc đã kết thúc.');
  let slot = -1;
  for (let i = 0; i < 2; i++) if (tokenOk(mt.tokens[i], m.token || '')) slot = i;
  if (slot < 0) return matchError(ws, 'Mã trận không hợp lệ.');
  if (mt.sockets[slot] && mt.sockets[slot] !== ws && mt.sockets[slot].readyState === 1) return matchError(ws, 'Slot này đã có người kết nối.');
  ws.ctx = { kind: 'match', match: mt, slot };
  mt.sockets[slot] = ws;
  send(ws, { t: 'matchWelcome', slot });
  if (mt.sim) {   // vào lại giữa trận
    mt.sim.setHuman(slot, true);
    send(ws, { t: 'matchStart', players: mt.players, state: mt.sim.snapshot() });
    return;
  }
  if (!mt.sockets[0] || !mt.sockets[1]) { send(ws, { t: 'matchWaiting', message: 'Đang chờ đối thủ kết nối...' }); return; }
  startMatch(mt);
}
function startMatch(mt) {
  clearTimeout(mt.joinTimer);
  mt.sim = new Sim(mt.players);
  mt.startedAt = Date.now(); mt.lastTick = performance.now();
  const msg = JSON.stringify({ t: 'matchStart', players: mt.players, state: mt.sim.snapshot() });
  mt.sockets.forEach(s => send(s, msg));
  log('Bắt đầu trận', mt.id, '·', mt.players[0].name, 'vs', mt.players[1].name);
}
function matchInput(ws, m) {
  const c = ws.ctx; if (c.kind !== 'match' || !c.match.sim) return;
  const y = Number(m.y); if (!Number.isFinite(y)) return;
  c.match.sim.setInput(c.slot, num(m.k) | 0, y);
}
function matchAction(ws, m) {
  const c = ws.ctx; if (c.kind !== 'match' || !c.match.sim) return;
  c.match.sim.action(c.slot, m);
}
function matchLeave(ws) {
  const c = ws.ctx; if (c.kind !== 'match') return;
  const mt = c.match, slot = c.slot;
  ws.ctx = { kind: 'gone' };
  if (mt.sockets[slot] === ws) mt.sockets[slot] = null;
  if (mt.sim) mt.sim.setHuman(slot, false);          // NPC thay thế người vừa rời
  const other = mt.sockets[1 - slot];
  if (other && other.readyState === 1) {
    if (mt.sim && mt.sim.ph !== 'end') send(other, { t: 'matchOpponentLeft', message: 'Đối thủ đã rời trận. Máy sẽ thay thế đối thủ.' });
    else if (!mt.sim) { matchError(other, 'Đối thủ đã rời trước khi trận bắt đầu. Hãy tìm trận lại.'); destroyMatch(mt, 'left before start'); return; }
  }
  if (!mt.sockets[0] && !mt.sockets[1]) destroyMatch(mt, 'empty');
}
function destroyMatch(mt, why) {
  if (mt.closing) return;
  mt.closing = true; clearTimeout(mt.joinTimer);
  if (matches.get(mt.id) === mt) matches.delete(mt.id);
  if (mt.sim) { stats.matchesPlayed++; log('Kết thúc trận', mt.id, '(' + why + ')', mt.sim.s0 + '-' + mt.sim.s1); }
  mt.sockets.forEach(s => { if (s && s.readyState === 1) { s.ctx = { kind: 'gone' }; try { s.close(1000, 'match closed'); } catch (_) { } } });
}

// -------------------------------------------------- vòng lặp mô phỏng chung
const DT = 1 / SIM_HZ, NET_EVERY = Math.max(1, Math.round(SIM_HZ / NET_HZ));
function simLoop() {
  const now = performance.now();
  for (const mt of matches.values()) {
    if (!mt.sim || mt.closing) continue;
    mt.acc += Math.min(0.1, (now - mt.lastTick) / 1000); mt.lastTick = now;
    let sent = false, n = 0;
    while (mt.acc >= DT && n++ < 6) {
      mt.sim.step(DT); mt.acc -= DT; mt.steps++;
      if (mt.steps % NET_EVERY === 0) sent = true;
    }
    if (n >= 6) mt.acc = 0;
    if (mt.sim.ph === 'end') {            // hết giờ: gửi kết quả ngay 1 lần, sau đó chỉ nhắc thưa (~4 gói/giây)
      if (!mt.endedAt) { mt.endedAt = Date.now(); sent = true; log('Hết giờ trận', mt.id, mt.sim.s0 + '-' + mt.sim.s1); }
      else sent = sent && mt.steps % (NET_EVERY * 8) < NET_EVERY;
    }
    if (sent) {
      const msg = JSON.stringify({ t: 'matchState', ...mt.sim.snapshot() });
      for (const s of mt.sockets) if (s && s.bufferedAmount < 262144) send(s, msg);
    }
    if (mt.endedAt && Date.now() - mt.endedAt > END_KEEP_MS) destroyMatch(mt, 'finished');
    else if (Date.now() - mt.startedAt > MATCH_MAX_MS) destroyMatch(mt, 'max duration');
  }
}

// ----------------------------------------------------------------- Dọn dẹp
function cleanup(ws) {
  const c = ws.ctx || {};
  if (c.kind === 'hub') hubRemove(c.player);
  else if (c.kind === 'match') matchLeave(ws);
}

// ============================================================================
//  KHỞI ĐỘNG
// ============================================================================
function start() {
  const WS = require('ws');
  const WebSocketServer = WS.WebSocketServer || WS.Server;
  const server = http.createServer(handleHttp);
  wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 16 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try { pathname = new URL(req.url, 'http://x').pathname; } catch (_) { }
    if (pathname !== '/ws') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });

  wss.on('connection', ws => {
    ws.ctx = { kind: null }; ws.isAlive = true; ws.msgs = 0; ws.lastMsg = Date.now();
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      ws.lastMsg = Date.now();
      if (++ws.msgs > 240) { if (ws.msgs > 3000) ws.terminate(); return; }   // chống spam
      let m; try { m = JSON.parse(data.toString()); } catch (_) { return; }
      if (!m || typeof m.t !== 'string') return;
      switch (m.t) {
        case 'hubJoin': return hubJoin(ws, m);
        case 'hubPose': return hubPose(ws, m);
        case 'hubBeat': return;
        case 'hubLeave': { cleanup(ws); ws.ctx = { kind: 'gone' }; return; }
        case 'queueJoin': return queueJoin(ws);
        case 'queueCancel': return queueCancel(ws);
        case 'matchJoin': return matchJoin(ws, m);
        case 'matchInput': return matchInput(ws, m);
        case 'matchAction': return matchAction(ws, m);
        case 'matchLeave': return matchLeave(ws);
        default: return;
      }
    });
    ws.on('close', () => cleanup(ws));
    ws.on('error', () => { });
    // client không gửi gói đầu tiên hợp lệ trong 15 giây thì đóng
    setTimeout(() => { if (ws.readyState === 1 && !ws.ctx.kind) ws.close(4000, 'no handshake'); }, 15000).unref();
  });

  setInterval(simLoop, 1000 / SIM_HZ);
  setInterval(hubFlush, 100);
  setInterval(() => { for (const ws of wss.clients) ws.msgs = 0; }, 1000);
  setInterval(() => {                      // giữ kết nối sống & dọn kết nối chết
    const now = Date.now();
    for (const ws of wss.clients) {
      if (!ws.isAlive || (ws.ctx && ws.ctx.kind === 'hub' && now - ws.lastMsg > 60000)) { ws.terminate(); continue; }
      ws.isAlive = false; try { ws.ping(); } catch (_) { }
    }
  }, 20000);

  server.listen(PORT, '0.0.0.0', () => {
    log('Ego Futsal server chạy tại cổng', PORT, '· mô phỏng', SIM_HZ + 'Hz · gửi trạng thái', Math.round(SIM_HZ / NET_EVERY) + 'Hz');
    if (!loadPage()) log('CẢNH BÁO: chưa thấy file game .html cạnh server.js');
  });

  const shutdown = sig => {
    log('Nhận', sig, '— đang tắt server...');
    for (const mt of [...matches.values()]) { mt.sockets.forEach(s => s && send(s, { t: 'matchError', message: 'Máy chủ đang khởi động lại. Hãy tìm trận lại sau ít giây.' })); destroyMatch(mt, 'shutdown'); }
    for (const ws of wss.clients) { try { ws.close(1001, 'server restart'); } catch (_) { } }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', e => log('Lỗi chưa bắt:', e && e.stack || e));
  process.on('unhandledRejection', e => log('Promise bị từ chối:', e && e.stack || e));
  return server;
}

if (require.main === module) start();
module.exports = { Sim, start };
