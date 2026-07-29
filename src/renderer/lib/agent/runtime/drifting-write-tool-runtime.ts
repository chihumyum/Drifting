import { Value } from '@sinclair/typebox/value';
import type {
  PersistedAgentRuntimeWriteEffect,
  PersistedAgentRuntimeWriteReview,
} from '../../../domain/agent-runtime-write-effect';
import {
  createAgentRuntimeWriteEffectRepository,
  type AgentRuntimeWriteEffectRepository,
} from '../../../sqlite-repo/agent-runtime-write-effect-repo';
import {
  getActiveAgentToolContext,
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
import {
  isAgentAbort,
  throwIfAgentAborted,
} from './errors';
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
  getContext?: () => AgentToolContext | null;
  readRuntime?: AgentToolRuntime;
  now?: () => string;
  dispatch?: typeof runAgentTool;
  resolveStrategy?: (name: string) => DriftingWriteStrategy | undefined;
}

export interface AgentWriteReviewDecisionResult {
  review: PersistedAgentRuntimeWriteReview;
  effect: PersistedAgentRuntimeWriteEffect;
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
  private readonly getContext: () => AgentToolContext | null;
  private readonly readRuntime: AgentToolRuntime;
  private readonly now: () => string;
  private readonly dispatch: typeof runAgentTool;
  private readonly resolveStrategy: (
    name: string,
  ) => DriftingWriteStrategy | undefined;

  constructor(options: DriftingWriteToolRuntimeOptions = {}) {
    this.repository =
      options.repository ?? createAgentRuntimeWriteEffectRepository();
    this.getContext = options.getContext ?? getActiveAgentToolContext;
    this.readRuntime = options.readRuntime ?? new DriftingReadToolRuntime();
    this.now = options.now ?? (() => new Date().toISOString());
    this.dispatch = options.dispatch ?? runAgentTool;
    this.resolveStrategy =
      options.resolveStrategy ?? getDriftingWriteStrategy;
  }

  listDefinitions(
    context: AgentRuntimeContext,
  ): readonly AgentToolDefinition[] {
    const reads = this.readRuntime.listDefinitions(context);
    const writes = listProviderTools({ allowWrite: true })
      .filter((tool) => tool.access === 'write')
      .map((tool) => writeDefinition(tool));
    return [...reads, ...writes];
  }

  async execute(
    request: AgentToolExecutionRequest,
  ): Promise<AgentToolExecutionResult> {
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
      expectedRevision: null,
      claimedAt: this.now(),
    });
    let effect = claimed.effect;

    const replay = await this.replayDurableOutcome(effect, tool, request);
    if (replay) return replay;

    let prepared: PreparedDriftingWriteEffect | null = null;
    try {
      prepared = await strategy.prepare(request, context);
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
      const handlerResult = await this.dispatch(
        tool.name,
        request.arguments,
        withProvenance(context, effect, request.signal),
      );
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
        await this.repository.transitionEffect({
          effectId,
          expectedPhase: 'mutation_started',
          nextPhase: 'uncertain',
          errorCode: 'WRITE_EFFECT_UNCERTAIN',
          errorMessage: publicWriteError(error),
          at: this.now(),
        });
      }
      throw error;
    }
  }

  private async replayDurableOutcome(
    effect: PersistedAgentRuntimeWriteEffect,
    tool: RegisteredTool,
    request: AgentToolExecutionRequest,
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
      case 'uncertain':
        return {
          ok: false,
          error:
            'This write entered mutation without a canonical result; inspect its durable effect before retrying',
        };
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
      tool.approval === 'soft_review'
        ? { id: reviewId, status: 'pending' as const }
        : null;
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
    return (
      await this.repository.createReview({
        id: writeReviewId(effect.id),
        effectId: effect.id,
        sessionId: effect.sessionId,
        turnId: effect.turnId,
        toolCallId: effect.toolCallId,
        createdAt: this.now(),
      })
    ).review;
  }

  private requireMatchingContext(
    runtimeContext: AgentRuntimeContext,
  ): AgentToolContext {
    const active = this.getContext();
    if (!active) throw new Error('Drifting tool context is not mounted');
    if (
      !runtimeContext.route.projectId ||
      runtimeContext.route.projectId !== active.projectId
    ) {
      throw new Error('Agent route does not match the active Drifting project');
    }
    return active;
  }

  private requireEffectContext(
    effect: PersistedAgentRuntimeWriteEffect,
  ): AgentToolContext {
    const active = this.getContext();
    if (!active || active.projectId !== effect.projectId) {
      throw new Error(
        'The Agent review belongs to a different or unmounted project',
      );
    }
    return active;
  }

  private async requireReview(
    reviewId: string,
  ): Promise<PersistedAgentRuntimeWriteReview> {
    const review = await this.repository.getReview(reviewId);
    if (!review) throw new Error(`Agent write review "${reviewId}" was not found`);
    return review;
  }

  private async requireEffect(
    effectId: string,
  ): Promise<PersistedAgentRuntimeWriteEffect> {
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

export function resolveDriftingCertifiedToolAccess(
  name: string,
): 'read' | 'write' | undefined {
  if (name === 'read_tool_result') return 'read';
  const tool = getRegisteredTool(name);
  if (
    !tool ||
    tool.scope !== 'general' ||
    !isCertifiedTool(tool) ||
    (tool.certification !== 'read-certified' &&
      tool.certification !== 'write-certified')
  ) {
    return undefined;
  }
  return tool.access;
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

function withProvenance(
  context: AgentToolContext,
  effect: PersistedAgentRuntimeWriteEffect,
  signal: AbortSignal,
): AgentToolContext {
  return {
    ...context,
    provenance: {
      sessionId: effect.sessionId,
      turnId: effect.turnId,
      callId: effect.callId,
      idempotencyKey: effect.idempotencyKey,
      signal,
    },
  };
}

function persistedExecutionResult(value: unknown): AgentToolExecutionResult {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as { ok?: unknown }).ok !== 'boolean'
  ) {
    throw new Error('The persisted Agent write result is invalid');
  }
  return value as AgentToolExecutionResult;
}

function persistedHandlerResult(value: unknown): unknown {
  if (
    !value ||
    typeof value !== 'object' ||
    !('handlerResult' in value)
  ) {
    throw new Error(
      'The committed Agent effect has no replayable handler result',
    );
  }
  return (value as { handlerResult: unknown }).handlerResult;
}

function unresolvedWriteResult(
  effect: PersistedAgentRuntimeWriteEffect,
): AgentToolExecutionResult {
  return {
    ok: false,
    error: `Write effect is in non-retryable phase "${effect.phase}"`,
  };
}

function publicWriteError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Agent write failed';
}
