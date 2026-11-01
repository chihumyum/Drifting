/**
 * 地层 — rock strata: a layer for every chapter from the top down, thick where
 * the chapter is long, tinted where storylines run through it; the beds are
 * folded, sometimes broken by a fault.
 */
import type { ArtStyle } from '../book';
import { COVER_HEIGHT as H, COVER_WIDTH as W, TAU, averageColor, mix, noise1d, noise2d, type RGB } from '../paint';

const EARTH: RGB[] = [[220, 202, 170], [200, 174, 136], [230, 218, 194], [184, 166, 142], [208, 188, 164], [194, 182, 164], [232, 210, 174]];

export const strata: ArtStyle = {
  draw(ctx, book, rand) {
    const N = book.chapters;
    const S = book.strands.filter((s) => !s.neutral);
    const thick = Array.from({ length: N }, (_, c) => 0.35 + 0.65 * Math.min(2.2, book.wn[c]));
    const scale = (H + 40) / thick.reduce((a, b) => a + b, 0);
    const foldA = 10 + rand() * 40;
    const foldF = 0.5 + rand() * 1.4;
    const foldP = rand() * TAU;
    const tilt = (rand() - 0.5) * 0.3;
    // Each bed's top edge across the cover.
    const bounds: Float32Array[] = [];
    let y = -20;
    for (let c = 0; c <= N; c++) {
      const wav = noise1d(W + 1, 24 + rand() * 30, rand);
      const b = new Float32Array(W);
      for (let x = 0; x < W; x++) {
        b[x] = y + Math.sin((x / W) * Math.PI * foldF + foldP) * foldA * (0.6 + 0.4 * (c / N)) + (x - W / 2) * tilt + (wav[x] - 0.5) * 3;
      }
      bounds.push(b);
      if (c < N) y += thick[c] * scale;
    }
    const beds = Array.from({ length: N }, (_, c) => {
      const base = EARTH[Math.floor(rand() * EARTH.length)];
      const present = S.filter((s) => s.on[c]);
      return {
        rgb: present.length ? mix(base, averageColor(present.map((s) => s.rgb)), 0.45 + 0.2 * rand()) : base,
        texture: Math.floor(rand() * 3),
        k: 0.8 + rand() * 1.6,
      };
    });
    const fault = rand() < 0.55;
    const fx0 = W * (0.2 + 0.6 * rand());
    const fx1 = fx0 + (rand() - 0.5) * W * 0.6;
    const shift = (rand() < 0.5 ? -1 : 1) * (8 + rand() * 26);
    const fine = noise2d(1.3, rand);
    const pebble = noise2d(2.2, rand);
    const img = ctx.createImageData(W, H);
    const d = img.data;
    for (let x = 0; x < W; x++) {
      for (let yy = 0; yy < H; yy++) {
        const fxAt = fx0 + ((fx1 - fx0) * yy) / H;
        const ys = fault && x > fxAt ? yy - shift : yy;
        let c = 0;
        while (c < N - 1 && bounds[c + 1][x] <= ys) c++;
        const bed = beds[c];
        const i = yy * W + x;
        let f = 0.92 + 0.12 * fine[i];
        if (bed.texture === 1) f *= 0.96 + 0.05 * Math.sin((ys - bounds[c][x]) * bed.k);
        if (bed.texture === 2 && pebble[i] > 0.86) f *= 0.8;
        if (Math.min(ys - bounds[c][x], bounds[c + 1][x] - ys) < 0.9) f *= 0.78;
        if (fault && Math.abs(x - fxAt) < 0.9) f *= 0.55;
        d[i * 4] = bed.rgb[0] * f;
        d[i * 4 + 1] = bed.rgb[1] * f;
        d[i * 4 + 2] = bed.rgb[2] * f;
        d[i * 4 + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return { dark: false };
  },
};
