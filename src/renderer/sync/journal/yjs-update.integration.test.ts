import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { ProductFileBackedSqliteGateway } from '../../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import type { DbClient } from '../../lib/db';
import { createYjsRepository } from '../../sqlite-repo/yjs-repo';
import {
  BookElementTable,
  BookNodeTable,
  NodeContentTable,
  ProjectTable,
  SyncApplyReceiptTable,
  SyncChangeSetTable,
  SyncMutationTable,
  YjsDocumentRevisionProvenanceTable,
  YjsDocumentRevisionTable,
  yjsUpdates,
} from '../../schema/drizzle';
import { createYjsProseSeedState } from '../../lib/agent/runtime/yjs-prose-command';
import { decodeCanonicalCbor, decodeSyncChangeSetV1, encodeCanonicalCbor } from '../protocol';
import { captureYjsTransactionEvidence } from '../../services/yjs-transaction-evidence';
import type { YjsSourceRetentionProvenanceV1 } from '../protocol/yjs-update-payload';
import { createAuthoredTransactionRunner } from './authored-transaction';
import { appendAuthoredDomainMutation } from './domain-mutation';
import type { SyncWriterIdentitySource } from './writer-state';
import {
  appendAuthoredProseSeedInTransaction,
  appendAuthoredProseRestoreStateInTransaction,
  createAuthoredYjsUpdateWriter,
} from './yjs-update';

const PROJECT_ID = 'project-yjs-journal';
const DOC_ID = 'node-content:node-yjs-journal';
const NOW = '2026-08-15T08:00:00.000Z';
const temporaryDirectories: string[] = [];
const gateways: ProductFileBackedSqliteGateway[] = [];

async function createDatabase(): Promise<DbClient> {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-yjs-journal-'));
  temporaryDirectories.push(directory);
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'drifting.db'));
  gateways.push(gateway);
  const database = gateway.client();
  await database.insert(ProjectTable).values({
    id: PROJECT_ID,
    userId: 'local-user',
    name: 'Yjs journal project',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await database.insert(BookNodeTable).values({
    id: 'node-yjs-journal',
    projectId: PROJECT_ID,
    title: 'Yjs journal node',
    summary: '',
    kind: 'chapter',
    writingStatus: 'draft',
    positionX: 0,
    positionY: 0,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await database.insert(NodeContentTable).values({
    nodeId: 'node-yjs-journal',
    contentJson: '{}',
    createdAt: NOW,
    updatedAt: NOW,
  });
  return database;
}

function identity(): SyncWriterIdentitySource {
  return {
    installationId: 'installation-yjs-journal',
    createWriterIdentity: () => ({
      writerId: 'writer-yjs-journal',
      writerEpoch: 'epoch-yjs-journal',
    }),
  };
}

function updateWithText(value: string): Uint8Array {
  const document = new Y.Doc();
  document.getText('body').insert(0, value);
  const update = Y.encodeStateAsUpdate(document);
  document.destroy();
  return update;
}

function runnerFor(database: DbClient) {
  return createAuthoredTransactionRunner({
    database: () => database,
    identity: async () => identity(),
    clock: () => ({ nowMs: Date.parse(NOW), nowIso: NOW }),
    syncGenerationIds: {
      createSyncGenerationId: () => 'sync-generation-yjs-journal',
      createProjectSyncId: () => 'projectSync-yjs-journal',
    },
  });
}

function writerFor(database: DbClient) {
  return createAuthoredYjsUpdateWriter(runnerFor(database));
}

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('authored Yjs journal', () => {
  it('persists actual transaction evidence with identical update and immutable envelope bytes', async () => {
    const database = await createDatabase();
    const doc = new Y.Doc();
    doc.clientID = 741;
    doc.getText('body').insert(0, '保潮航');
    const base = Y.encodeStateAsUpdate(doc);
    await writerFor(database)(PROJECT_ID, DOC_ID, base);
    const expectedBefore = Y.encodeSnapshot(Y.snapshot(doc));
    const capture = captureYjsTransactionEvidence(doc, () => true);
    doc.transact(() => doc.getText('body').delete(1, 1), 'explicit-test-operation');
    const [event] = capture.drain();
    expect(event?.status).toBe('captured');
    if (!event || event.status !== 'captured') throw new Error('Missing transaction evidence');
    const result = await writerFor(database)(PROJECT_ID, DOC_ID, event.payload.update,
      { kind: 'user' }, event.payload.sourceRetentionProvenance);
    const [row] = await database.select().from(yjsUpdates).where(eq(yjsUpdates.id, result.updateId));
    expect(new Uint8Array(row!.updateBlob as Uint8Array)).toEqual(event.payload.update);
    const mutations = await database.select().from(SyncMutationTable);
    const recorded = mutations.find(mutation => mutation.changeSetId.endsWith(':2'));
    expect(recorded).toBeDefined();
    expect(new Uint8Array(recorded!.payloadCbor as Uint8Array)).toEqual(encodeCanonicalCbor({
      update: event.payload.update,
      sourceRetentionProvenance: {
        version: 1, kind: 'transaction-event',
        beforeSnapshot: expectedBefore,
        transactionDeletes: [{ client: 741, clock: 1, length: 1 }],
      },
    }));
    const [envelope] = await database.select().from(SyncChangeSetTable)
      .where(eq(SyncChangeSetTable.changeSetId, recorded!.changeSetId));
    const decoded = await decodeSyncChangeSetV1(envelope!.encodedBytes as Uint8Array);
    if (!decoded.ok) throw new Error(decoded.message);
    expect(encodeCanonicalCbor(decoded.value.mutations[0]!.payload)).toEqual(new Uint8Array(recorded!.payloadCbor as Uint8Array));
    const replay = new Y.Doc();
    Y.applyUpdate(replay, base); Y.applyUpdate(replay, event.payload.update);
    expect(replay.getText('body').toString()).toBe('保航');
    expect(await createYjsRepository(database).getRevision(DOC_ID)).toBe(2);
    capture.dispose(); doc.destroy(); replay.destroy();
  });

  it('copies update and evidence before waiting for the SQLite transaction scheduler', async () => {
    const database = await createDatabase();
    const doc = new Y.Doc();
    doc.clientID = 742;
    doc.getText('body').insert(0, '原始正文');
    const update = Y.encodeStateAsUpdate(doc);
    const beforeSnapshot = Y.encodeSnapshot(Y.snapshot(doc));
    const transactionDeletes = [{ client: 742, clock: 1, length: 1 }];
    const evidence = { version: 1 as const, kind: 'transaction-event' as const,
      beforeSnapshot, transactionDeletes };
    const expectedPayload = encodeCanonicalCbor({ update, sourceRetentionProvenance: evidence });
    const expectedUpdate = new Uint8Array(update);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const transactionRunner = runnerFor(database);
    const writer = createAuthoredYjsUpdateWriter(async (projectId, command, work) => {
      await gate;
      return transactionRunner(projectId, command, work);
    });
    const pending = writer(PROJECT_ID, DOC_ID, update, { kind: 'user' }, evidence);
    update.fill(0); beforeSnapshot.fill(0); transactionDeletes[0]!.length = 3;
    transactionDeletes.push({ client: 742, clock: 9, length: 1 });
    release(); await pending;
    const [row] = await database.select().from(yjsUpdates);
    const [mutation] = await database.select().from(SyncMutationTable);
    expect(new Uint8Array(row!.updateBlob as Uint8Array)).toEqual(expectedUpdate);
    expect(new Uint8Array(mutation!.payloadCbor as Uint8Array)).toEqual(expectedPayload);
    doc.destroy();
  });

  it.each(['user', 'agent', 'system'] as const)('keeps %s revision labels separate from wire evidence', async kind => {
    const database = await createDatabase();
    const update = updateWithText('untagged compatible prose');
    await writerFor(database)(PROJECT_ID, DOC_ID, update, { kind });
    const [mutation] = await database.select().from(SyncMutationTable);
    expect(new Uint8Array(mutation!.payloadCbor as Uint8Array)).toEqual(encodeCanonicalCbor({ update }));
  });

  it('keeps seed and restore state untagged unless an operation supplies evidence', async () => {
    const database = await createDatabase();
    const update = updateWithText('full-state transfer');
    await runnerFor(database)(PROJECT_ID, 'yjs.update', async ({ tx, changes }) => {
      await appendAuthoredProseSeedInTransaction(tx, changes, {
        entityType: 'node', entityId: 'node-yjs-journal', stateUpdate: update,
      });
    });
    await runnerFor(database)(PROJECT_ID, 'yjs.update', async ({ tx, changes }) => {
      await appendAuthoredProseRestoreStateInTransaction(tx, changes, {
        entityType: 'node', entityId: 'node-yjs-journal', stateUpdate: update,
      });
    });
    const mutations = await database.select().from(SyncMutationTable);
    expect(mutations).toHaveLength(2);
    for (const mutation of mutations) expect(new Uint8Array(mutation.payloadCbor as Uint8Array)).toEqual(encodeCanonicalCbor({ update }));
  });

  it('persists explicit state-transfer evidence without transaction delete claims', async () => {
    const database = await createDatabase();
    const update = updateWithText('transferred state');
    await writerFor(database)(PROJECT_ID, DOC_ID, update, { kind: 'system' },
      { version: 1, kind: 'state-transfer' });
    const [mutation] = await database.select().from(SyncMutationTable);
    expect(new Uint8Array(mutation!.payloadCbor as Uint8Array)).toEqual(encodeCanonicalCbor({ update,
      sourceRetentionProvenance: { version: 1, kind: 'state-transfer' } }));
  });

  it('rolls back evidence and prose together when receipt observation fails after journaling', async () => {
    const database = await createDatabase();
    const update = updateWithText('retryable evidence');
    const evidence = { version: 1 as const, kind: 'state-transfer' as const };
    const expectedPayload = encodeCanonicalCbor({ update, sourceRetentionProvenance: evidence });
    const runner = createAuthoredTransactionRunner({
      database: () => database,
      identity: async () => identity(),
      clock: () => ({ nowMs: Date.parse(NOW), nowIso: NOW }),
      syncGenerationIds: {
        createSyncGenerationId: () => 'sync-generation-yjs-journal',
        createProjectSyncId: () => 'projectSync-yjs-journal',
      },
      observeAuthored: async tx => {
        // The failure follows both prose persistence and immutable journal
        // insertion, so the outer transaction must undo both owners.
        expect(await tx.select().from(yjsUpdates)).toHaveLength(1);
        expect(await tx.select().from(SyncChangeSetTable)).toHaveLength(1);
        const [mutation] = await tx.select().from(SyncMutationTable);
        expect(new Uint8Array(mutation!.payloadCbor as Uint8Array)).toEqual(expectedPayload);
        throw new Error('synthetic receipt observation failure');
      },
    });
    await expect(createAuthoredYjsUpdateWriter(runner)(PROJECT_ID, DOC_ID, update,
      { kind: 'user' }, evidence)).rejects.toThrow('synthetic receipt observation failure');
    expect(await database.select().from(yjsUpdates)).toEqual([]);
    expect(await database.select().from(YjsDocumentRevisionTable)).toEqual([]);
    expect(await database.select().from(YjsDocumentRevisionProvenanceTable)).toEqual([]);
    expect(await database.select().from(SyncChangeSetTable)).toEqual([]);
    expect(await database.select().from(SyncMutationTable)).toEqual([]);
    expect(await database.select().from(SyncApplyReceiptTable)).toEqual([]);
    await writerFor(database)(PROJECT_ID, DOC_ID, update, { kind: 'user' }, evidence);
    expect(await createYjsRepository(database).getRevision(DOC_ID)).toBe(1);
    expect(await database.select().from(SyncApplyReceiptTable)).toHaveLength(1);
    const [retry] = await database.select().from(SyncChangeSetTable);
    expect(retry!.deviceSeq).toBe(1);
  });

  it.each([
    { version: 2, kind: 'state-transfer' },
    { version: 1, kind: 'transaction-event', beforeSnapshot: new Uint8Array([255]), transactionDeletes: [] },
    { version: 1, kind: 'state-transfer', transactionDeletes: [] },
  ])('rejects invalid explicit evidence before scheduling any database transaction: %j', async evidence => {
    const schedule = vi.fn();
    const writer = createAuthoredYjsUpdateWriter(schedule);
    await expect(writer(PROJECT_ID, DOC_ID, updateWithText('no write'), { kind: 'user' },
      evidence as YjsSourceRetentionProvenanceV1)).rejects.toThrow(TypeError);
    expect(schedule).not.toHaveBeenCalled();
  });

  it('commits the update, revision, provenance and raw-byte mutation atomically', async () => {
    const database = await createDatabase();
    const update = updateWithText('atomic prose');

    const result = await writerFor(database)(
      PROJECT_ID,
      DOC_ID,
      update,
      { kind: 'user' },
    );

    expect(result.updateId).toBeGreaterThan(0);
    expect(await database.select().from(yjsUpdates)).toMatchObject([
      { id: result.updateId, docId: DOC_ID },
    ]);
    expect(await database.select().from(YjsDocumentRevisionTable)).toMatchObject([
      { docId: DOC_ID, revision: 1 },
    ]);
    expect(
      await database.select().from(YjsDocumentRevisionProvenanceTable),
    ).toMatchObject([{ docId: DOC_ID, revision: 1, sourceKind: 'user' }]);
    expect(await database.select().from(SyncChangeSetTable)).toMatchObject([
      {
        projectId: PROJECT_ID,
        mutationCount: 1,
        origin: 'local',
        applyState: 'applied',
      },
    ]);
    expect(await database.select().from(SyncApplyReceiptTable)).toHaveLength(1);

    const mutations = await database.select().from(SyncMutationTable);
    expect(mutations).toMatchObject([
      {
        targetFamily: 'yjs',
        targetKind: 'prose-document',
        targetId: DOC_ID,
        action: 'yjs.update',
      },
    ]);
    const decoded = decodeCanonicalCbor(mutations[0]!.payloadCbor as Uint8Array);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error(decoded.message);
    const journalUpdate = (decoded.value as { update: Uint8Array }).update;
    expect(journalUpdate).toEqual(update);
    const replayed = new Y.Doc();
    Y.applyUpdate(replayed, journalUpdate);
    expect(replayed.getText('body').toString()).toBe('atomic prose');
    replayed.destroy();
  });

  it('commits a deterministic create seed with the owner and one complete authored change-set', async () => {
    const database = await createDatabase();
    const contentJson = JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'created prose authority' }],
        },
      ],
    });
    const seed = await createYjsProseSeedState(contentJson);

    await runnerFor(database)(PROJECT_ID, 'element.create', async ({ tx, changes }) => {
      await tx.insert(BookElementTable).values({
        id: 'element-seeded',
        projectId: PROJECT_ID,
        categoryId: null,
        name: 'Seeded element',
        summary: '',
        contentJson,
        createdAt: NOW,
        updatedAt: NOW,
      });
      appendAuthoredDomainMutation(changes, {
        entityType: 'element',
        mutationType: 'create',
        entityId: 'element-seeded',
        projectId: PROJECT_ID,
        payload: { name: 'Seeded element', summary: '', contentJson },
      });
      const persisted = await appendAuthoredProseSeedInTransaction(tx, changes, {
        entityType: 'element',
        entityId: 'element-seeded',
        stateUpdate: seed,
      });
      expect(persisted).toMatchObject({
        docId: 'element:element-seeded',
        revision: 1,
      });
    });

    expect(await database.select().from(YjsDocumentRevisionTable)).toMatchObject([
      { docId: 'element:element-seeded', revision: 1 },
    ]);
    expect(await database.select().from(YjsDocumentRevisionProvenanceTable)).toMatchObject([
      { docId: 'element:element-seeded', revision: 1, sourceKind: 'system' },
    ]);
    const changeSets = await database.select().from(SyncChangeSetTable);
    expect(changeSets).toMatchObject([{ mutationCount: 2, applyState: 'applied' }]);
    const mutations = await database.select().from(SyncMutationTable);
    expect(mutations.map(({ action }) => action)).toEqual(['entity.create', 'yjs.update']);
    expect(
      mutations.some(
        ({ action, targetKind }) => action === 'field.set' && targetKind === 'element',
      ),
    ).toBe(false);
  });

  it('rolls every Yjs row back when the authored transaction cannot bind a SyncGeneration', async () => {
    const database = await createDatabase();

    await expect(
      writerFor(database)(
        'missing-project',
        'node-content:missing-project-node',
        updateWithText('must roll back'),
      ),
    ).rejects.toThrow(/missing project/u);

    expect(
      await database
        .select()
        .from(yjsUpdates)
        .where(eq(yjsUpdates.docId, 'node-content:missing-project-node')),
    ).toEqual([]);
    expect(
      await database
        .select()
        .from(YjsDocumentRevisionTable)
        .where(eq(YjsDocumentRevisionTable.docId, 'node-content:missing-project-node')),
    ).toEqual([]);
    expect(
      await database
        .select()
        .from(YjsDocumentRevisionProvenanceTable)
        .where(
          eq(
            YjsDocumentRevisionProvenanceTable.docId,
            'node-content:missing-project-node',
          ),
        ),
    ).toEqual([]);
    expect(await database.select().from(SyncChangeSetTable)).toEqual([]);
  });

  it('enumerates snapshot-only documents for checkpoint capture', async () => {
    const database = await createDatabase();
    const repository = createYjsRepository(database);

    await repository.upsertSnapshot(
      'element:snapshot-only',
      updateWithText('checkpoint source'),
      { advanceRevision: false },
    );

    expect(await repository.listDocIds()).toContain('element:snapshot-only');
  });
});
