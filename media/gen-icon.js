// Generates media/icon.png (128x128) with no external dependencies.
// Run: node media/gen-icon.js
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const S = 128;
const buf = Buffer.alloc(S * S * 4);

function px(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
}

// Rounded-rect background in Azure blue.
const radius = 24;
function inRoundedRect(x, y, w, h, r) {
  if (x < r && y < r) return (x - r) ** 2 + (y - r) ** 2 <= r * r;
  if (x > w - 1 - r && y < r) return (x - (w - 1 - r)) ** 2 + (y - r) ** 2 <= r * r;
  if (x < r && y > h - 1 - r) return (x - r) ** 2 + (y - (h - 1 - r)) ** 2 <= r * r;
  if (x > w - 1 - r && y > h - 1 - r)
    return (x - (w - 1 - r)) ** 2 + (y - (h - 1 - r)) ** 2 <= r * r;
  return true;
}

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    if (inRoundedRect(x, y, S, S, radius)) {
      // Vertical gradient from #0a84ff to #0058c4.
      const t = y / S;
      px(x, y, Math.round(10 + t * 0), Math.round(132 - t * 44), Math.round(255 - t * 59));
    }
  }
}

// White ">_" terminal glyph.
function line(x0, y0, x1, y1, thick) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let s = 0; s <= steps; s++) {
    const x = Math.round(x0 + ((x1 - x0) * s) / steps);
    const y = Math.round(y0 + ((y1 - y0) * s) / steps);
    for (let dx = -thick; dx <= thick; dx++)
      for (let dy = -thick; dy <= thick; dy++) px(x + dx, y + dy, 255, 255, 255);
  }
}

// Chevron ">"
line(44, 44, 68, 64, 4);
line(68, 64, 44, 84, 4);
// Underscore "_"
line(74, 84, 92, 84, 4);

// Encode PNG (filter type 0 per scanline).
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const idat = zlib.deflateSync(raw, { level: 9 });

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function crc32(b) {
  let c = ~0;
  for (let i = 0; i < b.length; i++) {
    c ^= b[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

fs.writeFileSync(path.join(__dirname, 'icon.png'), png);
console.log('wrote media/icon.png', png.length, 'bytes');
