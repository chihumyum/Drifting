import { Value } from '@sinclair/typebox/value';
import type {
  PersistedAgentRuntimeWriteEffect,
  PersistedAgentRuntimeWriteReview,
  PersistedAgentRuntimeWriteReviewBlock,
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
import { createAgentMemoryRepository } from '../../../sqlite-repo/agent-memory-repo';
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
import { getDb, type DbExecutor } from '../../../lib/db';
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
import {
  DRIFTING_WORKSPACE_DELETE_TOOL,
  DRIFTING_WORKSPACE_EDIT_TOOL,
  DRIFTING_WORKSPACE_WRITE_TOOL,
  workspaceCommandFromArguments,
} from './drifting-workspace-tool-runtime';
import { hashAgentPermissionArguments } from './control-plane';
import {
  agentMemorySetRevision,
  loadStorylineMembershipSnapshot,
} from './domain-crud-revision';

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
  /** Runtime-owned facade expansion performed after public schema validation
   * and permission, but before the durable effect is claimed. */
  prepareRequest?: (request: AgentToolExecutionRequest) => Promise<AgentToolExecutionRequest>;
  resolveStrategy?: (name: string) => DriftingWriteStrategy | undefined;
  proseCoordinator?: YjsProsePersistenceCoordinator;
  readNodeContent?: (nodeId: string) => Promise<string | null>;
  elementPatchDb?: DbExecutor;
  elementPatchReceipts?: AgentRuntimeElementPatchReceiptRepository;
  elementPatchPersistSyncMutation?: typeof persistSyncMutationInTransaction;
  elementPatchNotifySyncCommitted?: typeof notifySyncMutationCommitted;
}

export interface AgentWriteReviewDecisionResult {
  review: PersistedAgentRuntimeWriteReview;
  effect: PersistedAgentRuntimeWriteEffect;
}

export interface AgentWriteReviewBlockDecisionResult
  extends AgentWriteReviewDecisionResult {
  block: PersistedAgentRuntimeWriteReviewBlock;
  blocks: readonly PersistedAgentRuntimeWriteReviewBlock[];
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
  private readonly prepareRequest: (
    request: AgentToolExecutionRequest,
  ) => Promise<AgentToolExecutionRequest>;
  private readonly elementPatchDb: DbExecutor | undefined;
  private readonly resolveStrategy: (name: string) => DriftingWriteStrategy | undefined;

  constructor(options: DriftingWriteToolRuntimeOptions = {}) {
    this.repository = options.repository ?? createAgentRuntimeWriteEffectRepository();
    this.freshness =
      options.freshness === undefined ? createAgentRuntimeFreshnessRepository() : options.freshness;
    this.getContext = options.getContext ?? getActiveAgentToolContext;
    this.readRuntime = options.readRuntime ?? new DriftingReadToolRuntime();
    this.now = options.now ?? (() => new Date().toISOString());
    this.dispatch = options.dispatch ?? runAgentTool;
    this.prepareRequest = options.prepareRequest ?? (async (request) => request);
    this.elementPatchDb = options.elementPatchDb;
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
          dispatch: this.dispatch,
        }));
  }

  listDefinitions(context: AgentRuntimeContext): readonly AgentToolDefinition[] {
    const reads = this.readRuntime.listDefinitions(context);
    const workspaceWrites = [
      DRIFTING_WORKSPACE_EDIT_TOOL,
      DRIFTING_WORKSPACE_WRITE_TOOL,
      DRIFTING_WORKSPACE_DELETE_TOOL,
    ].map((name) => {
      const tool = getRegisteredTool(name);
      if (!isWorkspaceWriteFacade(tool)) {
        throw new Error(`The ${name} runtime contract is unavailable`);
      }
      return writeDefinition(tool);
    });
    const writes = listProviderTools({ allowWrite: true })
      .filter((tool) => tool.access === 'write')
      .map((tool) => writeDefinition(tool));
    return [...reads, ...workspaceWrites, ...writes];
  }

  resolveCanonicalName(
    name: string,
    context: AgentRuntimeContext,
  ): string | undefined {
    const direct = this.listDefinitions(context).find(
      (definition) => definition.name === name,
    );
    if (direct) return direct.name;
    const delegated = this.readRuntime.resolveCanonicalName?.(name, context);
    if (delegated) return delegated;
    const registered = getRegisteredTool(name);
    if (!registered || registered.name === name) return undefined;
    return this.listDefinitions(context).some(
      (definition) => definition.name === registered.name,
    )
      ? registered.name
      : undefined;
  }

  async execute(request: AgentToolExecutionRequest): Promise<AgentToolExecutionResult> {
    if (request.access === 'read') {
      return this.readRuntime.execute(request);
    }
    throwIfAgentAborted(request.signal);
    const tool = getRegisteredTool(request.name);
    const workspaceFacade = isWorkspaceWriteFacade(tool);
    if (
      !tool ||
      (tool.scope !== 'general' && !workspaceFacade) ||
      tool.access !== 'write' ||
      (tool.certification !== 'write-certified' && !workspaceFacade) ||
      !isCertifiedTool(tool)
    ) {
      return {
        ok: false,
        error: `Tool "${request.name}" is not write-certified`,
      };
    }
    try {
      const effectiveRequest = await this.prepareRequest(request);
      if (effectiveRequest.name !== tool.name) {
        throw new Error('Runtime request preparation cannot change the public tool name');
      }
      const strategy = this.resolveStrategy(tool.name);
      if (!strategy) {
        return {
          ok: false,
          error: `Tool "${tool.name}" has no certified write strategy`,
        };
      }
      const context = this.requireMatchingContext(effectiveRequest.context);
      return await this.executeCertifiedWrite(
        effectiveRequest,
        tool,
        strategy,
        context,
        request.arguments,
      );
    } catch (error) {
      if (isAgentAbort(error, request.signal)) throw error;
      return {
        ok: false,
        error: workspaceFacade ? publicWorkspaceWriteError(error) : publicWriteError(error),
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
    const effects = await this.repository.listEffects(sessionId);
    const candidates = effects.filter(
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
        await this.settleCommittedEffect(
          committed,
          tool,
          reconciled.handlerResult,
          strategy,
          active,
        );
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
    await this.reconcileCommittedEditorReviews(effects, active);
    await this.reconcileInterruptedReviewBlocks(sessionId, signal);
    await this.reconcileInterruptedReviewStates(sessionId, signal);
    return result;
  }

  /** Rebuild pending editor reviews from SQLite even when localStorage vanished. */
  async reconcileProjectReviews(
    projectId: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<{ projected: number; unresolved: number }> {
    const context = this.getContext();
    if (!context || context.projectId !== projectId) {
      throw new Error('The Agent review project is not mounted');
    }
    const result = { projected: 0, unresolved: 0 };
    const reviews = await this.repository.listPendingReviewsForProject(projectId);
    for (const candidate of reviews) {
      try {
        throwIfAgentAborted(signal);
        if (candidate.status === 'accepted') {
          await this.acceptReview(candidate.id, candidate.decisionNote);
          continue;
        }
        if (candidate.status === 'rejected') {
          await this.rejectReview(
            candidate.id,
            candidate.decisionNote,
            signal,
          );
          continue;
        }
        if (candidate.status === 'revert_started') {
          await this.repository.transitionReview({
            reviewId: candidate.id,
            expectedStatus: 'revert_started',
            nextStatus: 'revert_failed',
            errorCode: 'WRITE_REVERT_INTERRUPTED',
            errorMessage:
              'The renderer stopped after inverse execution began; the inverse was not replayed. Re-read the entity before any further edit.',
            at: this.now(),
          });
          continue;
        }
        if (candidate.status !== 'pending') continue;
        const effect = await this.requireEffect(candidate.effectId);
        const strategy = this.resolveStrategy(effect.toolName);
        if (strategy?.reviewBlocks) {
          await this.ensureCommittedReview(
            effect,
            'approve',
            strategy,
            context,
          );
        }
        const blocks = await this.repository.listReviewBlocks(candidate.id);
        for (const block of blocks) {
          if (
            block.status !== 'revert_started' &&
            block.status !== 'revert_failed'
          ) {
            continue;
          }
          await this.rejectReviewBlock(
            candidate.id,
            block.blockId,
            block.decisionNote,
            signal,
          );
        }
        const review = await this.requireReview(candidate.id);
        if (review.status !== 'pending') continue;
        if (!strategy?.projectReview) continue;
        await this.projectCommittedReview(effect, strategy, context);
        result.projected += 1;
      } catch (error) {
        if (isAgentAbort(error, signal)) throw error;
        result.unresolved += 1;
        console.warn(
          `[agent] project review ${candidate.id} could not be rebuilt`,
          error,
        );
      }
    }
    return result;
  }

  /**
   * Close the small, intentional transaction seam between result commit and
   * review-row creation. Automatic reviews are settled but not visually replayed
   * after restart; a pending approve-mode review is projected back into the
   * editor only after its canonical row has been recovered.
   */
  private async reconcileCommittedEditorReviews(
    effects: readonly PersistedAgentRuntimeWriteEffect[],
    context: AgentToolContext,
  ): Promise<void> {
    const committed = effects.filter(
      (effect) => effect.phase === 'result_committed' && effect.authorization,
    );
    for (const effect of committed) {
      try {
        const tool = requireReconciliationTool(effect);
        const descriptor = activeEditorReview(effect, tool);
        if (!descriptor) continue;
        const strategy = this.resolveStrategy(tool.name);
        const review = await this.ensureCommittedReview(
          effect,
          descriptor.mode,
          strategy,
          context,
        );
        if (review.status !== 'pending') continue;
        await this.projectCommittedReview(effect, strategy, context);
      } catch (error) {
        console.warn(
          `[agent] committed editor review ${effect.id} could not be recovered`,
          error,
        );
      }
    }
  }

  /** Resume only idempotent, guarded paragraph inverses. */
  private async reconcileInterruptedReviewBlocks(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const reviews = (await this.repository.listReviews(sessionId)).filter(
      (review) => review.status === 'pending',
    );
    for (const review of reviews) {
      const blocks = await this.repository.listReviewBlocks(review.id);
      for (const block of blocks) {
        if (
          block.status !== 'revert_started' &&
          block.status !== 'revert_failed'
        ) {
          continue;
        }
        throwIfAgentAborted(signal);
        await this.rejectReviewBlock(
          review.id,
          block.blockId,
          block.decisionNote,
          signal,
        );
      }
    }
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
    let review = await this.requireReview(reviewId);
    const effect = await this.requireEffect(review.effectId);
    const context = this.requireEffectContext(effect);
    const strategy = this.resolveStrategy(effect.toolName);
    if (review.status === 'pending' && strategy?.reviewBlocks) {
      review = await this.ensureCommittedReview(
        effect,
        'approve',
        strategy,
        context,
      );
    }
    const blocks = await this.repository.listReviewBlocks(reviewId);
    if (blocks.length > 0) {
      for (const block of blocks) {
        if (block.status === 'accepted' || block.status === 'reverted') continue;
        if (block.status !== 'pending') {
          throw new Error(
            `Agent review block ${reviewId}/${block.blockId} cannot be accepted from ${block.status}`,
          );
        }
        const result = await this.acceptReviewBlock(
          reviewId,
          block.blockId,
          decisionNote,
        );
        review = result.review;
      }
      return { review: await this.requireReview(reviewId), effect };
    }
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

  async acceptReviewBlock(
    reviewId: string,
    blockId: string,
    decisionNote: unknown = null,
  ): Promise<AgentWriteReviewBlockDecisionResult> {
    let review = await this.requireReview(reviewId);
    const effect = await this.requireEffect(review.effectId);
    this.requireEffectContext(effect);
    let blocks = await this.repository.listReviewBlocks(reviewId);
    let block = requireReviewBlock(reviewId, blockId, blocks);
    if (block.status === 'pending') {
      const result = await this.repository.transitionReviewBlock({
        reviewId,
        blockId,
        expectedStatus: 'pending',
        nextStatus: 'accepted',
        decisionNote,
        at: this.now(),
      });
      review = result.review;
      block = result.block;
      blocks = result.blocks;
    } else if (block.status !== 'accepted') {
      throw new Error(
        `Agent review block ${reviewId}/${blockId} cannot be accepted from ${block.status}`,
      );
    }
    return { review, effect, block, blocks };
  }

  async rejectReviewBlock(
    reviewId: string,
    blockId: string,
    decisionNote: unknown = null,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<AgentWriteReviewBlockDecisionResult> {
    let review = await this.requireReview(reviewId);
    const effect = await this.requireEffect(review.effectId);
    const context = this.requireEffectContext(effect);
    const strategy = this.resolveStrategy(effect.toolName);
    if (!strategy?.applyReviewBlockInverse) {
      throw new Error(
        `Agent review ${reviewId} has no certified block inverse`,
      );
    }
    let blocks = await this.repository.listReviewBlocks(reviewId);
    let block = requireReviewBlock(reviewId, blockId, blocks);
    if (block.status === 'reverted') {
      return { review, effect, block, blocks };
    }
    if (block.status === 'pending' || block.status === 'revert_failed') {
      const result = await this.repository.transitionReviewBlock({
        reviewId,
        blockId,
        expectedStatus: block.status,
        nextStatus: 'revert_started',
        decisionNote,
        at: this.now(),
      });
      review = result.review;
      block = result.block;
      blocks = result.blocks;
    }
    if (block.status !== 'revert_started') {
      throw new Error(
        `Agent review block ${reviewId}/${blockId} cannot be reverted from ${block.status}`,
      );
    }
    try {
      throwIfAgentAborted(signal);
      const revertEffect = await strategy.applyReviewBlockInverse(
        effect,
        blockId,
        withProvenance(context, effect, signal),
        signal,
      );
      throwIfAgentAborted(signal);
      const result = await this.repository.transitionReviewBlock({
        reviewId,
        blockId,
        expectedStatus: 'revert_started',
        nextStatus: 'reverted',
        revertEffect,
        at: this.now(),
      });
      return {
        review: result.review,
        effect,
        block: result.block,
        blocks: result.blocks,
      };
    } catch (error) {
      if (isAgentAbort(error, signal)) throw error;
      const result = await this.repository.transitionReviewBlock({
        reviewId,
        blockId,
        expectedStatus: 'revert_started',
        nextStatus: 'revert_failed',
        errorCode: 'WRITE_BLOCK_REVERT_FAILED',
        errorMessage: publicWriteError(error),
        at: this.now(),
      });
      return {
        review: result.review,
        effect,
        block: result.block,
        blocks: result.blocks,
      };
    }
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
    if (review.status === 'pending' && strategy?.reviewBlocks) {
      review = await this.ensureCommittedReview(
        effect,
        'approve',
        strategy,
        context,
      );
    }
    const blocks = await this.repository.listReviewBlocks(reviewId);
    if (blocks.length > 0) {
      for (const block of [...blocks].reverse()) {
        if (block.status === 'accepted' || block.status === 'reverted') continue;
        const result = await this.rejectReviewBlock(
          reviewId,
          block.blockId,
          decisionNote,
          signal,
        );
        if (result.block.status !== 'reverted') {
          return { review: result.review, effect };
        }
        review = result.review;
      }
      return { review: await this.requireReview(reviewId), effect };
    }
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
    if (review.status === 'revert_failed' && review.errorCode === 'WRITE_REVERT_FAILED') {
      review = (
        await this.repository.transitionReview({
          reviewId,
          expectedStatus: 'revert_failed',
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
    toolCallArguments: Record<string, unknown> = request.arguments,
  ): Promise<AgentToolExecutionResult> {
    const route = durableWriteRoute(request.context.route);
    const effectId = writeEffectId(request.idempotencyKey);
    const authorizedAt = this.now();
    const authorization = await requireWriteAuthorization(
      request,
      toolCallArguments,
      authorizedAt,
    );
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
      authorization,
      toolCallArguments,
      arguments: request.arguments,
      expectedRevision,
      claimedAt: authorizedAt,
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
      return this.settleCommittedEffect(
        effect,
        tool,
        handlerResult,
        strategy,
        context,
      );
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
    const expectsProse = isEffectiveProseWrite(request.name, request.arguments);
    if (
      !observation ||
      observation.receiptId !== expected.receiptId ||
      observation.entityKind !== target.entityKind ||
      observation.entityId !== target.entityId ||
      observation.revision !== expected.revision
    ) {
      throw new Error(
        expectsProse
          ? `expectedRevision does not match the requested ${target.entityKind} observation from a prose read`
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
    const expectsProse = isEffectiveProseWrite(effect.toolName, effect.arguments);
    const expectedEntityKind = reconciliationFreshnessTarget(
      effect.toolName,
      effect.arguments,
    ).entityKind;
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
      case 'result_committed': {
        if (effect.authorization) {
          const result = persistedExecutionResult(effect.result);
          const descriptor = activeEditorReview(effect, tool);
          if (!descriptor) return result;
          const review = await this.ensureCommittedReview(
            effect,
            descriptor.mode,
            strategy,
            context,
          );
          await this.projectCommittedReview(effect, strategy, context);
          return withCanonicalReviewStatus(result, review);
        }
        // Compatibility for effects created before central authorization. A
        // crash could leave their deterministic review row missing.
        return withCanonicalReviewStatus(
          persistedExecutionResult(effect.result),
          await this.ensureLegacyCommittedReview(effect),
        );
      }
      case 'effect_committed': {
        const handlerResult = persistedHandlerResult(effect.effect);
        return this.settleCommittedEffect(
          effect,
          tool,
          handlerResult,
          strategy,
          context,
        );
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
            return this.settleCommittedEffect(
              committed,
              tool,
              reconciled.handlerResult,
              strategy,
              context,
            );
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
    strategy?: DriftingWriteStrategy,
    context?: AgentToolContext,
  ): Promise<AgentToolExecutionResult> {
    if (!effect.authorization) {
      return this.settleLegacyCommittedEffect(effect, tool, handlerResult);
    }
    const descriptor = activeEditorReview(effect, tool);
    const reviewId = descriptor?.id ?? null;
    const visibleResult =
      workspaceFacadeName(tool.name)
        ? workspaceVisibleWriteResult(effect, handlerResult)
        : handlerResult;
    const result: AgentToolExecutionResult = {
      ok: true,
      data: {
        result: visibleResult,
        writeRef: reviewId ?? effect.id,
        ...(workspaceFacadeName(tool.name) ? {} : { effectId: effect.id }),
        authorization: { kind: effect.authorization.kind },
        ...(reviewId
          ? { review: { id: reviewId, status: 'pending' } }
          : {}),
      },
      ...(workspaceFacadeName(tool.name)
        ? {
            modelData: workspaceModelWriteResult(
              visibleResult as ReturnType<typeof workspaceVisibleWriteResult>,
              effect.id,
            ),
          }
        : descriptor
          ? {
              // The model only needs a stable success reference. Review IDs,
              // Yjs hashes, and editor presentation are renderer concerns.
              modelData: { updated: true, writeRef: effect.id },
            }
          : {}),
      ...(reviewId
        ? { presentation: { review: { id: reviewId, status: 'pending' } } }
        : {}),
    };
    await this.repository.transitionEffect({
      effectId: effect.id,
      expectedPhase: 'effect_committed',
      nextPhase: 'result_committed',
      result,
      at: this.now(),
    });
    if (descriptor) {
      // The repository intentionally requires a result-committed effect before
      // it will create the review row. Projection remains last, so the badge
      // can never race a missing review even if the renderer crashes here.
      const review = await this.ensureCommittedReview(
        effect,
        descriptor.mode,
        strategy,
        context,
      );
      await this.projectCommittedReview(effect, strategy, context);
      return withCanonicalReviewStatus(result, review);
    }
    return result;
  }

  private async settleLegacyCommittedEffect(
    effect: PersistedAgentRuntimeWriteEffect,
    tool: RegisteredTool,
    handlerResult: unknown,
  ): Promise<AgentToolExecutionResult> {
    const reviewId = writeReviewId(effect.id);
    const visibleResult =
      workspaceFacadeName(tool.name)
        ? workspaceVisibleWriteResult(effect, handlerResult)
        : handlerResult;
    const result: AgentToolExecutionResult = {
      ok: true,
      data: {
        result: visibleResult,
        writeRef: reviewId,
        ...(workspaceFacadeName(tool.name) ? {} : { effectId: effect.id }),
        review: { id: reviewId, status: 'pending' },
      },
      ...(workspaceFacadeName(tool.name)
        ? {
            modelData: workspaceModelWriteResult(
              visibleResult as ReturnType<typeof workspaceVisibleWriteResult>,
              reviewId,
              'pending',
            ),
          }
        : {}),
      presentation: { review: { id: reviewId, status: 'pending' } },
    };
    await this.repository.transitionEffect({
      effectId: effect.id,
      expectedPhase: 'effect_committed',
      nextPhase: 'result_committed',
      result,
      at: this.now(),
    });
    return withCanonicalReviewStatus(
      result,
      await this.ensureLegacyCommittedReview(effect),
    );
  }

  private async ensureLegacyCommittedReview(
    effect: PersistedAgentRuntimeWriteEffect,
  ): Promise<PersistedAgentRuntimeWriteReview> {
    return this.ensureCommittedReview(
      effect,
      legacyEffectReviewMode(effect.forward) ?? 'approve',
    );
  }

  private async ensureCommittedReview(
    effect: PersistedAgentRuntimeWriteEffect,
    mode: 'auto' | 'approve',
    strategy?: DriftingWriteStrategy,
    context?: AgentToolContext,
  ): Promise<PersistedAgentRuntimeWriteReview> {
    const blocks =
      mode === 'approve' && strategy?.reviewBlocks && context
        ? await strategy.reviewBlocks(effect, context)
        : [];
    let review = (
      await this.repository.createReview({
        id: writeReviewId(effect.id),
        effectId: effect.id,
        sessionId: effect.sessionId,
        turnId: effect.turnId,
        toolCallId: effect.toolCallId,
        createdAt: this.now(),
        ...(blocks.length > 0 ? { blocks } : {}),
      })
    ).review;
    if (mode !== 'auto') return review;
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

  private async projectCommittedReview(
    effect: PersistedAgentRuntimeWriteEffect,
    strategy?: DriftingWriteStrategy,
    context?: AgentToolContext,
  ): Promise<void> {
    if (!strategy?.projectReview || !context) return;
    try {
      const blocks = await this.repository.listReviewBlocks(
        writeReviewId(effect.id),
      );
      const decisions = Object.fromEntries(
        blocks.flatMap((block) =>
          block.status === 'accepted' || block.status === 'reverted'
            ? [[block.blockId, block.status] as const]
            : [],
        ),
      );
      await strategy.projectReview(effect, context, decisions);
    } catch (error) {
      console.warn(
        '[agent] durable prose review could not be projected into the editor',
        error,
      );
    }
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
    const target = reconciliationFreshnessTarget(effect.toolName, effect.arguments);
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
      (isProseFreshnessKind(target.entityKind) &&
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
  if (
    name === 'read_tool_result' ||
    name === 'ask_user' ||
    name === 'list_files' ||
    name === 'read_file' ||
    name === 'grep'
  ) {
    return 'read';
  }
  if (workspaceFacadeName(name)) return 'write';
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

function workspaceFacadeName(name: string): boolean {
  return (
    name === DRIFTING_WORKSPACE_EDIT_TOOL ||
    name === DRIFTING_WORKSPACE_WRITE_TOOL ||
    name === DRIFTING_WORKSPACE_DELETE_TOOL
  );
}

function isWorkspaceWriteFacade(
  tool: RegisteredTool | null | undefined,
): tool is RegisteredTool {
  return Boolean(
    tool &&
      workspaceFacadeName(tool.name) &&
      tool.scope === 'runtime-virtual' &&
      tool.access === 'write' &&
      tool.certification === 'internal-certified' &&
      isCertifiedTool(tool),
  );
}

function requireReconciliationTool(effect: PersistedAgentRuntimeWriteEffect): RegisteredTool {
  const tool = getRegisteredTool(effect.toolName);
  const workspaceFacade = isWorkspaceWriteFacade(tool);
  if (
    !tool ||
    (tool.scope !== 'general' && !workspaceFacade) ||
    tool.access !== 'write' ||
    (tool.certification !== 'write-certified' && !workspaceFacade) ||
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
  | 'get_overview'
  | 'list_comments'
  | 'list_memory'
  | 'get_entity_relations';

type FreshnessEntityKind =
  | 'node'
  | 'node_prose'
  | 'element_prose'
  | 'storyline_prose'
  | 'category_prose'
  | 'element_patch_set'
  | 'element_patch'
  | 'element'
  | 'storyline'
  | 'category'
  | 'comment'
  | 'relation'
  | 'storyline_membership'
  | 'memory_set'
  | 'memory'
  | 'project';

function reconciliationFreshnessTarget(
  toolName: string,
  arguments_?: unknown,
): {
  readToolNames: readonly FreshnessReadToolName[];
  entityKind: FreshnessEntityKind;
} {
  const effective = effectiveWriteCommand(toolName, arguments_);
  toolName = effective.name;
  if (isProseWriteTool(toolName)) {
    return {
      readToolNames: proseReadToolNames(effective.arguments),
      entityKind: proseFreshnessEntityKind(effective.arguments),
    };
  }
  if (toolName === 'create_element_patch') {
    return {
      readToolNames: ['get_element_patches'],
      entityKind: 'element_patch_set',
    };
  }
  if (
    toolName === 'update_element_patch' ||
    toolName === 'delete_element_patch'
  ) {
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
  if (toolName === 'set_storyline_membership') {
    return {
      readToolNames: ['get_storyline'],
      entityKind: 'storyline_membership',
    };
  }
  if (toolName === 'remember') {
    return { readToolNames: ['list_memory'], entityKind: 'memory_set' };
  }
  if (toolName === 'update_memory' || toolName === 'forget') {
    return { readToolNames: ['list_memory'], entityKind: 'memory' };
  }
  if (PROJECT_FRESHNESS_WRITE_TOOLS.has(toolName)) {
    return {
      readToolNames: ['get_project_brief', 'get_overview'],
      entityKind: 'project',
    };
  }
  if (toolName === 'delete_element') {
    return { readToolNames: ['read_element'], entityKind: 'element' };
  }
  if (toolName === 'delete_storyline') {
    return { readToolNames: ['get_storyline'], entityKind: 'storyline' };
  }
  if (
    toolName === 'update_category' ||
    toolName === 'delete_category'
  ) {
    return { readToolNames: ['read_node'], entityKind: 'category' };
  }
  if (
    toolName === 'update_comment' ||
    toolName === 'delete_comment' ||
    toolName === 'set_comment_status' ||
    toolName === 'set_comment_kind'
  ) {
    return { readToolNames: ['list_comments'], entityKind: 'comment' };
  }
  if (toolName === 'update_relation_kind' || toolName === 'remove_relation') {
    return { readToolNames: ['get_entity_relations'], entityKind: 'relation' };
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

async function requireWriteAuthorization(
  request: AgentToolExecutionRequest,
  publicArguments: Record<string, unknown>,
  authorizedAt: string,
) {
  const authorization = request.authorization;
  if (!authorization) {
    throw new Error(
      'Certified writes require pre-execution authorization from the central runtime',
    );
  }
  const argumentsHash = await hashAgentPermissionArguments(publicArguments);
  if (authorization.argumentsHash !== argumentsHash) {
    throw new Error(
      'The approved write arguments changed before the mutation boundary',
    );
  }
  if (
    (authorization.kind === 'automatic' && authorization.requestId !== null) ||
    (authorization.kind === 'author_approved' &&
      !authorization.requestId?.trim())
  ) {
    throw new Error('The write authorization has invalid permission provenance');
  }
  return {
    kind: authorization.kind,
    requestId: authorization.requestId,
    argumentsHash,
    authorizedAt,
  };
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
  entityKind: FreshnessEntityKind;
  entityId: string;
  currentRevision: string;
}

async function resolveWriteFreshnessTarget(
  request: WriteFreshnessRequest,
  db?: DbExecutor,
): Promise<WriteFreshnessTarget> {
  const effective = effectiveWriteCommand(request.name, request.arguments);
  request = {
    ...request,
    name: effective.name,
    arguments: effective.arguments,
  };
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
  if (
    request.name === 'update_element_patch' ||
    request.name === 'delete_element_patch'
  ) {
    const patchId = String(request.arguments.patchId ?? '').trim();
    const patch = patchId ? await createElementPatchRepository(db).findById(patchId) : null;
    if (!patch || patch.projectId !== projectId) {
      throw new Error(`No element patch "${patchId}" exists in this project`);
    }
    if (patch.invalidatedAt || pendingDeletedPatchIds(patch.elementId).has(patch.id)) {
      throw new Error(`Element patch "${patchId}" is not available for Agent changes`);
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
  if (request.name === 'set_storyline_membership') {
    const storyline = resolveProjectStoryline(
      projectId,
      request.arguments.storyline,
    );
    const snapshot = await loadStorylineMembershipSnapshot(
      db ?? getDb(),
      projectId,
      storyline.id,
    );
    return {
      readToolNames: ['get_storyline'],
      entityKind: 'storyline_membership',
      entityId: storyline.id,
      currentRevision: snapshot.updatedAt,
    };
  }
  if (request.name === 'remember') {
    const memories = await createAgentMemoryRepository(
      projectId,
      db,
    ).findAll();
    return {
      readToolNames: ['list_memory'],
      entityKind: 'memory_set',
      entityId: projectId,
      currentRevision: await agentMemorySetRevision(memories),
    };
  }
  if (request.name === 'update_memory' || request.name === 'forget') {
    const memoryId = String(request.arguments.memoryId ?? '').trim();
    const memory = memoryId
      ? await createAgentMemoryRepository(projectId, db).findById(memoryId)
      : null;
    if (!memory || memory.deletedAt) {
      throw new Error(`No live memory "${memoryId}" exists in this project`);
    }
    return {
      readToolNames: ['list_memory'],
      entityKind: 'memory',
      entityId: memory.id,
      currentRevision: memory.updatedAt,
    };
  }
  if (PROJECT_FRESHNESS_WRITE_TOOLS.has(request.name)) {
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
  if (request.name === 'delete_element') {
    const element = resolveProjectElement(projectId, request.arguments.element);
    return {
      readToolNames: ['read_element'],
      entityKind: 'element',
      entityId: element.id,
      currentRevision: element.updatedAt,
    };
  }
  if (request.name === 'delete_storyline') {
    const storyline = resolveProjectStoryline(projectId, request.arguments.storyline);
    return {
      readToolNames: ['get_storyline'],
      entityKind: 'storyline',
      entityId: storyline.id,
      currentRevision: storyline.updatedAt,
    };
  }
  if (request.name === 'update_category' || request.name === 'delete_category') {
    const category = resolveProjectCategory(projectId, request.arguments.category);
    return {
      readToolNames: ['read_node'],
      entityKind: 'category',
      entityId: category.id,
      currentRevision: category.updatedAt,
    };
  }
  if (
    request.name === 'update_comment' ||
    request.name === 'delete_comment' ||
    request.name === 'set_comment_status' ||
    request.name === 'set_comment_kind'
  ) {
    const comment = resolveProjectComment(projectId, request.arguments.commentId);
    return {
      readToolNames: ['list_comments'],
      entityKind: 'comment',
      entityId: comment.id,
      currentRevision: comment.updatedAt,
    };
  }
  if (request.name === 'update_relation_kind' || request.name === 'remove_relation') {
    const relation = resolveProjectRelation(projectId, request.arguments.relationId);
    return {
      readToolNames: ['get_entity_relations'],
      entityKind: 'relation',
      entityId: relation.id,
      currentRevision: relation.updatedAt,
    };
  }
  if (isProseWriteTool(request.name)) {
    const entity = resolveWriteTargetProseEntity(request);
    return {
      readToolNames: proseReadToolNames(request.arguments),
      entityKind: proseFreshnessEntityKind(request.arguments),
      entityId: entity.id,
      // The Yjs current version is verified inside the prose strategy/coordinator.
      currentRevision: String(
        (request.arguments.expectedRevision as { revision?: unknown } | undefined)?.revision ?? '',
      ),
    };
  }
  const node = resolveWriteTargetNode(request);
  return {
    readToolNames: ['read_node'],
    entityKind: 'node',
    entityId: node.id,
    currentRevision: node.updatedAt,
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

function resolveProjectCategory(projectId: string, value: unknown) {
  const ref = String(value ?? '').trim();
  if (!ref) throw new Error('A category reference is required');
  const categories = useDataStore
    .getState()
    .bookElementCategories.filter((category) => category.projectId === projectId);
  const direct = categories.find((category) => category.id === ref);
  if (direct) return direct;
  const matches = categories.filter(
    (category) => category.name.trim().toLocaleLowerCase() === ref.toLocaleLowerCase(),
  );
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `No category named "${ref}" exists in this project`
        : `Category reference "${ref}" is ambiguous`,
    );
  }
  return matches[0]!;
}

function resolveProjectComment(projectId: string, value: unknown) {
  const id = String(value ?? '').trim();
  const comment = useDataStore
    .getState()
    .comments.find((candidate) => candidate.projectId === projectId && candidate.id === id);
  if (!comment) throw new Error(`No comment "${id}" exists in this project`);
  return comment;
}

function resolveProjectRelation(projectId: string, value: unknown) {
  const id = String(value ?? '').trim();
  const relation = useDataStore
    .getState()
    .entityRelations.find(
      (candidate) => candidate.projectId === projectId && candidate.id === id,
    );
  if (!relation) throw new Error(`No relation "${id}" exists in this project`);
  return relation;
}

function resolveWriteTargetProseEntity(request: WriteFreshnessRequest) {
  const projectId = request.context.route.projectId;
  if (!projectId) throw new Error(`${request.name} requires a project-scoped entity`);
  const ref =
    request.arguments.entity ??
    request.arguments.node ??
    request.arguments.nodeId;
  const kind = String(request.arguments.kind ?? 'node');
  if (kind === 'element') return resolveProjectElement(projectId, ref);
  if (kind === 'storyline') return resolveProjectStoryline(projectId, ref);
  if (kind === 'category') return resolveProjectCategory(projectId, ref);
  return resolveWriteTargetNode(request);
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
  'edit_prose_file',
  'edit_block',
  'edit_blocks',
  'append_paragraph',
  'insert_blocks',
  'remove_blocks',
  'replace_block_range',
]);

const PROJECT_FRESHNESS_WRITE_TOOLS = new Set([
  'update_project_facts',
  'create_comment',
  'create_node',
  'create_element',
  'create_storyline',
  'create_category',
  'add_relation',
]);

function isProseWriteTool(name: string): boolean {
  return PROSE_WRITE_TOOLS.has(name);
}

function isEffectiveProseWrite(name: string, arguments_: unknown): boolean {
  return isProseWriteTool(effectiveWriteCommand(name, arguments_).name);
}

function proseFreshnessEntityKind(
  arguments_: Record<string, unknown>,
): Extract<
  FreshnessEntityKind,
  'node_prose' | 'element_prose' | 'storyline_prose' | 'category_prose'
> {
  const kind = String(arguments_.kind ?? 'node');
  if (kind === 'element') return 'element_prose';
  if (kind === 'storyline') return 'storyline_prose';
  if (kind === 'category') return 'category_prose';
  return 'node_prose';
}

function proseReadToolNames(
  arguments_: Record<string, unknown>,
): readonly FreshnessReadToolName[] {
  return String(arguments_.kind ?? 'node') === 'element'
    ? ['read_element', 'read_node']
    : ['read_node'];
}

function isProseFreshnessKind(kind: FreshnessEntityKind): boolean {
  return (
    kind === 'node_prose' ||
    kind === 'element_prose' ||
    kind === 'storyline_prose' ||
    kind === 'category_prose'
  );
}

function effectiveWriteCommand(
  name: string,
  arguments_: unknown,
): { name: string; arguments: Record<string, unknown> } {
  if (!workspaceFacadeName(name)) {
    return { name, arguments: requireRecord(arguments_, 'Write arguments are invalid') };
  }
  const command = workspaceCommandFromArguments(arguments_);
  if (!command) {
    throw new Error(`${name} has no runtime-prepared workspace command`);
  }
  return command;
}

function workspaceVisibleWriteResult(
  effect: PersistedAgentRuntimeWriteEffect,
  handlerResult?: unknown,
): {
  path: string;
  updated: true;
  replacements?: number;
  operation?: 'created' | 'updated' | 'deleted';
  guidance?: string;
  canonicalPath?: string;
} {
  const arguments_ = requireRecord(effect.arguments, 'The workspace write arguments are invalid');
  const path = String(arguments_.path ?? '');
  if (!path) throw new Error('The workspace write lost its public path');
  if (effect.toolName === DRIFTING_WORKSPACE_DELETE_TOOL) {
    return { path, updated: true, operation: 'deleted' };
  }
  if (effect.toolName === DRIFTING_WORKSPACE_WRITE_TOOL) {
    const command = workspaceCommandFromArguments(arguments_);
    const created = Boolean(
      command?.name.startsWith('create_') ||
        command?.name === 'add_relation' ||
        command?.name === 'remember',
    );
    const entityId =
      recordString(handlerResult, 'entityId') ??
      recordString(handlerResult, 'commentId');
    const categoryPath = /^\/categories\/(.+)\/body\.md$/u.exec(path);
    return {
      path,
      updated: true,
      operation: created ? 'created' : 'updated',
      ...(entityId && command?.name === 'remember'
        ? { canonicalPath: `/memory/${workspaceResultPathSegment(entityId)}.json` }
        : entityId && command?.name === 'create_comment'
          ? { canonicalPath: `/comments/${workspaceResultPathSegment(entityId)}.json` }
          : entityId && command?.name === 'add_relation'
            ? { canonicalPath: `/relations/${workspaceResultPathSegment(entityId)}.json` }
            : {}),
      ...(command?.name === 'create_category' && categoryPath
        ? {
            guidance:
              `The category now exists. Create an element in it by writing ` +
              `"/elements/${categoryPath[1]}/<element-name>/body.md" directly.`,
          }
        : {}),
    };
  }
  const replacements = Array.isArray(arguments_.replacements) ? arguments_.replacements.length : 0;
  if (replacements <= 0) {
    throw new Error('The workspace edit lost its public result summary');
  }
  return { path, updated: true, replacements };
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

function withCanonicalReviewStatus(
  result: AgentToolExecutionResult,
  review: PersistedAgentRuntimeWriteReview | null,
): AgentToolExecutionResult {
  if (!review || !result.ok || !result.data || typeof result.data !== 'object') {
    return result;
  }
  const data = result.data as Record<string, unknown>;
  const centrallyAuthorized = 'authorization' in data;
  return {
    ...result,
    ...(result.modelData !== undefined &&
    'result' in data &&
    !centrallyAuthorized
      ? {
          modelData: workspaceModelWriteResult(
            (data as { result: ReturnType<typeof workspaceVisibleWriteResult> }).result,
            review.id,
            review.status,
          ),
        }
      : {}),
    presentation: {
      ...(result.presentation ?? {}),
      review: {
        id: review.id,
        status: review.status,
      },
    },
    data: {
      ...(result.data as Record<string, unknown>),
      writeRef: review.id,
      review: {
        id: review.id,
        status: review.status,
      },
    },
  };
}

function workspaceModelWriteResult(
  result: ReturnType<typeof workspaceVisibleWriteResult>,
  writeRef: string,
  reviewStatus?: string,
) {
  return {
    updated: true as const,
    path: result.path,
    ...(result.replacements !== undefined ? { replacements: result.replacements } : {}),
    ...(result.operation ? { operation: result.operation } : {}),
    ...(result.guidance ? { guidance: result.guidance } : {}),
    ...(result.canonicalPath ? { canonicalPath: result.canonicalPath } : {}),
    writeRef,
    ...(reviewStatus ? { reviewStatus } : {}),
  };
}

function workspaceResultPathSegment(value: string): string {
  return value
    .trim()
    .replaceAll('%', '%25')
    .replaceAll('/', '%2F')
    .replaceAll('\\', '%5C');
}

function recordString(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === 'string' && candidate.trim()
    ? candidate.trim()
    : null;
}

function activeEditorReview(
  effect: PersistedAgentRuntimeWriteEffect,
  tool: RegisteredTool,
): { id: string; mode: 'auto' | 'approve' } | null {
  if (tool.approval !== 'review_after') return null;
  if (
    !effect.forward ||
    typeof effect.forward !== 'object' ||
    Array.isArray(effect.forward) ||
    (effect.forward as { kind?: unknown }).kind !== 'yjs_prose'
  ) {
    // `edit_file` is a facade over several independently certified writes.
    // Only its Yjs prose expansion has an editor block-diff surface; title,
    // summary, and other non-prose writes complete without a fake chat review.
    return null;
  }
  const reviewSnapshot = (effect.forward as { reviewSnapshot?: unknown })
    .reviewSnapshot;
  if (
    !reviewSnapshot ||
    typeof reviewSnapshot !== 'object' ||
    Array.isArray(reviewSnapshot) ||
    (reviewSnapshot as { effectId?: unknown }).effectId !== effect.id ||
    (reviewSnapshot as { reviewId?: unknown }).reviewId !==
      writeReviewId(effect.id) ||
    ((reviewSnapshot as { mode?: unknown }).mode !== 'auto' &&
      (reviewSnapshot as { mode?: unknown }).mode !== 'approve')
  ) {
    throw new Error('The committed prose write lost its editor-review provenance');
  }
  return {
    id: writeReviewId(effect.id),
    mode: (reviewSnapshot as { mode: 'auto' | 'approve' }).mode,
  };
}

function legacyEffectReviewMode(value: unknown): 'auto' | 'approve' | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const snapshot = (value as { reviewSnapshot?: unknown }).reviewSnapshot;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return null;
  }
  const mode = (snapshot as { mode?: unknown }).mode;
  return mode === 'auto' || mode === 'approve' ? mode : null;
}

function requireReviewBlock(
  reviewId: string,
  blockId: string,
  blocks: readonly PersistedAgentRuntimeWriteReviewBlock[],
): PersistedAgentRuntimeWriteReviewBlock {
  const block = blocks.find((candidate) => candidate.blockId === blockId);
  if (!block) {
    throw new Error(
      `Agent review ${reviewId} has no durable block "${blockId}"`,
    );
  }
  return block;
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

function publicWorkspaceWriteError(error: unknown): string {
  const message = publicWriteError(error);
  if (
    /\b(?:Yjs|freshness|expectedRevision|revision|state\s*(?:vector|hash)|read_node|receipt)\b/i.test(
      message,
    )
  ) {
    return 'The file changed while it was being edited. Read the current file and apply the replacement again.';
  }
  if (/\b(?:nodeId|entityId|docId|commandId)\b/i.test(message)) {
    return 'The file could not be saved safely. Read the current file before retrying.';
  }
  return message;
}
