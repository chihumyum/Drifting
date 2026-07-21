import { beforeEach, describe, expect, it, vi } from 'vitest';

const tauriMocks = vi.hoisted(() => ({
  convertFileSrc: vi.fn((path: string) => `asset://${path}`),
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: tauriMocks.convertFileSrc,
  invoke: tauriMocks.invoke,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: tauriMocks.listen,
}));

import { tauriPlatform } from './tauri';

type TauriTestGlobal = typeof globalThis & {
  __TAURI_INTERNALS__?: unknown;
};

describe('tauri local resource URLs', () => {
  beforeEach(() => {
    delete (globalThis as TauriTestGlobal).__TAURI_INTERNALS__;
    tauriMocks.convertFileSrc.mockClear();
  });

  it('does not expose a file URL outside the Tauri runtime', () => {
    expect(tauriPlatform.material.toLocalResourceUrl('/tmp/cover image.png')).toBeNull();
    expect(tauriMocks.convertFileSrc).not.toHaveBeenCalled();
  });

  it('converts the exact native path inside the Tauri runtime', () => {
    Object.defineProperty(globalThis, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });

    expect(tauriPlatform.material.toLocalResourceUrl('/tmp/cover image.png')).toBe(
      'asset:///tmp/cover image.png',
    );
    expect(tauriMocks.convertFileSrc).toHaveBeenCalledWith('/tmp/cover image.png');
  });
});
