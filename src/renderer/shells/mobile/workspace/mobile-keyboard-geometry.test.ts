import { describe, expect, it } from 'vitest';
import {
  mobileKeyboardInset,
  mobileNativeKeyboardInset,
  mobileSoftwareKeyboardVisible,
} from './mobile-keyboard-geometry';

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

describe('mobileNativeKeyboardInset', () => {
  it('normalizes the Android IME inset exposed by the native WebView bridge', () => {
    expect(mobileNativeKeyboardInset('420.571px')).toBe(420.571);
    expect(mobileNativeKeyboardInset('-3px')).toBe(0);
    expect(mobileNativeKeyboardInset('not-a-size')).toBe(0);
    expect(mobileNativeKeyboardInset('')).toBe(0);
  });
});

describe('mobileSoftwareKeyboardVisible', () => {
  it('stays open when iOS pans a reduced visual viewport above the keyboard', () => {
    expect(mobileSoftwareKeyboardVisible(763, { height: 509, offsetTop: 254 })).toBe(true);
    expect(mobileKeyboardInset(763, { height: 509, offsetTop: 254 })).toBe(0);
  });

  it('does not treat a full-height hardware-keyboard viewport as software input', () => {
    expect(mobileSoftwareKeyboardVisible(763, { height: 763, offsetTop: 0 })).toBe(false);
  });
});
