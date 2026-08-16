import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { asc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { ProductFileBackedSqliteGateway } from '../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import { createYjsProseSeedState } from '../lib/agent/runtime/yjs-prose-command';
import type { DbClient } from '../lib/db';
import {
  BookNodeTable,
  NodeContentTable,
  ProjectTable,
  SyncApplyReceiptTable,
  SyncChangeSetTable,
  SyncMutationTable,
  SyncGenerationTable,
  YjsDocumentRevisionProvenanceTable,
  yjsSnapshots,
  yjsUpdates,
} from '../schema/drizzle';
import { createYjsRepository } from '../sqlite-repo/yjs-repo';
import {
  createAuthoredTransactionRunner,
  createAuthoredYjsUpdateWriter,
  type SyncWriterIdentitySource,
} from '../sync/journal';
import {
  createSyncMutationV1,
  type SyncChangeSetV1,
} from '../sync/protocol';
import {
  applyVerifiedRemoteChangeSetInTransaction,
  invalidateSqliteReducerStateCache,
  productionSyncDomainMaterializationKernel,
} from '../sync/reducer';
import { compactUpdatesAfterSnapshot } from './yjs-local-durability.service';
import {
  scheduleMicrotask,
  YjsDocumentSessionRegistry,
  type YjsDocumentSessionDependencies,
} from './yjs-document-session';

const PROJECT_ID = 'project-remote-live-yjs';
const SYNC_GENERATION_ID = 'sync-generation-remote-live-yjs';
const PROJECT_SYNC_ID = 'project-sync-remote-live-yjs';
const NODE_ID = 'node-remote-live-yjs';
const DOC_ID = `node-content:${NODE_ID}`;
const NOW = '2026-08-15T00:00:00.000Z';

const directories: string[] = [];
const gateways: ProductFileBackedSqliteGateway[] = [];

function identity(): SyncWriterIdentitySource {
  return {
    installationId: 'installation-remote-live-yjs',
    createWriterIdentity: () => ({
      writerId: 'writer-local-live-yjs',
      writerEpoch: 'epoch-local-live-yjs',
    }),
  };
}

async function createDatabase(): Promise<DbClient> {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-remote-live-yjs-'));
  directories.push(directory);
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'drifting.db'));
  gateways.push(gateway);
  const db = gateway.client();
  await db.insert(ProjectTable).values({
    id: PROJECT_ID,
    userId: 'local-user',
    name: 'Remote live Yjs',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(BookNodeTable).values({
    id: NODE_ID,
    projectId: PROJECT_ID,
    title: 'Chapter',
    summary: '',
    kind: 'chapter',
    writingStatus: 'draft',
    positionX: 0,
    positionY: 0,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(NodeContentTable).values({
    nodeId: NODE_ID,
    contentJson: '{}',
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

async function remoteChangeSet(update: Uint8Array): Promise<SyncChangeSetV1> {
  const writerId = 'writer-remote-live-yjs';
  const writerEpoch = 'epoch-remote-live-yjs';
  return {
    protocol: 'drifting.sync.changeset',
    protocolVersion: 1,
    payloadVersion: 1,
    projectId: PROJECT_ID,
    projectSyncId: PROJECT_SYNC_ID,
    syncGenerationId: SYNC_GENERATION_ID,
    changeSetId: `${writerId}:${writerEpoch}:1`,
    writerId,
    writerEpoch,
    deviceSeq: 1,
    hlc: { wallMs: 1_000, counter: 0 },
    mutations: [await createSyncMutationV1({
      index: 0,
      target: {
        family: 'yjs',
        kind: 'prose-document',
        id: DOC_ID,
        incarnation: 0,
      },
      action: 'yjs.update',
      payloadVersion: 1,
      payload: { update },
    })],
  };
}

function sessionRegistry(db: DbClient): YjsDocumentSessionRegistry {
  const runAuthored = createAuthoredTransactionRunner({
    database: () => db,
    identity: async () => identity(),
    clock: () => ({ nowMs: 2_000, nowIso: '1970-01-01T00:00:02.000Z' }),
    syncGenerationIds: {
      createSyncGenerationId: () => SYNC_GENERATION_ID,
      createProjectSyncId: () => PROJECT_SYNC_ID,
    },
  });
  const dependencies: YjsDocumentSessionDependencies = {
    initDatabase: async () => undefined,
    createRepository: () => createYjsRepository(db),
    appendAuthoredUpdate: createAuthoredYjsUpdateWriter(runAuthored),
    compactUpdatesAfterSnapshot,
    captureSnapshotHistory: vi.fn(),
    queueMicrotask: scheduleMicrotask,
  };
  return new YjsDocumentSessionRegistry(dependencies);
}

async function settleFinalClose(session: {
  flushPendingWrites(): Promise<void>;
}): Promise<void> {
  await Promise.resolve();
  await session.flushPendingWrites();
  await Promise.resolve();
}

afterEach(async () => {
  invalidateSqliteReducerStateCache();
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('remote Yjs post-commit live merge', () => {
  it('keeps remote N+1 and local N+2 through compaction and reopen without remote echo', async () => {
    const db = await createDatabase();
    const registry = sessionRegistry(db);
    const session = registry.get(PROJECT_ID, DOC_ID, 'local-user');
    const release = session.retain();
    await session.waitUntilLoaded();

    const remoteUpdate = await createYjsProseSeedState(JSON.stringify({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: 'remote N+1' }],
      }],
    }));
    const remote = await remoteChangeSet(remoteUpdate);
    await db.transaction((tx) => applyVerifiedRemoteChangeSetInTransaction(tx, {
      changeSet: remote,
      identity: identity(),
      clock: { nowMs: 1_100, nowIso: '1970-01-01T00:00:01.100Z' },
      kernel: productionSyncDomainMaterializationKernel,
    }));

    // The reducer transaction is committed before the renderer touches the
    // open Y.Doc. This is the same post-commit bridge used by production.
    await registry.reconcilePersistedUpdates(PROJECT_ID, [DOC_ID]);
    expect(session.ydoc.getXmlFragment('default').toString()).toContain('remote N+1');
    expect((await db.select().from(SyncChangeSetTable)).filter((row) => row.origin === 'local'))
      .toHaveLength(0);

    session.ydoc.transact(() => {
      const paragraph = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'local N+2');
      paragraph.insert(0, [text]);
      const fragment = session.ydoc.getXmlFragment('default');
      fragment.insert(fragment.length, [paragraph]);
    }, 'user');
    await session.flushPendingWrites();

    expect(await db.select({ id: yjsUpdates.id }).from(yjsUpdates).orderBy(asc(yjsUpdates.id)))
      .toEqual([{ id: 1 }, { id: 2 }]);
    expect(await db.select({ source: YjsDocumentRevisionProvenanceTable.sourceKind })
      .from(YjsDocumentRevisionProvenanceTable)
      .orderBy(asc(YjsDocumentRevisionProvenanceTable.revision)))
      .toEqual([{ source: 'remote' }, { source: 'user' }]);

    await session.flushLocalState();
    expect(await db.select().from(yjsUpdates)).toEqual([]);
    expect(await db.select().from(yjsSnapshots).where(eq(yjsSnapshots.docId, DOC_ID)))
      .toHaveLength(1);

    release();
    await settleFinalClose(session);

    const reopenedRegistry = sessionRegistry(db);
    const reopened = reopenedRegistry.get(PROJECT_ID, DOC_ID, 'local-user');
    const releaseReopened = reopened.retain();
    await reopened.waitUntilLoaded();
    const prose = reopened.ydoc.getXmlFragment('default').toString();
    expect(prose).toContain('remote N+1');
    expect(prose).toContain('local N+2');

    const changeSets = await db.select({ origin: SyncChangeSetTable.origin })
      .from(SyncChangeSetTable);
    expect(changeSets.filter(({ origin }) => origin === 'remote')).toHaveLength(1);
    expect(changeSets.filter(({ origin }) => origin === 'local')).toHaveLength(1);
    expect(await db.select().from(SyncApplyReceiptTable)).toHaveLength(2);
    expect(await db.select().from(SyncMutationTable)).toHaveLength(2);

    releaseReopened();
    await settleFinalClose(reopened);
  });
});
