/**
 * 蓝晒 — a cyanotype: each storyline a plant laid on the coated paper, a leaf
 * shape of its own, a leaf for every chapter it carries, large where the
 * chapter is long; the plants print white on Prussian blue.
 */
import { lanesOf, shuffled, type ArtStyle } from '../book';
import { COVER_HEIGHT as H, COVER_WIDTH as W, PAPER, TAU, noise2d, smoothstep, type Paint, type RGB } from '../paint';

type Leaf = 'ellipse' | 'lance' | 'fan' | 'frond' | 'blade' | 'round';
const LEAVES: Leaf[] = ['ellipse', 'lance', 'fan', 'frond', 'blade', 'round'];
const BLUE: RGB = [22, 58, 112];

function leaf(ctx: Paint, kind: Leaf, x: number, y: number, ang: number, L: number, rand: () => number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  const white = `rgba(240,246,253,${0.74 + rand() * 0.2})`;
  const vein = 'rgba(36,76,136,0.4)';
  ctx.fillStyle = white;
  if (kind === 'ellipse' || kind === 'lance') {
    const w = kind === 'ellipse' ? L * 0.34 : L * 0.15;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(L * 0.45, -w * 1.6, L, 0);
    ctx.quadraticCurveTo(L * 0.45, w * 1.6, 0, 0);
    ctx.fill();
    ctx.strokeStyle = vein;
    ctx.lineWidth = 0.55;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(L * 0.9, 0);
    for (let k = 1; k < 4; k++) {
      const a = (k / 4) * L * 0.9;
      ctx.moveTo(a, 0);
      ctx.lineTo(a + L * 0.13, -w * 0.6);
      ctx.moveTo(a, 0);
      ctx.lineTo(a + L * 0.13, w * 0.6);
    }
    ctx.stroke();
  } else if (kind === 'fan') {
    ctx.strokeStyle = white;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(L * 0.45, 0);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(L * 0.4, 0);
    ctx.arc(L * 0.4, 0, L * 0.62, -0.8, -0.06);
    ctx.lineTo(L * 0.88, 0);
    ctx.arc(L * 0.4, 0, L * 0.62, 0.06, 0.8);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = vein;
    ctx.lineWidth = 0.45;
    ctx.beginPath();
    for (let k = -4; k <= 4; k++) {
      ctx.moveTo(L * 0.4, 0);
      ctx.lineTo(L * 0.4 + Math.cos(k * 0.18) * L * 0.6, Math.sin(k * 0.18) * L * 0.6);
    }
    ctx.stroke();
  } else if (kind === 'frond') {
    ctx.strokeStyle = white;
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(L * 1.25, 0);
    ctx.stroke();
    for (let k = 1; k <= 8; k++) {
      const a = (k / 9) * L * 1.25;
      const s = L * 0.24 * (1 - k / 10);
      ctx.beginPath();
      ctx.ellipse(a, -s * 0.75, s, s * 0.32, -0.9, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(a, s * 0.75, s, s * 0.32, 0.9, 0, TAU);
      ctx.fill();
    }
  } else if (kind === 'blade') {
    const bend = (rand() - 0.5) * L * 0.7;
    ctx.beginPath();
    ctx.moveTo(0, -1.3);
    ctx.quadraticCurveTo(L * 0.7, bend - 1.6, L * 1.6, bend * 1.7);
    ctx.quadraticCurveTo(L * 0.7, bend + 1.6, 0, 1.3);
    ctx.fill();
  } else {
    ctx.strokeStyle = white;
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(L * 0.5, 0);
    ctx.stroke();
    const r = L * 0.42;
    const cx = L * 0.5 + r * 0.7;
    ctx.beginPath();
    ctx.arc(cx, 0, r, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = vein;
    ctx.lineWidth = 0.45;
    ctx.beginPath();
    for (let k = 0; k < 9; k++) {
      const a = (k / 9) * TAU;
      ctx.moveTo(cx - r * 0.3, 0);
      ctx.lineTo(cx + Math.cos(a) * r * 0.9, Math.sin(a) * r * 0.9);
    }
    ctx.stroke();
  }
  ctx.restore();
}

export const cyanotype: ArtStyle = {
  draw(ctx, book, rand) {
    const mottle = noise2d(26, rand);
    const fine = noise2d(2, rand);
    const edgeN = noise2d(9, rand);
    const streak = noise2d(60, rand, 3);
    // The coat is brushed on by hand, so its edge is ragged and the paper shows past it.
    const m = 6 + rand() * 9;
    const img = ctx.createImageData(W, H);
    const d = img.data;
    for (let i = 0; i < W * H; i++) {
      const x = i % W;
      const y = (i / W) | 0;
      const edge = Math.min(x, y, W - 1 - x, H - 1 - y);
      const coat = smoothstep(m * 0.2, m, edge + (edgeN[i] - 0.5) * m * 1.8);
      const tone = 0.8 + 0.28 * mottle[i] + 0.08 * streak[i] + 0.05 * fine[i];
      for (let k = 0; k < 3; k++) d[i * 4 + k] = PAPER[k] + (BLUE[k] * tone - PAPER[k]) * coat;
      d[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const S = book.strands;
    const N = book.chapters;
    const lanes = lanesOf(S.length);
    const kinds = shuffled(LEAVES, rand);
    ctx.shadowColor = 'rgba(232,242,255,0.8)';
    ctx.shadowBlur = 2.5;
    S.forEach((s, i) => {
      const kind = kinds[i % kinds.length];
      const xb = lanes[i] + (rand() - 0.5) * 30;
      const xt = lanes[i] + (rand() - 0.5) * 50;
      const bend = (rand() - 0.5) * 70;
      const P = (u: number) => ({ x: xt + (xb - xt) * u + Math.sin(u * Math.PI) * bend, y: -12 + u * (H + 24) });
      ctx.strokeStyle = 'rgba(238,244,252,0.88)';
      ctx.lineCap = 'round';
      ctx.lineWidth = 1.2 + rand() * 1.1;
      ctx.beginPath();
      for (let u = 0; u <= 1.0001; u += 0.01) {
        const p = P(u);
        if (u) ctx.lineTo(p.x, p.y);
        else ctx.moveTo(p.x, p.y);
      }
      ctx.stroke();
      let side = rand() < 0.5 ? -1 : 1;
      for (let c = 0; c < N; c++) {
        if (!s.on[c]) continue;
        const u = (c + 0.5) / N;
        const p = P(u);
        const q = P(Math.min(1, u + 0.01));
        const up = Math.atan2(q.y - p.y, q.x - p.x) + Math.PI;
        const L = (8 + 13 * Math.min(1.7, book.wn[c])) * (0.8 + 0.4 * rand());
        leaf(ctx, kind, p.x, p.y, up + side * (0.45 + 0.55 * rand()), L, rand);
        side = -side;
      }
    });
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    // Dust and seeds caught in the exposure.
    for (let k = 0; k < 46; k++) {
      ctx.fillStyle = `rgba(236,244,252,${0.12 + rand() * 0.35})`;
      ctx.beginPath();
      ctx.arc(rand() * W, rand() * H, 0.4 + rand() * 1.1, 0, TAU);
      ctx.fill();
    }
    return { dark: true };
  },
};
