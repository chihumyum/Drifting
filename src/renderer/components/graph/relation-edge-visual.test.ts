import { describe, expect, it } from 'vitest';
import { relationArrowMarkerId, relationEdgePath } from './relation-edge-visual';

describe('relation edge visuals', () => {
  it('preserves the existing centre-to-centre path for non-directed relations', () => {
    expect(relationEdgePath({ x1: 10, y1: 20, x2: 90, y2: 100, directed: false })).toBe(
      'M 10 20 C 10 60, 90 60, 90 100',
    );
  });

  it('stops a horizontal directed relation before the target card', () => {
    expect(
      relationEdgePath({
        x1: 10,
        y1: 20,
        x2: 110,
        y2: 20,
        directed: true,
        targetInsetX: 30,
        targetInsetY: 15,
      }),
    ).toBe('M 10 20 C 45 20, 45 20, 80 20');
  });

  it('stops a vertical directed relation before the target card', () => {
    expect(
      relationEdgePath({
        x1: 10,
        y1: 20,
        x2: 30,
        y2: 120,
        directed: true,
        targetInsetX: 30,
        targetInsetY: 25,
      }),
    ).toBe('M 10 20 C 10 57.5, 30 57.5, 30 95');
  });

  it('sanitizes marker ids for use in SVG url references', () => {
    expect(relationArrowMarkerId('story edge', 'legacy:项目/先于')).toBe('story-edge-legacy------');
  });
});
