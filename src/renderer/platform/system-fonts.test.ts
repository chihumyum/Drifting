import { beforeEach, describe, expect, it, vi } from 'vitest';

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: vi.fn(),
  invoke: tauriMocks.invoke,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}));

import { tauriPlatform } from './tauri';

describe('Tauri system font enumeration', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
    tauriMocks.invoke.mockReset();
  });

  it('uses the typed native typography command', async () => {
    const fonts = [
      { family: 'Charter', aliases: [] },
      { family: 'Songti SC', aliases: ['宋体-简'] },
    ];
    tauriMocks.invoke.mockResolvedValue(fonts);

    await expect(tauriPlatform.typography.listSystemFonts()).resolves.toEqual(fonts);
    expect(tauriMocks.invoke).toHaveBeenCalledWith(
      'typography_list_system_fonts',
      undefined,
    );
  });
});
