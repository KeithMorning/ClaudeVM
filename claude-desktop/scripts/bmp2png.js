#!/usr/bin/env node
// 24 位 BMP -> PNG（无依赖，用 zlib 手写）
// 用法: node bmp2png.js in.bmp out.png
const fs = require('fs');
const zlib = require('zlib');

const [inp, outp] = process.argv.slice(2);
const buf = fs.readFileSync(inp);
const off = buf.readUInt32LE(10);
const W = buf.readInt32LE(18);
const H = Math.abs(buf.readInt32LE(22));
const bpp = buf.readUInt16LE(28);
if (bpp !== 24) { console.error('仅支持 24 位 BMP'); process.exit(1); }
const rowSize = Math.floor((24 * W + 31) / 32) * 4;

// 原始扫描线：每行 1 字节 filter(0) + RGB
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) {
  const srcY = H - 1 - y;
  const d = y * (W * 3 + 1);
  raw[d] = 0;
  for (let x = 0; x < W; x++) {
    const s = off + srcY * rowSize + x * 3;
    raw[d + 1 + x * 3] = buf[s + 2];      // R
    raw[d + 2 + x * 3] = buf[s + 1];      // G
    raw[d + 3 + x * 3] = buf[s];          // B
  }
}

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(b) {
  let c = -1;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

fs.writeFileSync(outp, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]));
console.log(`${outp}  ${W}x${H}`);
