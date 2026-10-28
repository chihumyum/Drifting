import { describe, expect, it } from 'vitest';
import { sharedWaveGroup } from './useGlassWave';

// Two timeline lanes holding wave layers keyed by chapter.
const timeline = () => {
  const laneA = { name: 'a' };
  const laneB = { name: 'b' };
  const layer = (key: string, lane: object) => ({ dataset: { waveKey: key }, closest: () => lane });
  const layers = [layer('one', laneA), layer('three', laneA), layer('four', laneB)];
  const container = { querySelectorAll: () => layers } as unknown as HTMLElement;
  return { container, laneA, laneB };
};

describe('a selection that changes rows', () => {
  it('flows along a lane when both chapters sit in it', () => {
    const { container, laneA } = timeline();
    expect(sharedWaveGroup(container, 'one', 'three', '.btl-track')).toBe(laneA);
  });

  it('does not flow across lanes, so the slabs fade and light in place', () => {
    const { container } = timeline();
    expect(sharedWaveGroup(container, 'three', 'four', '.btl-track')).toBeNull();
  });

  it('does not flow from a chapter that is not on the timeline', () => {
    const { container } = timeline();
    expect(sharedWaveGroup(container, 'gone', 'three', '.btl-track')).toBeNull();
  });
});
