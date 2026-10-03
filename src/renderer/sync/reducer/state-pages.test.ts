import { describe, expect, it } from 'vitest';

import { decodeCanonicalCbor, MAX_CBOR_NODES, type SyncChangeSetV1 } from '../protocol';
import {
  canonicalReducerSnapshot,
  compactReducerReceipts,
  createCanonicalReducerState,
  reducerStateFromSnapshot,
  replaySyncChangeSets,
} from './reducer';
import {
  EMPTY_REDUCER_STATE_JOURNAL,
  decodeReducerStatePagesV2,
  describeReducerProfile,
  encodeReducerStatePagesV2,
} from './state-pages';
import type { ReducerProfile } from './types';

const IDENTITY = {
  projectId: 'project-pages',
  projectSyncId: 'projectSync-pages',
  syncGenerationId: 'sync-generation-pages',
} as const;

const PROFILE: ReducerProfile = {
  knownTargetKinds: new Set(['node', 'membership']),
  externallyMaterializedActions: new Set(['yjs.update']),
};

function history(count: number): SyncChangeSetV1[] {
  return Array.from({ length: count }, (_, index) => {
    const seq = index + 1;
    const node = `node-${index % 4_000}`;
    return {
      protocol: 'drifting.sync.changeset',
      protocolVersion: 1,
      payloadVersion: 1,
      ...IDENTITY,
      changeSetId: `writer:epoch:${seq}`,
      writerId: 'writer',
      writerEpoch: 'epoch',
      deviceSeq: seq,
      hlc: { wallMs: 1_000 + seq, counter: 0 },
      mutations: [
        index % 3 === 0
          ? { index: 0, target: { family: 'set', kind: 'membership', id: 's1', incarnation: 0 }, action: 'set.add', payloadVersion: 1, payload: { memberId: node, value: seq }, payloadSha256: `sha256:${'a'.repeat(64)}` }
          : { index: 0, target: { family: 'entity', kind: 'node', id: node, incarnation: 0 }, action: 'field.set', payloadVersion: 1, payload: { field: 'title', value: `t${seq}` }, payloadSha256: `sha256:${'b'.repeat(64)}` },
      ],
    } as SyncChangeSetV1;
  });
}

describe('canonical reducer state pages', () => {
  it('round-trips a compacted state through bounded canonical pages', () => {
    const state = compactReducerReceipts(
      replaySyncChangeSets(createCanonicalReducerState(IDENTITY), history(12_000), PROFILE).state,
    );
    expect(state.coverage.size).toBe(1);
    expect(state.receipts.size).toBe(0);
    const pages = encodeReducerStatePagesV2({
      header: {
        identity: IDENTITY,
        profile: describeReducerProfile(PROFILE),
        maxChangeSetHlc: { wallMs: 13_000, counter: 0 },
      },
      snapshot: canonicalReducerSnapshot(state),
      journal: EMPTY_REDUCER_STATE_JOURNAL,
    });
    expect(pages.length).toBeGreaterThan(2);
    for (const page of pages) expect(decodeCanonicalCbor(page).ok).toBe(true);

    const decoded = decodeReducerStatePagesV2(pages);
    expect(decoded.header.profile).toEqual({ knownTargetKinds: ['membership', 'node'], externallyMaterializedActions: ['yjs.update'] });
    expect(canonicalReducerSnapshot(reducerStateFromSnapshot(decoded.snapshot))).toEqual(canonicalReducerSnapshot(state));
  });

  it('rejects reordered, repeated or malformed pages', () => {
    const state = replaySyncChangeSets(createCanonicalReducerState(IDENTITY), history(30), PROFILE).state;
    const pages = encodeReducerStatePagesV2({
      header: { identity: IDENTITY, profile: describeReducerProfile(PROFILE), maxChangeSetHlc: { wallMs: 1, counter: 0 } },
      snapshot: canonicalReducerSnapshot(state),
      journal: EMPTY_REDUCER_STATE_JOURNAL,
    });
    expect(() => decodeReducerStatePagesV2([...pages].reverse())).toThrow(/out of order/u);
    expect(() => decodeReducerStatePagesV2([pages[0], ...pages])).toThrow(/header repeats/u);
    expect(() => decodeReducerStatePagesV2(pages.slice(1))).toThrow(/header page is missing/u);
    expect(() => describeReducerProfile({ ...PROFILE, validateProjection: () => [] })).toThrow(/validator/u);
    expect(MAX_CBOR_NODES).toBe(100_000);
  });
});
