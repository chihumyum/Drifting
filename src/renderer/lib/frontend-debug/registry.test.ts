import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFrontendDebugRegistry, registerFrontendDebugSlice } from './registry';

class FakeHTMLElement {}

describe('frontend debug registry lifecycle', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the latest StrictMode-style registration and removes it on cleanup', () => {
    const fakeWindow = {
      innerWidth: 390,
      innerHeight: 844,
      devicePixelRatio: 3,
      visualViewport: null,
      getSelection: () => null,
    } as unknown as Window;
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('location', { pathname: '/', hash: '' });
    vi.stubGlobal('document', {
      activeElement: null,
      documentElement: { dataset: {} },
    });
    vi.stubGlobal('HTMLElement', FakeHTMLElement);

    const api = installFrontendDebugRegistry();
    const removeFirst = registerFrontendDebugSlice('mobile.workspace', () => ({
      activeKey: 'first',
    }));
    const removeSecond = registerFrontendDebugSlice('mobile.workspace', () => ({
      activeKey: 'second',
    }));
    removeFirst();
    expect(api.snapshot()).toMatchObject({
      slices: { 'mobile.workspace': { activeKey: 'second' } },
    });
    removeSecond();
    expect(api.snapshot()).toMatchObject({ slices: {} });
  });
});
