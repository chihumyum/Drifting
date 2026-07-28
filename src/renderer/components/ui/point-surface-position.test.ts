import { describe, expect, it } from 'vitest';
import { computePointSurfacePosition } from './point-surface-position';

describe('computePointSurfacePosition', () => {
  it('keeps an in-bounds point unchanged', () => {
    expect(
      computePointSurfacePosition({
        x: 80,
        y: 60,
        width: 180,
        height: 120,
        viewportWidth: 800,
        viewportHeight: 600,
        viewportPadding: 8,
      }),
    ).toEqual({ left: 80, top: 60 });
  });

  it('clamps the surface at the bottom-right viewport gutter', () => {
    expect(
      computePointSurfacePosition({
        x: 760,
        y: 570,
        width: 180,
        height: 120,
        viewportWidth: 800,
        viewportHeight: 600,
        viewportPadding: 8,
      }),
    ).toEqual({ left: 612, top: 472 });
  });
});
