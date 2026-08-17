import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { and, eq } from 'drizzle-orm';
import * as Y from 'yjs';
import { afterEach, describe, expect, it } from 'vitest';

import { ProductFileBackedSqliteGateway } from '../../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import type { DbClient } from '../../lib/db';
import { diffPlotGrid, serializePlotGrid, type PlotGrid } from '../../domain/plot-grid';
import {
  BookElementTable,
  BookActTable,
  BookNodeTable,
  DriftGroupTable,
  EntityKvEntryTable,
  ElementCategoryTable,
  ElementPatchTable,
  LibraryItemTable,
  NodeContentTable,
  PlotGridCellTable,
  PlotGridColumnTable,
  PlotGridDocumentTable,
  PlotGridRowTable,
  ProjectAssetTable,
  ProjectTable,
  StorylineTable,
  SyncChangeSetTable,
  SyncCheckpointTable,
  SyncFieldClockTable,
  SyncFrontierTable,
  SyncOrderRegisterTable,
  SyncRestoreAttemptTable,
  SyncSetTagTable,
  SyncGenerationTable,
  SyncGenerationWriterStateTable,
  YjsDocumentRevisionProvenanceTable,
  yjsSnapshots,
  yjsUpdates,
} from '../../schema/drizzle';
import {
  createLocalObjectRef,
  encodeCanonicalCbor,
  encodeSnapshotCommitMarkerV1,
  encodeSnapshotPackageV1,
  sha256Bytes,
  type LocalObjectRef,
  type Sha256,
  type SnapshotPackageV1,
} from '../protocol';
import { SyncChangeBuilder } from '../journal/change-builder';
import { recordAuthoredChangeSetInTransaction } from '../journal/repository';
import type { SyncWriterIdentitySource } from '../journal/writer-state';
import {
  appendAuthoredOrderMove,
  driftGroupOrderScope,
  fractionalPositionKeysBetween,
} from '../journal/order-authority';
import { observeLocalAuthoredReducerInTransaction } from '../reducer/sqlite-materializer';
import {
  replaceElementAliasesInTransaction,
  replaceEntityKvEntriesInTransaction,
} from '../../usecase/normalized-kv-alias-authority';
import { applyPlotGridMutationsInTransaction } from '../../usecase/plot-grid-write';
import {
  captureSnapshotV1,
  publishCapturedSnapshotV1,
  restoreSnapshotV1,
  restoreSnapshotsAtomicallyV1,
  SnapshotRestoreError,
  type CapturedSnapshotV1,
  type SnapshotAssetRestorePort,
} from '.';

const PROJECT_ID = 'project-checkpoint';
const SYNC_GENERATION_ID = 'sync-generation-checkpoint';
const PROJECT_SYNC_ID = 'projectSync-checkpoint';
const NOW = '2026-08-15T12:00:00.000Z';
const SOURCE_HLC_WALL_MS = 200_000_000;
const RESTORE_DEVICE_WALL_MS = 100_000_000;
const SOURCE_APPLIED_SEGMENT_HEAD = 'c'.repeat(64);
const ASSET_HASH = `sha256:${'a'.repeat(64)}` as Sha256;
const ASSET_REF = createLocalObjectRef('syncobj:test.asset-source');
const NORMALIZED_KV_JSON = JSON.stringify([{ key: 'POV', value: 'close third' }]);
const PROJECT_KV_SCOPE = JSON.stringify(['project', PROJECT_ID, 'facts']);
const PROJECT_TEMPLATE_KV_JSON = JSON.stringify([{ key: 'Tense', value: 'past' }]);
const CATEGORY_TEMPLATE_KV_JSON = JSON.stringify([{ key: 'Role', value: 'lead' }]);
const STORYLINE_KV_JSON = JSON.stringify([{ key: 'Arc', value: 'revolt' }]);
const ELEMENT_KV_JSON = JSON.stringify([{ key: 'Age', value: '31' }]);
const ELEMENT_ALIASES_JSON = JSON.stringify(['Willow']);
const PLOT_GRID: PlotGrid = {
  rows: [
    { id: 'plot-row-a', label: 'Character' },
    { id: 'plot-row-b', label: 'Conflict' },
  ],
  cols: [
    { id: 'plot-column-a', label: 'Opening' },
    { id: 'plot-column-b', label: 'Turn' },
  ],
  cells: {
    'plot-row-a:plot-column-a': 'Willow arrives',
    'plot-row-b:plot-column-b': 'The gate closes',
  },
  cellW: 210,
  cellH: 88,
};

function restoredWriterIdentity(label = 'checkpoint'): SyncWriterIdentitySource {
  return {
    installationId: `installation-restored-${label}`,
    createWriterIdentity: () => ({
      writerId: `writer-restored-${label}`,
      writerEpoch: `epoch-restored-${label}`,
    }),
  };
}
const temporaryDirectories: string[] = [];
const gateways: ProductFileBackedSqliteGateway[] = [];

async function database(label: string): Promise<DbClient> {
  const directory = await mkdtemp(path.join(tmpdir(), `drifting-checkpoint-${label}-`));
  temporaryDirectories.push(directory);
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'drifting.db'));
  gateways.push(gateway);
  return gateway.client();
}

function proseDoc(text: string): string {
  return JSON.stringify({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });
}

function yState(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, text);
  return Y.encodeStateAsUpdate(doc);
}

async function seedSource(db: DbClient): Promise<void> {
  await db.insert(ProjectTable).values({
    id: PROJECT_ID,
    name: 'Checkpoint source',
    summary: 'typed state',
    userId: 'source-user',
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
  await db.insert(ProjectAssetTable).values({
    id: 'asset-1',
    projectId: PROJECT_ID,
    kind: 'image',
    sourceMime: 'image/png',
    sourceSizeBytes: 42,
    sourceSha256: ASSET_HASH.slice('sha256:'.length),
    width: 10,
    height: 20,
    createdAt: NOW,
  });
  await db.insert(ElementCategoryTable).values({
    id: 'category-seed',
    projectId: PROJECT_ID,
    name: 'Seed category',
    color: '#112233',
    contentJson: proseDoc('seed category'),
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(StorylineTable).values({
    id: 'storyline-combined',
    projectId: PROJECT_ID,
    name: 'Combined storyline',
    color: '#223344',
    orderKey: 0,
    contentJson: proseDoc('storyline seed'),
    kvJson: '[]',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(BookNodeTable).values({
    id: 'node-snapshot',
    projectId: PROJECT_ID,
    title: 'Snapshot node',
    kind: 'drift',
    writingStatus: 'draft',
    bookOrder: null,
    positionX: 0,
    positionY: 0,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(BookNodeTable).values([
    {
      id: 'chapter-a',
      projectId: PROJECT_ID,
      title: 'Chapter A',
      kind: 'chapter',
      writingStatus: 'draft',
      bookOrder: 20,
      positionX: 10,
      positionY: 20,
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: 'chapter-b',
      projectId: PROJECT_ID,
      title: 'Chapter B',
      kind: 'chapter',
      writingStatus: 'draft',
      bookOrder: -5,
      positionX: 30,
      positionY: 40,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ]);
  await db.insert(NodeContentTable).values({
    nodeId: 'node-snapshot',
    contentJson: proseDoc('node seed'),
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(BookElementTable).values({
    id: 'element-update',
    projectId: PROJECT_ID,
    categoryId: 'category-seed',
    name: 'Update element',
    contentJson: proseDoc('element seed'),
    portraitAssetId: 'asset-1',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(DriftGroupTable).values({
    id: 'group-root',
    projectId: PROJECT_ID,
    name: 'Root group',
    parentGroupId: null,
    sortOrder: 4,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(ElementPatchTable).values({
    id: 'patch-ordered',
    projectId: PROJECT_ID,
    elementId: 'element-update',
    title: 'Ordered patch',
    contentJson: proseDoc('patch body'),
    orderKey: 7,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(LibraryItemTable).values([
    {
      id: 'library-a',
      projectId: PROJECT_ID,
      title: 'Library A',
      kind: 'text',
      bodyJson: proseDoc('library a'),
      orderKey: 5,
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: 'library-b',
      projectId: PROJECT_ID,
      title: 'Library B',
      kind: 'text',
      bodyJson: proseDoc('library b'),
      orderKey: -2,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ]);
  await db.insert(BookActTable).values([
    {
      id: 'act-opener',
      projectId: PROJECT_ID,
      name: 'Opening act',
      startOrder: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: 'act-second',
      projectId: PROJECT_ID,
      name: 'Second act',
      startOrder: 12,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ]);

  await db.insert(yjsSnapshots).values({
    docId: 'node-content:node-snapshot',
    stateBlob: yState('snapshot only'),
    updatedAt: NOW,
  });
  await db.insert(yjsUpdates).values({
    docId: 'element:element-update',
    updateBlob: yState('update only'),
    createdAt: NOW,
  });
  const combined = new Y.Doc();
  combined.getText('content').insert(0, 'snapshot');
  const snapshot = Y.encodeStateAsUpdate(combined);
  const vector = Y.encodeStateVector(combined);
  combined.getText('content').insert(8, ' + update');
  const update = Y.encodeStateAsUpdate(combined, vector);
  await db.insert(yjsSnapshots).values({
    docId: 'storyline:storyline-combined',
    stateBlob: snapshot,
    updatedAt: NOW,
  });
  await db.insert(yjsUpdates).values({
    docId: 'storyline:storyline-combined',
    updateBlob: update,
    createdAt: NOW,
  });

  await db.transaction(async (tx) => {
    const changes = new SyncChangeBuilder();
    await replaceEntityKvEntriesInTransaction(tx, changes, {
      projectId: PROJECT_ID,
      ownerKind: 'project',
      ownerId: PROJECT_ID,
      namespace: 'facts',
      nextJson: NORMALIZED_KV_JSON,
    });
    await replaceEntityKvEntriesInTransaction(tx, changes, {
      projectId: PROJECT_ID,
      ownerKind: 'project',
      ownerId: PROJECT_ID,
      namespace: 'storyline-template',
      nextJson: PROJECT_TEMPLATE_KV_JSON,
    });
    await replaceEntityKvEntriesInTransaction(tx, changes, {
      projectId: PROJECT_ID,
      ownerKind: 'element-category',
      ownerId: 'category-seed',
      namespace: 'element-template',
      nextJson: CATEGORY_TEMPLATE_KV_JSON,
    });
    await replaceEntityKvEntriesInTransaction(tx, changes, {
      projectId: PROJECT_ID,
      ownerKind: 'storyline',
      ownerId: 'storyline-combined',
      namespace: 'facts',
      nextJson: STORYLINE_KV_JSON,
    });
    await replaceEntityKvEntriesInTransaction(tx, changes, {
      projectId: PROJECT_ID,
      ownerKind: 'element',
      ownerId: 'element-update',
      namespace: 'facts',
      nextJson: ELEMENT_KV_JSON,
    });
    await replaceElementAliasesInTransaction(tx, changes, {
      projectId: PROJECT_ID,
      elementId: 'element-update',
      aliases: ['Willow'],
    });
    await applyPlotGridMutationsInTransaction(tx, changes, {
      projectId: PROJECT_ID,
      nodeId: 'node-snapshot',
      mutations: diffPlotGrid(null, PLOT_GRID),
    });
    await tx
      .update(BookNodeTable)
      .set({ title: 'Snapshot node with reducer clock', updatedAt: NOW })
      .where(eq(BookNodeTable.id, 'node-snapshot'));
    changes.add({
      target: { family: 'entity', kind: 'node', id: 'node-snapshot', incarnation: 0 },
      action: 'field.set',
      payload: { field: 'title', value: 'Snapshot node with reducer clock' },
    });
    const [firstKey, secondKey] = fractionalPositionKeysBetween(null, null, 2);
    appendAuthoredOrderMove(changes, {
      listKind: 'storyline',
      scope: PROJECT_ID,
      entityId: 'storyline-combined',
      positionKey: firstKey!,
    });
    appendAuthoredOrderMove(changes, {
      listKind: 'drift-group',
      scope: driftGroupOrderScope(PROJECT_ID, null),
      entityId: 'group-root',
      positionKey: firstKey!,
    });
    appendAuthoredOrderMove(changes, {
      listKind: 'element-patch',
      scope: 'element-update',
      entityId: 'patch-ordered',
      positionKey: firstKey!,
    });
    appendAuthoredOrderMove(changes, {
      listKind: 'library-item',
      scope: PROJECT_ID,
      entityId: 'library-a',
      positionKey: secondKey!,
    });
    appendAuthoredOrderMove(changes, {
      listKind: 'library-item',
      scope: PROJECT_ID,
      entityId: 'library-b',
      positionKey: firstKey!,
    });
    const clock = { nowMs: SOURCE_HLC_WALL_MS, nowIso: NOW };
    const recorded = await recordAuthoredChangeSetInTransaction(
      tx,
      {
        projectId: PROJECT_ID,
        projectSyncId: PROJECT_SYNC_ID,
        syncGenerationId: SYNC_GENERATION_ID,
        identity: {
          installationId: 'installation-checkpoint',
          createWriterIdentity: () => ({ writerId: 'writer-checkpoint', writerEpoch: 'epoch-1' }),
        },
        clock,
      },
      changes,
    );
    await observeLocalAuthoredReducerInTransaction(tx, {
      changeSet: recorded.changeSet,
      clock,
    });
    await tx.insert(SyncFrontierTable).values({
      syncGenerationId: SYNC_GENERATION_ID,
      writerId: recorded.changeSet.writerId,
      writerEpoch: recorded.changeSet.writerEpoch,
      receivedSeq: 1,
      appliedSeq: 1,
      publishedSeq: 1,
      segmentHeadSha256: SOURCE_APPLIED_SEGMENT_HEAD,
      updatedAt: NOW,
    });
  });
}

async function stagedTarget(db: DbClient, projectSyncId = PROJECT_SYNC_ID): Promise<void> {
  await db.insert(SyncGenerationTable).values({
    syncGenerationId: SYNC_GENERATION_ID,
    projectId: null,
    projectSyncId,
    generationNumber: 1,
    protocolVersion: 1,
    domainSchemaVersion: 1,
    status: 'staged',
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function capture(db: DbClient): Promise<CapturedSnapshotV1> {
  return captureSnapshotV1({
    db,
    projectId: PROJECT_ID,
    syncGenerationId: SYNC_GENERATION_ID,
    snapshotId: 'checkpoint-1',
    snapshotKind: 'checkpoint',
    packageLogicalKeyId: 'snapshot-package-key-1',
    capturedAt: { wallMs: SOURCE_HLC_WALL_MS + 1, counter: 0 },
    committedAt: { wallMs: SOURCE_HLC_WALL_MS + 2, counter: 0 },
    assetPort: {
      async captureCanonicalSource() {
        return {
          blobId: 'blob-keyed-asset-1',
          sourceRef: ASSET_REF,
          sourceSha256: ASSET_HASH,
          sizeBytes: 42,
          mimeType: 'image/png',
        };
      },
    },
  });
}

function restorePort(options: { corrupt?: boolean } = {}): SnapshotAssetRestorePort {
  return {
    async prepareVerifiedSource({ asset }) {
      return {
        assetId: asset.assetId,
        stagingRef: createLocalObjectRef(`syncobj:test.asset-stage.${asset.assetId}`),
        sourceSha256: options.corrupt ? (`sha256:${'b'.repeat(64)}` as Sha256) : asset.sourceSha256,
        sizeBytes: asset.sizeBytes,
      };
    },
    async activatePreparedSources() {
      return 'asset-activation-receipt-1';
    },
    async abandonAttempt() {},
  };
}

async function restore(
  db: DbClient,
  captured: CapturedSnapshotV1,
  options: {
    blobSources?: ReadonlyMap<string, LocalObjectRef>;
    assetPort?: SnapshotAssetRestorePort;
    expectedProjectSyncId?: string;
  } = {},
) {
  return restoreSnapshotV1({
    db,
    attemptId: `restore-${crypto.randomUUID()}`,
    stagingRef: createLocalObjectRef('syncobj:test.restore-attempt'),
    expected: {
      projectId: PROJECT_ID,
      projectSyncId: options.expectedProjectSyncId ?? PROJECT_SYNC_ID,
      syncGenerationId: SYNC_GENERATION_ID,
    },
    localUserId: 'restored-local-user',
    writerIdentity: restoredWriterIdentity(),
    packageBytes: captured.packageBytes,
    commitMarkerBytes: captured.commitMarkerBytes,
    blobSources: options.blobSources ?? new Map([['blob-keyed-asset-1', ASSET_REF]]),
    assetPort: options.assetPort ?? restorePort(),
    nowIso: () => '2026-08-15T13:00:00.000Z',
  });
}

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('provider-neutral checkpoint capture and isolated restore', () => {
  it('materializes no project when any member of an atomic multi-SyncGeneration restore fails', async () => {
    const source = await database('atomic-source');
    await seedSource(source);
    const captured = await capture(source);
    expect(captured.package.frontier).toEqual([
      {
        writerId: 'writer-checkpoint',
        writerEpoch: 'epoch-1',
        appliedSeq: 1,
        segmentHeadHash: `sha256:${SOURCE_APPLIED_SEGMENT_HEAD}`,
      },
    ]);
    const target = await database('atomic-target');
    await stagedTarget(target);
    await target.insert(SyncGenerationTable).values({
      syncGenerationId: 'sync-generation-invalid',
      projectId: null,
      projectSyncId: 'projectSync-invalid',
      generationNumber: 1,
      protocolVersion: 1,
      domainSchemaVersion: 1,
      status: 'staged',
      createdAt: NOW,
      updatedAt: NOW,
    });
    const abandoned: string[] = [];
    const port: SnapshotAssetRestorePort = {
      ...restorePort(),
      async abandonAttempt({ attemptId }) {
        abandoned.push(attemptId);
      },
    };
    const common = {
      db: target,
      localUserId: 'restored-local-user',
      writerIdentity: restoredWriterIdentity('atomic'),
      packageBytes: captured.packageBytes,
      commitMarkerBytes: captured.commitMarkerBytes,
      blobSources: new Map([['blob-keyed-asset-1', ASSET_REF]]),
      assetPort: port,
      nowIso: () => '2026-08-15T13:00:00.000Z',
    } as const;
    await expect(
      restoreSnapshotsAtomicallyV1({
        snapshots: [
          {
            ...common,
            attemptId: 'restore-atomic-valid',
            stagingRef: createLocalObjectRef('syncobj:test.atomic-valid'),
            expected: { projectId: PROJECT_ID, projectSyncId: PROJECT_SYNC_ID, syncGenerationId: SYNC_GENERATION_ID },
          },
          {
            ...common,
            attemptId: 'restore-atomic-invalid',
            stagingRef: createLocalObjectRef('syncobj:test.atomic-invalid'),
            expected: {
              projectId: 'project-invalid',
              projectSyncId: 'projectSync-invalid',
              syncGenerationId: 'sync-generation-invalid',
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'identity-mismatch' });
    expect(await target.select().from(ProjectTable)).toEqual([]);
    expect(await target.select().from(SyncGenerationTable)).toMatchObject([
      { syncGenerationId: SYNC_GENERATION_ID, status: 'staged', projectId: null },
      { syncGenerationId: 'sync-generation-invalid', status: 'staged', projectId: null },
    ]);
    expect(abandoned.sort()).toEqual(['restore-atomic-invalid', 'restore-atomic-valid']);
  });

  it('captures and restores snapshot-only, update-only, combined, and seed-only prose', async () => {
    const source = await database('source');
    await seedSource(source);
    const captured = await capture(source);
    expect(captured.package.proseDocuments.map((entry) => [entry.documentId, entry.mode])).toEqual([
      ['category:category-seed', 'seed-only'],
      ['element:element-update', 'full-state'],
      ['node-content:node-snapshot', 'full-state'],
      ['storyline:storyline-combined', 'full-state'],
    ]);

    const target = await database('target');
    await stagedTarget(target);
    await restore(target, captured);
    expect(await target.select().from(ProjectTable)).toMatchObject([
      { id: PROJECT_ID, userId: 'restored-local-user', name: 'Checkpoint source' },
    ]);
    expect(await target.select().from(ProjectAssetTable)).toHaveLength(1);
    expect(await target.select().from(SyncChangeSetTable)).toMatchObject([
      {
        writerId: 'writer-checkpoint',
        writerEpoch: 'epoch-1',
        deviceSeq: 1,
        hlcWallMs: SOURCE_HLC_WALL_MS,
        origin: 'remote',
      },
    ]);
    expect(await target.select().from(SyncFieldClockTable)).toContainEqual(
      expect.objectContaining({
        targetKind: 'node',
        targetId: 'node-snapshot',
        fieldKey: 'field:title',
      }),
    );
    const restoredSnapshots = await target.select().from(yjsSnapshots);
    expect(restoredSnapshots.map((row) => row.docId).sort()).toEqual([
      'element:element-update',
      'node-content:node-snapshot',
      'storyline:storyline-combined',
    ]);
    expect(
      restoredSnapshots.some((row) => row.docId === 'category:category-seed'),
    ).toBe(false);
    expect(await target.select().from(YjsDocumentRevisionProvenanceTable)).toMatchObject([
      { sourceKind: 'remote' },
      { sourceKind: 'remote' },
      { sourceKind: 'remote' },
    ]);
    expect(await target.select().from(SyncGenerationTable)).toMatchObject([
      { syncGenerationId: SYNC_GENERATION_ID, projectId: PROJECT_ID, status: 'active' },
    ]);
    expect(await target.select().from(SyncFrontierTable)).toMatchObject([
      {
        writerId: 'writer-checkpoint',
        writerEpoch: 'epoch-1',
        appliedSeq: 1,
        segmentHeadSha256: SOURCE_APPLIED_SEGMENT_HEAD,
      },
    ]);
    expect(await target.select().from(SyncGenerationWriterStateTable)).toMatchObject([
      {
        writerId: 'writer-restored-checkpoint',
        writerEpoch: 'epoch-restored-checkpoint',
        installationId: 'installation-restored-checkpoint',
        nextDeviceSeq: 1,
        hlcWallMs: SOURCE_HLC_WALL_MS,
        hlcCounter: 0,
      },
    ]);
    expect(await target.select().from(SyncRestoreAttemptTable)).toMatchObject([
      {
        sourceCheckpointId: 'checkpoint-1',
        state: 'completed',
        activationReceipt: 'asset-activation-receipt-1',
      },
    ]);
    expect(await target.select().from(SyncCheckpointTable)).toMatchObject([
      {
        checkpointId: 'checkpoint-1',
        kind: 'checkpoint',
        state: 'published',
        changeSetCount: 1,
      },
    ]);

    const postRestoreChanges = new SyncChangeBuilder();
    postRestoreChanges.add({
      target: { family: 'entity', kind: 'node', id: 'node-snapshot', incarnation: 0 },
      action: 'field.set',
      payload: { field: 'title', value: 'First local write after restore' },
    });
    const firstLocal = await target.transaction(async (tx) => {
      const clock = {
        nowMs: RESTORE_DEVICE_WALL_MS,
        nowIso: new Date(RESTORE_DEVICE_WALL_MS).toISOString(),
      };
      const recorded = await recordAuthoredChangeSetInTransaction(tx, {
        projectId: PROJECT_ID,
        projectSyncId: PROJECT_SYNC_ID,
        syncGenerationId: SYNC_GENERATION_ID,
        identity: restoredWriterIdentity(),
        clock,
      }, postRestoreChanges);
      await observeLocalAuthoredReducerInTransaction(tx, {
        changeSet: recorded.changeSet,
        clock,
      });
      return recorded.changeSet;
    });
    expect(firstLocal).toMatchObject({
      writerId: 'writer-restored-checkpoint',
      writerEpoch: 'epoch-restored-checkpoint',
      deviceSeq: 1,
      hlc: { wallMs: SOURCE_HLC_WALL_MS, counter: 1 },
    });
  });

  it('publishes every blob and the package before the only visible commit marker', async () => {
    const source = await database('publish-source');
    await seedSource(source);
    const captured = await capture(source);
    const calls: string[] = [];
    await publishCapturedSnapshotV1(captured, {
      async ensureBlob({ asset }) { calls.push(`blob:${asset.blobId}`); },
      async publishPackage() { calls.push('package'); },
      async publishCommitMarker() { calls.push('marker'); },
    });
    expect(calls).toEqual(['blob:blob-keyed-asset-1', 'package', 'marker']);

    calls.length = 0;
    await expect(
      publishCapturedSnapshotV1(captured, {
        async ensureBlob() { calls.push('blob'); },
        async publishPackage() { calls.push('package'); throw new Error('lost package'); },
        async publishCommitMarker() { calls.push('marker'); },
      }),
    ).rejects.toThrow(/lost package/u);
    expect(calls).toEqual(['blob', 'package']);
  });

  it('captures normalized authority and rebuilds a deliberately stale JSON projection', async () => {
    const source = await database('normalized-projection');
    await seedSource(source);
    const staleKv = JSON.stringify([{ key: 'stale', value: 'projection' }]);
    await source.transaction(async (tx) => {
      await tx
        .update(ProjectTable)
        .set({ kvJson: staleKv, storylineTemplateKvJson: staleKv })
        .where(eq(ProjectTable.id, PROJECT_ID));
      await tx
        .update(ElementCategoryTable)
        .set({ elementTemplateKvJson: staleKv })
        .where(eq(ElementCategoryTable.id, 'category-seed'));
      await tx
        .update(StorylineTable)
        .set({ kvJson: staleKv, orderKey: 999 })
        .where(eq(StorylineTable.id, 'storyline-combined'));
      await tx
        .update(BookElementTable)
        .set({ kvJson: staleKv, aliasesJson: JSON.stringify(['stale']) })
        .where(eq(BookElementTable.id, 'element-update'));
      await tx
        .update(NodeContentTable)
        .set({ plotGridJson: '{}' })
        .where(eq(NodeContentTable.nodeId, 'node-snapshot'));
      await tx
        .update(DriftGroupTable)
        .set({ sortOrder: 999 })
        .where(eq(DriftGroupTable.projectId, PROJECT_ID));
      await tx
        .update(ElementPatchTable)
        .set({ orderKey: 999 })
        .where(eq(ElementPatchTable.projectId, PROJECT_ID));
      await tx
        .update(LibraryItemTable)
        .set({ orderKey: 999 })
        .where(eq(LibraryItemTable.projectId, PROJECT_ID));
    });
    const captured = await capture(source);
    const target = await database('normalized-projection-target');
    await stagedTarget(target);
    await restore(target, captured);

    expect((await target.select().from(ProjectTable))[0]).toMatchObject({
      kvJson: NORMALIZED_KV_JSON,
      storylineTemplateKvJson: PROJECT_TEMPLATE_KV_JSON,
    });
    expect((await target.select().from(ElementCategoryTable))[0]?.elementTemplateKvJson)
      .toBe(CATEGORY_TEMPLATE_KV_JSON);
    expect((await target.select().from(StorylineTable))[0]).toMatchObject({
      kvJson: STORYLINE_KV_JSON,
      orderKey: 0,
    });
    expect((await target.select().from(BookElementTable))[0]).toMatchObject({
      kvJson: ELEMENT_KV_JSON,
      aliasesJson: ELEMENT_ALIASES_JSON,
    });
    const kvEntries = await target.select().from(EntityKvEntryTable);
    expect(kvEntries).toHaveLength(5);
    expect(kvEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ ownerKind: 'project', namespace: 'facts', key: 'POV', value: 'close third' }),
      expect.objectContaining({ ownerKind: 'project', namespace: 'storyline-template', key: 'Tense', value: 'past' }),
      expect.objectContaining({ ownerKind: 'element-category', key: 'Role', value: 'lead' }),
      expect.objectContaining({ ownerKind: 'storyline', key: 'Arc', value: 'revolt' }),
      expect.objectContaining({ ownerKind: 'element', key: 'Age', value: '31' }),
    ]));
    expect((await target.select().from(NodeContentTable))[0]?.plotGridJson)
      .toBe(serializePlotGrid(PLOT_GRID));
    expect(await target.select().from(PlotGridDocumentTable)).toMatchObject([
      { nodeId: 'node-snapshot', cellWidth: 210, cellHeight: 88 },
    ]);
    expect(await target.select().from(PlotGridRowTable)).toHaveLength(2);
    expect(await target.select().from(PlotGridColumnTable)).toHaveLength(2);
    expect(await target.select().from(PlotGridCellTable)).toHaveLength(2);
    expect(await target.select().from(BookNodeTable)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'chapter-a', bookOrder: 20 }),
      expect.objectContaining({ id: 'chapter-b', bookOrder: -5 }),
    ]));
    expect((await target.select().from(DriftGroupTable))[0]?.sortOrder).toBe(0);
    expect((await target.select().from(ElementPatchTable))[0]?.orderKey).toBe(0);
    expect(await target.select().from(LibraryItemTable)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'library-a', orderKey: 1 }),
      expect.objectContaining({ id: 'library-b', orderKey: 0 }),
    ]));
    expect(await target.select().from(BookActTable)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'act-opener', startOrder: null }),
      expect.objectContaining({ id: 'act-second', startOrder: 12 }),
    ]));
    expect(await target.select().from(SyncSetTagTable)).toMatchObject([
      { ownerKind: 'alias', ownerId: 'element-update', setKey: 'aliases', valueKey: 'willow' },
    ]);
    const orderRegisters = await target.select().from(SyncOrderRegisterTable);
    expect(orderRegisters).toHaveLength(14);
    expect(orderRegisters).toContainEqual(expect.objectContaining({
      listKind: 'kv-entry',
      ownerId: PROJECT_KV_SCOPE,
    }));
  });

  it('fails capture before publishing a checkpoint with missing fractional list authority', async () => {
    const source = await database('missing-normalized-authority');
    await seedSource(source);
    await source
      .delete(SyncOrderRegisterTable)
      .where(
        and(
          eq(SyncOrderRegisterTable.syncGenerationId, SYNC_GENERATION_ID),
          eq(SyncOrderRegisterTable.listKind, 'storyline'),
          eq(SyncOrderRegisterTable.entityId, 'storyline-combined'),
        ),
      );
    await expect(capture(source)).rejects.toThrow(
      /Normalized order authority is missing for storyline:storyline-combined/u,
    );
  });

  it('fails closed on missing/corrupt blobs and wrong projectSync without exposing a project', async () => {
    const source = await database('failure-source');
    await seedSource(source);
    const captured = await capture(source);

    const missing = await database('missing');
    await stagedTarget(missing);
    await expect(restore(missing, captured, { blobSources: new Map() })).rejects.toMatchObject({
      code: 'missing-blob',
    });
    expect(await missing.select().from(ProjectTable)).toEqual([]);
    expect(await missing.select().from(SyncGenerationTable)).toMatchObject([{ status: 'staged', projectId: null }]);

    const corrupt = await database('corrupt');
    await stagedTarget(corrupt);
    await expect(restore(corrupt, captured, { assetPort: restorePort({ corrupt: true }) })).rejects.toMatchObject({
      code: 'corrupt-blob',
    });
    expect(await corrupt.select().from(ProjectTable)).toEqual([]);

    const wrongProjectSync = await database('wrong-projectSync');
    await stagedTarget(wrongProjectSync, 'projectSync-other');
    await expect(
      restore(wrongProjectSync, captured, { expectedProjectSyncId: 'projectSync-other' }),
    ).rejects.toMatchObject({ code: 'identity-mismatch' });
    expect(await wrongProjectSync.select().from(ProjectTable)).toEqual([]);
  });

  it('rejects unknown package versions and invalid Yjs before materialization', async () => {
    const source = await database('invalid-source');
    await seedSource(source);
    const captured = await capture(source);

    const decoded = captured.package as unknown as Record<string, unknown>;
    const unknownBytes = encodeCanonicalCbor({ ...decoded, payloadVersion: 2 } as never);
    const unknown = await database('unknown-version');
    await stagedTarget(unknown);
    await expect(
      restoreSnapshotV1({
        db: unknown,
        attemptId: 'restore-unknown',
        stagingRef: createLocalObjectRef('syncobj:test.restore-unknown'),
        expected: { projectId: PROJECT_ID, projectSyncId: PROJECT_SYNC_ID, syncGenerationId: SYNC_GENERATION_ID },
        localUserId: 'local',
        writerIdentity: restoredWriterIdentity('unknown'),
        packageBytes: unknownBytes,
        commitMarkerBytes: captured.commitMarkerBytes,
        blobSources: new Map([['blob-keyed-asset-1', ASSET_REF]]),
        assetPort: restorePort(),
      }),
    ).rejects.toMatchObject({ code: 'unknown-version' });
    expect(await unknown.select().from(ProjectTable)).toEqual([]);

    const invalidPackage: SnapshotPackageV1 = {
      ...captured.package,
      proseDocuments: captured.package.proseDocuments.map((document) =>
        document.mode === 'full-state' && document.documentId === 'element:element-update'
          ? {
              ...document,
              state: Uint8Array.of(0xff, 0xff, 0xff),
              stateSha256: `sha256:${'0'.repeat(64)}` as Sha256,
            }
          : document,
      ),
    };
    const invalidState = invalidPackage.proseDocuments.find(
      (document) => document.mode === 'full-state' && document.documentId === 'element:element-update',
    );
    if (!invalidState || invalidState.mode !== 'full-state') throw new Error('missing test document');
    invalidState.stateSha256 = await sha256Bytes(invalidState.state);
    const invalidBytes = encodeSnapshotPackageV1(invalidPackage);
    const invalidMarker = {
      ...captured.commitMarker,
      packageSha256: await sha256Bytes(invalidBytes),
    };
    const invalid = await database('invalid-yjs');
    await stagedTarget(invalid);
    await expect(
      restoreSnapshotV1({
        db: invalid,
        attemptId: 'restore-invalid-yjs',
        stagingRef: createLocalObjectRef('syncobj:test.restore-invalid-yjs'),
        expected: { projectId: PROJECT_ID, projectSyncId: PROJECT_SYNC_ID, syncGenerationId: SYNC_GENERATION_ID },
        localUserId: 'local',
        writerIdentity: restoredWriterIdentity('invalid-yjs'),
        packageBytes: invalidBytes,
        commitMarkerBytes: encodeSnapshotCommitMarkerV1(invalidMarker),
        blobSources: new Map([['blob-keyed-asset-1', ASSET_REF]]),
        assetPort: restorePort(),
      }),
    ).rejects.toBeInstanceOf(SnapshotRestoreError);
    expect(await invalid.select().from(ProjectTable)).toEqual([]);
  });
});
