// Draws the app icon (1024×1024 PNG) without external tools: a dark page
// with text lines and one revision bar, the mark of a changed passage.
// Usage: node scripts/make-icon.mjs <out.png>
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const S = 1024;
const SS = 4; // supersampling per axis

const hex = (h) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
const BG = hex("#1e1e2e");
const LINE = hex("#cdd6f4");
const DIM = hex("#7f849c");
const BAR = hex("#fab387");

// Shapes are painted in order; later ones cover earlier ones.
const R = 0.2 * S;
const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const rect = (x0, y0, x1, y1, color, r = 0) => ({ x0, y0, x1, y1, color, r });
const lineH = 56;
const shapes = [
  rect(64, 64, S - 64, S - 64, BG, R),
  rect(300, 250, 800, 250 + lineH, LINE, lineH / 2),
  rect(300, 410, 760, 410 + lineH, LINE, lineH / 2),
  rect(300, 570, 820, 570 + lineH, LINE, lineH / 2),
  rect(300, 730, 600, 730 + lineH, DIM, lineH / 2),
  rect(196, 392, 236, 644, BAR, 20),
];

const px = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  const row = y * (S * 4 + 1);
  px[row] = 0; // filter: none
  for (let x = 0; x < S; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const fx = x + (sx + 0.5) / SS;
        const fy = y + (sy + 0.5) / SS;
        let c = null;
        for (const s of shapes) {
          if (inRoundRect(fx, fy, s.x0, s.y0, s.x1, s.y1, s.r)) c = s.color;
        }
        if (c) {
          r += c[0];
          g += c[1];
          b += c[2];
          a += 1;
        }
      }
    }
    const o = row + 1 + x * 4;
    if (a > 0) {
      px[o] = Math.round(r / a);
      px[o + 1] = Math.round(g / a);
      px[o + 2] = Math.round(b / a);
    }
    px[o + 3] = Math.round((255 * a) / (SS * SS));
  }
}

const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(px, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? "icon.png", png);
