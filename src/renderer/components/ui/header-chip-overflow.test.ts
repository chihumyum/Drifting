import { describe, expect, it } from 'vitest';
import { countFittingHeaderChips } from './header-chip-overflow';

describe('countFittingHeaderChips', () => {
  it('returns every chip when the whole row fits', () => {
    expect(countFittingHeaderChips([42, 46, 50], 154, 8)).toBe(3);
  });

  it('keeps the leading chips that fit completely', () => {
    expect(countFittingHeaderChips([42, 46, 50], 110, 8)).toBe(2);
  });

  it('does not expose a partially clipped first chip', () => {
    expect(countFittingHeaderChips([80, 52], 50, 8)).toBe(0);
  });

  it('ignores subpixel rounding at the boundary', () => {
    expect(countFittingHeaderChips([42, 46.75], 96, 8)).toBe(2);
  });

  it('counts the configured gap only between chips', () => {
    expect(countFittingHeaderChips([40, 40], 80, 8)).toBe(1);
    expect(countFittingHeaderChips([40, 40], 88, 8)).toBe(2);
  });
});
