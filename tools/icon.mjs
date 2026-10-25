// Draws images/icon.png (128×128) with Node alone: a blue rounded square with a small story map
// (a Feature pill on the left joined by lines to three cards). Run once; the PNG is committed.
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";

const S = 128, SS = 4; // 4×4 samples per pixel for smooth edges
const px = new Float32Array(S * S * 4);

function roundRect(x, y, w, h, r) {
  return (X, Y) => {
    const cx = Math.max(x + r, Math.min(X, x + w - r));
    const cy = Math.max(y + r, Math.min(Y, y + h - r));
    return (X - cx) ** 2 + (Y - cy) ** 2 <= r * r && X >= x && X <= x + w && Y >= y && Y <= y + h;
  };
}
function bezier(p0, p1, p2, p3, width) {
  const pts = [];
  for (let t = 0; t <= 1; t += 0.01) {
    const u = 1 - t;
    pts.push([u ** 3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t ** 3 * p3[0], u ** 3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t ** 3 * p3[1]]);
  }
  return (X, Y) => pts.some(([a, b]) => (X - a) ** 2 + (Y - b) ** 2 <= (width / 2) ** 2);
}

const layers = [
  [roundRect(4, 4, 120, 120, 26), [29, 111, 184, 255]],
  [bezier([46, 64], [62, 64], [62, 34], [76, 34], 3.2), [255, 255, 255, 150]],
  [bezier([46, 64], [62, 64], [62, 64], [76, 64], 3.2), [255, 255, 255, 150]],
  [bezier([46, 64], [62, 64], [62, 94], [76, 94], 3.2), [255, 255, 255, 150]],
  [roundRect(16, 50, 34, 28, 13), [255, 255, 255, 255]],
  [roundRect(74, 22, 38, 24, 6), [255, 255, 255, 255]],
  [roundRect(74, 52, 38, 24, 6), [255, 255, 255, 255]],
  [roundRect(74, 82, 38, 24, 6), [255, 211, 105, 255]],
  [roundRect(80, 30, 22, 4, 2), [29, 111, 184, 255]],
  [roundRect(80, 60, 16, 4, 2), [29, 111, 184, 255]],
  [roundRect(80, 90, 26, 4, 2), [120, 80, 0, 255]],
];

for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  const acc = [0, 0, 0, 0];
  for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
    const X = x + (sx + 0.5) / SS, Y = y + (sy + 0.5) / SS;
    let c = [0, 0, 0, 0];
    for (const [inside, col] of layers) {
      if (!inside(X, Y)) continue;
      const a = col[3] / 255;
      c = [col[0] * a + c[0] * (1 - a), col[1] * a + c[1] * (1 - a), col[2] * a + c[2] * (1 - a), 255 * a + c[3] * (1 - a)];
    }
    for (let i = 0; i < 4; i++) acc[i] += c[i];
  }
  const o = (y * S + x) * 4;
  for (let i = 0; i < 4; i++) px[o + i] = acc[i] / (SS * SS);
}

const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  for (let x = 0; x < S * 4; x++) {
    const i = y * S * 4 + x;
    const a = px[i - (i % 4) + 3];
    raw[y * (S * 4 + 1) + 1 + x] = Math.round(i % 4 === 3 ? a : a ? px[i] * 255 / a : 0);
  }
}
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
mkdirSync("images", { recursive: true });
writeFileSync("images/icon.png", Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
console.log("images/icon.png written");
