import { describe, expect, it } from 'vitest';
import { isIosWebKit, qualifiesAsCaretTap } from './ios-caret-tap';

describe('iOS caret tap correction gates', () => {
  it('accepts only a short, still tap and leaves scrolls and long-presses native', () => {
    expect(qualifiesAsCaretTap({ movementPx: 0, durationMs: 80 })).toBe(true);
    expect(qualifiesAsCaretTap({ movementPx: 12, durationMs: 350 })).toBe(true);
    // A travelled finger is a scroll; a held finger is the loupe / selection.
    expect(qualifiesAsCaretTap({ movementPx: 13, durationMs: 80 })).toBe(false);
    expect(qualifiesAsCaretTap({ movementPx: 0, durationMs: 351 })).toBe(false);
    expect(qualifiesAsCaretTap({ movementPx: Number.NaN, durationMs: 80 })).toBe(false);
    expect(qualifiesAsCaretTap({ movementPx: 0, durationMs: Number.NaN })).toBe(false);
  });

  it('targets iPhone, iPad, and desktop-class iPadOS WebKit only', () => {
    const iphone =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)';
    const ipadDesktopClass =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
    const macSafari = ipadDesktopClass;
    const androidChrome =
      'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0';

    expect(isIosWebKit(iphone, 5)).toBe(true);
    expect(isIosWebKit(ipadDesktopClass, 5)).toBe(true);
    // Real macOS WKWebView reports no touch points and must stay untouched.
    expect(isIosWebKit(macSafari, 0)).toBe(false);
    // Android Chrome is WebKit-derived but places the caret precisely already.
    expect(isIosWebKit(androidChrome, 5)).toBe(false);
    expect(isIosWebKit('', 5)).toBe(false);
  });
});
