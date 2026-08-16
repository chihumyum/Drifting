import { describe, expect, it } from 'vitest';
import {
  createProviderCursor,
  sha256Bytes,
  type ProviderBinding,
  type ProviderGeneration,
} from '../protocol';
import { MemoryProviderLocalObjectStore } from './local-object-store';
import { MemoryObjectLogProvider } from './memory-provider';
import { ObjectLogProviderError } from './provider-error';

const open = async (
  provider: MemoryObjectLogProvider,
  syncGenerationId = 'sync-generation-a',
  bindingId = `binding-${syncGenerationId}`,
): Promise<ProviderGeneration> => {
  const binding: ProviderBinding = {
    bindingId,
    syncGenerationId,
    accountRef: null,
    secretRef: null,
    authorityGeneration: 1,
  };
  return provider.openGeneration(binding);
};

describe('MemoryObjectLogProvider', () => {
  it('uploads immutable objects idempotently and downloads only verified bytes', async () => {
    const local = new MemoryProviderLocalObjectStore();
    const provider = new MemoryObjectLogProvider(local);
    const generation = await open(provider);
    const bytes = new TextEncoder().encode('immutable segment bytes');
    const sourceRef = local.put('source', bytes);
    const storedSha256 = await sha256Bytes(bytes);
    const signal = new AbortController().signal;

    const created = await provider.uploadImmutable({
      generation,
      sourceRef,
      objectKind: 'segment',
      logicalKeyId: 'segment-1',
      storedSha256,
      sizeBytes: bytes.byteLength,
      transferId: 'upload-1',
      signal,
    });
    expect(created.status).toBe('created');
    const replay = await provider.uploadImmutable({
      generation,
      sourceRef,
      objectKind: 'segment',
      logicalKeyId: 'segment-1',
      storedSha256,
      sizeBytes: bytes.byteLength,
      transferId: 'upload-2',
      signal,
    });
    expect(replay).toEqual({ status: 'already-present', object: created.object });
    await expect(
      provider.statImmutable({ generation, objectKind: 'segment', logicalKeyId: 'segment-1' }),
    ).resolves.toEqual(created.object);

    const destinationRef = local.ref('destination');
    await expect(
      provider.downloadImmutable({
        generation,
        objectId: created.object.objectId,
        destinationRef,
        expectedStoredSha256: storedSha256,
        transferId: 'download-1',
        signal,
      }),
    ).resolves.toMatchObject({ destinationRef, storedSha256, sizeBytes: bytes.byteLength });
    expect(local.bytes(destinationRef)).toEqual(bytes);
  });

  it('rejects same-key replacement even after a provider-side removal', async () => {
    const local = new MemoryProviderLocalObjectStore();
    const provider = new MemoryObjectLogProvider(local);
    const generation = await open(provider);
    const first = new TextEncoder().encode('first');
    const second = new TextEncoder().encode('second');
    const firstRef = local.put('first', first);
    const secondRef = local.put('second', second);
    const signal = new AbortController().signal;
    const created = await provider.uploadImmutable({
      generation,
      sourceRef: firstRef,
      objectKind: 'blob',
      logicalKeyId: 'blob-key',
      storedSha256: await sha256Bytes(first),
      sizeBytes: first.byteLength,
      transferId: 'upload-first',
      signal,
    });
    provider.removeRemoteObject(generation, 'blob-key');

    await expect(
      provider.uploadImmutable({
        generation,
        sourceRef: secondRef,
        objectKind: 'blob',
        logicalKeyId: 'blob-key',
        storedSha256: await sha256Bytes(second),
        sizeBytes: second.byteLength,
        transferId: 'upload-second',
        signal,
      }),
    ).rejects.toMatchObject({ code: 'IMMUTABLE_OBJECT_CONFLICT' });

    const restored = await provider.uploadImmutable({
      generation,
      sourceRef: firstRef,
      objectKind: 'blob',
      logicalKeyId: 'blob-key',
      storedSha256: await sha256Bytes(first),
      sizeBytes: first.byteLength,
      transferId: 'upload-restore',
      signal,
    });
    expect(restored.status).toBe('created');
    expect(restored.object.objectId).not.toBe(created.object.objectId);
  });

  it('holds inventory and change pagination to one captured cutoff', async () => {
    const local = new MemoryProviderLocalObjectStore();
    const provider = new MemoryObjectLogProvider(local, { pageSize: 1 });
    const generation = await open(provider);
    const start = await provider.captureStartCursor(generation);
    const upload = async (key: string) => {
      const bytes = new TextEncoder().encode(key);
      return provider.uploadImmutable({
        generation,
        sourceRef: local.put(`source.${key}`, bytes),
        objectKind: 'segment',
        logicalKeyId: key,
        storedSha256: await sha256Bytes(bytes),
        sizeBytes: bytes.byteLength,
        transferId: `upload-${key}`,
        signal: new AbortController().signal,
      });
    };
    await upload('segment-a');
    await upload('segment-b');

    const first = await provider.listChanges({ generation, cursor: start });
    expect(first.changes).toHaveLength(1);
    expect(first.nextPageToken).toBeDefined();
    await upload('segment-c');
    const second = await provider.listChanges({
      generation,
      cursor: start,
      pageToken: first.nextPageToken,
    });
    expect(second.changes).toHaveLength(1);
    expect(second.newCursor).toBeDefined();
    const tail = await provider.listChanges({ generation, cursor: second.newCursor! });
    expect(tail.changes).toHaveLength(1);

    const inventoryFirst = await provider.listInventory({ generation });
    await upload('segment-d');
    const inventorySecond = await provider.listInventory({
      generation,
      pageToken: inventoryFirst.nextPageToken,
    });
    expect(inventoryFirst.objects[0]?.logicalKeyId).toBe('segment-a');
    expect(inventorySecond.objects[0]?.logicalKeyId).toBe('segment-b');
  });

  it('reports remote removal as transport degradation without inventing a domain tombstone', async () => {
    const local = new MemoryProviderLocalObjectStore();
    const provider = new MemoryObjectLogProvider(local);
    const generation = await open(provider);
    const before = await provider.captureStartCursor(generation);
    const bytes = Uint8Array.of(1, 2, 3);
    const sourceRef = local.put('source', bytes);
    const created = await provider.uploadImmutable({
      generation,
      sourceRef,
      objectKind: 'checkpoint',
      logicalKeyId: 'checkpoint-1',
      storedSha256: await sha256Bytes(bytes),
      sizeBytes: bytes.byteLength,
      transferId: 'upload',
      signal: new AbortController().signal,
    });
    provider.removeRemoteObject(generation, 'checkpoint-1');
    const changes = await provider.listChanges({ generation, cursor: before });
    expect(changes.changes).toEqual([
      { kind: 'present', object: created.object },
      { kind: 'removed', objectId: created.object.objectId, logicalKeyId: 'checkpoint-1' },
    ]);
    expect(changes.changes.every((change) => !('action' in change))).toBe(true);
  });

  it('fails closed on cancellation, size/hash mismatch and corrupt downloads', async () => {
    const local = new MemoryProviderLocalObjectStore();
    const provider = new MemoryObjectLogProvider(local);
    const generation = await open(provider);
    const bytes = Uint8Array.of(9, 8, 7);
    const sourceRef = local.put('source', bytes);
    const hash = await sha256Bytes(bytes);
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      provider.uploadImmutable({
        generation,
        sourceRef,
        objectKind: 'blob',
        logicalKeyId: 'blob-aborted',
        storedSha256: hash,
        sizeBytes: bytes.byteLength,
        transferId: 'aborted',
        signal: aborted.signal,
      }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    await expect(
      provider.uploadImmutable({
        generation,
        sourceRef,
        objectKind: 'blob',
        logicalKeyId: 'blob-size',
        storedSha256: hash,
        sizeBytes: bytes.byteLength + 1,
        transferId: 'wrong-size',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'SIZE_MISMATCH' });

    const created = await provider.uploadImmutable({
      generation,
      sourceRef,
      objectKind: 'blob',
      logicalKeyId: 'blob-valid',
      storedSha256: hash,
      sizeBytes: bytes.byteLength,
      transferId: 'valid',
      signal: new AbortController().signal,
    });
    provider.corruptRemoteBytes(generation, created.object.objectId);
    const destination = local.ref('corrupt-destination');
    await expect(
      provider.downloadImmutable({
        generation,
        objectId: created.object.objectId,
        destinationRef: destination,
        expectedStoredSha256: hash,
        transferId: 'corrupt',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
    expect(local.has(destination)).toBe(false);
  });

  it('isolates SyncGeneration namespaces and rejects a mismatched generation reference', async () => {
    const local = new MemoryProviderLocalObjectStore();
    const provider = new MemoryObjectLogProvider(local);
    const first = await open(provider, 'sync-generation-a');
    const second = await open(provider, 'sync-generation-b');
    expect(await provider.captureStartCursor(first)).toBe(createProviderCursor('memory-cursor:0'));
    expect(await provider.captureStartCursor(second)).toBe(createProviderCursor('memory-cursor:0'));
    await expect(
      provider.captureStartCursor({ ...first, syncGenerationId: second.syncGenerationId }),
    ).rejects.toBeInstanceOf(ObjectLogProviderError);
  });
});
