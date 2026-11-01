/**
 * 年轮 — the book as a cut log: a ring for every chapter from the pith out,
 * wide where the chapter is long, stained in the colours of the storylines
 * that run through it; bark where the log ends inside the cover.
 */
import type { ArtStyle } from '../book';
import { COVER_HEIGHT as H, COVER_WIDTH as W, TAU, averageColor, css, ground, mix, noise2d, type RGB } from '../paint';

const LATEWOOD: RGB = [140, 92, 54];

function ringPath(cx: number, cy: number, r: Float32Array): Path2D {
  const p = new Path2D();
  const A = r.length;
  for (let a = 0; a <= A; a++) {
    const th = ((a % A) / A) * TAU;
    const x = cx + Math.cos(th) * r[a % A];
    const y = cy + Math.sin(th) * r[a % A];
    if (a) p.lineTo(x, y);
    else p.moveTo(x, y);
  }
  p.closePath();
  return p;
}

export const rings: ArtStyle = {
  draw(ctx, book, rand) {
    const grain = noise2d(1.5, rand);
    const cloud = noise2d(40, rand);
    ctx.putImageData(ground(ctx, [236, 216, 184], (i) => 0.95 + 0.04 * grain[i] + 0.03 * cloud[i]), 0, 0);
    const N = book.chapters;
    const cx = W * (0.12 + 0.76 * rand());
    const cy = H * (0.1 + 0.8 * rand());
    const far = Math.max(Math.hypot(cx, cy), Math.hypot(W - cx, cy), Math.hypot(cx, H - cy), Math.hypot(W - cx, H - cy));
    const reach = far * (0.72 + 0.4 * rand());
    const widths = Array.from({ length: N }, (_, c) => 0.3 + 0.7 * Math.min(2.2, book.wn[c]));
    const sum = widths.reduce((a, b) => a + b, 0);
    const A = 200;
    const wobble = Array.from({ length: 4 }, (_, k) => ({ k: k + 2, a: (0.1 / (k + 1)) * rand(), p: rand() * TAU }));
    // The tree grew more on one side.
    const ecc = 0.35 * rand();
    const lean = rand() * TAU;
    let r = new Float32Array(A).fill(2);
    const grown: Array<{ outer: Float32Array; mid: Float32Array; w: number; stain: RGB; present: boolean }> = [];
    for (let c = 0; c < N; c++) {
      const w = (widths[c] / sum) * reach;
      const outer = new Float32Array(A);
      const mid = new Float32Array(A);
      for (let a = 0; a < A; a++) {
        const th = (a / A) * TAU;
        let f = 1 + ecc * Math.cos(th - lean);
        for (const o of wobble) f += o.a * Math.sin(o.k * th + o.p + c * 0.04);
        outer[a] = r[a] + w * f;
        mid[a] = (r[a] + outer[a]) / 2;
      }
      const present = book.strands.filter((s) => !s.neutral && s.on[c]);
      grown.push({
        outer,
        mid,
        w,
        stain: present.length ? mix(LATEWOOD, averageColor(present.map((s) => s.rgb)), 0.65) : LATEWOOD,
        present: present.length > 0,
      });
      r = outer;
    }
    for (const ring of grown) {
      if (!ring.present) continue;
      ctx.strokeStyle = css(ring.stain, 0.16);
      ctx.lineWidth = ring.w;
      ctx.stroke(ringPath(cx, cy, ring.mid));
    }
    for (const ring of grown) {
      ctx.strokeStyle = css(ring.stain, ring.present ? 0.9 : 0.5);
      ctx.lineWidth = Math.max(0.6, ring.w * (ring.present ? 0.36 : 0.2));
      ctx.stroke(ringPath(cx, cy, ring.outer));
    }
    if (reach < far) {
      const bark = new Path2D();
      bark.rect(-5, -5, W + 10, H + 10);
      bark.addPath(ringPath(cx, cy, r.map((v) => v + 1)));
      ctx.save();
      ctx.fillStyle = css([92, 66, 46]);
      ctx.fill(bark, 'evenodd');
      ctx.clip(bark, 'evenodd');
      ctx.strokeStyle = 'rgba(40,26,16,0.5)';
      for (let k = 0; k < 160; k++) {
        const th = rand() * TAU;
        const rr = reach + 4 + rand() * far;
        const x = cx + Math.cos(th) * rr;
        const y = cy + Math.sin(th) * rr;
        const len = 6 + rand() * 14;
        ctx.lineWidth = 0.6 + rand() * 1.4;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(th) * len, y + Math.sin(th) * len);
        ctx.stroke();
      }
      ctx.restore();
    }
    // A check or two split from the pith.
    ctx.strokeStyle = 'rgba(70,44,24,0.55)';
    ctx.lineWidth = 1.1;
    for (let k = 0, checks = 1 + Math.floor(rand() * 2); k < checks; k++) {
      const th = rand() * TAU;
      let x = cx;
      let y = cy;
      ctx.beginPath();
      ctx.moveTo(x, y);
      const len = reach * (0.25 + 0.4 * rand());
      for (let s = 0; s < len; s += 4) {
        x += Math.cos(th + (rand() - 0.5) * 0.4) * 4;
        y += Math.sin(th + (rand() - 0.5) * 0.4) * 4;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(90,58,32,0.8)';
    ctx.beginPath();
    ctx.arc(cx, cy, 2.2, 0, TAU);
    ctx.fill();
    return { dark: false };
  },
};
