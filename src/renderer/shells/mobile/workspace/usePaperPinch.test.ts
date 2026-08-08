import { describe, expect, it } from 'vitest';
import { paperRevealForMidpoint, pinchProgress } from './usePaperPinch';

describe('mobile paper pinch model', () => {
  it('maps the upper half to bottom tools and lower half to top structure', () => {
    expect(paperRevealForMidpoint(100, 800)).toBe('bottom');
    expect(paperRevealForMidpoint(700, 800)).toBe('top');
    expect(paperRevealForMidpoint(400, 800)).toBeNull();
  });

  it('turns an inward pinch into reveal progress and an outward pinch into close progress', () => {
    expect(pinchProgress(200, 140, false)).toBe(1);
    expect(pinchProgress(200, 200, false)).toBe(0);
    expect(pinchProgress(200, 260, true)).toBe(0);
    expect(pinchProgress(200, 200, true)).toBe(1);
  });
});
