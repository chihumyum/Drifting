/**
 * 结绳 — a quipu: each storyline a dyed cord hung from one rope, its chapters
 * tied as knots down the cord, a run of chapters as a long knot, the knots
 * fat where the chapters are long.
 */
import { lanesOf, mean, runs, type ArtStyle } from '../book';
import { COVER_HEIGHT as H, COVER_WIDTH as W, TAU, clamp, css, ground, mix, noise1d, noise2d, type Paint, type Point, type RGB } from '../paint';

const DARK: RGB = [40, 28, 16];
const WHITE: RGB = [255, 255, 255];

function rope(ctx: Paint, pts: readonly Point[], w: number, rgb: RGB) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const line = (dx = 0, dy = 0) => {
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x + dx, p.y + dy) : ctx.moveTo(p.x + dx, p.y + dy)));
  };
  line(0.6, 0.8);
  ctx.strokeStyle = 'rgba(60,40,20,0.18)';
  ctx.lineWidth = w + 1.2;
  ctx.stroke();
  line();
  ctx.strokeStyle = css(rgb);
  ctx.lineWidth = w;
  ctx.stroke();
  // The twist: short diagonals across the cord.
  ctx.strokeStyle = css(mix(rgb, DARK, 0.38), 0.55);
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  let along = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    along += len;
    if (along < w * 0.8) continue;
    along = 0;
    const tx = (b.x - a.x) / len;
    const ty = (b.y - a.y) / len;
    const h = w / 2;
    ctx.moveTo(b.x - ty * h - tx * h * 0.7, b.y + tx * h - ty * h * 0.7);
    ctx.lineTo(b.x + ty * h + tx * h * 0.7, b.y - tx * h + ty * h * 0.7);
  }
  ctx.stroke();
  line(-w * 0.2, -w * 0.2);
  ctx.strokeStyle = css(mix(rgb, WHITE, 0.35), 0.45);
  ctx.lineWidth = Math.max(0.6, w * 0.18);
  ctx.stroke();
}

function knot(ctx: Paint, x: number, y: number, r: number, rgb: RGB, rand: () => number) {
  const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r * 1.15);
  g.addColorStop(0, css(mix(rgb, WHITE, 0.32)));
  g.addColorStop(0.55, css(rgb));
  g.addColorStop(1, css(mix(rgb, DARK, 0.45)));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(x, y, r * 0.95, r * 1.08, (rand() - 0.5) * 0.5, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = css(mix(rgb, DARK, 0.5), 0.5);
  ctx.lineWidth = 0.7;
  for (let k = -1; k <= 1; k++) {
    ctx.beginPath();
    ctx.ellipse(x, y + k * r * 0.38, r * 0.88, r * 0.3, 0.3, 0.1 * Math.PI, 0.9 * Math.PI);
    ctx.stroke();
  }
}

function longKnot(ctx: Paint, at: (y: number) => number, ya: number, yb: number, r: number, rgb: RGB) {
  const pts: Point[] = [];
  for (let y = ya; y <= yb; y += 1.5) pts.push({ x: at(y), y });
  const line = (dx = 0) => {
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x + dx, p.y) : ctx.moveTo(p.x + dx, p.y)));
  };
  ctx.lineCap = 'round';
  line();
  ctx.strokeStyle = css(mix(rgb, DARK, 0.42));
  ctx.lineWidth = r * 2 + 1;
  ctx.stroke();
  ctx.strokeStyle = css(rgb);
  ctx.lineWidth = r * 2 - 0.6;
  ctx.stroke();
  line(-r * 0.4);
  ctx.strokeStyle = css(mix(rgb, WHITE, 0.3), 0.55);
  ctx.lineWidth = r * 0.5;
  ctx.stroke();
  ctx.strokeStyle = css(mix(rgb, DARK, 0.5), 0.5);
  ctx.lineWidth = 0.75;
  for (let y = ya; y <= yb; y += 2.3) {
    const x = at(y);
    ctx.beginPath();
    ctx.moveTo(x - r, y - r * 0.3);
    ctx.quadraticCurveTo(x, y + r * 0.4, x + r, y - r * 0.3);
    ctx.stroke();
  }
}

export const quipu: ArtStyle = {
  draw(ctx, book, rand) {
    const fibre = noise2d(1.4, rand);
    const mottle = noise2d(30, rand);
    ctx.putImageData(ground(ctx, [238, 229, 211], (i) => 0.97 + 0.02 * fibre[i] + 0.025 * mottle[i]), 0, 0);
    const S = book.strands;
    const N = book.chapters;
    const top = 18 + rand() * 8;
    const sag = 4 + rand() * 9;
    const primaryY = (x: number) => top + sag * Math.sin((x / W) * Math.PI);
    const lanes = lanesOf(S.length).map((x) => x + (rand() - 0.5) * 16);
    S.forEach((s, i) => {
      const cord: RGB = s.neutral ? [212, 198, 170] : mix(s.rgb, [235, 225, 205], 0.1);
      const x0 = lanes[i];
      const y0 = primaryY(x0);
      const end = H - 10 - rand() * 46;
      const sway = noise1d(H + 2, 90 + rand() * 80, rand);
      const amp = 10 + rand() * 22;
      const at = (y: number) => x0 + (sway[Math.floor(clamp(y, 0, H))] - sway[Math.floor(y0)]) * amp;
      const pts: Point[] = [];
      for (let y = y0; y <= end; y += 2) pts.push({ x: at(y), y });
      const cw = 3.2 + rand() * 1.4;
      rope(ctx, pts, cw, cord);
      const span0 = y0 + 16;
      const step = (end - 12 - span0) / N;
      const yAt = (c: number) => span0 + (c + 0.5) * step;
      for (const [a, b] of runs(s.on)) {
        // A long run is tied as several long knots.
        for (let c = a; c <= b; c += 6) {
          const e = Math.min(b, c + 5);
          const words = Math.min(1.8, mean(book.wn, c, e));
          if (e === c) knot(ctx, at(yAt(c)), yAt(c), cw * (1.15 + 0.6 * words), cord, rand);
          else longKnot(ctx, at, yAt(c) - step * 0.3, yAt(e) + step * 0.3, cw * (0.95 + 0.35 * words), cord);
        }
      }
      // The frayed end.
      ctx.strokeStyle = css(cord, 0.85);
      ctx.lineWidth = 0.8;
      for (let k = 0; k < 7; k++) {
        ctx.beginPath();
        ctx.moveTo(at(end), end);
        ctx.quadraticCurveTo(at(end) + (rand() - 0.5) * cw * 2, end + 5, at(end) + (rand() - 0.5) * cw * 3.2, end + 7 + rand() * 7);
        ctx.stroke();
      }
    });
    const primary: Point[] = [];
    for (let x = -10; x <= W + 10; x += 2) primary.push({ x, y: primaryY(x) });
    rope(ctx, primary, 5.6, [190, 164, 120]);
    return { dark: false };
  },
};
