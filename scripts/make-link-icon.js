// Renders the Phone Link icon procedurally (gradient squircle + phone with a lens
// and sound waves) into build/link.png (512px) and build/link.ico (256/48/32/16).
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
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function sdRoundBox(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - hw + r, qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
const mix = (a, b, t) => a + (b - a) * t;

function render(size) {
  const S = 4;
  const buf = Buffer.alloc(size * size * 4);
  const c1 = [16, 185, 129], c2 = [14, 165, 233], c3 = [124, 92, 255];
  const stroke = size <= 32 ? 0.036 : 0.026;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const u = (x + (sx + 0.5) / S) / size, v = (y + (sy + 0.5) / S) / size;
      if (sdRoundBox(u, v, 0.5, 0.5, 0.46, 0.46, 0.2) > 0) continue;
      const t = Math.min(1, Math.max(0, u * 0.55 + v * 0.45));
      let col = t < 0.6 ? c1.map((c, i) => mix(c, c2[i], t / 0.6)) : c2.map((c, i) => mix(c, c3[i], (t - 0.6) / 0.4));
      const hl = Math.max(0, 0.18 - v * 0.3);
      col = col.map(c => c + (255 - c) * hl);
      const cx = 0.42, cy = 0.52;
      const phone = sdRoundBox(u, v, cx, cy, 0.16, 0.27, 0.065);
      let white = Math.abs(phone) - stroke < 0;
      // camera lens (ring + pupil)
      const dl = Math.hypot(u - cx, v - 0.41);
      if (Math.abs(dl - 0.068) < stroke * 0.9 || dl < 0.026) white = true;
      // mic dot
      if (Math.hypot(u - cx, v - 0.66) < 0.02) white = true;
      // sound waves to the right
      const ang = Math.atan2(v - cy, u - cx);
      const d = Math.hypot(u - cx, v - cy);
      if (Math.abs(ang) < 0.62) for (const R of [0.27, 0.35]) if (Math.abs(d - R) < stroke * 0.95) white = true;
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
fs.writeFileSync(path.join(outDir, 'link.png'), render(512));
fs.copyFileSync(path.join(outDir, 'link.png'), path.join(__dirname, '..', 'src', 'renderer', 'link-icon.png'));
const sizes = [256, 48, 32, 16];
const images = sizes.map(render);
const header = Buffer.alloc(6); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const entries = sizes.map((s, i) => {
  const e = Buffer.alloc(16);
  e[0] = s === 256 ? 0 : s; e[1] = s === 256 ? 0 : s;
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(images[i].length, 8); e.writeUInt32LE(offset, 12);
  offset += images[i].length;
  return e;
});
fs.writeFileSync(path.join(outDir, 'link.ico'), Buffer.concat([header, ...entries, ...images]));
console.log('link icons written to build/');
