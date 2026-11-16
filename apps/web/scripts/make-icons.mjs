// Renders the PWA icons (four friends on dark green) as PNG without image dependencies.
// Run once after changing the mark: `node apps/web/scripts/make-icons.mjs`.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const hex = (h) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
const BG = hex('#0e1713');
const DOTS = ['#f0b23a', '#4e79ec', '#22a088', '#e26a4c'].map(hex);

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, inset) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const s = size * (1 - 2 * inset);
  const o = size * inset;
  const r = s * (11 / 64);
  const centers = [
    [22, 22],
    [42, 22],
    [22, 42],
    [42, 42],
  ].map(([x, y]) => [o + (x / 64) * s, o + (y / 64) * s]);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let col = BG;
      for (let i = 0; i < 4; i++) {
        const [cx, cy] = centers[i];
        if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) col = DOTS[i];
      }
      const p = y * (size * 4 + 1) + 1 + x * 4;
      raw[p] = col[0];
      raw[p + 1] = col[1];
      raw[p + 2] = col[2];
      raw[p + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const dir = new URL('../public/icons/', import.meta.url);
writeFileSync(new URL('icon-192.png', dir), png(192, 0));
writeFileSync(new URL('icon-512.png', dir), png(512, 0));
writeFileSync(new URL('maskable-512.png', dir), png(512, 0.12));
