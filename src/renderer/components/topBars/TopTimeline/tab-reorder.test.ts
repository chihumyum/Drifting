import { describe, expect, it } from 'vitest';
import { projectTabReorder, tabDragScrollSpeed } from './tab-reorder';

describe('tab reorder geometry', () => {
  it('keeps the original slot until the leading edge crosses half a neighbour', () => {
    expect(projectTabReorder([100, 100, 100], 0, 49)).toEqual({ to: 0, offsets: [0, 0, 0] });
    expect(projectTabReorder([100, 100, 100], 0, 51)).toEqual({ to: 1, offsets: [0, -100, 0] });
  });
  it('moves unequal-width tabs in both directions without moving the trailing draft', () => {
    expect(projectTabReorder([80, 220, 120], 0, 400)).toEqual({ to: 2, offsets: [0, -80, -80] });
    expect(projectTabReorder([80, 220, 120], 2, -50)).toEqual({ to: 0, offsets: [120, 120, 0] });
  });
  it('moves a wider split as one slot and reverses without accumulated offsets', () => {
    expect(projectTabReorder([100, 240, 100], 1, 200)).toEqual({ to: 2, offsets: [0, 0, -240] });
    expect(projectTabReorder([100, 240, 100], 1, 0)).toEqual({ to: 0, offsets: [240, 0, 0] });
    expect(projectTabReorder([100, 240, 100], 1, 100)).toEqual({ to: 1, offsets: [0, 0, 0] });
  });
  it('keeps a lone tab stable', () => {
    expect(projectTabReorder([180], 0, 500)).toEqual({ to: 0, offsets: [0] });
  });
  it('scrolls only in the edge zones with bounded speed', () => {
    expect(tabDragScrollSpeed(100, 300)).toBe(0);
    expect(tabDragScrollSpeed(20, 300)).toBe(-300);
    expect(tabDragScrollSpeed(280, 300)).toBe(300);
    expect(tabDragScrollSpeed(500, 300)).toBe(600);
    expect(tabDragScrollSpeed(15, 60)).toBe(0);
  });
});
