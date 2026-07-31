import { and, asc, eq, inArray, or } from 'drizzle-orm';
import type {
  AgentRuntimeWriteEffectTransition,
  AgentRuntimeWritePersistenceSnapshot,
  AgentRuntimeWriteReviewTransition,
  ClaimAgentRuntimeWriteEffect,
  CreateAgentRuntimeWriteReview,
  PersistedAgentRuntimeWriteEffect,
  PersistedAgentRuntimeWriteReview,
} from '../domain/agent-runtime-write-effect';
import { getDb, type DbExecutor } from '../lib/db';
import {
  AgentRuntimeSessionTable,
  AgentRuntimeToolCallTable,
  AgentRuntimeTurnTable,
  AgentRuntimeWriteEffectTable,
  AgentRuntimeWriteReviewTable,
} from '../schema/drizzle';
import { canonicalAgentRuntimeJson } from './agent-runtime-persistence-repo';

export class AgentRuntimeWritePersistenceConflictError extends Error {
  constructor(
    readonly code:
      | 'EFFECT_CLAIM_CONFLICT'
      | 'CLAIM_PARAMETER_DRIFT'
      | 'WRITE_PROVENANCE_MISMATCH'
      | 'INVALID_EFFECT_TRANSITION'
      | 'REVISION_CONFLICT'
      | 'REVIEW_CONFLICT'
      | 'INVALID_REVIEW_TRANSITION',
    message: string,
  ) {
    super(message);
    this.name = 'AgentRuntimeWritePersistenceConflictError';
  }
}

export type WritePersistenceOutcome = 'inserted' | 'updated' | 'duplicate';

export interface WriteEffectPersistenceResult {
  outcome: WritePersistenceOutcome;
  effect: PersistedAgentRuntimeWriteEffect;
}

export interface WriteReviewPersistenceResult {
  outcome: WritePersistenceOutcome;
  review: PersistedAgentRuntimeWriteReview;
}

export interface InterruptedAgentRuntimeWrites {
  failedBeforeMutation: number;
  uncertainAfterMutationStart: number;
}

export interface AgentRuntimeWriteEffectRepository {
  claimEffect(
    claim: ClaimAgentRuntimeWriteEffect,
  ): Promise<WriteEffectPersistenceResult>;
  getEffect(id: string): Promise<PersistedAgentRuntimeWriteEffect | null>;
  listEffects(sessionId: string): Promise<PersistedAgentRuntimeWriteEffect[]>;
  transitionEffect(
    transition: AgentRuntimeWriteEffectTransition,
  ): Promise<WriteEffectPersistenceResult>;

  createReview(
    review: CreateAgentRuntimeWriteReview,
  ): Promise<WriteReviewPersistenceResult>;
  getReview(id: string): Promise<PersistedAgentRuntimeWriteReview | null>;
  listReviews(sessionId: string): Promise<PersistedAgentRuntimeWriteReview[]>;
  transitionReview(
    transition: AgentRuntimeWriteReviewTransition,
  ): Promise<WriteReviewPersistenceResult>;

  /**
   * Crash settlement is deliberately asymmetric. A write that never entered
   * its mutation is known-failed. Once mutation_started is durable, recovery
   * must reconcile it and may not invoke the handler again blindly.
   */
  interruptSessionWrites(
    sessionId: string,
    interruptedAt: string,
  ): Promise<InterruptedAgentRuntimeWrites>;
  loadSnapshot(sessionId: string): Promise<AgentRuntimeWritePersistenceSnapshot>;
}

function parseJson(json: string): unknown {
  return JSON.parse(json) as unknown;
}

function parseNullableJson(json: string | null): unknown | null {
  return json === null ? null : parseJson(json);
}

function canonicalNullableJson(value: unknown | null): string | null {
  return value === null ? null : canonicalAgentRuntimeJson(value);
}

function effectToDomain(
  row: typeof AgentRuntimeWriteEffectTable.$inferSelect,
): PersistedAgentRuntimeWriteEffect {
  return {
    id: row.id,
    projectId: row.projectId,
    routeKind: row.routeKind as PersistedAgentRuntimeWriteEffect['routeKind'],
    conversationId: row.conversationId ?? null,
    goalRunId: row.goalRunId ?? null,
    chapterId: row.chapterId ?? null,
    sessionId: row.sessionId,
    turnId: row.turnId,
    toolCallId: row.toolCallId,
    callId: row.callId,
    toolName: row.toolName,
    idempotencyKey: row.idempotencyKey,
    phase: row.phase as PersistedAgentRuntimeWriteEffect['phase'],
    arguments: parseJson(row.argumentsJson),
    expectedRevision: parseNullableJson(row.expectedRevisionJson),
    observedRevision: parseNullableJson(row.observedRevisionJson),
    preimage: parseNullableJson(row.preimageJson),
    forward: parseNullableJson(row.forwardJson),
    inverse: parseNullableJson(row.inverseJson),
    reversibility:
      (row.reversibility as PersistedAgentRuntimeWriteEffect['reversibility']) ??
      null,
    effect: parseNullableJson(row.effectJson),
    result: parseNullableJson(row.resultJson),
    errorCode: row.errorCode ?? null,
    errorMessage: row.errorMessage ?? null,
    claimedAt: row.claimedAt,
    confirmedAt: row.confirmedAt ?? null,
    mutationStartedAt: row.mutationStartedAt ?? null,
    effectCommittedAt: row.effectCommittedAt ?? null,
    resultCommittedAt: row.resultCommittedAt ?? null,
    uncertainAt: row.uncertainAt ?? null,
    failedAt: row.failedAt ?? null,
    declinedAt: row.declinedAt ?? null,
    updatedAt: row.updatedAt,
  };
}

function reviewToDomain(
  row: typeof AgentRuntimeWriteReviewTable.$inferSelect,
): PersistedAgentRuntimeWriteReview {
  return {
    id: row.id,
    effectId: row.effectId,
    sessionId: row.sessionId,
    turnId: row.turnId,
    toolCallId: row.toolCallId,
    status: row.status as PersistedAgentRuntimeWriteReview['status'],
    decisionNote: parseNullableJson(row.decisionNoteJson),
    revertEffect: parseNullableJson(row.revertEffectJson),
    errorCode: row.errorCode ?? null,
    errorMessage: row.errorMessage ?? null,
    createdAt: row.createdAt,
    acceptedAt: row.acceptedAt ?? null,
    rejectedAt: row.rejectedAt ?? null,
    revertStartedAt: row.revertStartedAt ?? null,
    settledAt: row.settledAt ?? null,
    updatedAt: row.updatedAt,
  };
}

function sameJson(a: unknown, b: unknown): boolean {
  return canonicalAgentRuntimeJson(a) === canonicalAgentRuntimeJson(b);
}

function assertRouteShape(claim: ClaimAgentRuntimeWriteEffect): void {
  const valid =
    claim.routeKind === 'chat'
      ? Boolean(claim.conversationId) &&
        claim.goalRunId === null &&
        claim.chapterId === null
      : claim.conversationId === null;
  if (!valid) {
    throw new AgentRuntimeWritePersistenceConflictError(
      'WRITE_PROVENANCE_MISMATCH',
      `Write effect ${claim.id} has an invalid ${claim.routeKind} route shape.`,
    );
  }
}

function sameClaimIdentity(
  effect: PersistedAgentRuntimeWriteEffect,
  claim: ClaimAgentRuntimeWriteEffect,
): boolean {
  return (
    effect.projectId === claim.projectId &&
    effect.routeKind === claim.routeKind &&
    effect.conversationId === claim.conversationId &&
    effect.goalRunId === claim.goalRunId &&
    effect.chapterId === claim.chapterId &&
    effect.sessionId === claim.sessionId &&
    effect.turnId === claim.turnId &&
    effect.toolCallId === claim.toolCallId &&
    effect.callId === claim.callId &&
    effect.toolName === claim.toolName &&
    effect.idempotencyKey === claim.idempotencyKey &&
    sameJson(effect.arguments, claim.arguments) &&
    sameJson(effect.expectedRevision, claim.expectedRevision)
  );
}

function sameEffectTransitionResult(
  effect: PersistedAgentRuntimeWriteEffect,
  transition: AgentRuntimeWriteEffectTransition,
): boolean {
  if (effect.phase !== transition.nextPhase) return false;
  switch (transition.nextPhase) {
    case 'confirmed':
    case 'declined':
      return true;
    case 'mutation_started':
      return (
        sameJson(effect.observedRevision, transition.observedRevision) &&
        sameJson(effect.preimage, transition.preimage) &&
        sameJson(effect.forward, transition.forward) &&
        sameJson(effect.inverse, transition.inverse) &&
        effect.reversibility === transition.reversibility
      );
    case 'effect_committed':
      return sameJson(effect.effect, transition.effect);
    case 'result_committed':
      return sameJson(effect.result, transition.result);
    case 'failed':
    case 'uncertain':
      return (
        effect.errorCode === transition.errorCode &&
        effect.errorMessage === (transition.errorMessage ?? null)
      );
  }
}

function sameReviewTransitionResult(
  review: PersistedAgentRuntimeWriteReview,
  transition: AgentRuntimeWriteReviewTransition,
): boolean {
  if (review.status !== transition.nextStatus) return false;
  switch (transition.nextStatus) {
    case 'accepted':
    case 'rejected':
      return sameJson(
        review.decisionNote,
        transition.decisionNote === undefined
          ? null
          : transition.decisionNote,
      );
    case 'accepted_effect':
    case 'revert_started':
      return true;
    case 'reverted':
      return sameJson(review.revertEffect, transition.revertEffect);
    case 'revert_failed':
    case 'revert_unavailable':
      return (
        review.errorCode === transition.errorCode &&
        review.errorMessage === (transition.errorMessage ?? null)
      );
  }
}

export function createAgentRuntimeWriteEffectRepository(
  dbOverride?: DbExecutor,
): AgentRuntimeWriteEffectRepository {
  const dbProvider = () => dbOverride ?? getDb();

  const getEffect = async (
    id: string,
    executor: DbExecutor = dbProvider(),
  ): Promise<PersistedAgentRuntimeWriteEffect | null> => {
    const rows = await executor
      .select()
      .from(AgentRuntimeWriteEffectTable)
      .where(eq(AgentRuntimeWriteEffectTable.id, id))
      .limit(1);
    return rows[0] ? effectToDomain(rows[0]) : null;
  };

  const getReview = async (
    id: string,
    executor: DbExecutor = dbProvider(),
  ): Promise<PersistedAgentRuntimeWriteReview | null> => {
    const rows = await executor
      .select()
      .from(AgentRuntimeWriteReviewTable)
      .where(eq(AgentRuntimeWriteReviewTable.id, id))
      .limit(1);
    return rows[0] ? reviewToDomain(rows[0]) : null;
  };

  const listEffects = async (
    sessionId: string,
    executor: DbExecutor = dbProvider(),
  ): Promise<PersistedAgentRuntimeWriteEffect[]> => {
    const rows = await executor
      .select()
      .from(AgentRuntimeWriteEffectTable)
      .where(eq(AgentRuntimeWriteEffectTable.sessionId, sessionId))
      .orderBy(
        asc(AgentRuntimeWriteEffectTable.claimedAt),
        asc(AgentRuntimeWriteEffectTable.id),
      );
    return rows.map(effectToDomain);
  };

  const listReviews = async (
    sessionId: string,
    executor: DbExecutor = dbProvider(),
  ): Promise<PersistedAgentRuntimeWriteReview[]> => {
    const rows = await executor
      .select()
      .from(AgentRuntimeWriteReviewTable)
      .where(eq(AgentRuntimeWriteReviewTable.sessionId, sessionId))
      .orderBy(
        asc(AgentRuntimeWriteReviewTable.createdAt),
        asc(AgentRuntimeWriteReviewTable.id),
      );
    return rows.map(reviewToDomain);
  };

  return {
    async claimEffect(claim) {
      assertRouteShape(claim);
      const argumentsJson = canonicalAgentRuntimeJson(claim.arguments);
      const expectedRevisionJson = canonicalNullableJson(
        claim.expectedRevision,
      );

      return dbProvider().transaction(async (tx) => {
        const existingRows = await tx
          .select()
          .from(AgentRuntimeWriteEffectTable)
          .where(
            or(
              eq(AgentRuntimeWriteEffectTable.id, claim.id),
              eq(
                AgentRuntimeWriteEffectTable.toolCallId,
                claim.toolCallId,
              ),
              eq(
                AgentRuntimeWriteEffectTable.idempotencyKey,
                claim.idempotencyKey,
              ),
              and(
                eq(AgentRuntimeWriteEffectTable.turnId, claim.turnId),
                eq(AgentRuntimeWriteEffectTable.callId, claim.callId),
              ),
            ),
          );
        if (existingRows.length > 0) {
          if (existingRows.length === 1) {
            const existing = effectToDomain(existingRows[0]);
            if (sameClaimIdentity(existing, claim)) {
              return { outcome: 'duplicate' as const, effect: existing };
            }
            if (existing.idempotencyKey === claim.idempotencyKey) {
              throw new AgentRuntimeWritePersistenceConflictError(
                'CLAIM_PARAMETER_DRIFT',
                `Write idempotency key ${claim.idempotencyKey} was reused with different parameters.`,
              );
            }
          }
          throw new AgentRuntimeWritePersistenceConflictError(
            'EFFECT_CLAIM_CONFLICT',
            `Write effect ${claim.id} conflicts with durable call provenance.`,
          );
        }

        const sessions = await tx
          .select()
          .from(AgentRuntimeSessionTable)
          .where(eq(AgentRuntimeSessionTable.id, claim.sessionId))
          .limit(1);
        const session = sessions[0];
        if (
          !session ||
          session.projectId !== claim.projectId ||
          session.routeKind !== claim.routeKind ||
          (session.conversationId ?? null) !== claim.conversationId ||
          (session.goalRunId ?? null) !== claim.goalRunId ||
          (session.chapterId ?? null) !== claim.chapterId
        ) {
          throw new AgentRuntimeWritePersistenceConflictError(
            'WRITE_PROVENANCE_MISMATCH',
            `Write effect ${claim.id} does not match session ${claim.sessionId}'s canonical route.`,
          );
        }

        const turns = await tx
          .select()
          .from(AgentRuntimeTurnTable)
          .where(eq(AgentRuntimeTurnTable.id, claim.turnId))
          .limit(1);
        if (!turns[0] || turns[0].sessionId !== claim.sessionId) {
          throw new AgentRuntimeWritePersistenceConflictError(
            'WRITE_PROVENANCE_MISMATCH',
            `Write effect ${claim.id} does not match turn ${claim.turnId}.`,
          );
        }

        const toolCalls = await tx
          .select()
          .from(AgentRuntimeToolCallTable)
          .where(eq(AgentRuntimeToolCallTable.id, claim.toolCallId))
          .limit(1);
        const toolCall = toolCalls[0];
        if (
          !toolCall ||
          toolCall.sessionId !== claim.sessionId ||
          toolCall.turnId !== claim.turnId ||
          toolCall.callId !== claim.callId ||
          toolCall.name !== claim.toolName ||
          toolCall.access !== 'write' ||
          (toolCall.status !== 'requested' &&
            toolCall.status !== 'running') ||
          toolCall.idempotencyKey !== claim.idempotencyKey ||
          toolCall.argumentsJson !== argumentsJson
        ) {
          throw new AgentRuntimeWritePersistenceConflictError(
            'WRITE_PROVENANCE_MISMATCH',
            `Write effect ${claim.id} does not match requested write tool call ${claim.toolCallId}.`,
          );
        }

        await tx.insert(AgentRuntimeWriteEffectTable).values({
          id: claim.id,
          projectId: claim.projectId,
          routeKind: claim.routeKind,
          conversationId: claim.conversationId,
          goalRunId: claim.goalRunId,
          chapterId: claim.chapterId,
          sessionId: claim.sessionId,
          turnId: claim.turnId,
          toolCallId: claim.toolCallId,
          callId: claim.callId,
          toolName: claim.toolName,
          toolAccess: 'write',
          idempotencyKey: claim.idempotencyKey,
          phase: 'claimed',
          argumentsJson,
          expectedRevisionJson,
          claimedAt: claim.claimedAt,
          updatedAt: claim.claimedAt,
        });
        const inserted = await getEffect(claim.id, tx);
        if (!inserted) {
          throw new Error(`Write effect ${claim.id} was not persisted.`);
        }
        return { outcome: 'inserted' as const, effect: inserted };
      }, { behavior: 'immediate' });
    },

    getEffect,
    listEffects,

    async transitionEffect(transition) {
      return dbProvider().transaction(async (tx) => {
        const current = await getEffect(transition.effectId, tx);
        if (!current) {
          throw new AgentRuntimeWritePersistenceConflictError(
            'INVALID_EFFECT_TRANSITION',
            `Write effect ${transition.effectId} does not exist.`,
          );
        }
        if (current.phase !== transition.expectedPhase) {
          if (sameEffectTransitionResult(current, transition)) {
            return { outcome: 'duplicate' as const, effect: current };
          }
          throw new AgentRuntimeWritePersistenceConflictError(
            'INVALID_EFFECT_TRANSITION',
            `Write effect ${transition.effectId} expected ${transition.expectedPhase}, found ${current.phase}.`,
          );
        }

        const values: Partial<
          typeof AgentRuntimeWriteEffectTable.$inferInsert
        > = {
          phase: transition.nextPhase,
          updatedAt: transition.at,
        };

        switch (transition.nextPhase) {
          case 'confirmed':
            values.confirmedAt = transition.at;
            break;
          case 'mutation_started': {
            if (
              current.expectedRevision !== null &&
              !sameJson(
                current.expectedRevision,
                transition.observedRevision,
              )
            ) {
              throw new AgentRuntimeWritePersistenceConflictError(
                'REVISION_CONFLICT',
                `Write effect ${current.id} observed a stale target revision.`,
              );
            }
            if (
              (transition.reversibility === 'exact' ||
                transition.reversibility === 'compensating') &&
              transition.inverse === null
            ) {
              throw new AgentRuntimeWritePersistenceConflictError(
                'INVALID_EFFECT_TRANSITION',
                `${transition.reversibility} write effect ${current.id} requires an inverse operation.`,
              );
            }
            if (
              (transition.reversibility === 'irreversible' ||
                transition.reversibility === 'unavailable') &&
              transition.inverse !== null
            ) {
              throw new AgentRuntimeWritePersistenceConflictError(
                'INVALID_EFFECT_TRANSITION',
                `${transition.reversibility} write effect ${current.id} cannot claim an exact inverse.`,
              );
            }
            values.observedRevisionJson = canonicalAgentRuntimeJson(
              transition.observedRevision,
            );
            values.preimageJson = canonicalAgentRuntimeJson(
              transition.preimage,
            );
            values.forwardJson = canonicalAgentRuntimeJson(
              transition.forward,
            );
            values.inverseJson = canonicalNullableJson(transition.inverse);
            values.reversibility = transition.reversibility;
            values.mutationStartedAt = transition.at;
            await tx
              .update(AgentRuntimeToolCallTable)
              .set({ status: 'running', startedAt: transition.at })
              .where(
                and(
                  eq(AgentRuntimeToolCallTable.id, current.toolCallId),
                  eq(AgentRuntimeToolCallTable.status, 'requested'),
                ),
              );
            break;
          }
          case 'effect_committed':
            values.effectJson = canonicalAgentRuntimeJson(transition.effect);
            values.effectCommittedAt = transition.at;
            // Receipt-backed reconciliation can prove that an outcome marked
            // uncertain during process recovery did commit. Clear the
            // diagnostic uncertainty and return the canonical tool call to an
            // entered state until result_committed settles it.
            values.errorCode = null;
            values.errorMessage = null;
            values.uncertainAt = null;
            if (transition.expectedPhase === 'uncertain') {
              await tx
                .update(AgentRuntimeToolCallTable)
                .set({
                  status: 'running',
                  errorCode: null,
                  completedAt: null,
                })
                .where(eq(AgentRuntimeToolCallTable.id, current.toolCallId));
            }
            break;
          case 'result_committed':
            values.resultJson = canonicalAgentRuntimeJson(transition.result);
            values.resultCommittedAt = transition.at;
            await tx
              .update(AgentRuntimeToolCallTable)
              .set({
                status: 'completed',
                resultJson: canonicalAgentRuntimeJson(transition.result),
                errorCode: null,
                completedAt: transition.at,
              })
              .where(eq(AgentRuntimeToolCallTable.id, current.toolCallId));
            break;
          case 'failed':
            values.errorCode = transition.errorCode;
            values.errorMessage = transition.errorMessage ?? null;
            values.failedAt = transition.at;
            // A certified compare-and-swap can prove that its UPDATE changed
            // zero rows and the surrounding transaction rolled back. Reclassify
            // that entered attempt as known-failed by clearing the conservative
            // mutation marker required only for unknown outcomes.
            if (transition.expectedPhase === 'mutation_started') {
              values.mutationStartedAt = null;
            }
            await tx
              .update(AgentRuntimeToolCallTable)
              .set({
                status: 'failed',
                errorCode: transition.errorCode,
                completedAt: transition.at,
              })
              .where(eq(AgentRuntimeToolCallTable.id, current.toolCallId));
            break;
          case 'declined':
            values.declinedAt = transition.at;
            await tx
              .update(AgentRuntimeToolCallTable)
              .set({
                status: 'failed',
                errorCode: 'WRITE_DECLINED',
                completedAt: transition.at,
              })
              .where(eq(AgentRuntimeToolCallTable.id, current.toolCallId));
            break;
          case 'uncertain':
            values.errorCode = transition.errorCode;
            values.errorMessage = transition.errorMessage ?? null;
            values.uncertainAt = transition.at;
            await tx
              .update(AgentRuntimeToolCallTable)
              .set({
                status: 'uncertain',
                errorCode: transition.errorCode,
                completedAt: transition.at,
              })
              .where(eq(AgentRuntimeToolCallTable.id, current.toolCallId));
            break;
        }

        await tx
          .update(AgentRuntimeWriteEffectTable)
          .set(values)
          .where(
            and(
              eq(AgentRuntimeWriteEffectTable.id, transition.effectId),
              eq(
                AgentRuntimeWriteEffectTable.phase,
                transition.expectedPhase,
              ),
            ),
          );
        const updated = await getEffect(transition.effectId, tx);
        if (!updated || updated.phase !== transition.nextPhase) {
          throw new AgentRuntimeWritePersistenceConflictError(
            'INVALID_EFFECT_TRANSITION',
            `Write effect ${transition.effectId} lost its compare-and-set transition.`,
          );
        }
        return { outcome: 'updated' as const, effect: updated };
      }, { behavior: 'immediate' });
    },

    async createReview(review) {
      return dbProvider().transaction(async (tx) => {
        const existingRows = await tx
          .select()
          .from(AgentRuntimeWriteReviewTable)
          .where(
            or(
              eq(AgentRuntimeWriteReviewTable.id, review.id),
              eq(
                AgentRuntimeWriteReviewTable.effectId,
                review.effectId,
              ),
            ),
          );
        if (existingRows.length > 0) {
          if (existingRows.length === 1) {
            const existing = reviewToDomain(existingRows[0]);
            if (
              existing.effectId === review.effectId &&
              existing.sessionId === review.sessionId &&
              existing.turnId === review.turnId &&
              existing.toolCallId === review.toolCallId
            ) {
              return { outcome: 'duplicate' as const, review: existing };
            }
          }
          throw new AgentRuntimeWritePersistenceConflictError(
            'REVIEW_CONFLICT',
            `Write review ${review.id} conflicts with durable effect review state.`,
          );
        }

        const effect = await getEffect(review.effectId, tx);
        if (
          !effect ||
          effect.phase !== 'result_committed' ||
          effect.sessionId !== review.sessionId ||
          effect.turnId !== review.turnId ||
          effect.toolCallId !== review.toolCallId
        ) {
          throw new AgentRuntimeWritePersistenceConflictError(
            'REVIEW_CONFLICT',
            `Write review ${review.id} does not match a result-committed effect.`,
          );
        }

        await tx.insert(AgentRuntimeWriteReviewTable).values({
          id: review.id,
          effectId: review.effectId,
          sessionId: review.sessionId,
          turnId: review.turnId,
          toolCallId: review.toolCallId,
          status: 'pending',
          createdAt: review.createdAt,
          updatedAt: review.createdAt,
        });
        const inserted = await getReview(review.id, tx);
        if (!inserted) {
          throw new Error(`Write review ${review.id} was not persisted.`);
        }
        return { outcome: 'inserted' as const, review: inserted };
      }, { behavior: 'immediate' });
    },

    getReview,
    listReviews,

    async transitionReview(transition) {
      return dbProvider().transaction(async (tx) => {
        const current = await getReview(transition.reviewId, tx);
        if (!current) {
          throw new AgentRuntimeWritePersistenceConflictError(
            'INVALID_REVIEW_TRANSITION',
            `Write review ${transition.reviewId} does not exist.`,
          );
        }
        if (current.status !== transition.expectedStatus) {
          if (sameReviewTransitionResult(current, transition)) {
            return { outcome: 'duplicate' as const, review: current };
          }
          throw new AgentRuntimeWritePersistenceConflictError(
            'INVALID_REVIEW_TRANSITION',
            `Write review ${transition.reviewId} expected ${transition.expectedStatus}, found ${current.status}.`,
          );
        }

        const effect = await getEffect(current.effectId, tx);
        if (!effect || effect.phase !== 'result_committed') {
          throw new AgentRuntimeWritePersistenceConflictError(
            'INVALID_REVIEW_TRANSITION',
            `Write review ${transition.reviewId} lost its committed effect provenance.`,
          );
        }

        const values: Partial<
          typeof AgentRuntimeWriteReviewTable.$inferInsert
        > = {
          status: transition.nextStatus,
          updatedAt: transition.at,
        };
        switch (transition.nextStatus) {
          case 'accepted':
            values.acceptedAt = transition.at;
            values.decisionNoteJson =
              transition.decisionNote === undefined ||
              transition.decisionNote === null
                ? null
                : canonicalAgentRuntimeJson(transition.decisionNote);
            break;
          case 'rejected':
            values.rejectedAt = transition.at;
            values.decisionNoteJson =
              transition.decisionNote === undefined ||
              transition.decisionNote === null
                ? null
                : canonicalAgentRuntimeJson(transition.decisionNote);
            break;
          case 'accepted_effect':
            values.settledAt = transition.at;
            break;
          case 'revert_started':
            if (
              (effect.reversibility !== 'exact' &&
                effect.reversibility !== 'compensating') ||
              effect.inverse === null
            ) {
              throw new AgentRuntimeWritePersistenceConflictError(
                'INVALID_REVIEW_TRANSITION',
                `Write effect ${effect.id} has no executable inverse.`,
              );
            }
            values.revertStartedAt = transition.at;
            break;
          case 'reverted':
            values.revertEffectJson = canonicalAgentRuntimeJson(
              transition.revertEffect,
            );
            values.settledAt = transition.at;
            break;
          case 'revert_failed':
            values.errorCode = transition.errorCode;
            values.errorMessage = transition.errorMessage ?? null;
            values.settledAt = transition.at;
            break;
          case 'revert_unavailable':
            if (
              effect.reversibility === 'exact' ||
              effect.reversibility === 'compensating'
            ) {
              throw new AgentRuntimeWritePersistenceConflictError(
                'INVALID_REVIEW_TRANSITION',
                `Reversible write effect ${effect.id} must attempt its inverse.`,
              );
            }
            values.errorCode = transition.errorCode;
            values.errorMessage = transition.errorMessage ?? null;
            values.settledAt = transition.at;
            break;
        }

        await tx
          .update(AgentRuntimeWriteReviewTable)
          .set(values)
          .where(
            and(
              eq(AgentRuntimeWriteReviewTable.id, transition.reviewId),
              eq(
                AgentRuntimeWriteReviewTable.status,
                transition.expectedStatus,
              ),
            ),
          );
        const updated = await getReview(transition.reviewId, tx);
        if (!updated || updated.status !== transition.nextStatus) {
          throw new AgentRuntimeWritePersistenceConflictError(
            'INVALID_REVIEW_TRANSITION',
            `Write review ${transition.reviewId} lost its compare-and-set transition.`,
          );
        }
        return { outcome: 'updated' as const, review: updated };
      }, { behavior: 'immediate' });
    },

    async interruptSessionWrites(sessionId, interruptedAt) {
      return dbProvider().transaction(async (tx) => {
        const enteredRows = await tx
          .select({
            id: AgentRuntimeWriteEffectTable.id,
            toolCallId: AgentRuntimeWriteEffectTable.toolCallId,
          })
          .from(AgentRuntimeWriteEffectTable)
          .where(
            and(
              eq(AgentRuntimeWriteEffectTable.sessionId, sessionId),
              eq(AgentRuntimeWriteEffectTable.phase, 'mutation_started'),
            ),
          );
        const safeRows = await tx
          .select({
            id: AgentRuntimeWriteEffectTable.id,
            toolCallId: AgentRuntimeWriteEffectTable.toolCallId,
          })
          .from(AgentRuntimeWriteEffectTable)
          .where(
            and(
              eq(AgentRuntimeWriteEffectTable.sessionId, sessionId),
              inArray(AgentRuntimeWriteEffectTable.phase, [
                'claimed',
                'confirmed',
              ]),
            ),
          );

        if (enteredRows.length > 0) {
          const effectIds = enteredRows.map((row) => row.id);
          const toolCallIds = enteredRows.map((row) => row.toolCallId);
          await tx
            .update(AgentRuntimeWriteEffectTable)
            .set({
              phase: 'uncertain',
              errorCode: 'PROCESS_INTERRUPTED_AFTER_MUTATION_START',
              errorMessage:
                'The process stopped after mutation entry; reconcile the durable target before retrying.',
              uncertainAt: interruptedAt,
              updatedAt: interruptedAt,
            })
            .where(inArray(AgentRuntimeWriteEffectTable.id, effectIds));
          await tx
            .update(AgentRuntimeToolCallTable)
            .set({
              status: 'uncertain',
              errorCode: 'PROCESS_INTERRUPTED_AFTER_MUTATION_START',
              completedAt: interruptedAt,
            })
            .where(inArray(AgentRuntimeToolCallTable.id, toolCallIds));
        }

        if (safeRows.length > 0) {
          const effectIds = safeRows.map((row) => row.id);
          const toolCallIds = safeRows.map((row) => row.toolCallId);
          await tx
            .update(AgentRuntimeWriteEffectTable)
            .set({
              phase: 'failed',
              errorCode: 'PROCESS_INTERRUPTED_BEFORE_MUTATION',
              errorMessage:
                'The process stopped before mutation entry; no local effect was applied.',
              failedAt: interruptedAt,
              updatedAt: interruptedAt,
            })
            .where(inArray(AgentRuntimeWriteEffectTable.id, effectIds));
          await tx
            .update(AgentRuntimeToolCallTable)
            .set({
              status: 'failed',
              errorCode: 'PROCESS_INTERRUPTED_BEFORE_MUTATION',
              completedAt: interruptedAt,
            })
            .where(inArray(AgentRuntimeToolCallTable.id, toolCallIds));
        }

        return {
          failedBeforeMutation: safeRows.length,
          uncertainAfterMutationStart: enteredRows.length,
        };
      }, { behavior: 'immediate' });
    },

    async loadSnapshot(sessionId) {
      return dbProvider().transaction(async (tx) => {
        const effects = await listEffects(sessionId, tx);
        const reviews = await listReviews(sessionId, tx);
        const turns = await tx
          .select({
            id: AgentRuntimeTurnTable.id,
            ordinal: AgentRuntimeTurnTable.ordinal,
          })
          .from(AgentRuntimeTurnTable)
          .where(eq(AgentRuntimeTurnTable.sessionId, sessionId));
        return {
          effects,
          reviews,
          turnOrdinalsById: Object.fromEntries(
            turns.map((turn) => [turn.id, turn.ordinal]),
          ),
        };
      });
    },
  };
}
