import { describe, expect, it } from 'vitest';

import type {
  CanonicalCborValue,
  SyncChangeSetV1,
  SyncMutationAction,
  SyncMutationTargetFamily,
  SyncMutationV1,
} from '../protocol';
import {
  canonicalReducerSnapshot,
  createCanonicalReducerState,
  materializationEffects,
  mutationAddTag,
  reduceSyncChangeSet,
  selectOrderedEntries,
  type CanonicalReducerState,
  type ReducerEffect,
  type ReducerProfile,
} from '.';

const IDENTITY = {
  projectId: 'project-reducer',
  projectSyncId: 'projectSync-reducer',
  syncGenerationId: 'sync-generation-reducer',
} as const;

const PROFILE: ReducerProfile = {
  knownTargetKinds: new Set(['node', 'membership', 'chapter']),
};

const FAMILY: Record<SyncMutationAction, SyncMutationTargetFamily> = {
  'entity.create': 'entity',
  'field.set': 'entity',
  'tuple.set': 'entity',
  'set.add': 'set',
  'set.remove': 'set',
  'order.move': 'order',
  'order.rebalance': 'order',
  'entity.trash': 'entity',
  'entity.restore': 'entity',
  'entity.purge': 'entity',
  'sync-generation.purge': 'sync-generation',
  'yjs.update': 'yjs',
  'asset.bind': 'asset',
  'asset.unbind': 'asset',
};

function digest(value: unknown): string {
  const input = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `sha256:${hash.toString(16).padStart(8, '0').repeat(8)}`;
}

interface MutationInput {
  action: SyncMutationAction;
  kind: string;
  id: string;
  incarnation?: number;
  payload: CanonicalCborValue;
  family?: SyncMutationTargetFamily;
}

function changeSet(input: {
  writer: string;
  seq: number;
  wallMs: number;
  counter?: number;
  epoch?: string;
  mutations: readonly MutationInput[];
}): SyncChangeSetV1 {
  const epoch = input.epoch ?? 'epoch-1';
  const changeSetId = `${input.writer}:${epoch}:${input.seq}`;
  return {
    protocol: 'drifting.sync.changeset',
    protocolVersion: 1,
    payloadVersion: 1,
    ...IDENTITY,
    changeSetId,
    writerId: input.writer,
    writerEpoch: epoch,
    deviceSeq: input.seq,
    hlc: { wallMs: input.wallMs, counter: input.counter ?? 0 },
    mutations: input.mutations.map((draft, index): SyncMutationV1 => ({
      index,
      target: {
        family: draft.family ?? FAMILY[draft.action],
        kind: draft.kind,
        id: draft.id,
        incarnation: draft.incarnation ?? 0,
      },
      action: draft.action,
      payloadVersion: 1,
      payload: draft.payload,
      payloadSha256: digest([draft.action, draft.payload]),
    })),
  };
}

function applyAll(
  changes: readonly SyncChangeSetV1[],
  profile: ReducerProfile = PROFILE,
): CanonicalReducerState {
  let state = createCanonicalReducerState(IDENTITY);
  for (const change of changes) {
    const result = reduceSyncChangeSet(state, change, profile);
    expect(result.status).toBe('applied');
    state = result.state;
  }
  return state;
}

function seededShuffle<T>(values: readonly T[], seed: number): T[] {
  const shuffled = [...values];
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
  }
  return shuffled;
}

function effect<T extends ReducerEffect['type']>(
  state: CanonicalReducerState,
  type: T,
): Extract<ReducerEffect, { type: T }> {
  const found = materializationEffects(state).find((candidate) => candidate.type === type);
  if (!found) throw new Error(`missing ${type} effect`);
  return found as Extract<ReducerEffect, { type: T }>;
}

describe('canonical SyncEngine reducer', () => {
  it('uses the frozen total order for field LWW despite duplicate delivery and ±24h skew', () => {
    const day = 24 * 60 * 60 * 1_000;
    const changes = [
      changeSet({
        writer: 'writer-a', seq: 1, wallMs: day,
        mutations: [{ action: 'field.set', kind: 'node', id: 'n1', payload: { field: 'title', value: 'middle' } }],
      }),
      changeSet({
        writer: 'writer-b', seq: 1, wallMs: 2 * day,
        mutations: [{ action: 'field.set', kind: 'node', id: 'n1', payload: { field: 'title', value: 'future' } }],
      }),
      changeSet({
        writer: 'writer-c', seq: 1, wallMs: 0,
        mutations: [{ action: 'field.set', kind: 'node', id: 'n1', payload: { field: 'title', value: 'past' } }],
      }),
    ];

    const forward = applyAll(changes);
    const reverse = applyAll([...changes].reverse());
    expect(canonicalReducerSnapshot(reverse)).toEqual(canonicalReducerSnapshot(forward));
    expect(effect(forward, 'field.set').value).toBe('future');

    const duplicate = reduceSyncChangeSet(forward, changes[1], PROFILE);
    expect(duplicate.status).toBe('duplicate');
    expect(duplicate.effects).toEqual([]);
    expect(duplicate.state).toBe(forward);
  });

  it('keeps an atomic tuple together instead of independently tearing x and y', () => {
    const older = changeSet({
      writer: 'writer-a', seq: 1, wallMs: 10,
      mutations: [{ action: 'tuple.set', kind: 'node', id: 'n1', payload: { tuple: 'graph.position', value: { x: 1, y: 100 } } }],
    });
    const newer = changeSet({
      writer: 'writer-b', seq: 1, wallMs: 11,
      mutations: [{ action: 'tuple.set', kind: 'node', id: 'n1', payload: { tuple: 'graph.position', value: { x: 2, y: 200 } } }],
    });
    const state = applyAll([newer, older]);
    expect(effect(state, 'tuple.set').value).toEqual({ x: 2, y: 200 });
  });

  it('implements observed-remove without deleting an unobserved concurrent add', () => {
    const addA = changeSet({
      writer: 'writer-a', seq: 1, wallMs: 10,
      mutations: [{ action: 'set.add', kind: 'membership', id: 'storyline-1', payload: { memberId: 'node-1', value: 'from-a' } }],
    });
    const addB = changeSet({
      writer: 'writer-b', seq: 1, wallMs: 10,
      mutations: [{ action: 'set.add', kind: 'membership', id: 'storyline-1', payload: { memberId: 'node-1', value: 'from-b' } }],
    });
    const removeA = changeSet({
      writer: 'writer-c', seq: 1, wallMs: 11,
      mutations: [{
        action: 'set.remove', kind: 'membership', id: 'storyline-1',
        payload: { memberId: 'node-1', observedAddTags: [mutationAddTag(addA.changeSetId, 0)] },
      }],
    });

    const expected = applyAll([addA, addB, removeA]);
    for (let seed = 1; seed <= 30; seed += 1) {
      expect(canonicalReducerSnapshot(applyAll(seededShuffle([addA, addB, removeA], seed)))).toEqual(
        canonicalReducerSnapshot(expected),
      );
    }
    expect(effect(expected, 'set.member')).toMatchObject({
      present: true,
      visibleAddTags: [mutationAddTag(addB.changeSetId, 0)],
      value: 'from-b',
    });
  });

  it('uses remove-wins trash for an incarnation, full-seed restore for n+1, and terminal purge', () => {
    const create = changeSet({
      writer: 'writer-a', seq: 1, wallMs: 100,
      mutations: [{ action: 'entity.create', kind: 'node', id: 'n1', payload: { seed: { title: 'created', body: 'full' } } }],
    });
    const lateField = changeSet({
      writer: 'writer-a', seq: 2, wallMs: 500,
      mutations: [{ action: 'field.set', kind: 'node', id: 'n1', payload: { field: 'title', value: 'late update' } }],
    });
    const trash = changeSet({
      writer: 'writer-b', seq: 1, wallMs: 110,
      mutations: [{ action: 'entity.trash', kind: 'node', id: 'n1', payload: {} }],
    });
    const restore = changeSet({
      writer: 'writer-c', seq: 1, wallMs: 120,
      mutations: [{
        action: 'entity.restore', kind: 'node', id: 'n1', incarnation: 1,
        payload: { seed: { title: 'restored', body: 'complete state', memberships: ['s1'] } },
      }],
    });

    const restored = applyAll([restore, lateField, trash, create]);
    expect(effect(restored, 'entity.lifecycle')).toMatchObject({
      status: 'live',
      target: { incarnation: 1 },
      seed: { title: 'restored', body: 'complete state', memberships: ['s1'] },
    });
    expect(effect(restored, 'field.set').materialize).toBe(false);
    expect(restored.conflicts.size).toBe(0);

    const purge = changeSet({
      writer: 'writer-a', seq: 3, wallMs: 50,
      mutations: [{ action: 'entity.purge', kind: 'node', id: 'n1', incarnation: 0, payload: {} }],
    });
    const purged = applyAll([restore, purge, create, trash]);
    expect(effect(purged, 'entity.lifecycle')).toMatchObject({ status: 'purged' });
  });

  it('suppresses late old-incarnation Yjs and asset effects after restore', () => {
    const profile: ReducerProfile = {
      knownTargetKinds: new Set(['element', 'prose-document', 'project-asset']),
      externallyMaterializedActions: new Set([
        'yjs.update',
        'asset.bind',
        'asset.unbind',
      ]),
    };
    const asset = {
      blobId: `sha256:${'a'.repeat(64)}`,
      sourceSha256: `sha256:${'a'.repeat(64)}`,
      sourceMime: 'image/png',
      sourceSizeBytes: 1,
      kind: 'image',
      width: 1,
      height: 1,
      createdAt: '2026-08-15T00:00:00.000Z',
      owner: { kind: 'element-portrait', id: 'e1' },
    } as const;
    const create = changeSet({
      writer: 'writer-a', seq: 1, wallMs: 1,
      mutations: [{
        action: 'entity.create', kind: 'element', id: 'e1',
        payload: { seed: { name: 'before' } },
      }],
    });
    const trash = changeSet({
      writer: 'writer-a', seq: 2, wallMs: 2,
      mutations: [{ action: 'entity.trash', kind: 'element', id: 'e1', payload: {} }],
    });
    const restore = changeSet({
      writer: 'writer-b', seq: 1, wallMs: 3,
      mutations: [
        {
          action: 'entity.restore', kind: 'element', id: 'e1', incarnation: 1,
          payload: { seed: { name: 'restored' } },
        },
        {
          action: 'yjs.update', family: 'yjs', kind: 'prose-document',
          id: 'element:e1', incarnation: 1, payload: { update: new Uint8Array([1]) },
        },
        {
          action: 'asset.bind', family: 'asset', kind: 'project-asset',
          id: 'asset-1', incarnation: 1, payload: asset,
        },
      ],
    });
    const restored = applyAll([create, trash, restore], profile);
    const lateOldIncarnation = changeSet({
      writer: 'writer-c', seq: 1, wallMs: 100,
      mutations: [
        {
          action: 'yjs.update', family: 'yjs', kind: 'prose-document',
          id: 'element:e1', incarnation: 0, payload: { update: new Uint8Array([2]) },
        },
        {
          action: 'asset.unbind', family: 'asset', kind: 'project-asset',
          id: 'asset-1', incarnation: 0,
          payload: { owner: { kind: 'element-portrait', id: 'e1' } },
        },
      ],
    });
    const result = reduceSyncChangeSet(restored, lateOldIncarnation, profile);
    expect(result.status).toBe('applied');
    expect(result.effects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'yjs.update',
        target: expect.objectContaining({ incarnation: 0 }),
        materialize: false,
      }),
      expect.objectContaining({
        type: 'asset.unbind',
        target: expect.objectContaining({ incarnation: 0 }),
        materialize: false,
      }),
      expect.objectContaining({
        type: 'asset.bind',
        target: expect.objectContaining({ incarnation: 1 }),
        materialize: true,
      }),
    ]));
  });

  it('sorts equal order keys by entity ID UTF-8 bytes and applies concurrent move by LWW', () => {
    const moves = [
      changeSet({
        writer: 'writer-a', seq: 1, wallMs: 1,
        mutations: [{ action: 'order.move', kind: 'chapter', id: 'ä', payload: { positionKey: 'a0' } }],
      }),
      changeSet({
        writer: 'writer-b', seq: 1, wallMs: 1,
        mutations: [{ action: 'order.move', kind: 'chapter', id: 'z', payload: { positionKey: 'a0' } }],
      }),
      changeSet({
        writer: 'writer-c', seq: 1, wallMs: 5,
        mutations: [{ action: 'order.move', kind: 'chapter', id: 'z', payload: { positionKey: 'b0' } }],
      }),
    ];
    const state = applyAll(moves);
    expect(selectOrderedEntries(state, { kind: 'chapter', incarnation: 0 })).toMatchObject([
      { entityId: 'ä', positionKey: 'a0' },
      { entityId: 'z', positionKey: 'b0' },
    ]);

    const sameKey = applyAll(moves.slice(0, 2));
    expect(selectOrderedEntries(sameKey, { kind: 'chapter', incarnation: 0 }).map(({ entityId }) => entityId)).toEqual([
      'z',
      'ä',
    ]);
  });

  it('treats scope as register value so one entity cannot remain in two order lists', () => {
    const oldParent = changeSet({
      writer: 'writer-a', seq: 1, wallMs: 1,
      mutations: [{
        action: 'order.move', kind: 'chapter', id: 'chapter-1',
        payload: { scope: 'parent-a', positionKey: 'a0' },
      }],
    });
    const newParent = changeSet({
      writer: 'writer-a', seq: 2, wallMs: 2,
      mutations: [{
        action: 'order.move', kind: 'chapter', id: 'chapter-1',
        payload: { scope: 'parent-b', positionKey: 'b0' },
      }],
    });
    const state = applyAll([newParent, oldParent]);

    expect(selectOrderedEntries(state, {
      kind: 'chapter', incarnation: 0, scope: 'parent-a',
    })).toEqual([]);
    expect(selectOrderedEntries(state, {
      kind: 'chapter', incarnation: 0, scope: 'parent-b',
    })).toMatchObject([{ entityId: 'chapter-1', positionKey: 'b0' }]);
  });

  it('rejects an unknown target kind or unsupported action before applying any mutation', () => {
    const mixed = changeSet({
      writer: 'writer-a', seq: 1, wallMs: 1,
      mutations: [
        { action: 'field.set', kind: 'node', id: 'n1', payload: { field: 'title', value: 'must not apply' } },
        { action: 'field.set', kind: 'new-unclassified-table', id: 'x1', payload: { field: 'name', value: 'unknown' } },
      ],
    });
    const empty = createCanonicalReducerState(IDENTITY);
    const unknown = reduceSyncChangeSet(empty, mixed, PROFILE);
    expect(unknown.status).toBe('rejected');
    if (unknown.status === 'rejected') expect(unknown.rejection.code).toBe('unknown-target-kind');
    expect(canonicalReducerSnapshot(unknown.state)).toEqual(canonicalReducerSnapshot(empty));

    const yjs = changeSet({
      writer: 'writer-b', seq: 1, wallMs: 2,
      mutations: [
        { action: 'field.set', kind: 'node', id: 'n1', payload: { field: 'title', value: 'also atomic' } },
        { action: 'yjs.update', family: 'yjs', kind: 'node', id: 'n1', payload: { update: new Uint8Array([1]) } },
      ],
    });
    const unsupported = reduceSyncChangeSet(empty, yjs, PROFILE);
    expect(unsupported.status).toBe('rejected');
    if (unsupported.status === 'rejected') expect(unsupported.rejection.code).toBe('unsupported-action');
    expect(unsupported.state.fields.size).toBe(0);
    expect(unsupported.state.receipts.size).toBe(0);
  });

  it('keeps invalid semantic output as a deterministic conflict without a repair operation', () => {
    const profile: ReducerProfile = {
      ...PROFILE,
      validateProjection(projection) {
        const invalid = projection.find(
          (candidate) => candidate.type === 'field.set' && candidate.field === 'relationTypeId' && candidate.value === 'missing',
        );
        return invalid
          ? [{
              code: 'relation.invalid-type',
              scope: 'relation:r1:type',
              message: 'relation type does not exist in the canonical projection',
              target: { kind: 'node', id: 'r1', incarnation: 0 },
              details: { typeId: 'missing' },
              blockedEffectIds: [invalid.effectId],
            }]
          : [];
      },
    };
    const invalid = changeSet({
      writer: 'writer-a', seq: 1, wallMs: 1,
      mutations: [{ action: 'field.set', kind: 'node', id: 'r1', payload: { field: 'relationTypeId', value: 'missing' } }],
    });
    const result = reduceSyncChangeSet(createCanonicalReducerState(IDENTITY), invalid, profile);
    expect(result.status).toBe('applied');
    expect(result.conflicts).toMatchObject([{
      code: 'relation.invalid-type',
      conflictId: '["relation.invalid-type","relation:r1:type"]',
    }]);
    expect(result.effects).toMatchObject([{ type: 'field.set', materialize: false }]);
    expect(result.effects.every(({ type }) => !type.includes('repair'))).toBe(true);
  });

  it('converges for random permutations of two/three writers, duplicates and mixed CRDT families', () => {
    const add = changeSet({
      writer: 'writer-a', seq: 1, wallMs: 1,
      mutations: [
        { action: 'field.set', kind: 'node', id: 'n1', payload: { field: 'title', value: 'A' } },
        { action: 'tuple.set', kind: 'node', id: 'n1', payload: { tuple: 'graph.position', value: { x: 1, y: 2 } } },
        { action: 'set.add', kind: 'membership', id: 's1', payload: { memberId: 'n1', value: 'A' } },
      ],
    });
    const competing = changeSet({
      writer: 'writer-b', seq: 1, wallMs: 1, counter: 1,
      mutations: [
        { action: 'field.set', kind: 'node', id: 'n1', payload: { field: 'title', value: 'B' } },
        { action: 'tuple.set', kind: 'node', id: 'n1', payload: { tuple: 'graph.position', value: { x: 3, y: 4 } } },
        { action: 'order.move', kind: 'chapter', id: 'n1', payload: { positionKey: 'm0' } },
      ],
    });
    const remove = changeSet({
      writer: 'writer-c', seq: 1, wallMs: 2,
      mutations: [{
        action: 'set.remove', kind: 'membership', id: 's1',
        payload: { memberId: 'n1', observedAddTags: [mutationAddTag(add.changeSetId, 2)] },
      }],
    });
    const operations = [add, competing, remove];
    const expected = canonicalReducerSnapshot(applyAll(operations));

    for (let seed = 1; seed <= 100; seed += 1) {
      const shuffled = seededShuffle(operations, seed);
      const withDuplicates = seededShuffle([...shuffled, shuffled[0], shuffled[1]], seed + 100);
      let state = createCanonicalReducerState(IDENTITY);
      for (const operation of withDuplicates) {
        const result = reduceSyncChangeSet(state, operation, PROFILE);
        expect(['applied', 'duplicate']).toContain(result.status);
        state = result.state;
      }
      expect(canonicalReducerSnapshot(state)).toEqual(expected);
    }
  });

  it('rejects a missing mutation index without committing an earlier member of the same change-set', () => {
    const malformed = changeSet({
      writer: 'writer-a', seq: 1, wallMs: 1,
      mutations: [
        { action: 'field.set', kind: 'node', id: 'n1', payload: { field: 'title', value: 'one' } },
        { action: 'field.set', kind: 'node', id: 'n1', payload: { field: 'summary', value: 'two' } },
      ],
    });
    malformed.mutations[1].index = 9;
    const result = reduceSyncChangeSet(createCanonicalReducerState(IDENTITY), malformed, PROFILE);
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.rejection.code).toBe('invalid-mutation-index');
    expect(result.state.fields.size).toBe(0);
    expect(result.state.receipts.size).toBe(0);
  });
});
