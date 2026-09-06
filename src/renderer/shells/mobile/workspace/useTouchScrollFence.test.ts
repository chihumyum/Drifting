import { describe, expect, it } from 'vitest';

import { scrollBoxTakes, touchScrollFenceAllows, type ScrollBox } from './useTouchScrollFence';

function box(overrides: Partial<ScrollBox> = {}): ScrollBox {
  return {
    overflowX: 'visible',
    overflowY: 'visible',
    scrollLeft: 0,
    scrollTop: 0,
    scrollWidth: 100,
    scrollHeight: 100,
    clientWidth: 100,
    clientHeight: 100,
    ...overrides,
  };
}

describe('touch scroll fence', () => {
  it('cancels a pan that nothing between the finger and the fence can consume', () => {
    const chain = [box(), box({ overflowY: 'hidden', scrollHeight: 400 })];
    expect(touchScrollFenceAllows(chain, 0, -40)).toBe(false);
    expect(touchScrollFenceAllows(chain, 0, 40)).toBe(false);
    expect(touchScrollFenceAllows(chain, 40, 4)).toBe(false);
    // No travel yet: nothing to decide.
    expect(touchScrollFenceAllows(chain, 0, 0)).toBe(true);
  });

  it('lets a scrollable part keep scrolling only while it has travel that way', () => {
    const log = box({ overflowY: 'auto', scrollHeight: 400, scrollTop: 50 });
    expect(touchScrollFenceAllows([box(), log], 0, -40)).toBe(true);
    expect(touchScrollFenceAllows([box(), log], 0, 40)).toBe(true);
    const atTop = box({ overflowY: 'auto', scrollHeight: 400, scrollTop: 0 });
    expect(scrollBoxTakes(atTop, 0, 40)).toBe(false);
    expect(scrollBoxTakes(atTop, 0, -40)).toBe(true);
    const atBottom = box({ overflowY: 'auto', scrollHeight: 400, scrollTop: 300 });
    expect(scrollBoxTakes(atBottom, 0, -40)).toBe(false);
    expect(scrollBoxTakes(atBottom, 0, 40)).toBe(true);
  });

  it('judges horizontal pans against horizontal travel and ignores content that fits', () => {
    const tabs = box({ overflowX: 'auto', scrollWidth: 300, scrollLeft: 0 });
    expect(scrollBoxTakes(tabs, -40, 3)).toBe(true);
    expect(scrollBoxTakes(tabs, 40, 3)).toBe(false);
    expect(scrollBoxTakes(tabs, 3, -40)).toBe(false);
    expect(scrollBoxTakes(box({ overflowY: 'auto', scrollHeight: 80 }), 0, -40)).toBe(false);
  });
});
