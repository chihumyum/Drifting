import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { createDatabaseClient, type DbExecutor } from '../../../lib/db';
import { readPersistedYjsUpdateOrigin } from '../../../lib/yjs-persistence-origin';
import {
  LocalSyncMutationTable,
  NodeContentTable,
} from '../../../schema/drizzle';
import type {
  DatabaseCheckpointResult,
  DatabaseExecuteResult,
  DatabaseOpenResult,
  DatabasePlatformApi,
  DatabaseQueryResult,
  DatabaseTransaction,
  TransactionBehavior,
} from '../../../platform/database';
import { createYjsRepository } from '../../../sqlite-repo/yjs-repo';
import {
  hashYjsProseState,
  replaceYjsProseBlocks,
  snapshotYjsProseBlocks,
  type YjsProseBlock,
} from './yjs-prose-command';
import {
  YjsProsePersistenceCoordinator,
  type PreparedYjsProsePersistenceCommand,
  type YjsProsePersistenceBase,
} from './yjs-prose-persistence-coordinator';

const migrationSql = readFileSync(
  new URL('../../../../../drizzle/0062_yjs_document_revision.sql', import.meta.url),
  'utf8',
).replaceAll('--> statement-breakpoint', '');

class NodeSqliteGateway implements DatabasePlatformApi {
  readonly database = new DatabaseSync(':memory:');
  private activeTransaction: string | null = null;
  private nextTransactionId = 1;

  constructor() {
    this.database.exec(`
      CREATE TABLE yjs_updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        document_id TEXT NOT NULL,
        update_blob BLOB NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_yjs_updates_doc ON yjs_updates(document_id);
      CREATE TABLE yjs_snapshots (
        document_id TEXT PRIMARY KEY NOT NULL,
        state_blob BLOB NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_yjs_snapshot_doc ON yjs_snapshots(document_id);
      CREATE TABLE node_content (
        node_id TEXT PRIMARY KEY NOT NULL,
        content_json TEXT DEFAULT '{}',
        outline_json TEXT DEFAULT '[]',
        plot_grid_json TEXT DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE local_sync_mutation (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        entity_type TEXT NOT NULL,
        mutation_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        parent_id TEXT,
        payload_json TEXT,
        mutation_ts INTEGER NOT NULL,
        status TEXT DEFAULT 'pending' NOT NULL,
        retry_count INTEGER DEFAULT 0 NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO node_content
        (node_id, content_json, outline_json, plot_grid_json, created_at, updated_at)
      VALUES ('node-1', '{"type":"doc","content":[]}', '[]', '{}', 'before', 'before');
    `);
    this.database.exec(migrationSql);
  }

  async open(_databaseName: string): Promise<DatabaseOpenResult> {
    return { path: ':memory:', journalMode: 'memory', migrationsApplied: 1 };
  }

  async execute(
    sql: string,
    parameters: readonly unknown[] = [],
    transactionId?: string,
  ): Promise<DatabaseExecuteResult> {
    this.assertTransaction(transactionId);
    const result = this.database
      .prepare(sql)
      .run(...(parameters as SQLInputValue[]));
    return {
      changes: Number(result.changes),
      lastInsertRowid: result.lastInsertRowid,
    };
  }

  async query(
    sql: string,
    parameters: readonly unknown[] = [],
    transactionId?: string,
  ): Promise<DatabaseQueryResult> {
    this.assertTransaction(transactionId);
    const statement = this.database.prepare(sql);
    statement.setReturnArrays(true);
    const columns = statement.columns().map((column) => column.name);
    const rows = statement.all(
      ...(parameters as SQLInputValue[]),
    ) as unknown as DatabaseQueryResult['rows'];
    return { columns, rows };
  }

  async begin(
    behavior: TransactionBehavior = 'deferred',
  ): Promise<DatabaseTransaction> {
    if (this.activeTransaction) throw new Error('nested top-level transaction');
    const id = String(this.nextTransactionId++);
    this.database.exec(`BEGIN ${behavior.toUpperCase()}`);
    this.activeTransaction = id;
    return { id };
  }

  async commit(transactionId: string): Promise<void> {
    this.requireOwner(transactionId);
    this.database.exec('COMMIT');
    this.activeTransaction = null;
  }

  async rollback(transactionId: string): Promise<void> {
    this.requireOwner(transactionId);
    this.database.exec('ROLLBACK');
    this.activeTransaction = null;
  }

  async checkpoint(): Promise<DatabaseCheckpointResult> {
    return { busy: 0, logFrames: 0, checkpointedFrames: 0 };
  }

  async close(): Promise<void> {
    this.database.close();
  }

  private assertTransaction(transactionId?: string): void {
    if (transactionId !== undefined) this.requireOwner(transactionId);
    if (transactionId === undefined && this.activeTransaction) {
      throw new Error('query escaped active transaction');
    }
  }

  private requireOwner(transactionId: string): void {
    if (this.activeTransaction !== transactionId) {
      throw new Error(`transaction ${transactionId} does not own the database`);
    }
  }
}

function paragraph(id: string, text: string): YjsProseBlock {
  return {
    id,
    type: 'paragraph',
    content: [{ kind: 'text', text }],
  };
}

function createState(blocks: readonly YjsProseBlock[]): Uint8Array {
  const doc = new Y.Doc({ gc: false });
  try {
    replaceYjsProseBlocks(doc, blocks);
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

function queryCount(gateway: NodeSqliteGateway, table: string): number {
  return Number(
    (
      gateway.database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as {
        count: number;
      }
    ).count,
  );
}

function persistenceHooks(
  projectId = 'project-1',
  nodeId = 'node-1',
): {
  persistProjection: (
    tx: DbExecutor,
    projection: { contentJson: string },
  ) => Promise<void>;
  persistOutbox: (
    tx: DbExecutor,
    projection: { contentJson: string },
  ) => Promise<void>;
} {
  return {
    async persistProjection(tx, projection) {
      await tx
        .update(NodeContentTable)
        .set({
          contentJson: projection.contentJson,
          updatedAt: 'committed',
        })
        .where(eq(NodeContentTable.nodeId, nodeId));
    },
    async persistOutbox(tx, projection) {
      await tx.insert(LocalSyncMutationTable).values({
        entityType: 'nodeContent',
        mutationType: 'update',
        entityId: nodeId,
        projectId,
        parentId: null,
        payloadJson: JSON.stringify({ contentJson: projection.contentJson }),
        mutationTs: 1,
        status: 'pending',
        retryCount: 0,
        lastError: null,
        createdAt: 'committed',
        updatedAt: 'committed',
      });
    },
  };
}

async function prepareAppend(
  coordinator: YjsProsePersistenceCoordinator,
  commandId: string,
  base: YjsProsePersistenceBase,
  id: string,
): Promise<PreparedYjsProsePersistenceCommand> {
  return coordinator.prepare({
    docId: base.docId,
    commandId,
    expectedBase: {
      revision: base.revision,
      stateVector: base.stateVector,
      stateHash: base.stateHash,
    },
    operation: {
      kind: 'append',
      blocks: [paragraph(id, `text-${id}`)],
    },
    ...(base.sourceKind === 'seed'
      ? { seedStateUpdate: base.stateUpdate }
      : {}),
  });
}

describe('Yjs prose persistence coordinator against real SQLite + Y.Doc', () => {
  let gateway: NodeSqliteGateway | undefined;

  afterEach(async () => {
    await gateway?.close();
    gateway = undefined;
  });

  function setup(options: {
    live?: Y.Doc;
    flushLive?: () => Promise<void>;
  } = {}) {
    gateway = new NodeSqliteGateway();
    const database = createDatabaseClient(gateway);
    const coordinator = new YjsProsePersistenceCoordinator({
      database,
      getLiveDocument: () => options.live,
      flushLiveDocument: options.flushLive ?? (async () => undefined),
      now: () => '2026-07-30T00:00:00.000Z',
    });
    return { database, coordinator };
  }

  it('backfills revision zero for snapshot-only and update-only documents during migration', () => {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(`
        CREATE TABLE yjs_updates (
          id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
          document_id TEXT NOT NULL,
          update_blob BLOB NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE yjs_snapshots (
          document_id TEXT PRIMARY KEY NOT NULL,
          state_blob BLOB NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      const insertSnapshot = database.prepare(`
        INSERT INTO yjs_snapshots (document_id, state_blob, updated_at)
        VALUES (?, ?, ?)
      `);
      insertSnapshot.run(
        'snapshot-only',
        createState([paragraph('snapshot-block', 'snapshot')]),
        '2026-07-29',
      );
      const insertUpdate = database.prepare(`
        INSERT INTO yjs_updates (document_id, update_blob, created_at)
        VALUES (?, ?, ?)
      `);
      insertUpdate.run(
        'update-only',
        createState([paragraph('update-block', 'update')]),
        '2026-07-30',
      );

      database.exec(migrationSql);
      const rows = database
        .prepare(
          'SELECT document_id, revision FROM yjs_document_revision ORDER BY document_id',
        )
        .all() as Array<{ document_id: string; revision: number }>;
      expect(rows).toEqual([
        { document_id: 'snapshot-only', revision: 0 },
        { document_id: 'update-only', revision: 0 },
      ]);
    } finally {
      database.close();
    }
  });

  it('commits seed -> closed commands, survives compaction, and replays receipts without a duplicate write', async () => {
    const { coordinator, database } = setup();
    const seed = createState([
      paragraph('base-a', 'Alpha'),
      paragraph('base-b', 'Beta'),
    ]);
    const seedBase = await coordinator.readBase('node-content:node-1', seed);
    expect(seedBase.sourceKind).toBe('seed');
    expect(seedBase.revision).toBe(0);

    const first = await prepareAppend(
      coordinator,
      'command-seed',
      seedBase,
      'agent-a',
    );
    const hooks = persistenceHooks();
    const committed = await coordinator.commit({
      command: first,
      direction: 'forward',
      expectedRevision: 0,
      ...hooks,
    });
    expect(committed.outcome).toBe('committed');
    expect(committed.receipt.committedRevision).toBe(1);
    expect(queryCount(gateway!, 'yjs_updates')).toBe(1);
    expect(queryCount(gateway!, 'yjs_prose_command_receipt')).toBe(1);
    expect(queryCount(gateway!, 'local_sync_mutation')).toBe(1);

    const duplicateProjection = vi.fn();
    const duplicateOutbox = vi.fn();
    const duplicate = await coordinator.commit({
      command: first,
      direction: 'forward',
      expectedRevision: 0,
      persistProjection: duplicateProjection,
      persistOutbox: duplicateOutbox,
    });
    expect(duplicate.outcome).toBe('duplicate');
    expect(duplicateProjection).not.toHaveBeenCalled();
    expect(duplicateOutbox).not.toHaveBeenCalled();
    expect(queryCount(gateway!, 'yjs_updates')).toBe(1);

    const repo = createYjsRepository(database);
    const compactedSnapshot = await repo.getSnapshot('node-content:node-1');
    await repo.upsertSnapshot(
      'node-content:node-1',
      compactedSnapshot!.stateBlob,
    );
    expect(await repo.getRevision('node-content:node-1')).toBe(1);
    await repo.deleteUpdatesUpTo('node-content:node-1', committed.receipt.updateId);
    expect(await repo.maxUpdateId('node-content:node-1')).toBe(0);
    expect(await repo.getRevision('node-content:node-1')).toBe(1);

    const closedBase = await coordinator.readBase('node-content:node-1');
    expect(closedBase.sourceKind).toBe('closed');
    expect(closedBase.revision).toBe(1);
    const second = await prepareAppend(
      coordinator,
      'command-closed',
      closedBase,
      'agent-b',
    );
    const secondResult = await coordinator.commit({
      command: second,
      direction: 'forward',
      expectedRevision: 1,
      ...hooks,
    });
    expect(secondResult.receipt.committedRevision).toBe(2);
    expect(await repo.getRevision('node-content:node-1')).toBe(2);

    const hydrated = new Y.Doc();
    const snapshot = await repo.getSnapshot('node-content:node-1');
    expect(snapshot).not.toBeNull();
    Y.applyUpdate(hydrated, snapshot!.stateBlob);
    expect(snapshotYjsProseBlocks(hydrated).map((block) => block.id)).toEqual([
      'base-a',
      'base-b',
      'agent-a',
      'agent-b',
    ]);
    hydrated.destroy();
  });

  it('applies a committed command to the live Y.Doc with an already-persisted origin and no second append', async () => {
    const live = new Y.Doc({ gc: false });
    replaceYjsProseBlocks(live, [
      paragraph('base-a', 'Alpha'),
      paragraph('base-b', 'Beta'),
    ]);
    const { coordinator, database } = setup({ live });
    const repo = createYjsRepository(database);
    await repo.upsertSnapshot(
      'node-content:node-1',
      Y.encodeStateAsUpdate(live),
    );
    let persistedOriginCount = 0;
    let accidentalAppendCount = 0;
    live.on('update', (_update, origin) => {
      if (readPersistedYjsUpdateOrigin(origin)) persistedOriginCount += 1;
      else accidentalAppendCount += 1;
    });

    const base = await coordinator.readBase('node-content:node-1');
    expect(base.sourceKind).toBe('live');
    expect(base.revision).toBe(1);
    const command = await prepareAppend(
      coordinator,
      'command-live',
      base,
      'agent-live',
    );
    const result = await coordinator.commit({
      command,
      direction: 'forward',
      expectedRevision: 1,
      ...persistenceHooks(),
    });

    expect(result.outcome).toBe('committed');
    expect(result.liveMerged).toBe(false);
    expect(persistedOriginCount).toBe(1);
    expect(accidentalAppendCount).toBe(0);
    expect(queryCount(gateway!, 'yjs_updates')).toBe(1);
    const liveBlocks = snapshotYjsProseBlocks(live);
    expect(liveBlocks[liveBlocks.length - 1]?.id).toBe('agent-live');
    live.destroy();
  });

  it('rolls back Yjs, revision, projection, outbox, and receipt when the transaction-bound outbox fails', async () => {
    const { coordinator, database } = setup();
    const repo = createYjsRepository(database);
    const initial = createState([
      paragraph('base-a', 'Alpha'),
      paragraph('base-b', 'Beta'),
    ]);
    await repo.upsertSnapshot('node-content:node-1', initial);
    const base = await coordinator.readBase('node-content:node-1');
    const command = await prepareAppend(
      coordinator,
      'command-rollback',
      base,
      'must-rollback',
    );
    const hooks = persistenceHooks();

    await expect(
      coordinator.commit({
        command,
        direction: 'forward',
        expectedRevision: base.revision,
        persistProjection: hooks.persistProjection,
        persistOutbox: async () => {
          throw new Error('fault after projection before outbox');
        },
      }),
    ).rejects.toThrow('fault after projection before outbox');

    expect(await repo.getRevision('node-content:node-1')).toBe(base.revision);
    expect(queryCount(gateway!, 'yjs_updates')).toBe(0);
    expect(queryCount(gateway!, 'yjs_prose_command_receipt')).toBe(0);
    expect(queryCount(gateway!, 'local_sync_mutation')).toBe(0);
    const projection = gateway!.database
      .prepare('SELECT content_json, updated_at FROM node_content WHERE node_id = ?')
      .get('node-1') as { content_json: string; updated_at: string };
    expect(projection.updated_at).toBe('before');
    expect(projection.content_json).toBe('{"type":"doc","content":[]}');
  });

  it('detects stale revision/vector/hash before mutation and commits an exact inverse as a new revision', async () => {
    const { coordinator, database } = setup();
    const repo = createYjsRepository(database);
    const initial = createState([
      paragraph('base-a', 'Alpha'),
      paragraph('base-b', 'Beta'),
    ]);
    await repo.upsertSnapshot('node-content:node-1', initial);
    const base = await coordinator.readBase('node-content:node-1');

    await expect(
      coordinator.prepare({
        docId: base.docId,
        commandId: 'stale-revision',
        expectedBase: {
          revision: base.revision - 1,
          stateVector: base.stateVector,
          stateHash: base.stateHash,
        },
        operation: {
          kind: 'append',
          blocks: [paragraph('never-revision', 'never')],
        },
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    await expect(
      coordinator.prepare({
        docId: base.docId,
        commandId: 'stale-vector',
        expectedBase: {
          revision: base.revision,
          stateVector: Uint8Array.from([...base.stateVector, 0]),
          stateHash: base.stateHash,
        },
        operation: {
          kind: 'append',
          blocks: [paragraph('never-vector', 'never')],
        },
      }),
    ).rejects.toMatchObject({ code: 'STALE_STATE_VECTOR' });
    await expect(
      coordinator.prepare({
        docId: base.docId,
        commandId: 'stale-hash',
        expectedBase: {
          revision: base.revision,
          stateVector: base.stateVector,
          stateHash: `sha256:${'0'.repeat(64)}`,
        },
        operation: {
          kind: 'append',
          blocks: [paragraph('never', 'never')],
        },
      }),
    ).rejects.toMatchObject({ code: 'STALE_STATE_HASH' });
    expect(queryCount(gateway!, 'yjs_updates')).toBe(0);

    const command = await prepareAppend(
      coordinator,
      'command-inverse',
      base,
      'temporary',
    );
    const hooks = persistenceHooks();
    const forward = await coordinator.commit({
      command,
      direction: 'forward',
      expectedRevision: base.revision,
      ...hooks,
    });
    const inverse = await coordinator.commit({
      command,
      direction: 'inverse',
      expectedRevision: forward.receipt.committedRevision,
      ...hooks,
    });
    expect(inverse.receipt.committedRevision).toBe(
      forward.receipt.committedRevision + 1,
    );

    const restored = await coordinator.readBase('node-content:node-1');
    expect(restored.stateHash).toBe(base.stateHash);
    const restoredDoc = new Y.Doc();
    Y.applyUpdate(restoredDoc, restored.stateUpdate);
    expect(await hashYjsProseState(restoredDoc)).toBe(base.stateHash);
    expect(snapshotYjsProseBlocks(restoredDoc).map((block) => block.id)).toEqual([
      'base-a',
      'base-b',
    ]);
    restoredDoc.destroy();
    expect(queryCount(gateway!, 'yjs_prose_command_receipt')).toBe(2);
  });

  it('fails the SQL revision CAS when another durable Yjs update wins the race', async () => {
    const { coordinator, database } = setup();
    const repo = createYjsRepository(database);
    const initial = createState([
      paragraph('base-a', 'Alpha'),
      paragraph('base-b', 'Beta'),
    ]);
    await repo.upsertSnapshot('node-content:node-1', initial);
    const base = await coordinator.readBase('node-content:node-1');
    const command = await prepareAppend(
      coordinator,
      'command-lost-race',
      base,
      'loser',
    );

    const concurrent = new Y.Doc({ gc: false });
    Y.applyUpdate(concurrent, base.stateUpdate);
    const updates: Uint8Array[] = [];
    concurrent.on('update', (update) => updates.push(copyUpdate(update)));
    concurrent.transact(() => {
      concurrent.getMap('concurrent').set('winner', true);
    }, 'manual');
    expect(updates).toHaveLength(1);
    await repo.appendUpdate('node-content:node-1', updates[0]);
    concurrent.destroy();

    await expect(
      coordinator.commit({
        command,
        direction: 'forward',
        expectedRevision: base.revision,
        ...persistenceHooks(),
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    expect(queryCount(gateway!, 'yjs_updates')).toBe(1);
    expect(queryCount(gateway!, 'yjs_prose_command_receipt')).toBe(0);
    expect(queryCount(gateway!, 'local_sync_mutation')).toBe(0);
  });
});

function copyUpdate(update: Uint8Array): Uint8Array {
  return new Uint8Array(update);
}
