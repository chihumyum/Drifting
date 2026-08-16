import { describe, expect, it } from 'vitest';

import { createWriterFrontier, observeFrontierRange } from '../engine/frontier';
import {
  sha256Bytes,
  type ObjectLogProvider,
  type ProviderBinding,
  type ProviderCursor,
  type ProviderObjectId,
  type ProviderGeneration,
  type RemoteObject,
} from '../protocol';
import { MemoryProviderLocalObjectStore } from './local-object-store';

export interface ObjectLogProviderConformanceHarness {
  readonly provider: ObjectLogProvider;
  readonly localObjects: MemoryProviderLocalObjectStore;
  readonly generation: ProviderGeneration;
  removeRemoteObject(logicalKeyId: string): void | Promise<void>;
  corruptRemoteObject(objectId: ProviderObjectId): void | Promise<void>;
  cleanup?(): void | Promise<void>;
}

export interface ObjectLogProviderConformanceDefinition {
  readonly name: string;
  create(options?: { pageSize?: number }): Promise<ObjectLogProviderConformanceHarness>;
}

async function upload(
  harness: ObjectLogProviderConformanceHarness,
  logicalKeyId: string,
  bytes = new TextEncoder().encode(logicalKeyId),
) {
  return harness.provider.uploadImmutable({
    generation: harness.generation,
    sourceRef: harness.localObjects.put(`source.${logicalKeyId}.${bytes[0] ?? 0}`, bytes),
    objectKind: 'segment',
    logicalKeyId,
    storedSha256: await sha256Bytes(bytes),
    sizeBytes: bytes.byteLength,
    transferId: `upload.${logicalKeyId}`,
    signal: new AbortController().signal,
  });
}

async function allInventory(
  provider: ObjectLogProvider,
  generation: ProviderGeneration,
): Promise<RemoteObject[]> {
  const objects: RemoteObject[] = [];
  let pageToken;
  do {
    const page = await provider.listInventory({ generation, ...(pageToken ? { pageToken } : {}) });
    objects.push(...page.objects);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return objects;
}

async function allChanges(
  provider: ObjectLogProvider,
  generation: ProviderGeneration,
  cursor: ProviderCursor,
) {
  const changes = [];
  let pageToken;
  let newCursor: ProviderCursor | undefined;
  do {
    const page = await provider.listChanges({
      generation,
      cursor,
      ...(pageToken ? { pageToken } : {}),
    });
    changes.push(...page.changes);
    pageToken = page.nextPageToken;
    newCursor = page.newCursor ?? newCursor;
  } while (pageToken);
  return { changes, newCursor };
}

export function defineObjectLogProviderConformance(
  definition: ObjectLogProviderConformanceDefinition,
): void {
  const withHarness = async (
    options: { pageSize?: number } | undefined,
    work: (harness: ObjectLogProviderConformanceHarness) => Promise<void>,
  ) => {
    const harness = await definition.create(options);
    try {
      await work(harness);
    } finally {
      await harness.cleanup?.();
    }
  };

  describe(`${definition.name} ObjectLogProvider conformance`, () => {
    it('paginates one captured inventory/change snapshot without duplicates or omissions', async () => {
      await withHarness({ pageSize: 2 }, async (harness) => {
        const start = await harness.provider.captureStartCursor(harness.generation);
        for (const key of ['segment-5', 'segment-1', 'segment-4', 'segment-2', 'segment-3']) {
          await upload(harness, key);
        }
        const firstInventory = await harness.provider.listInventory({ generation: harness.generation });
        await upload(harness, 'segment-after-cutoff');
        const inventory = [...firstInventory.objects];
        let inventoryToken = firstInventory.nextPageToken;
        while (inventoryToken) {
          const page = await harness.provider.listInventory({
            generation: harness.generation,
            pageToken: inventoryToken,
          });
          inventory.push(...page.objects);
          inventoryToken = page.nextPageToken;
        }
        expect(inventory.map((object) => object.logicalKeyId)).toEqual([
          'segment-1',
          'segment-2',
          'segment-3',
          'segment-4',
          'segment-5',
        ]);

        const changes = await allChanges(harness.provider, harness.generation, start);
        expect(changes.changes).toHaveLength(6);
        expect(
          new Set(
            changes.changes.map((change) =>
              change.kind === 'present' ? change.object.objectId : change.objectId,
            ),
          ).size,
        ).toBe(6);
        expect(changes.newCursor).toBeDefined();
      });
    });

    it('makes duplicated and arbitrarily reordered delivery converge', async () => {
      await withHarness({ pageSize: 1 }, async (harness) => {
        for (const sequence of [1, 2, 3, 4]) {
          await upload(harness, `segment-${sequence}`);
        }
        const inventory = await allInventory(harness.provider, harness.generation);
        const delivery = [inventory[2]!, inventory[0]!, inventory[3]!, inventory[1]!, inventory[2]!];
        let frontier = createWriterFrontier({
          syncGenerationId: 'sync-generation-a',
          writerId: 'writer-a',
          writerEpoch: 'epoch-a',
        });
        for (const object of delivery) {
          const sequence = Number(object.logicalKeyId.slice('segment-'.length));
          frontier = observeFrontierRange(frontier, 'received', {
            firstSeq: sequence,
            lastSeq: sequence,
          });
        }
        expect(frontier.received).toEqual({ maxSeq: 4, gaps: [] });
      });
    });

    it('reconciles response loss and concurrently deduplicates the same immutable identity', async () => {
      await withHarness(undefined, async (harness) => {
        const bytes = new TextEncoder().encode('response-loss');
        const sourceRef = harness.localObjects.put('response-loss', bytes);
        const request = {
          generation: harness.generation,
          sourceRef,
          objectKind: 'segment' as const,
          logicalKeyId: 'segment-response-loss',
          storedSha256: await sha256Bytes(bytes),
          sizeBytes: bytes.byteLength,
          transferId: 'transfer-response-loss',
          signal: new AbortController().signal,
        };
        await harness.provider.uploadImmutable(request);
        const retried = await harness.provider.uploadImmutable({
          ...request,
          transferId: 'transfer-retry',
        });
        expect(retried.status).toBe('already-present');
        const concurrent = await Promise.all(
          Array.from({ length: 4 }, (_, index) =>
            harness.provider.uploadImmutable({
              ...request,
              transferId: `transfer-concurrent-${index}`,
            }),
          ),
        );
        expect(concurrent.every((result) => result.status === 'already-present')).toBe(true);
        expect(await allInventory(harness.provider, harness.generation)).toHaveLength(1);
      });
    });

    it('retains immutable identity after removal and emits only transport degradation', async () => {
      await withHarness(undefined, async (harness) => {
        const before = await harness.provider.captureStartCursor(harness.generation);
        await upload(harness, 'segment-immutable', Uint8Array.of(1));
        await harness.removeRemoteObject('segment-immutable');
        const changes = await allChanges(harness.provider, harness.generation, before);
        expect(changes.changes[changes.changes.length - 1]).toMatchObject({
          kind: 'removed',
          logicalKeyId: 'segment-immutable',
        });
        expect(changes.changes.every((change) => !('action' in change))).toBe(true);
        await expect(
          upload(harness, 'segment-immutable', Uint8Array.of(2)),
        ).rejects.toMatchObject({ code: 'IMMUTABLE_OBJECT_CONFLICT' });
        const restored = await upload(harness, 'segment-immutable', Uint8Array.of(1));
        expect(restored.status).toBe('created');
      });
    });

    it('verifies remote bytes before writing a destination LocalObjectRef', async () => {
      await withHarness(undefined, async (harness) => {
        const created = await upload(harness, 'segment-corrupt');
        await harness.corruptRemoteObject(created.object.objectId);
        const destinationRef = harness.localObjects.ref('download-corrupt');
        await expect(
          harness.provider.downloadImmutable({
            generation: harness.generation,
            objectId: created.object.objectId,
            destinationRef,
            expectedStoredSha256: created.object.storedSha256,
            transferId: 'download-corrupt',
            signal: new AbortController().signal,
          }),
        ).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
        expect(harness.localObjects.has(destinationRef)).toBe(false);
      });
    });

    it('rejects a SyncGeneration reference splice', async () => {
      await withHarness(undefined, async (harness) => {
        await expect(
          harness.provider.captureStartCursor({ ...harness.generation, syncGenerationId: 'sync-generation-spliced' }),
        ).rejects.toMatchObject({ code: 'INVALID_GENERATION' });
      });
    });
  });
}

export const DEFAULT_CONFORMANCE_BINDING: ProviderBinding = {
  bindingId: 'binding-a',
  syncGenerationId: 'sync-generation-a',
  accountRef: null,
  secretRef: 'local-folder-root:test',
  authorityGeneration: 1,
};
