/**
 * 包豪斯 — a grid of the book's movements (rows) by its storylines (columns):
 * where a storyline carries a movement it gets a bold primitive in its
 * colour, large where the words run long; small black marks elsewhere.
 */
import { mean, type ArtStyle } from '../book';
import { COVER_HEIGHT as H, COVER_WIDTH as W, TAU, clamp, css, ground, noise2d, vivid, type Paint, type RGB } from '../paint';

const BLACK: RGB = [30, 28, 28];

function primitive(ctx: Paint, x: number, y: number, cw: number, rh: number, scale: number, rgb: RGB, rand: () => number) {
  const s = Math.min(cw, rh) * scale;
  const cx = x + cw / 2;
  const cy = y + rh / 2;
  const kind = Math.floor(rand() * 6);
  const turn = Math.floor(rand() * 4);
  const rot = turn * (Math.PI / 2);
  ctx.fillStyle = css(rgb);
  ctx.strokeStyle = css(rgb);
  ctx.beginPath();
  if (kind === 0) ctx.arc(cx, cy, s / 2, 0, TAU);
  else if (kind === 1) {
    ctx.arc(cx, cy, s / 2, rot, rot + Math.PI);
    ctx.closePath();
  } else if (kind === 2) {
    // A quarter disc from one corner of the cell.
    const qx = cx + (turn === 0 || turn === 3 ? -1 : 1) * (s / 2);
    const qy = cy + (turn < 2 ? -1 : 1) * (s / 2);
    const toward = Math.atan2(cy - qy, cx - qx);
    ctx.moveTo(qx, qy);
    ctx.arc(qx, qy, s, toward - Math.PI / 4, toward + Math.PI / 4);
    ctx.closePath();
  } else if (kind === 3) {
    ctx.moveTo(cx + (Math.cos(rot) * s) / 2, cy + (Math.sin(rot) * s) / 2);
    ctx.lineTo(cx + (Math.cos(rot + 2.1) * s) / 2, cy + (Math.sin(rot + 2.1) * s) / 2);
    ctx.lineTo(cx + (Math.cos(rot + 4.2) * s) / 2, cy + (Math.sin(rot + 4.2) * s) / 2);
    ctx.closePath();
  } else if (kind === 4) ctx.rect(cx - s / 2, cy - s / 2, s, s);
  else {
    ctx.arc(cx, cy, s * 0.4, 0, TAU);
    ctx.lineWidth = s * 0.18;
    ctx.stroke();
    return;
  }
  ctx.fill();
}

export const bauhaus: ArtStyle = {
  draw(ctx, book, rand) {
    const tooth = noise2d(1.6, rand);
    ctx.putImageData(ground(ctx, [241, 236, 225], (i) => 0.985 + 0.015 * tooth[i]), 0, 0);
    const S = book.strands;
    const n = S.length;
    const N = book.chapters;
    const cols = n <= 1 ? 2 : Math.min(4, n);
    const rows = clamp(Math.round(N / (2 + rand() * 3)), 5, 9);
    const mx = 10;
    const top = 10;
    const cw = (W - 2 * mx) / cols;
    const rh = (H - top - 10) / rows;
    // Overlapping shapes overprint.
    ctx.globalCompositeOperation = 'multiply';
    for (let r = 0; r < rows; r++) {
      const c0 = Math.min(N - 1, Math.floor((r / rows) * N));
      const c1 = Math.max(c0, Math.floor(((r + 1) / rows) * N) - 1);
      const words = Math.min(1.8, mean(book.wn, c0, c1)) / 1.8;
      for (let k = 0; k < cols; k++) {
        const s = S[k % n];
        const x = mx + k * cw;
        const y = top + r * rh;
        if (mean(s.on, c0, c1) > 0.34) {
          primitive(ctx, x, y, cw, rh, (0.5 + 0.7 * words) * (0.85 + 0.3 * rand()), s.neutral ? BLACK : vivid(s.rgb, 1.35, 1), rand);
        } else if (rand() < 0.2) {
          ctx.fillStyle = css(BLACK);
          if (rand() < 0.5) {
            ctx.beginPath();
            ctx.arc(x + cw / 2, y + rh / 2, 2.6, 0, TAU);
            ctx.fill();
          } else ctx.fillRect(x + cw * 0.2, y + rh / 2 - 1, cw * 0.6, 2);
        }
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    if (rand() < 0.6) {
      ctx.fillStyle = css(BLACK);
      ctx.fillRect(mx, top + Math.floor(rand() * rows) * rh - 1.5, W - 2 * mx, 3);
    }
    return { dark: false };
  },
};
