import { describe, expect, it } from 'vitest';
import { drawTimings, swashFit } from './comment-sand';
import { SAND_DRAW_MS, SAND_DRAW_PER_LINE_MS } from './motion';

describe('comment anchor sand', () => {
  it('cuts a short line from the stroke start and thins its last 12px', () => {
    // At 26px tall the 720 × 64 swash is about 292px wide.
    const fit = swashFit(120, 26, 7);
    expect(fit.size).toBeCloseTo(292.5, 1);
    expect(fit.tail).toBe(12);
    expect(fit.x).toBeLessThanOrEqual(0);
    expect(fit.x).toBeGreaterThan(-48 * (26 / 64) - 0.001);
  });

  it('stretches a long line whole, without a thinned tail', () => {
    expect(swashFit(640, 26, 7)).toEqual({ size: null, x: 0, tail: 0 });
  });

  it('picks the same cut for the same comment and line, and varies between them', () => {
    expect(swashFit(80, 26, 11)).toEqual(swashFit(80, 26, 11));
    const offsets = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((seed) => swashFit(80, 26, seed).x));
    expect(offsets.size).toBeGreaterThan(1);
  });

  it('draws again as one easing movement across the lines', () => {
    const one = drawTimings([300]);
    expect(one).toEqual([{ delay: 0, duration: SAND_DRAW_MS }]);
    const three = drawTimings([500, 500, 200]);
    const whole = SAND_DRAW_MS + 2 * SAND_DRAW_PER_LINE_MS;
    expect(three[0].delay).toBe(0);
    for (let index = 1; index < three.length; index += 1) {
      expect(three[index].delay).toBeCloseTo(three[index - 1].delay + three[index - 1].duration, 6);
    }
    const last = three[three.length - 1];
    expect(last.delay + last.duration).toBeCloseTo(whole, 6);
    // Easing out: the first line, though as long as the second, is drawn faster.
    expect(three[0].duration).toBeLessThan(three[1].duration);
  });
});
