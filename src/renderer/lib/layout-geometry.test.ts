import { describe, expect, it } from 'vitest';
import {
  clampDimension,
  clampSidebarWidth,
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
    expect(sidebarWidthBounds('left', 1000, 300)).toEqual({ min: 140, max: 280 });
    expect(clampSidebarWidth(800, 'left', 1000, 300)).toBe(280);
    expect(clampSidebarWidth(800, 'right', 1000, 280)).toBe(300);
  });

  it('falls back to the minimum when the viewport cannot satisfy every constraint', () => {
    expect(clampSidebarWidth(500, 'right', 480, 280)).toBe(200);
    expect(clampDimension(Number.NaN, { min: 10, max: 100 })).toBe(10);
  });

  it('reserves the requested content height for vertical docks', () => {
    expect(verticalDockBounds(640, 180, 240)).toEqual({ min: 180, max: 400 });
    expect(verticalDockBounds(300, 180, 240)).toEqual({ min: 180, max: 180 });
  });
});
