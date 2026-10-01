import { describe, expect, it } from 'vitest';
import {
  clampDimension,
  clampSidebarWidth,
  clampSidebarSplitRatio,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_DIVIDER_WIDTH,
  parsePersistedDimension,
  sidebarWidthBounds,
  verticalDockBounds,
} from './layout-geometry';

describe('layout geometry', () => {
  it('rejects corrupt persisted dimensions', () => {
    expect(parsePersistedDimension(null)).toBeNull();
    expect(parsePersistedDimension('')).toBeNull();
    expect(parsePersistedDimension('NaN')).toBeNull();
    expect(parsePersistedDimension('-1')).toBeNull();
    expect(parsePersistedDimension('320')).toBe(320);
  });

  it('keeps both sidebars from consuming the desktop content column', () => {
    expect(sidebarWidthBounds('left', 1024, 300)).toEqual({ min: 288, max: 304 });
    expect(clampSidebarWidth(800, 'left', 1024, 300)).toBe(304);
    expect(clampSidebarWidth(800, 'right', 1000, 280)).toBe(300);
  });

  it('falls back to the minimum when the viewport cannot satisfy every constraint', () => {
    expect(clampSidebarWidth(500, 'right', 480, 280)).toBe(288);
    expect(clampDimension(Number.NaN, { min: 10, max: 100 })).toBe(10);
  });

  it('lets either sidebar reach dual-column width while reserving the editor', () => {
    expect(clampSidebarWidth(650, 'left', 1440, 300)).toBe(650);
    expect(clampSidebarWidth(650, 'right', 1440, 280)).toBe(650);
    expect(clampSidebarWidth(800, 'left', 1440, 600)).toBe(420);
  });

  it.each(['left', 'right'] as const)('preserves full labels in the %s sidebar and both split panes', (side) => {
    expect(clampSidebarWidth(140, side, 1440, 280)).toBe(288);
    for (const width of [600, 601, 800, 1440]) {
      for (const preferred of [0, 0.2, 0.5, 0.8, 1, Number.NaN]) {
        const ratio = clampSidebarSplitRatio(preferred, side, width);
        const available = width - SIDEBAR_DIVIDER_WIDTH;
        expect(available * ratio).toBeGreaterThanOrEqual(SIDEBAR_MIN_WIDTH[side] - 1e-9);
        expect(available * (1 - ratio)).toBeGreaterThanOrEqual(SIDEBAR_MIN_WIDTH[side] - 1e-9);
      }
    }
    expect(clampSidebarSplitRatio(0.2, side, 0)).toBe(0.5);
  });

  it('reserves the requested content height for vertical docks', () => {
    expect(verticalDockBounds(640, 180, 240)).toEqual({ min: 180, max: 400 });
    expect(verticalDockBounds(300, 180, 240)).toEqual({ min: 180, max: 180 });
  });
});
