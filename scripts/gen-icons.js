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

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ];
}

/**
 * 画一个圆角方块 + 三根竖条。
 * 托盘图标是给面板缩放用的，所以形状要粗、对比要硬，别用细节。
 */
function drawBadge(size, opts = {}) {
  const {
    bg = [231, 164, 92],
    fg = [21, 24, 27],
    bg2 = null,             // 竖向渐变的下端
    radius = 0.24,          // 相对尺寸
    barW = 0.135,           // 相对尺寸
    barHeights = [0.34, 0.58, 0.44],
    gap = 0.075,
    opaque = false
  } = opts;

  const buf = Buffer.alloc(size * size * 4);
  const r = size * radius;
  const bw = size * barW;
  const gapPx = size * gap;
  const totalW = bw * 3 + gapPx * 2;
  const startX = (size - totalW) / 2;
  const cy = size / 2;
  const barR = Math.min(bw / 2, size * 0.055);

  const bars = barHeights.map((h, i) => ({
    x: startX + i * (bw + gapPx),
    w: bw,
    h: size * h,
    y: cy - (size * h) / 2
  }));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inside = roundedRectAlpha(x + 0.5, y + 0.5, size, size, r);

      let col = bg2 ? mix(bg, bg2, y / size) : bg;
      let alpha = opaque ? 1 : inside;

      for (const bar of bars) {
        const bi = roundedRectAlpha(x + 0.5 - bar.x, y + 0.5 - bar.y, bar.w, bar.h, barR);
        if (bi > 0) {
          col = mix(col, fg, bi);
          if (bi > 0.5) alpha = Math.max(alpha, inside);
        }
      }

      buf[i] = col[0]; buf[i + 1] = col[1]; buf[i + 2] = col[2];
      buf[i + 3] = Math.round(alpha * 255);
    }
  }
  return encodePNG(size, size, buf);
}

/** 应用图标：深色底 + 琥珀声波 */
function drawAppIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const scale = size / 256;
  const body = [42, 33, 24];
  const accent = [231, 164, 92];
  const bars = [
    { x: 88, w: 18, h: 62, o: 0.62 },
    { x: 119, w: 18, h: 104, o: 1.0 },
    { x: 150, w: 18, h: 78, o: 0.85 }
  ].map((b) => ({ x: b.x * scale, w: b.w * scale, h: b.h * scale, o: b.o }));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      let alpha = roundedRectAlpha(x + 0.5, y + 0.5, size, size, 52 * scale);
      let col = body.slice();

      for (const bar of bars) {
        const by = 128 * scale - bar.h / 2;
        const inside = roundedRectAlpha(x + 0.5 - bar.x, y + 0.5 - by, bar.w, bar.h, Math.min(bar.w / 2, 9 * scale));
        if (inside > 0) col = mix(col, accent, inside * bar.o);
      }

      buf[i] = col[0]; buf[i + 1] = col[1]; buf[i + 2] = col[2];
      buf[i + 3] = Math.round(alpha * 255);
    }
  }
  return encodePNG(size, size, buf);
}

const out = path.join(__dirname, '..', 'assets');
fs.mkdirSync(out, { recursive: true });

fs.writeFileSync(path.join(out, 'icon.png'), drawAppIcon(256));

// 托盘：32x32、不透明底。COSMIC 的 status area 只认这个规格的 pixmap，
// 64px 或带透明通道的图标会直接不渲染。
fs.writeFileSync(path.join(out, 'tray-idle.png'), drawBadge(32, {
  bg: [150, 156, 164], bg2: [124, 130, 138], fg: [18, 20, 23], radius: 0.22, opaque: true
}));
fs.writeFileSync(path.join(out, 'tray-rec.png'), drawBadge(32, {
  bg: [242, 180, 106], bg2: [224, 148, 68], fg: [26, 15, 4], radius: 0.22, opaque: true
}));

console.log('icons written to', out);
