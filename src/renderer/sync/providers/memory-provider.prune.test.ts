import { describe, expect, it } from 'vitest';

import { sha256Bytes, type RemoteObject, type SyncObjectKind } from '../protocol';
import { MemoryProviderLocalObjectStore } from './local-object-store';
import { MemoryObjectLogProvider } from './memory-provider';

const DAY_MS = 24 * 60 * 60 * 1_000;

async function fixture() {
  const clock = { value: 0 };
  const objects = new MemoryProviderLocalObjectStore();
  const provider = new MemoryObjectLogProvider(objects, {
    pruning: { graceMs: 30 * DAY_MS, nowMs: () => clock.value },
  });
  const generation = await provider.openGeneration({
    bindingId: 'binding',
    syncGenerationId: 'generation',
    accountRef: null,
    secretRef: null,
    authorityGeneration: 1,
  });
  let next = 0;
  const upload = async (objectKind: SyncObjectKind): Promise<RemoteObject> => {
    next += 1;
    const bytes = new TextEncoder().encode(`object-${next}`);
    return (
      await provider.uploadImmutable({
        generation,
        sourceRef: objects.put(`source-${next}`, bytes),
        objectKind,
        logicalKeyId: `key-${next}`,
        storedSha256: await sha256Bytes(bytes),
        sizeBytes: bytes.byteLength,
        transferId: `transfer-${next}`,
        signal: new AbortController().signal,
      })
    ).object;
  };
  const prune = async (retain: readonly RemoteObject[], remove: readonly RemoteObject[]) =>
    provider.pruneObjects!({
      generation,
      basisCursor: await provider.captureStartCursor(generation),
      retain: retain.map((object) => object.objectId),
      remove: remove.map((object) => object.objectId),
      signal: new AbortController().signal,
    });
  return { clock, provider, generation, upload, prune };
}

describe('memory provider pruning', () => {
  it('is absent unless enabled', () => {
    expect(new MemoryObjectLogProvider(new MemoryProviderLocalObjectStore()).pruneObjects).toBeUndefined();
  });

  it('defers young segments, removes old ones and announces each removal', async () => {
    const { clock, provider, generation, upload, prune } = await fixture();
    const oldSegment = await upload('segment');
    clock.value = 31 * DAY_MS;
    const youngSegment = await upload('segment');
    const markers = [await upload('snapshot-commit'), await upload('snapshot-commit')];
    const start = await provider.captureStartCursor(generation);

    await expect(prune(markers, [oldSegment, youngSegment])).resolves.toEqual({
      removed: [oldSegment.objectId],
      deferred: [youngSegment.objectId],
    });
    const page = await provider.listChanges({ generation, cursor: start });
    expect(page.changes).toEqual([
      { kind: 'removed', objectId: oldSegment.objectId, logicalKeyId: oldSegment.logicalKeyId },
    ]);
    // A retry is idempotent and the removed key can never come back.
    await expect(prune(markers, [oldSegment])).resolves.toEqual({
      removed: [oldSegment.objectId],
      deferred: [],
    });
    await expect(
      provider.statImmutable({ generation, objectKind: 'segment', logicalKeyId: oldSegment.logicalKeyId }),
    ).resolves.toBeNull();
  });

  it('enforces retained snapshots, marker pairing, blob safety and a fresh basis', async () => {
    const { clock, provider, generation, upload, prune } = await fixture();
    const segment = await upload('segment');
    const blob = await upload('blob');
    const oldPackage = await upload('checkpoint');
    const oldMarker = await upload('snapshot-commit');
    const markers = [await upload('snapshot-commit'), await upload('snapshot-commit')];
    clock.value = 31 * DAY_MS;

    await expect(prune([markers[0]!], [segment])).rejects.toMatchObject({ code: 'PRUNE_REJECTED' });
    await expect(prune(markers, [markers[0]!])).rejects.toMatchObject({ code: 'PRUNE_REJECTED' });
    await expect(prune(markers, [blob])).rejects.toMatchObject({ code: 'PRUNE_REJECTED' });
    await expect(prune(markers, [oldPackage])).rejects.toMatchObject({ code: 'PRUNE_REJECTED' });
    await expect(prune(markers, [oldPackage, oldMarker])).resolves.toEqual({
      removed: [oldPackage.objectId, oldMarker.objectId],
      deferred: [],
    });

    const staleBasis = await provider.captureStartCursor(generation);
    await upload('snapshot-commit');
    await expect(
      provider.pruneObjects!({
        generation,
        basisCursor: staleBasis,
        retain: markers.map((object) => object.objectId),
        remove: [segment.objectId],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'PRUNE_REJECTED' });
  });
});
