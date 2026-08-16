import { beforeEach, describe, expect, it, vi } from 'vitest';

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class MockChannel {},
  convertFileSrc: vi.fn(),
  invoke: tauriMocks.invoke,
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: tauriMocks.listen }));

vi.mock('../lib/config', () => ({
  APP_CONFIG: { API_BASE_URL: 'http://localhost:3000' },
  canUseExternalContent: () => false,
  canUseHostedService: () => false,
}));

import { tauriPlatform } from './tauri';

describe('local-only native account boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(globalThis, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
  });

  it('rejects account OAuth before creating state or opening a browser', async () => {
    await expect(tauriPlatform.auth.openOAuthBrowser('google')).rejects.toThrow(
      'HOSTED_SERVICE_DISABLED',
    );
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
  });

  it('rejects URL metadata before invoking native HTTP while offline', async () => {
    await expect(tauriPlatform.material.resolveUrlMeta('https://example.com')).resolves.toEqual({
      ok: false,
      error: 'EXTERNAL_CONTENT_OFFLINE: URL metadata is unavailable while offline.',
    });
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
  });
});
