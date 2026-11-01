/**
 * 色域 — colour fields: the book cut by its words into two to four movements,
 * each a soft-edged field stacked down the cover, tall where it is long, in
 * the colours of the storylines that carry it, on a deep or pale ground.
 */
import type { ArtStyle } from '../book';
import { COVER_HEIGHT as H, COVER_WIDTH as W, averageColor, ground, mix, noise2d, smoothstep, vivid, type RGB } from '../paint';

const EARTH: RGB[] = [[150, 70, 52], [182, 128, 64], [70, 76, 96], [120, 92, 70]];

export const field: ArtStyle = {
  draw(ctx, book, rand) {
    const N = book.chapters;
    const S = book.strands.filter((s) => !s.neutral);
    const K = Math.min(N, 2 + Math.floor(rand() * 3));
    const counted = book.words.reduce((a, b) => a + b, 0);
    const weight = (c: number) => (counted > 0 ? book.words[c] : 1);
    const total = counted > 0 ? counted : N;
    const cuts = [0];
    let acc = 0;
    for (let c = 0; c < N - 1 && cuts.length < K; c++) {
      acc += weight(c);
      if (acc >= ((total * cuts.length) / K) * (0.8 + 0.4 * rand())) cuts.push(c + 1);
    }
    cuts.push(N);
    const blocks: Array<{ rgb: RGB; words: number; y0: number; y1: number }> = [];
    for (let b = 0; b + 1 < cuts.length; b++) {
      const a = cuts[b];
      const e = cuts[b + 1] - 1;
      let sum = 0;
      const parts: Array<[RGB, number]> = [];
      for (const s of S) {
        let v = 0;
        for (let c = a; c <= e; c++) v += s.on[c] * book.wn[c];
        if (v) { parts.push([s.rgb, v]); sum += v; }
      }
      const rgb: RGB = parts.length
        ? ([0, 1, 2].map((k) => Math.round(parts.reduce((t, [c, v]) => t + c[k] * v, 0) / sum)) as RGB)
        : EARTH[Math.floor(rand() * EARTH.length)];
      let words = 0;
      for (let c = a; c <= e; c++) words += weight(c);
      blocks.push({ rgb: vivid(rgb, 1.25, 1), words: Math.max(1, words), y0: 0, y1: 0 });
    }
    const dark = rand() < 0.55;
    const overall = averageColor(blocks.map((b) => b.rgb));
    const groundRGB = dark ? mix(overall, [22, 14, 12], 0.66) : mix(overall, [250, 243, 230], 0.72);
    const mx = 15 + rand() * 12;
    const top = 18 + rand() * 18;
    const bottom = H - 20 - rand() * 18;
    const gap = 8 + rand() * 12;
    const share = blocks.reduce((s, b) => s + b.words ** 0.8, 0);
    const span = bottom - top - gap * (blocks.length - 1);
    let y = top;
    for (const b of blocks) {
      b.y0 = y;
      b.y1 = y + (span * b.words ** 0.8) / share;
      y = b.y1 + gap;
      b.rgb = dark ? mix(b.rgb, [255, 236, 210], 0.08) : mix(b.rgb, [255, 250, 240], 0.12);
    }
    const brush = noise2d(60, rand, 14);
    const brush2 = noise2d(34, rand, 9);
    const edgeN = noise2d(7, rand);
    const img = ground(ctx, groundRGB, (i) => 0.95 + 0.07 * brush[i]);
    const d = img.data;
    for (const b of blocks) {
      const lift = mix(b.rgb, [255, 248, 236], 0.14);
      for (let yy = Math.max(0, Math.floor(b.y0 - 10)); yy < Math.min(H, Math.ceil(b.y1 + 10)); yy++) {
        for (let x = 0; x < W; x++) {
          const i = yy * W + x;
          const inside = Math.min(x - mx, W - mx - x, yy - b.y0, b.y1 - yy);
          const a = smoothstep(-6, 7, inside + (edgeN[i] - 0.5) * 9) * (0.84 + 0.16 * brush2[i]);
          if (a <= 0) continue;
          // The field glows a little lighter towards its middle.
          const glow = smoothstep(4, 46, inside) * 0.8;
          for (let k = 0; k < 3; k++) {
            const c = b.rgb[k] + (lift[k] - b.rgb[k]) * glow;
            d[i * 4 + k] += (c * (0.95 + 0.08 * brush[i]) - d[i * 4 + k]) * a;
          }
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    return { dark };
  },
};
