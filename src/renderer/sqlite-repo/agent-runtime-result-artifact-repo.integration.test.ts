import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
import {
  DriftingReadToolRuntime,
  type TruncatedAgentToolResult,
} from '../lib/agent/runtime/drifting-read-tool-runtime';
import type { AgentRuntimeContext, AgentToolExecutionRequest } from '../lib/agent/runtime/types';
import {
  AgentRuntimeResultArtifactError,
  createAgentRuntimeResultArtifactRepository,
} from './agent-runtime-result-artifact-repo';

const MIGRATIONS = [
  new URL('../../../drizzle/0060_agent_runtime_persistence.sql', import.meta.url),
  new URL('../../../drizzle/0061_agent_runtime_write_effect.sql', import.meta.url),
  new URL('../../../drizzle/0064_agent_runtime_result_artifact.sql', import.meta.url),
  new URL('../../../drizzle/0068_agent_runtime_write_authorization.sql', import.meta.url),
];

class ReopenableSqliteGateway implements DatabasePlatformApi {
  readonly database: DatabaseSync;
  private activeTransaction: string | null = null;
  private nextTransactionId = 1;

  private constructor(readonly databasePath: string) {
    this.database = new DatabaseSync(databasePath);
  }

  static async open(databasePath: string): Promise<ReopenableSqliteGateway> {
    const gateway = new ReopenableSqliteGateway(databasePath);
    gateway.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
    `);
    const initialized = gateway.database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_runtime_result_artifact'",
      )
      .get();
    if (!initialized) {
      gateway.database.exec(`
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
      for (const migration of MIGRATIONS) {
        gateway.database.exec(
          (await readFile(migration, 'utf8')).replaceAll('--> statement-breakpoint', ''),
        );
      }
    }
    return gateway;
  }

  async open(_databaseName: string): Promise<DatabaseOpenResult> {
    return {
      path: this.databasePath,
      journalMode: 'wal',
      migrationsApplied: 0,
    };
  }

  async execute(
    sql: string,
    parameters: readonly unknown[] = [],
    transactionId?: string,
  ): Promise<DatabaseExecuteResult> {
    this.assertTransaction(transactionId);
    const result = this.database.prepare(sql).run(...(parameters as SQLInputValue[]));
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
    return {
      columns: statement.columns().map((column) => column.name),
      rows: statement.all(
        ...(parameters as SQLInputValue[]),
      ) as unknown as DatabaseQueryResult['rows'],
    };
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
      throw new Error(`transaction ${transactionId} does not own database`);
    }
  }
}

const runtimeContext = (projectId = 'project-1'): AgentRuntimeContext => ({
  route: { kind: 'chat', projectId },
});

function executionRequest(
  overrides: Partial<AgentToolExecutionRequest> = {},
): AgentToolExecutionRequest {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    callId: 'call-1',
    idempotencyKey: 'session-1:turn-1:call-1',
    name: 'get_project_brief',
    arguments: {},
    access: 'read',
    context: runtimeContext(),
    signal: new AbortController().signal,
    control: {
      requestUserInput: async () => {
        throw new Error('result artifact test did not expect user input');
      },
    },
    ...overrides,
  };
}

function seedLifecycle(
  database: DatabaseSync,
  input: {
    projectId?: string;
    sessionId?: string;
    turnId?: string;
    callId?: string;
    toolName?: string;
  } = {},
): void {
  const projectId = input.projectId ?? 'project-1';
  const sessionId = input.sessionId ?? 'session-1';
  const turnId = input.turnId ?? 'turn-1';
  const callId = input.callId ?? 'call-1';
  const toolName = input.toolName ?? 'get_project_brief';
  const conversationId = `conversation:${projectId}`;
  const toolCallId = `agent-tool:${sessionId}:${turnId}:${callId}`;
  const idempotencyKey = `${sessionId}:${turnId}:${callId}`;
  const now = '2026-07-30T00:00:00.000Z';
  database
    .prepare(
      `INSERT OR IGNORE INTO project
        (id, name, user_id, created_at, updated_at)
       VALUES (?, 'Novel', 'user-1', ?, ?)`,
    )
    .run(projectId, now, now);
  database
    .prepare(
      `INSERT OR IGNORE INTO agent_conversation
        (id, project_id, title, created_at, updated_at)
       VALUES (?, ?, 'Runtime', ?, ?)`,
    )
    .run(conversationId, projectId, now, now);
  database
    .prepare(
      `INSERT OR IGNORE INTO agent_runtime_session
        (id, project_id, route_kind, conversation_id, provider, status, created_at, updated_at)
       VALUES (?, ?, 'chat', ?, 'deepseek', 'running', ?, ?)`,
    )
    .run(sessionId, projectId, conversationId, now, now);
  database
    .prepare(
      `INSERT OR IGNORE INTO agent_runtime_turn
        (id, session_id, ordinal, status, accepted_at, updated_at)
       VALUES (?, ?, 0, 'running', ?, ?)`,
    )
    .run(turnId, sessionId, now, now);
  database
    .prepare(
      `INSERT OR IGNORE INTO agent_runtime_tool_call
        (id, session_id, turn_id, call_id, name, access, status,
         idempotency_key, arguments_json, created_at)
       VALUES (?, ?, ?, ?, ?, 'read', 'running', ?, '{}', ?)`,
    )
    .run(toolCallId, sessionId, turnId, callId, toolName, idempotencyKey, now);
}

function artifactInput(overrides: Record<string, unknown> = {}) {
  return {
    ref: 'agent-result:session-1:turn-1:call-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolCallId: 'agent-tool:session-1:turn-1:call-1',
    callId: 'call-1',
    toolName: 'get_project_brief',
    idempotencyKey: 'session-1:turn-1:call-1',
    arguments: {},
    serialized: '中😀'.repeat(7_000),
    createdAt: '2026-07-30T00:00:01.000Z',
    quota: {
      maxArtifactsPerSession: 128,
      maxBytesPerSession: 8 * 1024 * 1024,
    },
    ...overrides,
  };
}

describe('durable Agent result artifact repository', () => {
  let directory: string | undefined;
  let gateway: ReopenableSqliteGateway | undefined;

  afterEach(async () => {
    await gateway?.close();
    gateway = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  async function setup() {
    directory = await mkdtemp(path.join(tmpdir(), 'drifting-result-artifact-'));
    const databasePath = path.join(directory, 'runtime.sqlite');
    gateway = await ReopenableSqliteGateway.open(databasePath);
    seedLifecycle(gateway.database);
    return {
      databasePath,
      repository: createAgentRuntimeResultArtifactRepository(createDatabaseClient(gateway)),
    };
  }

  it('pages exact Unicode content after closing and reopening the repository', async () => {
    const { databasePath, repository } = await setup();
    const firstRuntime = new DriftingReadToolRuntime({
      freshness: null,
      artifacts: repository,
      getContext: () => ({
        projectId: 'project-1',
        write: {} as never,
      }),
      dispatch: async () => '中😀'.repeat(7_000),
      now: () => '2026-07-30T00:00:01.000Z',
    });
    const first = await firstRuntime.execute(executionRequest());
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error);
    const truncated = first.data as TruncatedAgentToolResult;

    await gateway?.close();
    gateway = await ReopenableSqliteGateway.open(databasePath);
    const reopenedRuntime = new DriftingReadToolRuntime({
      freshness: null,
      artifacts: createAgentRuntimeResultArtifactRepository(createDatabaseClient(gateway)),
      getContext: () => ({
        projectId: 'project-1',
        write: {} as never,
      }),
      dispatch: async () => {
        throw new Error('paging must not dispatch the original read');
      },
    });
    const page = await reopenedRuntime.execute(
      executionRequest({
        name: 'read_tool_result',
        callId: 'page-1',
        idempotencyKey: 'session-1:turn-1:page-1',
        arguments: {
          resultRef: truncated.resultRef,
          offset: 3_999,
          limit: 7,
        },
      }),
    );

    expect(page).toEqual({
      ok: true,
      data: {
        resultRef: truncated.resultRef,
        sourceTool: 'get_project_brief',
        sourceArguments: {},
        offset: 3_999,
        nextOffset: 4_006,
        totalChars: 14_000,
        totalBytes: 49_000,
        contentHash: truncated.contentHash,
        createdAt: '2026-07-30T00:00:01.000Z',
        truncated: true,
        content: [...'中😀'.repeat(7_000)].slice(3_999, 4_006).join(''),
        reread: {
          tool: 'read_tool_result',
          arguments: {
            resultRef: truncated.resultRef,
            offset: 4_006,
            limit: 7,
          },
        },
      },
    });
    expect(truncated).toMatchObject({
      totalBytes: 49_000,
      contentHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });

    await expect(
      createAgentRuntimeResultArtifactRepository(createDatabaseClient(gateway!)).readPage({
        ref: truncated.resultRef,
        projectId: 'project-1',
        sessionId: 'session-1',
        offset: 14_001,
        limit: 1,
      }),
    ).rejects.toThrow('exceeds Agent result');
  });

  it('deduplicates blobs and refuses quota overflow without invalidating existing refs', async () => {
    const { repository } = await setup();
    seedLifecycle(gateway!.database, {
      callId: 'call-2',
      toolName: 'get_project_brief',
    });
    seedLifecycle(gateway!.database, {
      callId: 'call-3',
      toolName: 'get_project_brief',
    });

    const first = await repository.persist(
      artifactInput({
        serialized: 'same-content',
        quota: { maxArtifactsPerSession: 2, maxBytesPerSession: 1_000 },
      }),
    );
    const retry = await repository.persist(
      artifactInput({
        serialized: 'same-content',
        createdAt: '2026-07-30T00:00:09.000Z',
        quota: { maxArtifactsPerSession: 2, maxBytesPerSession: 1_000 },
      }),
    );
    const second = await repository.persist(
      artifactInput({
        ref: 'agent-result:session-1:turn-1:call-2',
        toolCallId: 'agent-tool:session-1:turn-1:call-2',
        callId: 'call-2',
        idempotencyKey: 'session-1:turn-1:call-2',
        serialized: 'same-content',
        createdAt: '2026-07-30T00:00:02.000Z',
        quota: { maxArtifactsPerSession: 2, maxBytesPerSession: 1_000 },
      }),
    );
    expect(first.outcome).toBe('inserted');
    expect(retry).toMatchObject({
      outcome: 'duplicate',
      artifact: {
        createdAt: '2026-07-30T00:00:01.000Z',
      },
    });
    expect(second.outcome).toBe('inserted');
    expect(
      gateway!.database.prepare('SELECT count(*) AS count FROM agent_runtime_result_blob').get(),
    ).toEqual({ count: 1 });

    await expect(
      repository.persist(
        artifactInput({
          ref: 'agent-result:session-1:turn-1:call-3',
          toolCallId: 'agent-tool:session-1:turn-1:call-3',
          callId: 'call-3',
          idempotencyKey: 'session-1:turn-1:call-3',
          serialized: 'third-content',
          createdAt: '2026-07-30T00:00:03.000Z',
          quota: { maxArtifactsPerSession: 2, maxBytesPerSession: 1_000 },
        }),
      ),
    ).rejects.toMatchObject({
      code: 'ARTIFACT_TOO_LARGE',
    });
    expect(
      await repository.get({
        ref: 'agent-result:session-1:turn-1:call-1',
        projectId: 'project-1',
        sessionId: 'session-1',
      }),
    ).toMatchObject({
      ref: 'agent-result:session-1:turn-1:call-1',
      serialized: 'same-content',
    });
    expect(
      gateway!.database.prepare('SELECT count(*) AS count FROM agent_runtime_result_blob').get(),
    ).toEqual({ count: 1 });
  });

  it('isolates project/session access and performs age-scoped garbage collection', async () => {
    const { repository } = await setup();
    await repository.persist(artifactInput({ serialized: 'old artifact' }));

    await expect(
      repository.get({
        ref: 'agent-result:session-1:turn-1:call-1',
        projectId: 'project-other',
        sessionId: 'session-1',
      }),
    ).resolves.toBeNull();
    await expect(
      repository.get({
        ref: 'agent-result:session-1:turn-1:call-1',
        projectId: 'project-1',
        sessionId: 'session-other',
      }),
    ).resolves.toBeNull();

    await expect(
      repository.collectGarbage({
        expiresBefore: '2026-07-30T00:00:02.000Z',
        sessionId: 'session-1',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_ARTIFACT',
    });
    await expect(
      repository.collectGarbage({
        expiresBefore: '2026-07-30T08:00:02+08:00',
        projectId: 'project-1',
        sessionId: 'session-1',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_ARTIFACT',
    });
    await expect(
      repository.collectGarbage({
        expiresBefore: 'July 30 2026',
        projectId: 'project-1',
        sessionId: 'session-1',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_ARTIFACT',
    });
    await expect(
      repository.collectGarbage({
        expiresBefore: '2026-07-30T00:00:02.000Z',
        projectId: 'project-1',
        sessionId: 'session-1',
      }),
    ).resolves.toEqual({
      deletedArtifacts: 1,
      deletedBlobs: 1,
    });
  });

  it('fails closed on content corruption and on a single result above quota', async () => {
    const { repository } = await setup();
    await expect(
      repository.persist(
        artifactInput({
          serialized: 'too large',
          quota: { maxArtifactsPerSession: 1, maxBytesPerSession: 2 },
        }),
      ),
    ).rejects.toMatchObject({
      code: 'ARTIFACT_TOO_LARGE',
    });

    const persisted = await repository.persist(artifactInput({ serialized: 'tamper-me' }));
    gateway!.database.exec(`
      DROP TRIGGER trg_agent_runtime_result_blob_immutable;
      UPDATE agent_runtime_result_blob
      SET content_blob = CAST('tamper-xx' AS BLOB)
      WHERE content_hash = '${persisted.artifact.contentHash}';
    `);
    await expect(
      repository.get({
        ref: persisted.artifact.ref,
        projectId: 'project-1',
        sessionId: 'session-1',
      }),
    ).rejects.toBeInstanceOf(AgentRuntimeResultArtifactError);
    await expect(
      repository.get({
        ref: persisted.artifact.ref,
        projectId: 'project-1',
        sessionId: 'session-1',
      }),
    ).rejects.toMatchObject({
      code: 'ARTIFACT_CONTENT_INTEGRITY',
    });
  });
});
