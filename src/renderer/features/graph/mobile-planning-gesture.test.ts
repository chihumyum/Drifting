import { describe, expect, it } from 'vitest';
import {
  MOBILE_PLANNING_CONTEXT_MENU_MS,
  MOBILE_PLANNING_DRAG_ARM_MS,
  mobilePlanningEdgeAutoscrollDelta,
  resolveMobilePlanningGesture,
} from './mobile-planning-gesture';

describe('mobile Planning gesture ownership', () => {
  it('separates tap, arm, drag, menu, early pan, pinch, and cancellation', () => {
    const card = (sample: Partial<Parameters<typeof resolveMobilePlanningGesture>[0]>) =>
      resolveMobilePlanningGesture({
        surface: 'card',
        elapsedMs: 0,
        distancePx: 0,
        pointerCount: 1,
        ...sample,
      });

    expect(card({ ended: true })).toBe('tap');
    expect(card({ elapsedMs: MOBILE_PLANNING_DRAG_ARM_MS })).toBe('armed');
    expect(
      card({ elapsedMs: MOBILE_PLANNING_DRAG_ARM_MS, distancePx: 9 }),
    ).toBe('drag');
    expect(card({ elapsedMs: MOBILE_PLANNING_CONTEXT_MENU_MS })).toBe('menu');
    expect(card({ elapsedMs: 100, distancePx: 9 })).toBe('pan');
    expect(card({ pointerCount: 2 })).toBe('pinch');
    expect(card({ cancelled: true })).toBe('cancel');
  });

  it('gives background movement to pan and a second pointer to pinch', () => {
    expect(
      resolveMobilePlanningGesture({
        surface: 'background',
        elapsedMs: 20,
        distancePx: 10,
        pointerCount: 1,
      }),
    ).toBe('pan');
    expect(
      resolveMobilePlanningGesture({
        surface: 'background',
        elapsedMs: 20,
        distancePx: 0,
        pointerCount: 2,
      }),
    ).toBe('pinch');
  });

  it('autoscrolls proportionally, stops centrally, and clamps at both ends', () => {
    const base = { left: 100, right: 500, scrollLeft: 120, maxScrollLeft: 400 };
    expect(mobilePlanningEdgeAutoscrollDelta({ ...base, clientX: 124 })).toBe(-9);
    expect(mobilePlanningEdgeAutoscrollDelta({ ...base, clientX: 476 })).toBe(9);
    expect(mobilePlanningEdgeAutoscrollDelta({ ...base, clientX: 300 })).toBe(0);
    expect(
      mobilePlanningEdgeAutoscrollDelta({ ...base, clientX: 100, scrollLeft: 0 }),
    ).toBe(0);
    expect(
      mobilePlanningEdgeAutoscrollDelta({
        ...base,
        clientX: 500,
        scrollLeft: 400,
      }),
    ).toBe(0);
  });
});
