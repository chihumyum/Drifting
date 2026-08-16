import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MemoryProviderLocalObjectStore } from '../local-object-store';
import { NodeLocalFolderTestTransport } from './node-test-transport';
import { LocalFolderObjectLogProvider } from './provider';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'drifting-local-folder-provider-'));
  roots.push(root);
  const localObjects = new MemoryProviderLocalObjectStore();
  const transport = new NodeLocalFolderTestTransport(root, localObjects);
  const provider = new LocalFolderObjectLogProvider(transport, { pageSize: 1 });
  return { root, localObjects, transport, provider };
}

describe('LocalFolderObjectLogProvider', () => {
  it('refuses an absolute or relative folder path before invoking its transport', async () => {
    const openGeneration = vi.fn();
    const provider = new LocalFolderObjectLogProvider({
      openGeneration,
      readCatalog: vi.fn(),
      commitPresent: vi.fn(),
      materializeVerified: vi.fn(),
    });
    for (const secretRef of ['/tmp/generation', '../generation', 'folder/generation', 'C:\\generation']) {
      await expect(
        provider.openGeneration({
          bindingId: 'binding-a',
          syncGenerationId: 'sync-generation-a',
          accountRef: null,
          secretRef,
          authorityGeneration: 1,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_GENERATION' });
    }
    expect(openGeneration).not.toHaveBeenCalled();
  });

  it('reopens the same durable inventory and cursor through a fresh provider instance', async () => {
    const { root, localObjects, provider } = await setup();
    const binding = {
      bindingId: 'binding-a',
      syncGenerationId: 'sync-generation-a',
      accountRef: null,
      secretRef: 'local-folder-root:test',
      authorityGeneration: 1,
    } as const;
    const generation = await provider.openGeneration(binding);
    const bytes = new TextEncoder().encode('restart');
    const { sha256Bytes } = await import('../../protocol');
    await provider.uploadImmutable({
      generation,
      sourceRef: localObjects.put('restart', bytes),
      objectKind: 'checkpoint',
      logicalKeyId: 'checkpoint-restart',
      storedSha256: await sha256Bytes(bytes),
      sizeBytes: bytes.byteLength,
      transferId: 'restart-upload',
      signal: new AbortController().signal,
    });

    const reopenedLocalObjects = new MemoryProviderLocalObjectStore();
    const reopenedTransport = new NodeLocalFolderTestTransport(root, reopenedLocalObjects);
    const reopened = new LocalFolderObjectLogProvider(reopenedTransport);
    const reopenedSyncGeneration = await reopened.openGeneration({ ...binding, bindingId: 'binding-reopened' });
    await expect(reopened.captureStartCursor(reopenedSyncGeneration)).resolves.toBe('local-folder-cursor:1');
    await expect(reopened.listInventory({ generation: reopenedSyncGeneration })).resolves.toMatchObject({
      objects: [{ logicalKeyId: 'checkpoint-restart', objectKind: 'checkpoint' }],
    });
  });
});
