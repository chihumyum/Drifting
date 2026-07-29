import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
} from '../../../platform/database';
import { createDatabaseClient } from '../../../lib/db';
import { createAgentRuntimePersistenceRepository } from '../../../sqlite-repo/agent-runtime-persistence-repo';
import { planAgentModelContext } from './context-message-adapter';
import {
  AgentRuntimeRecoveryCorruptionError,
  hashAgentRuntimeCheckpointContext,
  hashAgentRuntimeCheckpointPayload,
  recoverAgentRuntimeSnapshot,
  type AgentRuntimeCheckpointContextV2,
} from './recovery';
import { createRepositoryAgentTransportPersistence } from './repository-transport-persistence';
import type {
  AgentModelMessage,
  AgentRuntimeEvent,
  AgentRuntimeUsage,
} from './types';

const migrationSql = readFileSync(
  new URL(
    '../../../../../drizzle/0060_agent_runtime_persistence.sql',
    import.meta.url,
  ),
  'utf8',
).replaceAll('--> statement-breakpoint', '');

const NOW = '2026-07-30T10:00:00.000Z';
const ENDED = '2026-07-30T10:00:01.000Z';
const ROUTE = {
  kind: 'chat' as const,
  projectId: 'project-v2',
  conversationId: 'conversation-v2',
};
const HISTORY: AgentModelMessage[] = [
  { role: 'user', content: 'Persist the final answer.' },
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'Final answer is durable.' }],
  },
];
const USAGE: AgentRuntimeUsage = {
  inputTokens: 8,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
};

class FileSqliteGateway implements DatabasePlatformApi {
  readonly database: DatabaseSync;
  private activeTransaction: string | null = null;
  private nextTransactionId = 1;

  constructor(path: string, initialize: boolean) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA foreign_keys = ON');
    if (!initialize) return;
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
    this.database.exec(`
      INSERT INTO project (id, name, user_id, created_at, updated_at)
      VALUES ('project-v2', 'Novel', 'user-v2', '${NOW}', '${NOW}');
      INSERT INTO agent_conversation
        (id, project_id, title, created_at, updated_at)
      VALUES (
        'conversation-v2',
        'project-v2',
        'V2 Recovery',
        '${NOW}',
        '${NOW}'
      );
    `);
  }

  async open(_databaseName: string): Promise<DatabaseOpenResult> {
    return { path: 'file-backed', journalMode: 'delete', migrationsApplied: 1 };
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
    if (this.activeTransaction) throw new Error('nested transaction');
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

function completeJournal(): AgentRuntimeEvent[] {
  return [
    { type: 'turn_started', prompt: 'Persist the final answer.' },
    {
      type: 'model_iteration_started',
      iteration: 1,
      driverId: 'test-provider',
    },
    {
      type: 'text_delta',
      iteration: 1,
      text: 'Final answer is durable.',
    },
    { type: 'model_usage', iteration: 1, usage: USAGE },
    {
      type: 'model_iteration_completed',
      iteration: 1,
      stopReason: 'end_turn',
    },
    {
      type: 'turn_finished',
      outcome: 'completed',
      usage: USAGE,
      modelIterations: 1,
      durationMs: 1_000,
    },
  ];
}

function corruptionCode(error: unknown): string | undefined {
  return error instanceof AgentRuntimeRecoveryCorruptionError
    ? error.code
    : undefined;
}

describe('file-backed Agent V2 context recovery', () => {
  let directory: string | undefined;
  let gateway: FileSqliteGateway | undefined;

  afterEach(async () => {
    await gateway?.close();
    gateway = undefined;
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it('commits the final assistant atomically, restarts, verifies nested integrity, and resumes canonical history', async () => {
    directory = mkdtempSync(join(tmpdir(), 'drifting-agent-v2-'));
    const databasePath = join(directory, 'runtime.sqlite');
    gateway = new FileSqliteGateway(databasePath, true);
    const firstRepository = createAgentRuntimePersistenceRepository(
      createDatabaseClient(gateway),
    );
    const firstPersistence = createRepositoryAgentTransportPersistence({
      repository: firstRepository,
      resolveToolAccess: () => undefined,
    });

    await firstPersistence.prepareTurn({
      candidateSessionId: 'session-v2',
      newConversation: true,
      route: ROUTE,
      provider: 'test-provider',
      model: 'test-model',
      turnId: 'turn-v2',
      prompt: 'Persist the final answer.',
      acceptedAt: NOW,
    });
    for (const [index, event] of completeJournal().entries()) {
      const seq = index + 1;
      await firstPersistence.appendJournal({
        schemaVersion: 1,
        sessionId: 'session-v2',
        turnId: 'turn-v2',
        route: ROUTE,
        seq,
        eventId: `turn-v2:${String(seq).padStart(8, '0')}`,
        wallTimeMs: Date.parse(NOW) + seq,
        event,
      });
    }
    const prematurePlan = await planAgentModelContext({
      systemPrompt: 'Drifting durable policy.',
      messages: HISTORY.slice(0, 1),
      resolveToolAccess: () => undefined,
      planner: {
        contextWindowTokens: 20_000,
        requestedOutputTokens: 1_000,
        fixedInputTokens: 100,
      },
    });
    expect(prematurePlan.ok).toBe(true);
    if (!prematurePlan.ok) return;
    await expect(
      firstPersistence.commitTurn({
        sessionId: 'session-v2',
        turnId: 'turn-v2',
        turnMessages: HISTORY,
        contextCheckpointV2: {
          canonicalSourceRows: prematurePlan.bridge.sourceRows,
          providerEnvelope: prematurePlan.envelope,
        },
        outcome: 'completed',
        errorCode: null,
        errorMessage: null,
        endedAt: ENDED,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CHECKPOINT' });
    expect(
      (await firstRepository.getTurn('turn-v2'))?.status,
    ).toBe('running');

    const planned = await planAgentModelContext({
      systemPrompt: 'Drifting durable policy.',
      messages: HISTORY,
      resolveToolAccess: () => undefined,
      planner: {
        contextWindowTokens: 20_000,
        requestedOutputTokens: 1_000,
        fixedInputTokens: 100,
      },
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    await firstPersistence.commitTurn({
      sessionId: 'session-v2',
      turnId: 'turn-v2',
      turnMessages: HISTORY,
      contextCheckpointV2: {
        canonicalSourceRows: planned.bridge.sourceRows,
        providerEnvelope: planned.envelope,
      },
      outcome: 'completed',
      errorCode: null,
      errorMessage: null,
      endedAt: ENDED,
    });

    const persisted = await firstRepository.loadRecoverySnapshot('session-v2');
    expect(persisted?.checkpoints[0]).toMatchObject({
      throughTurnOrdinal: 0,
      messageCount: 2,
      context: {
        schemaVersion: 2,
        format: 'drifting.agent-runtime-checkpoint-context',
        canonicalHistory: HISTORY,
      },
    });
    await gateway.close();
    gateway = new FileSqliteGateway(databasePath, false);
    const restartedRepository = createAgentRuntimePersistenceRepository(
      createDatabaseClient(gateway),
    );

    const restartedSnapshot =
      await restartedRepository.loadRecoverySnapshot('session-v2');
    if (!restartedSnapshot) throw new Error('restart lost the session');
    await expect(
      recoverAgentRuntimeSnapshot(restartedSnapshot),
    ).resolves.toMatchObject({
      providerHistory: HISTORY,
      checkpointId: 'agent-checkpoint:session-v2:0',
    });

    const checkpoint = restartedSnapshot.checkpoints[0];
    if (
      !checkpoint ||
      typeof checkpoint.context !== 'object' ||
      checkpoint.context === null
    ) {
      throw new Error('restart lost the V2 checkpoint');
    }
    const original = structuredClone(
      checkpoint.context,
    ) as AgentRuntimeCheckpointContextV2;
    gateway.database
      .prepare(
        `UPDATE agent_runtime_checkpoint
         SET context_hash = ?
         WHERE id = ?`,
      )
      .run('sha256:tampered', 'agent-checkpoint:session-v2:0');
    const hashTamperedSnapshot =
      await restartedRepository.loadRecoverySnapshot('session-v2');
    if (!hashTamperedSnapshot) throw new Error('hash tamper lost snapshot');
    await expect(
      recoverAgentRuntimeSnapshot(hashTamperedSnapshot),
    ).rejects.toSatisfy(
      (error: unknown) =>
        corruptionCode(error) === 'CHECKPOINT_HASH_MISMATCH',
    );

    const tamperCases: Array<{
      label: string;
      mutate: (context: AgentRuntimeCheckpointContextV2) => void;
    }> = [
      {
        label: 'canonical source',
        mutate: (context) => {
          context.canonicalSourceRows[0].content = 'tampered policy';
        },
      },
      {
        label: 'manifest',
        mutate: (context) => {
          context.providerEnvelope.sourceManifest[0].sourceHash =
            'sha256:tampered';
        },
      },
      {
        label: 'binding',
        mutate: (context) => {
          context.providerEnvelope.sourceBindings[0].sourceId =
            'tampered-binding';
        },
      },
      {
        label: 'projection',
        mutate: (context) => {
          context.providerEnvelope.providerContext.systemPrompt =
            'tampered projection';
        },
      },
      {
        label: 'budget',
        mutate: (context) => {
          context.providerEnvelope.plannerCheckpoint.budget.fixedInputTokens +=
            1;
        },
      },
    ];
    for (const { label, mutate } of tamperCases) {
      const tampered = structuredClone(original);
      mutate(tampered);
      const outerHash = await hashAgentRuntimeCheckpointPayload(tampered);
      gateway.database
        .prepare(
          `UPDATE agent_runtime_checkpoint
           SET context_json = ?, context_hash = ?
           WHERE id = ?`,
        )
        .run(
          JSON.stringify(tampered),
          outerHash,
          'agent-checkpoint:session-v2:0',
        );
      const tamperedSnapshot =
        await restartedRepository.loadRecoverySnapshot('session-v2');
      if (!tamperedSnapshot) throw new Error(`tamper ${label} lost snapshot`);
      await expect(
        recoverAgentRuntimeSnapshot(tamperedSnapshot),
        label,
      ).rejects.toSatisfy(
        (error: unknown) => corruptionCode(error) === 'INVALID_CHECKPOINT',
      );
    }

    const legacyHash = await hashAgentRuntimeCheckpointContext(HISTORY);
    gateway.database
      .prepare(
        `UPDATE agent_runtime_checkpoint
         SET context_json = ?, context_hash = ?
         WHERE id = ?`,
      )
      .run(
        JSON.stringify(HISTORY),
        legacyHash,
        'agent-checkpoint:session-v2:0',
      );
    const legacySnapshot =
      await restartedRepository.loadRecoverySnapshot('session-v2');
    if (!legacySnapshot) throw new Error('legacy fixture lost snapshot');
    await expect(
      recoverAgentRuntimeSnapshot(legacySnapshot),
    ).resolves.toMatchObject({
      providerHistory: HISTORY,
      checkpointId: 'agent-checkpoint:session-v2:0',
    });

    const originalHash = await hashAgentRuntimeCheckpointPayload(original);
    gateway.database
      .prepare(
        `UPDATE agent_runtime_checkpoint
         SET context_json = ?, context_hash = ?
         WHERE id = ?`,
      )
      .run(
        JSON.stringify(original),
        originalHash,
        'agent-checkpoint:session-v2:0',
      );
    const restartedPersistence = createRepositoryAgentTransportPersistence({
      repository: restartedRepository,
      resolveToolAccess: () => undefined,
    });
    await expect(
      restartedPersistence.prepareTurn({
        candidateSessionId: 'unused-session',
        resumeSessionId: 'session-v2',
        newConversation: false,
        route: ROUTE,
        provider: 'test-provider',
        model: 'test-model',
        turnId: 'turn-after-restart',
        prompt: 'Continue after restart.',
        acceptedAt: '2026-07-30T10:00:02.000Z',
      }),
    ).resolves.toEqual({
      sessionId: 'session-v2',
      history: HISTORY,
      recovered: false,
    });
  });
});
