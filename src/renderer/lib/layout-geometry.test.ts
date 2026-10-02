import { describe, expect, it } from 'vitest';
import {
  clampDimension,
  clampSidebarWidth,
  clampSidebarSplitRatio,
  sidebarTabMinimumWidth,
  sidebarSplitMinWidth,
  SIDEBAR_DIVIDER_WIDTH,
  MIN_DESKTOP_CONTENT_WIDTH,
  parsePersistedDimension,
  sidebarWidthBounds,
  verticalDockBounds,
} from './layout-geometry';

const minima = { left: 216, right: 224 }; // Synthetic measured tab rows.
const splits = { left: sidebarSplitMinWidth(minima.left), right: sidebarSplitMinWidth(minima.right) };

describe('layout geometry', () => {
  it('derives each minimum from all labels, gaps and edge padding', () => {
    expect(sidebarTabMinimumWidth([50, 60, 35], 12, 12)).toBe(181);
    expect(sidebarTabMinimumWidth([50, 60, 35, 40], 12, 12)).toBe(233);
    expect(sidebarTabMinimumWidth([26, 26, 26], 12, 12)).toBe(114);
    expect(sidebarSplitMinWidth(181)).toBe(363);
  });
  it('rejects corrupt persisted dimensions', () => {
    expect(parsePersistedDimension(null)).toBeNull();
    expect(parsePersistedDimension('')).toBeNull();
    expect(parsePersistedDimension('NaN')).toBeNull();
    expect(parsePersistedDimension('-1')).toBeNull();
    expect(parsePersistedDimension('320')).toBe(320);
  });

  it('keeps both sidebars from consuming the desktop content column', () => {
    expect(sidebarWidthBounds('left', 1024, 300, minima.left)).toEqual({ min: 216, max: 304 });
    expect(clampSidebarWidth(800, 'left', 1024, 300, minima.left)).toBe(304);
    expect(clampSidebarWidth(800, 'right', 1000, 280, minima.right)).toBe(300);
  });

  it('falls back to the minimum when the viewport cannot satisfy every constraint', () => {
    expect(clampSidebarWidth(500, 'right', 480, 280, minima.right)).toBe(224);
    expect(clampDimension(Number.NaN, { min: 10, max: 100 })).toBe(10);
  });

  it('lets both sidebars reach dual-column width on a laptop while reserving the editor', () => {
    expect(clampSidebarWidth(650, 'left', 1440, 300, minima.left)).toBe(650);
    expect(clampSidebarWidth(650, 'right', 1440, 280, minima.right)).toBe(650);
    expect(clampSidebarWidth(800, 'left', 1440, 600, minima.left)).toBe(420);
    for (const viewport of [1366, 1440, 1512]) {
      const left = clampSidebarWidth(splits.left, 'left', viewport, splits.right, minima.left);
      const right = clampSidebarWidth(splits.right, 'right', viewport, left, minima.right);
      expect(left).toBe(splits.left);
      expect(right).toBe(splits.right);
      expect(viewport - left - right).toBeGreaterThanOrEqual(MIN_DESKTOP_CONTENT_WIDTH);
    }
  });

  it.each(['left', 'right'] as const)('preserves full labels in the %s sidebar and both split panes', (side) => {
    expect(clampSidebarWidth(140, side, 1440, 280, minima[side])).toBe(minima[side]);
    for (const width of [splits[side], 600, 601, 800, 1440]) {
      for (const preferred of [0, 0.2, 0.5, 0.8, 1, Number.NaN]) {
        const ratio = clampSidebarSplitRatio(preferred, minima[side], width);
        const available = width - SIDEBAR_DIVIDER_WIDTH;
        expect(available * ratio).toBeGreaterThanOrEqual(minima[side] - 1e-9);
        expect(available * (1 - ratio)).toBeGreaterThanOrEqual(minima[side] - 1e-9);
      }
    }
    expect(clampSidebarSplitRatio(0.2, minima[side], 0)).toBe(0.5);
  });

  it('reserves the requested content height for vertical docks', () => {
    expect(verticalDockBounds(640, 180, 240)).toEqual({ min: 180, max: 400 });
    expect(verticalDockBounds(300, 180, 240)).toEqual({ min: 180, max: 180 });
  });
});
