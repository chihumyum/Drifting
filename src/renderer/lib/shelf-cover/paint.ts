/**
 * What every cover style paints with: seeded randomness, smooth noise, colour
 * arithmetic and a few raster helpers. Everything works on a 2D context of the
 * cover's own size (mask px, twice the 126 × 226 cover), in a worker or not.
 */

export const COVER_WIDTH = 252;
export const COVER_HEIGHT = 452;
const W = COVER_WIDTH;
const H = COVER_HEIGHT;

export const TAU = Math.PI * 2;

export type RGB = [number, number, number];

/** A 2D context, on screen or offscreen; both draw the same. */
export type Paint = CanvasRenderingContext2D;

/** A seeded random number generator (mulberry32), 0–1. */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ease = (t: number) => t * t * (3 - 2 * t);
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Smooth noise along one axis, 0–1, varying over about `cell` steps. */
export function noise1d(n: number, cell: number, rand: () => number): Float32Array {
  const grid = Array.from({ length: Math.floor(n / cell) + 3 }, rand);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = i / cell;
    const i0 = Math.floor(u);
    const t = ease(u - i0);
    out[i] = grid[i0] * (1 - t) + grid[i0 + 1] * t;
  }
  return out;
}

/** Smooth noise over the cover, 0–1, varying over about `cell` px across and `cellY` down. */
export function noise2d(cell: number, rand: () => number, cellY = cell): Float32Array {
  const gw = Math.floor(W / cell) + 3;
  const gh = Math.floor(H / cellY) + 3;
  const grid = new Float32Array(gw * gh);
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const v = y / cellY;
    const y0 = Math.floor(v);
    const ty = ease(v - y0);
    for (let x = 0; x < W; x++) {
      const u = x / cell;
      const x0 = Math.floor(u);
      const tx = ease(u - x0);
      const a = grid[y0 * gw + x0];
      const b = grid[y0 * gw + x0 + 1];
      const c = grid[(y0 + 1) * gw + x0];
      const d = grid[(y0 + 1) * gw + x0 + 1];
      out[y * W + x] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
  }
  return out;
}

/** `#rgb` or `#rrggbb`; anything else is the neutral ink. */
export function hexColor(color: string, fallback: RGB = [85, 82, 78]): RGB {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return fallback;
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
}

export const mix = (a: RGB, b: RGB, t: number): RGB =>
  a.map((v, i) => Math.round(v + (b[i] - v) * t)) as RGB;
export const css = (c: RGB, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
export const averageColor = (list: RGB[]): RGB =>
  [0, 1, 2].map((k) => Math.round(list.reduce((s, c) => s + c[k], 0) / list.length)) as RGB;

/** The colour with its saturation and lightness scaled, as print and paper colours are louder than ink. */
export function vivid(rgb: RGB, sat = 1.3, light = 1): RGB {
  const [r, g, b] = rgb.map((v) => v / 255);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  let l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  s = clamp(s * sat, 0, 1);
  l = clamp(l * light, 0, 1);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    t = (t + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)].map((v) => Math.round(v * 255)) as RGB;
}

export const PAPER: RGB = [253, 252, 249];

/** A ground of one colour, each px (index `i`, at `x`, `y`) scaled by `texture` if given. */
export function ground(ctx: Paint, rgb: RGB, texture?: (i: number, x: number, y: number) => number): ImageData {
  const img = ctx.createImageData(W, H);
  const d = img.data;
  for (let i = 0; i < W * H; i++) {
    const t = texture ? texture(i, i % W, (i / W) | 0) : 1;
    d[i * 4] = rgb[0] * t;
    d[i * 4 + 1] = rgb[1] * t;
    d[i * 4 + 2] = rgb[2] * t;
    d[i * 4 + 3] = 255;
  }
  return img;
}

/** Lays a colour on the image through an alpha field, as pigment: the paper shows through. */
export function multiplyInto(data: Uint8ClampedArray, alpha: Float32Array, rgb: RGB, strength = 1) {
  for (let i = 0; i < W * H; i++) {
    const a = alpha[i] * strength;
    if (a <= 0) continue;
    const o = i * 4;
    data[o] *= 1 - a + (a * rgb[0]) / 255;
    data[o + 1] *= 1 - a + (a * rgb[1]) / 255;
    data[o + 2] *= 1 - a + (a * rgb[2]) / 255;
  }
}

export interface Point {
  x: number;
  y: number;
}

/** A closed path through the points' midpoints, curving at each point. */
export function smoothClosed(ctx: Paint, pts: readonly Point[]) {
  const n = pts.length;
  const mid = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const start = mid(pts[n - 1], pts[0]);
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  for (let i = 0; i < n; i++) {
    const m = mid(pts[i], pts[(i + 1) % n]);
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, m.x, m.y);
  }
  ctx.closePath();
}
