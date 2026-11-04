/**
 * 字海 — a page of type, faint, through which each storyline runs as a
 * current of its colour, wider and bolder where the chapters are long. The
 * type follows the title: Latin letters for a Latin title, characters
 * otherwise.
 */
import { lanesOf, rowAt, type ArtStyle } from '../book';
import { COVER_HEIGHT as H, COVER_WIDTH as W, PAPER, css, ground, noise1d } from '../paint';

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const CHARACTERS =
  '的一是在不了有和人这中大为上个我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说种面而方后多定行学法所得经十三之进着等部度家力里如水化高自二理起小物现实加量都两体制机当使点从本去把性好应开它合还因由其些然前外天四日那事平形相全表间样与关各重新线内数正心反你明看原又么利比但气第向道命此变条只没结解问意建月无系很情者最立代想已通并提直题展五果料象位入常文总次品式活设管特件长求老头基资边流路少图山接知较将见计别她手角期根论运指几九区放决西被干做必先回则任取处雨雾海灯夜潮川风云';

export const chars: ArtStyle = {
  draw(ctx, book, rand) {
    ctx.putImageData(ground(ctx, PAPER), 0, 0);
    const S = book.strands;
    const pool = book.latin ? LETTERS : CHARACTERS;
    const cw = book.latin ? 9.5 : 12;
    const ch = book.latin ? 13 : 13.5;
    const cols = Math.floor((W - 6) / cw);
    const rows = Math.floor((H - 6) / ch);
    const ox = (W - cols * cw) / 2;
    const oy = (H - rows * ch) / 2;
    const lanes = lanesOf(S.length);
    const meander = S.map(() => noise1d(rows + 1, 4 + rand() * 6, rand));
    const font = book.latin ? 'ui-monospace, Menlo, Consolas, monospace' : '"Songti SC", "Noto Serif SC Variable", "Noto Serif SC", serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let r = 0; r < rows; r++) {
      const k = rowAt(r / (rows - 1));
      const words = book.wordLevel[k];
      for (let c = 0; c < cols; c++) {
        const x = ox + (c + 0.5) * cw;
        const y = oy + (r + 0.5) * ch;
        let best = 0;
        let dom = -1;
        S.forEach((s, i) => {
          const lx = lanes[i] + (meander[i][r] - 0.5) * 60;
          const sg = 8 + 12 * Math.min(1.8, words);
          const v = s.level[k] * Math.exp(-((x - lx) ** 2) / (2 * sg * sg));
          if (v > best) { best = v; dom = i; }
        });
        const glyph = pool[Math.floor(rand() * pool.length)];
        if (best > 0.12) {
          ctx.fillStyle = css(S[dom].neutral ? [50, 48, 46] : S[dom].rgb, 0.35 + 0.65 * Math.min(1, best));
          ctx.font = `${best > 0.6 ? 600 : 400} ${(book.latin ? 10 : 10.5) + 2.5 * Math.min(1, best)}px ${font}`;
        } else {
          ctx.fillStyle = 'rgba(60,56,50,0.075)';
          ctx.font = `400 ${book.latin ? 9.5 : 10}px ${font}`;
        }
        ctx.fillText(glyph, x, y);
      }
    }
    return { dark: false };
  },
};
