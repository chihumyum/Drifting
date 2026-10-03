import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProductFileBackedSqliteGateway } from '../../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import type { DbClient } from '../../lib/db';
import {
  BookNodeTable,
  ProjectTable,
  SyncApplyReceiptTable,
  SyncChangeSetTable,
  SyncConflictTable,
  SyncEntityLifecycleTable,
  SyncFieldClockTable,
  SyncOrderRegisterTable,
  SyncReducerSnapshotTable,
  SyncSetTagTable,
  SyncGenerationTable,
  SyncGenerationWriterStateTable,
} from '../../schema/drizzle';
import { SyncChangeBuilder } from '../journal/change-builder';
import { recordAuthoredChangeSetInTransaction } from '../journal/repository';
import type { SyncWriterIdentitySource } from '../journal/writer-state';
import {
  createSyncMutationV1,
  type CanonicalCborValue,
  type SyncChangeSetV1,
  type SyncMutationAction,
  type SyncMutationTargetFamily,
} from '../protocol';
import {
  canonicalReducerSnapshot,
  compactReducerReceipts,
  createCanonicalReducerState,
  replaySyncChangeSets,
} from './reducer';
import {
  applyVerifiedRemoteChangeSetInTransaction,
  DEFAULT_SQLITE_REDUCER_PROFILE,
  getSqliteReducerLoadDiagnostics,
  invalidateSqliteReducerStateCache,
  LocalAuthoredSemanticConflictError,
  observeLocalAuthoredReducerInTransaction,
  setSqliteReducerSnapshotIntervalForTest,
  SQLITE_REDUCER_V1_TARGET_KINDS,
  SyncReducerRejectedError,
  type SyncDomainMaterializationKernel,
} from './sqlite-materializer';
import { encodeReducerState, REDUCER_STATE_SNAPSHOT_FORMAT } from './state-snapshot';

const PROJECT_ID = 'project-materializer';
const SYNC_GENERATION_ID = 'sync-generation-materializer';
const PROJECT_SYNC_ID = 'projectSync-materializer';
const NODE_ID = 'node-materializer';
const NOW = '2026-08-15T00:00:00.000Z';
const temporaryDirectories: string[] = [];
const gateways: ProductFileBackedSqliteGateway[] = [];

async function createDatabase(): Promise<{
  db: DbClient;
  gateway: ProductFileBackedSqliteGateway;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-sync-materializer-'));
  temporaryDirectories.push(directory);
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'drifting.db'));
  gateways.push(gateway);
  const db = gateway.client();
  await db.insert(ProjectTable).values({
    id: PROJECT_ID,
    userId: 'local-user',
    name: 'Materializer project',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(BookNodeTable).values({
    id: NODE_ID,
    title: 'Before',
    summary: '',
    projectId: PROJECT_ID,
    kind: 'chapter',
    writingStatus: 'draft',
    positionX: 0,
    positionY: 0,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(SyncGenerationTable).values({
    syncGenerationId: SYNC_GENERATION_ID,
    projectId: PROJECT_ID,
    projectSyncId: PROJECT_SYNC_ID,
    generationNumber: 1,
    protocolVersion: 1,
    domainSchemaVersion: 1,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });
  return { db, gateway };
}

function identity(): SyncWriterIdentitySource {
  return {
    installationId: 'local-installation',
    createWriterIdentity: () => ({ writerId: 'local-writer', writerEpoch: 'local-epoch' }),
  };
}

const FAMILY: Readonly<Record<SyncMutationAction, SyncMutationTargetFamily>> = {
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

async function remoteChangeSet(input: {
  writer: string;
  seq: number;
  wallMs: number;
  mutations: readonly {
    action: SyncMutationAction;
    kind: string;
    id: string;
    payload: CanonicalCborValue;
    family?: SyncMutationTargetFamily;
  }[];
}): Promise<SyncChangeSetV1> {
  const writerEpoch = `epoch-${input.writer}`;
  const mutations = await Promise.all(input.mutations.map((mutation, index) =>
    createSyncMutationV1({
      index,
      target: {
        family: mutation.family ?? FAMILY[mutation.action],
        kind: mutation.kind,
        id: mutation.id,
        incarnation: 0,
      },
      action: mutation.action,
      payloadVersion: 1,
      payload: mutation.payload,
    }),
  ));
  return {
    protocol: 'drifting.sync.changeset',
    protocolVersion: 1,
    payloadVersion: 1,
    projectId: PROJECT_ID,
    projectSyncId: PROJECT_SYNC_ID,
    syncGenerationId: SYNC_GENERATION_ID,
    changeSetId: `${input.writer}:${writerEpoch}:${input.seq}`,
    writerId: input.writer,
    writerEpoch,
    deviceSeq: input.seq,
    hlc: { wallMs: input.wallMs, counter: 0 },
    mutations,
  };
}

function nodeKernel(blockTitle?: string): SyncDomainMaterializationKernel {
  return {
    async validate({ effects }) {
      const blocked = effects.find((effect) =>
        effect.type === 'field.set' &&
        effect.field === 'title' &&
        effect.value === blockTitle,
      );
      return blocked
        ? [{
            code: 'node.title-blocked',
            scope: `node:${NODE_ID}:title`,
            message: 'test domain validator rejected the title',
            target: { kind: 'node', id: NODE_ID, incarnation: 0 },
            details: { title: blockTitle ?? '' },
            blockedEffectIds: [blocked.effectId],
          }]
        : [];
    },
    async materialize({ tx, effects }) {
      for (const effect of effects) {
        if (!effect.materialize || effect.target.kind !== 'node' || effect.target.id !== NODE_ID) {
          continue;
        }
        if (effect.type === 'field.set' && effect.field === 'title') {
          if (typeof effect.value !== 'string') throw new TypeError('node title must be a string');
          await tx.update(BookNodeTable).set({ title: effect.value }).where(eq(BookNodeTable.id, NODE_ID));
        }
        if (effect.type === 'tuple.set' && effect.tuple === 'graph.position') {
          const value = effect.value as { x?: unknown; y?: unknown };
          if (typeof value.x !== 'number' || typeof value.y !== 'number') {
            throw new TypeError('graph.position must contain numeric x/y');
          }
          await tx.update(BookNodeTable).set({
            positionX: value.x,
            positionY: value.y,
          }).where(eq(BookNodeTable.id, NODE_ID));
        }
      }
    },
  };
}

afterEach(async () => {
  invalidateSqliteReducerStateCache();
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('SQLite SyncEngine reducer materializer', () => {
  it('atomically materializes remote field/tuple winners, clocks, HLC and receipt without echo', async () => {
    const { db, gateway } = await createDatabase();
    const changeSet = await remoteChangeSet({
      writer: 'remote-a',
      seq: 1,
      wallMs: 500,
      mutations: [
        { action: 'field.set', kind: 'node', id: NODE_ID, payload: { field: 'title', value: 'Remote' } },
        { action: 'tuple.set', kind: 'node', id: NODE_ID, payload: { tuple: 'graph.position', value: { x: 12, y: 34 } } },
      ],
    });

    const result = await db.transaction((tx) => applyVerifiedRemoteChangeSetInTransaction(tx, {
      changeSet,
      identity: identity(),
      clock: { nowMs: 100, nowIso: '2026-08-15T00:00:00.100Z' },
      kernel: nodeKernel(),
      sourceObjectId: 'drive-object-1',
    }));
    expect(result.status).toBe('applied');
    expect(await db.select().from(BookNodeTable).where(eq(BookNodeTable.id, NODE_ID))).toMatchObject([
      { title: 'Remote', positionX: 12, positionY: 34 },
    ]);
    expect(await db.select().from(SyncFieldClockTable)).toMatchObject([
      { fieldKey: 'field:title', changeSetId: changeSet.changeSetId, mutationIndex: 0 },
      { fieldKey: 'tuple:graph.position', changeSetId: changeSet.changeSetId, mutationIndex: 1 },
    ]);
    expect(await db.select().from(SyncApplyReceiptTable)).toMatchObject([
      { changeSetId: changeSet.changeSetId, sourceObjectId: 'drive-object-1' },
    ]);
    expect(await db.select().from(SyncChangeSetTable)).toMatchObject([
      { origin: 'remote', applyState: 'applied' },
    ]);
    expect(await db.select().from(SyncGenerationWriterStateTable)).toMatchObject([
      { writerId: 'local-writer', nextDeviceSeq: 1, hlcWallMs: 500, hlcCounter: 1 },
    ]);

    const duplicate = await db.transaction((tx) => applyVerifiedRemoteChangeSetInTransaction(tx, {
      changeSet,
      identity: identity(),
      clock: { nowMs: 101, nowIso: '2026-08-15T00:00:00.101Z' },
      kernel: nodeKernel(),
    }));
    expect(duplicate.status).toBe('duplicate');
    expect(await db.select().from(SyncApplyReceiptTable)).toHaveLength(1);
    expect((await db.select().from(SyncChangeSetTable)).filter(({ origin }) => origin === 'local')).toEqual([]);

    const collision = await remoteChangeSet({
      writer: 'remote-a',
      seq: 1,
      wallMs: 500,
      mutations: [{
        action: 'field.set',
        kind: 'node',
        id: NODE_ID,
        payload: { field: 'title', value: 'same identity, different bytes' },
      }],
    });
    await expect(db.transaction((tx) => applyVerifiedRemoteChangeSetInTransaction(tx, {
      changeSet: collision,
      identity: identity(),
      clock: { nowMs: 102, nowIso: '2026-08-15T00:00:00.102Z' },
      kernel: nodeKernel(),
    }))).rejects.toThrow(/collides with different stored bytes/u);
    expect(await db.select().from(SyncChangeSetTable)).toHaveLength(1);
    expect(gateway.database.prepare('PRAGMA integrity_check').get()).toEqual({
      integrity_check: 'ok',
    });
    expect(gateway.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('converges when an older change-set arrives after its winner', async () => {
    const { db } = await createDatabase();
    const newer = await remoteChangeSet({
      writer: 'remote-new', seq: 1, wallMs: 20,
      mutations: [{ action: 'field.set', kind: 'node', id: NODE_ID, payload: { field: 'title', value: 'Newer' } }],
    });
    const older = await remoteChangeSet({
      writer: 'remote-old', seq: 1, wallMs: 10,
      mutations: [{ action: 'field.set', kind: 'node', id: NODE_ID, payload: { field: 'title', value: 'Older' } }],
    });
    for (const changeSet of [newer, older]) {
      await db.transaction((tx) => applyVerifiedRemoteChangeSetInTransaction(tx, {
        changeSet,
        identity: identity(),
        clock: { nowMs: 1, nowIso: NOW },
        kernel: nodeKernel(),
      }));
    }
    expect(await db.select({ title: BookNodeTable.title }).from(BookNodeTable)).toEqual([{ title: 'Newer' }]);
    expect(await db.select().from(SyncFieldClockTable)).toMatchObject([
      { changeSetId: newer.changeSetId, hlcWallMs: 20 },
    ]);
  });

  it('persists observed-remove deterministically even when remove arrives before add', async () => {
    const { db } = await createDatabase();
    const add = await remoteChangeSet({
      writer: 'remote-add', seq: 1, wallMs: 10,
      mutations: [{ action: 'set.add', kind: 'membership', id: 'storyline-1', payload: { memberId: NODE_ID, value: 'member' } }],
    });
    const addTag = `${add.changeSetId}#0`;
    const remove = await remoteChangeSet({
      writer: 'remote-remove', seq: 1, wallMs: 20,
      mutations: [{ action: 'set.remove', kind: 'membership', id: 'storyline-1', payload: { memberId: NODE_ID, observedAddTags: [addTag] } }],
    });
    const kernel = nodeKernel();
    for (const changeSet of [remove, add]) {
      await db.transaction((tx) => applyVerifiedRemoteChangeSetInTransaction(tx, {
        changeSet,
        identity: identity(),
        clock: { nowMs: 1, nowIso: NOW },
        kernel,
      }));
    }
    expect(await db.select().from(SyncSetTagTable)).toMatchObject([{
      addTag,
      addChangeSetId: add.changeSetId,
      removedByChangeSetId: remove.changeSetId,
    }]);
  });

  it('keeps invalid semantic metadata/conflict but never writes the blocked domain effect', async () => {
    const { db } = await createDatabase();
    const changeSet = await remoteChangeSet({
      writer: 'remote-blocked', seq: 1, wallMs: 50,
      mutations: [{ action: 'field.set', kind: 'node', id: NODE_ID, payload: { field: 'title', value: 'Forbidden' } }],
    });
    const result = await db.transaction((tx) => applyVerifiedRemoteChangeSetInTransaction(tx, {
      changeSet,
      identity: identity(),
      clock: { nowMs: 1, nowIso: NOW },
      kernel: nodeKernel('Forbidden'),
    }));
    expect(result.effects).toMatchObject([{ type: 'field.set', materialize: false }]);
    expect(await db.select({ title: BookNodeTable.title }).from(BookNodeTable)).toEqual([{ title: 'Before' }]);
    expect(await db.select().from(SyncFieldClockTable)).toMatchObject([{ changeSetId: changeSet.changeSetId }]);
    expect(await db.select().from(SyncConflictTable)).toMatchObject([{
      kind: 'semantic', targetKind: 'node', targetId: NODE_ID, state: 'open',
    }]);
    expect(await db.select().from(SyncApplyReceiptTable)).toHaveLength(1);

    const unrelated = new SyncChangeBuilder();
    unrelated.add({
      action: 'field.set',
      target: { family: 'entity', kind: 'node', id: NODE_ID, incarnation: 0 },
      payload: { field: 'summary', value: 'unrelated local edit' },
    });
    await db.transaction(async (tx) => {
      await tx.update(BookNodeTable).set({ summary: 'unrelated local edit' })
        .where(eq(BookNodeTable.id, NODE_ID));
      const recorded = await recordAuthoredChangeSetInTransaction(tx, {
        projectId: PROJECT_ID,
        projectSyncId: PROJECT_SYNC_ID,
        syncGenerationId: SYNC_GENERATION_ID,
        identity: identity(),
        clock: { nowMs: 60, nowIso: '2026-08-15T00:00:00.060Z' },
      }, unrelated);
      await observeLocalAuthoredReducerInTransaction(tx, {
        changeSet: recorded.changeSet,
        clock: { nowMs: 60, nowIso: '2026-08-15T00:00:00.060Z' },
      });
    });
    expect(await db.select({ state: SyncConflictTable.state }).from(SyncConflictTable)).toEqual([
      { state: 'open' },
    ]);

    const resolution = await remoteChangeSet({
      writer: 'remote-resolution', seq: 1, wallMs: 100,
      mutations: [{
        action: 'field.set',
        kind: 'node',
        id: NODE_ID,
        payload: { field: 'title', value: 'Allowed again' },
      }],
    });
    await db.transaction((tx) => applyVerifiedRemoteChangeSetInTransaction(tx, {
      changeSet: resolution,
      identity: identity(),
      clock: { nowMs: 100, nowIso: '2026-08-15T00:00:00.100Z' },
      kernel: nodeKernel('Forbidden'),
    }));
    expect(await db.select({ state: SyncConflictTable.state }).from(SyncConflictTable)).toEqual([
      { state: 'resolved' },
    ]);
  });

  it('rolls back journal, metadata and domain rows when the receipt boundary faults', async () => {
    const { db, gateway } = await createDatabase();
    const changeSet = await remoteChangeSet({
      writer: 'remote-fault', seq: 1, wallMs: 50,
      mutations: [{ action: 'field.set', kind: 'node', id: NODE_ID, payload: { field: 'title', value: 'Must rollback' } }],
    });
    gateway.failNextExecute((statement) => statement.includes('sync_apply_receipt'));
    await expect(db.transaction((tx) => applyVerifiedRemoteChangeSetInTransaction(tx, {
      changeSet,
      identity: identity(),
      clock: { nowMs: 1, nowIso: NOW },
      kernel: nodeKernel(),
    }))).rejects.toThrow(/insert into "sync_apply_receipt"/u);
    expect(await db.select({ title: BookNodeTable.title }).from(BookNodeTable)).toEqual([{ title: 'Before' }]);
    expect(await db.select().from(SyncChangeSetTable)).toEqual([]);
    expect(await db.select().from(SyncFieldClockTable)).toEqual([]);
    expect(await db.select().from(SyncApplyReceiptTable)).toEqual([]);
    expect(await db.select().from(SyncGenerationWriterStateTable)).toEqual([]);

    const retry = await db.transaction((tx) => applyVerifiedRemoteChangeSetInTransaction(tx, {
      changeSet,
      identity: identity(),
      clock: { nowMs: 2, nowIso: '2026-08-15T00:00:00.002Z' },
      kernel: nodeKernel(),
    }));
    expect(retry.status).toBe('applied');
    expect(await db.select({ title: BookNodeTable.title }).from(BookNodeTable)).toEqual([
      { title: 'Must rollback' },
    ]);
  });

  it('fails closed for an unclassified target and rolls back staging', async () => {
    const { db } = await createDatabase();
    const changeSet = await remoteChangeSet({
      writer: 'remote-unknown', seq: 1, wallMs: 50,
      mutations: [{ action: 'field.set', kind: 'future-kind', id: NODE_ID, payload: { field: 'title', value: 'No' } }],
    });
    await expect(db.transaction((tx) => applyVerifiedRemoteChangeSetInTransaction(tx, {
      changeSet,
      identity: identity(),
      clock: { nowMs: 1, nowIso: NOW },
      kernel: nodeKernel(),
    }))).rejects.toBeInstanceOf(SyncReducerRejectedError);
    expect(await db.select().from(SyncChangeSetTable)).toEqual([]);
  });

  it('requires a remote typed kernel to explicitly claim an external reducer action', async () => {
    const { db } = await createDatabase();
    const changeSet = await remoteChangeSet({
      writer: 'remote-yjs', seq: 1, wallMs: 50,
      mutations: [{
        action: 'yjs.update',
        family: 'yjs',
        kind: 'prose-document',
        id: NODE_ID,
        payload: { update: new Uint8Array([1, 2, 3]) },
      }],
    });
    await expect(db.transaction((tx) => applyVerifiedRemoteChangeSetInTransaction(tx, {
      changeSet,
      identity: identity(),
      clock: { nowMs: 1, nowIso: NOW },
      kernel: nodeKernel(),
    }))).rejects.toBeInstanceOf(SyncReducerRejectedError);
    expect(await db.select().from(SyncChangeSetTable)).toEqual([]);
  });

  it('observes local domain writes into reducer metadata and rolls all of them back on conflict', async () => {
    const { db } = await createDatabase();
    const localIdentity = identity();
    const accepted = new SyncChangeBuilder();
    accepted.add({
      action: 'field.set',
      target: { family: 'entity', kind: 'node', id: NODE_ID, incarnation: 0 },
      payload: { field: 'title', value: 'Local accepted' },
    });
    await db.transaction(async (tx) => {
      await tx.update(BookNodeTable).set({ title: 'Local accepted' }).where(eq(BookNodeTable.id, NODE_ID));
      const recorded = await recordAuthoredChangeSetInTransaction(tx, {
        projectId: PROJECT_ID,
        projectSyncId: PROJECT_SYNC_ID,
        syncGenerationId: SYNC_GENERATION_ID,
        identity: localIdentity,
        clock: { nowMs: 10, nowIso: NOW },
      }, accepted);
      await observeLocalAuthoredReducerInTransaction(tx, {
        changeSet: recorded.changeSet,
        clock: { nowMs: 10, nowIso: NOW },
      });
    });
    expect(await db.select().from(SyncFieldClockTable)).toMatchObject([{ fieldKey: 'field:title' }]);

    const rejected = new SyncChangeBuilder();
    rejected.add({
      action: 'field.set',
      target: { family: 'entity', kind: 'node', id: NODE_ID, incarnation: 0 },
      payload: { field: 'title', value: 'Forbidden local' },
    });
    await expect(db.transaction(async (tx) => {
      await tx.update(BookNodeTable).set({ title: 'Forbidden local' }).where(eq(BookNodeTable.id, NODE_ID));
      const recorded = await recordAuthoredChangeSetInTransaction(tx, {
        projectId: PROJECT_ID,
        projectSyncId: PROJECT_SYNC_ID,
        syncGenerationId: SYNC_GENERATION_ID,
        identity: localIdentity,
        clock: { nowMs: 20, nowIso: '2026-08-15T00:00:00.020Z' },
      }, rejected);
      await observeLocalAuthoredReducerInTransaction(tx, {
        changeSet: recorded.changeSet,
        clock: { nowMs: 20, nowIso: '2026-08-15T00:00:00.020Z' },
        validator: nodeKernel('Forbidden local'),
      });
    })).rejects.toBeInstanceOf(LocalAuthoredSemanticConflictError);
    expect(await db.select({ title: BookNodeTable.title }).from(BookNodeTable)).toEqual([{ title: 'Local accepted' }]);
    expect(await db.select().from(SyncChangeSetTable)).toHaveLength(1);
    expect(await db.select().from(SyncApplyReceiptTable)).toHaveLength(1);
    expect(await db.select().from(SyncConflictTable)).toEqual([]);
  });
});

describe('reducer state compaction and incremental metadata', () => {
  afterEach(() => setSqliteReducerSnapshotIntervalForTest(null));

  async function history(count: number, startSeq = 1): Promise<SyncChangeSetV1[]> {
    const changes: SyncChangeSetV1[] = [];
    for (let index = 0; index < count; index += 1) {
      const seq = startSeq + index;
      const writer = `remote-${seq % 3}`;
      const other = `node-${seq % 4}`;
      const step = seq % 6;
      const mutations =
        step === 0 ? [{ action: 'entity.create' as const, kind: 'node', id: other, payload: { seed: { title: `t${seq}` } } }]
        : step === 1 ? [{ action: 'field.set' as const, kind: 'node', id: NODE_ID, payload: { field: 'title', value: `title ${seq}` } }]
        : step === 2 ? [{ action: 'set.add' as const, kind: 'membership', id: 'storyline-1', payload: { memberId: other, value: seq } }]
        : step === 3 ? [{ action: 'order.move' as const, kind: 'chapter', id: other, payload: { positionKey: `m${seq % 7}` } }]
        : step === 4 ? [{ action: 'entity.trash' as const, kind: 'node', id: other, payload: {} }]
        : [{ action: 'tuple.set' as const, kind: 'node', id: NODE_ID, payload: { tuple: 'graph.position', value: { x: seq, y: -seq } } }];
      // Every writer lane keeps its own sequence; wall clocks interleave.
      changes.push(await remoteChangeSet({ writer, seq: Math.floor((seq - 1) / 3) + 1, wallMs: 1_000 + ((seq * 7) % 40), mutations }));
    }
    return changes;
  }

  async function apply(db: DbClient, changeSet: SyncChangeSetV1) {
    return db.transaction((tx) => applyVerifiedRemoteChangeSetInTransaction(tx, {
      changeSet,
      identity: identity(),
      clock: { nowMs: 1, nowIso: NOW },
      kernel: nodeKernel(),
    }));
  }

  async function metadata(db: DbClient) {
    const sorted = <T,>(rows: T[]) => rows.map((row) => JSON.stringify(row, (_key, value: unknown) =>
      value instanceof Uint8Array ? [...value] : value,
    )).sort();
    return {
      fields: sorted(await db.select().from(SyncFieldClockTable)),
      sets: sorted(await db.select().from(SyncSetTagTable)),
      orders: sorted(await db.select().from(SyncOrderRegisterTable)),
      lifecycles: sorted(await db.select().from(SyncEntityLifecycleTable)),
    };
  }

  it('resumes from a persisted snapshot, replays only the uncovered tail and matches a full replay', async () => {
    setSqliteReducerSnapshotIntervalForTest(5);
    const changes = await history(24);
    const { db } = await createDatabase();
    for (const changeSet of changes.slice(0, 23)) await apply(db, changeSet);
    expect(await db.select({
      receiptCount: SyncReducerSnapshotTable.receiptCount,
      codec: SyncReducerSnapshotTable.codec,
    }).from(SyncReducerSnapshotTable)).toEqual([{ receiptCount: 20, codec: 'cbor+gzip' }]);

    invalidateSqliteReducerStateCache();
    const resumed = await apply(db, changes[23]);
    // Every lane of the snapshot was contiguous, so it holds coverage only.
    expect(getSqliteReducerLoadDiagnostics()).toMatchObject({
      source: 'snapshot',
      startReceipts: 0,
      replayedChangeSets: 3,
    });

    setSqliteReducerSnapshotIntervalForTest(1_000);
    const { db: reference } = await createDatabase();
    let replayed: Awaited<ReturnType<typeof apply>> | null = null;
    for (const changeSet of changes) replayed = await apply(reference, changeSet);
    expect(canonicalReducerSnapshot(compactReducerReceipts(resumed.state!)))
      .toEqual(canonicalReducerSnapshot(compactReducerReceipts(replayed!.state!)));
    expect(await metadata(db)).toEqual(await metadata(reference));
  });

  it('discards a snapshot covering a receipt that SQLite does not have', async () => {
    setSqliteReducerSnapshotIntervalForTest(1_000);
    const changes = await history(6);
    const { db } = await createDatabase();
    for (const changeSet of changes.slice(0, 5)) await apply(db, changeSet);
    const foreign = (await history(1, 50))[0];
    const stale = replaySyncChangeSets(
      createCanonicalReducerState({ projectId: PROJECT_ID, projectSyncId: PROJECT_SYNC_ID, syncGenerationId: SYNC_GENERATION_ID }),
      [...changes.slice(0, 5), foreign],
      { ...DEFAULT_SQLITE_REDUCER_PROFILE, externallyMaterializedActions: new Set(['yjs.update', 'asset.bind', 'asset.unbind', 'sync-generation.purge']) },
    ).state;
    await db.insert(SyncReducerSnapshotTable).values({
      syncGenerationId: SYNC_GENERATION_ID,
      profileKey: JSON.stringify([
        [...SQLITE_REDUCER_V1_TARGET_KINDS].sort(),
        ['asset.bind', 'asset.unbind', 'sync-generation.purge', 'yjs.update'],
      ]),
      formatVersion: REDUCER_STATE_SNAPSHOT_FORMAT,
      codec: 'cbor',
      receiptCount: stale.receipts.size,
      stateBlob: encodeReducerState(stale),
      createdAt: NOW,
    });

    invalidateSqliteReducerStateCache();
    const result = await apply(db, changes[5]);
    expect(getSqliteReducerLoadDiagnostics()).toMatchObject({ source: 'journal', replayedChangeSets: 5 });
    expect(result.state!.receipts.has(foreign.changeSetId)).toBe(false);
    expect(await db.select().from(SyncReducerSnapshotTable)).toEqual([]);
  });

  it('reuses the predecessor state after a rolled-back write instead of replaying history', async () => {
    const changes = await history(4);
    const { db, gateway } = await createDatabase();
    for (const changeSet of changes.slice(0, 3)) await apply(db, changeSet);
    const lastRebuild = getSqliteReducerLoadDiagnostics();

    gateway.failNextExecute((statement) => statement.includes('sync_apply_receipt'));
    await expect(apply(db, changes[3])).rejects.toThrow(/sync_apply_receipt/u);
    const retried = await apply(db, changes[3]);
    expect(retried.status).toBe('applied');
    expect(retried.state!.receipts.size).toBe(4);
    expect(getSqliteReducerLoadDiagnostics()).toBe(lastRebuild);
  });

  it('writes only changed metadata, which a full rebuild leaves unchanged', async () => {
    setSqliteReducerSnapshotIntervalForTest(1_000);
    const changes = await history(30);
    const { db } = await createDatabase();
    for (const changeSet of changes.slice(0, 29)) await apply(db, changeSet);
    const incremental = await metadata(db);

    // A rebuilt state rewrites every metadata row from the journal.
    invalidateSqliteReducerStateCache();
    await apply(db, changes[29]);
    const repaired = await metadata(db);
    const lastChange = changes[29].changeSetId;
    const withoutLast = (rows: string[]) => rows.filter((row) => !row.includes(lastChange));
    expect(withoutLast(repaired.fields)).toEqual(withoutLast(incremental.fields));
    expect(withoutLast(repaired.sets)).toEqual(withoutLast(incremental.sets));
    expect(withoutLast(repaired.orders)).toEqual(withoutLast(incremental.orders));
    expect(withoutLast(repaired.lifecycles)).toEqual(withoutLast(incremental.lifecycles));
  });

  it('upserts only the registers a warm write touched', async () => {
    setSqliteReducerSnapshotIntervalForTest(1_000);
    const changes = await history(31);
    const { db, gateway } = await createDatabase();
    for (const changeSet of changes.slice(0, 30)) await apply(db, changeSet);
    const metadataWrites = /insert into "sync_(field_clock|set_tag|order_register|entity_lifecycle|generation_purge)"/u;
    const execute = vi.spyOn(gateway, 'execute');
    // history step 1 sets one node title: exactly one field clock row changes.
    const touchOne = changes[30];
    expect(touchOne.mutations).toHaveLength(1);
    await apply(db, touchOne);
    const writes = execute.mock.calls.filter(([statement]) => metadataWrites.test(statement));
    expect(writes).toHaveLength(1);
    expect(await metadata(db)).toMatchObject({ fields: expect.arrayContaining([expect.stringContaining(touchOne.changeSetId)]) });
  });
});
