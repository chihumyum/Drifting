// The app icon's Icon Composer layers, drawn from the iceberg line art
// (iceberg-lines.png): the berg filled with sand, light at the top and denser
// with depth, its crevices left clear, and its outline a glass rim — an uneven
// line cut by the glass texture (glass-thick.png), a narrow bleed inward, and
// the sand under it drawn in a little. Each layer is a white mask on the
// 1024-point canvas; src/assets/icon.icon/icon.json colours it.

import { thin, trace, len, rng } from '../social-preview/sand-letters.js';

const N = 1024;
// The sketches were tuned on a 600px tile; these keep their proportions.
const U = 600 / N, S = N / 300, AA = 1.1 * N / 300;
// Sand weight and the rim's strength: sketch d1, made denser so the berg holds at Dock sizes.
const SAND = 1.1, SAND_INK = 1, LINE = 0.8, BLEED = 0.26, BLEED_WIDTH = 4, BEND = N * 0.012;

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
async function load(src) { const im = new Image(); im.src = src; await im.decode(); return im; }
function alphaOf(image, w = image.width, h = image.height, place = (g) => g.drawImage(image, 0, 0)) {
  const c = new OffscreenCanvas(w, h), g = c.getContext('2d');
  place(g);
  const px = g.getImageData(0, 0, w, h).data, a = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) a[p] = px[p * 4 + 3] / 255;
  return a;
}

/** Distance (chamfer, 1 and √2) from every pixel to the nearest pixel marked in `zero`. */
function distance(zero) {
  const d = new Float32Array(N * N), R2 = Math.SQRT2;
  for (let p = 0; p < N * N; p++) d[p] = zero[p] ? 0 : 1e9;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const p = y * N + x; let v = d[p];
    if (x > 0) v = Math.min(v, d[p - 1] + 1);
    if (y > 0) { v = Math.min(v, d[p - N] + 1); if (x > 0) v = Math.min(v, d[p - N - 1] + R2); if (x < N - 1) v = Math.min(v, d[p - N + 1] + R2); }
    d[p] = v;
  }
  for (let y = N - 1; y >= 0; y--) for (let x = N - 1; x >= 0; x--) {
    const p = y * N + x; let v = d[p];
    if (x < N - 1) v = Math.min(v, d[p + 1] + 1);
    if (y < N - 1) { v = Math.min(v, d[p + N] + 1); if (x < N - 1) v = Math.min(v, d[p + N + 1] + R2); if (x > 0) v = Math.min(v, d[p + N - 1] + R2); }
    d[p] = v;
  }
  return d;
}

/** The berg on the canvas: its silhouette, the distances in and out of it, and its crevices. */
function shape(lines) {
  const sc = (N * 0.82) / lines.height, w = lines.width * sc, h = lines.height * sc;
  const ink = alphaOf(lines, N, N, (g) => g.drawImage(lines, (N - w) / 2 + N * 0.01, (N - h) / 2 + N * 0.005, w, h));
  const stroke = new Uint8Array(N * N);
  for (let p = 0; p < N * N; p++) stroke[p] = ink[p] > 90 / 255 ? 1 : 0;
  // Outside: flood from the border through the empty pixels.
  const outside = new Uint8Array(N * N), stack = [];
  for (let i = 0; i < N; i++) for (const p of [i, (N - 1) * N + i, i * N, i * N + N - 1]) if (!stroke[p] && !outside[p]) { outside[p] = 1; stack.push(p); }
  while (stack.length) {
    const p = stack.pop(), x = p % N, y = (p / N) | 0;
    for (const q of [x > 0 ? p - 1 : -1, x < N - 1 ? p + 1 : -1, y > 0 ? p - N : -1, y < N - 1 ? p + N : -1]) if (q >= 0 && !stroke[q] && !outside[q]) { outside[q] = 1; stack.push(q); }
  }
  const sil = new Uint8Array(N * N);
  for (let p = 0; p < N * N; p++) sil[p] = outside[p] ? 0 : 1;
  const dIn = distance(outside), dOut = distance(sil);
  // A crevice is a skeleton stroke that runs well inside the outline.
  const strokes = trace(thin(stroke.slice(), N, N), N, N)
    .filter((s) => s.pts.length > 1)
    .filter((s) => !(s.endA && s.endB && len(s.pts) < N * 0.01));
  const crev = new Uint8Array(N * N);
  for (const s of strokes) {
    let m = 0; for (const [x, y] of s.pts) m += dIn[y * N + x];
    if (m / s.pts.length > N * 0.016) for (const [x, y] of s.pts) crev[y * N + x] = 1;
  }
  let top = N, bottom = 0;
  for (let p = 0; p < N * N; p++) if (sil[p]) { const y = (p / N) | 0; top = Math.min(top, y); bottom = Math.max(bottom, y); }
  return { sil, dIn, dOut, dCrev: distance(crev), top, bottom };
}

/** The berg as sand: lighter at the top, denser with depth, crevices left clear, a few grains thrown off the edge. */
function sand(berg, weight, seed) {
  const rand = rng(seed), a = new Float32Array(N * N), span = berg.bottom - berg.top;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const p = y * N + x;
    if (!berg.sil[p]) { const d = berg.dOut[p]; if (d < N * 0.012 && rand() < 0.012 * weight * (1 - d / (N * 0.012))) a[p] = 0.45 + 0.3 * rand(); continue; }
    const depth = clamp((y - berg.top) / span), edge = smoothstep(0, N * 0.012, berg.dIn[p]), gap = smoothstep(N * 0.004, N * 0.011, berg.dCrev[p]);
    // Even with depth: banding in the density outlives the grains when the
    // icon is scaled down and reads as contour rings in the Dock.
    const dens = weight * (0.32 + 0.5 * depth ** 1.1) * gap * (0.8 + 0.2 * edge);
    a[p] = rand() < dens ? 0.62 + 0.38 * rand() : dens * 0.25;
  }
  return a;
}

/** The three layers as white-on-alpha masks, N × N: `sand`, `line` (the rim) and `bleed`. */
export async function drawLayers(base = '../../..') {
  const [lines, glass] = await Promise.all([load('iceberg-lines.png'), load(`${base}/src/assets/design/glass-thick.png`)]);
  const tex = alphaOf(glass), tw = glass.width, th = glass.height;
  // Glass thickness, tiled (the app's 150px texture, scaled with the canvas).
  const thick = (x, y) => {
    let u = (x * U / 2.2) % tw, v = (y * U / 2.2) % th; if (u < 0) u += tw; if (v < 0) v += th;
    const x0 = Math.floor(u), y0 = Math.floor(v), x1 = (x0 + 1) % tw, y1 = (y0 + 1) % th, tx = u - x0, ty = v - y0;
    return (tex[y0 * tw + x0] * (1 - tx) + tex[y0 * tw + x1] * tx) * (1 - ty) + (tex[y1 * tw + x0] * (1 - tx) + tex[y1 * tw + x1] * tx) * ty;
  };
  const berg = shape(lines), grains = sand(berg, SAND, 17);
  const at = (a, x, y) => {
    x = clamp(x, 0, N - 1.001); y = clamp(y, 0, N - 1.001);
    const x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
    return (a[y0 * N + x0] * (1 - tx) + a[y0 * N + x0 + 1] * tx) * (1 - ty) + (a[(y0 + 1) * N + x0] * (1 - tx) + a[(y0 + 1) * N + x0 + 1] * tx) * ty;
  };
  const out = { sand: new Float32Array(N * N), line: new Float32Array(N * N), bleed: new Float32Array(N * N) };
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const p = y * N + x, d = berg.dIn[p];
    if (!berg.sil[p] || d > N * 0.06 || x < 1 || y < 1 || x > N - 2 || y > N - 2) { out.sand[p] = grains[p] * SAND_INK; continue; }
    // Under the rim the sand is seen through thicker glass: drawn in from the edge.
    let gx = berg.dIn[p + 1] - berg.dIn[p - 1], gy = berg.dIn[p + N] - berg.dIn[p - N];
    const gl = Math.hypot(gx, gy) || 1; gx /= gl; gy /= gl;
    const k = Math.max(0, 1 - d / (N * 0.04)) ** 2 * BEND;
    out.sand[p] = at(grains, x + gx * k, y + gy * k) * SAND_INK;
    const t = thick(x, y), w = S * (0.5 + 2.8 * t ** 1.3);
    out.line[p] = clamp(clamp((w - d) / AA + 0.5) * LINE);
    out.bleed[p] = clamp(Math.exp(-d / (BLEED_WIDTH * S)) * (0.4 + 0.9 * t) * BLEED);
  }
  return out;
}

/** A mask as a PNG data URL. */
export function maskUrl(a) {
  const c = document.createElement('canvas'); c.width = c.height = N;
  const img = new ImageData(N, N);
  for (let p = 0; p < N * N; p++) { img.data[p * 4] = img.data[p * 4 + 1] = img.data[p * 4 + 2] = 255; img.data[p * 4 + 3] = Math.round(clamp(a[p]) * 255); }
  c.getContext('2d').putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}
