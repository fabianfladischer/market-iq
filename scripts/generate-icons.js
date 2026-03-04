/**
 * Generates icon-192.png and icon-512.png using only Node.js built-ins.
 * Design: dark background (#0a0a0a) + green (#00ff88) border + bar chart.
 */
import { deflateSync } from 'zlib';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── CRC32 ──────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── PNG chunk builder ──────────────────────────────────────────────────────
function pngChunk(type, data) {
  const tb  = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const cs  = Buffer.alloc(4); cs.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0);
  return Buffer.concat([len, tb, data, cs]);
}

// ── PNG assembler ──────────────────────────────────────────────────────────
function makePNG(width, height, getPixel) {
  const sig  = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8]  = 8; // bit depth
  ihdr[9]  = 2; // color type: RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filter
  ihdr[12] = 0; // no interlace

  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    row[0] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = getPixel(x, y, width, height);
      row[1 + x * 3]     = r;
      row[2 + x * 3] = g;
      row[3 + x * 3] = b;
    }
    rows.push(row);
  }

  const raw        = Buffer.concat(rows);
  const compressed = deflateSync(raw, { level: 9 });

  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', compressed), pngChunk('IEND', Buffer.alloc(0))]);
}

// ── MarketIQ pixel function ────────────────────────────────────────────────
// Design: dark bg, green border, 5-bar chart (tallest = bar 4)
function marketIQPixel(x, y, w, h) {
  const BG = [10, 10, 10];   // #0a0a0a
  const GR = [0, 255, 136];  // #00ff88

  const nx = x / w;
  const ny = y / h;

  // Outer border (6%)
  const b = 0.06;
  if (nx < b || nx > 1 - b || ny < b || ny > 1 - b) return GR;

  // Inner canvas (normalized 0..1 within border)
  const ix = (nx - b) / (1 - 2 * b);
  const iy = (ny - b) / (1 - 2 * b);

  // X-axis baseline
  const chartBottom = 0.88;
  const chartTop    = 0.12;
  const chartH      = chartBottom - chartTop;

  // Thin baseline rule
  if (iy > chartBottom && iy < chartBottom + 0.035) return GR;

  // 5 bars with relative heights
  const bars = [0.42, 0.68, 0.52, 0.88, 0.64];
  const n    = bars.length;
  const bw   = 0.12;
  const gap  = (1 - n * bw) / (n + 1);

  for (let i = 0; i < n; i++) {
    const bx  = gap + i * (bw + gap);
    if (ix >= bx && ix <= bx + bw) {
      const top = chartBottom - bars[i] * chartH;
      if (iy >= top && iy <= chartBottom) return GR;
    }
  }

  return BG;
}

// ── Write icons ────────────────────────────────────────────────────────────
const publicDir = join(__dirname, '..', 'public');
if (!existsSync(publicDir)) mkdirSync(publicDir, { recursive: true });

for (const size of [192, 512]) {
  const png  = makePNG(size, size, marketIQPixel);
  const dest = join(publicDir, `icon-${size}.png`);
  writeFileSync(dest, png);
  console.log(`✓ Generated icon-${size}.png (${(png.length / 1024).toFixed(1)} KB)`);
}

console.log('\nDone. Run: node server.js');
