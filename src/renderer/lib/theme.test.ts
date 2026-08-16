import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyAccentColor, initAccentColor, normalizeAccentColor } from './theme';

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
    expect(removeItem.mock.calls.map(([key]) => key)).toEqual(['accentHue', 'accentColor']);
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

describe('user accent color', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('normalizes six-digit hex colors and rejects malformed preferences', () => {
    expect(normalizeAccentColor('#6A7DA0')).toBe('#6a7da0');
    expect(normalizeAccentColor('  #6A7DA0  ')).toBe('#6a7da0');
    expect(normalizeAccentColor('#fff')).toBeNull();
    expect(normalizeAccentColor('blue')).toBeNull();
    expect(normalizeAccentColor(null)).toBeNull();
  });

  it('converts the color-picker value to the HSL triplets consumed by the palette', () => {
    const setProperty = vi.fn();
    const removeProperty = vi.fn();
    vi.stubGlobal('document', {
      documentElement: { style: { setProperty, removeProperty } },
    });

    applyAccentColor('#6A7DA0');

    expect(setProperty.mock.calls).toEqual([
      ['--accent', '218.89 22.13% 52.16%'],
      ['--accent-foreground', '0 0% 0%'],
      ['--ring', '218.89 22.13% 52.16%'],
    ]);
    expect(removeProperty.mock.calls.map(([property]) => property)).toEqual([
      '--accent',
      '--accent-border',
      '--accent-foreground',
      '--ring',
    ]);
  });

  it('selects a readable black or white foreground for the chosen accent', () => {
    const setProperty = vi.fn();
    const removeProperty = vi.fn();
    vi.stubGlobal('document', {
      documentElement: { style: { setProperty, removeProperty } },
    });

    applyAccentColor('#000000');
    expect(setProperty).toHaveBeenCalledWith('--accent-foreground', '0 0% 100%');

    setProperty.mockClear();
    removeProperty.mockClear();
    applyAccentColor('#ffffff');
    expect(setProperty).toHaveBeenCalledWith('--accent-foreground', '0 0% 0%');
  });

  it('removes the inline override so light and dark stylesheet defaults take over again', () => {
    const setProperty = vi.fn();
    const removeProperty = vi.fn();
    vi.stubGlobal('document', {
      documentElement: { style: { setProperty, removeProperty } },
    });

    applyAccentColor(null);

    expect(removeProperty.mock.calls.map(([property]) => property)).toEqual([
      '--accent',
      '--accent-border',
      '--accent-foreground',
      '--ring',
    ]);
    expect(setProperty).not.toHaveBeenCalled();
  });
});
