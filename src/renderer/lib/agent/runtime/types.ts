/**
 * Provider-neutral contracts for the Drifting Agent Runtime.
 *
 * This layer deliberately knows nothing about React, Tauri, persistence, or a
 * vendor SDK. Provider adapters normalize their wire stream into
 * `AgentModelStreamEvent`; the runtime turns those events into a deterministic
 * journal and executes tools through `AgentToolRuntime`.
 */
import type {
  AgentContextProviderEnvelopeV2,
  AgentContextProviderProjection,
} from './context-message-adapter';
import type { AgentContextSourceRow } from './context-planner';
import type {
  AgentPermissionRequest,
  AgentPermissionResolutionInput,
  AgentPermissionScope,
  AgentUserInputRequest,
} from '../protocol';
import type { AgentRuntimeControlChannel } from './control-plane';

export const AGENT_RUNTIME_SCHEMA_VERSION = 1 as const;
export const AGENT_RUNTIME_TOOL_SEARCH_LIMIT = 8 as const;

export interface AgentRuntimeUsage {
  /**
   * Provider-normalized total input tokens for this iteration. Cache token
   * fields are diagnostic subsets/breakdowns and must not be added again.
   */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface AgentReasoningOptions {
  enabled: boolean;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: object;
  access: 'read' | 'write';
  /**
   * Runtime validation is mandatory. `inputSchema` is sent to the model, while
   * this function is the local authority and may also normalize the value.
   */
  validateInput: (input: Record<string, unknown>) => AgentToolValidationResult;
}

/** JSON/IPC-safe subset exposed to a provider adapter. */
export interface AgentModelToolDefinition {
  name: string;
  description: string;
  inputSchema: object;
}

export type AgentToolValidationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

export interface AgentAssistantTextBlock {
  type: 'text';
  text: string;
}

export interface AgentAssistantThinkingBlock {
  type: 'thinking';
  text: string;
}

export interface AgentAssistantToolCallBlock {
  type: 'tool_call';
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Exact normalized JSON assembled from provider argument deltas. */
  rawArguments: string;
}

export type AgentAssistantContentBlock =
  | AgentAssistantTextBlock
  | AgentAssistantThinkingBlock
  | AgentAssistantToolCallBlock;

export interface AgentToolResultBlock {
  callId: string;
  name: string;
  ok: boolean;
  content: string;
  /**
   * Runtime provenance is persisted only for results whose origin materially
   * affects context safety. Today that is the canonical UNKNOWN_TOOL denial.
   */
  source?: 'runtime';
  errorCode?: 'UNKNOWN_TOOL';
}

export const AGENT_RUNTIME_UNKNOWN_TOOL_ERROR_CODE =
  'UNKNOWN_TOOL' as const;

export function agentRuntimeUnknownToolResultContent(
  toolName: string,
): string {
  return `Unknown tool "${toolName}"`;
}

export function isCanonicalAgentRuntimeUnknownToolResult(
  result: AgentToolResultBlock,
): boolean {
  return (
    result.ok === false &&
    result.source === 'runtime' &&
    result.errorCode === AGENT_RUNTIME_UNKNOWN_TOOL_ERROR_CODE &&
    result.content === agentRuntimeUnknownToolResultContent(result.name)
  );
}

export type AgentModelMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: AgentAssistantContentBlock[] }
  | { role: 'tool'; content: AgentToolResultBlock[] };

export interface AgentModelRequest {
  sessionId: string;
  turnId: string;
  iteration: number;
  model?: string;
  reasoning?: AgentReasoningOptions;
  /**
   * The only model-visible conversation context. The runtime has already
   * verified and budgeted this projection for this exact provider invocation.
   * Full canonical history must never cross the provider-driver seam.
   */
  context: AgentContextProviderProjection;
  tools: AgentModelToolDefinition[];
  maxOutputTokens: number;
  signal: AbortSignal;
}

export type AgentModelStopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'content_filter'
  | 'unknown';

export type AgentModelStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call_start'; callId: string; name: string }
  | { type: 'tool_args_delta'; callId: string; delta: string }
  | { type: 'tool_call_end'; callId: string }
  | { type: 'usage'; usage: AgentRuntimeUsage }
  | { type: 'finish'; reason: AgentModelStopReason };

export interface AgentModelDriver {
  readonly id: string;
  readonly capabilities?: {
    /** False when this adapter cannot safely round-trip provider reasoning state. */
    reasoning?: boolean;
  };
  stream(request: AgentModelRequest): AsyncIterable<AgentModelStreamEvent>;
}

export type AgentRuntimeRoute =
  | { kind: 'chat'; projectId: string; conversationId?: string }
  | { kind: 'goal'; projectId: string; goalRunId?: string; chapterId?: string }
  | { kind: 'test'; projectId?: string };

export interface AgentRuntimeContext {
  route: AgentRuntimeRoute;
}

export interface AgentToolExecutionRequest {
  sessionId: string;
  turnId: string;
  callId: string;
  /** Stable effect key; write adapters must make duplicate delivery harmless. */
  idempotencyKey: string;
  name: string;
  arguments: Record<string, unknown>;
  access: AgentToolDefinition['access'];
  context: AgentRuntimeContext;
  signal: AbortSignal;
  control?: {
    /**
     * Pause this tool at a canonical safe point until the user answers.
     * A provider-visible elicitation tool should delegate to this primitive.
     */
    requestUserInput(input: {
      requestId?: string;
      prompt: string;
    }): Promise<string>;
  };
}

export type AgentToolExecutionResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

/**
 * Policy-filtered tool surface for one runtime invocation.
 *
 * Future Drifting integration will derive definitions from the canonical tool
 * catalog and route `execute` through `runAgentTool`/renderer use cases.
 */
export interface AgentToolRuntime {
  listDefinitions(context: AgentRuntimeContext): readonly AgentToolDefinition[];
  /**
   * Write implementations must check `signal` before entering their mutation
   * phase, make the `(sessionId, turnId, callId)` idempotency key durable, and
   * settle promptly once execution has started. The runtime will not publish a
   * terminal event while an entered write is unresolved.
   */
  execute(request: AgentToolExecutionRequest): Promise<AgentToolExecutionResult>;
}

export interface AgentToolPermissionPolicyRequest
  extends AgentPermissionRequest {
  context: AgentRuntimeContext;
}

export type AgentToolPermissionPolicyDecision =
  | {
      decision: 'allow';
      scope?: AgentPermissionScope;
    }
  | {
      decision: 'ask';
      reason?: string;
      allowedScopes?: readonly AgentPermissionScope[];
    }
  | {
      decision: 'deny';
      reason: string;
    };

/**
 * One centralized authorization gate. The runtime invokes it after strict
 * argument validation and before the scheduler/tool handler can observe the
 * call, so individual handlers cannot accidentally bypass policy.
 */
export interface AgentToolPermissionPolicy {
  decide(
    request: AgentToolPermissionPolicyRequest,
  ):
    | AgentToolPermissionPolicyDecision
    | Promise<AgentToolPermissionPolicyDecision>;
}

export type AgentRuntimeToolSearchMode = 'off' | 'auto' | 'on';

export interface AgentToolSelectionRequest {
  /** Policy-filtered executable definitions for this runtime invocation. */
  definitions: readonly AgentToolDefinition[];
  context: AgentRuntimeContext;
  iteration: number;
  /** Deterministic, bounded query derived from the original request and recent work. */
  query: string;
  /**
   * Canonical names of successful reads from the immediately preceding tool
   * batch, after discarding reads that happened before a successful write in
   * that batch.
   *
   * This intentionally short-lived signal lets selectors avoid one redundant
   * confirmation read without turning a tool result into an unversioned cache
   * for the rest of a long-running turn.
   */
  successfulReadNamesInPreviousBatch: readonly string[];
  /**
   * Canonical names of successful reads in this turn since the most recent
   * successful write.
   *
   * This accumulated signal is reserved for deterministic, self-contained
   * catalog requests whose requested read fully answers the original prompt.
   * Generic retrieval should use `successfulReadNamesInPreviousBatch` instead.
   * A successful write invalidates the accumulated coverage.
   */
  successfulReadNamesSinceLastWrite: readonly string[];
  /**
   * True while at least one runtime-owned resultRef still reports
   * `truncated: true`. A terminal `read_tool_result` page closes only its own
   * resultRef; this becomes false after every pending resultRef is complete.
   */
  pendingResultPage: boolean;
  /** Hard provider-facing cap; selectors must never return more names. */
  limit: number;
}

/**
 * Provider-neutral retrieval seam. A selector returns canonical executable
 * names, never schemas or aliases; AgentRuntime intersects them with the
 * policy-filtered definitions before exposing or dispatching anything.
 */
export interface AgentToolSelectionStrategy {
  select(request: AgentToolSelectionRequest): readonly string[];
}

/** Coordinates write effects across concurrently running runtime instances. */
export interface AgentRuntimeScheduler {
  runRead<T>(
    request: AgentToolExecutionRequest,
    execute: () => Promise<T>,
  ): Promise<T>;
  runWrite<T>(
    request: AgentToolExecutionRequest,
    execute: () => Promise<T>,
  ): Promise<T>;
}

export interface AgentRuntimeLimits {
  maxModelIterations: number;
  maxToolCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxTotalTokens: number;
  maxCostUsd: number;
  maxDurationMs: number;
  maxOutputTokensPerIteration: number;
  maxToolArgumentBytes: number;
  maxToolResultBytes: number;
}

export interface AgentClock {
  wallNowMs(): number;
  monotonicNowMs(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface AgentJournalSink {
  /**
   * Persist one immutable entry. Implementations should be atomic/idempotent by
   * eventId and must observe the signal before committing late writes.
   */
  append(
    entry: AgentRuntimeJournalEntry,
    signal?: AbortSignal,
  ): void | Promise<void>;
}

export type AgentRuntimeFailureCode =
  | 'BUDGET_EXCEEDED'
  | 'MAX_MODEL_ITERATIONS'
  | 'MODEL_ERROR'
  | 'MODEL_MAX_TOKENS'
  | 'PROTOCOL_VIOLATION'
  | 'JOURNAL_ERROR'
  | 'INTERNAL_ERROR';

export type AgentToolResultSource = 'executor' | 'runtime';
export type AgentRuntimeOutcome = 'completed' | 'failed' | 'aborted' | 'budget_exceeded';

export type AgentRuntimeEvent =
  | { type: 'turn_started'; prompt: string }
  | { type: 'model_iteration_started'; iteration: number; driverId: string }
  | { type: 'text_delta'; iteration: number; text: string }
  | { type: 'thinking_delta'; iteration: number; text: string }
  | {
      type: 'tool_call_started';
      iteration: number;
      callId: string;
      name: string;
    }
  | {
      type: 'tool_args_delta';
      iteration: number;
      callId: string;
      delta: string;
    }
  | {
      type: 'tool_call_ready';
      iteration: number;
      callId: string;
      name: string;
      arguments: Record<string, unknown>;
      rawArguments: string;
    }
  | {
      type: 'tool_execution_started';
      callId: string;
      name: string;
      access: AgentToolDefinition['access'];
    }
  | {
      type: 'permission_requested';
      request: AgentPermissionRequest;
    }
  | {
      type: 'permission_resolved';
      resolution: AgentPermissionResolutionInput;
    }
  | {
      type: 'user_input_requested';
      request: AgentUserInputRequest;
    }
  | {
      type: 'user_input_received';
      response: {
        requestId: string;
        sessionId: string;
        turnId: string;
        callId: string;
        text: string;
      };
    }
  | {
      type: 'steering_received';
      messageId: string;
      text: string;
    }
  | {
      type: 'steering_applied';
      messageId: string;
    }
  | { type: 'stop_after_tool_requested' }
  | { type: 'cancellation_requested'; reason: string }
  | { type: 'commit_started'; outcome: AgentRuntimeOutcome }
  | {
      type: 'tool_result';
      callId: string;
      name: string;
      ok: boolean;
      content: string;
      source: AgentToolResultSource;
      errorCode?: string;
    }
  | { type: 'model_usage'; iteration: number; usage: AgentRuntimeUsage }
  | {
      type: 'model_iteration_completed';
      iteration: number;
      stopReason: AgentModelStopReason;
    }
  | {
      type: 'turn_finished';
      outcome: AgentRuntimeOutcome;
      failureCode?: AgentRuntimeFailureCode;
      message?: string;
      usage: AgentRuntimeUsage;
      modelIterations: number;
      durationMs: number;
    };

export type AgentRuntimeTerminalEvent = Extract<AgentRuntimeEvent, { type: 'turn_finished' }>;

export interface AgentRuntimeJournalEntry {
  schemaVersion: typeof AGENT_RUNTIME_SCHEMA_VERSION;
  sessionId: string;
  turnId: string;
  route: AgentRuntimeRoute;
  seq: number;
  eventId: string;
  wallTimeMs: number;
  event: AgentRuntimeEvent;
}

export type AgentRuntimeToolStatus = 'streaming' | 'ready' | 'executing' | 'completed';

export interface AgentRuntimeToolState {
  callId: string;
  name: string;
  iteration: number;
  argumentsText: string;
  arguments?: Record<string, unknown>;
  status: AgentRuntimeToolStatus;
  result?: {
    ok: boolean;
    content: string;
    source: AgentToolResultSource;
    errorCode?: string;
  };
}

export type AgentRuntimeStatus =
  | 'idle'
  | 'running'
  | 'waiting_permission'
  | 'waiting_user'
  | 'cancelling'
  | 'committing'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'budget_exceeded';

export interface AgentRuntimeState {
  sessionId: string;
  turnId: string;
  route: AgentRuntimeRoute;
  status: AgentRuntimeStatus;
  lastSeq: number;
  lastEventId: string | null;
  journalEntries: number;
  prompt: string | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
  activeIteration: number | null;
  activeIterationUsageSeen: boolean;
  modelIterations: number;
  modelIterationsWithUsage: number;
  lastStopReason: AgentModelStopReason | null;
  assistantText: string;
  thinkingText: string;
  toolOrder: string[];
  tools: Record<string, AgentRuntimeToolState>;
  pendingPermission: AgentPermissionRequest | null;
  pendingUserInput: AgentUserInputRequest | null;
  pendingSteering: { messageId: string; text: string }[];
  appliedSteeringSinceIteration: boolean;
  stopAfterToolRequested: boolean;
  usage: AgentRuntimeUsage;
  terminal: AgentRuntimeTerminalEvent | null;
}

export interface AgentRuntimeRunInput {
  sessionId: string;
  turnId: string;
  route: AgentRuntimeRoute;
  prompt: string;
  model?: string;
  systemPrompt?: string;
  reasoning?: AgentReasoningOptions;
  toolSearch?: AgentRuntimeToolSearchMode;
  history?: readonly AgentModelMessage[];
  limits?: Partial<AgentRuntimeLimits>;
  signal?: AbortSignal;
  control?: AgentRuntimeControlChannel;
  onEntry?: (entry: AgentRuntimeJournalEntry) => void;
}

export interface AgentRuntimeRunResult {
  state: AgentRuntimeState;
  entries: AgentRuntimeJournalEntry[];
  messages: AgentModelMessage[];
  /**
   * Verified context used immediately before the most recent provider call.
   * It intentionally excludes assistant/tool output produced by that call and
   * therefore is not a completed-turn checkpoint.
   */
  lastProviderCallContextEnvelope?: AgentContextProviderEnvelopeV2;
  /**
   * Created only after a successful turn's final assistant message has been
   * folded back through strict context planning. Persistence may use this as
   * the complete-turn V2 checkpoint source.
   */
  completedContextCheckpoint?: {
    canonicalSourceRows: AgentContextSourceRow[];
    providerEnvelope: AgentContextProviderEnvelopeV2;
  };
}
