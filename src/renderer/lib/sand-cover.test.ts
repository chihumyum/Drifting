import { describe, expect, it } from 'vitest';
import { COVER_MASK_HEIGHT, COVER_MASK_WIDTH, coverSeed, drawSandCover } from './sand-cover';

const W = COVER_MASK_WIDTH;
const H = COVER_MASK_HEIGHT;

/** How much sand lies on rows [from, to) of a mask, per row. */
function inkOnRows(mask: Float32Array, from: number, to: number) {
  let sum = 0;
  for (let y = from; y < to; y++) for (let x = 0; x < W; x++) sum += mask[y * W + x];
  return sum / (to - from);
}

describe('shelf cover sand', () => {
  it('draws one stroke per storyline, or one neutral stroke for a book without storylines', () => {
    expect(drawSandCover({ seed: 1, chapters: 12, storylines: [{ chapters: [0] }, { chapters: [1] }, { chapters: [] }] })).toHaveLength(3);
    const [neutral] = drawSandCover({ seed: 1, chapters: 3, storylines: [] });
    expect(neutral).toHaveLength(W * H);
    expect(inkOnRows(neutral, 0, H)).toBeGreaterThan(0);
  });

  it('is the same cover every time for the same book, and another for another book', () => {
    const request = { chapters: 20, storylines: [{ chapters: [0, 1, 2, 9] }, { chapters: [5, 6] }] };
    const a = drawSandCover({ seed: coverSeed('book-a'), ...request });
    const again = drawSandCover({ seed: coverSeed('book-a'), ...request });
    const b = drawSandCover({ seed: coverSeed('book-b'), ...request });
    expect(again).toEqual(a);
    expect(b[0]).not.toEqual(a[0]);
    expect(coverSeed('book-a')).toBe(coverSeed('book-a'));
  });

  it('runs thick through the chapters a storyline carries and thin where it is absent', () => {
    // The first half of the book carries the storyline; the second does not.
    const [stroke] = drawSandCover({ seed: 7, chapters: 20, storylines: [{ chapters: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] }] });
    const carried = inkOnRows(stroke, Math.round(H * 0.1), Math.round(H * 0.4));
    const absent = inkOnRows(stroke, Math.round(H * 0.6), Math.round(H * 0.9));
    expect(absent).toBeGreaterThan(0);
    expect(carried).toBeGreaterThan(absent * 3);
  });

  it('scribbles from side to side on its way down', () => {
    const [stroke] = drawSandCover({ seed: 11, chapters: 12, storylines: [{ chapters: Array.from({ length: 12 }, (_, i) => i) }] });
    // Where the ink lies across each row: the stroke turns back many times.
    let turns = 0;
    let last = 0;
    let heading = 0;
    for (let y = 0; y < H; y += 4) {
      let sum = 0;
      let weight = 0;
      for (let x = 0; x < W; x++) { sum += x * stroke[y * W + x]; weight += stroke[y * W + x]; }
      if (!weight) continue;
      const centre = sum / weight;
      const step = centre - last;
      if (last && Math.abs(step) > 6) {
        if (heading && Math.sign(step) !== heading) turns++;
        heading = Math.sign(step);
      }
      last = centre;
    }
    expect(turns).toBeGreaterThanOrEqual(5);
  });

  it('runs thicker through long chapters, loosely', () => {
    const all = Array.from({ length: 20 }, (_, i) => i);
    // Long chapters in the first half, short ones in the second.
    const words = all.map((i) => (i < 10 ? 6000 : 600));
    const [stroke] = drawSandCover({ seed: 5, chapters: 20, storylines: [{ chapters: all }], words });
    const long = inkOnRows(stroke, Math.round(H * 0.1), Math.round(H * 0.4));
    const short = inkOnRows(stroke, Math.round(H * 0.6), Math.round(H * 0.9));
    expect(long).toBeGreaterThan(short * 1.3);
    // Even chapters do not make an even stroke: the hand's pressure wanders.
    const [even] = drawSandCover({ seed: 5, chapters: 20, storylines: [{ chapters: all }], words: all.map(() => 3000) });
    const thirds = [0, 1, 2].map((t) => inkOnRows(even, Math.round((H * t) / 3), Math.round((H * (t + 1)) / 3)));
    expect(Math.max(...thirds) / Math.min(...thirds)).toBeGreaterThan(1.1);
  });

  it('draws one neutral stroke for a book whose storylines carry no chapter', () => {
    const masks = drawSandCover({ seed: 9, chapters: 8, storylines: [{ chapters: [] }, { chapters: [] }] });
    expect(masks).toHaveLength(1);
    expect(inkOnRows(masks[0], 0, H)).toBeGreaterThan(0);
  });

  it('sets the strokes in the storylines’ order from left to right and keeps every grain in 0–1', () => {
    const all = Array.from({ length: 10 }, (_, i) => i);
    const masks = drawSandCover({ seed: 3, chapters: 10, storylines: [{ chapters: all }, { chapters: all }, { chapters: all }] });
    const centre = (mask: Float32Array) => {
      let sum = 0;
      let weight = 0;
      mask.forEach((a, i) => { sum += (i % W) * a; weight += a; });
      return sum / weight;
    };
    const centres = masks.map(centre);
    expect(centres[0]).toBeLessThan(centres[1]);
    expect(centres[1]).toBeLessThan(centres[2]);
    for (const mask of masks) expect(mask.every((a) => a >= 0 && a <= 1)).toBe(true);
  });
});
