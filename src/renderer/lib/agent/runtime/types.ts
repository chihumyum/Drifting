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
  AgentPromptSource,
  AgentUserInputRequest,
} from '../protocol';
import type { AgentRuntimeControlChannel } from './control-plane';

export const AGENT_RUNTIME_SCHEMA_VERSION = 1 as const;
export const AGENT_RUNTIME_TOOL_SEARCH_LIMIT = 8 as const;
export const AGENT_CONTEXT_USAGE_SCHEMA_VERSION = 2 as const;

export const AGENT_CONTEXT_USAGE_CATEGORY_KEYS = [
  'system_prompt',
  'user_messages',
  'assistant_messages',
  'thinking',
  'tool_calls',
  'tool_results',
  'write_receipts',
  'write_reviews',
  'write_reverts',
  'freshness',
  'task_plan',
  'task_constraints',
  'compaction_summaries',
  'tool_definitions',
  'provider_overhead',
] as const;

export type AgentContextUsageCategoryKey = (typeof AGENT_CONTEXT_USAGE_CATEGORY_KEYS)[number];

export interface AgentContextUsageCategory {
  key: AgentContextUsageCategoryKey;
  tokens: number;
  /** Source rows represented by this category; tool definitions count as rows. */
  sourceCount: number;
}

export interface AgentContextUsageSnapshot {
  schemaVersion: typeof AGENT_CONTEXT_USAGE_SCHEMA_VERSION;
  iteration: number;
  /** Raw provider context window. The circular indicator uses this denominator. */
  contextWindowTokens: number;
  /** Projected system/history/tool-result rows after verified compaction. */
  projectedSourceTokens: number;
  /** Tool schemas plus provider framing, not represented by context source rows. */
  fixedInputTokens: number;
  /** `projectedSourceTokens + fixedInputTokens`. */
  estimatedInputTokens: number;
  reservedOutputTokens: number;
  /** Headroom at which the planner starts compaction instead of filling the window. */
  safetyMarginTokens: number;
  usableSourceBudgetTokens: number;
  remainingSourceBudgetTokens: number;
  /** Space left after current input, output reserve, and compaction headroom. */
  freeTokens: number;
  categories: AgentContextUsageCategory[];
  toolDefinitions: Array<{ name: string; estimatedTokens: number }>;
  pinned: {
    semanticTokens: number;
    recentTurnTokens: number;
    totalTokens: number;
    sourceCount: number;
  };
  compaction: {
    initialSourceTokens: number;
    finalSourceTokens: number;
    savedTokens: number;
    stages: Array<'drop_discardable' | 'deterministic_summaries' | 'full_compactor'>;
    summaryCount: number;
    deterministicSummaryTokens: number;
    fullCompactorSummaryTokens: number;
  };
  coverage: {
    canonicalSources: number;
    representedSources: number;
    discardedSources: number;
  };
}

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

/** Provider-neutral function/tool selection for one model iteration. */
export type AgentModelToolChoice = 'auto' | 'required' | { force: string };

export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: object;
  access: 'read' | 'write';
  /**
   * Local-only identity for a concrete executable definition generation.
   * It is never sent to the model. Dynamic runtimes use it to ensure a tool
   * cannot be replaced while an approval prompt is waiting and then consume
   * the stale approval with a different handler/schema.
   */
  executionRevision?: string;
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

export const AGENT_RUNTIME_UNKNOWN_TOOL_ERROR_CODE = 'UNKNOWN_TOOL' as const;

export function agentRuntimeUnknownToolResultContent(toolName: string): string {
  return `Unknown tool "${toolName}"`;
}

export function isCanonicalAgentRuntimeUnknownToolResult(result: AgentToolResultBlock): boolean {
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
  /**
   * One-shot internal calls (for example context compaction) must not join the
   * main turn's provider reasoning cache merely because they share diagnostic
   * session/turn ids.
   */
  lifecycle?: 'turn' | 'single_request';
  /** Product-captured route; adapters must not reread mutable UI state. */
  provider?: string;
  model?: string;
  reasoning?: AgentReasoningOptions;
  /**
   * Runtime-internal provider sampling mode. This does not mutate the
   * provider/model/reasoning tuple frozen for the author turn; it only asks
   * the adapter to serialize one required tool action without spending
   * another reasoning allowance.
   */
  executionMode?: 'required_tool_non_reasoning';
  /** Runtime-selected policy for this exact iteration. */
  toolChoice?: AgentModelToolChoice;
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

/**
 * The provider/model input contract used by context planning.
 *
 * This is deliberately declared by the installed driver instead of inferred
 * from a model-name string. A gateway can expose the same model name with a
 * different window or framing cost, and silently assuming the larger value
 * would make the planner's otherwise strict checkpoint meaningless.
 */
export interface AgentModelContextProfile {
  /** Stable identity; changing any budget field requires a new id. */
  id: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  providerOverheadTokens: number;
  perToolOverheadTokens: number;
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
    /** Exact provider/model budget contract, when the driver can certify it. */
    context?: AgentModelContextProfile;
  };
  stream(request: AgentModelRequest): AsyncIterable<AgentModelStreamEvent>;
}

export type AgentRuntimeRoute =
  | { kind: 'chat'; projectId: string; conversationId?: string }
  | { kind: 'goal'; projectId: string; goalRunId?: string; chapterId?: string }
  | {
      kind: 'shadow';
      projectId: string;
      chapterId?: string;
      operation: 'review' | 'evolve-critic' | 'evolve-edit' | 'eval';
    }
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
  /**
   * Decision emitted by the central permission gate before the tool runtime is
   * allowed to observe this request. Certified writes require it and persist
   * its public-argument hash with their canonical effect.
   */
  authorization?: AgentToolExecutionAuthorization;
  /** Exact local definition generation selected before validation/approval. */
  definitionRevision?: string;
  context: AgentRuntimeContext;
  signal: AbortSignal;
  control?: {
    /**
     * Pause this tool at a canonical safe point until the user answers.
     * A provider-visible elicitation tool should delegate to this primitive.
     */
    requestUserInput(input: { requestId?: string; prompt: string }): Promise<string>;
  };
}

export interface AgentToolExecutionAuthorization {
  kind: 'automatic' | 'author_approved';
  requestId: string | null;
  argumentsHash: string;
}

export interface AgentToolExecutionPresentation {
  review?: {
    id: string;
    status: string;
  };
}

export type AgentToolExecutionResult =
  | {
      ok: true;
      /** Complete runtime result used for persistence and local UI authority. */
      data: unknown;
      /** Optional smaller, domain-natural result sent back to the model. */
      modelData?: unknown;
      /** Local presentation metadata that must never enter model context. */
      presentation?: AgentToolExecutionPresentation;
    }
  | { ok: false; error: string };

export interface AgentToolSelectionLongTaskHint {
  status: 'active' | 'paused' | 'blocked' | 'completed' | 'failed';
  scopeKind: 'explicit_targets' | 'whole_book_chapters';
  workKind?: 'edit' | 'review';
  objective: string;
  /** Provider-safe first in-progress/pending/blocked unit used for tool recall. */
  nextStep?: {
    title: string;
    /** Present for current runtimes; optional for transport/backward compatibility. */
    workKind?: 'edit' | 'review' | 'research';
    status: 'pending' | 'in_progress' | 'blocked' | 'completed' | 'failed' | 'retired';
    target: { kind: string; name: string } | null;
  };
}

/**
 * Small, runtime-owned facts that affect which tools must be provider-visible.
 *
 * This is deliberately separate from the provider context envelope: tool
 * selection runs before context planning, while both surfaces must be derived
 * from the same durable state instead of guessing continuation intent from a
 * generic user prompt.
 */
export interface AgentToolSelectionHints {
  longTask?: AgentToolSelectionLongTaskHint;
}

export interface AgentToolSelectionHintRequest {
  sessionId: string;
  turnId: string;
  context: AgentRuntimeContext;
  signal: AbortSignal;
}

/**
 * Policy-filtered tool surface for one runtime invocation.
 *
 * Future Drifting integration will derive definitions from the canonical tool
 * catalog and route `execute` through `runAgentTool`/renderer use cases.
 */
export interface AgentToolRuntime {
  listDefinitions(context: AgentRuntimeContext): readonly AgentToolDefinition[];
  /**
   * Resolve only executable legacy dispatcher aliases to the canonical model
   * tool name. Human/search aliases must never be accepted here. Returning no
   * value keeps the original name so unknown tools still fail closed.
   */
  resolveCanonicalName?(name: string, context: AgentRuntimeContext): string | undefined;
  /**
   * Load durable facts required before provider-facing tool selection. The
   * runtime reloads these hints for every searched model iteration so a plan
   * mutated by the preceding tool batch is observed immediately.
   */
  loadSelectionHints?(request: AgentToolSelectionHintRequest): Promise<AgentToolSelectionHints>;
  /**
   * Write implementations must check `signal` before entering their mutation
   * phase, make the `(sessionId, turnId, callId)` idempotency key durable, and
   * settle promptly once execution has started. The runtime will not publish a
   * terminal event while an entered write is unresolved.
   */
  execute(request: AgentToolExecutionRequest): Promise<AgentToolExecutionResult>;
}

export interface AgentToolPermissionPolicyRequest extends AgentPermissionRequest {
  context: AgentRuntimeContext;
}

export type AgentToolPermissionPolicyDecision =
  | {
      decision: 'allow';
      scope?: AgentPermissionScope;
      /** Durable authority row that satisfied this exact request. */
      grantId?: string;
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
  ): AgentToolPermissionPolicyDecision | Promise<AgentToolPermissionPolicyDecision>;
  /** Persist a broader author choice before the dispatcher can observe it. */
  recordResolution?(
    request: AgentToolPermissionPolicyRequest,
    resolution: AgentPermissionResolutionInput,
  ): void | { authorityId: string } | Promise<void | { authorityId: string }>;
}

export type AgentRuntimeToolSearchMode = 'off' | 'auto' | 'on';

export interface AgentToolSelectionRequest {
  /** Policy-filtered executable definitions for this runtime invocation. */
  definitions: readonly AgentToolDefinition[];
  context: AgentRuntimeContext;
  iteration: number;
  /** Durable runtime facts that must not be inferred from a vague prompt. */
  hints: AgentToolSelectionHints;
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
  /**
   * Canonical installed tools whose immediately preceding call could not be
   * validated or was omitted from the searched schema. Selectors may use this
   * as context, while AgentRuntime itself guarantees a one-iteration repair
   * lease by forcing these definitions into the provider-facing surface.
   */
  repairToolNames: readonly string[];
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
  runRead<T>(request: AgentToolExecutionRequest, execute: () => Promise<T>): Promise<T>;
  runWrite<T>(request: AgentToolExecutionRequest, execute: () => Promise<T>): Promise<T>;
}

export interface AgentRuntimeLimits {
  /** Null means the turn continues until completion, cancellation, or a real failure. */
  maxModelIterations: number | null;
  maxToolCalls: number | null;
  /** Aggregate usage limits are optional; the provider context window remains enforced separately. */
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  maxTotalTokens: number | null;
  maxCostUsd: number | null;
  maxDurationMs: number | null;
  /** Provider calls still need a finite response-size request. This is not a task budget. */
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
  append(entry: AgentRuntimeJournalEntry, signal?: AbortSignal): void | Promise<void>;
}

export type AgentRuntimeFailureCode =
  | 'BUDGET_EXCEEDED'
  | 'MAX_MODEL_ITERATIONS'
  | 'MODEL_ERROR'
  | 'MODEL_MAX_TOKENS'
  | 'PROTOCOL_VIOLATION'
  | 'JOURNAL_ERROR'
  | 'INTERNAL_ERROR';

export const AGENT_RUNTIME_DURABLE_COMMIT_FAILURE_MESSAGE =
  "The Agent turn's completed conversation context could not be durably adopted. Any manuscript writes that committed are tracked independently and will be reconciled on reload.";
export const AGENT_RUNTIME_INTERRUPTED_RECOVERY_MESSAGE =
  'The Agent execution was interrupted before a terminal result was durably recorded.';

export type AgentToolResultSource = 'executor' | 'runtime';
export type AgentRuntimeOutcome = 'completed' | 'failed' | 'aborted' | 'budget_exceeded';

export type AgentRuntimeEvent =
  | {
      type: 'turn_started';
      prompt: string;
      promptSource?: AgentPromptSource;
      completionTool?: string;
    }
  | { type: 'model_iteration_started'; iteration: number; driverId: string }
  | {
      type: 'context_planned';
      iteration: number;
      snapshot: AgentContextUsageSnapshot;
    }
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
      review?: {
        id: string;
        status: string;
      };
    }
  | { type: 'model_usage'; iteration: number; usage: AgentRuntimeUsage }
  | {
      type: 'model_iteration_completed';
      iteration: number;
      stopReason: AgentModelStopReason;
    }
  | {
      type: 'completion_tool_accepted';
      callId: string;
      name: string;
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
  completionToolName: string | null;
  completionToolCallId: string | null;
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
  promptSource?: AgentPromptSource;
  provider?: string;
  model?: string;
  contextMode?: 'standard' | 'max';
  systemPrompt?: string;
  reasoning?: AgentReasoningOptions;
  /**
   * Structured-output completion boundary. A successful call to this tool ends
   * the turn without an extra prose synthesis round. Before the final iteration
   * the runtime keeps nudging instead of accepting an unstructured text answer.
   */
  completionTool?: {
    name: string;
    forceOnFinalIteration?: boolean;
    disableReasoningWhenForced?: boolean;
    reminder?: string;
  };
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
  completionTool?: {
    callId: string;
    name: string;
    arguments: Record<string, unknown>;
    result: AgentToolResultBlock;
  };
  /**
   * Verified context used immediately before the most recent provider call.
   * It intentionally excludes assistant/tool output produced by that call and
   * therefore is not a completed-turn checkpoint.
   */
  lastProviderCallContextEnvelope?: AgentContextProviderEnvelopeV2;
  /**
   * Created after a successful turn, or a resumable budget slice, has folded
   * every completed assistant/tool message back through strict context
   * planning. Persistence may use this as the complete-turn V2 checkpoint
   * source.
   */
  completedContextCheckpoint?: {
    canonicalSourceRows: AgentContextSourceRow[];
    providerEnvelope: AgentContextProviderEnvelopeV2;
  };
}
