/**
 * 孔版 — a risograph print: each storyline one spot ink, every stretch it
 * carries printed as a big shape (disc, arch, bar, half disc) in halftone
 * that fades along its length, sized by the words, each ink slightly off
 * register and the inks overprinting.
 */
import { lanesOf, mean, mergeRuns, runs, shuffled, type ArtStyle } from '../book';
import { COVER_HEIGHT as H, COVER_WIDTH as W, ground, multiplyInto, noise2d, smoothstep, vivid, type RGB } from '../paint';

const ANGLES = [0.26, 0.79, 1.31, 0, 0.52, 1.05];

export const riso: ArtStyle = {
  draw(ctx, book, rand) {
    const grain = noise2d(1.2, rand);
    const blot = noise2d(14, rand);
    const img = ground(ctx, [246, 242, 233], (i) => 0.985 + 0.015 * grain[i]);
    const S = book.strands;
    const N = book.chapters;
    const lanes = lanesOf(S.length);
    const angles = shuffled(ANGLES, rand);
    const cell = 3.6 + rand() * 1.6;
    S.forEach((s, i) => {
      const ink: RGB = s.neutral ? [36, 36, 42] : vivid(s.rgb, 1.45, 1);
      const tone = new Float32Array(W * H);
      for (const [a, b] of mergeRuns(runs(s.on), 1)) {
        const y0 = (a / N) * H;
        const y1 = ((b + 1) / N) * H;
        const ym = (y0 + y1) / 2;
        const words = Math.min(1.6, mean(book.wn, a, b)) / 1.6;
        const kind = Math.floor(rand() * 4);
        const cx = lanes[i] + (rand() - 0.5) * 30;
        const r = (22 + 38 * words) * (0.75 + 0.5 * rand());
        const flip = rand() < 0.5;
        const R = Math.min(80, Math.max(r, (y1 - y0) / 2));
        const t0 = kind === 2 ? y0 : ym - R;
        const t1 = kind === 2 ? y1 : ym + R;
        for (let y = Math.max(0, Math.floor(t0)); y < Math.min(H, Math.ceil(t1)); y++) {
          for (let x = Math.max(0, Math.floor(cx - R)); x < Math.min(W, Math.ceil(cx + R)); x++) {
            const dx = x - cx;
            const dy = y - ym;
            let inside: boolean;
            if (kind === 0) inside = dx * dx + dy * dy < R * R;
            else if (kind === 1) inside = (dy > 0 && Math.abs(dx) < R * 0.7) || dx * dx + dy * dy < (R * 0.7) ** 2;
            else if (kind === 2) inside = Math.abs(dx) < r * 0.55;
            else inside = dx * dx + dy * dy < R * R && (flip ? dx > 0 : dx < 0);
            if (!inside) continue;
            const g = (y - t0) / Math.max(1, t1 - t0);
            const v = 0.18 + 0.82 * (flip ? g : 1 - g);
            const j = y * W + x;
            if (v > tone[j]) tone[j] = v;
          }
        }
      }
      const ang = angles[i % angles.length];
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const ox = (rand() - 0.5) * 5;
      const oy = (rand() - 0.5) * 5;
      const alpha = new Float32Array(W * H);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const sx = Math.round(x - ox);
          const sy = Math.round(y - oy);
          if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
          const T = tone[sy * W + sx];
          if (!T) continue;
          const u = x * ca + y * sa;
          const v = -x * sa + y * ca;
          const fu = u / cell - Math.round(u / cell);
          const fv = v / cell - Math.round(v / cell);
          const dd = Math.hypot(fu, fv) * cell;
          const rad = cell * 0.72 * Math.sqrt(T);
          const j = y * W + x;
          alpha[j] = smoothstep(rad + 0.6, rad - 0.6, dd) * (blot[j] < 0.14 ? 0.45 : 0.92) * (0.84 + 0.16 * grain[j]);
        }
      }
      multiplyInto(img.data, alpha, ink, 1);
    });
    ctx.putImageData(img, 0, 0);
    return { dark: false };
  },
};
