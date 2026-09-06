import { describe, expect, it } from 'vitest';
import { nearestVerticalDot, verticalTimelineSlots } from './vertical-timeline-gestures';

describe('vertical timeline gesture helpers', () => {
  it('picks the nearest dot by y inside the hit radius only', () => {
    const dots = [
      { id: 'a', y: 100 },
      { id: 'b', y: 130 },
      { id: 'c', y: 300 },
    ];
    expect(nearestVerticalDot(dots, 112)?.id).toBe('a');
    expect(nearestVerticalDot(dots, 118)?.id).toBe('b');
    expect(nearestVerticalDot(dots, 200)).toBeNull();
    expect(nearestVerticalDot(dots, 322)?.id).toBe('c');
    expect(nearestVerticalDot(dots, 323)).toBeNull();
  });

  it('offers midpoint slots between placed chapters plus both ends', () => {
    expect(verticalTimelineSlots([1, 6, 20], 5)).toEqual([
      { afterIndex: -1, order: -4 },
      { afterIndex: 0, order: 3.5 },
      { afterIndex: 1, order: 13 },
      { afterIndex: 2, order: 25 },
    ]);
    expect(verticalTimelineSlots([], 5)).toEqual([{ afterIndex: -1, order: 1 }]);
  });
});
