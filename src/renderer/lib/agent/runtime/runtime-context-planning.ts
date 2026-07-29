import {
  estimateAgentContextFixedInputTokens,
  planAgentModelContext,
  verifyAgentContextProviderEnvelope,
  type AgentContextProviderEnvelopeV2,
  type AgentContextSupplementalPinnedRow,
} from './context-message-adapter';
import {
  AgentContextCompactionCircuitBreaker,
  type AgentContextFullCompactor,
  type AgentContextSummaryCandidate,
  type AgentContextTokenEstimator,
} from './context-planner';
import { AgentRuntimeError } from './errors';
import type {
  AgentModelMessage,
  AgentModelToolDefinition,
  AgentRuntimeContext,
  AgentToolDefinition,
} from './types';

/**
 * A deliberately conservative, provider-neutral default. Provider adapters or
 * product composition roots may supply a smaller/larger verified window; the
 * runtime never infers one from a vendor or model name.
 */
export const DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS = 32_768 as const;
export const DEFAULT_AGENT_CONTEXT_PROVIDER_OVERHEAD_TOKENS = 512 as const;
export const DEFAULT_AGENT_CONTEXT_PER_TOOL_OVERHEAD_TOKENS = 8 as const;
export const DEFAULT_AGENT_RUNTIME_SYSTEM_POLICY =
  'Follow the user request using only the context and tools explicitly supplied by the Drifting Agent Runtime.';

export type AgentRuntimeContextPlanningPurpose =
  | 'provider_call'
  | 'completed_turn';

export interface AgentRuntimeContextPlanningHookInput {
  purpose: AgentRuntimeContextPlanningPurpose;
  sessionId: string;
  turnId: string;
  iteration: number;
  driverId: string;
  model?: string;
  context: AgentRuntimeContext;
  systemPrompt: string;
  messages: readonly AgentModelMessage[];
  /** Exact schemas selected for this invocation/checkpoint. */
  tools: readonly AgentModelToolDefinition[];
  signal: AbortSignal;
}

type MaybePromise<T> = T | Promise<T>;

export interface AgentRuntimeContextPlanningOptions {
  /** Provider-neutral verified input window, never inferred from a model id. */
  contextWindowTokens?: number;
  /** Provider framing not represented by messages or tool schemas. */
  providerOverheadTokens?: number;
  /** Conservative framing charged once per selected tool schema. */
  perToolOverheadTokens?: number;
  /** Explicit policy used only when the caller supplies no non-blank policy. */
  fallbackSystemPrompt?: string;
  estimateTokens?: AgentContextTokenEstimator;
  compactionTimeoutMs?: number;
  fullCompactor?: AgentContextFullCompactor;
  supplementalRows?:
    | readonly AgentContextSupplementalPinnedRow[]
    | ((
        input: AgentRuntimeContextPlanningHookInput,
      ) => MaybePromise<readonly AgentContextSupplementalPinnedRow[]>);
  deterministicSummaries?:
    | readonly AgentContextSummaryCandidate[]
    | ((
        input: AgentRuntimeContextPlanningHookInput,
      ) => MaybePromise<readonly AgentContextSummaryCandidate[]>);
  /**
   * Optional caller-defined provider epoch. By default, driver id + explicit
   * model form the epoch. Returning a new id deliberately resets the circuit.
   */
  resolveProviderEpoch?: (
    input: AgentRuntimeContextPlanningHookInput,
  ) => string;
}

export interface AgentRuntimeContextPlanningRequest {
  purpose: AgentRuntimeContextPlanningPurpose;
  sessionId: string;
  turnId: string;
  iteration: number;
  driverId: string;
  model?: string;
  context: AgentRuntimeContext;
  systemPrompt?: string;
  messages: readonly AgentModelMessage[];
  /** Full policy-filtered executable catalog, including historical tools. */
  executableDefinitions: readonly AgentToolDefinition[];
  /** Exact provider-facing schemas selected after this iteration's search. */
  selectedTools: readonly AgentModelToolDefinition[];
  requestedOutputTokens: number;
  signal: AbortSignal;
}

export interface AgentRuntimeVerifiedContextPlan {
  systemPrompt: string;
  envelope: AgentContextProviderEnvelopeV2;
  canonicalSourceRows: import('./context-planner').AgentContextSourceRow[];
}

const BUDGET_FAILURES = new Set([
  'PINNED_CONTEXT_EXCEEDS_BUDGET',
  'CONTEXT_BUDGET_EXCEEDED',
  'COMPACTOR_FAILED',
  'COMPACTOR_TIMEOUT',
  'COMPACTOR_ABORTED',
  'COMPACTION_CIRCUIT_OPEN',
  'COMPACTOR_NO_GAIN',
]);

function requirePositiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AgentRuntimeError(
      'INTERNAL_ERROR',
      `${label} must be a positive safe integer`,
    );
  }
  return value;
}

function requireNonNegativeSafeInteger(
  value: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AgentRuntimeError(
      'INTERNAL_ERROR',
      `${label} must be a non-negative safe integer`,
    );
  }
  return value;
}

function exactSystemPrompt(
  supplied: string | undefined,
  fallback: string,
): string {
  if (typeof supplied === 'string' && supplied.trim().length > 0) {
    return supplied;
  }
  if (fallback.trim().length === 0) {
    throw new AgentRuntimeError(
      'INTERNAL_ERROR',
      'Context planning fallback system policy must not be blank',
    );
  }
  return fallback;
}

function buildAccessResolver(
  definitions: readonly AgentToolDefinition[],
): (toolName: string) => 'read' | 'write' | null {
  const accessByName = new Map<string, 'read' | 'write'>();
  for (const definition of definitions) {
    if (accessByName.has(definition.name)) {
      throw new AgentRuntimeError(
        'INTERNAL_ERROR',
        `Duplicate executable tool "${definition.name}" in context planning`,
      );
    }
    accessByName.set(definition.name, definition.access);
  }
  return (toolName) => accessByName.get(toolName) ?? null;
}

function planningFailure(
  error: { code: string; message: string },
): AgentRuntimeError {
  return new AgentRuntimeError(
    BUDGET_FAILURES.has(error.code)
      ? 'BUDGET_EXCEEDED'
      : error.code === 'HASH_UNAVAILABLE'
        ? 'INTERNAL_ERROR'
        : 'PROTOCOL_VIOLATION',
    `Context planning failed (${error.code}): ${error.message}`,
  );
}

async function resolveHook<T>(
  hook: readonly T[] | ((input: AgentRuntimeContextPlanningHookInput) => MaybePromise<readonly T[]>) | undefined,
  input: AgentRuntimeContextPlanningHookInput,
  label: string,
): Promise<readonly T[] | undefined> {
  if (!hook) return undefined;
  try {
    return Array.isArray(hook)
      ? hook
      : await (
          hook as (
            value: AgentRuntimeContextPlanningHookInput,
          ) => MaybePromise<readonly T[]>
        )(input);
  } catch {
    throw new AgentRuntimeError(
      'INTERNAL_ERROR',
      `${label} context hook failed`,
    );
  }
}

/**
 * Runtime-owned coordinator for strict per-call planning. It owns one
 * compaction breaker per session/provider epoch so a failing model compactor
 * cannot be retried repeatedly while other sessions/providers remain isolated.
 */
export class AgentRuntimeContextPlanningCoordinator {
  private readonly options: Required<
    Pick<
      AgentRuntimeContextPlanningOptions,
      | 'contextWindowTokens'
      | 'providerOverheadTokens'
      | 'perToolOverheadTokens'
      | 'fallbackSystemPrompt'
    >
  > &
    Omit<
      AgentRuntimeContextPlanningOptions,
      | 'contextWindowTokens'
      | 'providerOverheadTokens'
      | 'perToolOverheadTokens'
      | 'fallbackSystemPrompt'
    >;

  private readonly circuits = new Map<
    string,
    AgentContextCompactionCircuitBreaker
  >();

  constructor(options: AgentRuntimeContextPlanningOptions = {}) {
    this.options = {
      ...options,
      contextWindowTokens: requirePositiveSafeInteger(
        options.contextWindowTokens ?? DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS,
        'contextWindowTokens',
      ),
      providerOverheadTokens: requireNonNegativeSafeInteger(
        options.providerOverheadTokens ??
          DEFAULT_AGENT_CONTEXT_PROVIDER_OVERHEAD_TOKENS,
        'providerOverheadTokens',
      ),
      perToolOverheadTokens: requireNonNegativeSafeInteger(
        options.perToolOverheadTokens ??
          DEFAULT_AGENT_CONTEXT_PER_TOOL_OVERHEAD_TOKENS,
        'perToolOverheadTokens',
      ),
      fallbackSystemPrompt:
        options.fallbackSystemPrompt ?? DEFAULT_AGENT_RUNTIME_SYSTEM_POLICY,
    };
    exactSystemPrompt(undefined, this.options.fallbackSystemPrompt);
    if (
      this.options.compactionTimeoutMs !== undefined &&
      (!Number.isSafeInteger(this.options.compactionTimeoutMs) ||
        this.options.compactionTimeoutMs <= 0)
    ) {
      throw new AgentRuntimeError(
        'INTERNAL_ERROR',
        'compactionTimeoutMs must be a positive safe integer',
      );
    }
  }

  async plan(
    request: AgentRuntimeContextPlanningRequest,
  ): Promise<AgentRuntimeVerifiedContextPlan> {
    const systemPrompt = exactSystemPrompt(
      request.systemPrompt,
      this.options.fallbackSystemPrompt,
    );
    const hookInput: AgentRuntimeContextPlanningHookInput = {
      purpose: request.purpose,
      sessionId: request.sessionId,
      turnId: request.turnId,
      iteration: request.iteration,
      driverId: request.driverId,
      ...(request.model ? { model: request.model } : {}),
      context: request.context,
      systemPrompt,
      messages: request.messages,
      tools: request.selectedTools,
      signal: request.signal,
    };
    const providerEpoch = this.resolveProviderEpoch(hookInput);
    const circuitKey = JSON.stringify([request.sessionId, providerEpoch]);
    let circuit = this.circuits.get(circuitKey);
    if (!circuit) {
      circuit = new AgentContextCompactionCircuitBreaker();
      this.circuits.set(circuitKey, circuit);
    }

    const supplementalRows = await resolveHook(
      this.options.supplementalRows,
      hookInput,
      'Supplemental',
    );
    const deterministicSummaries = await resolveHook(
      this.options.deterministicSummaries,
      hookInput,
      'Deterministic-summary',
    );
    const fixedInputTokens = estimateAgentContextFixedInputTokens({
      tools: request.selectedTools,
      providerOverheadTokens: this.options.providerOverheadTokens,
      perToolOverheadTokens: this.options.perToolOverheadTokens,
      ...(this.options.estimateTokens
        ? { estimateTokens: this.options.estimateTokens }
        : {}),
    });
    let planned: Awaited<ReturnType<typeof planAgentModelContext>>;
    try {
      planned = await planAgentModelContext({
        systemPrompt,
        messages: request.messages,
        resolveToolAccess: buildAccessResolver(
          request.executableDefinitions,
        ),
        ...(supplementalRows ? { supplementalRows } : {}),
        planner: {
          contextWindowTokens: this.options.contextWindowTokens,
          requestedOutputTokens: request.requestedOutputTokens,
          fixedInputTokens,
          ...(deterministicSummaries
            ? { deterministicSummaries }
            : {}),
          ...(this.options.fullCompactor
            ? { fullCompactor: this.options.fullCompactor }
            : {}),
          compactionCircuit: circuit,
          ...(this.options.compactionTimeoutMs
            ? { compactionTimeoutMs: this.options.compactionTimeoutMs }
            : {}),
          ...(this.options.estimateTokens
            ? { estimateTokens: this.options.estimateTokens }
            : {}),
          signal: request.signal,
        },
      });
    } catch (error) {
      if (error instanceof AgentRuntimeError) throw error;
      throw new AgentRuntimeError(
        'PROTOCOL_VIOLATION',
        `Canonical context bridge rejected the runtime history: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!planned.ok) throw planningFailure(planned.error);

    try {
      await verifyAgentContextProviderEnvelope({
        envelope: planned.envelope,
        canonicalSourceRows: planned.bridge.sourceRows,
      });
    } catch (error) {
      throw new AgentRuntimeError(
        'PROTOCOL_VIOLATION',
        `Verified provider context failed integrity validation: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return {
      systemPrompt,
      envelope: planned.envelope,
      canonicalSourceRows: planned.bridge.sourceRows.map((row) => ({
        ...row,
      })),
    };
  }

  private resolveProviderEpoch(
    input: AgentRuntimeContextPlanningHookInput,
  ): string {
    let epoch: string;
    try {
      epoch =
        this.options.resolveProviderEpoch?.(input) ??
        JSON.stringify([input.driverId, input.model ?? null]);
    } catch {
      throw new AgentRuntimeError(
        'INTERNAL_ERROR',
        'Provider epoch resolver failed',
      );
    }
    if (typeof epoch !== 'string' || epoch.trim().length === 0) {
      throw new AgentRuntimeError(
        'INTERNAL_ERROR',
        'Provider epoch must be a non-empty string',
      );
    }
    return epoch;
  }
}
