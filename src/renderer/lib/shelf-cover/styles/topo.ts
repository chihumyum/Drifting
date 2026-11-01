/**
 * 等高线 — a contour map: each chapter a storyline carries raises a hill in its
 * lane, higher where the chapter is long; the contours take the colour of the
 * storyline whose hill they ring.
 */
import { lanesOf, type ArtStyle } from '../book';
import { COVER_HEIGHT as H, COVER_WIDTH as W, css, ground, mix, noise2d, type RGB } from '../paint';

type Edge = 'T' | 'R' | 'B' | 'L';
/** Marching squares: corners top-left 8, top-right 4, bottom-right 2, bottom-left 1. */
const SEGMENTS: Record<number, Array<[Edge, Edge]>> = {
  1: [['L', 'B']], 2: [['B', 'R']], 3: [['L', 'R']], 4: [['T', 'R']], 5: [['T', 'L'], ['B', 'R']],
  6: [['T', 'B']], 7: [['T', 'L']], 8: [['T', 'L']], 9: [['T', 'B']], 10: [['T', 'R'], ['L', 'B']],
  11: [['T', 'R']], 12: [['L', 'R']], 13: [['R', 'B']], 14: [['L', 'B']],
};

export const topo: ArtStyle = {
  draw(ctx, book, rand) {
    ctx.putImageData(ground(ctx, [248, 245, 236]), 0, 0);
    const S = book.strands;
    const N = book.chapters;
    const g = 3;
    const gw = Math.ceil(W / g) + 1;
    const gh = Math.ceil(H / g) + 1;
    const F = new Float32Array(gw * gh);
    const D = new Int8Array(gw * gh).fill(-1);
    const best = new Float32Array(gw * gh);
    const terrain = noise2d(70, rand);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) F[y * gw + x] = terrain[Math.min(H - 1, y * g) * W + Math.min(W - 1, x * g)] * 0.4;
    }
    const lanes = lanesOf(S.length);
    const sigma = 11 + rand() * 12;
    S.forEach((s, i) => {
      for (let c = 0; c < N; c++) {
        if (!s.on[c]) continue;
        const hx = lanes[i] + (rand() - 0.5) * 40;
        const hy = ((c + 0.5) / N) * H + (rand() - 0.5) * 8;
        const a = 0.3 + 0.45 * Math.min(2, book.wn[c]);
        const sg = sigma * (0.7 + 0.6 * rand());
        const r = sg * 3;
        for (let y = Math.max(0, Math.floor((hy - r) / g)); y <= Math.min(gh - 1, Math.ceil((hy + r) / g)); y++) {
          for (let x = Math.max(0, Math.floor((hx - r) / g)); x <= Math.min(gw - 1, Math.ceil((hx + r) / g)); x++) {
            const v = a * Math.exp(-((x * g - hx) ** 2 + (y * g - hy) ** 2) / (2 * sg * sg));
            const j = y * gw + x;
            F[j] += v;
            if (v > best[j]) { best[j] = v; D[j] = i; }
          }
        }
      }
    });
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of F) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const L = 16 + Math.floor(rand() * 12);
    const step = (hi - lo) / L;
    // A wash of the storyline's colour, deeper up its hills.
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const j = y * gw + x;
        const i = D[j];
        if (i < 0 || best[j] < 0.05 || S[i].neutral) continue;
        ctx.fillStyle = css(S[i].rgb, 0.2 * ((F[j] - lo) / (hi - lo)) ** 1.4);
        ctx.fillRect(x * g - g / 2, y * g - g / 2, g, g);
      }
    }
    const paths = new Map<string, Path2D>();
    for (let l = 1; l < L; l++) {
      const iso = lo + l * step;
      const major = l % 4 === 0;
      for (let y = 0; y < gh - 1; y++) {
        for (let x = 0; x < gw - 1; x++) {
          const a = F[y * gw + x];
          const b = F[y * gw + x + 1];
          const c = F[(y + 1) * gw + x + 1];
          const d = F[(y + 1) * gw + x];
          const code = (a > iso ? 8 : 0) | (b > iso ? 4 : 0) | (c > iso ? 2 : 0) | (d > iso ? 1 : 0);
          if (code === 0 || code === 15) continue;
          const X = x * g;
          const Y = y * g;
          const P: Record<Edge, [number, number]> = {
            T: [X + (g * (iso - a)) / (b - a), Y],
            R: [X + g, Y + (g * (iso - b)) / (c - b)],
            B: [X + (g * (iso - d)) / (c - d), Y + g],
            L: [X, Y + (g * (iso - a)) / (d - a)],
          };
          const j = y * gw + x;
          const key = `${D[j] >= 0 && best[j] > 0.04 ? D[j] : -1}|${major ? 1 : 0}`;
          let path = paths.get(key);
          if (!path) paths.set(key, (path = new Path2D()));
          for (const [e0, e1] of SEGMENTS[code]) {
            path.moveTo(P[e0][0], P[e0][1]);
            path.lineTo(P[e1][0], P[e1][1]);
          }
        }
      }
    }
    for (const [key, path] of paths) {
      const [i, major] = key.split('|').map(Number);
      const rgb: RGB = i < 0 || S[i].neutral ? [128, 110, 88] : mix(S[i].rgb, [40, 30, 20], 0.18);
      ctx.strokeStyle = css(rgb, major ? 0.92 : 0.62);
      ctx.lineWidth = major ? 1.2 : 0.7;
      ctx.stroke(path);
    }
    return { dark: false };
  },
};
