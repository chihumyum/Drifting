/**
 * 山脊 — every slice of the book a ridgeline, near ones hiding far ones; each
 * storyline rises as peaks in its own lane where it runs, higher where the
 * chapters are long, its peaks drawn in its colour.
 */
import { lanesOf, rowAt, type ArtStyle } from '../book';
import { COVER_HEIGHT as H, COVER_WIDTH as W, PAPER, css, ground, noise1d, type RGB } from '../paint';

const INK: RGB = [40, 36, 32];

export const ridge: ArtStyle = {
  draw(ctx, book, rand) {
    ctx.putImageData(ground(ctx, PAPER), 0, 0);
    const S = book.strands;
    const n = S.length;
    const lanes = lanesOf(n).map((x) => x + (rand() - 0.5) * 24);
    const sig = S.map(() => 9 + rand() * 14);
    const rows = 36 + Math.floor(rand() * 24);
    const top = 64 + rand() * 40;
    const gap = (H - 30 - top) / (rows - 1);
    const lift = gap * (4 + rand() * 5);
    const x0 = 16;
    const x1 = W - 16;
    ctx.lineJoin = 'round';
    for (let r = 0; r < rows; r++) {
      const k = rowAt(r / (rows - 1));
      const y0 = top + r * gap;
      const words = book.wordLevel[k];
      const jit = noise1d(W + 1, 2 + rand() * 3, rand);
      const pts: Array<{ x: number; y: number; dom: number }> = [];
      for (let x = x0; x <= x1; x += 1.5) {
        let h = 0;
        let dom = -1;
        let best = 0;
        for (let i = 0; i < n; i++) {
          const g = S[i].level[k] * (0.45 + 0.55 * Math.min(1.8, words)) * Math.exp(-((x - lanes[i]) ** 2) / (2 * sig[i] ** 2));
          h += g;
          if (g > best) { best = g; dom = i; }
        }
        const j = jit[Math.floor(x)];
        const calm = Math.exp(-((x - W / 2) ** 2) / (2 * (W * 0.3) ** 2));
        h = h * lift * (0.7 + 0.6 * j) + calm * gap * 0.5 * j;
        pts.push({ x, y: y0 - h, dom: best > 0.06 ? dom : -1 });
      }
      // Paper under the line hides the ridges behind it.
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (const p of pts) ctx.lineTo(p.x, p.y);
      ctx.lineTo(x1, H + 2);
      ctx.lineTo(x0, H + 2);
      ctx.closePath();
      ctx.fillStyle = css(PAPER);
      ctx.fill();
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.strokeStyle = css(INK, 0.82);
      ctx.lineWidth = 1.15;
      ctx.stroke();
      for (let i = 0; i < n; i++) {
        if (S[i].neutral) continue;
        ctx.beginPath();
        let on = false;
        for (const p of pts) {
          if (p.dom !== i) { on = false; continue; }
          if (on) ctx.lineTo(p.x, p.y);
          else ctx.moveTo(p.x, p.y);
          on = true;
        }
        ctx.strokeStyle = css(S[i].rgb, 0.95);
        ctx.lineWidth = 1.7;
        ctx.stroke();
      }
    }
    return { dark: false };
  },
};
