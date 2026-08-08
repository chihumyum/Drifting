import { describe, expect, it } from 'vitest';
import { paperClusterDestination, paperClusterPreview } from './paper-cluster-gesture';

describe('mobile paper cluster gesture', () => {
  it('maps focused upward and downward drags to the matching context workspace', () => {
    expect(paperClusterPreview('focused', -75)).toEqual({ target: 'bottom', progress: 0.5 });
    expect(paperClusterPreview('focused', 150)).toEqual({ target: 'top', progress: 1 });
  });

  it('distinguishes a tap from a drag using pointer-up displacement', () => {
    expect(paperClusterDestination('focused', 5)).toBeNull();
    expect(paperClusterDestination('focused', -5)).toBeNull();
    expect(paperClusterDestination('focused', -60)).toBe('bottom');
    expect(paperClusterDestination('focused', 60)).toBe('top');
  });

  it('docks short drags back to the focused paper and closes revealed panels outward', () => {
    expect(paperClusterDestination('focused', -40)).toBe('focused');
    expect(paperClusterDestination('bottom', 95)).toBe('focused');
    expect(paperClusterDestination('top', -95)).toBe('focused');
    expect(paperClusterDestination('bottom', -20)).toBe('bottom');
    expect(paperClusterDestination('top', 20)).toBe('top');
  });
});
