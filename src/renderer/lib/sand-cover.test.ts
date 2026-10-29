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
  it('draws one band per storyline, or one neutral band for a book without storylines', () => {
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
    const [band] = drawSandCover({ seed: 7, chapters: 20, storylines: [{ chapters: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] }] });
    const carried = inkOnRows(band, Math.round(H * 0.1), Math.round(H * 0.4));
    const absent = inkOnRows(band, Math.round(H * 0.6), Math.round(H * 0.9));
    expect(absent).toBeGreaterThan(0);
    expect(carried).toBeGreaterThan(absent * 3);
  });

  it('sets the bands side by side in the storylines’ order and keeps every grain in 0–1', () => {
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
