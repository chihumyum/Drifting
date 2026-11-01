/**
 * 星图 — a star chart: a storyline's chapters are its stars, bright where the
 * chapter is long, joined into a constellation while the storyline runs and
 * broken where it is away; field stars and a faint graticule behind.
 */
import { lanesOf, type ArtStyle } from '../book';
import { COVER_HEIGHT as H, COVER_WIDTH as W, TAU, clamp, css, ground, mix, noise2d, vivid, type Paint, type RGB } from '../paint';

const WHITE: RGB = [255, 255, 255];

function glowStar(ctx: Paint, x: number, y: number, r: number, rgb: RGB) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r * 5);
  g.addColorStop(0, css(rgb, 0.45));
  g.addColorStop(1, css(rgb, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r * 5, 0, TAU);
  ctx.fill();
  ctx.fillStyle = css(mix(rgb, WHITE, 0.65));
  ctx.beginPath();
  ctx.arc(x, y, r * 0.7, 0, TAU);
  ctx.fill();
  if (r > 2.3) {
    ctx.strokeStyle = css(rgb, 0.5);
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(x - r * 4, y);
    ctx.lineTo(x + r * 4, y);
    ctx.moveTo(x, y - r * 4);
    ctx.lineTo(x, y + r * 4);
    ctx.stroke();
  }
}

export const stars: ArtStyle = {
  draw(ctx, book, rand) {
    const neb = noise2d(60, rand);
    const fine = noise2d(3, rand);
    ctx.putImageData(
      ground(ctx, [15, 20, 36], (i, x, y) => 0.85 + 0.4 * neb[i] * (1 - Math.hypot(x / W - 0.5, y / H - 0.5)) + 0.04 * fine[i]),
      0,
      0,
    );
    ctx.strokeStyle = 'rgba(200,215,255,0.07)';
    ctx.lineWidth = 0.7;
    const gcx = W * (rand() * 2 - 0.5);
    const gcy = -H * (0.6 + rand());
    for (let k = 1; k <= 9; k++) {
      ctx.beginPath();
      ctx.arc(gcx, gcy, H * 0.6 + k * 46, 0, TAU);
      ctx.stroke();
    }
    ctx.beginPath();
    for (let k = -7; k <= 7; k++) {
      const a = Math.PI / 2 + k * 0.12;
      ctx.moveTo(gcx, gcy);
      ctx.lineTo(gcx + Math.cos(a) * H * 3, gcy + Math.sin(a) * H * 3);
    }
    ctx.stroke();
    for (let k = 0; k < 220; k++) {
      ctx.fillStyle = `rgba(230,236,255,${0.1 + rand() * 0.45})`;
      ctx.beginPath();
      ctx.arc(rand() * W, rand() * H, 0.35 + rand() * 0.6, 0, TAU);
      ctx.fill();
    }
    const S = book.strands;
    const N = book.chapters;
    const lanes = lanesOf(S.length);
    S.forEach((s, i) => {
      const tint: RGB = s.neutral ? [220, 226, 240] : mix(vivid(s.rgb, 1.25, 1), WHITE, 0.35);
      let x = lanes[i];
      const placed: Array<{ x: number; y: number; mag: number } | null> = [];
      for (let c = 0; c < N; c++) {
        // A random walk held near its lane.
        x += (rand() - 0.5) * 28;
        x += (lanes[i] - x) * 0.22;
        if (!s.on[c]) { placed.push(null); continue; }
        const y = 30 + ((c + 0.5) / N) * (H - 56) + (rand() - 0.5) * 10;
        placed.push({ x: clamp(x + (rand() - 0.5) * 12, 8, W - 8), y, mag: 0.8 + 2.5 * (Math.min(1.8, book.wn[c]) / 1.8) ** 0.8 });
      }
      ctx.strokeStyle = css(tint, 0.42);
      ctx.lineWidth = 0.75;
      ctx.beginPath();
      let last: { x: number; y: number } | null = null;
      let lastC = -9;
      placed.forEach((star, c) => {
        if (!star) return;
        if (last && c - lastC <= 3) {
          ctx.moveTo(last.x, last.y);
          ctx.lineTo(star.x, star.y);
        }
        last = star;
        lastC = c;
      });
      ctx.stroke();
      for (const star of placed) if (star) glowStar(ctx, star.x, star.y, star.mag, tint);
    });
    return { dark: true };
  },
};
