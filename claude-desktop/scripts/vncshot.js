#!/usr/bin/env node
/**
 * 极简 VNC 客户端：连上 RFB，抓一帧，存成 BMP。
 * 用途：本地没有 X 工具时，验证容器桌面到底显示了什么。
 * 用法: node vncshot.js <out.bmp> [host] [port]
 */
const net = require('net');
const fs = require('fs');

const OUT = process.argv[2] || '/tmp/shot.bmp';
const HOST = process.argv[3] || '127.0.0.1';
const PORT = parseInt(process.argv[4], 10) || 5901;

const sock = net.connect(PORT, HOST);
let buf = Buffer.alloc(0);
let state = 'version';
let W = 0, H = 0, bpp = 4;
const rects = [];
let rectsLeft = 0;
const timeout = setTimeout(() => { console.error('超时'); process.exit(2); }, 20000);

function send(b) { sock.write(b); }
function str(s) { return Buffer.from(s, 'binary'); }

sock.on('connect', () => console.error('[vnc] 已连接'));
sock.on('error', (e) => { console.error('[vnc] 错误:', e.message); process.exit(1); });

sock.on('data', (chunk) => {
  if (process.env.DEBUG_RAW) {
    console.error(`[raw] chunk=${chunk.length} head=${chunk.slice(0, 48).toString('hex')} ascii=${JSON.stringify(chunk.slice(0, 48).toString('latin1'))}`);
  }
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    if (state === 'version') {
      if (buf.length < 12) return;
      const v = buf.slice(0, 12).toString();
      buf = buf.slice(12);
      console.error('[vnc] 服务端版本', v.trim());
      send(str('RFB 003.008\n'));
      state = 'sec-types';
      continue;
    }
    if (state === 'sec-types') {
      if (buf.length < 1) return;
      const n = buf[0];
      if (buf.length < 1 + n) return;
      const types = [...buf.slice(1, 1 + n)];
      buf = buf.slice(1 + n);
      console.error('[vnc] 认证方式', types);
      if (!types.includes(1)) { console.error('不支持 None 认证'); process.exit(1); }
      send(Buffer.from([1]));
      state = 'sec-result';
      continue;
    }
    if (state === 'sec-result') {
      if (buf.length < 4) return;
      buf = buf.slice(4);
      send(Buffer.from([1]));                       // ClientInit: shared
      state = 'server-init';
      continue;
    }
    if (state === 'server-init') {
      if (buf.length < 26) return;
      W = buf.readUInt16BE(0);
      H = buf.readUInt16BE(2);
      // 标准里 nameLen 在偏移 20，但 Xtigervnc 实测多 2 字节（偏移 22）。
      // 按「名字非空且可打印 + 之后紧跟合法消息类型」优先匹配，空名字只作兜底。
      let pick = null, fallback = null;
      for (const off of [22, 20, 24, 18, 26]) {
        if (buf.length < off + 2) continue;
        const nl = buf.readUInt16BE(off);
        const end = off + 2 + nl;
        if (nl > 200 || end > buf.length) continue;
        const nm = buf.slice(off + 2, end).toString('latin1');
        const printable = nl === 0 || /^[\x20-\x7e]+$/.test(nm);
        const nextOk = buf.length <= end || [0, 1, 2, 3].includes(buf[end]);
        if (!printable || !nextOk) continue;
        if (nl > 0) { pick = { nl, nm, end, off }; break; }
        if (!fallback) fallback = { nl, nm, end, off };
      }
      pick = pick || fallback;
      if (!pick) {
        console.error('[vnc] ServerInit 解析失败，前 40 字节:', buf.slice(0, 40).toString('hex'));
        process.exit(1);
      }
      buf = buf.slice(pick.end);
      console.error(`[vnc] 桌面 ${W}x${H} "${pick.nm}"（名长偏移 ${pick.off}）`);
      // SetPixelFormat: 32bpp / depth24 / little-endian / truecolor, r<<16 g<<8 b
      const pf = Buffer.from([0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]);
      send(pf);
      // SetEncodings: 仅 Raw(0)
      send(Buffer.from([2, 0, 0, 1, 0, 0, 0, 0]));
      // FramebufferUpdateRequest: 非增量，全屏
      const req = Buffer.alloc(10);
      req[0] = 3;
      req.writeUInt16BE(0, 2); req.writeUInt16BE(0, 4);
      req.writeUInt16BE(W, 6); req.writeUInt16BE(H, 8);
      send(req);
      state = 'update-header';
      continue;
    }
    if (state === 'update-header') {
      if (buf.length < 1) return;
      if (buf[0] === 1) {                            // SetColourMapEntries
        if (buf.length < 6) return;
        const n = buf.readUInt16BE(4);
        if (buf.length < 6 + n * 6) return;
        buf = buf.slice(6 + n * 6);
        continue;
      }
      if (buf[0] !== 0) {                            // 其它消息，安全跳过
        console.error('[vnc] 收到未知消息类型', buf[0], '前 32 字节:', buf.slice(0, 32).toString('hex'));
        process.exit(1);
      }
      if (buf.length < 4) return;
      rectsLeft = buf.readUInt16BE(2);
      console.error(`[vnc] FramebufferUpdate, 块数=${rectsLeft}, 头=${buf.slice(0, 12).toString('hex')}`);
      buf = buf.slice(4);
      state = 'rect-header';
      continue;
    }
    if (state === 'rect-header') {
      if (rectsLeft === 0) { state = 'done'; continue; }
      if (buf.length < 12) return;
      const x = buf.readUInt16BE(0), y = buf.readUInt16BE(2);
      const w = buf.readUInt16BE(4), h = buf.readUInt16BE(6);
      const enc = buf.readInt32BE(8);
      buf = buf.slice(12);
      if (enc !== 0) { console.error('[vnc] 非 Raw 编码', enc); process.exit(1); }
      rects.push({ x, y, w, h, need: w * h * bpp, got: 0, parts: [] });
      state = 'rect-data';
      continue;
    }
    if (state === 'rect-data') {
      const r = rects[rects.length - 1];
      const remain = r.need - r.got;
      if (buf.length < remain) {
        // 像素数据会被 TCP 分片，必须累计而不是整块判断
        r.parts.push(buf);
        r.got += buf.length;
        buf = Buffer.alloc(0);
        return;
      }
      r.parts.push(buf.slice(0, remain));
      r.data = Buffer.concat(r.parts);
      buf = buf.slice(remain);
      rectsLeft--;
      state = 'rect-header';
      continue;
    }
    if (state === 'done') break;
  }
  if (state === 'done') finish();
});

function finish() {
  clearTimeout(timeout);
  // 画布 + 贴图（源为 BGRX 小端）
  const canvas = Buffer.alloc(W * H * 4);
  for (const r of rects) {
    for (let row = 0; row < r.h; row++) {
      const s = row * r.w * 4;
      const d = ((r.y + row) * W + r.x) * 4;
      r.data.copy(canvas, d, s, s + r.w * 4);
    }
  }
  // BMP 24 位，行序自下而上，每行 4 字节对齐
  const rowSize = Math.floor((24 * W + 31) / 32) * 4;
  const pixelBytes = rowSize * H;
  const header = Buffer.alloc(54);
  header.write('BM', 0, 'ascii');
  header.writeUInt32LE(54 + pixelBytes, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(W, 18);
  header.writeInt32LE(H, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(pixelBytes, 34);
  const body = Buffer.alloc(pixelBytes);
  for (let y = 0; y < H; y++) {
    const srcY = H - 1 - y;
    for (let x = 0; x < W; x++) {
      const s = (srcY * W + x) * 4;
      const d = y * rowSize + x * 3;
      body[d] = canvas[s];         // B
      body[d + 1] = canvas[s + 1]; // G
      body[d + 2] = canvas[s + 2]; // R
    }
  }
  fs.writeFileSync(OUT, Buffer.concat([header, body]));
  console.error(`[vnc] 已保存 ${OUT}（${W}x${H}, ${rects.length} 个块）`);
  process.exit(0);
}
