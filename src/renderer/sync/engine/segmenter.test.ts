import { describe, expect, it } from 'vitest';

import {
  createSyncMutationV1,
  decodeSegmentV1,
  encodeSyncChangeSetV1,
  type SyncChangeSetV1,
} from '../protocol';
import { ChangeSetSegmenter, SegmentRangeForkDetector } from './segmenter';

const identity = {
  projectId: 'project-a',
  projectSyncId: 'projectSync-a',
  syncGenerationId: 'sync-generation-a',
  writerId: 'writer-a',
  writerEpoch: 'epoch-a',
} as const;

async function changeSet(deviceSeq: number, payloadBytes = 1): Promise<SyncChangeSetV1> {
  const mutation = await createSyncMutationV1({
    index: 0,
    target: { family: 'yjs', kind: 'prose', id: 'doc-a', incarnation: 0 },
    action: 'yjs.update',
    payloadVersion: 1,
    payload: { update: new Uint8Array(payloadBytes).fill(deviceSeq % 251) },
  });
  return {
    protocol: 'drifting.sync.changeset',
    protocolVersion: 1,
    payloadVersion: 1,
    ...identity,
    changeSetId: `${identity.writerId}:${identity.writerEpoch}:${deviceSeq}`,
    deviceSeq,
    hlc: { wallMs: 1_000 + deviceSeq, counter: 0 },
    mutations: [mutation],
  };
}

async function assetChangeSet(deviceSeq: number): Promise<SyncChangeSetV1> {
  const hashes = ['b', 'a', 'b'] as const;
  const mutations = await Promise.all(
    hashes.map((byte, index) => {
      const sourceSha256 = `sha256:${byte.repeat(64)}`;
      return createSyncMutationV1({
        index,
        target: {
          family: 'asset',
          kind: 'project-asset',
          id: `asset-${index}`,
          incarnation: 0,
        },
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
          owner: { kind: 'library-item', id: `library-${index}` },
        },
      });
    }),
  );
  return {
    protocol: 'drifting.sync.changeset',
    protocolVersion: 1,
    payloadVersion: 1,
    ...identity,
    changeSetId: `${identity.writerId}:${identity.writerEpoch}:${deviceSeq}`,
    deviceSeq,
    hlc: { wallMs: 1_000 + deviceSeq, counter: 0 },
    mutations,
  };
}

describe('ChangeSetSegmenter', () => {
  it('seals count-bounded segments and chains deterministic hashes', async () => {
    const segmenter = new ChangeSetSegmenter({
      identity,
      nextDeviceSeq: 1,
      maxChangeSets: 2,
    });
    expect(await segmenter.push({ changeSet: await changeSet(1), enqueuedAtMs: 0 })).toEqual([]);
    const [first] = await segmenter.push({
      changeSet: await assetChangeSet(2),
      enqueuedAtMs: 1,
    });
    expect(first?.sealedBecause).toBe('count');
    expect(first?.segment.header.requiredBlobIds).toEqual([
      `sha256:${'a'.repeat(64)}`,
      `sha256:${'b'.repeat(64)}`,
    ]);
    expect(first?.segment.header.previousSegmentHash).toBeNull();

    await segmenter.push({ changeSet: await changeSet(3), enqueuedAtMs: 2 });
    const second = await segmenter.flush('manual');
    expect(second?.segment.header.previousSegmentHash).toBe(first?.segmentSha256);
    expect(second?.segment.header.firstSeq).toBe(3);
    expect((await decodeSegmentV1(second!.encodedBytes)).ok).toBe(true);
  });

  it('uses final segment bytes for the size boundary and never splits a change set', async () => {
    const sample = await changeSet(1, 128);
    const probe = new ChangeSetSegmenter({ identity, nextDeviceSeq: 1 });
    await probe.push({ changeSet: sample, enqueuedAtMs: 0 });
    const oneSegmentBytes = (await probe.flush('manual'))!.encodedBytes.byteLength;
    expect(oneSegmentBytes).toBeGreaterThan(encodeSyncChangeSetV1(sample).byteLength);
    const segmenter = new ChangeSetSegmenter({
      identity,
      nextDeviceSeq: 1,
      // Leave room for the next segment's non-null previousSegmentHash while
      // remaining far below the encoded size of two complete change sets.
      maxBytes: oneSegmentBytes + 256,
    });
    const firstPush = await segmenter.push({ changeSet: sample, enqueuedAtMs: 0 });
    expect(firstPush).toEqual([]);
    const sealed = await segmenter.push({ changeSet: await changeSet(2, 128), enqueuedAtMs: 1 });
    expect(sealed).toHaveLength(1);
    expect(sealed[0]?.segment.changeSets).toHaveLength(1);
    expect(sealed[0]?.oversized).toBe(false);
    expect(segmenter.pendingCount).toBe(1);
  });

  it('allows one oversized change set and seals it atomically', async () => {
    const segmenter = new ChangeSetSegmenter({ identity, nextDeviceSeq: 1, maxBytes: 256 });
    const [sealed] = await segmenter.push({
      changeSet: await changeSet(1, 2_048),
      enqueuedAtMs: 0,
    });
    expect(sealed?.oversized).toBe(true);
    expect(sealed?.segment.header.firstSeq).toBe(1);
    expect(sealed?.segment.header.lastSeq).toBe(1);
    expect(segmenter.pendingCount).toBe(0);
  });

  it('seals only once the oldest pending change set reaches two seconds', async () => {
    const segmenter = new ChangeSetSegmenter({ identity, nextDeviceSeq: 1 });
    await segmenter.push({ changeSet: await changeSet(1), enqueuedAtMs: 10_000 });
    expect(await segmenter.sealExpired(11_999)).toBeNull();
    expect((await segmenter.sealExpired(12_000))?.sealedBecause).toBe('age');
  });

  it('fails closed on writer changes and sequence gaps without consuming the sequence', async () => {
    const segmenter = new ChangeSetSegmenter({ identity, nextDeviceSeq: 1 });
    await expect(
      segmenter.push({ changeSet: await changeSet(2), enqueuedAtMs: 0 }),
    ).rejects.toThrow('expected 1, received 2');
    expect(segmenter.expectedDeviceSeq).toBe(1);

    const wrongWriter = { ...(await changeSet(1)), writerId: 'writer-b' };
    await expect(segmenter.push({ changeSet: wrongWriter, enqueuedAtMs: 0 })).rejects.toThrow(
      'writerId',
    );
    expect(segmenter.expectedDeviceSeq).toBe(1);
  });

  it('classifies same-range different-hash input as a fork for quarantine', () => {
    const detector = new SegmentRangeForkDetector();
    const range = {
      syncGenerationId: 'sync-generation-a',
      writerId: 'writer-a',
      writerEpoch: 'epoch-a',
      firstSeq: 1,
      lastSeq: 2,
    } as const;
    const firstHash = `sha256:${'a'.repeat(64)}` as const;
    const forkHash = `sha256:${'b'.repeat(64)}` as const;
    expect(detector.register({ ...range, sha256: firstHash }).disposition).toBe('accepted');
    expect(detector.register({ ...range, sha256: firstHash }).disposition).toBe('duplicate');
    expect(detector.register({ ...range, sha256: forkHash })).toMatchObject({
      disposition: 'fork',
      existingSha256: firstHash,
      incomingSha256: forkHash,
    });
  });
});
