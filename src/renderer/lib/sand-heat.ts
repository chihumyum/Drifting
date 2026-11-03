/**
 * Sand for the shelf's writing heatmap and the cards' 30-day strips
 * (docs/writing-days.md). A day written is one press of a dry brush, larger
 * and fuller the more words it holds; a day without words is a few loose
 * grains; a day in a strip is a short upright stroke, pressed at its foot and
 * drying toward the top. Everything paints white alpha into a mask; the
 * colour is the `.sand` element's (materials.css), so a theme change needs no
 * redraw. Every mark is seeded, so the same day always lands the same.
 */

export interface SandMask {
  /** Device pixels. */
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  /** 0–255 per device pixel. */
  readonly alpha: Uint8ClampedArray;
}

export function createSandMask(width: number, height: number, dpr: number): SandMask {
  const w = Math.max(1, Math.round(width * dpr));
  const h = Math.max(1, Math.round(height * dpr));
  return { width: w, height: h, dpr, alpha: new Uint8ClampedArray(w * h) };
}

function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(a: number, b: number, c: number): number {
  let h = (Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 1274126177)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));

/** 1 well inside `inner`, falling to 0 at `outer` (inner < outer). */
function falloff(outer: number, inner: number, x: number): number {
  const t = clamp((x - outer) / (inner - outer), 0, 1);
  return t * t * (3 - 2 * t);
}

function grain(mask: SandMask, x: number, y: number, alpha: number): void {
  if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) return;
  const index = y * mask.width + x;
  const value = Math.round(clamp(alpha, 0, 1) * 255);
  if (value > mask.alpha[index]) mask.alpha[index] = value;
}

/** A day without words: a few loose grains round (cx, cy), in CSS px. */
export function sandLoose(mask: SandMask, cx: number, cy: number, count: number, alpha: number, seed: number): void {
  const rand = random(seed);
  for (let k = 0; k < count; k++) {
    const x = Math.round((cx + (rand() - 0.5) * 3.2) * mask.dpr);
    const y = Math.round((cy + (rand() - 0.5) * 3.2) * mask.dpr);
    grain(mask, x, y, alpha * (0.6 + 0.4 * rand()));
  }
}

/** One press of a dry brush: an uneven dot whose hairs streak along its slant. */
export function sandDab(mask: SandMask, cx: number, cy: number, size: number, density: number, seed: number): void {
  const r = (size / 2) * mask.dpr;
  const X = cx * mask.dpr;
  const Y = cy * mask.dpr;
  const rand = random(seed);
  const tilt = -0.5 + (rand() - 0.5) * 0.6;
  const p0 = rand() * 6.28;
  const p1 = rand() * 6.28;
  const p2 = rand() * 6.28;
  const press = (rand() - 0.5) * 0.8;
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  for (let py = Math.floor(Y - r - 2); py <= Math.ceil(Y + r + 2); py++) {
    for (let px = Math.floor(X - r - 2); px <= Math.ceil(X + r + 2); px++) {
      const dx = (px + 0.5 - X) / r;
      const dy = (py + 0.5 - Y) / r;
      const angle = Math.atan2(dy, dx);
      const edge = 0.92 + 0.08 * Math.sin(2 * angle + p0) + 0.06 * Math.sin(3 * angle + p1) + 0.04 * Math.sin(5 * angle + p2);
      // Between a square and a circle: a brush dot, not a pixel.
      const distance = 0.55 * Math.max(Math.abs(dx), Math.abs(dy)) + 0.45 * Math.hypot(dx, dy);
      const inside = falloff(edge, edge - 0.3, distance);
      if (inside <= 0) continue;
      const along = dx * ct + dy * st;
      const across = -dx * st + dy * ct;
      const hair = 0.86 + 0.14 * Math.sin(across * 10 + p0 * 3);
      const p = clamp(inside * density * hair * (1.16 - 0.22 * Math.abs(along - press)), 0, 1);
      if (hash(px, py, seed) > p) continue;
      grain(mask, px, py, 0.5 + 0.5 * hash(py, px, seed ^ 0x5bd1e995));
    }
  }
}

/** A short upright stroke from `base` up `height` CSS px, `width` wide at its foot. */
export function sandBar(mask: SandMask, x: number, base: number, width: number, height: number, seed: number): void {
  const dpr = mask.dpr;
  const X0 = x * dpr;
  const X1 = (x + width) * dpr;
  const Yb = base * dpr;
  const Yt = (base - height) * dpr;
  const rand = random(seed);
  const lean = (rand() - 0.5) * 0.7 * dpr;
  const wobble = rand() * 6.28;
  const half = (X1 - X0) / 2;
  const middle = (X0 + X1) / 2;
  for (let py = Math.floor(Yt); py < Math.ceil(Yb); py++) {
    const v = clamp((Yb - py) / Math.max(1, Yb - Yt), 0, 1);
    const shift = lean * v;
    const breadth = 1 - 0.16 * v + 0.06 * Math.sin(v * 7 + wobble);
    const dry = (0.97 - 0.32 * v) * (v > 0.9 ? 1 - ((v - 0.9) / 0.1) * 0.6 : 1);
    for (let px = Math.floor(X0 - 2); px <= Math.ceil(X1 + 2); px++) {
      const u = (px + 0.5 - shift - middle) / half;
      const inside = falloff(breadth, breadth - 0.4, Math.abs(u));
      if (inside <= 0) continue;
      const hair = 0.68 + 0.32 * hash(px - Math.round(shift), 7, seed);
      if (hash(px, py, seed) > inside * hair * dry) continue;
      grain(mask, px, py, 0.55 + 0.45 * hash(py, px, seed ^ 0x27d4eb2d));
    }
  }
}

/** Grains painted so far (for tests and empty checks). */
export function sandCoverage(mask: SandMask): number {
  let painted = 0;
  for (const value of mask.alpha) if (value > 0) painted++;
  return painted;
}

/** The mask as a PNG for `--sand-mask`. Browser only. */
export function sandMaskURL(mask: SandMask): string {
  const canvas = document.createElement('canvas');
  canvas.width = mask.width;
  canvas.height = mask.height;
  const context = canvas.getContext('2d');
  if (!context) return '';
  const image = context.createImageData(mask.width, mask.height);
  for (let i = 0; i < mask.alpha.length; i++) {
    const o = i * 4;
    image.data[o] = 255;
    image.data[o + 1] = 255;
    image.data[o + 2] = 255;
    image.data[o + 3] = mask.alpha[i];
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

/** Heatmap layout: an 11px cell every 14px, seven rows, Monday at the top. */
export const HEAT_CELL = 11;
export const HEAT_STEP = 14;
const DAB_SIZE = [0, 7.6, 8.8, 10, 11.2] as const;
const DAB_DENSITY = [0, 0.66, 0.8, 0.92, 1] as const;

/** The year's dabs (`levels` per day, 1–4) and the loose grains of the days without words. */
export function paintHeatmap(
  levels: readonly number[],
  columns: number,
  dpr: number,
): { dabs: SandMask; loose: SandMask } {
  const width = columns * HEAT_STEP - (HEAT_STEP - HEAT_CELL);
  const height = 7 * HEAT_STEP - (HEAT_STEP - HEAT_CELL);
  const dabs = createSandMask(width, height, dpr);
  const loose = createSandMask(width, height, dpr);
  levels.forEach((level, i) => {
    const cx = Math.floor(i / 7) * HEAT_STEP + HEAT_CELL / 2;
    const cy = (i % 7) * HEAT_STEP + HEAT_CELL / 2;
    if (level <= 0) sandLoose(loose, cx, cy, 2, 0.5, i * 131 + 17);
    else sandDab(dabs, cx, cy, DAB_SIZE[level] ?? DAB_SIZE[4], DAB_DENSITY[level] ?? 1, Math.imul(i + 1, 2654435761) >>> 0);
  });
  return { dabs, loose };
}

/** A strip of days, one upright stroke per day written, as tall as its share of the strip's busiest day. */
export function paintStrip(daily: readonly number[], width: number, height: number, dpr: number, seed: number): SandMask {
  const mask = createSandMask(width, height, dpr);
  const slot = width / Math.max(1, daily.length);
  const barWidth = Math.min(5, slot * 0.5);
  const max = Math.max(1, ...daily);
  daily.forEach((words, i) => {
    const x = i * slot + (slot - barWidth) / 2;
    if (words > 0) sandBar(mask, x, height, barWidth, Math.max(3, ((height - 1) * words) / max), seed + i * 97);
    else sandLoose(mask, x + barWidth / 2, height - 1.5, 2, 0.45, seed + i * 31);
  });
  return mask;
}
