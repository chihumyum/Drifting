/**
 * 剪纸 — cut paper: every stretch a storyline carries is cut as one bold shape
 * in its colour, a shape of its own kind, large where the words run long, a
 * long stretch as several down its length; offcuts lie about.
 */
import { lanesOf, mean, mergeRuns, runs, shuffled, type ArtStyle } from '../book';
import { COVER_HEIGHT as H, COVER_WIDTH as W, TAU, css, ground, noise1d, noise2d, smoothClosed, vivid, type Paint, type Point, type RGB } from '../paint';

type Cut = 'algae' | 'burst' | 'seed' | 'pebble';
const CUTS: Cut[] = ['algae', 'burst', 'seed', 'pebble'];
const SHEETS: RGB[] = [[250, 246, 238], [228, 236, 240], [245, 230, 220], [234, 237, 224], [40, 44, 58]];

function cutShape(ctx: Paint, kind: Cut, cx: number, cy: number, sx: number, sy: number, rgb: RGB, rand: () => number) {
  const M = 140;
  const pts: Point[] = [];
  const k = kind === 'algae' ? 5 + Math.floor(rand() * 5) : kind === 'burst' ? 7 + Math.floor(rand() * 6) : 3;
  const ph = rand() * TAU;
  const ph2 = rand() * TAU;
  const rot = (rand() - 0.5) * 0.7;
  const wob = noise1d(M + 3, 10, rand);
  for (let m = 0; m < M; m++) {
    const th = (m / M) * TAU;
    let r: number;
    if (kind === 'algae') r = 0.5 + 0.5 * Math.abs(Math.sin((k * th) / 2 + ph)) ** 0.55 + 0.12 * (wob[m] - 0.5);
    else if (kind === 'burst') r = 0.42 + 0.58 * Math.abs(Math.cos((k * th) / 2 + ph)) ** 2.6 + 0.05 * (wob[m] - 0.5);
    else if (kind === 'seed') r = 0.75 + 0.25 * Math.cos(th - ph) + 0.08 * (wob[m] - 0.5);
    else r = 0.82 + 0.12 * Math.sin(3 * th + ph) + 0.08 * Math.sin(5 * th + ph2) + 0.12 * (wob[m] - 0.5);
    const x = (Math.cos(th) * r * sx) / 2;
    const y = (Math.sin(th) * r * sy) / 2;
    pts.push({ x: cx + x * Math.cos(rot) - y * Math.sin(rot), y: cy + x * Math.sin(rot) + y * Math.cos(rot) });
  }
  ctx.fillStyle = css(rgb);
  smoothClosed(ctx, pts);
  ctx.fill();
}

export const cutout: ArtStyle = {
  draw(ctx, book, rand) {
    const sheet = Math.floor(rand() * SHEETS.length);
    const dark = sheet === SHEETS.length - 1;
    const tooth = noise2d(1.5, rand);
    ctx.putImageData(ground(ctx, SHEETS[sheet], (i) => 0.985 + 0.015 * tooth[i]), 0, 0);
    const S = book.strands;
    const N = book.chapters;
    const lanes = lanesOf(S.length);
    ctx.shadowColor = 'rgba(30,20,10,0.24)';
    ctx.shadowBlur = 3;
    ctx.shadowOffsetX = 1.2;
    ctx.shadowOffsetY = 1.8;
    const kinds = shuffled(CUTS, rand);
    S.forEach((s, i) => {
      const kind = kinds[i % kinds.length];
      const rgb: RGB = s.neutral ? (dark ? [236, 230, 218] : [40, 44, 58]) : vivid(s.rgb, 1.4, 1.02);
      for (const [a, b] of mergeRuns(runs(s.on), 1)) {
        const span = ((b - a + 1) / N) * H;
        const pieces = Math.max(1, Math.round(span / 110));
        for (let p = 0; p < pieces; p++) {
          const cy = ((a + ((p + 0.5) / pieces) * (b - a + 1)) / N) * H;
          const size = (34 + 54 * (Math.min(1.6, mean(book.wn, a, b)) / 1.6) ** 0.7) * (0.75 + 0.5 * rand());
          const sy = Math.min(170, Math.max(size, (span / pieces) * (0.8 + 0.4 * rand())));
          cutShape(ctx, kind, lanes[i] + (rand() - 0.5) * 50, cy, size, sy, rgb, rand);
        }
      }
      for (let k = 0, offcuts = 2 + Math.floor(rand() * 4); k < offcuts; k++) {
        const s0 = 6 + rand() * 10;
        cutShape(ctx, rand() < 0.5 ? 'seed' : 'burst', rand() * W, rand() * H, s0, s0 * (0.8 + rand()), rgb, rand);
      }
    });
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    return { dark };
  },
};
