import { describe, expect, it, vi } from 'vitest';

import type {
  CanonicalCborValue,
  SyncChangeSetV1,
  SyncMutationAction,
  SyncMutationTargetFamily,
  SyncMutationV1,
} from '../protocol';
import {
  canonicalReducerSnapshot,
  compactReducerReceipts,
  createCanonicalReducerState,
  materializationEffects,
  mutationAddTag,
  reduceSyncChangeSet,
  reducerStateFromSnapshot,
  replaySyncChangeSets,
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
  knownTargetKinds: new Set(['node', 'storyline', 'membership', 'chapter']),
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

  it('materializes membership tombstones while their storyline is trashed but still suppresses adds', () => {
    const created = changeSet({
      writer: 'writer-a', seq: 1, wallMs: 10,
      mutations: [
        { action: 'entity.create', kind: 'storyline', id: 'storyline-1', payload: { seed: { name: 'Main', color: '#123456' } } },
        { action: 'entity.create', kind: 'node', id: 'node-1', payload: { seed: { title: 'Chapter', kind: 'chapter' } } },
        { action: 'set.add', kind: 'membership', id: 'storyline-1', payload: { memberId: 'node-1', value: null } },
      ],
    });
    const removedAndTrashed = changeSet({
      writer: 'writer-a', seq: 2, wallMs: 11,
      mutations: [
        {
          action: 'set.remove', kind: 'membership', id: 'storyline-1',
          payload: { memberId: 'node-1', observedAddTags: [mutationAddTag(created.changeSetId, 2)] },
        },
        { action: 'entity.trash', kind: 'storyline', id: 'storyline-1', payload: {} },
        { action: 'set.add', kind: 'membership', id: 'storyline-1', payload: { memberId: 'node-2', value: null } },
      ],
    });

    const state = applyAll([created, removedAndTrashed]);
    const memberships = materializationEffects(state).filter(
      (candidate): candidate is Extract<ReducerEffect, { type: 'set.member' }> =>
        candidate.type === 'set.member',
    );
    expect(memberships).toEqual(expect.arrayContaining([
      expect.objectContaining({ memberId: 'node-1', present: false, materialize: true }),
      expect.objectContaining({ memberId: 'node-2', present: true, materialize: false }),
    ]));
    expect(materializationEffects(state).find(
      (candidate) =>
        candidate.type === 'entity.lifecycle' &&
        candidate.target.kind === 'storyline' &&
        candidate.target.id === 'storyline-1',
    )).toMatchObject({
      target: { kind: 'storyline', id: 'storyline-1' },
      status: 'trashed',
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

describe('linear replay and structural sharing', () => {
  const REPLAY_PROFILE: ReducerProfile = {
    knownTargetKinds: new Set(['node', 'membership', 'chapter', 'prose-document', 'sync-generation']),
    externallyMaterializedActions: new Set(['yjs.update', 'sync-generation.purge']),
    validateProjection(projection) {
      return projection
        .filter((candidate) => candidate.type === 'field.set' && candidate.value === 'blocked')
        .map((candidate) => ({
          code: 'node.blocked-title',
          scope: candidate.effectId,
          message: 'test validator blocks this title',
          blockedEffectIds: [candidate.effectId],
        }));
    },
  };

  function randomHistory(seed: number, withPurge: boolean): SyncChangeSetV1[] {
    let state = seed >>> 0;
    const random = () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    };
    const pick = <T,>(values: readonly T[]): T => values[Math.floor(random() * values.length)];
    const nodes = ['n1', 'n2', 'n3'];
    const addTags: string[] = [];
    const history: SyncChangeSetV1[] = [];
    const sequences = new Map<string, number>();
    for (let index = 0; index < 60; index += 1) {
      const writer = pick(['writer-a', 'writer-b', 'writer-c']);
      const seq = (sequences.get(writer) ?? 0) + 1;
      sequences.set(writer, seq);
      const node = pick(nodes);
      const mutations: MutationInput[] = [];
      for (let count = 1 + Math.floor(random() * 3); count > 0; count -= 1) {
        const roll = random();
        if (roll < 0.15) {
          mutations.push({ action: 'entity.create', kind: 'node', id: node, payload: { seed: { title: `t${index}` } } });
        } else if (roll < 0.35) {
          mutations.push({ action: 'field.set', kind: 'node', id: node, payload: { field: 'title', value: random() < 0.2 ? 'blocked' : `v${index}` } });
        } else if (roll < 0.45) {
          mutations.push({ action: 'tuple.set', kind: 'node', id: node, payload: { tuple: 'graph.position', value: { x: index, y: count } } });
        } else if (roll < 0.55) {
          mutations.push({ action: 'set.add', kind: 'membership', id: 's1', payload: { memberId: node, value: index } });
          addTags.push(mutationAddTag(`${writer}:epoch-1:${seq}`, mutations.length - 1));
        } else if (roll < 0.62 && addTags.length > 0) {
          mutations.push({ action: 'set.remove', kind: 'membership', id: 's1', payload: { memberId: node, observedAddTags: [pick(addTags)] } });
        } else if (roll < 0.7) {
          mutations.push({ action: 'order.move', kind: 'chapter', id: node, payload: { positionKey: `m${Math.floor(random() * 9)}` } });
        } else if (roll < 0.78) {
          mutations.push({ action: 'entity.trash', kind: 'node', id: node, incarnation: Math.floor(random() * 2), payload: {} });
        } else if (roll < 0.84) {
          mutations.push({ action: 'entity.restore', kind: 'node', id: node, incarnation: 1, payload: { seed: { title: `restored${index}` } } });
        } else if (roll < 0.97 || !withPurge) {
          mutations.push({ action: 'yjs.update', kind: 'prose-document', id: `node-content:${node}`, payload: { update: index } });
        } else {
          mutations.push({ action: 'sync-generation.purge', kind: 'sync-generation', id: IDENTITY.syncGenerationId, payload: { reason: 'test' } });
        }
      }
      history.push(changeSet({ writer, seq, wallMs: Math.floor(random() * 50), counter: index, mutations }));
    }
    // Duplicate delivery inside the replayed history must stay a no-op.
    return [...history, history[3], history[17]];
  }

  it('matches a step-by-step fold exactly, including conflicts and the final effects', () => {
    let seedsWithConflicts = 0;
    let seedsWithPurge = 0;
    for (let seed = 1; seed <= 40; seed += 1) {
      const history = randomHistory(seed, seed % 4 === 0);
      let stepwise = createCanonicalReducerState(IDENTITY);
      let lastApplied: ReturnType<typeof reduceSyncChangeSet> | null = null;
      for (const change of history) {
        const result = reduceSyncChangeSet(stepwise, change, REPLAY_PROFILE);
        expect(result.status).not.toBe('rejected');
        if (result.status === 'applied') lastApplied = result;
        stepwise = result.state;
      }
      const replayed = replaySyncChangeSets(createCanonicalReducerState(IDENTITY), history, REPLAY_PROFILE);
      expect(replayed.status).toBe('applied');
      expect(canonicalReducerSnapshot(replayed.state)).toEqual(canonicalReducerSnapshot(stepwise));
      expect(replayed.effects).toEqual(lastApplied?.effects);
      expect(replayed.conflicts).toEqual(lastApplied?.conflicts);
      if (replayed.conflicts.length > 0) seedsWithConflicts += 1;
      if (replayed.state.generationPurge) seedsWithPurge += 1;

      // Replaying a suffix on top of a prefix (a persisted snapshot) converges too.
      const prefix = replaySyncChangeSets(createCanonicalReducerState(IDENTITY), history.slice(0, 25), REPLAY_PROFILE);
      const resumed = replaySyncChangeSets(prefix.state, history.slice(25), REPLAY_PROFILE);
      expect(canonicalReducerSnapshot(resumed.state)).toEqual(canonicalReducerSnapshot(stepwise));
    }
    expect(seedsWithConflicts).toBeGreaterThan(10);
    expect(seedsWithPurge).toBeGreaterThan(2);
  });

  it('never mutates the predecessor state while deriving the next one', () => {
    const history = randomHistory(7, false);
    const prior = replaySyncChangeSets(createCanonicalReducerState(IDENTITY), history.slice(0, 40), REPLAY_PROFILE).state;
    const before = canonicalReducerSnapshot(prior);
    let next = prior;
    for (const change of history.slice(40)) next = reduceSyncChangeSet(next, change, REPLAY_PROFILE).state;
    replaySyncChangeSets(prior, history.slice(40), REPLAY_PROFILE);
    expect(canonicalReducerSnapshot(prior)).toEqual(before);
    expect(canonicalReducerSnapshot(next)).not.toEqual(before);
  });

  it('shares receipts across states and forks when an older state is extended', () => {
    const [first, second, third] = randomHistory(11, false);
    const base = reduceSyncChangeSet(createCanonicalReducerState(IDENTITY), first, REPLAY_PROFILE).state;
    const left = reduceSyncChangeSet(base, second, REPLAY_PROFILE).state;
    // Extending `base` again is what happens after a rolled-back optimistic write.
    const right = reduceSyncChangeSet(base, third, REPLAY_PROFILE).state;
    expect([...base.receipts.keys()]).toEqual([first.changeSetId]);
    expect([...left.receipts.keys()]).toEqual([first.changeSetId, second.changeSetId]);
    expect([...right.receipts.keys()]).toEqual([first.changeSetId, third.changeSetId]);
    expect(left.receipts.has(third.changeSetId)).toBe(false);
    expect(right.receipts.get(second.changeSetId)).toBeUndefined();
    expect(reduceSyncChangeSet(right, second, REPLAY_PROFILE).state.receipts.size).toBe(3);
  });

  it('derives the next state without iterating historical receipts', () => {
    const history = randomHistory(13, false);
    const prior = replaySyncChangeSets(createCanonicalReducerState(IDENTITY), history.slice(0, 50), REPLAY_PROFILE).state;
    const receipts = prior.receipts;
    const iterated = [
      vi.spyOn(receipts, 'entries'),
      vi.spyOn(receipts, 'keys'),
      vi.spyOn(receipts, 'values'),
      vi.spyOn(receipts, 'forEach'),
    ];
    const result = reduceSyncChangeSet(prior, history[55], REPLAY_PROFILE);
    expect(result.state.receipts.size).toBe(receipts.size + 1);
    for (const spy of iterated) expect(spy).not.toHaveBeenCalled();
  });

  /** Registers and the applied set, independent of how receipts are compacted. */
  function semantic(state: CanonicalReducerState) {
    const { coverage, receipts, ...registers } = canonicalReducerSnapshot(state);
    const applied = receipts.map(({ changeSetId }) => changeSetId);
    for (const lane of coverage) {
      for (let seq = 1; seq <= lane.deviceSeq; seq += 1) applied.push(`${lane.writerId}:${lane.writerEpoch}:${seq}`);
    }
    return { ...registers, applied: applied.sort() };
  }

  it('compacts contiguous lanes without changing registers or later reductions', () => {
    for (let seed = 21; seed <= 30; seed += 1) {
      const history = randomHistory(seed, false);
      const prefix = replaySyncChangeSets(createCanonicalReducerState(IDENTITY), history.slice(0, 40), REPLAY_PROFILE).state;
      const compacted = compactReducerReceipts(prefix);
      expect(compacted.coverage.size).toBeGreaterThan(0);
      expect(compacted.receipts.size).toBeLessThan(prefix.receipts.size);
      expect(semantic(compacted)).toEqual(semantic(prefix));

      for (const covered of history.slice(0, 40)) {
        expect(reduceSyncChangeSet(compacted, covered, REPLAY_PROFILE).status).toBe('duplicate');
      }
      const tail = history.slice(40);
      expect(semantic(replaySyncChangeSets(compacted, tail, REPLAY_PROFILE).state))
        .toEqual(semantic(replaySyncChangeSets(prefix, tail, REPLAY_PROFILE).state));
      // Compaction is idempotent and keeps non-contiguous receipts explicit.
      expect(compactReducerReceipts(compacted)).toBe(compacted);
    }
  });

  it('round-trips the canonical snapshot back into an equivalent state', () => {
    const history = randomHistory(31, true);
    for (const state of [
      replaySyncChangeSets(createCanonicalReducerState(IDENTITY), history, REPLAY_PROFILE).state,
      compactReducerReceipts(replaySyncChangeSets(createCanonicalReducerState(IDENTITY), history, REPLAY_PROFILE).state),
    ]) {
      const restored = reducerStateFromSnapshot(canonicalReducerSnapshot(state));
      expect(JSON.stringify(canonicalReducerSnapshot(restored))).toBe(JSON.stringify(canonicalReducerSnapshot(state)));
      const next = changeSet({
        writer: 'writer-z', seq: 1, wallMs: 99,
        mutations: [{ action: 'field.set', kind: 'node', id: 'n1', payload: { field: 'title', value: 'after restore' } }],
      });
      expect(canonicalReducerSnapshot(reduceSyncChangeSet(restored, next, REPLAY_PROFILE).state))
        .toEqual(canonicalReducerSnapshot(reduceSyncChangeSet(state, next, REPLAY_PROFILE).state));
    }
    const duplicated = canonicalReducerSnapshot(createCanonicalReducerState(IDENTITY));
    expect(() => reducerStateFromSnapshot({
      ...duplicated,
      coverage: [{ writerId: 'w', writerEpoch: 'e', deviceSeq: 1 }, { writerId: 'w', writerEpoch: 'e', deviceSeq: 2 }],
    })).toThrow(/repeats coverage lane/u);
  });
});
