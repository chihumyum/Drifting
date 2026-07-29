import { asc, eq, inArray, or } from 'drizzle-orm';

import type {
  AgentRuntimeCurrentEntityVersion,
  AttachAgentRuntimeWriteExpectations,
  CreateAgentRuntimeReadObservation,
  CreateAgentRuntimeReadReceipt,
  PersistedAgentRuntimeReadObservation,
  PersistedAgentRuntimeReadReceipt,
  PersistedAgentRuntimeWriteExpectation,
} from '../domain/agent-runtime-freshness';
import { getDb, type DbExecutor } from '../lib/db';
import {
  AgentRuntimeReadObservationTable,
  AgentRuntimeReadReceiptTable,
  AgentRuntimeSessionTable,
  AgentRuntimeToolCallTable,
  AgentRuntimeWriteEffectTable,
  AgentRuntimeWriteExpectationTable,
} from '../schema/drizzle';
import { canonicalAgentRuntimeJson } from './agent-runtime-persistence-repo';

export type AgentRuntimeFreshnessPersistenceOutcome =
  | 'inserted'
  | 'duplicate';

export class AgentRuntimeFreshnessError extends Error {
  constructor(
    readonly code:
      | 'INVALID_READ_RECEIPT'
      | 'READ_PROVENANCE_MISMATCH'
      | 'READ_RECEIPT_CONFLICT'
      | 'READ_RESULT_INTEGRITY'
      | 'WRITE_EXPECTATION_CONFLICT'
      | 'FRESHNESS_PROVENANCE_MISMATCH'
      | 'MISSING_EXPECTATIONS'
      | 'ENTITY_MISSING'
      | 'STALE_REVISION'
      | 'STALE_STATE_VECTOR'
      | 'STALE_STATE_HASH',
    message: string,
  ) {
    super(message);
    this.name = 'AgentRuntimeFreshnessError';
  }
}

export interface PersistAgentRuntimeReadReceiptResult {
  outcome: AgentRuntimeFreshnessPersistenceOutcome;
  receipt: PersistedAgentRuntimeReadReceipt;
}

export interface AttachAgentRuntimeWriteExpectationsResult {
  outcome: AgentRuntimeFreshnessPersistenceOutcome;
  expectations: PersistedAgentRuntimeWriteExpectation[];
}

/**
 * Entity-specific readers are injected by renderer usecases. They MUST read
 * through the supplied executor; using getDb(), a store snapshot, or another
 * connection would reopen the check-then-write race this boundary prevents.
 */
export type AgentRuntimeCurrentVersionReader = (
  tx: DbExecutor,
  expectation: PersistedAgentRuntimeWriteExpectation,
) => Promise<AgentRuntimeCurrentEntityVersion | null>;

export interface ExecuteAgentRuntimeGuardedMutation<T> {
  effectId: string;
  projectId: string;
  sessionId: string;
  readCurrentVersion: AgentRuntimeCurrentVersionReader;
  mutate: (
    tx: DbExecutor,
    expectations: readonly PersistedAgentRuntimeWriteExpectation[],
  ) => Promise<T>;
}

export interface AgentRuntimeFreshnessRepository {
  persistReadReceipt(
    input: CreateAgentRuntimeReadReceipt,
  ): Promise<PersistAgentRuntimeReadReceiptResult>;
  getReadReceipt(
    id: string,
  ): Promise<PersistedAgentRuntimeReadReceipt | null>;
  attachWriteExpectations(
    input: AttachAgentRuntimeWriteExpectations,
  ): Promise<AttachAgentRuntimeWriteExpectationsResult>;
  listWriteExpectations(
    effectId: string,
  ): Promise<PersistedAgentRuntimeWriteExpectation[]>;
  /**
   * Loads and verifies every immutable expectation, re-reads every target, and
   * invokes the mutation callback inside one BEGIN IMMEDIATE transaction.
   * A failed check rolls back the callback and all transaction-bound side
   * effects (projection, write receipt, and outbox).
   */
  executeGuardedMutation<T>(
    input: ExecuteAgentRuntimeGuardedMutation<T>,
  ): Promise<T>;
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

function copyBytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

function normalizeBlob(value: unknown, path: string): Uint8Array {
  if (value instanceof Uint8Array) return copyBytes(value);
  if (value instanceof ArrayBuffer) {
    return copyBytes(new Uint8Array(value));
  }
  if (ArrayBuffer.isView(value)) {
    return copyBytes(
      new Uint8Array(
        value.buffer,
        value.byteOffset,
        value.byteLength,
      ),
    );
  }
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (
    value &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'Buffer' &&
    Array.isArray((value as { data?: unknown }).data)
  ) {
    return Uint8Array.from((value as { data: number[] }).data);
  }
  throw new AgentRuntimeFreshnessError(
    'READ_RESULT_INTEGRITY',
    `${path} is not a supported SQLite blob.`,
  );
}

function bytesEqual(
  left: Uint8Array | null,
  right: Uint8Array | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new AgentRuntimeFreshnessError(
      'READ_RESULT_INTEGRITY',
      'Web Crypto SHA-256 is unavailable; Agent read results cannot be verified.',
    );
  }
  const digest = await subtle.digest('SHA-256', bytes as BufferSource);
  return `sha256:${bytesToHex(new Uint8Array(digest))}`;
}

function normalizedOptionalBlob(
  value: Uint8Array | null | undefined,
  path: string,
): Uint8Array | null {
  if (value === null || value === undefined) return null;
  const normalized = normalizeBlob(value, path);
  if (normalized.byteLength === 0) {
    throw new AgentRuntimeFreshnessError(
      'INVALID_READ_RECEIPT',
      `${path} must not be empty.`,
    );
  }
  return normalized;
}

function assertNonEmpty(value: string, path: string): void {
  if (value.trim().length === 0) {
    throw new AgentRuntimeFreshnessError(
      'INVALID_READ_RECEIPT',
      `${path} must not be empty.`,
    );
  }
}

function assertOptionalHash(
  value: string | null | undefined,
  path: string,
): void {
  if (value !== null && value !== undefined && !SHA256_PATTERN.test(value)) {
    throw new AgentRuntimeFreshnessError(
      'INVALID_READ_RECEIPT',
      `${path} must be a lowercase sha256 hash.`,
    );
  }
}

function normalizeCreateObservations(
  observations: readonly CreateAgentRuntimeReadObservation[],
): Array<{
  id: string;
  ordinal: number;
  entityKind: string;
  entityId: string;
  revision: string;
  stateVector: Uint8Array | null;
  stateHash: string | null;
}> {
  const ids = new Set<string>();
  const entities = new Set<string>();
  return observations.map((observation, ordinal) => {
    assertNonEmpty(observation.id, `observations[${ordinal}].id`);
    assertNonEmpty(
      observation.entityKind,
      `observations[${ordinal}].entityKind`,
    );
    assertNonEmpty(
      observation.entityId,
      `observations[${ordinal}].entityId`,
    );
    assertNonEmpty(
      observation.revision,
      `observations[${ordinal}].revision`,
    );
    assertOptionalHash(
      observation.stateHash,
      `observations[${ordinal}].stateHash`,
    );
    const entityKey = `${observation.entityKind}\u0000${observation.entityId}`;
    if (ids.has(observation.id) || entities.has(entityKey)) {
      throw new AgentRuntimeFreshnessError(
        'INVALID_READ_RECEIPT',
        `Read receipt contains a duplicate observation at ordinal ${ordinal}.`,
      );
    }
    ids.add(observation.id);
    entities.add(entityKey);
    return {
      id: observation.id,
      ordinal,
      entityKind: observation.entityKind,
      entityId: observation.entityId,
      revision: observation.revision,
      stateVector: normalizedOptionalBlob(
        observation.stateVector,
        `observations[${ordinal}].stateVector`,
      ),
      stateHash: observation.stateHash ?? null,
    };
  });
}

function observationToDomain(
  row: typeof AgentRuntimeReadObservationTable.$inferSelect,
): PersistedAgentRuntimeReadObservation {
  return {
    id: row.id,
    receiptId: row.receiptId,
    projectId: row.projectId,
    sessionId: row.sessionId,
    turnId: row.turnId,
    toolCallId: row.toolCallId,
    ordinal: row.ordinal,
    entityKind: row.entityKind,
    entityId: row.entityId,
    revision: row.revision,
    stateVector:
      row.stateVector === null
        ? null
        : normalizeBlob(row.stateVector, `observation ${row.id} state vector`),
    stateHash: row.stateHash ?? null,
    createdAt: row.createdAt,
  };
}

function expectationToDomain(
  row: typeof AgentRuntimeWriteExpectationTable.$inferSelect,
): PersistedAgentRuntimeWriteExpectation {
  return {
    id: row.id,
    effectId: row.effectId,
    projectId: row.projectId,
    sessionId: row.sessionId,
    writeTurnId: row.writeTurnId,
    writeToolCallId: row.writeToolCallId,
    observationId: row.observationId,
    readReceiptId: row.readReceiptId,
    readTurnId: row.readTurnId,
    readToolCallId: row.readToolCallId,
    entityKind: row.entityKind,
    entityId: row.entityId,
    expectedRevision: row.expectedRevision,
    expectedStateVector:
      row.expectedStateVector === null
        ? null
        : normalizeBlob(
            row.expectedStateVector,
            `expectation ${row.id} state vector`,
          ),
    expectedStateHash: row.expectedStateHash ?? null,
    createdAt: row.createdAt,
  };
}

function sameObservation(
  persisted: PersistedAgentRuntimeReadObservation,
  expected: ReturnType<typeof normalizeCreateObservations>[number],
): boolean {
  return (
    persisted.id === expected.id &&
    persisted.ordinal === expected.ordinal &&
    persisted.entityKind === expected.entityKind &&
    persisted.entityId === expected.entityId &&
    persisted.revision === expected.revision &&
    bytesEqual(persisted.stateVector, expected.stateVector) &&
    persisted.stateHash === expected.stateHash
  );
}

function sameExpectationSet(
  persisted: readonly PersistedAgentRuntimeWriteExpectation[],
  requested: readonly { id: string; observationId: string }[],
): boolean {
  if (persisted.length !== requested.length) return false;
  const requestedById = new Map(
    requested.map((expectation) => [
      expectation.id,
      expectation.observationId,
    ]),
  );
  return persisted.every(
    (expectation) =>
      requestedById.get(expectation.id) === expectation.observationId,
  );
}

function assertCurrentVersion(
  version: AgentRuntimeCurrentEntityVersion,
  expectation: PersistedAgentRuntimeWriteExpectation,
): {
  revision: string;
  stateVector: Uint8Array | null;
  stateHash: string | null;
} {
  if (typeof version.revision !== 'string' || version.revision.length === 0) {
    throw new AgentRuntimeFreshnessError(
      'FRESHNESS_PROVENANCE_MISMATCH',
      `Current revision for ${expectation.entityKind}:${expectation.entityId} is invalid.`,
    );
  }
  assertOptionalHash(
    version.stateHash,
    `current ${expectation.entityKind}:${expectation.entityId} stateHash`,
  );
  return {
    revision: version.revision,
    stateVector: normalizedOptionalBlob(
      version.stateVector,
      `current ${expectation.entityKind}:${expectation.entityId} stateVector`,
    ),
    stateHash: version.stateHash ?? null,
  };
}

export function createAgentRuntimeFreshnessRepository(
  dbOverride?: DbExecutor,
): AgentRuntimeFreshnessRepository {
  const dbProvider = (): DbExecutor => dbOverride ?? getDb();

  const listObservations = async (
    receiptId: string,
    executor: DbExecutor,
  ): Promise<PersistedAgentRuntimeReadObservation[]> => {
    const rows = await executor
      .select()
      .from(AgentRuntimeReadObservationTable)
      .where(eq(AgentRuntimeReadObservationTable.receiptId, receiptId))
      .orderBy(asc(AgentRuntimeReadObservationTable.ordinal));
    return rows.map(observationToDomain);
  };

  const loadVerifiedReadReceipt = async (
    id: string,
    executor: DbExecutor,
  ): Promise<{
    row: typeof AgentRuntimeReadReceiptTable.$inferSelect;
    resultBlob: Uint8Array;
    result: unknown;
  } | null> => {
    const rows = await executor
      .select()
      .from(AgentRuntimeReadReceiptTable)
      .where(eq(AgentRuntimeReadReceiptTable.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;

    const resultBlob = normalizeBlob(
      row.resultBlob,
      `read receipt ${id} result`,
    );
    const actualHash = await sha256(resultBlob);
    if (actualHash !== row.resultHash) {
      throw new AgentRuntimeFreshnessError(
        'READ_RESULT_INTEGRITY',
        `Read receipt ${id} failed result hash verification.`,
      );
    }

    let result: unknown;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(resultBlob);
      result = JSON.parse(text) as unknown;
      if (canonicalAgentRuntimeJson(result) !== text) {
        throw new Error('result is not canonical JSON');
      }
    } catch (cause) {
      throw new AgentRuntimeFreshnessError(
        'READ_RESULT_INTEGRITY',
        `Read receipt ${id} contains an invalid canonical JSON result: ${cause instanceof Error ? cause.message : String(cause)}.`,
      );
    }

    return { row, resultBlob, result };
  };

  const getReadReceipt = async (
    id: string,
    executor: DbExecutor = dbProvider(),
  ): Promise<PersistedAgentRuntimeReadReceipt | null> => {
    const verified = await loadVerifiedReadReceipt(id, executor);
    if (!verified) return null;
    const { row, resultBlob, result } = verified;
    return {
      id: row.id,
      projectId: row.projectId,
      sessionId: row.sessionId,
      turnId: row.turnId,
      toolCallId: row.toolCallId,
      callId: row.callId,
      toolName: row.toolName,
      idempotencyKey: row.idempotencyKey,
      resultBlob,
      resultHash: row.resultHash,
      result,
      observations: await listObservations(id, executor),
      createdAt: row.createdAt,
    };
  };

  const listWriteExpectationsRaw = async (
    effectId: string,
    executor: DbExecutor = dbProvider(),
  ): Promise<PersistedAgentRuntimeWriteExpectation[]> => {
    const rows = await executor
      .select()
      .from(AgentRuntimeWriteExpectationTable)
      .where(eq(AgentRuntimeWriteExpectationTable.effectId, effectId))
      .orderBy(
        asc(AgentRuntimeWriteExpectationTable.entityKind),
        asc(AgentRuntimeWriteExpectationTable.entityId),
        asc(AgentRuntimeWriteExpectationTable.id),
      );
    return rows.map(expectationToDomain);
  };

  const listWriteExpectations = async (
    effectId: string,
    executor: DbExecutor = dbProvider(),
  ): Promise<PersistedAgentRuntimeWriteExpectation[]> => {
    const expectations = await listWriteExpectationsRaw(effectId, executor);
    if (expectations.length === 0) return expectations;

    const observationRows = await executor
      .select()
      .from(AgentRuntimeReadObservationTable)
      .where(
        inArray(
          AgentRuntimeReadObservationTable.id,
          expectations.map((expectation) => expectation.observationId),
        ),
      );
    if (observationRows.length !== expectations.length) {
      throw new AgentRuntimeFreshnessError(
        'FRESHNESS_PROVENANCE_MISMATCH',
        `Write effect ${effectId} lost one or more read observations.`,
      );
    }
    const observationsById = new Map(
      observationRows.map((row) => [row.id, observationToDomain(row)]),
    );
    for (const expectation of expectations) {
      const observation = observationsById.get(expectation.observationId);
      if (
        !observation ||
        observation.receiptId !== expectation.readReceiptId ||
        observation.projectId !== expectation.projectId ||
        observation.sessionId !== expectation.sessionId ||
        observation.turnId !== expectation.readTurnId ||
        observation.toolCallId !== expectation.readToolCallId ||
        observation.entityKind !== expectation.entityKind ||
        observation.entityId !== expectation.entityId ||
        observation.revision !== expectation.expectedRevision ||
        !bytesEqual(
          observation.stateVector,
          expectation.expectedStateVector,
        ) ||
        observation.stateHash !== expectation.expectedStateHash
      ) {
        throw new AgentRuntimeFreshnessError(
          'FRESHNESS_PROVENANCE_MISMATCH',
          `Write expectation ${expectation.id} drifted from observation ${expectation.observationId}.`,
        );
      }
    }
    return expectations;
  };

  return {
    async persistReadReceipt(input) {
      for (const [path, value] of Object.entries({
        id: input.id,
        projectId: input.projectId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        toolCallId: input.toolCallId,
        callId: input.callId,
        toolName: input.toolName,
        idempotencyKey: input.idempotencyKey,
      })) {
        assertNonEmpty(value, path);
      }
      const normalizedObservations = normalizeCreateObservations(
        input.observations,
      );
      const resultBlob = new TextEncoder().encode(
        canonicalAgentRuntimeJson(input.result),
      );
      const resultHash = await sha256(resultBlob);

      return dbProvider().transaction(async (tx) => {
        const existingRows = await tx
          .select({ id: AgentRuntimeReadReceiptTable.id })
          .from(AgentRuntimeReadReceiptTable)
          .where(
            or(
              eq(AgentRuntimeReadReceiptTable.id, input.id),
              eq(
                AgentRuntimeReadReceiptTable.toolCallId,
                input.toolCallId,
              ),
              eq(
                AgentRuntimeReadReceiptTable.idempotencyKey,
                input.idempotencyKey,
              ),
            ),
          );
        if (existingRows.length > 0) {
          if (existingRows.length === 1) {
            const existing = await getReadReceipt(existingRows[0].id, tx);
            if (
              existing &&
              existing.id === input.id &&
              existing.projectId === input.projectId &&
              existing.sessionId === input.sessionId &&
              existing.turnId === input.turnId &&
              existing.toolCallId === input.toolCallId &&
              existing.callId === input.callId &&
              existing.toolName === input.toolName &&
              existing.idempotencyKey === input.idempotencyKey &&
              existing.resultHash === resultHash &&
              bytesEqual(existing.resultBlob, resultBlob) &&
              existing.observations.length ===
                normalizedObservations.length &&
              existing.observations.every((observation, index) =>
                sameObservation(
                  observation,
                  normalizedObservations[index],
                ),
              )
            ) {
              return {
                outcome: 'duplicate' as const,
                receipt: existing,
              };
            }
          }
          throw new AgentRuntimeFreshnessError(
            'READ_RECEIPT_CONFLICT',
            `Read receipt ${input.id} conflicts with durable read state.`,
          );
        }

        const sessions = await tx
          .select({
            id: AgentRuntimeSessionTable.id,
            projectId: AgentRuntimeSessionTable.projectId,
          })
          .from(AgentRuntimeSessionTable)
          .where(eq(AgentRuntimeSessionTable.id, input.sessionId))
          .limit(1);
        const toolCalls = await tx
          .select()
          .from(AgentRuntimeToolCallTable)
          .where(eq(AgentRuntimeToolCallTable.id, input.toolCallId))
          .limit(1);
        const session = sessions[0];
        const toolCall = toolCalls[0];
        if (
          !session ||
          session.projectId !== input.projectId ||
          !toolCall ||
          toolCall.sessionId !== input.sessionId ||
          toolCall.turnId !== input.turnId ||
          toolCall.callId !== input.callId ||
          toolCall.name !== input.toolName ||
          toolCall.access !== 'read' ||
          (toolCall.status !== 'running' &&
            toolCall.status !== 'completed') ||
          toolCall.idempotencyKey !== input.idempotencyKey
        ) {
          throw new AgentRuntimeFreshnessError(
            'READ_PROVENANCE_MISMATCH',
            `Read receipt ${input.id} does not match its project/session/turn/tool call provenance.`,
          );
        }

        await tx.insert(AgentRuntimeReadReceiptTable).values({
          id: input.id,
          projectId: input.projectId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          toolCallId: input.toolCallId,
          callId: input.callId,
          toolName: input.toolName,
          toolAccess: 'read',
          idempotencyKey: input.idempotencyKey,
          resultBlob,
          resultHash,
          createdAt: input.createdAt,
        });
        if (normalizedObservations.length > 0) {
          await tx.insert(AgentRuntimeReadObservationTable).values(
            normalizedObservations.map((observation) => ({
              id: observation.id,
              receiptId: input.id,
              projectId: input.projectId,
              sessionId: input.sessionId,
              turnId: input.turnId,
              toolCallId: input.toolCallId,
              ordinal: observation.ordinal,
              entityKind: observation.entityKind,
              entityId: observation.entityId,
              revision: observation.revision,
              stateVector: observation.stateVector,
              stateHash: observation.stateHash,
              createdAt: input.createdAt,
            })),
          );
        }
        const inserted = await getReadReceipt(input.id, tx);
        if (!inserted) {
          throw new Error(`Read receipt ${input.id} was not persisted.`);
        }
        return { outcome: 'inserted' as const, receipt: inserted };
      }, { behavior: 'immediate' });
    },

    getReadReceipt,

    async attachWriteExpectations(input) {
      for (const [path, value] of Object.entries({
        effectId: input.effectId,
        projectId: input.projectId,
        sessionId: input.sessionId,
      })) {
        assertNonEmpty(value, path);
      }
      if (input.observations.length === 0) {
        throw new AgentRuntimeFreshnessError(
          'MISSING_EXPECTATIONS',
          `Write effect ${input.effectId} must cite at least one read observation.`,
        );
      }
      const expectationIds = new Set<string>();
      const observationIds = new Set<string>();
      for (const [index, expectation] of input.observations.entries()) {
        assertNonEmpty(expectation.id, `observations[${index}].id`);
        assertNonEmpty(
          expectation.observationId,
          `observations[${index}].observationId`,
        );
        if (
          expectationIds.has(expectation.id) ||
          observationIds.has(expectation.observationId)
        ) {
          throw new AgentRuntimeFreshnessError(
            'WRITE_EXPECTATION_CONFLICT',
            `Write effect ${input.effectId} contains duplicate expectation links.`,
          );
        }
        expectationIds.add(expectation.id);
        observationIds.add(expectation.observationId);
      }

      return dbProvider().transaction(async (tx) => {
        const effects = await tx
          .select()
          .from(AgentRuntimeWriteEffectTable)
          .where(eq(AgentRuntimeWriteEffectTable.id, input.effectId))
          .limit(1);
        const effect = effects[0];
        if (
          !effect ||
          effect.projectId !== input.projectId ||
          effect.sessionId !== input.sessionId ||
          (effect.phase !== 'claimed' && effect.phase !== 'confirmed')
        ) {
          throw new AgentRuntimeFreshnessError(
            'FRESHNESS_PROVENANCE_MISMATCH',
            `Write effect ${input.effectId} is not an attachable effect in the requested project/session.`,
          );
        }

        const existing = await listWriteExpectations(input.effectId, tx);
        if (existing.length > 0) {
          if (sameExpectationSet(existing, input.observations)) {
            return {
              outcome: 'duplicate' as const,
              expectations: existing,
            };
          }
          throw new AgentRuntimeFreshnessError(
            'WRITE_EXPECTATION_CONFLICT',
            `Write effect ${input.effectId} already has a different freshness expectation set.`,
          );
        }

        const observationRows = await tx
          .select()
          .from(AgentRuntimeReadObservationTable)
          .where(
            inArray(
              AgentRuntimeReadObservationTable.id,
              [...observationIds],
            ),
          );
        if (observationRows.length !== input.observations.length) {
          throw new AgentRuntimeFreshnessError(
            'FRESHNESS_PROVENANCE_MISMATCH',
            `Write effect ${input.effectId} references a missing read observation.`,
          );
        }
        const observationsById = new Map(
          observationRows.map((row) => [row.id, observationToDomain(row)]),
        );

        const values = input.observations.map((requested) => {
          const observation = observationsById.get(requested.observationId);
          if (
            !observation ||
            observation.projectId !== input.projectId ||
            observation.sessionId !== input.sessionId
          ) {
            throw new AgentRuntimeFreshnessError(
              'FRESHNESS_PROVENANCE_MISMATCH',
              `Observation ${requested.observationId} is outside write effect ${input.effectId}'s project/session.`,
            );
          }
          return {
            id: requested.id,
            effectId: effect.id,
            projectId: effect.projectId,
            sessionId: effect.sessionId,
            writeTurnId: effect.turnId,
            writeToolCallId: effect.toolCallId,
            observationId: observation.id,
            readReceiptId: observation.receiptId,
            readTurnId: observation.turnId,
            readToolCallId: observation.toolCallId,
            entityKind: observation.entityKind,
            entityId: observation.entityId,
            expectedRevision: observation.revision,
            expectedStateVector: observation.stateVector,
            expectedStateHash: observation.stateHash,
            createdAt: input.createdAt,
          };
        });

        const receiptIds = [...new Set(values.map((row) => row.readReceiptId))];
        for (const receiptId of receiptIds) {
          const receipt = await loadVerifiedReadReceipt(receiptId, tx);
          if (!receipt) {
            throw new AgentRuntimeFreshnessError(
              'FRESHNESS_PROVENANCE_MISMATCH',
              `Write effect ${input.effectId} lost read receipt ${receiptId}.`,
            );
          }
        }
        await tx.insert(AgentRuntimeWriteExpectationTable).values(values);
        const inserted = await listWriteExpectations(input.effectId, tx);
        if (inserted.length !== values.length) {
          throw new Error(
            `Write expectations for ${input.effectId} were not persisted.`,
          );
        }
        return {
          outcome: 'inserted' as const,
          expectations: inserted,
        };
      }, { behavior: 'immediate' });
    },

    listWriteExpectations,

    async executeGuardedMutation(input) {
      return dbProvider().transaction(async (tx) => {
        const effects = await tx
          .select({
            id: AgentRuntimeWriteEffectTable.id,
            projectId: AgentRuntimeWriteEffectTable.projectId,
            sessionId: AgentRuntimeWriteEffectTable.sessionId,
            phase: AgentRuntimeWriteEffectTable.phase,
          })
          .from(AgentRuntimeWriteEffectTable)
          .where(eq(AgentRuntimeWriteEffectTable.id, input.effectId))
          .limit(1);
        const effect = effects[0];
        if (
          !effect ||
          effect.projectId !== input.projectId ||
          effect.sessionId !== input.sessionId ||
          (effect.phase !== 'confirmed' &&
            effect.phase !== 'mutation_started')
        ) {
          throw new AgentRuntimeFreshnessError(
            'FRESHNESS_PROVENANCE_MISMATCH',
            `Write effect ${input.effectId} is not mutation-ready in the requested project/session.`,
          );
        }

        const expectations = await listWriteExpectations(input.effectId, tx);
        if (expectations.length === 0) {
          throw new AgentRuntimeFreshnessError(
            'MISSING_EXPECTATIONS',
            `Write effect ${input.effectId} has no durable read observations.`,
          );
        }

        const receiptIds = [
          ...new Set(expectations.map((row) => row.readReceiptId)),
        ];
        for (const receiptId of receiptIds) {
          const verified = await loadVerifiedReadReceipt(receiptId, tx);
          const receipt = verified?.row;
          if (
            !receipt ||
            receipt.projectId !== input.projectId ||
            receipt.sessionId !== input.sessionId
          ) {
            throw new AgentRuntimeFreshnessError(
              'FRESHNESS_PROVENANCE_MISMATCH',
              `Write effect ${input.effectId} lost read receipt ${receiptId}.`,
            );
          }
        }

        for (const expectation of expectations) {
          const rawCurrent = await input.readCurrentVersion(tx, expectation);
          if (!rawCurrent) {
            throw new AgentRuntimeFreshnessError(
              'ENTITY_MISSING',
              `${expectation.entityKind}:${expectation.entityId} no longer exists in project ${input.projectId}.`,
            );
          }
          const current = assertCurrentVersion(rawCurrent, expectation);
          if (current.revision !== expectation.expectedRevision) {
            throw new AgentRuntimeFreshnessError(
              'STALE_REVISION',
              `${expectation.entityKind}:${expectation.entityId} expected revision ${expectation.expectedRevision}, received ${current.revision}.`,
            );
          }
          if (
            !bytesEqual(
              current.stateVector,
              expectation.expectedStateVector,
            )
          ) {
            throw new AgentRuntimeFreshnessError(
              'STALE_STATE_VECTOR',
              `${expectation.entityKind}:${expectation.entityId} state vector changed after observation ${expectation.observationId}.`,
            );
          }
          if (current.stateHash !== expectation.expectedStateHash) {
            throw new AgentRuntimeFreshnessError(
              'STALE_STATE_HASH',
              `${expectation.entityKind}:${expectation.entityId} state hash changed after observation ${expectation.observationId}.`,
            );
          }
        }

        return input.mutate(tx, expectations);
      }, { behavior: 'immediate' });
    },
  };
}
