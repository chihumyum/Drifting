import { describe, expect, it } from 'vitest';

import {
  EXPANDED_TABLET_MIN_PORTRAIT_CSS_PX,
  resolveUiShellMode,
} from './ui-shell-mode';

describe('resolveUiShellMode', () => {
  it('keeps every native desktop target on the desktop shell', () => {
    expect(resolveUiShellMode({ target: 'desktop', screenWidth: 390, screenHeight: 844 })).toEqual({
      deviceClass: 'desktop',
      shellMode: 'desktop',
    });
  });

  it.each([
    { name: 'phone', width: 390, height: 844 },
    { name: 'compact tablet', width: 744, height: 1133 },
    { name: 'reported landscape compact tablet', width: 1133, height: 744 },
  ])('uses the mobile shell for a $name', ({ width, height }) => {
    expect(resolveUiShellMode({ target: 'mobile', screenWidth: width, screenHeight: height })).toEqual(
      {
        deviceClass: 'compact',
        shellMode: 'mobile',
      },
    );
  });

  it.each([
    { width: EXPANDED_TABLET_MIN_PORTRAIT_CSS_PX, height: 1366 },
    { width: 1366, height: EXPANDED_TABLET_MIN_PORTRAIT_CSS_PX },
  ])('reuses the desktop shell for an expanded native tablet at %o', ({ width, height }) => {
    expect(resolveUiShellMode({ target: 'mobile', screenWidth: width, screenHeight: height })).toEqual(
      {
        deviceClass: 'expanded',
        shellMode: 'desktop',
      },
    );
  });

  it('fails safe to the compact mobile shell when native geometry is unavailable', () => {
    expect(resolveUiShellMode({ target: 'mobile', screenWidth: 0, screenHeight: NaN })).toEqual({
      deviceClass: 'compact',
      shellMode: 'mobile',
    });
  });

  it('keeps an unavailable browser runtime on the development desktop shell', () => {
    expect(resolveUiShellMode({ target: 'unknown', screenWidth: 390, screenHeight: 844 })).toEqual({
      deviceClass: 'desktop',
      shellMode: 'desktop',
    });
  });
});
