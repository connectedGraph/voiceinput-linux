'use strict';
// 生成图标：应用图标 + 托盘图标（纯 Node 手写 PNG，不依赖外部库）
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function roundedRectAlpha(x, y, w, h, r) {
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  const dx = x - cx, dy = y - cy;
  const d = Math.sqrt(dx * dx + dy * dy);
  return Math.max(0, Math.min(1, r - d + 0.5));
}

function drawIcon(size, opts = {}) {
  const { bg = [42, 33, 24], fg = [231, 164, 92], transparent = false, pad = 0 } = opts;
  const w = size, h = size;
  const buf = Buffer.alloc(w * h * 4);
  const scale = size / 256;
  // 三根竖条
  const bars = [
    { x: 88, w: 18, h: 62, o: 0.55 },
    { x: 119, w: 18, h: 104, o: 1.0 },
    { x: 150, w: 18, h: 78, o: 0.8 }
  ].map(b => ({
    x: (b.x + pad) * scale, w: b.w * scale,
    h: b.h * scale, y: 0, o: b.o
  }));

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let a = transparent ? 0 : roundedRectAlpha(x + 0.5 - pad * scale, y + 0.5 - pad * scale, w - 2 * pad * scale, h - 2 * pad * scale, 52 * scale);
      let r = bg[0], g = bg[1], b = bg[2];
      let alpha = a;

      for (const bar of bars) {
        const by = (128 * scale) - bar.h / 2;
        const rr = Math.min(bar.w / 2, 9 * scale);
        const inside = roundedRectAlpha(x + 0.5 - bar.x, y + 0.5 - by, bar.w, bar.h, rr);
        if (inside > 0) {
          const o = bar.o;
          r = Math.round(r * (1 - inside) + fg[0] * inside);
          g = Math.round(g * (1 - inside) + fg[1] * inside);
          b = Math.round(b * (1 - inside) + fg[2] * inside);
          alpha = Math.max(alpha, inside * (o * 0.35 + 0.65));
          if (transparent) alpha = Math.max(alpha, inside * o);
        }
      }
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = Math.round(alpha * 255);
    }
  }
  return encodePNG(w, h, buf);
}

const out = path.join(__dirname, '..', 'assets');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon.png'), drawIcon(256));
fs.writeFileSync(path.join(out, 'tray-idle.png'), drawIcon(22, { transparent: true, pad: 1, bg: [40, 44, 50], fg: [200, 205, 212] }));
fs.writeFileSync(path.join(out, 'tray-rec.png'), drawIcon(22, { transparent: true, pad: 1, bg: [40, 44, 50], fg: [231, 164, 92] }));
console.log('icons written to', out);
