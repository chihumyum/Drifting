import { describe, expect, it } from 'vitest';
import {
  CHAR_SEA_STEP_RATE,
  CHAR_SEA_WATER_CELL,
  CharSeaGlyphs,
  CharSeaRain,
  CharSeaWater,
  charSeaCellsCovered,
  layoutCharSea,
} from './char-sea-model';
import { CHAR_SEA_LANGUAGES, charSeaScript, type CharSeaLanguage } from './char-sea-text';

/** A repeatable stand-in for Math.random. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
}

/** How much light the rain lays on its columns in [from, to). */
function litAmount(rain: CharSeaRain, from = 0, to = rain.cols): number {
  let sum = 0;
  for (let row = 0; row < rain.rows; row += 1) {
    for (let col = from; col < to; col += 1) sum += rain.cells[(row * rain.cols + col) * 2];
  }
  return sum;
}

/** How many of the rain's columns have a lit cell, of those in [from, to). */
function litColumns(rain: CharSeaRain, from = 0, to = rain.cols): number {
  let count = 0;
  for (let col = from; col < to; col += 1) {
    for (let row = 0; row < rain.rows; row += 1) {
      if (rain.cells[(row * rain.cols + col) * 2] > 0) {
        count += 1;
        break;
      }
    }
  }
  return count;
}

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
    expect(charSeaScript('zh-TW')).toBe('zh-TW');
    expect(charSeaScript('ko')).toBe('ko');
    // Every Latin interface language writes its own passage; one without falls back to English.
    expect(charSeaScript('es')).toBe('es');
    expect(charSeaScript('de')).toBe('de');
    expect(charSeaScript('fr')).toBe('fr');
    expect(charSeaScript('pt-BR')).toBe('pt');
    expect(charSeaScript('it')).toBe('en');
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

  it('holds the water to the loading word: it stands there, settles back after a ring, and spreads when let go', () => {
    const water = new CharSeaWater(480, 300);
    const shape = new Float32Array(water.cols * water.rows);
    for (let y = 18; y < 24; y += 1) for (let x = 24; x < 44; x += 1) shape[y * water.cols + x] = 1;
    const at = { x: 34 * CHAR_SEA_WATER_CELL + 3, y: 21 * CHAR_SEA_WATER_CELL + 3 };
    const centre = 21 * water.cols + 34;
    water.hold(shape);
    water.setHoldHeight(0.45);
    for (let i = 0; i < CHAR_SEA_STEP_RATE * 3; i += 1) water.step();
    expect(water.heights[centre]).toBeCloseTo(0.45, 2);
    expect(Math.abs(water.offRest(at.x, at.y))).toBeLessThan(0.01);
    expect(Math.abs(water.heights[5 * water.cols + 5])).toBeLessThan(0.005);

    water.splash(at.x, at.y, 1.2, 2.2);
    for (let i = 0; i < CHAR_SEA_STEP_RATE * 0.05; i += 1) water.step();
    expect(Math.abs(water.offRest(at.x, at.y))).toBeGreaterThan(0.1);
    for (let i = 0; i < CHAR_SEA_STEP_RATE * 2; i += 1) water.step();
    expect(Math.abs(water.offRest(at.x, at.y))).toBeLessThan(0.02);

    water.hold(null);
    for (let i = 0; i < CHAR_SEA_STEP_RATE * 0.5; i += 1) water.step();
    expect(water.heights[centre]).toBeLessThan(0.2);
  });

  it('bursts a held word into rings that reach the sides when it is let go', () => {
    const reach = (burst: number) => {
      const water = new CharSeaWater(960, 600);
      const shape = new Float32Array(water.cols * water.rows);
      for (let y = 36; y < 50; y += 1) for (let x = 30; x < 107; x += 1) if (Math.floor(x / 3) % 2 === 0) shape[y * water.cols + x] = 1;
      water.hold(shape);
      water.setHoldHeight(0.45);
      for (let i = 0; i < CHAR_SEA_STEP_RATE * 1.5; i += 1) water.step();
      water.hold(null, burst);
      let peak = 0;
      const side = Math.floor(300 / CHAR_SEA_WATER_CELL) * water.cols + Math.floor(60 / CHAR_SEA_WATER_CELL);
      for (let i = 0; i < CHAR_SEA_STEP_RATE * 3; i += 1) {
        water.step();
        peak = Math.max(peak, Math.abs(water.heights[side]));
      }
      return peak;
    };
    // A burst leaves from the word's outline only, so it carries further than
    // letting go plainly, and at the loading word's strength (4) further still.
    const plain = reach(1);
    expect(reach(2)).toBeGreaterThan(plain * 1.6);
    expect(reach(4)).toBeGreaterThan(0.4);
  });

  it('lets a held word go as one swell from its outline, and its middle does not ring again', () => {
    const water = new CharSeaWater(960, 600);
    const shape = new Float32Array(water.cols * water.rows);
    // Strokes four cells wide with gaps between them, as letters stand.
    for (let y = 36; y < 50; y += 1) for (let x = 30; x < 107; x += 1) if (Math.floor(x / 4) % 2 === 0) shape[y * water.cols + x] = 1;
    water.hold(shape);
    water.setHoldHeight(0.45);
    for (let i = 0; i < CHAR_SEA_STEP_RATE * 1.5; i += 1) water.step();
    // Along the word's middle row: how many separate stretches stand above half its top.
    const stretches = () => {
      const row = 43 * water.cols;
      let top = 0;
      for (let x = 20; x < 117; x += 1) top = Math.max(top, water.heights[row + x]);
      let count = 0;
      for (let x = 20; x < 117; x += 1) if (water.heights[row + x] > top / 2 && !(water.heights[row + x - 1] > top / 2)) count += 1;
      return count;
    };
    expect(stretches()).toBeGreaterThan(5);
    water.hold(null, 2);
    expect(stretches()).toBe(1);
    const middle = 43 * water.cols + 68;
    const side = Math.floor(300 / CHAR_SEA_WATER_CELL) * water.cols + Math.floor(60 / CHAR_SEA_WATER_CELL);
    let late = 0;
    let reach = 0;
    for (let i = 0; i < CHAR_SEA_STEP_RATE * 2; i += 1) {
      water.step();
      if (i > CHAR_SEA_STEP_RATE * 0.4) late = Math.max(late, Math.abs(water.heights[middle]));
      reach = Math.max(reach, Math.abs(water.heights[side]));
    }
    // The word stood at 0.9 when let go; its middle sinks and stays down while the ring reaches the side.
    expect(late).toBeLessThan(0.1);
    expect(reach).toBeGreaterThan(0.2);
  });

  it('rains down about a third of the columns, breaks the drops the water knocks, and refills them', () => {
    const rain = new CharSeaRain(60, 40, seeded(7));
    const tick = (seconds: number, offRest: (col: number) => number) => {
      for (let t = 0; t < seconds; t += 1 / 60) rain.tick(1 / 60, offRest);
    };
    rain.start();
    tick(6, () => 0);
    const falling = litColumns(rain);
    expect(falling).toBeGreaterThan(60 * 0.15);
    expect(falling).toBeLessThan(60 * 0.6);
    expect(rain.cells.some((value, index) => index % 2 === 1 && value === 255)).toBe(true);

    // Drops that still fall in break at once, so only their first instant shows.
    tick(1, (col) => (col < 30 ? 1 : 0));
    expect(litAmount(rain, 0, 30)).toBeLessThan(litAmount(rain, 30) * 0.25);

    tick(4, () => 0);
    expect(litColumns(rain, 0, 30)).toBeGreaterThan(30 * 0.15);
  });

  it('stops the rain: nothing new falls and what is out fades within half a second', () => {
    const rain = new CharSeaRain(40, 30, seeded(3));
    rain.start();
    for (let t = 0; t < 4; t += 1 / 60) rain.tick(1 / 60, () => 0);
    expect(litColumns(rain)).toBeGreaterThan(0);
    rain.stop();
    let still = true;
    for (let t = 0; t < 0.5; t += 1 / 60) still = rain.tick(1 / 60, () => 0);
    expect(still).toBe(false);
    expect(litColumns(rain)).toBe(0);
  });

  it('changes the characters under the rain and in the word for other letters, and puts them back after', () => {
    const layout = layoutCharSea(200, 100, CHAR_SEA_LANGUAGES.zh);
    const glyphs = new CharSeaGlyphs(layout, seeded(11));
    const cells = layout.cols * layout.rows;
    const rain = new Uint8Array(cells * 2);
    const word = new Uint8Array(cells);
    const head = 3;
    const trail = layout.cols + 3;
    const inWord = 2 * layout.cols + 8;
    rain[head * 2] = 255;
    rain[head * 2 + 1] = 255;
    rain[trail * 2] = 120;
    word[inWord] = 1;
    const seen = { head: new Set<number>(), trail: new Set<number>(), word: new Set<number>() };
    for (let t = 0; t < 2; t += 1 / 60) {
      expect(glyphs.tick(1 / 60, rain, word).changing).toBe(true);
      seen.head.add(glyphs.live[head]);
      seen.trail.add(glyphs.live[trail]);
      seen.word.add(glyphs.live[inWord]);
    }
    // about 14 changes a second under a head, 2.5 in a trail, 0.8 in the word
    expect(seen.head.size).toBeGreaterThan(12);
    expect(seen.trail.size).toBeGreaterThan(1);
    expect(seen.trail.size).toBeLessThan(seen.head.size);
    expect(seen.word.size).toBeGreaterThan(0);
    const letters = new Set([...seen.head, ...seen.trail].map((index) => layout.glyphs[index]));
    for (const glyph of letters) expect(glyph).toMatch(/[\p{L}\p{N}]/u);
    // once the rain and the word are gone every cell shows its own character again
    expect(glyphs.tick(1 / 60, null, null)).toMatchObject({ changing: false, changed: true });
    expect([...glyphs.live]).toEqual([...glyphs.own]);
  });

  it('lets every cell drift through the passage\'s letters about once a second, without keeping the sea awake', () => {
    const layout = layoutCharSea(200, 100, CHAR_SEA_LANGUAGES.zh);
    const glyphs = new CharSeaGlyphs(layout, seeded(5));
    const cells = layout.cols * layout.rows;
    const traded = new Uint8Array(cells);
    for (let t = 0; t < 3; t += 1 / 60) {
      expect(glyphs.tick(1 / 60, null, null).changing).toBe(false);
      for (let i = 0; i < cells; i += 1) if (glyphs.own[i] !== layout.map[i]) traded[i] = 1;
    }
    // Over three seconds nearly every cell has traded (1 - e^-3 ≈ 95%), always for a letter.
    expect(traded.reduce((sum, value) => sum + value, 0) / cells).toBeGreaterThan(0.85);
    glyphs.own.forEach((index, cell) => {
      if (traded[cell]) expect(layout.glyphs[index]).toMatch(/[\p{L}\p{N}]/u);
    });
    expect([...glyphs.live]).toEqual([...glyphs.own]);
  });

  it('finds the sheet cells the loading word covers', () => {
    const layout = layoutCharSea(200, 100, CHAR_SEA_LANGUAGES.zh);
    const water = new CharSeaWater(200, 100);
    const shape = new Float32Array(water.cols * water.rows);
    const x = Math.floor((layout.originX + 5.5 * layout.cellWidth) / CHAR_SEA_WATER_CELL);
    const y = Math.floor((layout.originY + 2.5 * layout.cellHeight) / CHAR_SEA_WATER_CELL);
    shape[y * water.cols + x] = 1;
    const cells = charSeaCellsCovered(layout, shape, water.cols, water.rows);
    expect(cells[2 * layout.cols + 5]).toBe(1);
    expect(cells.reduce((sum, value) => sum + value, 0)).toBe(1);
  });
});
