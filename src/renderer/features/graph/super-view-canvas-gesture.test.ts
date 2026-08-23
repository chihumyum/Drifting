import { describe, expect, it } from 'vitest';
import { beginSuperViewPinch, updateSuperViewPinch } from './super-view-canvas-gesture';

describe('Super View canvas pinch', () => {
  it('keeps the authored world point under a moving midpoint', () => {
    const origin = beginSuperViewPinch({
      points: [
        { x: 130, y: 180 },
        { x: 230, y: 180 },
      ],
      viewportOrigin: { x: 30, y: 80 },
      pan: { x: 20, y: 10 },
      zoom: 1,
    });
    const next = updateSuperViewPinch({
      origin,
      points: [
        { x: 120, y: 200 },
        { x: 320, y: 200 },
      ],
      viewportOrigin: { x: 30, y: 80 },
      minZoom: 0.25,
      maxZoom: 3,
    });
    const midpoint = { x: 190, y: 120 };
    expect(next.zoom).toBe(2);
    expect(next.pan.x + origin.world.x * next.zoom).toBeCloseTo(midpoint.x);
    expect(next.pan.y + origin.world.y * next.zoom).toBeCloseTo(midpoint.y);
  });

  it('clamps scale without losing midpoint anchoring', () => {
    const origin = beginSuperViewPinch({
      points: [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
      ],
      viewportOrigin: { x: 0, y: 0 },
      pan: { x: 0, y: 0 },
      zoom: 1,
    });
    const next = updateSuperViewPinch({
      origin,
      points: [
        { x: -100, y: 20 },
        { x: 120, y: 20 },
      ],
      viewportOrigin: { x: 0, y: 0 },
      minZoom: 0.5,
      maxZoom: 2,
    });
    expect(next.zoom).toBe(2);
    expect(next.pan.x + origin.world.x * next.zoom).toBeCloseTo(10);
    expect(next.pan.y + origin.world.y * next.zoom).toBeCloseTo(20);
  });
});
