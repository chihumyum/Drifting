// Pure-Node (zlib only) PNG codec + macOS icon shaping.
//
// macOS does NOT auto-round or auto-pad Dock icons (unlike iOS). Apple's icon
// grid places the artwork inside a rounded rectangle that occupies ~824/1024
// of the canvas, leaving a transparent margin. A full-bleed square master
// therefore renders larger and squarer than every native neighbor.
//
// `shapeMacIcon` takes an already-resized square "body" PNG (RGBA) and
// composites it centered on a transparent canvas with an anti-aliased
// rounded-rectangle (squircle-approximation) mask.

import zlib from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';

// ---- CRC32 (PNG chunk checksum) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Decode an 8-bit PNG (color type 2 RGB or 6 RGBA) → {width, height, data:RGBA}.
export function decodePng(path) {
  const b = readFileSync(path);
  let off = 8; // skip signature
  let width = 0, height = 0, colorType = 0, bitDepth = 0;
  const idat = [];
  while (off < b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString('ascii', off + 4, off + 8);
    const body = b.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if ((bitDepth !== 8 && bitDepth !== 16) || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`Unsupported PNG (bitDepth=${bitDepth}, colorType=${colorType}); need 8/16-bit RGB/RGBA`);
  }
  const ch = colorType === 6 ? 4 : 3;
  const sampleBytes = bitDepth / 8;  // 1 (8-bit) or 2 (16-bit, big-endian)
  const bpp = ch * sampleBytes;      // filter operates on whole pixels (bytes)
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const recon = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[pos++];
      const a = x >= bpp ? recon[y * stride + x - bpp] : 0;
      const up = y > 0 ? recon[(y - 1) * stride + x] : 0;
      const ul = x >= bpp && y > 0 ? recon[(y - 1) * stride + x - bpp] : 0;
      let val;
      switch (filter) {
        case 0: val = rawByte; break;
        case 1: val = rawByte + a; break;
        case 2: val = rawByte + up; break;
        case 3: val = rawByte + ((a + up) >> 1); break;
        case 4: val = rawByte + paeth(a, up, ul); break;
        default: throw new Error(`Bad PNG filter ${filter}`);
      }
      recon[y * stride + x] = val & 0xff;
    }
  }
  // Normalize to 8-bit RGBA (16-bit samples are big-endian → take the high byte).
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++) {
    const base = i * bpp;
    data[j++] = recon[base];
    data[j++] = recon[base + sampleBytes];
    data[j++] = recon[base + 2 * sampleBytes];
    data[j++] = ch === 4 ? recon[base + 3 * sampleBytes] : 255;
  }
  return { width, height, data };
}

// Encode an RGBA buffer → PNG file (color type 6, filter None).
export function encodePng(path, width, height, data) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    data.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const deflated = zlib.deflateSync(raw, { level: 9 });

  const chunk = (type, body) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'ascii');
    body.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  writeFileSync(path, Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflated),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

// Signed distance to a rounded rectangle centered in the canvas.
// Negative inside, positive outside; used for 1px anti-aliased coverage.
function roundedBoxSdf(px, py, cx, cy, halfX, halfY, r) {
  const qx = Math.abs(px - cx) - (halfX - r);
  const qy = Math.abs(py - cy) - (halfY - r);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/**
 * Composite a square body PNG onto a transparent canvas with a rounded mask.
 * @param {object} o
 * @param {string} o.bodyPngPath  square RGBA PNG, already resized to bodySize
 * @param {string} o.outPngPath   destination (canvas×canvas RGBA PNG)
 * @param {number} o.canvas       output edge length (e.g. 1024)
 * @param {number} o.bodySize     body edge length (e.g. 824)
 * @param {number} o.radius       corner radius in canvas px (only used when round)
 * @param {boolean} [o.round]     apply the rounded mask (default true). Pass
 *                                false when the body is already a shaped
 *                                squircle (e.g. an Icon Composer export) — then
 *                                this just scales-in + centers, preserving the
 *                                source's own alpha, with no second rounding.
 */
export function shapeMacIcon({ bodyPngPath, outPngPath, canvas, bodySize, radius, round = true }) {
  const body = decodePng(bodyPngPath);
  if (body.width !== bodySize || body.height !== bodySize) {
    throw new Error(`body is ${body.width}×${body.height}, expected ${bodySize}²`);
  }
  const margin = (canvas - bodySize) / 2;
  const out = Buffer.alloc(canvas * canvas * 4); // zero-filled = transparent
  const cx = canvas / 2, cy = canvas / 2;
  const half = bodySize / 2;

  for (let y = 0; y < canvas; y++) {
    const sy = y - margin;
    for (let x = 0; x < canvas; x++) {
      const sx = x - margin;
      if (sx < 0 || sy < 0 || sx >= bodySize || sy >= bodySize) continue;
      let coverage = 1;
      if (round) {
        const d = roundedBoxSdf(x + 0.5, y + 0.5, cx, cy, half, half, radius);
        coverage = Math.min(Math.max(0.5 - d, 0), 1);
        if (coverage <= 0) continue;
      }
      const si = (sy * bodySize + sx) * 4;
      const di = (y * canvas + x) * 4;
      out[di] = body.data[si];
      out[di + 1] = body.data[si + 1];
      out[di + 2] = body.data[si + 2];
      out[di + 3] = round ? Math.round(body.data[si + 3] * coverage) : body.data[si + 3];
    }
  }
  encodePng(outPngPath, canvas, canvas, out);
}

// True when all four corner pixels are mostly transparent — i.e. the art is
// already a shaped squircle rather than a full-bleed square. Lets the icon
// pipeline skip a redundant (and mismatched) second rounding pass. The
// threshold sits at half-opacity so soft/anti-aliased squircle corners (an
// Icon Composer @1x export can leave ~37% alpha in a corner) still count as
// shaped, while a true full-bleed square (opaque corners ≈255) does not.
export function cornersAreTransparent(pngPath, threshold = 128) {
  const { width: w, height: h, data } = decodePng(pngPath);
  const alpha = (x, y) => data[(y * w + x) * 4 + 3];
  return (
    alpha(0, 0) < threshold &&
    alpha(w - 1, 0) < threshold &&
    alpha(0, h - 1) < threshold &&
    alpha(w - 1, h - 1) < threshold
  );
}
