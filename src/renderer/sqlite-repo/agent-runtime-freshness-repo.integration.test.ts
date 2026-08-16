import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import { and, eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AgentRuntimeFreshnessError,
  createAgentRuntimeFreshnessRepository,
} from './agent-runtime-freshness-repo';
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
  AgentRuntimeWriteEffectTable,
  BookNodeTable,
} from '../schema/drizzle';

const baselineSql = readFileSync(
  new URL('../../../drizzle/0000_local_first_baseline.sql', import.meta.url),
  'utf8',
).replaceAll('--> statement-breakpoint', '');

const HASH_ZERO = `sha256:${'0'.repeat(64)}`;
const HASH_ONE = `sha256:${'1'.repeat(64)}`;

class FileBackedNodeSqliteGateway implements DatabasePlatformApi {
  readonly directory = mkdtempSync(
    join(tmpdir(), 'drifting-agent-freshness-'),
  );
  readonly path = join(this.directory, 'freshness.sqlite');
  readonly database = new DatabaseSync(this.path);
  private activeTransaction: string | null = null;
  private nextTransactionId = 1;

  constructor() {
    this.database.exec('PRAGMA journal_mode = WAL');
    this.database.exec('PRAGMA synchronous = NORMAL');
    this.database.exec('PRAGMA foreign_keys = OFF');
    this.database.exec(baselineSql);
    this.database.exec('PRAGMA foreign_keys = ON');
    this.database.exec(`
      CREATE TABLE freshness_outbox (
        id TEXT PRIMARY KEY NOT NULL,
        effect_id TEXT NOT NULL UNIQUE,
        entity_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  async open(_databaseName: string): Promise<DatabaseOpenResult> {
    return {
      path: this.path,
      journalMode: 'wal',
      migrationsApplied: 1,
    };
  }

  async execute(
    statement: string,
    parameters: readonly unknown[] = [],
    transactionId?: string,
  ): Promise<DatabaseExecuteResult> {
    this.assertTransaction(transactionId);
    const result = this.database
      .prepare(statement)
      .run(...(parameters as SQLInputValue[]));
    return {
      changes: Number(result.changes),
      lastInsertRowid: result.lastInsertRowid,
    };
  }

  async query(
    statement: string,
    parameters: readonly unknown[] = [],
    transactionId?: string,
  ): Promise<DatabaseQueryResult> {
    this.assertTransaction(transactionId);
    const prepared = this.database.prepare(statement);
    prepared.setReturnArrays(true);
    const columns = prepared.columns().map((column) => column.name);
    const rows = prepared.all(
      ...(parameters as SQLInputValue[]),
    ) as unknown as DatabaseQueryResult['rows'];
    return { columns, rows };
  }

  async begin(
    behavior: TransactionBehavior = 'deferred',
  ): Promise<DatabaseTransaction> {
    if (this.activeTransaction) {
      throw new Error('nested top-level transaction');
    }
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
    rmSync(this.directory, { recursive: true, force: true });
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

function insertRuntimeFixture(
  gateway: FileBackedNodeSqliteGateway,
): void {
  gateway.database.exec(`
    INSERT INTO project (id, name, user_id, created_at, updated_at) VALUES
      ('project-1', 'Novel', 'user-1', '2026-07-30', '2026-07-30'),
      ('project-2', 'Other', 'user-1', '2026-07-30', '2026-07-30');
    INSERT INTO agent_conversation
      (id, project_id, title, created_at, updated_at)
    VALUES
      ('conversation-1', 'project-1', 'Runtime', '2026-07-30', '2026-07-30'),
      ('conversation-2', 'project-2', 'Other', '2026-07-30', '2026-07-30');
    INSERT INTO agent_runtime_session
      (id, project_id, route_kind, conversation_id, provider, model, status,
       created_at, updated_at)
    VALUES
      ('session-1', 'project-1', 'chat', 'conversation-1', 'fake', 'fake',
       'running', '2026-07-30', '2026-07-30'),
      ('session-2', 'project-2', 'chat', 'conversation-2', 'fake', 'fake',
       'running', '2026-07-30', '2026-07-30');
    INSERT INTO agent_runtime_turn
      (id, session_id, ordinal, status, accepted_at, updated_at)
    VALUES
      ('turn-1', 'session-1', 0, 'running', '2026-07-30', '2026-07-30'),
      ('turn-2', 'session-2', 0, 'running', '2026-07-30', '2026-07-30');
    INSERT INTO agent_runtime_tool_call
      (id, session_id, turn_id, call_id, name, access, status,
       idempotency_key, arguments_json, created_at, started_at)
    VALUES
      ('read-tool-1', 'session-1', 'turn-1', 'read-call-1', 'read_node',
       'read', 'running', 'session-1:turn-1:read-call-1', '{}',
       '2026-07-30', '2026-07-30'),
      ('write-tool-1', 'session-1', 'turn-1', 'write-call-1', 'rename_node',
       'write', 'running', 'session-1:turn-1:write-call-1', '{}',
       '2026-07-30', '2026-07-30');
    INSERT INTO agent_runtime_write_effect
      (id, project_id, route_kind, conversation_id, session_id, turn_id,
       tool_call_id, call_id, tool_name, idempotency_key, phase,
       arguments_json, claimed_at, confirmed_at, updated_at)
    VALUES
      ('effect-1', 'project-1', 'chat', 'conversation-1', 'session-1',
       'turn-1', 'write-tool-1', 'write-call-1', 'rename_node',
       'session-1:turn-1:write-call-1', 'confirmed', '{}',
       '2026-07-30', '2026-07-30', '2026-07-30');
  `);
}

function createReceiptInput() {
  return {
    id: 'receipt-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolCallId: 'read-tool-1',
    callId: 'read-call-1',
    toolName: 'read_node',
    idempotencyKey: 'session-1:turn-1:read-call-1',
    result: { node: 'Chapter 1', summary: 'Observed' },
    observations: [
      {
        id: 'observation-1',
        entityKind: 'node',
        entityId: 'node-1',
        revision: 'rev-0',
        stateVector: Uint8Array.of(1, 2, 3),
        stateHash: HASH_ZERO,
      },
    ],
    createdAt: '2026-07-30T00:00:01.000Z',
  };
}

describe('agent runtime durable freshness against file-backed node:sqlite', () => {
  const gateways: FileBackedNodeSqliteGateway[] = [];

  afterEach(async () => {
    await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
  });

  function setup() {
    const gateway = new FileBackedNodeSqliteGateway();
    gateways.push(gateway);
    insertRuntimeFixture(gateway);
    const client = createDatabaseClient(gateway);
    return {
      gateway,
      client,
      freshness: createAgentRuntimeFreshnessRepository(client),
    };
  }

  it('persists exact read observations idempotently and rejects cross-project provenance', async () => {
    const { gateway, freshness } = setup();
    const input = createReceiptInput();

    await expect(
      freshness.persistReadReceipt({
        ...input,
        id: 'cross-project-receipt',
        projectId: 'project-2',
      }),
    ).rejects.toMatchObject({
      code: 'READ_PROVENANCE_MISMATCH',
    });

    const inserted = await freshness.persistReadReceipt(input);
    expect(inserted.outcome).toBe('inserted');
    expect(inserted.receipt.resultHash).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    expect(inserted.receipt.observations).toEqual([
      expect.objectContaining({
        id: 'observation-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        toolCallId: 'read-tool-1',
        entityKind: 'node',
        entityId: 'node-1',
        revision: 'rev-0',
        stateVector: Uint8Array.of(1, 2, 3),
        stateHash: HASH_ZERO,
      }),
    ]);

    const duplicate = await freshness.persistReadReceipt({
      ...input,
      result: { summary: 'Observed', node: 'Chapter 1' },
    });
    expect(duplicate.outcome).toBe('duplicate');
    await expect(
      freshness.persistReadReceipt({
        ...input,
        result: { node: 'Chapter 1', summary: 'Drifted' },
      }),
    ).rejects.toMatchObject({ code: 'READ_RECEIPT_CONFLICT' });

    const attached = await freshness.attachWriteExpectations({
      effectId: 'effect-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      observations: [
        {
          id: 'expectation-1',
          observationId: 'observation-1',
        },
      ],
      createdAt: '2026-07-30T00:00:02.000Z',
    });
    expect(attached.outcome).toBe('inserted');
    expect(
      await freshness.attachWriteExpectations({
        effectId: 'effect-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        observations: [
          {
            id: 'expectation-1',
            observationId: 'observation-1',
          },
        ],
        createdAt: '2026-07-30T00:00:02.000Z',
      }),
    ).toMatchObject({ outcome: 'duplicate' });
    expect(() =>
      gateway.database.exec(
        "UPDATE agent_runtime_write_expectation SET expected_revision = 'tampered' WHERE id = 'expectation-1'",
      ),
    ).toThrow(/expectation is immutable/);
    await expect(
      freshness.attachWriteExpectations({
        effectId: 'effect-1',
        projectId: 'project-2',
        sessionId: 'session-1',
        observations: [
          {
            id: 'expectation-cross',
            observationId: 'observation-1',
          },
        ],
        createdAt: '2026-07-30T00:00:02.000Z',
      }),
    ).rejects.toMatchObject({
      code: 'FRESHNESS_PROVENANCE_MISMATCH',
    });
  });

  it('detects a tampered result blob and a tampered result hash', async () => {
    const { gateway, freshness } = setup();
    await freshness.persistReadReceipt(createReceiptInput());

    expect(() =>
      gateway.database.exec(
        "UPDATE agent_runtime_read_receipt SET result_blob = CAST('{\"tampered\":true}' AS BLOB) WHERE id = 'receipt-1'",
      ),
    ).toThrow(/immutable/);

    gateway.database.exec(
      'DROP TRIGGER trg_agent_runtime_read_receipt_immutable',
    );
    gateway.database.exec(
      "UPDATE agent_runtime_read_receipt SET result_blob = CAST('{\"tampered\":true}' AS BLOB) WHERE id = 'receipt-1'",
    );
    await expect(freshness.getReadReceipt('receipt-1')).rejects.toMatchObject({
      code: 'READ_RESULT_INTEGRITY',
    });

    gateway.database.exec(`
      UPDATE agent_runtime_read_receipt
      SET result_blob = CAST('{"node":"Chapter 1","summary":"Observed"}' AS BLOB),
          result_hash = '${HASH_ONE}'
      WHERE id = 'receipt-1'
    `);
    await expect(freshness.getReadReceipt('receipt-1')).rejects.toMatchObject({
      code: 'READ_RESULT_INTEGRITY',
    });
  });

  it('revalidates exact observation provenance after an expectation is tampered', async () => {
    const { gateway, freshness } = setup();
    await freshness.persistReadReceipt(createReceiptInput());
    await freshness.attachWriteExpectations({
      effectId: 'effect-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      observations: [
        {
          id: 'expectation-1',
          observationId: 'observation-1',
        },
      ],
      createdAt: '2026-07-30T00:00:02.000Z',
    });

    gateway.database.exec(
      'DROP TRIGGER trg_agent_runtime_write_expectation_immutable',
    );
    gateway.database.exec(`
      UPDATE agent_runtime_write_expectation
      SET expected_state_hash = '${HASH_ONE}'
      WHERE id = 'expectation-1'
    `);
    await expect(
      freshness.listWriteExpectations('effect-1'),
    ).rejects.toMatchObject({
      code: 'FRESHNESS_PROVENANCE_MISMATCH',
    });
    await expect(
      freshness.executeGuardedMutation({
        effectId: 'effect-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        readCurrentVersion: async () => ({
          revision: 'rev-0',
          stateVector: Uint8Array.of(1, 2, 3),
          stateHash: HASH_ONE,
        }),
        mutate: async () => {
          throw new Error('tampered expectation reached mutation');
        },
      }),
    ).rejects.toMatchObject({
      code: 'FRESHNESS_PROVENANCE_MISMATCH',
    });
  });

  it('cascades a deleted runtime session without orphaning freshness rows', async () => {
    const { gateway, freshness } = setup();
    await freshness.persistReadReceipt(createReceiptInput());
    await freshness.attachWriteExpectations({
      effectId: 'effect-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      observations: [
        {
          id: 'expectation-1',
          observationId: 'observation-1',
        },
      ],
      createdAt: '2026-07-30T00:00:02.000Z',
    });

    gateway.database.exec(
      "DELETE FROM agent_runtime_session WHERE id = 'session-1'",
    );
    const remaining = gateway.database
      .prepare(`
        SELECT
          (SELECT count(*) FROM agent_runtime_read_receipt) AS receipts,
          (SELECT count(*) FROM agent_runtime_read_observation) AS observations,
          (SELECT count(*) FROM agent_runtime_write_expectation) AS expectations
      `)
      .get() as {
      receipts: number;
      observations: number;
      expectations: number;
    };
    expect(remaining).toEqual({
      receipts: 0,
      observations: 0,
      expectations: 0,
    });
  });

  it('rejects stale revision, state vector, and state hash before invoking mutation', async () => {
    const { freshness } = setup();
    const receiptInput = createReceiptInput();
    await freshness.persistReadReceipt({
      ...receiptInput,
      observations: [
        ...receiptInput.observations,
        {
          id: 'observation-2',
          entityKind: 'node',
          entityId: 'node-2',
          revision: 'rev-0',
          stateVector: Uint8Array.of(1, 2, 3),
          stateHash: HASH_ZERO,
        },
      ],
    });
    await freshness.attachWriteExpectations({
      effectId: 'effect-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      observations: [
        {
          id: 'expectation-1',
          observationId: 'observation-1',
        },
        {
          id: 'expectation-2',
          observationId: 'observation-2',
        },
      ],
      createdAt: '2026-07-30T00:00:02.000Z',
    });

    let mutationCalls = 0;
    const mutate = async () => {
      mutationCalls += 1;
    };
    await expect(
      freshness.executeGuardedMutation({
        effectId: 'effect-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        readCurrentVersion: async (_tx, expectation) => ({
          revision:
            expectation.entityId === 'node-2' ? 'rev-1' : 'rev-0',
          stateVector: Uint8Array.of(1, 2, 3),
          stateHash: HASH_ZERO,
        }),
        mutate,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    await expect(
      freshness.executeGuardedMutation({
        effectId: 'effect-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        readCurrentVersion: async (_tx, expectation) => ({
          revision: 'rev-0',
          stateVector:
            expectation.entityId === 'node-2'
              ? Uint8Array.of(9)
              : Uint8Array.of(1, 2, 3),
          stateHash: HASH_ZERO,
        }),
        mutate,
      }),
    ).rejects.toMatchObject({ code: 'STALE_STATE_VECTOR' });
    await expect(
      freshness.executeGuardedMutation({
        effectId: 'effect-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        readCurrentVersion: async (_tx, expectation) => ({
          revision: 'rev-0',
          stateVector: Uint8Array.of(1, 2, 3),
          stateHash:
            expectation.entityId === 'node-2' ? HASH_ONE : HASH_ZERO,
        }),
        mutate,
      }),
    ).rejects.toMatchObject({ code: 'STALE_STATE_HASH' });
    expect(mutationCalls).toBe(0);
  });

  it(
    'allows at most one writer for each of 1000 concurrent competitions',
    async () => {
      const { gateway, client, freshness } = setup();
      const scenarioCount = 1_000;
      const observations = Array.from(
        { length: scenarioCount },
        (_, index) => ({
          id: `race-observation-${index}`,
          entityKind: 'node',
          entityId: `race-node-${index}`,
          revision: 'rev-0',
        }),
      );
      await freshness.persistReadReceipt({
        ...createReceiptInput(),
        result: { count: scenarioCount },
        observations,
      });

      gateway.database.exec('BEGIN IMMEDIATE');
      try {
        const insertNode = gateway.database.prepare(`
          INSERT INTO book_node
            (id, title, summary, project_id, created_at, updated_at,
             position_x, position_y)
          VALUES (?, ?, '', 'project-1', '2026-07-30', 'rev-0', 0, 0)
        `);
        const insertTool = gateway.database.prepare(`
          INSERT INTO agent_runtime_tool_call
            (id, session_id, turn_id, call_id, name, access, status,
             idempotency_key, arguments_json, created_at, started_at)
          VALUES (?, 'session-1', 'turn-1', ?, 'rename_node', 'write',
                  'running', ?, '{}', '2026-07-30', '2026-07-30')
        `);
        const insertEffect = gateway.database.prepare(`
          INSERT INTO agent_runtime_write_effect
            (id, project_id, route_kind, conversation_id, session_id, turn_id,
             tool_call_id, call_id, tool_name, idempotency_key, phase,
             arguments_json, claimed_at, confirmed_at, updated_at)
          VALUES (?, 'project-1', 'chat', 'conversation-1', 'session-1',
                  'turn-1', ?, ?, 'rename_node', ?, 'confirmed', '{}',
                  '2026-07-30', '2026-07-30', '2026-07-30')
        `);
        const insertExpectation = gateway.database.prepare(`
          INSERT INTO agent_runtime_write_expectation
            (id, effect_id, project_id, session_id, write_turn_id,
             write_tool_call_id, observation_id, read_receipt_id, read_turn_id,
             read_tool_call_id, entity_kind, entity_id, expected_revision,
             created_at)
          VALUES (?, ?, 'project-1', 'session-1', 'turn-1', ?,
                  ?, 'receipt-1', 'turn-1', 'read-tool-1', 'node', ?,
                  'rev-0', '2026-07-30')
        `);

        for (let index = 0; index < scenarioCount; index += 1) {
          insertNode.run(`race-node-${index}`, `Race ${index}`);
          for (const contender of ['a', 'b']) {
            const callId = `race-call-${index}-${contender}`;
            const toolCallId = `race-tool-${index}-${contender}`;
            const idempotencyKey = `session-1:turn-1:${callId}`;
            const effectId = `race-effect-${index}-${contender}`;
            insertTool.run(
              toolCallId,
              callId,
              idempotencyKey,
            );
            insertEffect.run(
              effectId,
              toolCallId,
              callId,
              idempotencyKey,
            );
            insertExpectation.run(
              `race-expectation-${index}-${contender}`,
              effectId,
              toolCallId,
              `race-observation-${index}`,
              `race-node-${index}`,
            );
          }
        }
        gateway.database.exec('COMMIT');
      } catch (error) {
        gateway.database.exec('ROLLBACK');
        throw error;
      }

      let mutationCalls = 0;
      const outcomes = await Promise.all(
        Array.from({ length: scenarioCount }, async (_, index) => {
          const contenders =
            index % 2 === 0
              ? (['a', 'b'] as const)
              : (['b', 'a'] as const);
          return Promise.all(
            contenders.map(async (contender) => {
              const effectId = `race-effect-${index}-${contender}`;
              try {
                await freshness.executeGuardedMutation({
                  effectId,
                  projectId: 'project-1',
                  sessionId: 'session-1',
                  readCurrentVersion: async (tx, expectation) => {
                    const rows = await tx
                      .select({
                        projectId: BookNodeTable.projectId,
                        revision: BookNodeTable.updatedAt,
                      })
                      .from(BookNodeTable)
                      .where(
                        and(
                          eq(
                            BookNodeTable.id,
                            expectation.entityId,
                          ),
                          eq(BookNodeTable.projectId, 'project-1'),
                        ),
                      )
                      .limit(1);
                    return rows[0]
                      ? { revision: rows[0].revision }
                      : null;
                  },
                  mutate: async (tx, expectationsForWrite) => {
                    mutationCalls += 1;
                    const [expectation] = expectationsForWrite;
                    await tx
                      .update(BookNodeTable)
                      .set({
                        summary: effectId,
                        updatedAt: 'rev-1',
                      })
                      .where(
                        and(
                          eq(BookNodeTable.id, expectation.entityId),
                          eq(BookNodeTable.projectId, 'project-1'),
                        ),
                      );
                    await tx
                      .update(AgentRuntimeWriteEffectTable)
                      .set({
                        phase: 'effect_committed',
                        observedRevisionJson: '"rev-0"',
                        preimageJson: '{}',
                        forwardJson: '{}',
                        inverseJson: '{}',
                        reversibility: 'exact',
                        effectJson: `{"entityId":"${expectation.entityId}"}`,
                        mutationStartedAt: '2026-07-30',
                        effectCommittedAt: '2026-07-30',
                        updatedAt: '2026-07-30',
                      })
                      .where(eq(AgentRuntimeWriteEffectTable.id, effectId));
                    await tx.run(sql`
                      INSERT INTO freshness_outbox
                        (id, effect_id, entity_id, created_at)
                      VALUES (
                        ${`outbox:${effectId}`},
                        ${effectId},
                        ${expectation.entityId},
                        '2026-07-30'
                      )
                    `);
                  },
                });
                return 'committed' as const;
              } catch (error) {
                if (
                  error instanceof AgentRuntimeFreshnessError &&
                  error.code === 'STALE_REVISION'
                ) {
                  return 'stale' as const;
                }
                throw error;
              }
            }),
          );
        }),
      );

      const flattened = outcomes.flat();
      expect(
        flattened.filter((outcome) => outcome === 'committed'),
      ).toHaveLength(scenarioCount);
      expect(
        flattened.filter((outcome) => outcome === 'stale'),
      ).toHaveLength(scenarioCount);
      expect(mutationCalls).toBe(scenarioCount);

      const nodeStats = gateway.database
        .prepare(`
          SELECT
            count(*) AS total,
            sum(CASE WHEN updated_at = 'rev-1' THEN 1 ELSE 0 END) AS advanced,
            count(DISTINCT summary) AS distinct_effects
          FROM book_node
          WHERE project_id = 'project-1'
        `)
        .get() as {
        total: number;
        advanced: number;
        distinct_effects: number;
      };
      const effectStats = gateway.database
        .prepare(`
          SELECT
            sum(CASE WHEN phase = 'effect_committed' THEN 1 ELSE 0 END) AS committed,
            sum(CASE WHEN phase = 'confirmed' THEN 1 ELSE 0 END) AS stale
          FROM agent_runtime_write_effect
          WHERE id LIKE 'race-effect-%'
        `)
        .get() as { committed: number; stale: number };
      const outboxCount = gateway.database
        .prepare('SELECT count(*) AS count FROM freshness_outbox')
        .get() as { count: number };

      expect(nodeStats).toEqual({
        total: scenarioCount,
        advanced: scenarioCount,
        distinct_effects: scenarioCount,
      });
      expect(effectStats).toEqual({
        committed: scenarioCount,
        stale: scenarioCount,
      });
      expect(outboxCount.count).toBe(scenarioCount);

      const projectCrossover = await client
        .select({ count: sql<number>`count(*)` })
        .from(BookNodeTable)
        .where(eq(BookNodeTable.projectId, 'project-2'));
      expect(Number(projectCrossover[0]?.count ?? -1)).toBe(0);
      expect(
        gateway.database.prepare('PRAGMA foreign_key_check').all(),
      ).toEqual([]);
    },
    60_000,
  );
});
