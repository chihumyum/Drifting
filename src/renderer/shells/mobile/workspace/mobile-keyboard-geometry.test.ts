import { describe, expect, it } from 'vitest';
import { mobileKeyboardInset } from './mobile-keyboard-geometry';

describe('mobileKeyboardInset', () => {
  it('tracks the visual viewport bottom one pixel per keyboard pixel', () => {
    expect(mobileKeyboardInset(844, { height: 510, offsetTop: 0 })).toBe(334);
    expect(mobileKeyboardInset(844, { height: 511, offsetTop: 0 })).toBe(333);
  });

  it('accounts for a visual viewport that has been panned to keep the caret visible', () => {
    expect(mobileKeyboardInset(844, { height: 510, offsetTop: 28 })).toBe(306);
  });

  it('never creates a negative or invalid inset', () => {
    expect(mobileKeyboardInset(700, { height: 760, offsetTop: 0 })).toBe(0);
    expect(mobileKeyboardInset(Number.NaN, { height: 500, offsetTop: 0 })).toBe(0);
    expect(mobileKeyboardInset(700, null)).toBe(0);
  });
});
