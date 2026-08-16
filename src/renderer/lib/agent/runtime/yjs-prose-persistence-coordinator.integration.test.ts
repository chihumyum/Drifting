import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { createDatabaseClient, type DbExecutor } from '../../../lib/db';
import { readPersistedYjsUpdateOrigin } from '../../../lib/yjs-persistence-origin';
import {
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
  type YjsProseCommandError,
} from './yjs-prose-command';
import {
  YjsProsePersistenceCoordinator,
  type PreparedYjsProsePersistenceCommand,
  type YjsProsePersistenceBase,
} from './yjs-prose-persistence-coordinator';
import { createTestAgentAuthoredJournal } from './agent-authored-journal.test-support';

const baselineSql = readFileSync(
  new URL(
    '../../../../../drizzle/0000_local_first_baseline.sql',
    import.meta.url,
  ),
  'utf8',
).replaceAll('--> statement-breakpoint', '');

class NodeSqliteGateway implements DatabasePlatformApi {
  readonly database = new DatabaseSync(':memory:');
  private activeTransaction: string | null = null;
  private nextTransactionId = 1;

  constructor() {
    this.database.exec('PRAGMA foreign_keys = OFF');
    this.database.exec(baselineSql);
    this.database.exec('PRAGMA foreign_keys = ON');
    this.database.exec(`
      INSERT INTO project
        (id, name, user_id, created_at, updated_at)
      VALUES ('project-1', 'Project', 'local', 'before', 'before');
      INSERT INTO book_node
        (id, title, project_id, created_at, updated_at, position_x, position_y)
      VALUES ('node-1', 'Node', 'project-1', 'before', 'before', 0, 0);
      INSERT INTO node_content
        (node_id, content_json, outline_json, plot_grid_json, created_at, updated_at)
      VALUES ('node-1', '{"type":"doc","content":[]}', '[]', '{}', 'before', 'before');
    `);
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

function createMalformedState(
  kind: 'missing-block-id' | 'duplicate-block-id',
): Uint8Array {
  const doc = new Y.Doc({ gc: false });
  try {
    const createParagraph = (textValue: string, id?: string): Y.XmlElement => {
      const paragraph = new Y.XmlElement('paragraph');
      if (id !== undefined) paragraph.setAttribute('id', id);
      const text = new Y.XmlText();
      text.insert(0, textValue);
      paragraph.insert(0, [text]);
      return paragraph;
    };
    const paragraphs =
      kind === 'missing-block-id'
        ? [createParagraph('Malformed prose without an id.')]
        : [
            createParagraph('First duplicate.', 'duplicate-id'),
            createParagraph('Second duplicate.', 'duplicate-id'),
          ];
    doc.getXmlFragment('default').insert(0, paragraphs);
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
  projectId: string;
  persistProjection: (
    tx: DbExecutor,
    projection: { contentJson: string },
  ) => Promise<void>;
} {
  return {
    projectId,
    async persistProjection(tx, projection) {
      await tx
        .update(NodeContentTable)
        .set({
          contentJson: projection.contentJson,
          updatedAt: 'committed',
        })
        .where(eq(NodeContentTable.nodeId, nodeId));
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

async function prepareEdit(
  coordinator: YjsProsePersistenceCoordinator,
  commandId: string,
  base: YjsProsePersistenceBase,
  blockId: string,
  text: string,
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
      kind: 'edit',
      blockId,
      block: paragraph(blockId, text),
    },
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
      journal: createTestAgentAuthoredJournal('yjs-coordinator'),
    });
    return { database, coordinator };
  }

  it('keeps exact user and Agent revision provenance after update compaction', async () => {
    const { database } = setup();
    const repo = createYjsRepository(database);
    const docId = 'node-content:provenance';

    await repo.upsertSnapshot(docId, createState([paragraph('p-1', 'seed')]), {
      source: { kind: 'system' },
    });
    await repo.appendUpdate(docId, Uint8Array.of(1, 2, 3), { kind: 'user' });
    await repo.appendUpdateCas(docId, Uint8Array.of(4, 5, 6), 2, {
      kind: 'agent',
      collaborator: {
        sessionId: 'session-b',
        turnId: 'turn-b',
        callId: 'call-b',
      },
    });
    await repo.deleteUpdatesUpTo(docId, await repo.maxUpdateId(docId));

    expect(await repo.listRevisionProvenance(docId, 0)).toEqual([
      expect.objectContaining({ revision: 1, source: { kind: 'system' } }),
      expect.objectContaining({ revision: 2, source: { kind: 'user' } }),
      expect.objectContaining({
        revision: 3,
        source: {
          kind: 'agent',
          collaborator: {
            sessionId: 'session-b',
            turnId: 'turn-b',
            callId: 'call-b',
          },
        },
      }),
    ]);
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
    expect(queryCount(gateway!, 'sync_change_set')).toBe(1);
    expect(queryCount(gateway!, 'sync_apply_receipt')).toBe(1);

    const duplicateProjection = vi.fn();
    const duplicateAppend = vi.fn();
    const duplicate = await coordinator.commit({
      projectId: 'project-1',
      command: first,
      direction: 'forward',
      expectedRevision: 0,
      persistProjection: duplicateProjection,
      appendAuthoredMutations: duplicateAppend,
    });
    expect(duplicate.outcome).toBe('duplicate');
    expect(duplicateProjection).not.toHaveBeenCalled();
    expect(duplicateAppend).not.toHaveBeenCalled();
    expect(queryCount(gateway!, 'yjs_updates')).toBe(1);
    expect(queryCount(gateway!, 'sync_change_set')).toBe(1);

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

  it.each([
    {
      kind: 'missing-block-id' as const,
      message: 'Top-level prose block 0 has no stable string id.',
    },
    {
      kind: 'duplicate-block-id' as const,
      message: 'Duplicate top-level prose block id "duplicate-id".',
    },
  ])(
    'fails closed for persisted prose with $kind without writing a repair update',
    async ({ kind, message }) => {
      const { coordinator, database } = setup();
      const repo = createYjsRepository(database);
      const malformedState = createMalformedState(kind);
      await repo.upsertSnapshot('node-content:node-1', malformedState);
      const revisionBefore = await repo.getRevision('node-content:node-1');
      const snapshotBefore = await repo.getSnapshot('node-content:node-1');

      await expect(
        coordinator.readBase('node-content:node-1'),
      ).rejects.toEqual(
        expect.objectContaining<Partial<YjsProseCommandError>>({
          name: 'YjsProseCommandError',
          code: 'INVALID_PROSE',
          message,
        }),
      );

      const snapshotAfter = await repo.getSnapshot('node-content:node-1');
      expect(await repo.getRevision('node-content:node-1')).toBe(revisionBefore);
      expect(queryCount(gateway!, 'yjs_updates')).toBe(0);
      expect(snapshotAfter?.stateBlob).toEqual(snapshotBefore?.stateBlob);
      expect([...(snapshotAfter?.stateBlob ?? [])]).toEqual([...malformedState]);
    },
  );

  it.each([
    {
      kind: 'missing-block-id' as const,
      message: 'Top-level prose block 0 has no stable string id.',
    },
    {
      kind: 'duplicate-block-id' as const,
      message: 'Duplicate top-level prose block id "duplicate-id".',
    },
  ])(
    'fails closed for live prose with $kind without mutating Yjs or SQLite',
    async ({ kind, message }) => {
      const live = new Y.Doc({ gc: false });
      Y.applyUpdate(live, createMalformedState(kind));
      const liveStateBefore = Y.encodeStateAsUpdate(live);
      const flushLive = vi.fn(async () => undefined);
      const { coordinator, database } = setup({ live, flushLive });
      const repo = createYjsRepository(database);

      await expect(
        coordinator.readBase('node-content:node-1'),
      ).rejects.toEqual(
        expect.objectContaining<Partial<YjsProseCommandError>>({
          name: 'YjsProseCommandError',
          code: 'INVALID_PROSE',
          message,
        }),
      );

      expect(flushLive).toHaveBeenCalledTimes(1);
      expect(Y.encodeStateAsUpdate(live)).toEqual(liveStateBefore);
      expect(await repo.getRevision('node-content:node-1')).toBe(0);
      expect(await repo.getSnapshot('node-content:node-1')).toBeNull();
      expect(queryCount(gateway!, 'yjs_updates')).toBe(0);
      live.destroy();
    },
  );

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
    const persistedCollaborators: unknown[] = [];
    let accidentalAppendCount = 0;
    live.on('update', (_update, origin) => {
      const persisted = readPersistedYjsUpdateOrigin(origin);
      if (persisted) {
        persistedOriginCount += 1;
        persistedCollaborators.push(persisted.collaborator);
      } else accidentalAppendCount += 1;
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
    const rollbackPresentation = vi.fn();
    const beforeMergeBlockIds: string[][] = [];
    const durableJournalBeforeMerge: number[] = [];
    const result = await coordinator.commit({
      command,
      direction: 'forward',
      expectedRevision: 1,
      collaborator: {
        kind: 'agent',
        sessionId: 'session-a',
        turnId: 'turn-a',
        callId: 'call-a',
      },
      ...persistenceHooks(),
      beforeLiveMerge() {
        durableJournalBeforeMerge.push(queryCount(gateway!, 'sync_apply_receipt'));
        beforeMergeBlockIds.push(
          snapshotYjsProseBlocks(live).map((block) => block.id),
        );
        return rollbackPresentation;
      },
    });

    expect(result.outcome).toBe('committed');
    expect(result.liveMerged).toBe(false);
    expect(beforeMergeBlockIds).toEqual([['base-a', 'base-b']]);
    expect(durableJournalBeforeMerge).toEqual([1]);
    expect(rollbackPresentation).not.toHaveBeenCalled();
    expect(persistedOriginCount).toBe(1);
    expect(persistedCollaborators).toEqual([
      { kind: 'agent', sessionId: 'session-a', turnId: 'turn-a', callId: 'call-a' },
    ]);
    expect(accidentalAppendCount).toBe(0);
    expect(queryCount(gateway!, 'yjs_updates')).toBe(1);
    expect(await repo.listRevisionProvenance('node-content:node-1', 1)).toEqual([
      expect.objectContaining({
        revision: 2,
        source: {
          kind: 'agent',
          collaborator: {
            sessionId: 'session-a',
            turnId: 'turn-a',
            callId: 'call-a',
          },
        },
      }),
    ]);
    const liveBlocks = snapshotYjsProseBlocks(live);
    expect(liveBlocks[liveBlocks.length - 1]?.id).toBe('agent-live');
    live.destroy();
  });

  it('rolls back Yjs, revision, projection, journal, and receipt when the transaction-bound journal fails', async () => {
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
        projectId: hooks.projectId,
        command,
        direction: 'forward',
        expectedRevision: base.revision,
        persistProjection: hooks.persistProjection,
        appendAuthoredMutations: async () => {
          throw new Error('fault after projection before journal');
        },
      }),
    ).rejects.toThrow('fault after projection before journal');

    expect(await repo.getRevision('node-content:node-1')).toBe(base.revision);
    expect(queryCount(gateway!, 'yjs_updates')).toBe(0);
    expect(queryCount(gateway!, 'yjs_prose_command_receipt')).toBe(0);
    expect(queryCount(gateway!, 'sync_change_set')).toBe(0);
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

  it('rebases an inverse over an unrelated durable block edit and preserves both outcomes', async () => {
    const { coordinator, database } = setup();
    const repo = createYjsRepository(database);
    await repo.upsertSnapshot(
      'node-content:node-1',
      createState([
        paragraph('base-a', 'Alpha'),
        paragraph('base-b', 'Beta'),
      ]),
    );
    const base = await coordinator.readBase('node-content:node-1');
    const agent = await prepareEdit(
      coordinator,
      'command-rebased-agent',
      base,
      'base-a',
      'Agent Alpha',
    );
    const agentForward = await coordinator.commit({
      command: agent,
      direction: 'forward',
      expectedRevision: base.revision,
      ...persistenceHooks(),
    });

    const afterAgent = await coordinator.readBase('node-content:node-1');
    const concurrent = await prepareEdit(
      coordinator,
      'command-rebased-concurrent',
      afterAgent,
      'base-b',
      'Author Beta',
    );
    const concurrentForward = await coordinator.commit({
      command: concurrent,
      direction: 'forward',
      expectedRevision: afterAgent.revision,
      ...persistenceHooks(),
    });

    const inverse = await coordinator.commit({
      command: agent,
      direction: 'inverse',
      expectedRevision: agentForward.receipt.committedRevision,
      ...persistenceHooks(),
    });
    expect(inverse.receipt.baseRevision).toBe(
      concurrentForward.receipt.committedRevision,
    );
    expect(inverse.receipt.committedRevision).toBe(
      concurrentForward.receipt.committedRevision + 1,
    );
    expect(inverse.receipt.resultStateHash).not.toBe(base.stateHash);

    const current = await coordinator.readBase('node-content:node-1');
    const doc = new Y.Doc({ gc: false });
    Y.applyUpdate(doc, current.stateUpdate);
    expect(snapshotYjsProseBlocks(doc)).toEqual([
      paragraph('base-a', 'Alpha'),
      paragraph('base-b', 'Author Beta'),
    ]);
    doc.destroy();

    const duplicate = await coordinator.commit({
      command: agent,
      direction: 'inverse',
      expectedRevision: agentForward.receipt.committedRevision,
      ...persistenceHooks(),
    });
    expect(duplicate.outcome).toBe('duplicate');
    expect(duplicate.receipt).toEqual(inverse.receipt);
  });

  it('refuses a rebased inverse after its affected block changed again', async () => {
    const { coordinator, database } = setup();
    const repo = createYjsRepository(database);
    await repo.upsertSnapshot(
      'node-content:node-1',
      createState([
        paragraph('base-a', 'Alpha'),
        paragraph('base-b', 'Beta'),
      ]),
    );
    const base = await coordinator.readBase('node-content:node-1');
    const agent = await prepareEdit(
      coordinator,
      'command-target-agent',
      base,
      'base-a',
      'Agent Alpha',
    );
    const agentForward = await coordinator.commit({
      command: agent,
      direction: 'forward',
      expectedRevision: base.revision,
      ...persistenceHooks(),
    });
    const afterAgent = await coordinator.readBase('node-content:node-1');
    const author = await prepareEdit(
      coordinator,
      'command-target-author',
      afterAgent,
      'base-a',
      'Author Alpha',
    );
    const authorForward = await coordinator.commit({
      command: author,
      direction: 'forward',
      expectedRevision: afterAgent.revision,
      ...persistenceHooks(),
    });

    await expect(
      coordinator.commit({
        command: agent,
        direction: 'inverse',
        expectedRevision: agentForward.receipt.committedRevision,
        ...persistenceHooks(),
      }),
    ).rejects.toMatchObject({ code: 'STALE_STATE_HASH' });
    expect(await repo.getRevision('node-content:node-1')).toBe(
      authorForward.receipt.committedRevision,
    );
    expect(
      await coordinator.getReceipt(agent.prepared.commandId, 'inverse'),
    ).toBeNull();
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
    expect(queryCount(gateway!, 'sync_change_set')).toBe(0);
  });
});

function copyUpdate(update: Uint8Array): Uint8Array {
  return new Uint8Array(update);
}
