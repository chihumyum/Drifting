import { describe, expect, it } from 'vitest';
import { parseMaterialRegion } from './comment';

const anchor = (region: unknown) => JSON.stringify({ region, createdAt: '2026-10-27T00:00:00.000Z' });

describe('material region anchors', () => {
  it('reads image and PDF page regions normalized to the media box', () => {
    expect(parseMaterialRegion(anchor({ v: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.4 }))).toEqual({ v: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
    expect(parseMaterialRegion(anchor({ v: 1, page: 3, x: 0, y: 0, w: 1, h: 1 }))).toEqual({ v: 1, page: 3, x: 0, y: 0, w: 1, h: 1 });
  });

  it('treats text anchors, future versions and out-of-box rectangles as no region', () => {
    for (const value of [
      JSON.stringify({ selectedText: 'x' }),
      anchor({ v: 2, x: 0, y: 0, w: 0.1, h: 0.1 }),
      anchor({ v: 1, x: 0.8, y: 0, w: 0.5, h: 0.1 }),
      anchor({ v: 1, x: -0.1, y: 0, w: 0.1, h: 0.1 }),
      anchor({ v: 1, page: 0, x: 0, y: 0, w: 0.1, h: 0.1 }),
      anchor({ v: 1, page: 1.5, x: 0, y: 0, w: 0.1, h: 0.1 }),
      'not json',
      '',
      null,
    ]) {
      expect(parseMaterialRegion(value)).toBeNull();
    }
  });
});
