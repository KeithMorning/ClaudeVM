#!/usr/bin/env node
/**
 * 桌面美术资源生成器（无外部依赖，纯 JS 光栅化 + PNG 编码）
 *
 *   node gen-art.js wallpaper <out.png> [w] [h]
 *   node gen-art.js icons     <outdir>  [size]
 *
 * 为什么自己画：
 *   镜像里没有任何图片编解码库（不装 imagemagick / python-pil 是为了瘦身），
 *   而桌面观感全靠壁纸和图标。这里用 SDF + 超采样做抗锯齿，输出 8bit PNG。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------------------------------- PNG ---------------------------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** RGBA8 → PNG buffer */
function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------- 光栅画布 -------------------------------- */

class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.buf = Buffer.alloc(w * h * 4); // 透明起始
  }

  /** 以覆盖率 a(0..1) 把不透明色叠到 (x,y) 上（非预乘 alpha） */
  blend(x, y, r, g, b, a) {
    if (a <= 0 || x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const o = (y * this.w + x) * 4;
    const da = this.buf[o + 3] / 255;
    const na = a + da * (1 - a);
    if (na <= 0) return;
    this.buf[o] = Math.round((r * a + this.buf[o] * da * (1 - a)) / na);
    this.buf[o + 1] = Math.round((g * a + this.buf[o + 1] * da * (1 - a)) / na);
    this.buf[o + 2] = Math.round((b * a + this.buf[o + 2] * da * (1 - a)) / na);
    this.buf[o + 3] = Math.round(na * 255);
  }

  /** 用 SDF 填充：sd(x,y) < 0 为内部；超采样 3x3 抗锯齿 */
  fill(sd, color, alpha = 1) {
    const { r, g, b } = color;
    const S = 3;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        let cov = 0;
        for (let sy = 0; sy < S; sy++) {
          for (let sx = 0; sx < S; sx++) {
            const px = x + (sx + 0.5) / S;
            const py = y + (sy + 0.5) / S;
            if (sd(px, py) <= 0) cov++;
          }
        }
        if (cov) this.blend(x, y, r, g, b, (cov / (S * S)) * alpha);
      }
    }
  }
}

/* ------------------------------- SDF 图元 -------------------------------- */

const sdCircle = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r;
const sdRing = (cx, cy, r, t) => (x, y) => Math.abs(Math.hypot(x - cx, y - cy) - r) - t / 2;

const sdCapsule = (x0, y0, x1, y1, t) => {
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy || 1;
  return (x, y) => {
    let u = ((x - x0) * dx + (y - y0) * dy) / len2;
    u = Math.max(0, Math.min(1, u));
    return Math.hypot(x - (x0 + u * dx), y - (y0 + u * dy)) - t / 2;
  };
};

const sdRoundRect = (cx, cy, hw, hh, r) => (x, y) => {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
};

/** 椭圆环（球面经线）：把点按半轴归一化后取到单位圆的距离 */
const sdEllipseRing = (cx, cy, a, b, t) => (x, y) => {
  const u = (x - cx) / a, v = (y - cy) / b;
  const d = Math.hypot(u, v) - 1;
  const scale = Math.min(a, b);
  return Math.abs(d) * scale - t / 2;
};

/* -------------------------------- 壁纸 ----------------------------------- */

function wallpaper(out, W, H) {
  const c = new Canvas(W, H);
  // 背景：自上而下的深色渐变（近黑 → 石墨蓝）
  const top = [7, 9, 14], bot = [13, 16, 24];
  const glows = [
    // [cx%, cy%, 半径px, 颜色, 强度]
    [0.88, 0.92, H * 0.62, [217, 119, 87], 0.85],  // 右下：Claude 橙余烬
    [0.08, 0.04, H * 0.75, [96, 118, 220], 0.30],  // 左上：冷靛蓝
  ];
  const bay = [0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240];
  const bayer = (x, y) => (bay[(y & 3) * 4 + (x & 3)] / 256 - 0.5);

  for (let y = 0; y < H; y++) {
    const t = y / (H - 1);
    for (let x = 0; x < W; x++) {
      let r = top[0] + (bot[0] - top[0]) * t;
      let g = top[1] + (bot[1] - top[1]) * t;
      let b = top[2] + (bot[2] - top[2]) * t;

      for (const [gx, gy, rad, col, amp] of glows) {
        const d = Math.hypot(x - gx * W, y - gy * H) / rad;
        const f = Math.exp(-d * d * 2.6) * amp;
        r += col[0] * f; g += col[1] * f; b += col[2] * f;
      }

      // 轻微暗角，让四角沉下去
      const vx = (x / W - 0.5) * 2, vy = (y / H - 0.5) * 2;
      const vig = 1 - 0.28 * Math.pow(Math.min(1, Math.hypot(vx, vy) / 1.35), 2.2);
      r *= vig; g *= vig; b *= vig;

      // 抖动：8bit 渐变不加就一圈一圈的色带
      const dth = bayer(x, y) * 1.6;
      const o = (y * W + x) * 4;
      c.buf[o] = Math.max(0, Math.min(255, Math.round(r + dth)));
      c.buf[o + 1] = Math.max(0, Math.min(255, Math.round(g + dth)));
      c.buf[o + 2] = Math.max(0, Math.min(255, Math.round(b + dth)));
      c.buf[o + 3] = 255;
    }
  }
  fs.writeFileSync(out, encodePNG(W, H, c.buf));
  console.log(`[art] 壁纸 ${out} ${W}x${H}`);
}

/* -------------------------------- 图标 ----------------------------------- */

const INK = { r: 232, g: 236, b: 244 };

/** 地球（登录 / 浏览器） */
function iconGlobe(S) {
  const c = new Canvas(S, S), k = S / 64, cx = S / 2, cy = S / 2;
  c.fill(sdRing(cx, cy, 22 * k, 3.2 * k), INK);
  c.fill(sdEllipseRing(cx, cy, 10.5 * k, 22 * k, 2.6 * k), { r: 200, g: 208, b: 222 });
  c.fill(sdCapsule(cx - 22 * k, cy, cx + 22 * k, cy, 3.0 * k), INK);
  return c;
}

/** Claude 星芒 */
function iconClaude(S) {
  const c = new Canvas(S, S), k = S / 64, cx = S / 2, cy = S / 2;
  const col = { r: 217, g: 119, b: 87 };
  const RAYS = 11;
  for (let i = 0; i < RAYS; i++) {
    const a = (Math.PI * 2 * i) / RAYS - Math.PI / 2;
    const len = i % 2 ? 17 * k : 24 * k;
    const w = i % 2 ? 5.2 * k : 6.4 * k;
    c.fill(sdCapsule(cx + Math.cos(a) * 5 * k, cy + Math.sin(a) * 5 * k,
                     cx + Math.cos(a) * len, cy + Math.sin(a) * len, w), col);
  }
  c.fill(sdCircle(cx, cy, 8.2 * k), col);
  return c;
}

/** 终端 >_ */
function iconTerminal(S) {
  const c = new Canvas(S, S), k = S / 64;
  const g = { r: 126, g: 231, b: 135 };
  c.fill(sdCapsule(17 * k, 24 * k, 27 * k, 32 * k, 4.2 * k), g);
  c.fill(sdCapsule(27 * k, 32 * k, 17 * k, 40 * k, 4.2 * k), g);
  c.fill(sdCapsule(31 * k, 41 * k, 45 * k, 41 * k, 3.6 * k), { r: 200, g: 208, b: 222 });
  return c;
}

/** 文件夹 */
function iconFolder(S) {
  const c = new Canvas(S, S), k = S / 64;
  const body = { r: 240, g: 180, b: 90 };
  const back = { r: 214, g: 152, b: 66 };
  c.fill(sdRoundRect(24 * k, 22 * k, 20 * k, 5 * k, 3 * k), back);
  c.fill(sdRoundRect(32 * k, 36 * k, 25 * k, 15 * k, 4 * k), body);
  c.fill(sdRoundRect(32 * k, 33 * k, 24 * k, 3 * k, 2 * k), { r: 250, g: 205, b: 130 });
  return c;
}

const ICONS = {
  'chrome.png': iconGlobe,
  'claude.png': iconClaude,
  'terminal.png': iconTerminal,
  'folder.png': iconFolder,
  'globe.png': iconGlobe,
};

function icons(out, S) {
  fs.mkdirSync(out, { recursive: true });
  for (const [file, fn] of Object.entries(ICONS)) {
    const c = fn(S);
    fs.writeFileSync(path.join(out, file), encodePNG(S, S, c.buf));
  }
  console.log(`[art] 图标 ${Object.keys(ICONS).length} 个 → ${out} (${S}px)`);
}

/* -------------------------------- 入口 ----------------------------------- */

const [mode, out, a, b] = process.argv.slice(2);
if (mode === 'wallpaper') wallpaper(out, +(a || 1280), +(b || 800));
else if (mode === 'icons') icons(out, +(a || 64));
else {
  console.error('用法: gen-art.js wallpaper <out.png> [w] [h] | icons <dir> [size]');
  process.exit(1);
}
