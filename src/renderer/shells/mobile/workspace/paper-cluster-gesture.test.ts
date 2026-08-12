import { describe, expect, it } from 'vitest';
import {
  paperClusterDestination,
  paperClusterPreview,
  paperClusterQuickSwitchIndex,
} from './paper-cluster-gesture';

describe('mobile paper cluster gesture', () => {
  it('maps focused upward and downward drags to the matching context workspace', () => {
    expect(paperClusterPreview('focused', -150, 1_000)).toEqual({
      target: 'bottom',
      progress: 0.5,
    });
    expect(paperClusterPreview('focused', 300, 1_000)).toEqual({ target: 'top', progress: 1 });
  });

  it('distinguishes a tap from a drag using pointer-up displacement', () => {
    expect(paperClusterDestination('focused', 5, 1_000)).toBeNull();
    expect(paperClusterDestination('focused', -5, 1_000)).toBeNull();
    expect(paperClusterDestination('focused', -120, 1_000)).toBe('bottom');
    expect(paperClusterDestination('focused', 120, 1_000)).toBe('top');
  });

  it('docks short drags back to the focused paper and closes revealed panels outward', () => {
    expect(paperClusterDestination('focused', -80, 1_000)).toBe('focused');
    expect(paperClusterDestination('bottom', 190, 1_000)).toBe('focused');
    expect(paperClusterDestination('top', -190, 1_000)).toBe('focused');
    expect(paperClusterDestination('bottom', -20, 1_000)).toBe('bottom');
    expect(paperClusterDestination('top', 20, 1_000)).toBe('top');
  });

  it('maps the panel edge to the same physical drag distance on any viewport', () => {
    const short = paperClusterPreview('focused', -120, 800);
    const tall = paperClusterPreview('focused', -120, 1_200);
    expect(short.progress * 0.3 * 800).toBeCloseTo(120);
    expect(tall.progress * 0.3 * 1_200).toBeCloseTo(120);
  });

  it('quick-switches across papers with a short horizontal pill drag', () => {
    expect(paperClusterQuickSwitchIndex(2, -44, 6)).toBe(3);
    expect(paperClusterQuickSwitchIndex(2, -132, 6)).toBe(5);
    expect(paperClusterQuickSwitchIndex(2, 88, 6)).toBe(0);
    expect(paperClusterQuickSwitchIndex(0, 100, 6)).toBe(0);
    expect(paperClusterQuickSwitchIndex(5, -100, 6)).toBe(5);
    expect(paperClusterQuickSwitchIndex(0, 0, 0)).toBe(-1);
  });
});
