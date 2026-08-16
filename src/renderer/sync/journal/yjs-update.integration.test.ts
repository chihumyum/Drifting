import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
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
import { decodeCanonicalCbor } from '../protocol';
import { createAuthoredTransactionRunner } from './authored-transaction';
import { appendAuthoredDomainMutation } from './domain-mutation';
import type { SyncWriterIdentitySource } from './writer-state';
import {
  appendAuthoredProseSeedInTransaction,
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
