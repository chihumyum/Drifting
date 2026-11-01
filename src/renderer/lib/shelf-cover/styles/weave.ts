/**
 * 织物 — a woven cloth: each storyline a band of dyed warp threads that float
 * over the weft through the chapters it carries and dip under elsewhere; a
 * chapter is a band of weft, thick where it is long.
 */
import { lanesOf, type ArtStyle } from '../book';
import { COVER_HEIGHT as H, COVER_WIDTH as W, css, mix, type Paint, type RGB } from '../paint';

const DARK: RGB = [30, 20, 10];
const WHITE: RGB = [255, 255, 255];

function threadCell(ctx: Paint, x: number, y: number, w: number, h: number, rgb: RGB, vertical: boolean, rand: () => number) {
  const j = () => (rand() - 0.5) * 0.5;
  ctx.fillStyle = css(rgb);
  ctx.fillRect(x + 0.4 + j(), y + 0.35 + j(), w - 0.8, h - 0.7);
  ctx.fillStyle = css(mix(rgb, DARK, 0.28), 0.5);
  if (vertical) {
    ctx.fillRect(x + 0.4, y, 0.9, h);
    ctx.fillRect(x + w - 1.3, y, 0.9, h);
    ctx.fillStyle = css(mix(rgb, WHITE, 0.28), 0.6);
    ctx.fillRect(x + w * 0.36, y + 0.6, w * 0.16, h - 1.2);
  } else {
    ctx.fillRect(x, y + 0.35, w, 0.8);
    ctx.fillRect(x, y + h - 1.15, w, 0.8);
    ctx.fillStyle = css(mix(rgb, WHITE, 0.28), 0.55);
    ctx.fillRect(x + 0.7, y + h * 0.36, w - 1.4, Math.max(0.6, h * 0.14));
  }
}

export const weave: ArtStyle = {
  draw(ctx, book, rand) {
    const S = book.strands.filter((s) => !s.neutral);
    const N = book.chapters;
    const linen: RGB = [226, 216, 196];
    const weft = mix(linen, WHITE, 0.3);
    const heights = Array.from({ length: N }, (_, c) => 0.45 + 0.55 * Math.min(2, book.wn[c]));
    const scale = (H + 4) / heights.reduce((a, b) => a + b, 0);
    const tw = 6 + rand() * 2.5;
    const T = Math.ceil(W / tw) + 1;
    const band = new Array<number>(T).fill(-1);
    const lanes = lanesOf(Math.max(1, S.length));
    S.forEach((_, i) => {
      const k = 3 + Math.floor(rand() * 4);
      const c0 = Math.round(lanes[i] / tw - k / 2);
      for (let j = c0; j < c0 + k; j++) if (j >= 0 && j < T) band[j] = i;
    });
    // A book without storylines: one dark band, weft-faced where chapters run long.
    const plain = S.length === 0;
    ctx.fillStyle = css(mix(linen, [60, 50, 40], 0.35));
    ctx.fillRect(0, 0, W, H);
    let y = -2;
    let pick = 0;
    for (let c = 0; c < N; c++) {
      const h = heights[c] * scale;
      const picks = Math.max(1, Math.round(h / (6 + rand() * 3)));
      const wc = mix(weft, [205, 192, 168], rand() * 0.3);
      for (let p = 0; p < picks; p++, pick++) {
        const ph = h / picks;
        for (let j = 0; j < T; j++) {
          const x = j * tw - 1;
          const i = band[j];
          let over: boolean;
          let warp: RGB;
          if (i >= 0) {
            over = S[i].on[c] ? true : (j + pick) % 3 === 0;
            warp = S[i].rgb;
          } else if (plain && j > T * 0.3 && j < T * 0.7) {
            over = book.wn[c] > 1 ? (j + pick) % 4 === 0 : (j + pick) % 2 === 0;
            warp = [72, 70, 74];
          } else {
            over = (j + pick) % 2 === 0;
            warp = mix(linen, [150, 135, 110], 0.12 + (0.12 * ((j * 7) % 3)) / 2);
          }
          threadCell(ctx, x, y, tw, ph, over ? warp : wc, over, rand);
        }
        y += ph;
      }
    }
    return { dark: false };
  },
};
