import { describe, expect, it } from 'vitest';
import { drawSandStroke, rgbOfComputedColour, SAND_FRAME_PAD, type SandStroke } from './sand-frame';

const DPR = 2;
const PAD = SAND_FRAME_PAD * DPR;

const row = (stroke: SandStroke, y: number, from: number, to: number) =>
  Array.from(stroke.alpha.subarray(y * stroke.width + from, y * stroke.width + to));

/** Device px of ink (alpha over 0.3) down one column, between two rows. */
const inkDown = (stroke: SandStroke, x: number, y0: number, y1: number) => {
  let n = 0;
  for (let y = y0; y < y1; y++) if (stroke.alpha[y * stroke.width + x] > 0.3) n++;
  return n;
};

describe('a sand frame drawn for its cell', () => {
  it('draws the same stroke for the same seed and another for another seed', () => {
    const a = drawSandStroke({ width: 200, height: 30, dpr: DPR, seed: 7 });
    const b = drawSandStroke({ width: 200, height: 30, dpr: DPR, seed: 7 });
    const c = drawSandStroke({ width: 200, height: 30, dpr: DPR, seed: 8 });
    expect(a.width).toBe((200 + SAND_FRAME_PAD * 2) * DPR);
    expect(a.height).toBe((30 + SAND_FRAME_PAD * 2) * DPR);
    expect(Array.from(a.alpha)).toEqual(Array.from(b.alpha));
    expect(Array.from(a.alpha)).not.toEqual(Array.from(c.alpha));
  });

  it('starts beside the mark on the left side and reaches the top last', () => {
    const stroke = drawSandStroke({ width: 200, height: 30, dpr: DPR, seed: 11 });
    let firstX = 0;
    let firstY = 0;
    let first = 0;
    let topLate = 0;
    let top = 0;
    for (let y = 0; y < stroke.height; y++) {
      for (let x = 0; x < stroke.width; x++) {
        const at = y * stroke.width + x;
        if (stroke.alpha[at] < 0.3 || stroke.arrive[at] > 1) continue;
        if (stroke.arrive[at] < 0.015) {
          firstX += x;
          firstY += y;
          first++;
        }
        if (y < PAD + 3 * DPR && x > stroke.width * 0.3 && x < stroke.width * 0.7) {
          top++;
          if (stroke.arrive[at] > 0.5) topLate++;
        }
      }
    }
    expect(first).toBeGreaterThan(0);
    expect(firstX / first).toBeLessThan(PAD + 4 * DPR);
    expect(Math.abs(firstY / first - stroke.height / 2)).toBeLessThan(8 * DPR);
    expect(top).toBeGreaterThan(0);
    expect(topLate / top).toBeGreaterThan(0.9);
  });

  it('keeps its line the same width whatever the height of the cell', () => {
    const short = drawSandStroke({ width: 200, height: 30, dpr: DPR, seed: 5 });
    const tall = drawSandStroke({ width: 200, height: 60, dpr: DPR, seed: 5 });
    const bottomInk = (stroke: SandStroke) => {
      let sum = 0;
      for (let x = PAD + 60 * DPR; x < PAD + 140 * DPR; x += 4) sum += inkDown(stroke, x, stroke.height / 2, stroke.height);
      return sum / 20;
    };
    expect(Math.abs(bottomInk(short) - bottomInk(tall))).toBeLessThan(1.5);
  });

  it('holds still while the cell is dragged wider: the left stays, the right side moves with the edge', () => {
    const narrow = drawSandStroke({ width: 200, height: 30, dpr: DPR, seed: 3, nominalWidth: 200 });
    const wide = drawSandStroke({ width: 260, height: 30, dpr: DPR, seed: 3, nominalWidth: 200 });
    const leftPart = PAD + 120 * DPR;
    for (let y = 0; y < narrow.height; y++) expect(row(wide, y, 0, leftPart)).toEqual(row(narrow, y, 0, leftPart));
    const rightPart = PAD + 8 * DPR;
    for (let y = PAD + 10 * DPR; y < PAD + 20 * DPR; y++) {
      expect(row(wide, y, wide.width - rightPart, wide.width)).toEqual(row(narrow, y, narrow.width - rightPart, narrow.width));
    }
  });

  it('reads the frame colour in either computed form', () => {
    expect(rgbOfComputedColour('rgb(168, 84, 67)')).toEqual([168, 84, 67]);
    expect(rgbOfComputedColour('color(srgb 0.5 0.25 1)')).toEqual([128, 64, 255]);
  });
});
