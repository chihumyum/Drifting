import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ClaimAgentRuntimeWriteEffect,
  PersistedAgentRuntimeWriteEffect,
} from '../domain/agent-runtime-write-effect';
import type {
  PersistedAgentRuntimeMessage,
  PersistedAgentRuntimeSession,
  PersistedAgentRuntimeToolCall,
  PersistedAgentRuntimeTurn,
} from '../domain/agent-runtime-persistence';
import { createDatabaseClient } from '../lib/db';
import type {
  DatabaseCheckpointResult,
  DatabaseExecuteResult,
  DatabaseOpenResult,
  DatabasePlatformApi,
  DatabaseQueryResult,
  DatabaseTransaction,
  TransactionBehavior,
} from '../platform/database';
import {
  createAgentRuntimePersistenceRepository,
  type AgentRuntimePersistenceRepository,
} from './agent-runtime-persistence-repo';
import {
  createAgentRuntimeWriteEffectRepository,
  type AgentRuntimeWriteEffectRepository,
} from './agent-runtime-write-effect-repo';

const readMigration = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), 'utf8').replaceAll(
    '--> statement-breakpoint',
    '',
  );
const runtimeMigrationSql = readMigration(
  '../../../drizzle/0060_agent_runtime_persistence.sql',
);
const writeEffectMigrationSql = readMigration(
  '../../../drizzle/0061_agent_runtime_write_effect.sql',
);
const authorizationMigrationSql = readMigration(
  '../../../drizzle/0068_agent_runtime_write_authorization.sql',
);
const reviewBlockMigrationSql = readMigration(
  '../../../drizzle/0071_agent_runtime_review_blocks.sql',
);
const migrationSql = `${runtimeMigrationSql}\n${writeEffectMigrationSql}\n${authorizationMigrationSql}\n${reviewBlockMigrationSql}`;

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
    return { path: ':memory:', journalMode: 'memory', migrationsApplied: 4 };
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

const at = (second: number): string =>
  `2026-07-30T00:00:${String(second).padStart(2, '0')}.000Z`;

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
    createdAt: at(0),
    updatedAt: at(0),
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
    acceptedAt: at(1),
    startedAt: null,
    endedAt: null,
    errorCode: null,
    errorMessage: null,
    updatedAt: at(1),
    ...overrides,
  };
}

function promptMessage(): PersistedAgentRuntimeMessage {
  return {
    id: 'message-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ordinal: 0,
    role: 'user',
    status: 'complete',
    content: { role: 'user', content: '修改第一章' },
    createdAt: at(1),
    completedAt: at(1),
  };
}

function toolCall(
  callId: string,
  overrides: Partial<PersistedAgentRuntimeToolCall> = {},
): PersistedAgentRuntimeToolCall {
  return {
    id: `agent-tool:session-1:turn-1:${callId}`,
    sessionId: 'session-1',
    turnId: 'turn-1',
    callId,
    name: 'write_chapter_prose',
    access: 'write',
    status: 'running',
    idempotencyKey: `session-1:turn-1:${callId}`,
    arguments: { chapterId: 'chapter-1', text: `text-${callId}` },
    result: null,
    errorCode: null,
    createdAt: at(2),
    startedAt: at(2),
    completedAt: null,
    ...overrides,
  };
}

function claimFor(
  tool: PersistedAgentRuntimeToolCall,
  overrides: Partial<ClaimAgentRuntimeWriteEffect> = {},
): ClaimAgentRuntimeWriteEffect {
  return {
    id: `effect:${tool.callId}`,
    projectId: 'project-1',
    routeKind: 'chat',
    conversationId: 'conversation-1',
    goalRunId: null,
    chapterId: null,
    sessionId: tool.sessionId,
    turnId: tool.turnId,
    toolCallId: tool.id,
    callId: tool.callId,
    toolName: tool.name,
    idempotencyKey: tool.idempotencyKey,
    authorization: {
      kind: 'automatic',
      requestId: null,
      argumentsHash: 'sha256:test-arguments',
      authorizedAt: at(3),
    },
    arguments: tool.arguments,
    expectedRevision: { kind: 'revision', value: 7 },
    claimedAt: at(3),
    ...overrides,
  };
}

describe('agent runtime write-effect persistence against real SQLite', () => {
  let gateway: NodeSqliteGateway | undefined;

  afterEach(async () => {
    await gateway?.close();
    gateway = undefined;
  });

  async function setup(): Promise<{
    runtime: AgentRuntimePersistenceRepository;
    writes: AgentRuntimeWriteEffectRepository;
  }> {
    gateway = new NodeSqliteGateway();
    gateway.database.exec(`
      INSERT INTO project (id, name, user_id, created_at, updated_at)
      VALUES ('project-1', 'Novel', 'user-1', '2026-07-30', '2026-07-30');
      INSERT INTO agent_conversation
        (id, project_id, title, created_at, updated_at)
      VALUES ('conversation-1', 'project-1', 'Effects', '2026-07-30', '2026-07-30');
      INSERT INTO agent_conversation
        (id, project_id, title, created_at, updated_at)
      VALUES ('conversation-2', 'project-1', 'Other', '2026-07-30', '2026-07-30');
    `);
    const client = createDatabaseClient(gateway);
    const runtime = createAgentRuntimePersistenceRepository(client);
    await runtime.acceptTurn({
      session: session(),
      turn: turn(),
      promptMessage: promptMessage(),
    });
    return {
      runtime,
      writes: createAgentRuntimeWriteEffectRepository(client),
    };
  }

  async function createClaimedEffect(
    runtime: AgentRuntimePersistenceRepository,
    writes: AgentRuntimeWriteEffectRepository,
    callId: string,
    overrides: Partial<PersistedAgentRuntimeToolCall> = {},
  ): Promise<{
    tool: PersistedAgentRuntimeToolCall;
    claim: ClaimAgentRuntimeWriteEffect;
    effect: PersistedAgentRuntimeWriteEffect;
  }> {
    const tool = toolCall(callId, overrides);
    await runtime.createToolCall(tool);
    const claim = claimFor(tool, { claimedAt: at(3) });
    const result = await writes.claimEffect(claim);
    return { tool, claim, effect: result.effect };
  }

  async function completeEffect(
    writes: AgentRuntimeWriteEffectRepository,
    effectId: string,
    reversibility: 'exact' | 'irreversible' = 'exact',
  ): Promise<void> {
    await writes.transitionEffect({
      effectId,
      expectedPhase: 'claimed',
      nextPhase: 'confirmed',
      at: at(4),
    });
    await writes.transitionEffect({
      effectId,
      expectedPhase: 'confirmed',
      nextPhase: 'mutation_started',
      observedRevision: { kind: 'revision', value: 7 },
      preimage: { text: 'before' },
      forward: { text: 'after' },
      inverse:
        reversibility === 'exact' ? { text: 'before' } : null,
      reversibility,
      at: at(5),
    });
    await writes.transitionEffect({
      effectId,
      expectedPhase: 'mutation_started',
      nextPhase: 'effect_committed',
      effect: { revision: 8, stateVector: 'sv-8' },
      at: at(6),
    });
    await writes.transitionEffect({
      effectId,
      expectedPhase: 'effect_committed',
      nextPhase: 'result_committed',
      result: { ok: true, revision: 8 },
      at: at(7),
    });
  }

  it('upgrades a populated 0060 database without rewriting runtime rows', () => {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec('PRAGMA foreign_keys = ON');
      database.exec(`
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
        INSERT INTO project (id, name, user_id, created_at, updated_at)
        VALUES ('project-1', 'Novel', 'user-1', '2026-07-30', '2026-07-30');
        INSERT INTO agent_conversation
          (id, project_id, title, created_at, updated_at)
        VALUES ('conversation-1', 'project-1', 'Effects', '2026-07-30', '2026-07-30');
      `);
      database.exec(runtimeMigrationSql);
      database.exec(`
        INSERT INTO agent_runtime_session (
          id, project_id, route_kind, conversation_id, provider, status,
          created_at, updated_at
        ) VALUES (
          'session-1', 'project-1', 'chat', 'conversation-1', 'deepseek',
          'running', '${at(0)}', '${at(0)}'
        );
        INSERT INTO agent_runtime_turn (
          id, session_id, ordinal, status, accepted_at, updated_at
        ) VALUES (
          'turn-1', 'session-1', 0, 'running', '${at(1)}', '${at(1)}'
        );
        INSERT INTO agent_runtime_tool_call (
          id, session_id, turn_id, call_id, name, access, status,
          idempotency_key, arguments_json, created_at, started_at
        ) VALUES (
          'agent-tool:session-1:turn-1:call-upgrade',
          'session-1',
          'turn-1',
          'call-upgrade',
          'write_chapter_prose',
          'write',
          'running',
          'session-1:turn-1:call-upgrade',
          '{"chapterId":"chapter-1"}',
          '${at(2)}',
          '${at(2)}'
        );
      `);

      database.exec(writeEffectMigrationSql);

      expect(
        database
          .prepare(
            "SELECT status FROM agent_runtime_tool_call WHERE call_id = 'call-upgrade'",
          )
          .get(),
      ).toEqual({ status: 'running' });
      expect(
        database
          .prepare(
            "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('agent_runtime_write_effect', 'agent_runtime_write_review')",
          )
          .get(),
      ).toEqual({ count: 2 });
      expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('retires pending legacy reviews when hard authorization is installed', () => {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec('PRAGMA foreign_keys = ON');
      database.exec(`
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
        INSERT INTO project (id, name, user_id, created_at, updated_at)
        VALUES ('project-1', 'Novel', 'user-1', '${at(0)}', '${at(0)}');
        INSERT INTO agent_conversation
          (id, project_id, title, created_at, updated_at)
        VALUES ('conversation-1', 'project-1', 'Legacy', '${at(0)}', '${at(0)}');
      `);
      database.exec(runtimeMigrationSql);
      database.exec(`
        INSERT INTO agent_runtime_session (
          id, project_id, route_kind, conversation_id, provider, status,
          created_at, updated_at
        ) VALUES (
          'session-1', 'project-1', 'chat', 'conversation-1', 'deepseek',
          'running', '${at(0)}', '${at(0)}'
        );
        INSERT INTO agent_runtime_turn (
          id, session_id, ordinal, status, accepted_at, updated_at
        ) VALUES ('turn-1', 'session-1', 0, 'running', '${at(1)}', '${at(1)}');
        INSERT INTO agent_runtime_tool_call (
          id, session_id, turn_id, call_id, name, access, status,
          idempotency_key, arguments_json, created_at, started_at
        ) VALUES (
          'agent-tool:session-1:turn-1:legacy-call', 'session-1', 'turn-1',
          'legacy-call', 'write_chapter_prose', 'write', 'running',
          'session-1:turn-1:legacy-call', '{}', '${at(2)}', '${at(2)}'
        );
      `);
      database.exec(writeEffectMigrationSql);
      database.exec(`
        INSERT INTO agent_runtime_write_effect (
          id, project_id, route_kind, conversation_id, session_id, turn_id,
          tool_call_id, call_id, tool_name, idempotency_key, arguments_json,
          claimed_at, updated_at
        ) VALUES (
          'legacy-effect', 'project-1', 'chat', 'conversation-1', 'session-1',
          'turn-1', 'agent-tool:session-1:turn-1:legacy-call', 'legacy-call',
          'write_chapter_prose', 'session-1:turn-1:legacy-call', '{}',
          '${at(3)}', '${at(3)}'
        );
        INSERT INTO agent_runtime_write_review (
          id, effect_id, session_id, turn_id, tool_call_id, status,
          created_at, updated_at
        ) VALUES (
          'legacy-review', 'legacy-effect', 'session-1', 'turn-1',
          'agent-tool:session-1:turn-1:legacy-call', 'pending', '${at(4)}', '${at(4)}'
        );
      `);

      database.exec(authorizationMigrationSql);

      expect(
        database.prepare(`
          SELECT status, accepted_at, settled_at, decision_note_json
          FROM agent_runtime_write_review WHERE id = 'legacy-review'
        `).get(),
      ).toMatchObject({
        status: 'accepted_effect',
        accepted_at: expect.any(String),
        settled_at: expect.any(String),
        decision_note_json: '"Retired during hard-authorization migration"',
      });
      expect(
        database.prepare(`
          SELECT authorization_kind, authorization_request_id,
                 authorization_arguments_hash, authorized_at
          FROM agent_runtime_write_effect WHERE id = 'legacy-effect'
        `).get(),
      ).toEqual({
        authorization_kind: null,
        authorization_request_id: null,
        authorization_arguments_hash: null,
        authorized_at: null,
      });
    } finally {
      database.close();
    }
  });

  it('claims a running deterministic tool call idempotently and rejects parameter drift', async () => {
    const { runtime, writes } = await setup();
    const tool = toolCall('call-1');
    await runtime.createToolCall(tool);
    const claim = claimFor(tool);

    const inserted = await writes.claimEffect(claim);
    expect(inserted).toMatchObject({
      outcome: 'inserted',
      effect: {
        id: 'effect:call-1',
        phase: 'claimed',
        toolCallId: 'agent-tool:session-1:turn-1:call-1',
      },
    });
    const replay = await writes.claimEffect({
      ...claim,
      id: 'a-new-nondeterministic-id-that-must-not-win',
      authorization: { ...claim.authorization, authorizedAt: at(19) },
      claimedAt: at(19),
    });
    expect(replay).toMatchObject({
      outcome: 'duplicate',
      effect: { id: 'effect:call-1', claimedAt: at(3) },
    });

    await expect(
      writes.claimEffect({
        ...claim,
        arguments: { ...tool.arguments as object, text: 'drifted' },
      }),
    ).rejects.toMatchObject({ code: 'CLAIM_PARAMETER_DRIFT' });
    expect(await writes.listEffects('session-1')).toHaveLength(1);

    const foreignRouteTool = toolCall('call-foreign-route');
    await runtime.createToolCall(foreignRouteTool);
    await expect(
      writes.claimEffect(
        claimFor(foreignRouteTool, {
          id: 'effect:foreign-route',
          projectId: 'project-2',
        }),
      ),
    ).rejects.toMatchObject({ code: 'WRITE_PROVENANCE_MISMATCH' });

    expect(() =>
      gateway?.database
        .prepare(
          "UPDATE agent_runtime_write_effect SET session_id = 'missing' WHERE id = 'effect:call-1'",
        )
        .run(),
    ).toThrow(/route provenance mismatch/i);
    expect(() =>
      gateway?.database
        .prepare(
          "UPDATE agent_runtime_write_effect SET tool_call_id = 'missing' WHERE id = 'effect:call-1'",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i);
    expect(() =>
      gateway?.database
        .prepare(
          "UPDATE agent_runtime_write_effect SET conversation_id = 'conversation-2' WHERE id = 'effect:call-1'",
        )
        .run(),
    ).toThrow(/route provenance mismatch/i);
    expect(() =>
      gateway?.database
        .prepare(
          "UPDATE agent_runtime_session SET conversation_id = 'conversation-2' WHERE id = 'session-1'",
        )
        .run(),
    ).toThrow(/durable write effects/i);
  });

  it('persists the ordered effect receipt and accepted whole-effect review with CAS replay', async () => {
    const { runtime, writes } = await setup();
    const { effect } = await createClaimedEffect(
      runtime,
      writes,
      'call-accepted',
      { status: 'requested', startedAt: null },
    );

    const confirmed = {
      effectId: effect.id,
      expectedPhase: 'claimed' as const,
      nextPhase: 'confirmed' as const,
      at: at(4),
    };
    expect((await writes.transitionEffect(confirmed)).outcome).toBe('updated');
    expect((await writes.transitionEffect(confirmed)).outcome).toBe('duplicate');

    const started = {
      effectId: effect.id,
      expectedPhase: 'confirmed' as const,
      nextPhase: 'mutation_started' as const,
      observedRevision: { kind: 'revision', value: 7 },
      preimage: { text: 'before' },
      forward: { text: 'after' },
      inverse: { text: 'before' },
      reversibility: 'exact' as const,
      at: at(5),
    };
    expect((await writes.transitionEffect(started)).outcome).toBe('updated');
    expect((await writes.transitionEffect(started)).outcome).toBe('duplicate');

    await writes.transitionEffect({
      effectId: effect.id,
      expectedPhase: 'mutation_started',
      nextPhase: 'effect_committed',
      effect: { revision: 8, stateVector: 'sv-8' },
      at: at(6),
    });
    await writes.transitionEffect({
      effectId: effect.id,
      expectedPhase: 'effect_committed',
      nextPhase: 'result_committed',
      result: { ok: true, revision: 8 },
      at: at(7),
    });

    const review = {
      id: 'review-accepted',
      effectId: effect.id,
      sessionId: effect.sessionId,
      turnId: effect.turnId,
      toolCallId: effect.toolCallId,
      createdAt: at(8),
    };
    expect((await writes.createReview(review)).outcome).toBe('inserted');
    const replayedReview = await writes.createReview({
      ...review,
      createdAt: at(18),
    });
    expect(replayedReview).toMatchObject({
      outcome: 'duplicate',
      review: { createdAt: at(8) },
    });
    await expect(
      writes.transitionReview({
        reviewId: review.id,
        expectedStatus: 'accepted',
        nextStatus: 'accepted_effect',
        at: at(9),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REVIEW_TRANSITION' });

    await writes.transitionReview({
      reviewId: review.id,
      expectedStatus: 'pending',
      nextStatus: 'accepted',
      decisionNote: { source: 'author', note: '保留' },
      at: at(9),
    });
    await writes.transitionReview({
      reviewId: review.id,
      expectedStatus: 'accepted',
      nextStatus: 'accepted_effect',
      at: at(10),
    });

    const snapshot = await writes.loadSnapshot('session-1');
    expect(snapshot.effects[0]).toMatchObject({
      phase: 'result_committed',
      preimage: { text: 'before' },
      forward: { text: 'after' },
      inverse: { text: 'before' },
      effect: { revision: 8, stateVector: 'sv-8' },
      result: { ok: true, revision: 8 },
    });
    expect(snapshot.reviews[0]).toMatchObject({
      status: 'accepted_effect',
      decisionNote: { source: 'author', note: '保留' },
      acceptedAt: at(9),
      settledAt: at(10),
    });
    const toolCalls = await runtime.listToolCalls('session-1');
    expect(toolCalls[0]).toMatchObject({
      status: 'completed',
      result: { ok: true, revision: 8 },
    });
  });

  it('rejects stale mutation entry without changing the confirmed receipt', async () => {
    const { runtime, writes } = await setup();
    const { effect } = await createClaimedEffect(
      runtime,
      writes,
      'call-stale',
    );
    await writes.transitionEffect({
      effectId: effect.id,
      expectedPhase: 'claimed',
      nextPhase: 'confirmed',
      at: at(4),
    });

    await expect(
      writes.transitionEffect({
        effectId: effect.id,
        expectedPhase: 'confirmed',
        nextPhase: 'mutation_started',
        observedRevision: { kind: 'revision', value: 8 },
        preimage: { text: 'somebody else changed it' },
        forward: { text: 'unsafe' },
        inverse: { text: 'somebody else changed it' },
        reversibility: 'exact',
        at: at(5),
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(await writes.getEffect(effect.id)).toMatchObject({
      phase: 'confirmed',
      mutationStartedAt: null,
      preimage: null,
    });
  });

  it('persists ordered block decisions, atomically settles mixed/all-reverted reviews, and upgrades pending legacy rows', async () => {
    const { runtime, writes } = await setup();
    const mixed = await createClaimedEffect(runtime, writes, 'call-block-mixed');
    await completeEffect(writes, mixed.effect.id);
    const mixedReview = {
      id: 'review-block-mixed',
      effectId: mixed.effect.id,
      sessionId: mixed.effect.sessionId,
      turnId: mixed.effect.turnId,
      toolCallId: mixed.effect.toolCallId,
      createdAt: at(8),
      blocks: [
        { blockId: 'paragraph-a', ordinal: 0 },
        { blockId: 'paragraph-b', ordinal: 1 },
      ],
    };
    expect((await writes.createReview(mixedReview)).outcome).toBe('inserted');
    expect((await writes.createReview(mixedReview)).outcome).toBe('duplicate');
    await expect(
      writes.transitionReview({
        reviewId: mixedReview.id,
        expectedStatus: 'pending',
        nextStatus: 'accepted',
        at: at(9),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REVIEW_TRANSITION' });

    const accepted = {
      reviewId: mixedReview.id,
      blockId: 'paragraph-a',
      expectedStatus: 'pending' as const,
      nextStatus: 'accepted' as const,
      decisionNote: 'keep paragraph a',
      at: at(9),
    };
    expect((await writes.transitionReviewBlock(accepted)).review.status).toBe(
      'pending',
    );
    expect((await writes.transitionReviewBlock(accepted)).outcome).toBe(
      'duplicate',
    );
    await writes.transitionReviewBlock({
      reviewId: mixedReview.id,
      blockId: 'paragraph-b',
      expectedStatus: 'pending',
      nextStatus: 'revert_started',
      decisionNote: 'restore paragraph b',
      at: at(10),
    });
    expect(await writes.listReviewBlocks(mixedReview.id)).toMatchObject([
      { blockId: 'paragraph-a', ordinal: 0, status: 'accepted' },
      { blockId: 'paragraph-b', ordinal: 1, status: 'revert_started' },
    ]);
    const mixedSettled = await writes.transitionReviewBlock({
      reviewId: mixedReview.id,
      blockId: 'paragraph-b',
      expectedStatus: 'revert_started',
      nextStatus: 'reverted',
      revertEffect: { revision: 'yjs:restored-b' },
      at: at(11),
    });
    expect(mixedSettled.review).toMatchObject({
      status: 'accepted_effect',
      decisionNote: {
        schemaVersion: 1,
        kind: 'block_review',
        decisions: [
          { blockId: 'paragraph-a', decision: 'accepted' },
          { blockId: 'paragraph-b', decision: 'reverted' },
        ],
      },
      settledAt: at(11),
    });
    expect(
      (await writes.listPendingReviewsForProject('project-1')).map(
        (review) => review.id,
      ),
    ).not.toContain(mixedReview.id);

    const reverted = await createClaimedEffect(
      runtime,
      writes,
      'call-block-reverted',
    );
    await completeEffect(writes, reverted.effect.id);
    const revertedReview = {
      id: 'review-block-reverted',
      effectId: reverted.effect.id,
      sessionId: reverted.effect.sessionId,
      turnId: reverted.effect.turnId,
      toolCallId: reverted.effect.toolCallId,
      createdAt: at(12),
      blocks: [
        { blockId: 'paragraph-c', ordinal: 0 },
        { blockId: 'paragraph-d', ordinal: 1 },
      ],
    };
    await writes.createReview(revertedReview);
    for (const [index, blockId] of ['paragraph-c', 'paragraph-d'].entries()) {
      await writes.transitionReviewBlock({
        reviewId: revertedReview.id,
        blockId,
        expectedStatus: 'pending',
        nextStatus: 'revert_started',
        at: at(13 + index * 2),
      });
      await writes.transitionReviewBlock({
        reviewId: revertedReview.id,
        blockId,
        expectedStatus: 'revert_started',
        nextStatus: 'reverted',
        revertEffect: { blockId, restored: true },
        at: at(14 + index * 2),
      });
    }
    expect(await writes.getReview(revertedReview.id)).toMatchObject({
      status: 'reverted',
      revertEffect: {
        kind: 'block_review_revert',
        blocks: [
          { blockId: 'paragraph-c', effect: { blockId: 'paragraph-c', restored: true } },
          { blockId: 'paragraph-d', effect: { blockId: 'paragraph-d', restored: true } },
        ],
      },
    });

    const legacy = await createClaimedEffect(runtime, writes, 'call-block-legacy');
    await completeEffect(writes, legacy.effect.id);
    const legacyReview = {
      id: 'review-block-legacy',
      effectId: legacy.effect.id,
      sessionId: legacy.effect.sessionId,
      turnId: legacy.effect.turnId,
      toolCallId: legacy.effect.toolCallId,
      createdAt: at(18),
    };
    await writes.createReview(legacyReview);
    expect(
      (
        await writes.createReview({
          ...legacyReview,
          createdAt: at(19),
          blocks: [{ blockId: 'legacy-paragraph', ordinal: 0 }],
        })
      ).outcome,
    ).toBe('updated');
    expect(await writes.listReviewBlocks(legacyReview.id)).toMatchObject([
      {
        blockId: 'legacy-paragraph',
        ordinal: 0,
        status: 'pending',
        createdAt: at(18),
      },
    ]);
    await expect(
      writes.createReview({
        ...legacyReview,
        blocks: [{ blockId: 'different-paragraph', ordinal: 0 }],
      }),
    ).rejects.toMatchObject({ code: 'REVIEW_CONFLICT' });

    expect(gateway?.database.prepare('PRAGMA foreign_key_check').all()).toEqual(
      [],
    );
  });

  it('marks only entered mutations uncertain and never blind-retries them', async () => {
    const { runtime, writes } = await setup();
    const claimed = await createClaimedEffect(runtime, writes, 'call-claimed');
    const confirmed = await createClaimedEffect(
      runtime,
      writes,
      'call-confirmed',
    );
    const entered = await createClaimedEffect(runtime, writes, 'call-entered');
    const committed = await createClaimedEffect(
      runtime,
      writes,
      'call-committed',
    );

    for (const item of [confirmed, entered, committed]) {
      await writes.transitionEffect({
        effectId: item.effect.id,
        expectedPhase: 'claimed',
        nextPhase: 'confirmed',
        at: at(4),
      });
    }
    for (const item of [entered, committed]) {
      await writes.transitionEffect({
        effectId: item.effect.id,
        expectedPhase: 'confirmed',
        nextPhase: 'mutation_started',
        observedRevision: { kind: 'revision', value: 7 },
        preimage: { text: 'before' },
        forward: { text: 'after' },
        inverse: { text: 'before' },
        reversibility: 'exact',
        at: at(5),
      });
    }
    await writes.transitionEffect({
      effectId: committed.effect.id,
      expectedPhase: 'mutation_started',
      nextPhase: 'effect_committed',
      effect: { revision: 8 },
      at: at(6),
    });

    expect(await writes.interruptSessionWrites('session-1', at(7))).toEqual({
      failedBeforeMutation: 2,
      uncertainAfterMutationStart: 1,
    });
    expect(await writes.interruptSessionWrites('session-1', at(8))).toEqual({
      failedBeforeMutation: 0,
      uncertainAfterMutationStart: 0,
    });

    expect(await writes.getEffect(claimed.effect.id)).toMatchObject({
      phase: 'failed',
      failedAt: at(7),
    });
    expect(await writes.getEffect(confirmed.effect.id)).toMatchObject({
      phase: 'failed',
      failedAt: at(7),
    });
    expect(await writes.getEffect(entered.effect.id)).toMatchObject({
      phase: 'uncertain',
      uncertainAt: at(7),
    });
    expect(await writes.getEffect(committed.effect.id)).toMatchObject({
      phase: 'effect_committed',
      effect: { revision: 8 },
    });

    expect((await writes.claimEffect(entered.claim)).effect).toMatchObject({
      phase: 'uncertain',
    });
    await expect(
      writes.transitionEffect({
        effectId: entered.effect.id,
        expectedPhase: 'confirmed',
        nextPhase: 'mutation_started',
        observedRevision: { kind: 'revision', value: 7 },
        preimage: { text: 'before' },
        forward: { text: 'after' },
        inverse: { text: 'before' },
        reversibility: 'exact',
        at: at(9),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_EFFECT_TRANSITION' });

    const statusByCall = new Map(
      (await runtime.listToolCalls('session-1')).map((tool) => [
        tool.callId,
        tool.status,
      ]),
    );
    expect(statusByCall).toEqual(
      new Map([
        ['call-claimed', 'failed'],
        ['call-confirmed', 'failed'],
        ['call-entered', 'uncertain'],
        ['call-committed', 'running'],
      ]),
    );

    const reconciled = await writes.transitionEffect({
      effectId: entered.effect.id,
      expectedPhase: 'uncertain',
      nextPhase: 'effect_committed',
      effect: { revision: 8, receiptId: 'immutable-receipt' },
      at: at(10),
    });
    expect(reconciled.effect).toMatchObject({
      phase: 'effect_committed',
      effect: { revision: 8, receiptId: 'immutable-receipt' },
      errorCode: null,
      errorMessage: null,
      uncertainAt: null,
      effectCommittedAt: at(10),
    });
    expect(
      (await runtime.listToolCalls('session-1')).find(
        (tool) => tool.callId === 'call-entered',
      ),
    ).toMatchObject({
      status: 'running',
      errorCode: null,
      completedAt: null,
    });
  });

  it('settles reversible rejection in order and records irreversible unavailability', async () => {
    const { runtime, writes } = await setup();
    const reversible = await createClaimedEffect(
      runtime,
      writes,
      'call-reversible',
    );
    await completeEffect(writes, reversible.effect.id);
    const reversibleReview = {
      id: 'review-reversible',
      effectId: reversible.effect.id,
      sessionId: reversible.effect.sessionId,
      turnId: reversible.effect.turnId,
      toolCallId: reversible.effect.toolCallId,
      createdAt: at(8),
    };
    await writes.createReview(reversibleReview);
    await writes.transitionReview({
      reviewId: reversibleReview.id,
      expectedStatus: 'pending',
      nextStatus: 'rejected',
      decisionNote: { note: '撤销' },
      at: at(9),
    });
    await writes.transitionReview({
      reviewId: reversibleReview.id,
      expectedStatus: 'rejected',
      nextStatus: 'revert_started',
      at: at(10),
    });
    await writes.transitionReview({
      reviewId: reversibleReview.id,
      expectedStatus: 'revert_started',
      nextStatus: 'reverted',
      revertEffect: { revision: 9, restored: true },
      at: at(11),
    });
    expect(await writes.getReview(reversibleReview.id)).toMatchObject({
      status: 'reverted',
      revertEffect: { revision: 9, restored: true },
      settledAt: at(11),
    });

    const retryable = await createClaimedEffect(
      runtime,
      writes,
      'call-retryable-revert',
    );
    await completeEffect(writes, retryable.effect.id);
    const retryableReview = {
      id: 'review-retryable-revert',
      effectId: retryable.effect.id,
      sessionId: retryable.effect.sessionId,
      turnId: retryable.effect.turnId,
      toolCallId: retryable.effect.toolCallId,
      createdAt: at(12),
    };
    await writes.createReview(retryableReview);
    await writes.transitionReview({
      reviewId: retryableReview.id,
      expectedStatus: 'pending',
      nextStatus: 'rejected',
      at: at(13),
    });
    await writes.transitionReview({
      reviewId: retryableReview.id,
      expectedStatus: 'rejected',
      nextStatus: 'revert_started',
      at: at(14),
    });
    await writes.transitionReview({
      reviewId: retryableReview.id,
      expectedStatus: 'revert_started',
      nextStatus: 'revert_failed',
      errorCode: 'TRANSIENT_CONFLICT',
      errorMessage: 'retry me',
      at: at(15),
    });
    await writes.transitionReview({
      reviewId: retryableReview.id,
      expectedStatus: 'revert_failed',
      nextStatus: 'revert_started',
      at: at(16),
    });
    expect(await writes.getReview(retryableReview.id)).toMatchObject({
      status: 'revert_started',
      errorCode: null,
      errorMessage: null,
      settledAt: null,
    });
    await writes.transitionReview({
      reviewId: retryableReview.id,
      expectedStatus: 'revert_started',
      nextStatus: 'reverted',
      revertEffect: { revision: 10, restored: true },
      at: at(17),
    });

    const irreversible = await createClaimedEffect(
      runtime,
      writes,
      'call-irreversible',
    );
    await completeEffect(writes, irreversible.effect.id, 'irreversible');
    const irreversibleReview = {
      id: 'review-irreversible',
      effectId: irreversible.effect.id,
      sessionId: irreversible.effect.sessionId,
      turnId: irreversible.effect.turnId,
      toolCallId: irreversible.effect.toolCallId,
      createdAt: at(12),
    };
    await writes.createReview(irreversibleReview);
    await writes.transitionReview({
      reviewId: irreversibleReview.id,
      expectedStatus: 'pending',
      nextStatus: 'rejected',
      at: at(13),
    });
    await expect(
      writes.transitionReview({
        reviewId: irreversibleReview.id,
        expectedStatus: 'rejected',
        nextStatus: 'revert_started',
        at: at(14),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REVIEW_TRANSITION' });
    await writes.transitionReview({
      reviewId: irreversibleReview.id,
      expectedStatus: 'rejected',
      nextStatus: 'revert_unavailable',
      errorCode: 'IRREVERSIBLE_EFFECT',
      errorMessage: 'The author explicitly confirmed an irreversible effect.',
      at: at(14),
    });
    expect(await writes.getReview(irreversibleReview.id)).toMatchObject({
      status: 'revert_unavailable',
      errorCode: 'IRREVERSIBLE_EFFECT',
      settledAt: at(14),
    });

    expect(gateway?.database.prepare('PRAGMA foreign_key_check').all()).toEqual(
      [],
    );
    expect(gateway?.database.prepare('PRAGMA integrity_check').get()).toEqual({
      integrity_check: 'ok',
    });
  });
});
