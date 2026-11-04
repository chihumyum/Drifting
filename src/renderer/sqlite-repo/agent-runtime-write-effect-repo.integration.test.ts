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

const baselineSql = readFileSync(
  new URL('../../../drizzle/0000_local_first_baseline.sql', import.meta.url),
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
      inverse: { text: 'before' },
      reversibility: 'exact',
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
      writes.createReview({
        ...review,
        blocks: [{ blockId: 'unexpected-block', ordinal: 0 }],
      }),
    ).rejects.toMatchObject({ code: 'REVIEW_CONFLICT' });
    expect(await writes.listReviewBlocks(review.id)).toEqual([]);
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

  it('persists ordered settlement blocks and settles the receipt atomically with the last one', async () => {
    const { runtime, writes } = await setup();
    const blocked = await createClaimedEffect(runtime, writes, 'call-block-settled');
    await completeEffect(writes, blocked.effect.id);
    const blockReview = {
      id: 'review-block-settled',
      effectId: blocked.effect.id,
      sessionId: blocked.effect.sessionId,
      turnId: blocked.effect.turnId,
      toolCallId: blocked.effect.toolCallId,
      createdAt: at(8),
      blocks: [
        { blockId: 'paragraph-a', ordinal: 0 },
        { blockId: 'paragraph-b', ordinal: 1 },
      ],
    };
    expect((await writes.createReview(blockReview)).outcome).toBe('inserted');
    expect((await writes.createReview(blockReview)).outcome).toBe('duplicate');
    await expect(
      writes.createReview({
        ...blockReview,
        blocks: [{ blockId: 'paragraph-b', ordinal: 0 }],
      }),
    ).rejects.toMatchObject({ code: 'REVIEW_CONFLICT' });
    await expect(
      writes.transitionReview({
        reviewId: blockReview.id,
        expectedStatus: 'pending',
        nextStatus: 'accepted',
        at: at(9),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REVIEW_TRANSITION' });

    const first = {
      reviewId: blockReview.id,
      blockId: 'paragraph-a',
      expectedStatus: 'pending' as const,
      nextStatus: 'accepted' as const,
      at: at(9),
    };
    expect((await writes.transitionReviewBlock(first)).review.status).toBe(
      'pending',
    );
    expect((await writes.transitionReviewBlock(first)).outcome).toBe(
      'duplicate',
    );
    expect(await writes.listReviewBlocks(blockReview.id)).toMatchObject([
      { blockId: 'paragraph-a', ordinal: 0, status: 'accepted', settledAt: at(9) },
      { blockId: 'paragraph-b', ordinal: 1, status: 'pending', settledAt: null },
    ]);
    expect(
      (await writes.listPendingReviewsForProject('project-1')).map(
        (review) => review.id,
      ),
    ).toContain(blockReview.id);

    const settled = await writes.transitionReviewBlock({
      reviewId: blockReview.id,
      blockId: 'paragraph-b',
      expectedStatus: 'pending',
      nextStatus: 'accepted',
      at: at(10),
    });
    expect(settled.review).toMatchObject({
      status: 'accepted_effect',
      acceptedAt: at(10),
      settledAt: at(10),
    });
    await expect(
      writes.transitionReviewBlock({ ...first, at: at(11) }),
    ).resolves.toMatchObject({ outcome: 'duplicate' });
    expect(
      (await writes.listPendingReviewsForProject('project-1')).map(
        (review) => review.id,
      ),
    ).not.toContain(blockReview.id);

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
});
