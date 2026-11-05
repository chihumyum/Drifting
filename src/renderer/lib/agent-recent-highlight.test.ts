import { describe, expect, it } from 'vitest';
import { pathTouchesRect, pointerPathStart } from './agent-recent-highlight';

const word = { left: 100, right: 140, top: 200, bottom: 224 };

describe('the pointer touching the words the Agent just wrote', () => {
  it('counts a pointer standing on the words, edges included', () => {
    expect(pathTouchesRect({ x: 120, y: 210 }, { x: 120, y: 210 }, word)).toBe(true);
    expect(pathTouchesRect({ x: 140, y: 224 }, { x: 140, y: 224 }, word)).toBe(true);
    expect(pathTouchesRect({ x: 141, y: 210 }, { x: 141, y: 210 }, word)).toBe(false);
  });

  it('counts words a quick scroll carried past a still pointer between two frames', () => {
    // The words were below the pointer last frame and are above it now.
    expect(pathTouchesRect({ x: 120, y: 300 }, { x: 120, y: 150 }, word)).toBe(true);
    // Words in another column never passed under it.
    expect(pathTouchesRect({ x: 160, y: 300 }, { x: 160, y: 150 }, word)).toBe(false);
    // The path stopped short of the words.
    expect(pathTouchesRect({ x: 120, y: 300 }, { x: 120, y: 230 }, word)).toBe(false);
  });

  it('follows a slanted path and misses words beside it', () => {
    expect(pathTouchesRect({ x: 80, y: 180 }, { x: 160, y: 244 }, word)).toBe(true);
    expect(pathTouchesRect({ x: 60, y: 260 }, { x: 100, y: 300 }, word)).toBe(false);
  });

  it('maps where the last frame left the pointer in the content back into this frame', () => {
    const point = { x: 120, y: 400 };
    // Last frame the pointer stood at content y 400 + 1000; the page has since scrolled 60px down.
    expect(pointerPathStart({ x: 120, y: 1400 }, point, { left: 0, top: 1060, height: 800 }))
      .toEqual({ x: 120, y: 340 });
    expect(pointerPathStart(null, point, { left: 0, top: 1060, height: 800 })).toBe(point);
  });

  it('counts only where a jump lands, not the words it skipped', () => {
    const point = { x: 120, y: 400 };
    // A search result moved the content 2000px in one frame.
    expect(pointerPathStart({ x: 120, y: 1400 }, point, { left: 0, top: 3000, height: 800 })).toBe(point);
    // Just under half the scroller still sweeps.
    expect(pointerPathStart({ x: 120, y: 1400 }, point, { left: 0, top: 1399, height: 800 }))
      .toEqual({ x: 120, y: 1 });
  });
});
