import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readCoverBook, type CoverRequest } from './book';
import { shelfCoverKey } from './covers';
import { random } from './paint';
import { ART_STYLES, COVER_STYLES, DEFAULT_COVER_STYLE, nextCoverStyle, type CoverStyleId } from './styles';

/** A 2D context that keeps what is set on it and counts what is painted. */
function fakeContext() {
  const painted = { count: 0 };
  const state: Record<string | symbol, unknown> = {};
  const paint = () => { painted.count++; };
  const target: Record<string, unknown> = {
    createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    createRadialGradient: () => ({ addColorStop() {} }),
    putImageData: paint,
    fill: paint,
    stroke: paint,
    fillRect: paint,
    fillText: paint,
  };
  const ctx = new Proxy(target, {
    get: (t, k) => (k in t ? t[k as string] : k in state ? state[k] : () => {}),
    set: (_, k, v) => { state[k] = v; return true; },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, painted };
}

/** A synthetic book: some chapters, some storylines carrying runs of them, words of any length. */
function book(seed: number, overrides: Partial<CoverRequest> = {}): CoverRequest {
  const rand = random(seed);
  const chapters = 1 + Math.floor(rand() * 60);
  const lines = Math.floor(rand() * 7);
  return {
    seed,
    chapters,
    words: Array.from({ length: chapters }, () => Math.round(rand() * 8000)),
    storylines: Array.from({ length: lines }, (_, i) => ({
      color: ['#B0614C', '#4F72BE', '#7F9A40', '#8A5BA8', '#C28A2E', '#3E8C8A'][i],
      chapters: Array.from({ length: chapters }, (_, c) => c).filter(() => rand() < 0.45),
    })),
    latin: rand() < 0.5,
    ...overrides,
  };
}

beforeAll(() => {
  if (typeof globalThis.Path2D === 'undefined') {
    vi.stubGlobal('Path2D', class { moveTo() {} lineTo() {} rect() {} addPath() {} closePath() {} });
  }
});

describe('the book a cover reads', () => {
  it('reads each chapter’s words against the book’s mean, evenly when nothing is counted', () => {
    expect(readCoverBook(book(1, { chapters: 4, words: [100, 300, 0, 400] })).wn).toEqual([0.5, 1.5, 0, 2]);
    expect(readCoverBook(book(1, { chapters: 3, words: [] })).wn).toEqual([1, 1, 1]);
  });

  it('reads a book whose storylines carry no chapter as one neutral strand through all of it', () => {
    const read = readCoverBook(book(2, { chapters: 5, storylines: [{ color: '#4F72BE', chapters: [] }] }));
    expect(read.strands).toHaveLength(1);
    expect(read.strands[0].neutral).toBe(true);
    expect(Array.from(read.strands[0].on)).toEqual([1, 1, 1, 1, 1]);
    const carried = readCoverBook(book(2, { chapters: 5, storylines: [{ color: '#4F72BE', chapters: [1, 3] }, { color: 'tomato', chapters: [] }] }));
    expect(carried.strands.map((s) => Array.from(s.on))).toEqual([[0, 1, 0, 1, 0], [0, 0, 0, 0, 0]]);
    expect(carried.strands[1].rgb).toEqual([85, 82, 78]);
  });
});

describe('the cover styles', () => {
  it('turns through every style in order and back to sand', () => {
    expect(new Set(COVER_STYLES).size).toBe(COVER_STYLES.length);
    expect(DEFAULT_COVER_STYLE).toBe('topo');
    expect(Object.keys(ART_STYLES).sort()).toEqual(COVER_STYLES.filter((s) => s !== 'sand').sort());
    let style: CoverStyleId = COVER_STYLES[0];
    const seen = [];
    for (let i = 0; i < COVER_STYLES.length; i++) {
      seen.push(style);
      style = nextCoverStyle(style);
    }
    expect(seen).toEqual([...COVER_STYLES]);
    expect(style).toBe('sand');
  });

  it('names every style in both languages', () => {
    for (const file of ['zh-CN', 'en']) {
      const names = JSON.parse(readFileSync(`src/renderer/locales/${file}.json`, 'utf8')).projectPicker.desk.coverStyle.names;
      expect(Object.keys(names).sort()).toEqual([...COVER_STYLES].sort());
    }
  });

  it('paints every kind of book in every style', () => {
    const books = [
      ...Array.from({ length: 12 }, (_, i) => book(100 + i)),
      book(7, { chapters: 0, words: [], storylines: [] }),
      book(8, { chapters: 1, words: [0], storylines: [{ color: '#4F72BE', chapters: [0] }] }),
      book(9, { storylines: [{ color: '#4F72BE', chapters: [] }, { color: '#B0614C', chapters: [] }] }),
    ];
    for (const [id, style] of Object.entries(ART_STYLES)) {
      for (const request of books) {
        const { ctx, painted } = fakeContext();
        const result = style.draw(ctx, readCoverBook(request), random(request.seed));
        expect(typeof result.dark, id).toBe('boolean');
        expect(painted.count, id).toBeGreaterThan(0);
      }
    }
  });
});

describe('the shelf’s cover cache', () => {
  it('draws a book again for another style, its storylines or much longer chapters, not for a few more words', () => {
    const request = book(3, { chapters: 10, words: Array(10).fill(2000) });
    const key = (style: (typeof COVER_STYLES)[number], change: Partial<CoverRequest> = {}) =>
      shelfCoverKey('book', style, { ...request, ...change });
    expect(key('sand')).not.toBe(key('rings'));
    expect(key('rings', { words: [2040, ...Array(9).fill(2000)] })).toBe(key('rings'));
    expect(key('rings', { words: [9000, ...Array(9).fill(2000)] })).not.toBe(key('rings'));
    const recoloured = request.storylines.map((line) => ({ ...line, color: '#000000' }));
    if (recoloured.length) {
      // Sand is coloured in CSS; every other style draws its colours in.
      expect(key('sand', { storylines: recoloured })).toBe(key('sand'));
      expect(key('rings', { storylines: recoloured })).not.toBe(key('rings'));
    }
  });
});

describe('the shelf’s cover style on this device', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  function storage(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial));
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => { values.set(k, v); },
    });
    return values;
  }

  it('starts on contours, turns to the next style and remembers choices including sand', async () => {
    const values = storage();
    const { readCoverStyle, turnCoverStyle, subscribeCoverStyle } = await import('./preference');
    expect(readCoverStyle()).toBe('topo');
    expect(values.has('shelf:cover-style')).toBe(false);
    const heard = vi.fn();
    const stop = subscribeCoverStyle(heard);
    expect(turnCoverStyle()).toBe('cyanotype');
    expect(heard).toHaveBeenCalledTimes(1);
    expect(values.get('shelf:cover-style')).toBe('cyanotype');
    stop();
    vi.resetModules();
    expect((await import('./preference')).readCoverStyle()).toBe('cyanotype');
    values.set('shelf:cover-style', 'sand');
    vi.resetModules();
    expect((await import('./preference')).readCoverStyle()).toBe('sand');
  });

  it('falls back to contours for a style it does not know or storage it cannot reach', async () => {
    storage({ 'shelf:cover-style': 'retired-style' });
    expect((await import('./preference')).readCoverStyle()).toBe('topo');
    vi.resetModules();
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    });
    const { readCoverStyle, turnCoverStyle } = await import('./preference');
    expect(readCoverStyle()).toBe('topo');
    expect(turnCoverStyle()).toBe('cyanotype');
  });
});
