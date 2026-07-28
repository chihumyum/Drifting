import { describe, expect, it } from 'vitest';
import { countFittingHeaderChips } from './header-chip-overflow';

describe('countFittingHeaderChips', () => {
  it('returns every chip when the whole row fits', () => {
    expect(countFittingHeaderChips([42, 96, 154], 154)).toBe(3);
  });

  it('keeps the leading chips that fit completely', () => {
    expect(countFittingHeaderChips([42, 96, 154], 110)).toBe(2);
  });

  it('does not expose a partially clipped first chip', () => {
    expect(countFittingHeaderChips([80, 140], 50)).toBe(0);
  });

  it('ignores subpixel rounding at the boundary', () => {
    expect(countFittingHeaderChips([42, 96.75], 96)).toBe(2);
  });
});
