// Renders the app icon procedurally (gradient squircle + phone + play glyph)
// into build/icon.png (512px), build/tray.png (32px) and build/icon.ico.
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
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// signed distance to a rounded box centred at (cx,cy)
function sdRoundBox(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - hw + r, qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function sdTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const e = [[bx - ax, by - ay], [cx - bx, cy - by], [ax - cx, ay - cy]];
  const v = [[px - ax, py - ay], [px - bx, py - by], [px - cx, py - cy]];
  let d = Infinity, s = 1;
  const sgn = Math.sign(e[0][0] * e[2][1] - e[0][1] * e[2][0]);
  for (let i = 0; i < 3; i++) {
    const t = Math.max(0, Math.min(1, (v[i][0] * e[i][0] + v[i][1] * e[i][1]) / (e[i][0] ** 2 + e[i][1] ** 2)));
    const qx = v[i][0] - e[i][0] * t, qy = v[i][1] - e[i][1] * t;
    d = Math.min(d, qx * qx + qy * qy);
    if (sgn * (v[i][0] * e[i][1] - v[i][1] * e[i][0]) < 0) s = -1;
  }
  return Math.sqrt(d) * -s;
}
const mix = (a, b, t) => a + (b - a) * t;

function render(size) {
  const S = 4; // supersampling
  const buf = Buffer.alloc(size * size * 4);
  const c1 = [124, 92, 255], c2 = [34, 211, 238];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const u = (x + (sx + 0.5) / S) / size, v = (y + (sy + 0.5) / S) / size;
      // background squircle
      const bg = sdRoundBox(u, v, 0.5, 0.5, 0.46, 0.46, 0.2);
      if (bg > 0) continue;
      const t = Math.min(1, Math.max(0, (u * 0.6 + v * 0.4)));
      let col = [mix(c1[0], c2[0], t), mix(c1[1], c2[1], t), mix(c1[2], c2[2], t)];
      // soft top highlight
      const hl = Math.max(0, 0.18 - v * 0.3);
      col = col.map(c => c + (255 - c) * hl);
      // phone body (outline)
      const phone = sdRoundBox(u, v, 0.5, 0.52, 0.19, 0.3, 0.07);
      const ring = Math.abs(phone) - 0.028;
      let white = 0;
      if (ring < 0) white = 1;
      // speaker slot
      if (sdRoundBox(u, v, 0.5, 0.29, 0.045, 0.01, 0.01) < 0) white = 1;
      // play triangle
      if (sdTriangle(u, v, 0.45, 0.43, 0.45, 0.63, 0.6, 0.53) < -0.004) white = 1;
      // subtle glass fill inside the phone
      if (phone < 0 && !white) col = col.map(c => c + (255 - c) * 0.12);
      if (white) col = [255, 255, 255];
      r += col[0]; g += col[1]; b += col[2]; a += 1;
    }
    const n = S * S, i = (y * size + x) * 4;
    if (a) { buf[i] = r / a; buf[i + 1] = g / a; buf[i + 2] = b / a; }
    buf[i + 3] = Math.round((a / n) * 255);
  }
  return png(size, buf);
}

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
const big = render(512);
fs.writeFileSync(path.join(outDir, 'icon.png'), big);
fs.writeFileSync(path.join(outDir, 'tray.png'), render(32));
fs.copyFileSync(path.join(outDir, 'icon.png'), path.join(__dirname, '..', 'src', 'renderer', 'icon.png'));
// ICO with embedded 256px PNG
const p256 = render(256);
const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
const entry = Buffer.alloc(16);
entry[0] = 0; entry[1] = 0; entry[2] = 0; entry[3] = 0;
entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
entry.writeUInt32LE(p256.length, 8); entry.writeUInt32LE(22, 12);
fs.writeFileSync(path.join(outDir, 'icon.ico'), Buffer.concat([header, entry, p256]));
console.log('icons written to build/');
