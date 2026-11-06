#!/usr/bin/env node
// 从 24 位 BMP 里裁一块并放大，用于核对小尺寸 UI 细节
// 用法: node crop-bmp.js in.bmp out.bmp x y w h [scale]
const fs = require('fs');

const [inp, outp, xs, ys, ws, hs, ss] = process.argv.slice(2);
const X = +xs, Y = +ys, W = +ws, H = +hs, S = +(ss || 3);

const buf = fs.readFileSync(inp);
const dataOff = buf.readUInt32LE(10);
const width = buf.readInt32LE(18);
const height = buf.readInt32LE(22);
const bpp = buf.readUInt16LE(28);
if (bpp !== 24) { console.error('只支持 24 位 BMP，当前', bpp); process.exit(1); }
const rowSize = Math.floor((24 * width + 31) / 32) * 4;

const outW = W * S, outH = H * S;
const outRow = Math.floor((24 * outW + 31) / 32) * 4;
const body = Buffer.alloc(outRow * outH);

for (let y = 0; y < outH; y++) {
  const srcY = height - 1 - (Y + Math.floor(y / S));   // BMP 自下而上
  for (let x = 0; x < outW; x++) {
    const srcX = X + Math.floor(x / S);
    const s = dataOff + srcY * rowSize + srcX * 3;
    const d = (outH - 1 - y) * outRow + x * 3;
    body[d] = buf[s]; body[d + 1] = buf[s + 1]; body[d + 2] = buf[s + 2];
  }
}

const header = Buffer.alloc(54);
header.write('BM', 0, 'ascii');
header.writeUInt32LE(54 + body.length, 2);
header.writeUInt32LE(54, 10);
header.writeUInt32LE(40, 14);
header.writeInt32LE(outW, 18);
header.writeInt32LE(outH, 22);
header.writeUInt16LE(1, 26);
header.writeUInt16LE(24, 28);
header.writeUInt32LE(body.length, 34);
fs.writeFileSync(outp, Buffer.concat([header, body]));
console.log(`${outp}  ${outW}x${outH}`);
