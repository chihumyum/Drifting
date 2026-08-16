import { describe, expect, it } from 'vitest';

import { createSyncMutationV1, type SyncChangeSetV1 } from './change-set';
import {
  parseProjectAssetMutationV1,
  requiredBlobIdsForChangeSet,
  validateProjectAssetBindSemantics,
} from './asset';

async function assetChangeSet(): Promise<SyncChangeSetV1> {
  const sourceSha256 = `sha256:${'a'.repeat(64)}`;
  const mutation = await createSyncMutationV1({
    index: 0,
    target: { family: 'asset', kind: 'project-asset', id: 'asset-1', incarnation: 0 },
    action: 'asset.bind',
    payloadVersion: 1,
    payload: {
      blobId: sourceSha256,
      sourceSha256,
      sourceMime: 'image/png',
      sourceSizeBytes: 3,
      kind: 'image',
      width: 10,
      height: 20,
      createdAt: '2026-08-15T00:00:00.000Z',
      owner: { kind: 'library-item', id: 'library-1' },
    },
  });
  return {
    protocol: 'drifting.sync.changeset',
    protocolVersion: 1,
    payloadVersion: 1,
    projectId: 'project-1',
    projectSyncId: 'projectSync-1',
    syncGenerationId: 'sync-generation-1',
    changeSetId: 'writer-1:epoch-1:1',
    writerId: 'writer-1',
    writerEpoch: 'epoch-1',
    deviceSeq: 1,
    hlc: { wallMs: 1, counter: 0 },
    mutations: [mutation],
  };
}

describe('project asset protocol v1', () => {
  it('validates bind payloads and extracts blob dependencies from the change-set', async () => {
    const changeSet = await assetChangeSet();
    const parsed = parseProjectAssetMutationV1(changeSet.mutations[0]!);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.value.action !== 'asset.bind') return;
    expect(validateProjectAssetBindSemantics(parsed.value.payload)).toEqual([]);
    expect(requiredBlobIdsForChangeSet(changeSet)).toEqual([`sha256:${'a'.repeat(64)}`]);
  });

  it('fails closed when an asset mutation omits its verified blob identity', async () => {
    const changeSet = await assetChangeSet();
    const invalid = {
      ...changeSet,
      mutations: [
        {
          ...changeSet.mutations[0]!,
          payload: { owner: { kind: 'library-item', id: 'library-1' } },
        },
      ],
    };

    expect(() => requiredBlobIdsForChangeSet(invalid)).toThrow(/invalid project asset mutation/u);

    const mismatched = {
      ...changeSet,
      mutations: [
        {
          ...changeSet.mutations[0]!,
          payload: {
            ...(changeSet.mutations[0]!.payload as Record<string, unknown>),
            blobId: `sha256:${'b'.repeat(64)}`,
          },
        },
      ],
    } as SyncChangeSetV1;
    expect(() => requiredBlobIdsForChangeSet(mismatched)).toThrow(/must equal sourceSha256/u);
  });
});
