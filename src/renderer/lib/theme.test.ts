import { afterEach, describe, expect, it, vi } from 'vitest';
import { initAccentColor } from './theme';

describe('theme migration', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('removes the legacy inline accent instead of overriding semantic palettes', () => {
    const removeProperty = vi.fn();
    const removeItem = vi.fn();
    vi.stubGlobal('document', { documentElement: { style: { removeProperty } } });
    vi.stubGlobal('localStorage', { removeItem });

    initAccentColor();

    expect(removeProperty.mock.calls.map(([property]) => property)).toEqual([
      '--accent',
      '--accent-border',
      '--accent-foreground',
      '--ring',
    ]);
    expect(removeItem).toHaveBeenCalledWith('accentHue');
  });

  it('does not make app startup depend on localStorage availability', () => {
    const removeProperty = vi.fn();
    vi.stubGlobal('document', { documentElement: { style: { removeProperty } } });
    vi.stubGlobal('localStorage', {
      removeItem: vi.fn(() => {
        throw new DOMException('Storage denied', 'SecurityError');
      }),
    });

    expect(() => initAccentColor()).not.toThrow();
    expect(removeProperty).toHaveBeenCalledTimes(4);
  });
});
