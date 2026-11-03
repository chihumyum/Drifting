import { describe, expect, it } from 'vitest';

import { createSandMask, HEAT_CELL, HEAT_STEP, paintHeatmap, paintStrip, sandCoverage, sandDab } from './sand-heat';

describe('sand for the writing heatmap', () => {
  it('lands the same dab for the same seed, and a fuller one for more words', () => {
    const a = createSandMask(20, 20, 2);
    const b = createSandMask(20, 20, 2);
    sandDab(a, 10, 10, 8, 0.7, 42);
    sandDab(b, 10, 10, 8, 0.7, 42);
    expect(Array.from(a.alpha)).toEqual(Array.from(b.alpha));
    const light = createSandMask(20, 20, 2);
    const heavy = createSandMask(20, 20, 2);
    sandDab(light, 10, 10, 7.6, 0.66, 7);
    sandDab(heavy, 10, 10, 11.2, 1, 7);
    expect(sandCoverage(heavy)).toBeGreaterThan(sandCoverage(light) * 1.5);
  });

  it('paints a year: dabs for the days written, loose grains for the rest, inside the grid', () => {
    const levels = Array.from({ length: 53 * 7 }, (_, i) => (i % 5 === 0 ? 4 : i % 3 === 0 ? 1 : 0));
    const { dabs, loose } = paintHeatmap(levels, 53, 1);
    expect(dabs.width).toBe(53 * HEAT_STEP - (HEAT_STEP - HEAT_CELL));
    expect(dabs.height).toBe(7 * HEAT_STEP - (HEAT_STEP - HEAT_CELL));
    expect(sandCoverage(dabs)).toBeGreaterThan(0);
    expect(sandCoverage(loose)).toBeGreaterThan(0);
    const empty = paintHeatmap(levels.map(() => 0), 53, 1);
    expect(sandCoverage(empty.dabs)).toBe(0);
  });

  it('draws a strip whose busiest day is the tallest stroke', () => {
    const strip = paintStrip([0, 0, 100, 0, 1000], 50, 20, 1, 3);
    const columnHeight = (x0: number, x1: number) => {
      let top = strip.height;
      for (let y = 0; y < strip.height; y++) for (let x = x0; x < x1; x++) if (strip.alpha[y * strip.width + x] > 0) top = Math.min(top, y);
      return strip.height - top;
    };
    expect(columnHeight(40, 50)).toBeGreaterThan(columnHeight(20, 30));
  });
});
