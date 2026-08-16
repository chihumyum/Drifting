import { describe, expect, it, vi } from 'vitest';

import type { SyncObjectStorePlatformApi } from '../platform';
import { createNativeSyncObjectCodec } from './native-object-codec';

const SHA = `sha256:${'1'.repeat(64)}`;

function native(overrides: Partial<SyncObjectStorePlatformApi> = {}): SyncObjectStorePlatformApi {
  return {
    stageBytes: vi.fn(async (bytes) => ({
      sourceRef: 'syncobj:stage.bytes',
      sizeBytes: bytes.byteLength,
      storedSha256: SHA,
    })),
    stageAssetSource: vi.fn(async () => ({
      sourceRef: 'syncobj:stage.asset',
      sizeBytes: 3,
      storedSha256: SHA,
    })),
    readProtocolBytes: vi.fn(async () => Uint8Array.of(1, 2, 3)),
    gcOrphans: vi.fn(async () => ({ removedObjects: 0, removedTemporaryFiles: 0 })),
    ...overrides,
  };
}

describe('native SyncEngine plaintext object boundary', () => {
  it('stages protocol bytes and brands only root-confined opaque refs', async () => {
    const port = native();
    const codec = createNativeSyncObjectCodec(port);

    await expect(codec.stageProtocolBytes(Uint8Array.of(1, 2, 3))).resolves.toEqual({
      sourceRef: 'syncobj:stage.bytes',
      sizeBytes: 3,
      storedSha256: SHA,
    });
    expect(port.stageBytes).toHaveBeenCalledWith(Uint8Array.of(1, 2, 3));
  });

  it('reads protocol bytes only through the bounded native port', async () => {
    const port = native();
    const codec = createNativeSyncObjectCodec(port);

    await expect(
      codec.readProtocolBytes('syncobj:stage.bytes' as never, 2 * 1024 * 1024),
    ).resolves.toEqual(Uint8Array.of(1, 2, 3));
    expect(port.readProtocolBytes).toHaveBeenCalledWith(
      'syncobj:stage.bytes',
      2 * 1024 * 1024,
    );
    await expect(codec.readProtocolBytes('syncobj:stage.bytes' as never, 0)).rejects.toThrow(
      'positive safe integer',
    );
  });

  it('fails closed on path-shaped refs and malformed hashes returned by native', async () => {
    const codec = createNativeSyncObjectCodec(
      native({
        stageBytes: vi.fn(async () => ({
          sourceRef: '/tmp/plaintext',
          sizeBytes: 1,
          storedSha256: 'bad',
        })),
      }),
    );

    await expect(codec.stageProtocolBytes(Uint8Array.of(1))).rejects.toThrow();
  });
});
