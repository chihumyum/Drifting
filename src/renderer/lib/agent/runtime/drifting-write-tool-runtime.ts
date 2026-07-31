import { Value } from '@sinclair/typebox/value';
import type {
  PersistedAgentRuntimeWriteEffect,
  PersistedAgentRuntimeWriteReview,
} from '../../../domain/agent-runtime-write-effect';
import type {
  AgentRuntimeExpectedRevision,
  PersistedAgentRuntimeReadReceipt,
  PersistedAgentRuntimeWriteExpectation,
} from '../../../domain/agent-runtime-freshness';
import {
  createAgentRuntimeFreshnessRepository,
  type AgentRuntimeFreshnessRepository,
} from '../../../sqlite-repo/agent-runtime-freshness-repo';
import {
  createAgentRuntimeWriteEffectRepository,
  type AgentRuntimeWriteEffectRepository,
} from '../../../sqlite-repo/agent-runtime-write-effect-repo';
import { canonicalAgentRuntimeJson } from '../../../sqlite-repo/agent-runtime-persistence-repo';
import { createElementPatchRepository } from '../../../sqlite-repo/element-patch-repo';
import { useDataStore } from '../../../store/data-store';
import { useProjectStore } from '../../../store/project-store';
import {
  getActiveAgentToolContext,
  pendingDeletedPatchIds,
  runAgentTool,
  type AgentToolContext,
} from '../tool-handlers';
import {
  getRegisteredTool,
  isCertifiedTool,
  listProviderTools,
  type RegisteredTool,
} from '../tool-registry';
import { DriftingReadToolRuntime } from './drifting-read-tool-runtime';
import {
  getDriftingWriteStrategy,
  type DriftingWriteStrategy,
  type PreparedDriftingWriteEffect,
} from './drifting-write-strategies';
import type { YjsProsePersistenceCoordinator } from './yjs-prose-persistence-coordinator';
import type { DbExecutor } from '../../../lib/db';
import type { AgentRuntimeElementPatchReceiptRepository } from '../../../sqlite-repo/agent-runtime-element-patch-receipt-repo';
import type {
  notifySyncMutationCommitted,
  persistSyncMutationInTransaction,
} from '../../../services/entity-sync.service';
import { elementPatchRevision, elementPatchSetRevision } from './element-patch-revision';
import { isAgentAbort, throwIfAgentAborted } from './errors';
import type {
  AgentRuntimeContext,
  AgentRuntimeRoute,
  AgentToolDefinition,
  AgentToolExecutionRequest,
  AgentToolExecutionResult,
  AgentToolRuntime,
} from './types';

export interface DriftingWriteToolRuntimeOptions {
  repository?: AgentRuntimeWriteEffectRepository;
  /**
   * Product runtimes use the canonical repository. `null` is reserved for the
   * pre-P4 deterministic fixtures whose purpose is unrelated to freshness.
   */
  freshness?: AgentRuntimeFreshnessRepository | null;
  getContext?: () => AgentToolContext | null;
  readRuntime?: AgentToolRuntime;
  now?: () => string;
  dispatch?: typeof runAgentTool;
  resolveStrategy?: (name: string) => DriftingWriteStrategy | undefined;
  proseCoordinator?: YjsProsePersistenceCoordinator;
  readNodeContent?: (nodeId: string) => Promise<string | null>;
  elementPatchDb?: DbExecutor;
  elementPatchReceipts?: AgentRuntimeElementPatchReceiptRepository;
  elementPatchPersistSyncMutation?: typeof persistSyncMutationInTransaction;
  elementPatchNotifySyncCommitted?: typeof notifySyncMutationCommitted;
  /** Product-owned frozen review mode lookup. When true, the canonical soft
   * review is immediately advanced through accepted -> accepted_effect; local
   * reveal animation remains a presentation concern. */
  autoAcceptReview?: (effect: PersistedAgentRuntimeWriteEffect) => boolean;
}

export interface AgentWriteReviewDecisionResult {
  review: PersistedAgentRuntimeWriteReview;
  effect: PersistedAgentRuntimeWriteEffect;
}

export interface AgentInterruptedWriteReconciliationResult {
  inspected: number;
  reconciled: number;
  unresolved: number;
  issues: Array<{
    effectId: string;
    reason: string;
  }>;
}

/**
 * Provider-facing tool runtime with a fail-closed write coordinator.
 *
 * The provider can see only `write-certified` catalog entries. Every write is
 * durably claimed against the canonical session/turn/tool-call row before its
 * renderer usecase runs. A duplicate after mutation start is inspected, never
 * blindly retried.
 */
export class DriftingWriteToolRuntime implements AgentToolRuntime {
  private readonly repository: AgentRuntimeWriteEffectRepository;
  private readonly freshness: AgentRuntimeFreshnessRepository | null;
  private readonly getContext: () => AgentToolContext | null;
  private readonly readRuntime: AgentToolRuntime;
  private readonly now: () => string;
  private readonly dispatch: typeof runAgentTool;
  private readonly elementPatchDb: DbExecutor | undefined;
  private readonly autoAcceptReview: (effect: PersistedAgentRuntimeWriteEffect) => boolean;
  private readonly resolveStrategy: (name: string) => DriftingWriteStrategy | undefined;

  constructor(options: DriftingWriteToolRuntimeOptions = {}) {
    this.repository = options.repository ?? createAgentRuntimeWriteEffectRepository();
    this.freshness =
      options.freshness === undefined ? createAgentRuntimeFreshnessRepository() : options.freshness;
    this.getContext = options.getContext ?? getActiveAgentToolContext;
    this.readRuntime = options.readRuntime ?? new DriftingReadToolRuntime();
    this.now = options.now ?? (() => new Date().toISOString());
    this.dispatch = options.dispatch ?? runAgentTool;
    this.elementPatchDb = options.elementPatchDb;
    this.autoAcceptReview = options.autoAcceptReview ?? (() => false);
    this.resolveStrategy =
      options.resolveStrategy ??
      ((name) =>
        getDriftingWriteStrategy(name, {
          freshness: this.freshness,
          ...(options.elementPatchDb ? { elementPatchDb: options.elementPatchDb } : {}),
          ...(options.elementPatchReceipts
            ? { elementPatchReceipts: options.elementPatchReceipts }
            : {}),
          ...(options.elementPatchPersistSyncMutation
            ? {
                elementPatchPersistSyncMutation: options.elementPatchPersistSyncMutation,
              }
            : {}),
          ...(options.elementPatchNotifySyncCommitted
            ? {
                elementPatchNotifySyncCommitted: options.elementPatchNotifySyncCommitted,
              }
            : {}),
          now: this.now,
          ...(options.proseCoordinator ? { proseCoordinator: options.proseCoordinator } : {}),
          ...(options.readNodeContent ? { readNodeContent: options.readNodeContent } : {}),
        }));
  }

  listDefinitions(context: AgentRuntimeContext): readonly AgentToolDefinition[] {
    const reads = this.readRuntime.listDefinitions(context);
    const writes = listProviderTools({ allowWrite: true })
      .filter((tool) => tool.access === 'write')
      .map((tool) => writeDefinition(tool));
    return [...reads, ...writes];
  }

  async execute(request: AgentToolExecutionRequest): Promise<AgentToolExecutionResult> {
    if (request.access === 'read') {
      return this.readRuntime.execute(request);
    }
    throwIfAgentAborted(request.signal);
    const tool = getRegisteredTool(request.name);
    if (
      !tool ||
      tool.scope !== 'general' ||
      tool.access !== 'write' ||
      tool.certification !== 'write-certified' ||
      !isCertifiedTool(tool)
    ) {
      return {
        ok: false,
        error: `Tool "${request.name}" is not write-certified`,
      };
    }
    const strategy = this.resolveStrategy(tool.name);
    if (!strategy) {
      return {
        ok: false,
        error: `Tool "${tool.name}" has no certified write strategy`,
      };
    }
    try {
      const context = this.requireMatchingContext(request.context);
      return await this.executeCertifiedWrite(request, tool, strategy, context);
    } catch (error) {
      if (isAgentAbort(error, request.signal)) throw error;
      return {
        ok: false,
        error: publicWriteError(error),
      };
    }
  }

  /**
   * Product restart pass for writes that crossed the mutation boundary.
   *
   * This path can only inspect a certified strategy's immutable domain
   * receipt. It never dispatches a tool or replays the forward mutation.
   */
  async reconcileInterruptedWrites(
    sessionId: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<AgentInterruptedWriteReconciliationResult> {
    throwIfAgentAborted(signal);
    const active = this.getContext();
    if (!active) throw new Error('Drifting tool context is not mounted');
    const candidates = (await this.repository.listEffects(sessionId)).filter(
      (effect) => effect.phase === 'mutation_started' || effect.phase === 'uncertain',
    );
    const result: AgentInterruptedWriteReconciliationResult = {
      inspected: candidates.length,
      reconciled: 0,
      unresolved: 0,
      issues: [],
    };

    for (const effect of candidates) {
      throwIfAgentAborted(signal);
      if (effect.phase !== 'mutation_started' && effect.phase !== 'uncertain') {
        continue;
      }
      const enteredPhase: 'mutation_started' | 'uncertain' = effect.phase;
      try {
        const tool = requireReconciliationTool(effect);
        const strategy = this.resolveStrategy(tool.name);
        if (!strategy?.reconcileEnteredEffect) {
          throw new Error(`Tool "${effect.toolName}" has no certified receipt reconciler`);
        }
        const expected = await this.assertReconciliationProvenance(effect, sessionId, active);
        const reconciled = await strategy.reconcileEnteredEffect(
          effect,
          withProvenance(active, effect, signal, expected),
          signal,
        );
        if (!reconciled) {
          result.unresolved += 1;
          result.issues.push({
            effectId: effect.id,
            reason: 'No matching durable mutation receipt was found.',
          });
          continue;
        }

        // Re-read the immutable outer receipt chain after the domain strategy
        // completes and re-check the mounted project immediately before CAS.
        await this.assertReconciliationProvenance(
          effect,
          sessionId,
          this.requireEffectContext(effect),
        );
        throwIfAgentAborted(signal);
        const committed = (
          await this.repository.transitionEffect({
            effectId: effect.id,
            expectedPhase: enteredPhase,
            nextPhase: 'effect_committed',
            effect: reconciled.committedEffect,
            at: this.now(),
          })
        ).effect;
        await this.settleCommittedEffect(committed, tool, reconciled.handlerResult);
        result.reconciled += 1;
      } catch (error) {
        if (isAgentAbort(error, signal)) throw error;
        result.unresolved += 1;
        result.issues.push({
          effectId: effect.id,
          reason: publicWriteError(error),
        });
      }
    }
    await this.reconcileInterruptedReviewStates(sessionId, signal);
    return result;
  }

  /**
   * Finish author decisions that were durably recorded before a renderer
   * crash. `accepted` and `rejected` are safe resumable boundaries. An
   * already-entered inverse has no universal receipt contract, so
   * `revert_started` is settled fail-closed instead of replaying a mutation
   * that may already have happened.
   */
  private async reconcileInterruptedReviewStates(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const reviews = (await this.repository.listReviews(sessionId)).filter(
      (review) =>
        review.status === 'accepted' ||
        review.status === 'rejected' ||
        review.status === 'revert_started',
    );
    for (const review of reviews) {
      throwIfAgentAborted(signal);
      if (review.status === 'accepted') {
        await this.acceptReview(review.id, review.decisionNote);
        continue;
      }
      if (review.status === 'rejected') {
        await this.rejectReview(review.id, review.decisionNote, signal);
        continue;
      }
      await this.repository.transitionReview({
        reviewId: review.id,
        expectedStatus: 'revert_started',
        nextStatus: 'revert_failed',
        errorCode: 'WRITE_REVERT_INTERRUPTED',
        errorMessage:
          'The renderer stopped after inverse execution began; the inverse was not replayed. Re-read the entity before any further edit.',
        at: this.now(),
      });
    }
  }

  async acceptReview(
    reviewId: string,
    decisionNote: unknown = null,
  ): Promise<AgentWriteReviewDecisionResult> {
    const review = await this.requireReview(reviewId);
    const effect = await this.requireEffect(review.effectId);
    const context = this.requireEffectContext(effect);
    void context;
    const accepted =
      review.status === 'pending'
        ? (
            await this.repository.transitionReview({
              reviewId,
              expectedStatus: 'pending',
              nextStatus: 'accepted',
              decisionNote,
              at: this.now(),
            })
          ).review
        : review;
    const settled =
      accepted.status === 'accepted'
        ? (
            await this.repository.transitionReview({
              reviewId,
              expectedStatus: 'accepted',
              nextStatus: 'accepted_effect',
              at: this.now(),
            })
          ).review
        : accepted;
    return { review: settled, effect };
  }

  async rejectReview(
    reviewId: string,
    decisionNote: unknown = null,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<AgentWriteReviewDecisionResult> {
    let review = await this.requireReview(reviewId);
    const effect = await this.requireEffect(review.effectId);
    const context = this.requireEffectContext(effect);
    const strategy = this.resolveStrategy(effect.toolName);
    if (!strategy || !effect.inverse || effect.reversibility !== 'exact') {
      if (review.status === 'pending') {
        review = (
          await this.repository.transitionReview({
            reviewId,
            expectedStatus: 'pending',
            nextStatus: 'rejected',
            decisionNote,
            at: this.now(),
          })
        ).review;
      }
      if (review.status === 'rejected') {
        review = (
          await this.repository.transitionReview({
            reviewId,
            expectedStatus: 'rejected',
            nextStatus: 'revert_unavailable',
            errorCode: 'WRITE_INVERSE_UNAVAILABLE',
            errorMessage: 'This write has no certified exact inverse.',
            at: this.now(),
          })
        ).review;
      }
      return { review, effect };
    }

    if (review.status === 'pending') {
      review = (
        await this.repository.transitionReview({
          reviewId,
          expectedStatus: 'pending',
          nextStatus: 'rejected',
          decisionNote,
          at: this.now(),
        })
      ).review;
    }
    if (review.status === 'rejected') {
      review = (
        await this.repository.transitionReview({
          reviewId,
          expectedStatus: 'rejected',
          nextStatus: 'revert_started',
          at: this.now(),
        })
      ).review;
    }
    if (review.status !== 'revert_started') return { review, effect };

    try {
      const revertEffect = await strategy.applyInverse(
        effect,
        withProvenance(context, effect, signal),
        signal,
      );
      review = (
        await this.repository.transitionReview({
          reviewId,
          expectedStatus: 'revert_started',
          nextStatus: 'reverted',
          revertEffect,
          at: this.now(),
        })
      ).review;
    } catch (error) {
      review = (
        await this.repository.transitionReview({
          reviewId,
          expectedStatus: 'revert_started',
          nextStatus: 'revert_failed',
          errorCode: 'WRITE_REVERT_FAILED',
          errorMessage: publicWriteError(error),
          at: this.now(),
        })
      ).review;
    }
    return { review, effect };
  }

  private async executeCertifiedWrite(
    request: AgentToolExecutionRequest,
    tool: RegisteredTool,
    strategy: DriftingWriteStrategy,
    context: AgentToolContext,
  ): Promise<AgentToolExecutionResult> {
    const route = durableWriteRoute(request.context.route);
    const effectId = writeEffectId(request.idempotencyKey);
    const expectedRevision = this.freshness
      ? parseExpectedRevision(request.arguments.expectedRevision)
      : null;
    const claimed = await this.repository.claimEffect({
      id: effectId,
      ...route,
      sessionId: request.sessionId,
      turnId: request.turnId,
      toolCallId: runtimeToolCallId(request),
      callId: request.callId,
      toolName: tool.name,
      idempotencyKey: request.idempotencyKey,
      arguments: request.arguments,
      expectedRevision,
      claimedAt: this.now(),
    });
    let effect = claimed.effect;
    let writeExpectation: PersistedAgentRuntimeWriteExpectation | null = null;

    if (effect.phase === 'failed' || effect.phase === 'declined') {
      const replay = await this.replayDurableOutcome(effect, tool, request);
      if (replay) return replay;
    }

    if (this.freshness && expectedRevision) {
      try {
        if (effect.phase === 'claimed' || effect.phase === 'confirmed') {
          const observation = await this.validateExpectedRevision(request, expectedRevision);
          writeExpectation = observation;
          await this.attachWriteExpectation(effect, observation);
        } else {
          writeExpectation = await this.assertDurableWriteExpectation(effect, expectedRevision);
        }
      } catch (error) {
        if (effect.phase === 'claimed' || effect.phase === 'confirmed') {
          await this.repository.transitionEffect({
            effectId,
            expectedPhase: effect.phase,
            nextPhase: 'failed',
            errorCode: 'WRITE_FRESHNESS_REJECTED',
            errorMessage: publicWriteError(error),
            at: this.now(),
          });
        }
        throw error;
      }
    }

    const replay = await this.replayDurableOutcome(effect, tool, request, strategy, context);
    if (replay) return replay;

    let prepared: PreparedDriftingWriteEffect | null = null;
    try {
      const strategyPrepared = await strategy.prepare(request, context, writeExpectation);
      prepared =
        expectedRevision === null
          ? strategyPrepared
          : {
              ...strategyPrepared,
              // The effect repository compares this value to the immutable
              // claim token. The actual SQLite CAS still uses the revision
              // string passed through renderer provenance below.
              observedRevision: expectedRevision,
            };
      throwIfAgentAborted(request.signal);
      if (effect.phase === 'claimed') {
        effect = (
          await this.repository.transitionEffect({
            effectId,
            expectedPhase: 'claimed',
            nextPhase: 'confirmed',
            at: this.now(),
          })
        ).effect;
      }
      if (effect.phase !== 'confirmed') {
        return unresolvedWriteResult(effect);
      }
      effect = (
        await this.repository.transitionEffect({
          effectId,
          expectedPhase: 'confirmed',
          nextPhase: 'mutation_started',
          observedRevision: prepared.observedRevision,
          preimage: prepared.preimage,
          forward: prepared.forward,
          inverse: prepared.inverse,
          reversibility: prepared.reversibility,
          at: this.now(),
        })
      ).effect;
    } catch (error) {
      if (effect.phase === 'claimed' || effect.phase === 'confirmed') {
        await this.repository.transitionEffect({
          effectId,
          expectedPhase: effect.phase,
          nextPhase: 'failed',
          errorCode: 'WRITE_PREPARATION_FAILED',
          errorMessage: publicWriteError(error),
          at: this.now(),
        });
      }
      throw error;
    }

    try {
      const executionContext = withProvenance(
        context,
        effect,
        request.signal,
        expectedRevision ?? undefined,
      );
      const handlerResult = strategy.applyForward
        ? await strategy.applyForward(request, executionContext, prepared)
        : await this.dispatch(tool.name, request.arguments, executionContext);
      const committedEffect = await strategy.captureEffect(
        request,
        context,
        handlerResult,
        prepared,
      );
      effect = (
        await this.repository.transitionEffect({
          effectId,
          expectedPhase: 'mutation_started',
          nextPhase: 'effect_committed',
          effect: committedEffect,
          at: this.now(),
        })
      ).effect;
      return this.settleCommittedEffect(effect, tool, handlerResult);
    } catch (error) {
      if (effect.phase === 'mutation_started') {
        if (isDeterministicStaleWriteError(error)) {
          await this.repository.transitionEffect({
            effectId,
            expectedPhase: 'mutation_started',
            nextPhase: 'failed',
            errorCode: error.code,
            errorMessage: publicWriteError(error),
            at: this.now(),
          });
        } else {
          await this.repository.transitionEffect({
            effectId,
            expectedPhase: 'mutation_started',
            nextPhase: 'uncertain',
            errorCode: 'WRITE_EFFECT_UNCERTAIN',
            errorMessage: publicWriteError(error),
            at: this.now(),
          });
        }
      }
      throw error;
    }
  }

  private async validateExpectedRevision(
    request: AgentToolExecutionRequest,
    expected: AgentRuntimeExpectedRevision,
  ): Promise<PersistedAgentRuntimeWriteExpectation> {
    if (!this.freshness) {
      throw new Error('Agent freshness repository is unavailable');
    }
    const receipt = await this.freshness.getReadReceipt(expected.receiptId);
    const target = await resolveWriteFreshnessTarget(request, this.elementPatchDb);
    assertExpectedReceiptProvenance(receipt, request, target.readToolNames);
    const observation = receipt.observations.find(
      (candidate) => candidate.id === expected.observationId,
    );
    const expectsProse = isProseWriteTool(request.name);
    if (
      !observation ||
      observation.receiptId !== expected.receiptId ||
      observation.entityKind !== target.entityKind ||
      observation.entityId !== target.entityId ||
      observation.revision !== expected.revision
    ) {
      throw new Error(
        expectsProse
          ? 'expectedRevision does not match a node_prose observation from read_node(prose=true)'
          : `expectedRevision does not match the requested ${target.entityKind} observation`,
      );
    }
    if (
      expectsProse &&
      (!observation.stateVector ||
        !observation.stateHash ||
        parseYjsRevision(observation.revision) === null)
    ) {
      throw new Error(
        'The cited read has no exact Yjs revision/vector/hash; call read_node with prose=true',
      );
    }
    if (!expectsProse && target.currentRevision !== expected.revision) {
      throw new Error(
        target.entityKind === 'node'
          ? 'The node changed after read_node; read it again before writing'
          : 'The target changed after it was read; read it again before writing',
      );
    }
    return {
      id: writeExpectationId(request.idempotencyKey),
      effectId: writeEffectId(request.idempotencyKey),
      projectId: receipt.projectId,
      sessionId: receipt.sessionId,
      writeTurnId: request.turnId,
      writeToolCallId: runtimeToolCallId(request),
      observationId: observation.id,
      readReceiptId: receipt.id,
      readTurnId: observation.turnId,
      readToolCallId: observation.toolCallId,
      entityKind: observation.entityKind,
      entityId: observation.entityId,
      expectedRevision: observation.revision,
      expectedStateVector: observation.stateVector,
      expectedStateHash: observation.stateHash,
      createdAt: this.now(),
    };
  }

  private async attachWriteExpectation(
    effect: PersistedAgentRuntimeWriteEffect,
    expected: PersistedAgentRuntimeWriteExpectation,
  ): Promise<void> {
    if (!this.freshness) return;
    await this.freshness.attachWriteExpectations({
      effectId: effect.id,
      projectId: effect.projectId,
      sessionId: effect.sessionId,
      observations: [
        {
          id: expected.id,
          observationId: expected.observationId,
        },
      ],
      createdAt: expected.createdAt,
    });
  }

  private async assertDurableWriteExpectation(
    effect: PersistedAgentRuntimeWriteEffect,
    expected: AgentRuntimeExpectedRevision,
  ): Promise<PersistedAgentRuntimeWriteExpectation | null> {
    if (!this.freshness) return null;
    const durable = await this.freshness.listWriteExpectations(effect.id);
    const expectsProse = isProseWriteTool(effect.toolName);
    const expectedEntityKind = reconciliationFreshnessTarget(effect.toolName).entityKind;
    if (
      durable.length !== 1 ||
      durable[0].id !== writeExpectationId(effect.idempotencyKey) ||
      durable[0].readReceiptId !== expected.receiptId ||
      durable[0].observationId !== expected.observationId ||
      durable[0].expectedRevision !== expected.revision ||
      durable[0].entityKind !== expectedEntityKind ||
      (expectsProse &&
        (!durable[0].expectedStateVector ||
          !durable[0].expectedStateHash ||
          parseYjsRevision(durable[0].expectedRevision) === null))
    ) {
      throw new Error('The durable write effect lost its exact read expectation');
    }
    return durable[0];
  }

  private async replayDurableOutcome(
    effect: PersistedAgentRuntimeWriteEffect,
    tool: RegisteredTool,
    request: AgentToolExecutionRequest,
    strategy?: DriftingWriteStrategy,
    context?: AgentToolContext,
  ): Promise<AgentToolExecutionResult | null> {
    switch (effect.phase) {
      case 'result_committed':
        // The result row is the effect's canonical commit point. A crash can
        // happen immediately after that transaction and before the separate
        // review insert. Reconcile the deterministic review id on replay
        // instead of returning a result that points at a missing review.
        await this.ensureCommittedReview(effect, tool);
        return persistedExecutionResult(effect.result);
      case 'effect_committed': {
        const handlerResult = persistedHandlerResult(effect.effect);
        return this.settleCommittedEffect(effect, tool, handlerResult);
      }
      case 'mutation_started':
      case 'uncertain': {
        if (strategy?.reconcileEnteredEffect && context) {
          const reconciled = await strategy.reconcileEnteredEffect(
            effect,
            withProvenance(context, effect, request.signal),
            request.signal,
          );
          if (reconciled) {
            const committed = (
              await this.repository.transitionEffect({
                effectId: effect.id,
                expectedPhase: effect.phase,
                nextPhase: 'effect_committed',
                effect: reconciled.committedEffect,
                at: this.now(),
              })
            ).effect;
            return this.settleCommittedEffect(committed, tool, reconciled.handlerResult);
          }
        }
        return {
          ok: false,
          error:
            'This write entered mutation without a canonical result; inspect its durable effect before retrying',
        };
      }
      case 'failed':
        return {
          ok: false,
          error: effect.errorMessage ?? effect.errorCode ?? 'Write failed',
        };
      case 'declined':
        return { ok: false, error: 'The write was declined' };
      case 'claimed':
      case 'confirmed':
        throwIfAgentAborted(request.signal);
        return null;
    }
  }

  private async settleCommittedEffect(
    effect: PersistedAgentRuntimeWriteEffect,
    tool: RegisteredTool,
    handlerResult: unknown,
  ): Promise<AgentToolExecutionResult> {
    const reviewId = writeReviewId(effect.id);
    const review =
      tool.approval === 'soft_review' ? { id: reviewId, status: 'pending' as const } : null;
    const result: AgentToolExecutionResult = {
      ok: true,
      data: {
        result: handlerResult,
        effectId: effect.id,
        ...(review
          ? {
              review: {
                id: review.id,
                status: review.status,
              },
            }
          : {}),
      },
    };
    await this.repository.transitionEffect({
      effectId: effect.id,
      expectedPhase: 'effect_committed',
      nextPhase: 'result_committed',
      result,
      at: this.now(),
    });
    await this.ensureCommittedReview(effect, tool);
    return result;
  }

  private async ensureCommittedReview(
    effect: PersistedAgentRuntimeWriteEffect,
    tool: RegisteredTool,
  ): Promise<PersistedAgentRuntimeWriteReview | null> {
    if (tool.approval !== 'soft_review') return null;
    let review = (
      await this.repository.createReview({
        id: writeReviewId(effect.id),
        effectId: effect.id,
        sessionId: effect.sessionId,
        turnId: effect.turnId,
        toolCallId: effect.toolCallId,
        createdAt: this.now(),
      })
    ).review;
    if (!this.autoAcceptReview(effect)) return review;
    if (review.status === 'pending') {
      review = (
        await this.repository.transitionReview({
          reviewId: review.id,
          expectedStatus: 'pending',
          nextStatus: 'accepted',
          decisionNote: 'auto mode',
          at: this.now(),
        })
      ).review;
    }
    if (review.status === 'accepted') {
      review = (
        await this.repository.transitionReview({
          reviewId: review.id,
          expectedStatus: 'accepted',
          nextStatus: 'accepted_effect',
          at: this.now(),
        })
      ).review;
    }
    return review;
  }

  private async assertReconciliationProvenance(
    effect: PersistedAgentRuntimeWriteEffect,
    sessionId: string,
    context: AgentToolContext,
  ): Promise<AgentRuntimeExpectedRevision> {
    if (!this.freshness) {
      throw new Error('Agent freshness repository is unavailable');
    }
    if (
      effect.sessionId !== sessionId ||
      effect.projectId !== context.projectId ||
      effect.id !== writeEffectId(effect.idempotencyKey) ||
      effect.toolCallId !== `agent-tool:${effect.sessionId}:${effect.turnId}:${effect.callId}` ||
      !effect.mutationStartedAt ||
      effect.forward === null ||
      effect.reversibility === null
    ) {
      throw new Error('The interrupted write has conflicting durable provenance');
    }
    const arguments_ = requireRecord(
      effect.arguments,
      'The interrupted write arguments are invalid',
    );
    const expected = parseExpectedRevision(arguments_.expectedRevision);
    if (
      effect.expectedRevision === null ||
      effect.observedRevision === null ||
      canonicalAgentRuntimeJson(effect.expectedRevision) !== canonicalAgentRuntimeJson(expected) ||
      canonicalAgentRuntimeJson(effect.observedRevision) !== canonicalAgentRuntimeJson(expected)
    ) {
      throw new Error('The interrupted write lost its exact expected revision');
    }

    const expectations = await this.freshness.listWriteExpectations(effect.id);
    const expectation = expectations[0];
    const target = reconciliationFreshnessTarget(effect.toolName);
    if (
      expectations.length !== 1 ||
      !expectation ||
      expectation.id !== writeExpectationId(effect.idempotencyKey) ||
      expectation.effectId !== effect.id ||
      expectation.projectId !== effect.projectId ||
      expectation.sessionId !== effect.sessionId ||
      expectation.writeTurnId !== effect.turnId ||
      expectation.writeToolCallId !== effect.toolCallId ||
      expectation.readReceiptId !== expected.receiptId ||
      expectation.observationId !== expected.observationId ||
      expectation.expectedRevision !== expected.revision ||
      expectation.entityKind !== target.entityKind ||
      (target.entityKind === 'node_prose' &&
        (!expectation.expectedStateVector ||
          !expectation.expectedStateHash ||
          parseYjsRevision(expectation.expectedRevision) === null))
    ) {
      throw new Error('The interrupted write lost its exact durable expectation');
    }

    const receipt = await this.freshness.getReadReceipt(expectation.readReceiptId);
    const observation = receipt?.observations.find(
      (candidate) => candidate.id === expectation.observationId,
    );
    if (
      !receipt ||
      receipt.id !== `agent-read:${receipt.idempotencyKey}` ||
      receipt.projectId !== effect.projectId ||
      receipt.sessionId !== effect.sessionId ||
      !target.readToolNames.includes(receipt.toolName as FreshnessReadToolName) ||
      receipt.turnId !== expectation.readTurnId ||
      receipt.toolCallId !== expectation.readToolCallId ||
      receipt.toolCallId !==
        `agent-tool:${receipt.sessionId}:${receipt.turnId}:${receipt.callId}` ||
      !observation ||
      observation.receiptId !== receipt.id ||
      observation.projectId !== receipt.projectId ||
      observation.sessionId !== receipt.sessionId ||
      observation.turnId !== receipt.turnId ||
      observation.toolCallId !== receipt.toolCallId ||
      observation.id !== `agent-observation:${receipt.idempotencyKey}:${observation.ordinal}` ||
      observation.entityKind !== expectation.entityKind ||
      observation.entityId !== expectation.entityId ||
      observation.revision !== expectation.expectedRevision ||
      !optionalBytesEqual(observation.stateVector, expectation.expectedStateVector) ||
      observation.stateHash !== expectation.expectedStateHash
    ) {
      throw new Error('The interrupted write receipt chain has conflicting provenance');
    }
    return expected;
  }

  private requireMatchingContext(runtimeContext: AgentRuntimeContext): AgentToolContext {
    const active = this.getContext();
    if (!active) throw new Error('Drifting tool context is not mounted');
    if (!runtimeContext.route.projectId || runtimeContext.route.projectId !== active.projectId) {
      throw new Error('Agent route does not match the active Drifting project');
    }
    return active;
  }

  private requireEffectContext(effect: PersistedAgentRuntimeWriteEffect): AgentToolContext {
    const active = this.getContext();
    if (!active || active.projectId !== effect.projectId) {
      throw new Error('The Agent review belongs to a different or unmounted project');
    }
    return active;
  }

  private async requireReview(reviewId: string): Promise<PersistedAgentRuntimeWriteReview> {
    const review = await this.repository.getReview(reviewId);
    if (!review) throw new Error(`Agent write review "${reviewId}" was not found`);
    return review;
  }

  private async requireEffect(effectId: string): Promise<PersistedAgentRuntimeWriteEffect> {
    const effect = await this.repository.getEffect(effectId);
    if (!effect) throw new Error(`Agent write effect "${effectId}" was not found`);
    return effect;
  }
}

export function createDriftingWriteToolRuntime(
  options?: DriftingWriteToolRuntimeOptions,
): DriftingWriteToolRuntime {
  return new DriftingWriteToolRuntime(options);
}

export function resolveDriftingCertifiedToolAccess(name: string): 'read' | 'write' | undefined {
  if (name === 'read_tool_result' || name === 'ask_user') return 'read';
  const tool = getRegisteredTool(name);
  if (
    !tool ||
    tool.scope !== 'general' ||
    !isCertifiedTool(tool) ||
    (tool.certification !== 'read-certified' && tool.certification !== 'write-certified')
  ) {
    return undefined;
  }
  return tool.access;
}

function requireReconciliationTool(effect: PersistedAgentRuntimeWriteEffect): RegisteredTool {
  const tool = getRegisteredTool(effect.toolName);
  if (
    !tool ||
    tool.scope !== 'general' ||
    tool.access !== 'write' ||
    tool.certification !== 'write-certified' ||
    !isCertifiedTool(tool)
  ) {
    throw new Error(`Tool "${effect.toolName}" is not certified for write reconciliation`);
  }
  return tool;
}

type FreshnessReadToolName =
  | 'read_node'
  | 'get_element_patches'
  | 'read_element'
  | 'get_storyline'
  | 'get_project_brief'
  | 'get_overview';

function reconciliationFreshnessTarget(toolName: string): {
  readToolNames: readonly FreshnessReadToolName[];
  entityKind:
    | 'node'
    | 'node_prose'
    | 'element_patch_set'
    | 'element_patch'
    | 'element'
    | 'storyline'
    | 'project';
} {
  if (isProseWriteTool(toolName)) {
    return { readToolNames: ['read_node'], entityKind: 'node_prose' };
  }
  if (toolName === 'create_element_patch') {
    return {
      readToolNames: ['get_element_patches'],
      entityKind: 'element_patch_set',
    };
  }
  if (toolName === 'update_element_patch') {
    return {
      readToolNames: ['get_element_patches'],
      entityKind: 'element_patch',
    };
  }
  if (toolName === 'update_element') {
    return { readToolNames: ['read_element'], entityKind: 'element' };
  }
  if (toolName === 'update_storyline') {
    return {
      readToolNames: ['get_storyline'],
      entityKind: 'storyline',
    };
  }
  if (toolName === 'update_project_facts' || toolName === 'create_comment') {
    return {
      readToolNames: ['get_project_brief', 'get_overview'],
      entityKind: 'project',
    };
  }
  return { readToolNames: ['read_node'], entityKind: 'node' };
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function optionalBytesEqual(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  );
}

function writeDefinition(tool: RegisteredTool): AgentToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parametersSchema,
    access: 'write',
    validateInput: (input) => {
      if (Value.Check(tool.parametersSchema, input)) {
        return { ok: true, value: input };
      }
      const first = Value.Errors(tool.parametersSchema, input).First();
      return {
        ok: false,
        error: first
          ? `Invalid ${tool.name} arguments at ${first.path || '/'}: ${first.message}`
          : `Invalid ${tool.name} arguments`,
      };
    },
  };
}

function durableWriteRoute(route: AgentRuntimeRoute) {
  if (route.kind === 'test' || !route.projectId) {
    throw new Error('A durable Agent write requires a project route');
  }
  if (route.kind === 'chat') {
    if (!route.conversationId) {
      throw new Error('A durable Agent write requires a conversation');
    }
    return {
      projectId: route.projectId,
      routeKind: 'chat' as const,
      conversationId: route.conversationId,
      goalRunId: null,
      chapterId: null,
    };
  }
  return {
    projectId: route.projectId,
    routeKind: 'goal' as const,
    conversationId: null,
    goalRunId: route.goalRunId ?? null,
    chapterId: route.chapterId ?? null,
  };
}

function runtimeToolCallId(request: AgentToolExecutionRequest): string {
  return `agent-tool:${request.sessionId}:${request.turnId}:${request.callId}`;
}

function writeEffectId(idempotencyKey: string): string {
  return `agent-write:${idempotencyKey}`;
}

function writeReviewId(effectId: string): string {
  return `agent-review:${effectId}`;
}

function writeExpectationId(idempotencyKey: string): string {
  return `agent-expectation:${idempotencyKey}:0`;
}

function withProvenance(
  context: AgentToolContext,
  effect: PersistedAgentRuntimeWriteEffect,
  signal: AbortSignal,
  expectedRevision?: AgentRuntimeExpectedRevision,
): AgentToolContext {
  return {
    ...context,
    provenance: {
      sessionId: effect.sessionId,
      turnId: effect.turnId,
      callId: effect.callId,
      idempotencyKey: effect.idempotencyKey,
      ...(expectedRevision ? { expectedRevision } : {}),
      signal,
    },
  };
}

function parseExpectedRevision(value: unknown): AgentRuntimeExpectedRevision {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as { receiptId?: unknown }).receiptId !== 'string' ||
    !(value as { receiptId: string }).receiptId.trim() ||
    typeof (value as { observationId?: unknown }).observationId !== 'string' ||
    !(value as { observationId: string }).observationId.trim() ||
    typeof (value as { revision?: unknown }).revision !== 'string' ||
    !(value as { revision: string }).revision.trim()
  ) {
    throw new Error(
      'Certified writes require expectedRevision copied from the dependent read freshness',
    );
  }
  return {
    receiptId: (value as { receiptId: string }).receiptId,
    observationId: (value as { observationId: string }).observationId,
    revision: (value as { revision: string }).revision,
  };
}

function isDeterministicStaleWriteError(error: unknown): error is Error & {
  code: 'STALE_REVISION' | 'STALE_STATE_VECTOR' | 'STALE_STATE_HASH';
} {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'STALE_REVISION' ||
      error.code === 'STALE_STATE_VECTOR' ||
      error.code === 'STALE_STATE_HASH')
  );
}

function assertExpectedReceiptProvenance(
  receipt: PersistedAgentRuntimeReadReceipt | null,
  request: Pick<AgentToolExecutionRequest, 'sessionId' | 'context'>,
  readToolNames: readonly FreshnessReadToolName[],
): asserts receipt is PersistedAgentRuntimeReadReceipt {
  if (
    !receipt ||
    receipt.projectId !== request.context.route.projectId ||
    receipt.sessionId !== request.sessionId ||
    !readToolNames.includes(receipt.toolName as FreshnessReadToolName)
  ) {
    throw new Error(
      `expectedRevision must cite a ${readToolNames.join(' or ')} receipt from this project and session`,
    );
  }
}

interface WriteFreshnessRequest {
  name: string;
  arguments: Record<string, unknown>;
  context: {
    route: {
      projectId?: string | null;
    };
  };
}

interface WriteFreshnessTarget {
  readToolNames: readonly FreshnessReadToolName[];
  entityKind:
    | 'node'
    | 'node_prose'
    | 'element_patch_set'
    | 'element_patch'
    | 'element'
    | 'storyline'
    | 'project';
  entityId: string;
  currentRevision: string;
}

async function resolveWriteFreshnessTarget(
  request: WriteFreshnessRequest,
  db?: DbExecutor,
): Promise<WriteFreshnessTarget> {
  const projectId = request.context.route.projectId;
  if (!projectId) {
    throw new Error(`${request.name} requires a project-scoped route`);
  }
  if (request.name === 'create_element_patch') {
    const element = resolveProjectElement(projectId, request.arguments.element);
    const pendingDeletes = pendingDeletedPatchIds(element.id);
    const patches = (await createElementPatchRepository(db).listByElement(element.id)).filter(
      (patch) =>
        patch.projectId === projectId && !patch.invalidatedAt && !pendingDeletes.has(patch.id),
    );
    return {
      readToolNames: ['get_element_patches'],
      entityKind: 'element_patch_set',
      entityId: element.id,
      currentRevision: await elementPatchSetRevision(patches),
    };
  }
  if (request.name === 'update_element_patch') {
    const patchId = String(request.arguments.patchId ?? '').trim();
    const patch = patchId ? await createElementPatchRepository(db).findById(patchId) : null;
    if (!patch || patch.projectId !== projectId) {
      throw new Error(`No element patch "${patchId}" exists in this project`);
    }
    if (patch.invalidatedAt || pendingDeletedPatchIds(patch.elementId).has(patch.id)) {
      throw new Error(`Element patch "${patchId}" is not available for Agent updates`);
    }
    return {
      readToolNames: ['get_element_patches'],
      entityKind: 'element_patch',
      entityId: patch.id,
      currentRevision: await elementPatchRevision(patch),
    };
  }
  if (request.name === 'update_element') {
    const element = resolveProjectElement(projectId, request.arguments.element);
    return {
      readToolNames: ['read_element'],
      entityKind: 'element',
      entityId: element.id,
      currentRevision: element.updatedAt,
    };
  }
  if (request.name === 'update_storyline') {
    const storyline = resolveProjectStoryline(projectId, request.arguments.storyline);
    return {
      readToolNames: ['get_storyline'],
      entityKind: 'storyline',
      entityId: storyline.id,
      currentRevision: storyline.updatedAt,
    };
  }
  if (request.name === 'update_project_facts' || request.name === 'create_comment') {
    const project = useProjectStore.getState().currentProject;
    if (!project || project.id !== projectId) {
      throw new Error(`${request.name} requires the mounted project brief`);
    }
    return {
      readToolNames: ['get_project_brief', 'get_overview'],
      entityKind: 'project',
      entityId: projectId,
      currentRevision: project.updatedAt,
    };
  }
  const node = resolveWriteTargetNode(request);
  return {
    readToolNames: ['read_node'],
    entityKind: isProseWriteTool(request.name) ? 'node_prose' : 'node',
    entityId: node.id,
    // Yjs current version is verified inside the prose strategy/coordinator.
    currentRevision: isProseWriteTool(request.name)
      ? String(
          (request.arguments.expectedRevision as { revision?: unknown } | undefined)?.revision ??
            '',
        )
      : node.updatedAt,
  };
}

function resolveProjectElement(projectId: string, value: unknown) {
  const ref = String(value ?? '').trim();
  if (!ref) throw new Error('create_element_patch requires an element');
  const elements = useDataStore
    .getState()
    .bookElements.filter((element) => element.projectId === projectId);
  const direct = elements.find((element) => element.id === ref);
  if (direct) return direct;
  const matches = elements.filter(
    (element) => element.name.trim().toLocaleLowerCase() === ref.toLocaleLowerCase(),
  );
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `No element named "${ref}" exists in this project`
        : `Element reference "${ref}" is ambiguous`,
    );
  }
  return matches[0]!;
}

function resolveProjectStoryline(projectId: string, value: unknown) {
  const ref = String(value ?? '').trim();
  if (!ref) throw new Error('update_storyline requires a storyline');
  const storylines = useDataStore
    .getState()
    .storylines.filter((storyline) => storyline.projectId === projectId);
  const direct = storylines.find((storyline) => storyline.id === ref);
  if (direct) return direct;
  const matches = storylines.filter(
    (storyline) => storyline.name.trim().toLocaleLowerCase() === ref.toLocaleLowerCase(),
  );
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `No storyline named "${ref}" exists in this project`
        : `Storyline reference "${ref}" is ambiguous`,
    );
  }
  return matches[0]!;
}

function resolveWriteTargetNode(request: WriteFreshnessRequest) {
  const projectId = request.context.route.projectId;
  const ref = String(
    request.arguments.node ?? request.arguments.nodeId ?? request.arguments.entity ?? '',
  ).trim();
  const kind = String(request.arguments.kind ?? 'node');
  if (kind !== 'node' && kind !== 'chapter' && kind !== 'drift') {
    throw new Error(`${request.name} currently certifies node prose only`);
  }
  if (!projectId || !ref) {
    throw new Error(`${request.name} requires a project-scoped node`);
  }
  const nodes = useDataStore.getState().bookNodes.filter((node) => node.projectId === projectId);
  const direct = nodes.find((node) => node.id === ref);
  if (direct) return direct;
  const matches = nodes.filter(
    (node) => node.title.trim().toLocaleLowerCase() === ref.toLocaleLowerCase(),
  );
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `No node named "${ref}" exists in this project`
        : `Node reference "${ref}" is ambiguous`,
    );
  }
  return matches[0];
}

const PROSE_WRITE_TOOLS = new Set([
  'edit_block',
  'edit_blocks',
  'append_paragraph',
  'insert_blocks',
  'remove_blocks',
  'replace_block_range',
]);

function isProseWriteTool(name: string): boolean {
  return PROSE_WRITE_TOOLS.has(name);
}

function parseYjsRevision(value: string): number | null {
  const match = /^yjs:(0|[1-9]\d*)$/.exec(value);
  if (!match) return null;
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision) ? revision : null;
}

function persistedExecutionResult(value: unknown): AgentToolExecutionResult {
  if (!value || typeof value !== 'object' || typeof (value as { ok?: unknown }).ok !== 'boolean') {
    throw new Error('The persisted Agent write result is invalid');
  }
  return value as AgentToolExecutionResult;
}

function persistedHandlerResult(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !('handlerResult' in value)) {
    throw new Error('The committed Agent effect has no replayable handler result');
  }
  return (value as { handlerResult: unknown }).handlerResult;
}

function unresolvedWriteResult(effect: PersistedAgentRuntimeWriteEffect): AgentToolExecutionResult {
  return {
    ok: false,
    error: `Write effect is in non-retryable phase "${effect.phase}"`,
  };
}

function publicWriteError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Agent write failed';
}
