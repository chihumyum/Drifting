import { describe, expect, it } from 'vitest';
import { CHAR_SEA_STEP_RATE, CHAR_SEA_WATER_CELL, CharSeaWater, layoutCharSea } from './char-sea-model';
import { CHAR_SEA_LANGUAGES, charSeaScript, type CharSeaLanguage } from './char-sea-text';

/** How far the wave front has travelled along a direction, in CSS px. */
function frontDistance(water: CharSeaWater, cx: number, cy: number, angle: number): number {
  let front = 0;
  for (let r = 0; r < 80; r += 0.5) {
    const x = Math.round(cx + Math.cos(angle) * r);
    const y = Math.round(cy + Math.sin(angle) * r);
    if (x < 0 || y < 0 || x >= water.cols || y >= water.rows) break;
    if (Math.abs(water.heights[y * water.cols + x]) > 0.05) front = r;
  }
  return front * CHAR_SEA_WATER_CELL;
}

describe('the sea of characters', () => {
  it('maps the interface language to the script the sea writes in', () => {
    expect(charSeaScript('zh-CN')).toBe('zh');
    expect(charSeaScript('ja')).toBe('ja');
    expect(charSeaScript('ar-EG')).toBe('ar');
    expect(charSeaScript('en')).toBe('en');
    expect(charSeaScript('fr')).toBe('en');
    expect(charSeaScript(undefined)).toBe('en');
  });

  it.each(Object.entries(CHAR_SEA_LANGUAGES))('centres a cell on the window, as the startup dots do (%s)', (_name, language) => {
    for (const [width, height] of [[960, 600], [1512, 945], [1281, 799]]) {
      const layout = layoutCharSea(width, height, language);
      expect(layout.originX).toBeGreaterThanOrEqual(0);
      expect(layout.originX).toBeLessThan(language.cellWidth);
      expect(((width / 2 - layout.originX - language.cellWidth / 2) / language.cellWidth) % 1).toBeCloseTo(0, 6);
      expect(((height / 2 - layout.originY - language.cellHeight / 2) / language.cellHeight) % 1).toBeCloseTo(0, 6);
      expect(layout.originX + layout.cols * language.cellWidth).toBeLessThanOrEqual(width);
      expect(layout.glyphs.length).toBeLessThanOrEqual(256);
      expect(Math.max(...layout.map)).toBeLessThan(layout.glyphs.length);
    }
  });

  it('writes in reading order, right to left for Arabic, without stray marks', () => {
    const zh = layoutCharSea(960, 600, CHAR_SEA_LANGUAGES.zh);
    expect(zh.glyphs[zh.map[0]]).toBe(Array.from(CHAR_SEA_LANGUAGES.zh.text)[0]);
    const ar = layoutCharSea(960, 600, CHAR_SEA_LANGUAGES.ar);
    expect(ar.glyphs[ar.map[ar.cols - 1]]).toBe(Array.from(CHAR_SEA_LANGUAGES.ar.text)[0]);
    const marked: CharSeaLanguage = { ...CHAR_SEA_LANGUAGES.ar, text: 'سَلامٌ' };
    expect(layoutCharSea(100, 100, marked).glyphs).toEqual(['س', 'ل', 'ا', 'م']);
  });

  it('spreads a press as a round ring at about 310px a second', () => {
    const water = new CharSeaWater(960, 600);
    water.splash(480, 300, 1.2, 2.2);
    for (let i = 0; i < CHAR_SEA_STEP_RATE / 2; i += 1) water.step();
    const cx = 480 / CHAR_SEA_WATER_CELL;
    const cy = 300 / CHAR_SEA_WATER_CELL;
    const along = frontDistance(water, cx, cy, 0);
    const diagonal = frontDistance(water, cx, cy, Math.PI / 4);
    expect(along).toBeGreaterThan(130);
    expect(along).toBeLessThan(200);
    expect(Math.abs(diagonal - along) / along).toBeLessThan(0.12);
  });

  it('keeps a ring in sight for a second and a half, then goes still within six', () => {
    const water = new CharSeaWater(960, 600);
    water.splash(480, 300, 1.2, 2.2);
    let peak = Infinity;
    for (let i = 0; i < CHAR_SEA_STEP_RATE * 1.5; i += 1) peak = water.step();
    expect(peak).toBeGreaterThan(0.1);
    for (let i = 0; i < CHAR_SEA_STEP_RATE * 4.5; i += 1) peak = water.step();
    expect(peak).toBeLessThan(0.004);
  });
});
