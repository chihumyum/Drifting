import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  DatabaseCheckpointResult,
  DatabaseExecuteResult,
  DatabaseOpenResult,
  DatabasePlatformApi,
  DatabaseQueryResult,
  DatabaseTransaction,
  TransactionBehavior,
} from '../platform/database';
import { createDatabaseClient } from '../lib/db';
import type {
  PersistedAgentRuntimeMessage,
  PersistedAgentRuntimeSession,
  PersistedAgentRuntimeTurn,
} from '../domain/agent-runtime-persistence';
import {
  AgentRuntimePersistenceConflictError,
  createAgentRuntimePersistenceRepository,
} from './agent-runtime-persistence-repo';

const migrationSql = readFileSync(
  new URL('../../../drizzle/0060_agent_runtime_persistence.sql', import.meta.url),
  'utf8',
).replaceAll('--> statement-breakpoint', '');

class NodeSqliteGateway implements DatabasePlatformApi {
  readonly database = new DatabaseSync(':memory:');
  private activeTransaction: string | null = null;
  private nextTransactionId = 1;

  constructor() {
    this.database.exec('PRAGMA foreign_keys = ON');
    this.database.exec(`
      CREATE TABLE project (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE agent_conversation (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        title TEXT NOT NULL DEFAULT '',
        sdk_session_id TEXT,
        mode TEXT NOT NULL DEFAULT 'byok',
        messages_json TEXT NOT NULL DEFAULT '[]',
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
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

  async begin(behavior: TransactionBehavior = 'deferred'): Promise<DatabaseTransaction> {
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

function session(
  overrides: Partial<PersistedAgentRuntimeSession> = {},
): PersistedAgentRuntimeSession {
  return {
    id: 'session-1',
    projectId: 'project-1',
    routeKind: 'chat',
    conversationId: 'conversation-1',
    goalRunId: null,
    chapterId: null,
    provider: 'deepseek',
    model: 'deepseek-chat',
    providerEpoch: 0,
    status: 'pending',
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
    endedAt: null,
    ...overrides,
  };
}

function turn(
  overrides: Partial<PersistedAgentRuntimeTurn> = {},
): PersistedAgentRuntimeTurn {
  return {
    id: 'turn-1',
    sessionId: 'session-1',
    ordinal: 0,
    status: 'accepted',
    promptMessageId: 'message-1',
    acceptedAt: '2026-07-30T00:00:01.000Z',
    startedAt: null,
    endedAt: null,
    errorCode: null,
    errorMessage: null,
    updatedAt: '2026-07-30T00:00:01.000Z',
    ...overrides,
  };
}

function message(
  overrides: Partial<PersistedAgentRuntimeMessage> = {},
): PersistedAgentRuntimeMessage {
  return {
    id: 'message-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ordinal: 0,
    role: 'user',
    status: 'complete',
    content: { role: 'user', content: '写第一章' },
    createdAt: '2026-07-30T00:00:01.000Z',
    completedAt: '2026-07-30T00:00:01.000Z',
    ...overrides,
  };
}

describe('agent runtime persistence repository against real SQLite', () => {
  let gateway: NodeSqliteGateway | undefined;

  afterEach(async () => {
    await gateway?.close();
    gateway = undefined;
  });

  function setup() {
    gateway = new NodeSqliteGateway();
    gateway.database.exec(`
      INSERT INTO project (id, name, user_id, created_at, updated_at)
      VALUES ('project-1', 'Novel', 'user-1', '2026-07-30', '2026-07-30');
      INSERT INTO agent_conversation
        (id, project_id, title, created_at, updated_at)
      VALUES ('conversation-1', 'project-1', 'Recovery', '2026-07-30', '2026-07-30');
    `);
    const client = createDatabaseClient(gateway);
    return createAgentRuntimePersistenceRepository(client);
  }

  it('atomically accepts, journals, settles, checkpoints, and replays one turn', async () => {
    const repository = setup();
    const accepted = await repository.acceptTurn({
      session: session(),
      turn: turn(),
      promptMessage: message(),
    });
    expect(accepted).toBe('inserted');
    expect(
      await repository.acceptTurn({
        session: session(),
        turn: turn(),
        promptMessage: message(),
      }),
    ).toBe('duplicate');

    await repository.markTurnRunning(
      'session-1',
      'turn-1',
      '2026-07-30T00:00:02.000Z',
    );
    const event = {
      eventId: 'turn-1:00000001',
      sessionId: 'session-1',
      turnId: 'turn-1',
      seq: 1,
      schemaVersion: 1,
      eventType: 'turn_started',
      payload: { route: { kind: 'chat', projectId: 'project-1' } },
      wallTimeMs: 1,
      createdAt: '2026-07-30T00:00:02.000Z',
    };
    expect((await repository.appendEvent(event)).outcome).toBe('inserted');
    expect((await repository.appendEvent(event)).outcome).toBe('duplicate');
    await expect(
      repository.appendEvent({
        ...event,
        eventId: 'turn-1:00000003',
        seq: 3,
      }),
    ).rejects.toMatchObject({ code: 'EVENT_SEQ_GAP' });

    expect(
      await repository.createToolCall({
        id: 'tool-record-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        callId: 'call-1',
        name: 'list_nodes',
        access: 'read',
        status: 'completed',
        idempotencyKey: 'session-1:turn-1:call-1',
        arguments: {},
        result: { nodes: [] },
        errorCode: null,
        createdAt: '2026-07-30T00:00:03.000Z',
        startedAt: '2026-07-30T00:00:03.000Z',
        completedAt: '2026-07-30T00:00:03.000Z',
      }),
    ).toBe('inserted');
    await expect(repository.getToolCall?.('tool-record-1')).resolves.toMatchObject({
      id: 'tool-record-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      callId: 'call-1',
      result: { nodes: [] },
    });
    await expect(repository.getToolCall?.('missing-tool-record')).resolves.toBeNull();

    const assistant = message({
      id: 'message-2',
      ordinal: 1,
      role: 'assistant',
      content: { role: 'assistant', content: [{ type: 'text', text: '完成' }] },
      createdAt: '2026-07-30T00:00:04.000Z',
      completedAt: '2026-07-30T00:00:04.000Z',
    });
    const checkpoint = {
      id: 'checkpoint-1',
      sessionId: 'session-1',
      throughTurnOrdinal: 0,
      messageCount: 2,
      context: [message().content, assistant.content],
      contextHash: 'sha256:canonical-history',
      createdAt: '2026-07-30T00:00:04.000Z',
    };
    const settlement = {
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages: [assistant],
      checkpoint,
      terminalStatus: 'completed' as const,
      errorCode: null,
      errorMessage: null,
      endedAt: '2026-07-30T00:00:04.000Z',
    };
    expect(await repository.commitTurn(settlement)).toBe('inserted');
    expect(await repository.commitTurn(settlement)).toBe('duplicate');

    const snapshot = await repository.loadRecoverySnapshot('session-1');
    expect(snapshot).toMatchObject({
      session: { status: 'idle', routeKind: 'chat' },
      turns: [{ status: 'completed' }],
      messages: [{ ordinal: 0 }, { ordinal: 1 }],
      toolCalls: [{ callId: 'call-1', status: 'completed' }],
      checkpoints: [{ messageCount: 2 }],
    });
    expect(snapshot?.events.map((entry) => entry.seq)).toEqual([1]);
    expect(gateway?.database.prepare('PRAGMA integrity_check').get()).toEqual({
      integrity_check: 'ok',
    });
  });

  it('keeps checkpoint storage linear while retaining old commit idempotency', async () => {
    const repository = setup();
    const firstPrompt = message();
    const firstTurn = turn();
    await repository.acceptTurn({
      session: session(),
      turn: firstTurn,
      promptMessage: firstPrompt,
    });
    const firstAssistant = message({
      id: 'message-2',
      ordinal: 1,
      role: 'assistant',
      content: {
        role: 'assistant',
        content: [{ type: 'text', text: 'first' }],
      },
      createdAt: '2026-07-30T00:00:02.000Z',
      completedAt: '2026-07-30T00:00:02.000Z',
    });
    const firstCheckpoint = {
      id: 'checkpoint-1',
      sessionId: 'session-1',
      throughTurnOrdinal: 0,
      messageCount: 2,
      context: [firstPrompt.content, firstAssistant.content],
      contextHash: 'sha256:first-context',
      createdAt: '2026-07-30T00:00:02.000Z',
    };
    const firstSettlement = {
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages: [firstAssistant],
      checkpoint: firstCheckpoint,
      terminalStatus: 'completed' as const,
      errorCode: null,
      errorMessage: null,
      endedAt: '2026-07-30T00:00:02.000Z',
    };
    await repository.commitTurn(firstSettlement);

    const secondPrompt = message({
      id: 'message-3',
      turnId: 'turn-2',
      ordinal: 2,
      content: { role: 'user', content: 'continue' },
      createdAt: '2026-07-30T00:00:03.000Z',
      completedAt: '2026-07-30T00:00:03.000Z',
    });
    await repository.acceptTurn({
      session: session(),
      turn: turn({
        id: 'turn-2',
        ordinal: 1,
        promptMessageId: secondPrompt.id,
        acceptedAt: '2026-07-30T00:00:03.000Z',
        updatedAt: '2026-07-30T00:00:03.000Z',
      }),
      promptMessage: secondPrompt,
    });
    const secondAssistant = message({
      id: 'message-4',
      turnId: 'turn-2',
      ordinal: 3,
      role: 'assistant',
      content: {
        role: 'assistant',
        content: [{ type: 'text', text: 'second' }],
      },
      createdAt: '2026-07-30T00:00:04.000Z',
      completedAt: '2026-07-30T00:00:04.000Z',
    });
    await repository.commitTurn({
      sessionId: 'session-1',
      turnId: 'turn-2',
      messages: [secondAssistant],
      checkpoint: {
        id: 'checkpoint-2',
        sessionId: 'session-1',
        throughTurnOrdinal: 1,
        messageCount: 4,
        context: [
          firstPrompt.content,
          firstAssistant.content,
          secondPrompt.content,
          secondAssistant.content,
        ],
        contextHash: 'sha256:second-context',
        createdAt: '2026-07-30T00:00:04.000Z',
      },
      terminalStatus: 'completed',
      errorCode: null,
      errorMessage: null,
      endedAt: '2026-07-30T00:00:04.000Z',
    });

    const thirdPrompt = message({
      id: 'message-5',
      turnId: 'turn-3',
      ordinal: 4,
      content: { role: 'user', content: 'continue again' },
      createdAt: '2026-07-30T00:00:05.000Z',
      completedAt: '2026-07-30T00:00:05.000Z',
    });
    await repository.acceptTurn({
      session: session(),
      turn: turn({
        id: 'turn-3',
        ordinal: 2,
        promptMessageId: thirdPrompt.id,
        acceptedAt: '2026-07-30T00:00:05.000Z',
        updatedAt: '2026-07-30T00:00:05.000Z',
      }),
      promptMessage: thirdPrompt,
    });
    const thirdAssistant = message({
      id: 'message-6',
      turnId: 'turn-3',
      ordinal: 5,
      role: 'assistant',
      content: {
        role: 'assistant',
        content: [{ type: 'text', text: 'third' }],
      },
      createdAt: '2026-07-30T00:00:06.000Z',
      completedAt: '2026-07-30T00:00:06.000Z',
    });
    await repository.commitTurn({
      sessionId: 'session-1',
      turnId: 'turn-3',
      messages: [thirdAssistant],
      checkpoint: {
        id: 'checkpoint-3',
        sessionId: 'session-1',
        throughTurnOrdinal: 2,
        messageCount: 6,
        context: [
          firstPrompt.content,
          firstAssistant.content,
          secondPrompt.content,
          secondAssistant.content,
          thirdPrompt.content,
          thirdAssistant.content,
        ],
        contextHash: 'sha256:third-context',
        createdAt: '2026-07-30T00:00:06.000Z',
      },
      terminalStatus: 'completed',
      errorCode: null,
      errorMessage: null,
      endedAt: '2026-07-30T00:00:06.000Z',
    });

    expect(await repository.commitTurn(firstSettlement)).toBe('duplicate');
    expect((await repository.listCheckpoints('session-1')).map((row) => row.id)).toEqual([
      'checkpoint-2',
      'checkpoint-3',
    ]);
    expect(
      gateway?.database
        .prepare(
          "SELECT count(*) AS count FROM agent_runtime_checkpoint WHERE json_extract(context_json, '$.format') = 'drifting.agent-runtime-checkpoint-digest'",
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      gateway?.database
        .prepare(
          'SELECT sum(length(context_json)) AS bytes FROM agent_runtime_checkpoint',
        )
        .get(),
    ).toMatchObject({ bytes: expect.any(Number) });
  });

  it('rolls back route ownership failures without orphan rows', async () => {
    const repository = setup();
    await expect(
      repository.acceptTurn({
        session: session({ projectId: 'foreign-project' }),
        turn: turn(),
        promptMessage: message(),
      }),
    ).rejects.toBeInstanceOf(AgentRuntimePersistenceConflictError);

    expect(await repository.getSession('session-1')).toBeNull();
    expect(await repository.getTurn('turn-1')).toBeNull();
    expect(await repository.getMessage('message-1')).toBeNull();
  });

  it('marks in-flight reads interrupted and entered writes uncertain exactly once', async () => {
    const repository = setup();
    await repository.acceptTurn({
      session: session(),
      turn: turn(),
      promptMessage: message(),
    });
    await repository.createToolCall({
      id: 'read-tool',
      sessionId: 'session-1',
      turnId: 'turn-1',
      callId: 'read-call',
      name: 'read_node',
      access: 'read',
      status: 'running',
      idempotencyKey: 'read-key',
      arguments: {},
      result: null,
      errorCode: null,
      createdAt: '2026-07-30T00:00:02.000Z',
      startedAt: '2026-07-30T00:00:02.000Z',
      completedAt: null,
    });
    await repository.createToolCall({
      id: 'write-tool',
      sessionId: 'session-1',
      turnId: 'turn-1',
      callId: 'write-call',
      name: 'write_chapter_prose',
      access: 'write',
      status: 'running',
      idempotencyKey: 'write-key',
      arguments: {},
      result: null,
      errorCode: null,
      createdAt: '2026-07-30T00:00:02.000Z',
      startedAt: '2026-07-30T00:00:02.000Z',
      completedAt: null,
    });

    await repository.interruptSession(
      'session-1',
      '2026-07-30T00:00:03.000Z',
    );
    await repository.interruptSession(
      'session-1',
      '2026-07-30T00:00:04.000Z',
    );

    const snapshot = await repository.loadRecoverySnapshot('session-1');
    expect(snapshot?.session.status).toBe('interrupted');
    expect(snapshot?.turns[0]).toMatchObject({
      status: 'interrupted',
      endedAt: '2026-07-30T00:00:03.000Z',
    });
    expect(snapshot?.toolCalls).toMatchObject([
      { id: 'read-tool', status: 'interrupted' },
      {
        id: 'write-tool',
        status: 'uncertain',
        errorCode: 'PROCESS_INTERRUPTED_AFTER_WRITE_START',
      },
    ]);
  });
});
