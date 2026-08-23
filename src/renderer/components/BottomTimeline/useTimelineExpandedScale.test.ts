import { describe, expect, it } from 'vitest';
import { timelinePinchAnchoredScrollLeft } from './useTimelineExpandedScale';

describe('timeline pinch midpoint anchoring', () => {
  it('keeps the authored content point beneath the moving pinch midpoint', () => {
    expect(
      timelinePinchAnchoredScrollLeft({
        anchorContentX: 300,
        nextScale: 2,
        midpointClientX: 240,
        containerLeft: 40,
        maxScrollLeft: 900,
      }),
    ).toBe(400);
  });

  it('clamps the anchored scroll to both content edges', () => {
    expect(
      timelinePinchAnchoredScrollLeft({
        anchorContentX: 20,
        nextScale: 0.5,
        midpointClientX: 200,
        containerLeft: 0,
        maxScrollLeft: 500,
      }),
    ).toBe(0);
    expect(
      timelinePinchAnchoredScrollLeft({
        anchorContentX: 800,
        nextScale: 2,
        midpointClientX: 100,
        containerLeft: 0,
        maxScrollLeft: 500,
      }),
    ).toBe(500);
  });
});
