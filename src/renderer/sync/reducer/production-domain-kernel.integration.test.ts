import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { ProductFileBackedSqliteGateway } from '../../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import { createYjsProseSeedState } from '../../lib/agent/runtime/yjs-prose-command';
import type { DbClient } from '../../lib/db';
import {
  BookElementTable,
  BookNodeTable,
  CommentActionTable,
  CommentTable,
  EntityRelationTable,
  EntityRelationTypeEndpointKindTable,
  NodeContentTable,
  NodeStorylineLinkTable,
  ProjectAssetTable,
  ProjectTable,
  StorylineTable,
  SyncApplyReceiptTable,
  SyncBlobStateTable,
  SyncChangeSetTable,
  SyncConflictTable,
  SyncEntityLifecycleTable,
  SyncGenerationPurgeTable,
  SyncGenerationTable,
  YjsDocumentRevisionProvenanceTable,
  yjsUpdates,
} from '../../schema/drizzle';
import type { SyncWriterIdentitySource } from '../journal';
import {
  captureReducerStateV1,
  materializeReducerStateV1,
} from '../checkpoint/reducer-state';
import {
  createSyncMutationV1,
  type CanonicalCborValue,
  type SyncChangeSetV1,
  type SyncMutationAction,
  type SyncMutationTargetFamily,
} from '../protocol';
import {
  applyVerifiedRemoteChangeSetInTransaction,
  invalidateSqliteReducerStateCache,
  SQLITE_REDUCER_V1_TARGET_KINDS,
} from './sqlite-materializer';
import { canonicalReducerSnapshot } from './reducer';
import {
  PRODUCTION_DOMAIN_KERNEL_COVERAGE,
  productionSyncDomainMaterializationKernel,
} from './production-domain-kernel';

const PROJECT_ID = 'project-production-kernel';
const SYNC_GENERATION_ID = 'sync-generation-production-kernel';
const PROJECT_SYNC_ID = 'projectSync-production-kernel';
const NODE_ID = 'node-production-kernel';
const NOW = '2026-08-15T00:00:00.000Z';
const temporaryDirectories: string[] = [];
const gateways: ProductFileBackedSqliteGateway[] = [];

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

async function createDatabase(): Promise<DbClient> {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-production-domain-kernel-'));
  temporaryDirectories.push(directory);
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'drifting.db'));
  gateways.push(gateway);
  const db = gateway.client();
  await db.insert(ProjectTable).values({
    id: PROJECT_ID,
    userId: 'local-user',
    name: 'Production kernel',
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
  return db;
}

function identity(): SyncWriterIdentitySource {
  return {
    installationId: 'production-kernel-installation',
    createWriterIdentity: () => ({ writerId: 'production-kernel-local', writerEpoch: 'epoch-local' }),
  };
}

async function changeSet(
  sequence: number,
  mutations: readonly {
    action: SyncMutationAction;
    kind: string;
    id: string;
    payload: CanonicalCborValue;
    family?: SyncMutationTargetFamily;
    incarnation?: number;
  }[],
  writer: { writerId: string; writerEpoch?: string; wallMs?: number } = {
    writerId: 'production-kernel-remote',
  },
): Promise<SyncChangeSetV1> {
  const writerId = writer.writerId;
  const writerEpoch = writer.writerEpoch ?? 'epoch-remote';
  return {
    protocol: 'drifting.sync.changeset',
    protocolVersion: 1,
    payloadVersion: 1,
    projectId: PROJECT_ID,
    projectSyncId: PROJECT_SYNC_ID,
    syncGenerationId: SYNC_GENERATION_ID,
    changeSetId: `${writerId}:${writerEpoch}:${sequence}`,
    writerId,
    writerEpoch,
    deviceSeq: sequence,
    hlc: { wallMs: writer.wallMs ?? 1_700_000_000_000 + sequence, counter: 0 },
    mutations: await Promise.all(mutations.map((mutation, index) => createSyncMutationV1({
      index,
      target: {
        family: mutation.family ?? FAMILY[mutation.action],
        kind: mutation.kind,
        id: mutation.id,
        incarnation: mutation.incarnation ?? 0,
      },
      action: mutation.action,
      payloadVersion: 1,
      payload: mutation.payload,
    }))),
  };
}

async function apply(db: DbClient, value: SyncChangeSetV1) {
  return db.transaction((tx) => applyVerifiedRemoteChangeSetInTransaction(tx, {
    changeSet: value,
    identity: identity(),
    clock: { nowMs: 1_700_000_000_100, nowIso: NOW },
    kernel: productionSyncDomainMaterializationKernel,
  }));
}

afterEach(async () => {
  invalidateSqliteReducerStateCache();
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('production SyncDomainMaterializationKernel on file-backed SQLite', () => {
  it('classifies every frozen reducer target as implemented or explicitly fail-closed', () => {
    const classified = new Set([
      ...PRODUCTION_DOMAIN_KERNEL_COVERAGE.entityKinds,
      ...PRODUCTION_DOMAIN_KERNEL_COVERAGE.setKinds,
      ...PRODUCTION_DOMAIN_KERNEL_COVERAGE.orderKinds,
      'prose-document',
      'project-asset',
      'sync-generation',
    ]);
    expect([...SQLITE_REDUCER_V1_TARGET_KINDS].filter((kind) => !classified.has(kind))).toEqual([]);
    expect(PRODUCTION_DOMAIN_KERNEL_COVERAGE.externalActions).toEqual([
      'yjs.update', 'asset.bind', 'asset.unbind', 'sync-generation.purge',
    ]);
  });

  it('replays a locked built-in relation type before applying the next chapter creation bundle', async () => {
    const db = await createDatabase();
    const builtInRelationTypeId = `system:generic-association:${PROJECT_ID}`;
    await apply(db, await changeSet(1, [{
      action: 'entity.create',
      kind: 'entity-relation-type',
      id: builtInRelationTypeId,
      payload: {
        seed: {
          name: 'Generic association',
          normalizedName: 'generic association',
          description: 'Built-in association for TODO and library item links.',
          orientation: 'directed',
          systemKey: 'generic-association',
          locked: true,
          sourceRole: 'Source',
          targetRole: 'Target',
          sourceKinds: ['comment', 'library_item'],
          targetKinds: ['node', 'element', 'patch', 'category', 'storyline'],
        },
      },
    }]));

    const chapterId = 'chapter-created-on-desktop';
    const remote = await changeSet(2, [
      {
        action: 'entity.create',
        kind: 'node',
        id: chapterId,
        payload: {
          seed: {
            kind: 'chapter',
            title: 'New Chapter',
            summary: '',
            driftGroupId: null,
            writingStatus: 'draft',
            narrativeOrder: null,
          },
        },
      },
      {
        action: 'yjs.update',
        kind: 'prose-document',
        id: `node-content:${chapterId}`,
        payload: { update: new Uint8Array([0, 0]) },
      },
      {
        action: 'field.set',
        kind: 'node-storyline-primary',
        id: chapterId,
        payload: { field: 'storylineId', value: null },
      },
      {
        action: 'order.move',
        kind: 'chapter',
        id: chapterId,
        payload: { scope: PROJECT_ID, positionKey: 'a0' },
      },
    ]);

    await apply(db, remote);

    expect(await db.select({ id: BookNodeTable.id, title: BookNodeTable.title })
      .from(BookNodeTable)
      .where(eq(BookNodeTable.id, chapterId))).toEqual([
      { id: chapterId, title: 'New Chapter' },
    ]);
    expect(await db.select({ nodeId: NodeContentTable.nodeId })
      .from(NodeContentTable)
      .where(eq(NodeContentTable.nodeId, chapterId))).toEqual([
      { nodeId: chapterId },
    ]);
    expect(await db.select().from(SyncApplyReceiptTable)).toHaveLength(2);
    expect(await db.select({
      side: EntityRelationTypeEndpointKindTable.side,
      entityKind: EntityRelationTypeEndpointKindTable.entityKind,
    }).from(EntityRelationTypeEndpointKindTable)
      .where(eq(EntityRelationTypeEndpointKindTable.relationTypeId, builtInRelationTypeId)))
      .toHaveLength(7);
  });

  it('materializes a classified field and records no authored echo', async () => {
    const db = await createDatabase();
    const remote = await changeSet(1, [{
      action: 'field.set',
      kind: 'node',
      id: NODE_ID,
      payload: { field: 'title', value: 'Remote title' },
    }]);
    await apply(db, remote);
    expect(await db.select({ title: BookNodeTable.title }).from(BookNodeTable)).toEqual([
      { title: 'Remote title' },
    ]);
    expect(await db.select().from(SyncApplyReceiptTable)).toHaveLength(1);
    expect((await db.select().from(SyncChangeSetTable)).filter(({ origin }) => origin === 'local')).toEqual([]);
  });

  it('keeps invalid effects as deterministic conflicts without touching domain rows', async () => {
    const db = await createDatabase();
    const remote = await changeSet(1, [{
      action: 'field.set',
      kind: 'node',
      id: NODE_ID,
      payload: { field: 'futureField', value: 'must not leak' },
    }]);
    const result = await apply(db, remote);
    expect(result.effects).toMatchObject([{ type: 'field.set', materialize: false }]);
    expect(await db.select({ title: BookNodeTable.title }).from(BookNodeTable)).toEqual([
      { title: 'Before' },
    ]);
    expect(await db.select().from(SyncConflictTable)).toMatchObject([
      { kind: 'semantic', targetKind: 'node', targetId: NODE_ID, state: 'open' },
    ]);
  });

  it('validates relation invariants before a lifecycle seed reaches SQLite', async () => {
    const db = await createDatabase();
    const remote = await changeSet(1, [{
      action: 'entity.create',
      kind: 'entity-relation',
      id: 'self-relation',
      payload: {
        seed: {
          fromKind: 'node',
          fromId: NODE_ID,
          toKind: 'node',
          toId: NODE_ID,
          relationTypeId: 'missing-type',
        },
      },
    }]);
    const result = await apply(db, remote);
    expect(result.effects.find((effect) => effect.type === 'entity.lifecycle')).toMatchObject({
      materialize: false,
    });
    expect(await db.select().from(EntityRelationTable)).toEqual([]);
    expect(await db.select().from(SyncConflictTable)).toHaveLength(1);
  });

  it('materializes membership OR-set state before the independent primary LWW register', async () => {
    const db = await createDatabase();
    const storylineState = await createYjsProseSeedState('{"type":"doc","content":[]}');
    const remote = await changeSet(1, [
      {
        action: 'entity.create',
        kind: 'storyline',
        id: 'storyline-remote',
        payload: { seed: { name: 'Remote storyline', color: '#123456' } },
      },
      {
        action: 'yjs.update',
        kind: 'prose-document',
        id: 'storyline:storyline-remote',
        payload: { update: storylineState },
      },
      {
        action: 'set.add',
        kind: 'membership',
        id: 'storyline-remote',
        payload: { memberId: NODE_ID, value: null },
      },
      {
        action: 'field.set',
        kind: 'node-storyline-primary',
        id: NODE_ID,
        payload: { field: 'storylineId', value: 'storyline-remote' },
      },
    ]);
    await apply(db, remote);
    expect(await db.select().from(NodeStorylineLinkTable)).toMatchObject([{
      nodeId: NODE_ID,
      storylineId: 'storyline-remote',
      isPrimary: true,
    }]);

    const removed = await changeSet(2, [
      {
        action: 'set.remove',
        kind: 'membership',
        id: 'storyline-remote',
        payload: { memberId: NODE_ID, observedAddTags: [`${remote.changeSetId}#2`] },
      },
      {
        action: 'field.set',
        kind: 'node-storyline-primary',
        id: NODE_ID,
        payload: { field: 'storylineId', value: null },
      },
    ]);
    await apply(db, removed);
    expect(await db.select().from(NodeStorylineLinkTable)).toEqual([]);
  });

  it('blocks a primary register that does not reference a present membership', async () => {
    const db = await createDatabase();
    await db.insert(StorylineTable).values({
      id: 'unlinked-storyline',
      projectId: PROJECT_ID,
      name: 'Unlinked',
      color: '#654321',
      orderKey: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const remote = await changeSet(1, [{
      action: 'field.set',
      kind: 'node-storyline-primary',
      id: NODE_ID,
      payload: { field: 'storylineId', value: 'unlinked-storyline' },
    }]);
    const result = await apply(db, remote);
    expect(result.effects).toMatchObject([{ type: 'field.set', materialize: false }]);
    expect(await db.select().from(NodeStorylineLinkTable)).toEqual([]);
    expect(await db.select().from(SyncConflictTable)).toMatchObject([{
      targetKind: 'node-storyline-primary',
      targetId: NODE_ID,
      state: 'open',
    }]);
  });

  it('materializes trash and full-seed restore as a new incarnation', async () => {
    const db = await createDatabase();
    const elementId = 'restorable-element';
    const createdState = await createYjsProseSeedState('{"type":"doc","content":[]}');
    const restoredState = await createYjsProseSeedState('{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"restored"}]}]}');
    const created = await changeSet(1, [
      {
        action: 'entity.create', kind: 'element', id: elementId,
        payload: { seed: { name: 'Before restore', summary: '', categoryId: null, groupName: null } },
      },
      {
        action: 'yjs.update', kind: 'prose-document', id: `element:${elementId}`,
        payload: { update: createdState },
      },
    ]);
    const trashed = await changeSet(2, [{
      action: 'entity.trash', kind: 'element', id: elementId, payload: {},
    }]);
    const restored = await changeSet(3, [
      {
        action: 'entity.restore', kind: 'element', id: elementId, incarnation: 1,
        payload: { seed: { name: 'Restored seed', summary: 'new incarnation', categoryId: null, groupName: null } },
      },
      {
        action: 'yjs.update', kind: 'prose-document', id: `element:${elementId}`, incarnation: 1,
        payload: { update: restoredState },
      },
    ]);
    await apply(db, created);
    await apply(db, trashed);
    expect(await db.select({ deletedAt: BookElementTable.deletedAt }).from(BookElementTable).where(eq(BookElementTable.id, elementId))).toMatchObject([{ deletedAt: expect.any(String) }]);
    await apply(db, restored);
    expect(await db.select({ name: BookElementTable.name, summary: BookElementTable.summary, deletedAt: BookElementTable.deletedAt }).from(BookElementTable).where(eq(BookElementTable.id, elementId))).toEqual([{ name: 'Restored seed', summary: 'new incarnation', deletedAt: null }]);
  });

  it('fails closed on scalar prose and prose lifecycles without one full Yjs state', async () => {
    const db = await createDatabase();
    const scalar = await apply(db, await changeSet(1, [{
      action: 'field.set',
      kind: 'node-content',
      id: NODE_ID,
      payload: { field: 'contentJson', value: '{"type":"doc","content":[]}' },
    }]));
    expect(scalar.effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'field.set', materialize: false }),
    ]));
    expect(scalar.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'domain.unsupported-field' }),
    ]));

    const missingState = await apply(db, await changeSet(2, [
      {
        action: 'entity.create',
        kind: 'storyline',
        id: 'storyline-without-yjs',
        payload: { seed: { name: 'Missing body', color: '#123456', summary: '' } },
      },
      {
        action: 'field.set',
        kind: 'storyline',
        id: 'storyline-without-yjs',
        payload: { field: 'summary', value: 'must not partially materialize' },
      },
    ]));
    expect(missingState.effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'entity.lifecycle', materialize: false }),
      expect.objectContaining({ type: 'field.set', materialize: false }),
    ]));
    expect(missingState.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'yjs.lifecycle-state-count' }),
    ]));
    expect(await db.select().from(StorylineTable).where(
      eq(StorylineTable.id, 'storyline-without-yjs'),
    )).toEqual([]);
  });

  it('restores rows without deletedAt from physical trash projections at incarnation one', async () => {
    const db = await createDatabase();
    const commentId = 'restorable-comment';
    const actionId = 'restorable-comment-action';
    const commentSeed = {
      kind: 'todo',
      targetKind: 'node',
      targetId: NODE_ID,
      targetBlockId: null,
      anchorJson: '{}',
      authorKind: 'user',
      authorId: null,
      authorName: null,
      bodyJson: '{"type":"doc","content":[]}',
      status: 'open',
      priority: null,
      source: 'manual',
      metadataJson: null,
      targetBlockIdsJson: '[]',
      resolvedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    } as const;
    const actionSeed = {
      commentId,
      kind: 'accept_suggestion',
      label: 'kept with restore',
      payloadJson: '{}',
      status: 'applied',
      resultJson: '{"ok":true}',
      createdByKind: 'user',
      createdById: null,
      appliedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    } as const;

    await apply(db, await changeSet(1, [
      {
        action: 'entity.create',
        kind: 'comment',
        id: commentId,
        payload: { seed: commentSeed },
      },
      {
        action: 'entity.create',
        kind: 'comment-action',
        id: actionId,
        payload: { seed: actionSeed },
      },
    ]));
    await apply(db, await changeSet(2, [
      { action: 'entity.trash', kind: 'comment-action', id: actionId, payload: {} },
      { action: 'entity.trash', kind: 'comment', id: commentId, payload: {} },
    ]));
    expect(await db.select().from(CommentTable).where(eq(CommentTable.id, commentId))).toEqual([]);
    expect(await db.select().from(CommentActionTable).where(eq(CommentActionTable.id, actionId)))
      .toEqual([]);
    expect(await db.select({
      kind: SyncEntityLifecycleTable.entityKind,
      incarnation: SyncEntityLifecycleTable.incarnation,
      state: SyncEntityLifecycleTable.state,
    }).from(SyncEntityLifecycleTable)).toEqual(expect.arrayContaining([
      { kind: 'comment', incarnation: 0, state: 'trashed' },
      { kind: 'comment-action', incarnation: 0, state: 'trashed' },
    ]));

    const restoredBody = '{"type":"doc","content":[{"type":"paragraph"}]}';
    await apply(db, await changeSet(3, [
      {
        action: 'entity.restore',
        kind: 'comment',
        id: commentId,
        incarnation: 1,
        payload: { seed: { ...commentSeed, bodyJson: restoredBody } },
      },
      {
        action: 'entity.restore',
        kind: 'comment-action',
        id: actionId,
        incarnation: 1,
        payload: { seed: actionSeed },
      },
    ]));
    expect(await db.select({ bodyJson: CommentTable.bodyJson }).from(CommentTable).where(eq(CommentTable.id, commentId))).toEqual([
      { bodyJson: restoredBody },
    ]);
    expect(await db.select({ label: CommentActionTable.label }).from(CommentActionTable).where(eq(CommentActionTable.id, actionId))).toEqual([
      { label: 'kept with restore' },
    ]);
    expect(await db.select({
      kind: SyncEntityLifecycleTable.entityKind,
      incarnation: SyncEntityLifecycleTable.incarnation,
      state: SyncEntityLifecycleTable.state,
    }).from(SyncEntityLifecycleTable)).toEqual(expect.arrayContaining([
      { kind: 'comment', incarnation: 1, state: 'live' },
      { kind: 'comment-action', incarnation: 1, state: 'live' },
    ]));
  });

  it('keeps restored Yjs and asset ownership when late incarnation-zero operations arrive', async () => {
    const db = await createDatabase();
    const elementId = 'restored-external-owner';
    const assetId = 'restored-external-asset';
    const digest = 'c'.repeat(64);
    await db.insert(BookElementTable).values({
      id: elementId,
      projectId: PROJECT_ID,
      name: 'External owner',
      contentJson: '{}',
      createdAt: NOW,
      updatedAt: NOW,
    });
    await db.insert(SyncBlobStateTable).values({
      syncGenerationId: SYNC_GENERATION_ID,
      blobId: `sha256:${digest}`,
      logicalKeyId: 'restored-external-blob',
      contentSha256: digest,
      sizeBytes: 4,
      mime: 'image/png',
      localState: 'verified',
      remoteState: 'available',
      verifiedAt: NOW,
      updatedAt: NOW,
    });
    const assetPayload = {
      blobId: `sha256:${digest}`,
      sourceSha256: `sha256:${digest}`,
      sourceMime: 'image/png',
      sourceSizeBytes: 4,
      kind: 'image',
      width: 1,
      height: 1,
      createdAt: NOW,
      owner: { kind: 'element-portrait', id: elementId },
    } as const;
    const initialDocument = new Y.Doc();
    initialDocument.getText('content').insert(0, 'incarnation zero');
    const restoredDocument = new Y.Doc();
    restoredDocument.getText('content').insert(0, 'incarnation one');
    const lateDocument = new Y.Doc();
    lateDocument.getText('content').insert(0, 'late stale prose');

    await apply(db, await changeSet(1, [
      {
        action: 'entity.create', kind: 'element', id: elementId,
        payload: {
          seed: {
            name: 'External owner',
            summary: '',
            categoryId: null,
            groupName: null,
          },
        },
      },
      {
        action: 'yjs.update', kind: 'prose-document', id: `element:${elementId}`,
        payload: { update: Y.encodeStateAsUpdate(initialDocument) },
      },
    ]));
    await apply(db, await changeSet(2, [
      {
        action: 'asset.bind', kind: 'project-asset', id: assetId,
        payload: assetPayload,
      },
    ]));
    await apply(db, await changeSet(3, [{
      action: 'entity.trash', kind: 'element', id: elementId, payload: {},
    }]));
    await apply(db, await changeSet(4, [
      {
        action: 'entity.restore', kind: 'element', id: elementId, incarnation: 1,
        payload: {
          seed: {
            name: 'Restored external owner',
            summary: 'new generation',
            categoryId: null,
            groupName: null,
          },
        },
      },
      {
        action: 'yjs.update', kind: 'prose-document', id: `element:${elementId}`,
        incarnation: 1,
        payload: { update: Y.encodeStateAsUpdate(restoredDocument) },
      },
      {
        action: 'asset.bind', kind: 'project-asset', id: assetId,
        incarnation: 1,
        payload: assetPayload,
      },
    ]));
    const late = await apply(db, await changeSet(5, [
      {
        action: 'yjs.update', kind: 'prose-document', id: `element:${elementId}`,
        incarnation: 0,
        payload: { update: Y.encodeStateAsUpdate(lateDocument) },
      },
      {
        action: 'asset.unbind', kind: 'project-asset', id: assetId,
        incarnation: 0,
        payload: { owner: { kind: 'element-portrait', id: elementId } },
      },
    ]));

    expect(late.effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'yjs.update', materialize: false }),
      expect.objectContaining({ type: 'asset.unbind', materialize: false }),
      expect.objectContaining({ type: 'asset.bind', materialize: true }),
    ]));
    expect(await db.select().from(yjsUpdates)).toHaveLength(2);
    expect(await db.select({
      name: BookElementTable.name,
      portraitAssetId: BookElementTable.portraitAssetId,
      deletedAt: BookElementTable.deletedAt,
    }).from(BookElementTable).where(eq(BookElementTable.id, elementId))).toEqual([{
      name: 'Restored external owner',
      portraitAssetId: assetId,
      deletedAt: null,
    }]);
    expect(await db.select().from(ProjectAssetTable).where(eq(ProjectAssetTable.id, assetId)))
      .toHaveLength(1);
  });

  it('applies a valid Yjs update with remote provenance inside the receipt transaction', async () => {
    const db = await createDatabase();
    const update = await createYjsProseSeedState(JSON.stringify({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: 'remote prose' }],
      }],
    }));
    const remote = await changeSet(1, [{
      action: 'yjs.update',
      kind: 'prose-document',
      id: `node-content:${NODE_ID}`,
      payload: { update },
    }]);
    await apply(db, remote);
    expect(await db.select().from(yjsUpdates)).toMatchObject([
      { docId: `node-content:${NODE_ID}` },
    ]);
    expect(await db.select().from(YjsDocumentRevisionProvenanceTable)).toMatchObject([
      { docId: `node-content:${NODE_ID}`, sourceKind: 'remote', revision: 1 },
    ]);
    expect(await db.select({ contentJson: NodeContentTable.contentJson })
      .from(NodeContentTable)
      .where(eq(NodeContentTable.nodeId, NODE_ID))).toMatchObject([
      { contentJson: expect.stringContaining('remote prose') },
    ]);
  });

  it('binds an asset only after verified blob staging and enforces one typed owner', async () => {
    const db = await createDatabase();
    const elementId = 'element-owner';
    await db.insert(BookElementTable).values({
      id: elementId,
      projectId: PROJECT_ID,
      name: 'Portrait owner',
      createdAt: NOW,
      updatedAt: NOW,
    });
    const digest = 'a'.repeat(64);
    await db.insert(SyncBlobStateTable).values({
      syncGenerationId: SYNC_GENERATION_ID,
      blobId: `sha256:${digest}`,
      logicalKeyId: 'blob-logical-key',
      contentSha256: digest,
      sizeBytes: 4,
      mime: 'image/png',
      localState: 'verified',
      remoteState: 'available',
      verifiedAt: NOW,
      updatedAt: NOW,
    });
    const remote = await changeSet(1, [{
      action: 'asset.bind',
      kind: 'project-asset',
      id: 'asset-1',
      payload: {
        blobId: `sha256:${digest}`,
        sourceSha256: `sha256:${digest}`,
        sourceMime: 'image/png',
        sourceSizeBytes: 4,
        kind: 'image',
        width: 1,
        height: 1,
        createdAt: NOW,
        owner: { kind: 'element-portrait', id: elementId },
      },
    }]);
    await apply(db, remote);
    expect(await db.select().from(ProjectAssetTable)).toMatchObject([
      { id: 'asset-1', sourceSha256: digest, projectId: PROJECT_ID },
    ]);
    expect(await db.select({ portraitAssetId: BookElementTable.portraitAssetId }).from(BookElementTable).where(eq(BookElementTable.id, elementId))).toEqual([
      { portraitAssetId: 'asset-1' },
    ]);
  });

  it('converges asset bind/unbind when the older bind arrives after the winner', async () => {
    const forward = await createDatabase();
    const reverse = await createDatabase();
    const digest = 'b'.repeat(64);
    for (const db of [forward, reverse]) {
      await db.insert(BookElementTable).values({
        id: 'asset-owner',
        projectId: PROJECT_ID,
        name: 'Asset owner',
        createdAt: NOW,
        updatedAt: NOW,
      });
      await db.insert(SyncBlobStateTable).values({
        syncGenerationId: SYNC_GENERATION_ID,
        blobId: `sha256:${digest}`,
        logicalKeyId: 'asset-convergence-key',
        contentSha256: digest,
        sizeBytes: 4,
        mime: 'image/png',
        localState: 'verified',
        remoteState: 'available',
        verifiedAt: NOW,
        updatedAt: NOW,
      });
    }
    const bind = await changeSet(1, [{
      action: 'asset.bind', kind: 'project-asset', id: 'asset-convergent',
      payload: {
        blobId: `sha256:${digest}`,
        sourceSha256: `sha256:${digest}`,
        sourceMime: 'image/png',
        sourceSizeBytes: 4,
        kind: 'image',
        width: 1,
        height: 1,
        createdAt: NOW,
        owner: { kind: 'element-portrait', id: 'asset-owner' },
      },
    }]);
    const unbind = await changeSet(2, [{
      action: 'asset.unbind', kind: 'project-asset', id: 'asset-convergent',
      payload: { owner: { kind: 'element-portrait', id: 'asset-owner' } },
    }]);
    await apply(forward, bind);
    await apply(forward, unbind);
    await apply(reverse, unbind);
    await apply(reverse, bind);
    expect(await forward.select().from(ProjectAssetTable)).toEqual([]);
    expect(await reverse.select().from(ProjectAssetTable)).toEqual([]);
    expect(await forward.select({ portraitAssetId: BookElementTable.portraitAssetId }).from(BookElementTable).where(eq(BookElementTable.id, 'asset-owner'))).toEqual([{ portraitAssetId: null }]);
    expect(await reverse.select({ portraitAssetId: BookElementTable.portraitAssetId }).from(BookElementTable).where(eq(BookElementTable.id, 'asset-owner'))).toEqual([{ portraitAssetId: null }]);
  });

  it('materializes sync-generation.purge without deleting the immutable sync receipt', async () => {
    const db = await createDatabase();
    const remote = await changeSet(1, [{
      action: 'sync-generation.purge',
      kind: 'sync-generation',
      id: SYNC_GENERATION_ID,
      family: 'sync-generation',
      incarnation: 1,
      payload: {},
    }]);
    await apply(db, remote);
    expect(await db.select().from(ProjectTable)).toEqual([]);
    expect(await db.select().from(SyncGenerationTable)).toMatchObject([
      { syncGenerationId: SYNC_GENERATION_ID, projectId: null, status: 'purged' },
    ]);
    expect(await db.select().from(SyncGenerationPurgeTable)).toMatchObject([
      { syncGenerationId: SYNC_GENERATION_ID, changeSetId: remote.changeSetId, mutationIndex: 0 },
    ]);
    expect(await db.select().from(SyncApplyReceiptTable)).toHaveLength(1);
  });

  it('keeps sync-generation.purge absorbing across two-writer reorder, duplicate, and restart replay', async () => {
    const forward = await createDatabase();
    const reverse = await createDatabase();
    const seed = await changeSet(1, [{
      action: 'entity.create',
      kind: 'project',
      id: PROJECT_ID,
      payload: { seed: { name: 'Canonical project', summary: '' } },
    }], { writerId: 'writer-seed', wallMs: 1_700_000_000_001 });
    const purge = await changeSet(1, [{
      action: 'sync-generation.purge',
      kind: 'sync-generation',
      id: SYNC_GENERATION_ID,
      family: 'sync-generation',
      incarnation: 1,
      payload: {},
    }], { writerId: 'writer-purge', wallMs: 1_700_000_000_002 });
    const concurrent = await changeSet(1, [{
      action: 'field.set',
      kind: 'project',
      id: PROJECT_ID,
      payload: { field: 'name', value: 'Must never resurrect' },
    }], { writerId: 'writer-update', wallMs: 1_700_000_000_003 });

    await apply(forward, seed);
    await apply(reverse, seed);
    const forwardPurge = await apply(forward, purge);
    const forwardFinal = await apply(forward, concurrent);
    await apply(reverse, concurrent);
    const reverseFinal = await apply(reverse, purge);

    expect(await forward.select().from(ProjectTable)).toEqual([]);
    expect(await reverse.select().from(ProjectTable)).toEqual([]);
    expect(forwardFinal.effects.every((effect) => !effect.materialize)).toBe(true);
    expect(canonicalReducerSnapshot(forwardFinal.state!)).toEqual(
      canonicalReducerSnapshot(reverseFinal.state!),
    );
    expect(await forward.select().from(SyncApplyReceiptTable)).toHaveLength(3);
    expect(await reverse.select().from(SyncApplyReceiptTable)).toHaveLength(3);
    expect(forwardPurge.effects.filter((effect) => effect.materialize)).toMatchObject([
      { type: 'sync-generation.purge' },
    ]);

    invalidateSqliteReducerStateCache(SYNC_GENERATION_ID);
    const duplicate = await apply(forward, concurrent);
    expect(duplicate.status).toBe('duplicate');
    expect(await forward.select().from(ProjectTable)).toEqual([]);
    expect(await forward.select().from(SyncGenerationPurgeTable)).toHaveLength(1);
  });

  it('preserves the terminal purge register through checkpoint reducer-state restore', async () => {
    const source = await createDatabase();
    const seed = await changeSet(1, [{
      action: 'entity.create',
      kind: 'project',
      id: PROJECT_ID,
      payload: { seed: { name: 'Checkpoint seed' } },
    }], { writerId: 'writer-checkpoint-seed' });
    const purge = await changeSet(1, [{
      action: 'sync-generation.purge',
      kind: 'sync-generation',
      id: SYNC_GENERATION_ID,
      family: 'sync-generation',
      incarnation: 1,
      payload: {},
    }], { writerId: 'writer-checkpoint-purge' });
    await apply(source, seed);
    await apply(source, purge);
    const reducerState = await captureReducerStateV1(source, SYNC_GENERATION_ID);
    expect(reducerState.generationPurges).toHaveLength(1);

    const restored = await createDatabase();
    await restored.delete(ProjectTable).where(eq(ProjectTable.id, PROJECT_ID));
    await restored.transaction((tx) => materializeReducerStateV1(tx, reducerState));
    expect(await restored.select().from(SyncGenerationPurgeTable)).toHaveLength(1);

    invalidateSqliteReducerStateCache(SYNC_GENERATION_ID);
    const late = await changeSet(1, [{
      action: 'field.set',
      kind: 'project',
      id: PROJECT_ID,
      payload: { field: 'name', value: 'Cannot restore purged project' },
    }], { writerId: 'writer-checkpoint-late' });
    const result = await apply(restored, late);
    expect(result.effects.every((effect) => !effect.materialize)).toBe(true);
    expect(await restored.select().from(ProjectTable)).toEqual([]);
    expect(await restored.select().from(SyncApplyReceiptTable)).toHaveLength(3);
  });
});
