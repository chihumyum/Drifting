import { systemAgentClock } from './clock';
import { hashAgentPermissionArguments } from './control-plane';
import {
  abortReason,
  AgentRuntimeAbortError,
  AgentRuntimeError,
  publicModelDriverErrorMessage,
} from './errors';
import { agentRuntimeEventId, createAgentRuntimeState, reduceAgentRuntimeJournal } from './reducer';
import { clonePortableData } from './portable-data';
import {
  AGENT_FINAL_RESPONSE_MARKER,
  stripAgentFinalResponseMarker,
} from './presentation-protocol';
import {
  AgentRuntimeContextPlanningCoordinator,
  type AgentRuntimeContextPlanningOptions,
} from './runtime-context-planning';
import { sharedAgentRuntimeScheduler } from './scheduler';
import {
  AGENT_RUNTIME_SCHEMA_VERSION,
  AGENT_RUNTIME_TOOL_SEARCH_LIMIT,
  AGENT_RUNTIME_UNKNOWN_TOOL_ERROR_CODE,
  agentRuntimeUnknownToolResultContent,
  type AgentAssistantContentBlock,
  type AgentAssistantThinkingBlock,
  type AgentAssistantTextBlock,
  type AgentAssistantToolCallBlock,
  type AgentClock,
  type AgentJournalSink,
  type AgentModelMessage,
  type AgentModelRequest,
  type AgentModelStopReason,
  type AgentModelStreamEvent,
  type AgentRuntimeContext,
  type AgentRuntimeEvent,
  type AgentRuntimeJournalEntry,
  type AgentRuntimeLimits,
  type AgentRuntimeRunInput,
  type AgentRuntimeRunResult,
  type AgentRuntimeScheduler,
  type AgentRuntimeUsage,
  type AgentToolDefinition,
  type AgentToolExecutionAuthorization,
  type AgentToolExecutionPresentation,
  type AgentToolExecutionResult,
  type AgentToolPermissionPolicy,
  type AgentToolPermissionPolicyDecision,
  type AgentToolPermissionPolicyRequest,
  type AgentToolResultBlock,
  type AgentToolRuntime,
  type AgentToolSelectionHints,
  type AgentToolSelectionStrategy,
  type AgentToolValidationResult,
} from './types';

export const DEFAULT_AGENT_RUNTIME_LIMITS: AgentRuntimeLimits = {
  maxModelIterations: null,
  maxToolCalls: null,
  maxInputTokens: null,
  maxOutputTokens: null,
  maxTotalTokens: null,
  maxCostUsd: null,
  maxDurationMs: null,
  maxOutputTokensPerIteration: 8_192,
  maxToolArgumentBytes: 64 * 1024,
  maxToolResultBytes: 128 * 1024,
};

const RESULT_PAGE_TOOL = 'read_tool_result';
const MAX_SYNTHESIS_OUTPUT_TOKEN_RESERVE = 2_048;
export const AGENT_SYNTHESIS_ONLY_SYSTEM_NOTE =
  'Runtime synthesis boundary: tool execution is disabled for this final response. Do not emit function-call, XML, DSML, or other tool invocation markup, and do not claim an unexecuted call. Summarize only verified results, state unfinished work explicitly, and end with ordinary prose.';
export const AGENT_SYNTHESIS_DISCARDED_TOOL_TEXT =
  'This execution slice ended before another tool call could run. The unexecuted invocation was discarded; durable task progress is preserved for continuation.';

function sanitizeAgentSynthesisText(text: string): string {
  const containsToolMarkup = [
    /DSML[\s\S]{0,80}(?:tool_calls?|invoke)/i,
    /<\s*\/?\s*(?:tool_calls?|function_calls?)\b/i,
    /<\s*invoke\b[^>]*\bname\s*=/i,
    /["']tool_calls?["']\s*:/i,
  ].some((pattern) => pattern.test(text));
  return containsToolMarkup ? AGENT_SYNTHESIS_DISCARDED_TOOL_TEXT : text;
}

const emptyToolRuntime: AgentToolRuntime = {
  listDefinitions: () => [],
  execute: async () => ({ ok: false, error: 'No tool runtime is installed' }),
};

export interface AgentRuntimeDependencies {
  driver: import('./types').AgentModelDriver;
  tools?: AgentToolRuntime;
  toolSelector?: AgentToolSelectionStrategy;
  contextPlanning?: AgentRuntimeContextPlanningOptions;
  permissionPolicy?: AgentToolPermissionPolicy;
  clock?: AgentClock;
  journal?: AgentJournalSink;
  scheduler?: AgentRuntimeScheduler;
}

interface MutableToolCall {
  callId: string;
  name: string;
  iteration: number;
  rawArguments: string;
  argumentBytes: number;
  argumentsTooLarge: boolean;
  repairRequested: boolean;
  ended: boolean;
  block: AgentAssistantToolCallBlock;
  definition?: AgentToolDefinition;
  validatedArguments?: Record<string, unknown>;
  authorization?: AgentToolExecutionAuthorization;
  result?: AgentToolResultBlock;
}

interface ModelIterationResult {
  assistant: AgentModelMessage;
  toolResults: AgentToolResultBlock[];
  repairToolNames: readonly string[];
  stopReason: AgentModelStopReason;
  completionTool?: NonNullable<AgentRuntimeRunResult['completionTool']>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface PendingResultPageUpdate {
  resultRef: string;
  pending: boolean;
}

function pendingResultPageUpdateFromToolResult(
  result: AgentToolResultBlock,
): PendingResultPageUpdate | undefined {
  if (!result.ok || !result.content.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.content);
  } catch {
    return undefined;
  }
  const candidates = [parsed, isRecord(parsed) ? parsed.result : undefined];
  for (const candidate of candidates) {
    if (!isRecord(candidate) || typeof candidate.truncated !== 'boolean') {
      continue;
    }
    const reread = isRecord(candidate.reread) ? candidate.reread : undefined;
    const rereadArguments = isRecord(reread?.arguments) ? reread.arguments : undefined;
    const resultRef =
      typeof candidate.resultRef === 'string'
        ? candidate.resultRef
        : typeof rereadArguments?.resultRef === 'string'
          ? rereadArguments.resultRef
          : undefined;
    if (!resultRef) continue;
    if (result.name === RESULT_PAGE_TOOL) {
      return { resultRef, pending: candidate.truncated };
    }
    if (candidate.truncated === true && reread?.tool === RESULT_PAGE_TOOL) {
      return { resultRef, pending: true };
    }
  }
  return undefined;
}

function cloneMessage(message: AgentModelMessage): AgentModelMessage {
  return clonePortableData(message);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value;
  const objectValue = value as object;
  if (seen.has(objectValue)) return value;
  seen.add(objectValue);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function canonicalizeArguments(
  value: unknown,
): { ok: true; value: Record<string, unknown>; text: string } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: 'Validator must return a JSON object' };
  try {
    const text = JSON.stringify(value);
    if (!text) return { ok: false, error: 'Validator returned a non-JSON value' };
    const cloned: unknown = JSON.parse(text);
    if (!isRecord(cloned)) return { ok: false, error: 'Validator must return a JSON object' };
    return { ok: true, value: cloned, text };
  } catch (error) {
    return {
      ok: false,
      error: `Validator returned a non-serializable value: ${toErrorMessage(error)}`,
    };
  }
}

function permissionRevision(value: Record<string, unknown>): string | null {
  const revision = value.expectedRevision;
  if (typeof revision === 'string' || (typeof revision === 'number' && Number.isFinite(revision))) {
    return String(revision);
  }
  return null;
}

function validatePermissionDecision(
  value: AgentToolPermissionPolicyDecision,
): AgentToolPermissionPolicyDecision {
  if (value.decision === 'allow') {
    if (
      value.scope !== undefined &&
      value.scope !== 'once' &&
      value.scope !== 'session' &&
      value.scope !== 'project'
    ) {
      throw new AgentRuntimeError(
        'INTERNAL_ERROR',
        'Permission policy returned an invalid allow scope',
      );
    }
    if (value.grantId !== undefined && !value.grantId.trim()) {
      throw new AgentRuntimeError('INTERNAL_ERROR', 'Permission policy returned an empty grant id');
    }
    return value;
  }
  if (value.decision === 'deny') {
    if (!value.reason.trim()) {
      throw new AgentRuntimeError(
        'INTERNAL_ERROR',
        'Permission policy returned an empty deny reason',
      );
    }
    return value;
  }
  if (value.decision !== 'ask') {
    throw new AgentRuntimeError(
      'INTERNAL_ERROR',
      'Permission policy returned an unsupported decision',
    );
  }
  const scopes = value.allowedScopes ?? ['once'];
  if (
    scopes.length === 0 ||
    scopes.length > 3 ||
    new Set(scopes).size !== scopes.length ||
    scopes.some((scope) => scope !== 'once' && scope !== 'session' && scope !== 'project')
  ) {
    throw new AgentRuntimeError(
      'INTERNAL_ERROR',
      'Permission policy returned invalid permission scopes',
    );
  }
  return { ...value, allowedScopes: [...scopes] };
}

function mergeLimits(overrides?: Partial<AgentRuntimeLimits>): AgentRuntimeLimits {
  const limits = { ...DEFAULT_AGENT_RUNTIME_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (value === null) {
      if (
        name !== 'maxOutputTokensPerIteration' &&
        name !== 'maxToolArgumentBytes' &&
        name !== 'maxToolResultBytes'
      ) {
        continue;
      }
      throw new AgentRuntimeError('INTERNAL_ERROR', `Invalid runtime limit ${name}=null`);
    }
    if (!Number.isFinite(value) || value <= 0) {
      throw new AgentRuntimeError('INTERNAL_ERROR', `Invalid runtime limit ${name}=${value}`);
    }
  }
  return limits;
}

function synthesisOutputTokenReserve(limits: AgentRuntimeLimits): number {
  if (
    limits.maxModelIterations === null &&
    limits.maxOutputTokens === null &&
    limits.maxTotalTokens === null
  ) {
    return 0;
  }
  const aggregateLimits = [limits.maxOutputTokens, limits.maxTotalTokens].filter(
    (value): value is number => value !== null,
  );
  return Math.max(
    0,
    Math.floor(
      Math.min(
        MAX_SYNTHESIS_OUTPUT_TOKEN_RESERVE,
        limits.maxOutputTokensPerIteration,
        ...aggregateLimits.map((value) => value / 2),
      ),
    ),
  );
}

function validateUsage(usage: AgentRuntimeUsage): void {
  for (const name of [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
  ] as const) {
    const value = usage[name];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new AgentRuntimeError(
        'PROTOCOL_VIOLATION',
        `Provider reported invalid usage ${name}=${value}`,
      );
    }
  }
  if (!Number.isFinite(usage.costUsd) || usage.costUsd < 0) {
    throw new AgentRuntimeError(
      'PROTOCOL_VIOLATION',
      `Provider reported invalid usage costUsd=${usage.costUsd}`,
    );
  }
}

function stringifyToolData(
  data: unknown,
): { ok: true; text: string } | { ok: false; error: string } {
  if (typeof data === 'string') return { ok: true, text: data };
  if (data === undefined) return { ok: true, text: '' };
  try {
    const text = JSON.stringify(data);
    return { ok: true, text: text ?? String(data) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Tool result is not serializable',
    };
  }
}

function appendContentDelta(
  blocks: AgentAssistantContentBlock[],
  kind: 'text' | 'thinking',
  delta: string,
): void {
  const last = blocks[blocks.length - 1];
  if (kind === 'text' && last?.type === 'text') {
    last.text += delta;
    return;
  }
  if (kind === 'thinking' && last?.type === 'thinking') {
    last.text += delta;
    return;
  }
  if (kind === 'text') {
    const block: AgentAssistantTextBlock = { type: 'text', text: delta };
    blocks.push(block);
  } else {
    const block: AgentAssistantThinkingBlock = { type: 'thinking', text: delta };
    blocks.push(block);
  }
}

function textFromAssistantBlocks(blocks: readonly AgentAssistantContentBlock[]): string {
  return blocks
    .filter((block): block is AgentAssistantTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function normalizedFinalResponseBlocks(
  blocks: readonly AgentAssistantContentBlock[],
): AgentAssistantContentBlock[] {
  const rawText = textFromAssistantBlocks(blocks);
  if (!rawText.includes(AGENT_FINAL_RESPONSE_MARKER)) return [...blocks];
  const visibleText = stripAgentFinalResponseMarker(rawText);
  return [...blocks.filter((block) => block.type !== 'text'), { type: 'text', text: visibleText }];
}

function protocol(message: string): never {
  throw new AgentRuntimeError('PROTOCOL_VIOLATION', message);
}

function modelFailure(message: string): never {
  throw new AgentRuntimeError('MODEL_ERROR', message);
}

function modelDriverFailure(error: unknown): never {
  throw new AgentRuntimeError('MODEL_ERROR', publicModelDriverErrorMessage(error));
}

function budget(message: string): never {
  throw new AgentRuntimeError('BUDGET_EXCEEDED', message);
}

function normalizeToolExecution(
  result: AgentToolExecutionResult,
  access: AgentToolDefinition['access'],
): { ok: boolean; text: string; source: 'executor' | 'runtime'; errorCode?: string } {
  if (!result.ok) return { ok: false, text: result.error, source: 'executor' };
  const serialized = stringifyToolData(result.modelData ?? result.data);
  if (!serialized.ok) {
    return {
      ok: access === 'write',
      text:
        access === 'write'
          ? `Write completed, but its result could not be serialized: ${serialized.error}`
          : `Tool result serialization failed: ${serialized.error}`,
      source: 'runtime',
      errorCode: 'TOOL_RESULT_SERIALIZATION_FAILED',
    };
  }
  return { ok: true, text: serialized.text, source: 'executor' };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function groupDefinitions(
  definitions: readonly AgentToolDefinition[],
): Map<string, AgentToolDefinition> {
  const byName = new Map<string, AgentToolDefinition>();
  for (const definition of definitions) {
    if (!definition.name) {
      throw new AgentRuntimeError('INTERNAL_ERROR', 'Tool definition has an empty name');
    }
    if (byName.has(definition.name)) {
      throw new AgentRuntimeError(
        'INTERNAL_ERROR',
        `Duplicate tool definition "${definition.name}"`,
      );
    }
    byName.set(definition.name, definition);
  }
  return byName;
}

const TOOL_SEARCH_PROMPT_CHARS = 1_024;
const TOOL_SEARCH_RECENT_MESSAGE_CHARS = 640;
const TOOL_SEARCH_RECENT_MESSAGE_COUNT = 4;
const TOOL_SEARCH_QUERY_CHARS = 4_096;

function clipped(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const omission = '\n…\n';
  const available = maxChars - omission.length;
  const headChars = Math.ceil(available / 2);
  const tailChars = available - headChars;
  return `${value.slice(0, headChars)}${omission}${value.slice(-tailChars)}`;
}

function searchableMessageText(message: AgentModelMessage): string {
  if (message.role === 'user') return '';
  if (message.role === 'tool') {
    return message.content
      .map(
        (result) => `tool ${result.ok ? 'success' : 'failure'} ${result.name}: ${result.content}`,
      )
      .join('\n');
  }
  return message.content
    .flatMap((block) => {
      if (block.type === 'text') return [block.text];
      if (block.type === 'tool_call') return [`tool ${block.name}`];
      return [];
    })
    .join('\n');
}

/**
 * Keep retrieval deterministic and bounded. The original request remains the
 * stable anchor; only the four most recent assistant/tool messages can affect
 * a later iteration's tool surface.
 */
export function buildAgentToolSearchQuery(
  prompt: string,
  messages: readonly AgentModelMessage[],
): string {
  const recent = messages
    .map((message) => searchableMessageText(message))
    .filter((value) => value.trim().length > 0)
    .slice(-TOOL_SEARCH_RECENT_MESSAGE_COUNT)
    .map((value) => clipped(value, TOOL_SEARCH_RECENT_MESSAGE_CHARS));
  return clipped(
    [
      `original request:\n${clipped(prompt, TOOL_SEARCH_PROMPT_CHARS)}`,
      ...recent.map((value) => `recent work:\n${value}`),
    ].join('\n'),
    TOOL_SEARCH_QUERY_CHARS,
  );
}

export class AgentRuntime {
  private readonly driver: AgentRuntimeDependencies['driver'];
  private readonly tools: AgentToolRuntime;
  private readonly toolSelector?: AgentToolSelectionStrategy;
  private readonly contextPlanning: AgentRuntimeContextPlanningCoordinator;
  private readonly permissionPolicy?: AgentToolPermissionPolicy;
  private readonly clock: AgentClock;
  private readonly journal?: AgentJournalSink;
  private readonly scheduler: AgentRuntimeScheduler;
  private readonly encoder = new TextEncoder();

  constructor(dependencies: AgentRuntimeDependencies) {
    this.driver = dependencies.driver;
    this.tools = dependencies.tools ?? emptyToolRuntime;
    this.toolSelector = dependencies.toolSelector;
    this.contextPlanning = new AgentRuntimeContextPlanningCoordinator(dependencies.contextPlanning);
    this.permissionPolicy = dependencies.permissionPolicy;
    this.clock = dependencies.clock ?? systemAgentClock;
    this.journal = dependencies.journal;
    this.scheduler = dependencies.scheduler ?? sharedAgentRuntimeScheduler;
  }

  async runTurn(input: AgentRuntimeRunInput): Promise<AgentRuntimeRunResult> {
    const limits = mergeLimits(input.limits);
    const route = deepFreeze(clonePortableData(input.route));
    const context: AgentRuntimeContext = { route };
    if (
      input.control &&
      (input.control.sessionId !== input.sessionId || input.control.turnId !== input.turnId)
    ) {
      throw new AgentRuntimeError(
        'INTERNAL_ERROR',
        'The runtime control channel belongs to a different turn',
      );
    }
    const definitions = Object.freeze(
      [...this.tools.listDefinitions(context)].map((definition) => {
        if (
          (definition.access !== 'read' && definition.access !== 'write') ||
          typeof definition.validateInput !== 'function'
        ) {
          throw new AgentRuntimeError(
            'INTERNAL_ERROR',
            `Tool definition "${definition.name}" is not executable`,
          );
        }
        let inputSchema: object;
        try {
          inputSchema = deepFreeze(clonePortableData(definition.inputSchema));
        } catch {
          throw new AgentRuntimeError(
            'INTERNAL_ERROR',
            `Tool definition "${definition.name}" has a non-portable schema`,
          );
        }
        return { ...definition, inputSchema };
      }),
    );
    const availableDefinitionsByName = groupDefinitions(definitions);
    const completionToolName = input.completionTool?.name.trim();
    if (input.completionTool && !completionToolName) {
      throw new AgentRuntimeError('INTERNAL_ERROR', 'Completion tool name must not be empty');
    }
    if (completionToolName && !availableDefinitionsByName.has(completionToolName)) {
      throw new AgentRuntimeError(
        'INTERNAL_ERROR',
        `Completion tool "${completionToolName}" is not installed`,
      );
    }
    const toolSearch = input.toolSearch ?? 'off';
    if (toolSearch !== 'off' && toolSearch !== 'auto' && toolSearch !== 'on') {
      throw new AgentRuntimeError(
        'INTERNAL_ERROR',
        `Invalid tool search mode "${String(toolSearch)}"`,
      );
    }
    const messages: AgentModelMessage[] = [
      ...(input.history ?? []).map(cloneMessage),
      { role: 'user', content: input.prompt },
    ];
    let state = createAgentRuntimeState(input.sessionId, input.turnId, route);
    const controller = new AbortController();
    const journalController = new AbortController();
    const detachParentAbort = this.linkAbort(input.signal, controller);
    const detachParentJournalAbort = this.linkAbort(input.signal, journalController);
    const startedMonoMs = this.clock.monotonicNowMs();
    const deadlineController = new AbortController();
    let deadlineTriggered = false;
    let deadlineError: AgentRuntimeError | null = null;
    if (limits.maxDurationMs !== null) {
      deadlineError = new AgentRuntimeError(
        'BUDGET_EXCEEDED',
        `maxDurationMs reached: ${limits.maxDurationMs}`,
      );
      const installedDeadlineError = deadlineError;
      void this.clock
        .sleep(limits.maxDurationMs, deadlineController.signal)
        .then(() => {
          if (!controller.signal.aborted) {
            deadlineTriggered = true;
            controller.abort(installedDeadlineError);
          }
          if (!journalController.signal.aborted) {
            journalController.abort(installedDeadlineError);
          }
        })
        .catch(() => undefined);
    }
    const entries: AgentRuntimeJournalEntry[] = [];
    let seq = 0;
    let totalToolCalls = 0;
    let userInputSequence = 0;
    let steeringSequence = 0;
    let acceptingControl = true;
    const successfulReadNamesSinceLastWrite = new Set<string>();
    let successfulReadNamesInPreviousBatch = new Set<string>();
    let repairToolNamesForNextIteration = new Set<string>();
    const pendingResultRefs = new Set<string>();
    let detachControl: () => void = () => undefined;
    let journalDisabled = false;
    let lastProviderCallContextEnvelope:
      | import('./context-message-adapter').AgentContextProviderEnvelopeV2
      | undefined;
    let completedContextCheckpoint:
      | NonNullable<AgentRuntimeRunResult['completedContextCheckpoint']>
      | undefined;
    let completedTool: NonNullable<AgentRuntimeRunResult['completionTool']> | undefined;
    let lastPlanningSelection:
      | {
          iteration: number;
          requestedOutputTokens: number;
          tools: import('./types').AgentModelToolDefinition[];
        }
      | undefined;
    const seenToolCallIds = new Set<string>();

    const durationMs = () => Math.max(0, this.clock.monotonicNowMs() - startedMonoMs);
    const throwIfStopped = (): void => {
      if (!controller.signal.aborted) return;
      if (controller.signal.reason instanceof AgentRuntimeError) {
        throw controller.signal.reason;
      }
      throw new AgentRuntimeAbortError(abortReason(controller.signal));
    };
    const awaitWithSignal = async <T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> => {
      if (signal.aborted) {
        const reason = signal.reason;
        throw reason instanceof AgentRuntimeError
          ? reason
          : new AgentRuntimeAbortError(abortReason(signal));
      }
      return new Promise<T>((resolve, reject) => {
        let settled = false;
        const cleanup = () => signal.removeEventListener('abort', onAbort);
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          cleanup();
          callback();
        };
        const onAbort = () => {
          finish(() => {
            const reason = signal.reason;
            reject(
              reason instanceof AgentRuntimeError
                ? reason
                : new AgentRuntimeAbortError(abortReason(signal)),
            );
          });
        };
        signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(work).then(
          (value) => finish(() => resolve(value)),
          (error: unknown) => finish(() => reject(error)),
        );
      });
    };
    const awaitAbortable = <T>(work: PromiseLike<T>): Promise<T> =>
      awaitWithSignal(work, controller.signal);
    const appendEvent = async (event: AgentRuntimeEvent, cleanup = false): Promise<void> => {
      const nextSeq = seq + 1;
      const entry = deepFreeze<AgentRuntimeJournalEntry>({
        schemaVersion: AGENT_RUNTIME_SCHEMA_VERSION,
        sessionId: input.sessionId,
        turnId: input.turnId,
        route,
        seq: nextSeq,
        eventId: agentRuntimeEventId(input.turnId, nextSeq),
        wallTimeMs: this.clock.wallNowMs(),
        event: clonePortableData(event),
      });
      const nextState = reduceAgentRuntimeJournal(state, entry);
      let journalError: unknown;
      if (this.journal && !journalDisabled) {
        try {
          await awaitWithSignal(
            Promise.resolve(this.journal.append(entry, journalController.signal)),
            journalController.signal,
          );
        } catch (error) {
          journalDisabled = true;
          journalError = error;
        }
      }
      seq = nextSeq;
      state = nextState;
      entries.push(entry);
      try {
        input.onEntry?.(entry);
      } catch {
        // Observers are projections; they cannot change runtime correctness.
      }
      if (journalError !== undefined) {
        if (cleanup) return;
        if (controller.signal.aborted) throwIfStopped();
        if (journalController.signal.aborted) {
          const reason = journalController.signal.reason;
          throw reason instanceof AgentRuntimeError
            ? reason
            : new AgentRuntimeAbortError(abortReason(journalController.signal));
        }
        throw new AgentRuntimeError('JOURNAL_ERROR', 'Agent journal persistence failed');
      }
    };
    let emitTail: Promise<void> = Promise.resolve();
    const emit = (event: AgentRuntimeEvent, cleanup = false): Promise<void> => {
      const operation = emitTail.then(() => appendEvent(event, cleanup));
      emitTail = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    };

    if (input.control) {
      detachControl = input.control.attach({
        onSteering: async ({ text }) => {
          if (!acceptingControl || state.terminal) {
            throw new AgentRuntimeError(
              'INTERNAL_ERROR',
              'The Agent turn is no longer accepting steering',
            );
          }
          steeringSequence += 1;
          await emit({
            type: 'steering_received',
            messageId: `${input.turnId}:steering:${steeringSequence}`,
            text,
          });
        },
        onStopAfterTool: async () => {
          if (!acceptingControl || state.terminal) {
            throw new AgentRuntimeError(
              'INTERNAL_ERROR',
              'The Agent turn is no longer accepting stop requests',
            );
          }
          if (state.stopAfterToolRequested) return;
          await emit({ type: 'stop_after_tool_requested' });
        },
        onCancellation: async (reason) => {
          if (state.terminal || state.status === 'committing') return;
          if (state.status !== 'cancelling') {
            await emit({ type: 'cancellation_requested', reason }, true);
          }
          if (!controller.signal.aborted) controller.abort(reason);
        },
      });
    }

    const applyPendingSteering = async (): Promise<number> => {
      let applied = 0;
      while (state.pendingSteering.length > 0) {
        const message = state.pendingSteering[0];
        messages.push({ role: 'user', content: message.text });
        await emit({
          type: 'steering_applied',
          messageId: message.messageId,
        });
        applied += 1;
      }
      return applied;
    };

    const checkDurationBudget = (): void => {
      if (limits.maxDurationMs !== null && durationMs() > limits.maxDurationMs) {
        budget(`maxDurationMs exceeded: ${durationMs()} > ${limits.maxDurationMs}`);
      }
    };
    const checkUsageBudget = (): void => {
      const usage = state.usage;
      if (limits.maxInputTokens !== null && usage.inputTokens > limits.maxInputTokens) {
        budget(`maxInputTokens exceeded: ${usage.inputTokens} > ${limits.maxInputTokens}`);
      }
      if (limits.maxOutputTokens !== null && usage.outputTokens > limits.maxOutputTokens) {
        budget(`maxOutputTokens exceeded: ${usage.outputTokens} > ${limits.maxOutputTokens}`);
      }
      const totalTokens = usage.inputTokens + usage.outputTokens;
      if (limits.maxTotalTokens !== null && totalTokens > limits.maxTotalTokens) {
        budget(`maxTotalTokens exceeded: ${totalTokens} > ${limits.maxTotalTokens}`);
      }
      if (limits.maxCostUsd !== null && usage.costUsd > limits.maxCostUsd) {
        budget(`maxCostUsd exceeded: ${usage.costUsd} > ${limits.maxCostUsd}`);
      }
    };
    const checkBeforeWork = (): void => {
      throwIfStopped();
      checkDurationBudget();
      checkUsageBudget();
    };

    const emitRuntimeToolResult = async (
      call: MutableToolCall,
      content: string,
      errorCode: string,
      repairable = false,
    ): Promise<void> => {
      if (call.result) return;
      call.repairRequested = repairable;
      await emit({
        type: 'tool_result',
        callId: call.callId,
        name: call.name,
        ok: false,
        content,
        source: 'runtime',
        errorCode,
      });
      call.result = {
        callId: call.callId,
        name: call.name,
        ok: false,
        content,
        ...(errorCode === AGENT_RUNTIME_UNKNOWN_TOOL_ERROR_CODE
          ? {
              source: 'runtime' as const,
              errorCode: AGENT_RUNTIME_UNKNOWN_TOOL_ERROR_CODE,
            }
          : {}),
      };
    };

    const authorizeTool = async (call: MutableToolCall): Promise<boolean> => {
      if (!call.definition || !call.validatedArguments || call.result) {
        return false;
      }
      const argumentsHash = await awaitAbortable(
        hashAgentPermissionArguments(call.validatedArguments),
      );
      const baseRequest = {
        requestId: `${input.turnId}:${call.callId}:permission`,
        sessionId: input.sessionId,
        turnId: input.turnId,
        callId: call.callId,
        toolName: call.name,
        access: call.definition.access,
        arguments: clonePortableData(call.validatedArguments),
        argumentsHash,
        revision: permissionRevision(call.validatedArguments),
        ...(call.definition.executionRevision
          ? {
              toolDefinitionRevision: call.definition.executionRevision,
            }
          : {}),
        allowedScopes: ['once'] as const,
      };
      let decision: AgentToolPermissionPolicyDecision = {
        decision: 'allow',
        scope: 'once',
      };
      if (this.permissionPolicy) {
        const policyRequest: AgentToolPermissionPolicyRequest = {
          ...baseRequest,
          context,
        };
        try {
          decision = validatePermissionDecision(
            await awaitAbortable(Promise.resolve(this.permissionPolicy.decide(policyRequest))),
          );
        } catch (error) {
          if (error instanceof AgentRuntimeError) throw error;
          throw new AgentRuntimeError(
            'INTERNAL_ERROR',
            `Permission policy failed: ${toErrorMessage(error)}`,
          );
        }
      }
      if (decision.decision === 'allow') {
        call.authorization = {
          kind: decision.grantId ? 'author_approved' : 'automatic',
          requestId: decision.grantId ?? null,
          argumentsHash,
        };
        return true;
      }
      if (decision.decision === 'deny') {
        await emitRuntimeToolResult(
          call,
          `Permission denied: ${decision.reason}`,
          'PERMISSION_DENIED',
        );
        return false;
      }
      const request = deepFreeze({
        ...baseRequest,
        ...(decision.reason ? { reason: decision.reason } : {}),
        allowedScopes: [...(decision.allowedScopes ?? ['once'])],
      });
      if (
        request.allowedScopes.some((scope) => scope !== 'once') &&
        !this.permissionPolicy?.recordResolution
      ) {
        throw new AgentRuntimeError(
          'INTERNAL_ERROR',
          'Permission policy advertised a durable scope without an authority store',
        );
      }
      if (!input.control) {
        await emitRuntimeToolResult(
          call,
          'Permission denied because no interactive control channel is installed.',
          'PERMISSION_CONTROL_UNAVAILABLE',
        );
        return false;
      }
      const resolutionPromise = input.control.waitForPermission(request, controller.signal);
      await emit({ type: 'permission_requested', request });
      let resolution;
      let authorityId: string | null = null;
      try {
        resolution = await awaitAbortable(resolutionPromise);
        if (
          resolution.decision === 'allow' &&
          resolution.scope !== 'once' &&
          this.permissionPolicy?.recordResolution
        ) {
          const recorded = await awaitAbortable(
            Promise.resolve(
              this.permissionPolicy.recordResolution({ ...request, context }, resolution),
            ),
          );
          authorityId = recorded?.authorityId ?? null;
          if (!authorityId) {
            throw new AgentRuntimeError(
              'INTERNAL_ERROR',
              'Durable permission authority did not return its persisted id',
            );
          }
        }
        await emit({ type: 'permission_resolved', resolution });
        input.control.acknowledgePermission(resolution.requestId);
      } catch (error) {
        input.control.acknowledgePermission(request.requestId);
        throw error;
      }
      if (resolution.decision === 'allow') {
        call.authorization = {
          kind: 'author_approved',
          requestId: authorityId ?? resolution.requestId,
          argumentsHash,
        };
        return true;
      }
      await emitRuntimeToolResult(
        call,
        `Permission denied${resolution.reason ? `: ${resolution.reason}` : '.'}`,
        'PERMISSION_DENIED',
      );
      return false;
    };

    const toolControl = (call: MutableToolCall) => ({
      requestUserInput: async ({
        requestId,
        prompt,
      }: {
        requestId?: string;
        prompt: string;
      }): Promise<string> => {
        if (!prompt.trim()) {
          throw new AgentRuntimeError(
            'INTERNAL_ERROR',
            'A user input request cannot have an empty prompt',
          );
        }
        if (!input.control) {
          throw new AgentRuntimeError(
            'INTERNAL_ERROR',
            'No interactive control channel is installed',
          );
        }
        userInputSequence += 1;
        const request = deepFreeze({
          requestId: requestId ?? `${input.turnId}:${call.callId}:user-input:${userInputSequence}`,
          sessionId: input.sessionId,
          turnId: input.turnId,
          callId: call.callId,
          prompt,
        });
        const responsePromise = input.control.waitForUserInput(request, controller.signal);
        await emit({ type: 'user_input_requested', request });
        try {
          const response = await awaitAbortable(responsePromise);
          await emit({ type: 'user_input_received', response });
          input.control.acknowledgeUserInput(response.requestId);
          return response.text;
        } catch (error) {
          input.control.acknowledgeUserInput(request.requestId);
          throw error;
        }
      },
    });

    const closeUnfinishedTools = async (errorCode: string, message: string): Promise<void> => {
      for (const callId of state.toolOrder) {
        const tool = state.tools[callId];
        if (!tool || tool.status === 'completed') continue;
        await emit(
          {
            type: 'tool_result',
            callId,
            name: tool.name,
            ok: false,
            content: message,
            source: 'runtime',
            errorCode,
          },
          true,
        );
      }
    };

    const closeActiveIteration = async (): Promise<void> => {
      const active = state.activeIteration;
      if (active === null) return;
      await emit(
        {
          type: 'model_iteration_completed',
          iteration: active,
          stopReason: 'unknown',
        },
        true,
      );
    };

    const appendRecoveredToolResults = (): void => {
      const assistant = messages[messages.length - 1];
      if (assistant?.role !== 'assistant') return;
      const toolCalls = assistant.content.filter(
        (block): block is AgentAssistantToolCallBlock => block.type === 'tool_call',
      );
      if (toolCalls.length === 0) return;
      const results: AgentToolResultBlock[] = [];
      for (const call of toolCalls) {
        const result = state.tools[call.callId]?.result;
        if (!result) return;
        const recovered: AgentToolResultBlock = {
          callId: call.callId,
          name: call.name,
          ok: result.ok,
          content: result.content,
        };
        if (
          result.source === 'runtime' &&
          result.errorCode === AGENT_RUNTIME_UNKNOWN_TOOL_ERROR_CODE &&
          result.content === agentRuntimeUnknownToolResultContent(call.name)
        ) {
          recovered.source = 'runtime';
          recovered.errorCode = AGENT_RUNTIME_UNKNOWN_TOOL_ERROR_CODE;
        }
        results.push(recovered);
      }
      messages.push({ role: 'tool', content: results });
    };

    const finish = async (
      outcome: 'completed' | 'failed' | 'aborted' | 'budget_exceeded',
      failure?: { code?: import('./types').AgentRuntimeFailureCode; message?: string },
    ): Promise<void> => {
      if (input.control && state.status !== 'committing') {
        await emit({ type: 'commit_started', outcome }, true);
      }
      await emit(
        {
          type: 'turn_finished',
          outcome,
          ...(failure?.code ? { failureCode: failure.code } : {}),
          ...(failure?.message ? { message: failure.message } : {}),
          usage: state.usage,
          modelIterations: state.modelIterations,
          durationMs: durationMs(),
        },
        true,
      );
    };

    const planCompletedContextCheckpoint = async (
      signal: AbortSignal,
    ): Promise<NonNullable<AgentRuntimeRunResult['completedContextCheckpoint']>> => {
      if (!lastPlanningSelection) {
        throw new AgentRuntimeError(
          'INTERNAL_ERROR',
          'Resumable turn has no provider context planning state',
        );
      }
      const completedPlan = await this.contextPlanning.plan({
        purpose: 'completed_turn',
        sessionId: input.sessionId,
        turnId: input.turnId,
        iteration: lastPlanningSelection.iteration,
        driverId: this.driver.id,
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.contextMode ? { contextMode: input.contextMode } : {}),
        context,
        ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
        messages,
        executableDefinitions: definitions,
        selectedTools: lastPlanningSelection.tools,
        requestedOutputTokens: lastPlanningSelection.requestedOutputTokens,
        signal,
      });
      return deepFreeze({
        canonicalSourceRows: clonePortableData(completedPlan.canonicalSourceRows),
        providerEnvelope: clonePortableData(completedPlan.envelope),
      });
    };

    const executeOne = async (call: MutableToolCall): Promise<void> => {
      if (!call.definition || !call.validatedArguments || call.result) return;
      checkBeforeWork();
      const request = {
        sessionId: input.sessionId,
        turnId: input.turnId,
        callId: call.callId,
        idempotencyKey: `${input.sessionId}:${input.turnId}:${call.callId}`,
        name: call.name,
        arguments: call.validatedArguments,
        access: call.definition.access,
        ...(call.authorization ? { authorization: call.authorization } : {}),
        ...(call.definition.executionRevision
          ? { definitionRevision: call.definition.executionRevision }
          : {}),
        context,
        signal: controller.signal,
        control: toolControl(call),
      };
      let executionStarted = false;
      let presentation: AgentToolExecutionPresentation | undefined;
      const execute = async (): Promise<AgentToolExecutionResult> => {
        checkBeforeWork();
        await emit({
          type: 'tool_execution_started',
          callId: call.callId,
          name: call.name,
          access: call.definition?.access ?? 'write',
        });
        executionStarted = true;
        return this.tools.execute(request);
      };
      let normalized: ReturnType<typeof normalizeToolExecution>;
      try {
        let result: AgentToolExecutionResult;
        if (call.definition.access === 'write') {
          const pending = this.scheduler.runWrite(request, execute);
          try {
            result = await awaitAbortable(pending);
          } catch (error) {
            if (!executionStarted) throw error;
            // Once a write enters its mutation phase, terminal publication waits
            // for it to settle so no effect can land after `turn_finished`.
            result = await pending;
          }
        } else {
          result = await awaitAbortable(execute());
        }
        if (result.ok) presentation = result.presentation;
        normalized = normalizeToolExecution(result, call.definition.access);
      } catch (error) {
        if (controller.signal.aborted) throwIfStopped();
        if (error instanceof AgentRuntimeError) throw error;
        normalized = {
          ok: false,
          text: toErrorMessage(error),
          source: executionStarted ? 'executor' : 'runtime',
          ...(!executionStarted ? { errorCode: 'TOOL_SCHEDULER_ERROR' } : {}),
        };
      }
      if (this.encoder.encode(normalized.text).byteLength > limits.maxToolResultBytes) {
        const committedWrite = call.definition.access === 'write' && normalized.ok;
        normalized = {
          ok: committedWrite,
          text: committedWrite
            ? `Write completed, but its result exceeded ${limits.maxToolResultBytes} bytes and was omitted`
            : `Tool result exceeded ${limits.maxToolResultBytes} bytes`,
          source: 'runtime',
          errorCode: 'TOOL_RESULT_TOO_LARGE',
        };
      }
      await emit({
        type: 'tool_result',
        callId: call.callId,
        name: call.name,
        ok: normalized.ok,
        content: normalized.text,
        source: normalized.source,
        ...(normalized.errorCode ? { errorCode: normalized.errorCode } : {}),
        ...(presentation?.review ? { review: presentation.review } : {}),
      });
      call.result = {
        callId: call.callId,
        name: call.name,
        ok: normalized.ok,
        content: normalized.text,
      };
    };

    const executeReadBatch = async (calls: MutableToolCall[]): Promise<void> => {
      checkBeforeWork();
      const settled = await Promise.all(
        calls.map(async (call) => {
          if (!call.definition || !call.validatedArguments) {
            return {
              ok: false as const,
              text: 'Tool was not ready for execution',
              source: 'runtime' as const,
              errorCode: 'TOOL_NOT_READY',
            };
          }
          const request = {
            sessionId: input.sessionId,
            turnId: input.turnId,
            callId: call.callId,
            idempotencyKey: `${input.sessionId}:${input.turnId}:${call.callId}`,
            name: call.name,
            arguments: call.validatedArguments,
            access: call.definition.access,
            ...(call.authorization ? { authorization: call.authorization } : {}),
            ...(call.definition.executionRevision
              ? { definitionRevision: call.definition.executionRevision }
              : {}),
            context,
            signal: controller.signal,
            control: toolControl(call),
          };
          const execute = async (): Promise<AgentToolExecutionResult> => {
            checkBeforeWork();
            await emit({
              type: 'tool_execution_started',
              callId: call.callId,
              name: call.name,
              access: call.definition?.access ?? 'read',
            });
            return this.tools.execute(request);
          };
          try {
            const result = await awaitAbortable(this.scheduler.runRead(request, execute));
            return normalizeToolExecution(result, call.definition.access);
          } catch (error) {
            if (controller.signal.aborted) throwIfStopped();
            return {
              ok: false as const,
              text: toErrorMessage(error),
              source: 'executor' as const,
            };
          }
        }),
      );
      for (let index = 0; index < calls.length; index += 1) {
        const call = calls[index];
        let normalized = settled[index];
        if (this.encoder.encode(normalized.text).byteLength > limits.maxToolResultBytes) {
          normalized = {
            ok: false,
            text: `Tool result exceeded ${limits.maxToolResultBytes} bytes`,
            source: 'runtime',
            errorCode: 'TOOL_RESULT_TOO_LARGE',
          };
        }
        await emit({
          type: 'tool_result',
          callId: call.callId,
          name: call.name,
          ok: normalized.ok,
          content: normalized.text,
          source: normalized.source,
          ...('errorCode' in normalized && normalized.errorCode
            ? { errorCode: normalized.errorCode }
            : {}),
        });
        call.result = {
          callId: call.callId,
          name: call.name,
          ok: normalized.ok,
          content: normalized.text,
        };
      }
    };

    const executeTools = async (calls: MutableToolCall[]): Promise<void> => {
      let readBatch: MutableToolCall[] = [];
      const stopUnstarted = async (startIndex: number): Promise<boolean> => {
        if (!state.stopAfterToolRequested) return false;
        for (let index = startIndex; index < calls.length; index += 1) {
          const pending = calls[index];
          if (pending.result) continue;
          await emitRuntimeToolResult(
            pending,
            'Tool was not started because the author requested a stop after the current tool.',
            'STOP_AFTER_TOOL',
          );
        }
        return true;
      };
      const flushReads = async (): Promise<void> => {
        if (readBatch.length === 0) return;
        const batch = readBatch;
        readBatch = [];
        await executeReadBatch(batch);
      };

      for (let index = 0; index < calls.length; index += 1) {
        const call = calls[index];
        if (call.result || !call.definition || !call.validatedArguments) continue;
        if (await stopUnstarted(index)) break;
        if (!(await authorizeTool(call))) continue;
        if (await stopUnstarted(index)) break;
        if (call.definition.access === 'read') {
          readBatch.push(call);
          continue;
        }
        await flushReads();
        if (await stopUnstarted(index)) break;
        await executeOne(call);
        if (await stopUnstarted(index + 1)) break;
      }
      if (state.stopAfterToolRequested) {
        const firstBatched = readBatch.length > 0 ? calls.indexOf(readBatch[0]) : calls.length;
        readBatch = [];
        await stopUnstarted(firstBatched);
      } else {
        await flushReads();
      }
      throwIfStopped();
    };

    const runModelIteration = async (iteration: number): Promise<ModelIterationResult> => {
      checkBeforeWork();
      if (
        state.modelIterations > 0 &&
        limits.maxInputTokens !== null &&
        state.usage.inputTokens >= limits.maxInputTokens
      ) {
        budget('No input token budget remains for another model iteration');
      }
      if (
        state.modelIterations > 0 &&
        limits.maxCostUsd !== null &&
        state.usage.costUsd >= limits.maxCostUsd
      ) {
        budget('No cost budget remains for another model iteration');
      }
      const usedTotalTokens = state.usage.inputTokens + state.usage.outputTokens;
      const remainingOutputTokens =
        limits.maxOutputTokens === null
          ? Number.POSITIVE_INFINITY
          : limits.maxOutputTokens - state.usage.outputTokens;
      const remainingTotalTokens =
        limits.maxTotalTokens === null
          ? Number.POSITIVE_INFINITY
          : limits.maxTotalTokens - usedTotalTokens;
      const synthesisReserve = synthesisOutputTokenReserve(limits);
      const hasToolResultsInContext = messages[messages.length - 1]?.role === 'tool';
      const hasFutureModelIteration =
        limits.maxModelIterations === null || iteration < limits.maxModelIterations;
      const isFinalModelIteration =
        limits.maxModelIterations !== null && iteration === limits.maxModelIterations;
      // When only the protected headroom remains, synthesize now rather than
      // spending another tool round and discovering on the next iteration that
      // no answer budget remains.
      const reserveForcesSynthesis =
        hasToolResultsInContext &&
        hasFutureModelIteration &&
        synthesisReserve > 0 &&
        (remainingOutputTokens <= synthesisReserve || remainingTotalTokens <= synthesisReserve);
      const forceCompletionTool = Boolean(
        completionToolName &&
        isFinalModelIteration &&
        input.completionTool?.forceOnFinalIteration !== false,
      );
      const synthesisOnly =
        hasToolResultsInContext &&
        !forceCompletionTool &&
        (reserveForcesSynthesis || isFinalModelIteration);
      if (remainingOutputTokens <= 0 || remainingTotalTokens <= 0) {
        budget('No output token budget remains for another model iteration');
      }
      // Tool access is removed for the reserved/final round so the model must
      // turn the facts already in context into a best-effort author response.
      const shouldSearch =
        !synthesisOnly &&
        (toolSearch === 'on' ||
          (toolSearch === 'auto' && definitions.length > AGENT_RUNTIME_TOOL_SEARCH_LIMIT));
      let iterationDefinitions = synthesisOnly ? [] : definitions;
      if (shouldSearch) {
        if (!this.toolSelector) {
          throw new AgentRuntimeError(
            'INTERNAL_ERROR',
            'Tool search was requested but no selection strategy is installed',
          );
        }
        let selectionHints: AgentToolSelectionHints = {};
        if (this.tools.loadSelectionHints) {
          try {
            selectionHints = deepFreeze(
              clonePortableData(
                await awaitAbortable(
                  this.tools.loadSelectionHints({
                    sessionId: input.sessionId,
                    turnId: input.turnId,
                    context,
                    signal: controller.signal,
                  }),
                ),
              ),
            );
          } catch {
            throwIfStopped();
            throw new AgentRuntimeError(
              'INTERNAL_ERROR',
              'The installed tool runtime failed to load selection hints',
            );
          }
        }
        const repairToolNames = [...repairToolNamesForNextIteration].filter((name) =>
          availableDefinitionsByName.has(name),
        );
        let selectedNames: readonly string[];
        try {
          selectedNames = this.toolSelector.select({
            definitions,
            context,
            iteration,
            hints: selectionHints,
            query: buildAgentToolSearchQuery(input.prompt, messages),
            successfulReadNamesInPreviousBatch: [...successfulReadNamesInPreviousBatch],
            successfulReadNamesSinceLastWrite: [...successfulReadNamesSinceLastWrite],
            pendingResultPage: pendingResultRefs.size > 0,
            repairToolNames,
            limit: AGENT_RUNTIME_TOOL_SEARCH_LIMIT,
          });
        } catch {
          throw new AgentRuntimeError(
            'INTERNAL_ERROR',
            'The installed tool selection strategy failed',
          );
        }
        if (selectedNames.length > AGENT_RUNTIME_TOOL_SEARCH_LIMIT) {
          throw new AgentRuntimeError(
            'INTERNAL_ERROR',
            `Tool selection exceeded the ${AGENT_RUNTIME_TOOL_SEARCH_LIMIT}-tool limit`,
          );
        }
        const requested = new Set<string>();
        for (const name of selectedNames) {
          if (requested.has(name)) {
            throw new AgentRuntimeError(
              'INTERNAL_ERROR',
              `Tool selection returned duplicate name "${name}"`,
            );
          }
          requested.add(name);
          if (!availableDefinitionsByName.has(name)) {
            throw new AgentRuntimeError(
              'INTERNAL_ERROR',
              `Tool selection returned unavailable name "${name}"`,
            );
          }
        }
        const leasedNames = [
          ...repairToolNames,
          ...selectedNames.filter((name) => !repairToolNames.includes(name)),
        ].slice(0, AGENT_RUNTIME_TOOL_SEARCH_LIMIT);
        const selected = new Set<string>();
        iterationDefinitions = leasedNames.map((name) => {
          if (selected.has(name)) {
            throw new AgentRuntimeError(
              'INTERNAL_ERROR',
              `Tool selection returned duplicate name "${name}"`,
            );
          }
          selected.add(name);
          const definition = availableDefinitionsByName.get(name);
          if (!definition) {
            throw new AgentRuntimeError(
              'INTERNAL_ERROR',
              `Tool selection returned unavailable name "${name}"`,
            );
          }
          return definition;
        });
      }
      if (forceCompletionTool) {
        iterationDefinitions = [availableDefinitionsByName.get(completionToolName!)!];
      }
      // Protect a separate synthesis round whenever this provider request can
      // actually start more tool work. A tool-free/direct-answer request has
      // no future tool evidence to synthesize, so reserving half its output
      // budget would strand tokens if the provider stops at max_tokens.
      const protectedSynthesisTokens =
        iterationDefinitions.length > 0 && !synthesisOnly && hasFutureModelIteration
          ? synthesisReserve
          : 0;
      let requestMaxOutputTokens = Math.floor(
        Math.min(
          limits.maxOutputTokensPerIteration,
          remainingOutputTokens - protectedSynthesisTokens,
          remainingTotalTokens - protectedSynthesisTokens,
        ),
      );
      // A steered continuation with no tool results may reach the protected
      // tail after an earlier direct answer. Let it use that tail instead of
      // failing before it can respond.
      if (requestMaxOutputTokens <= 0 && !hasToolResultsInContext) {
        requestMaxOutputTokens = Math.floor(
          Math.min(limits.maxOutputTokensPerIteration, remainingOutputTokens, remainingTotalTokens),
        );
      }
      if (requestMaxOutputTokens <= 0) {
        budget('No output token budget remains for another model iteration');
      }
      const definitionsByName = groupDefinitions(iterationDefinitions);
      const providerTools = iterationDefinitions.map((definition) => ({
        name: definition.name,
        description: definition.description,
        inputSchema: clonePortableData(definition.inputSchema),
      }));
      const iterationSystemPrompt = [
        input.systemPrompt,
        synthesisOnly ? AGENT_SYNTHESIS_ONLY_SYSTEM_NOTE : undefined,
      ]
        .filter(Boolean)
        .join('\n\n');
      const plannedContext = await awaitAbortable(
        this.contextPlanning.plan({
          purpose: 'provider_call',
          sessionId: input.sessionId,
          turnId: input.turnId,
          iteration,
          driverId: this.driver.id,
          ...(input.provider ? { provider: input.provider } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.contextMode ? { contextMode: input.contextMode } : {}),
          context,
          ...(iterationSystemPrompt ? { systemPrompt: iterationSystemPrompt } : {}),
          messages,
          executableDefinitions: definitions,
          selectedTools: providerTools,
          requestedOutputTokens: requestMaxOutputTokens,
          signal: controller.signal,
        }),
      );
      lastProviderCallContextEnvelope = deepFreeze(clonePortableData(plannedContext.envelope));
      lastPlanningSelection = {
        iteration,
        requestedOutputTokens: requestMaxOutputTokens,
        tools: providerTools.map((tool) => clonePortableData(tool)),
      };
      await emit({
        type: 'model_iteration_started',
        iteration,
        driverId: this.driver.id,
      });
      await emit({
        type: 'context_planned',
        iteration,
        snapshot: plannedContext.contextUsage,
      });

      const blocks: AgentAssistantContentBlock[] = [];
      let bufferedSynthesisText = '';
      let bufferedVisibleText = '';
      let finalResponseMarkerSeen = false;
      let trimFinalResponseLeadingWhitespace = true;
      let iterationUsesTools = false;
      const calls: MutableToolCall[] = [];
      const callsById = new Map<string, MutableToolCall>();
      let finishReason: AgentModelStopReason | null = null;
      let usageSeen = false;

      const request: AgentModelRequest = {
        sessionId: input.sessionId,
        turnId: input.turnId,
        iteration,
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.reasoning ? { reasoning: input.reasoning } : {}),
        ...(forceCompletionTool && input.completionTool?.disableReasoningWhenForced !== false
          ? { executionMode: 'required_tool_non_reasoning' as const }
          : {}),
        ...(providerTools.length > 0
          ? {
              toolChoice: forceCompletionTool
                ? ({ force: completionToolName! } as const)
                : ('auto' as const),
            }
          : {}),
        context: deepFreeze(clonePortableData(plannedContext.envelope.providerContext)),
        tools: providerTools.map((tool) => clonePortableData(tool)),
        maxOutputTokens: requestMaxOutputTokens,
        signal: controller.signal,
      };

      let stream: AsyncIterable<AgentModelStreamEvent>;
      try {
        stream = this.driver.stream(request);
      } catch (error) {
        modelDriverFailure(error);
      }

      const iterator = stream[Symbol.asyncIterator]();
      let iteratorCompleted = false;
      try {
        while (true) {
          const next = await awaitAbortable(iterator.next());
          if (next.done) {
            iteratorCompleted = true;
            break;
          }
          const frame = next.value;
          checkBeforeWork();
          if (finishReason && frame.type !== 'usage') {
            protocol(`Provider emitted ${frame.type} after finish`);
          }
          switch (frame.type) {
            case 'text_delta':
              if (synthesisOnly) {
                // A tool-disabled boundary is buffered so provider-specific
                // pseudo-call markup can be discarded before it reaches the
                // canonical journal/UI. Ordinary answer iterations still stream.
                bufferedSynthesisText += frame.text;
              } else {
                appendContentDelta(blocks, 'text', frame.text);
                if (!iterationUsesTools) {
                  if (finalResponseMarkerSeen) {
                    const visible = trimFinalResponseLeadingWhitespace
                      ? frame.text.replace(/^\s+/, '')
                      : frame.text;
                    if (visible.length > 0) {
                      trimFinalResponseLeadingWhitespace = false;
                      await emit({ type: 'text_delta', iteration, text: visible });
                    }
                  } else {
                    bufferedVisibleText += frame.text;
                    const markerIndex = bufferedVisibleText.indexOf(AGENT_FINAL_RESPONSE_MARKER);
                    if (markerIndex >= 0) {
                      finalResponseMarkerSeen = true;
                      const afterMarker = bufferedVisibleText.slice(
                        markerIndex + AGENT_FINAL_RESPONSE_MARKER.length,
                      );
                      bufferedVisibleText = '';
                      const visible = afterMarker.replace(/^\s+/, '');
                      if (visible.length > 0) {
                        trimFinalResponseLeadingWhitespace = false;
                        await emit({ type: 'text_delta', iteration, text: visible });
                      }
                    }
                  }
                }
              }
              break;

            case 'thinking_delta':
              appendContentDelta(blocks, 'thinking', frame.text);
              await emit({ type: 'thinking_delta', iteration, text: frame.text });
              break;

            case 'tool_call_start': {
              iterationUsesTools = true;
              bufferedVisibleText = '';
              if (!frame.callId || !frame.name) {
                protocol('Provider emitted a tool call without callId/name');
              }
              if (seenToolCallIds.has(frame.callId)) {
                protocol(`Duplicate provider tool call id "${frame.callId}"`);
              }
              seenToolCallIds.add(frame.callId);
              totalToolCalls += 1;
              if (limits.maxToolCalls !== null && totalToolCalls > limits.maxToolCalls) {
                budget(`maxToolCalls exceeded: ${totalToolCalls} > ${limits.maxToolCalls}`);
              }
              let canonicalName = frame.name;
              try {
                canonicalName =
                  this.tools.resolveCanonicalName?.(frame.name, context) ?? frame.name;
              } catch {
                throw new AgentRuntimeError(
                  'INTERNAL_ERROR',
                  'The installed tool runtime failed to resolve a canonical tool name',
                );
              }
              if (!canonicalName.trim()) {
                throw new AgentRuntimeError(
                  'INTERNAL_ERROR',
                  'The installed tool runtime returned an empty canonical tool name',
                );
              }
              const block: AgentAssistantToolCallBlock = {
                type: 'tool_call',
                callId: frame.callId,
                name: canonicalName,
                arguments: {},
                rawArguments: '',
              };
              const call: MutableToolCall = {
                callId: frame.callId,
                name: canonicalName,
                iteration,
                rawArguments: '',
                argumentBytes: 0,
                argumentsTooLarge: false,
                repairRequested: false,
                ended: false,
                block,
              };
              calls.push(call);
              callsById.set(call.callId, call);
              blocks.push(block);
              await emit({
                type: 'tool_call_started',
                iteration,
                callId: call.callId,
                name: call.name,
              });
              break;
            }

            case 'tool_args_delta': {
              const call = callsById.get(frame.callId);
              if (!call) protocol(`Arguments for unknown tool call "${frame.callId}"`);
              if (call.ended) protocol(`Arguments after tool call "${frame.callId}" ended`);
              const deltaBytes = this.encoder.encode(frame.delta).byteLength;
              call.argumentBytes += deltaBytes;
              if (call.argumentBytes > limits.maxToolArgumentBytes) {
                call.argumentsTooLarge = true;
                break;
              }
              call.rawArguments += frame.delta;
              call.block.rawArguments = call.rawArguments;
              break;
            }

            case 'tool_call_end': {
              const call = callsById.get(frame.callId);
              if (!call) protocol(`End for unknown tool call "${frame.callId}"`);
              if (call.ended) protocol(`Duplicate end for tool call "${frame.callId}"`);
              call.ended = true;
              // Provider adapters commonly stream JSON one or two characters at
              // a time. Persisting every fragment made a normal long read turn
              // produce thousands of journal rows, even though neither recovery
              // nor the product UI needs partial JSON. Emit the exact raw payload
              // once, immediately before ready/error, so replay stays lossless
              // while the UI can wait for the real semantic action instead of
              // flashing a guessed placeholder.
              if (!call.argumentsTooLarge && call.rawArguments.length > 0) {
                await emit({
                  type: 'tool_args_delta',
                  iteration,
                  callId: call.callId,
                  delta: call.rawArguments,
                });
              }
              if (call.argumentsTooLarge) {
                // The journal above retains the provider's exact bytes. The
                // canonical model message must still contain a valid JSON
                // object pair so a rejected call cannot poison restart
                // recovery after the model repairs it on the next iteration.
                call.block.arguments = deepFreeze({});
                call.block.rawArguments = '{}';
                await emitRuntimeToolResult(
                  call,
                  `Tool arguments exceeded ${limits.maxToolArgumentBytes} bytes`,
                  'TOOL_ARGUMENTS_TOO_LARGE',
                  availableDefinitionsByName.has(call.name),
                );
                break;
              }
              let parsed: unknown;
              try {
                parsed = call.rawArguments.trim() ? JSON.parse(call.rawArguments) : {};
              } catch (error) {
                call.block.arguments = deepFreeze({});
                call.block.rawArguments = '{}';
                await emitRuntimeToolResult(
                  call,
                  `Malformed JSON arguments: ${toErrorMessage(error)}`,
                  'MALFORMED_TOOL_ARGUMENTS',
                  availableDefinitionsByName.has(call.name),
                );
                break;
              }
              if (!isRecord(parsed)) {
                call.block.arguments = deepFreeze({});
                call.block.rawArguments = '{}';
                await emitRuntimeToolResult(
                  call,
                  'Tool arguments must be a JSON object',
                  'INVALID_TOOL_ARGUMENT_SHAPE',
                  availableDefinitionsByName.has(call.name),
                );
                break;
              }
              const parsedCanonical = canonicalizeArguments(parsed);
              if (!parsedCanonical.ok) {
                call.block.arguments = deepFreeze({});
                call.block.rawArguments = '{}';
                await emitRuntimeToolResult(
                  call,
                  `Invalid normalized arguments for "${call.name}": ${parsedCanonical.error}`,
                  'INVALID_NORMALIZED_TOOL_ARGUMENTS',
                  availableDefinitionsByName.has(call.name),
                );
                break;
              }
              // Preserve a canonical representation even when the tool name
              // is unknown or schema validation rejects the call. The
              // following tool_result is the model-visible rejection; keeping
              // arguments internally consistent makes the completed turn
              // durably recoverable.
              call.block.arguments = deepFreeze(parsedCanonical.value);
              call.block.rawArguments = call.rawArguments;
              const definition = definitionsByName.get(call.name);
              if (!definition) {
                await emitRuntimeToolResult(
                  call,
                  agentRuntimeUnknownToolResultContent(call.name),
                  AGENT_RUNTIME_UNKNOWN_TOOL_ERROR_CODE,
                  availableDefinitionsByName.has(call.name),
                );
                break;
              }
              call.definition = definition;
              let validated: AgentToolValidationResult;
              try {
                validated = definition.validateInput(parsed);
              } catch (error) {
                await emitRuntimeToolResult(
                  call,
                  `Tool input validator failed: ${toErrorMessage(error)}`,
                  'TOOL_VALIDATOR_ERROR',
                );
                break;
              }
              if (!validated.ok) {
                await emitRuntimeToolResult(
                  call,
                  `Invalid arguments for "${call.name}": ${validated.error}`,
                  'INVALID_TOOL_ARGUMENTS',
                  true,
                );
                break;
              }
              const canonical = canonicalizeArguments(validated.value);
              if (!canonical.ok) {
                await emitRuntimeToolResult(
                  call,
                  `Invalid normalized arguments for "${call.name}": ${canonical.error}`,
                  'INVALID_NORMALIZED_TOOL_ARGUMENTS',
                  true,
                );
                break;
              }
              if (this.encoder.encode(canonical.text).byteLength > limits.maxToolArgumentBytes) {
                await emitRuntimeToolResult(
                  call,
                  `Normalized tool arguments exceeded ${limits.maxToolArgumentBytes} bytes`,
                  'TOOL_ARGUMENTS_TOO_LARGE',
                  true,
                );
                break;
              }
              const argumentsValue = deepFreeze(canonical.value);
              call.validatedArguments = argumentsValue;
              call.block.arguments = argumentsValue;
              call.block.rawArguments = call.rawArguments;
              await emit({
                type: 'tool_call_ready',
                iteration,
                callId: call.callId,
                name: call.name,
                arguments: argumentsValue,
                rawArguments: call.rawArguments,
              });
              break;
            }

            case 'usage':
              if (usageSeen) protocol(`Duplicate usage for model iteration ${iteration}`);
              validateUsage(frame.usage);
              usageSeen = true;
              await emit({ type: 'model_usage', iteration, usage: frame.usage });
              checkUsageBudget();
              break;

            case 'finish':
              if (finishReason) protocol(`Duplicate finish for model iteration ${iteration}`);
              finishReason = frame.reason;
              break;
          }
        }
      } catch (error) {
        if (controller.signal.aborted) throwIfStopped();
        if (error instanceof AgentRuntimeError) throw error;
        modelDriverFailure(error);
      } finally {
        if (!iteratorCompleted) {
          // A provider may ignore AbortSignal and also never settle `return()`.
          // Terminal publication must not wait for that non-cooperative cleanup:
          // the runtime signal is authoritative and iterator cleanup is strictly
          // best-effort once the consumer has stopped reading the stream.
          void Promise.resolve(iterator.return?.()).catch(() => undefined);
        }
      }

      if (!finishReason) protocol(`Model iteration ${iteration} ended without finish`);
      if (!usageSeen) protocol(`Model iteration ${iteration} ended without usage`);
      if (calls.some((call) => !call.ended)) {
        protocol(`Model iteration ${iteration} ended with partial tool arguments`);
      }
      if (calls.length > 0 && finishReason !== 'tool_use') {
        protocol(`Model returned tool calls with stop reason "${finishReason}"`);
      }
      if (calls.length === 0 && finishReason === 'tool_use') {
        protocol('Model stopped for tool use without any tool calls');
      }

      if (synthesisOnly && bufferedSynthesisText) {
        const synthesisText = sanitizeAgentSynthesisText(
          stripAgentFinalResponseMarker(bufferedSynthesisText),
        );
        appendContentDelta(blocks, 'text', synthesisText);
        await emit({ type: 'text_delta', iteration, text: synthesisText });
      } else if (calls.length === 0 && !finalResponseMarkerSeen && bufferedVisibleText) {
        // Compatibility fallback for providers or older recovered prompts that
        // do not implement the presentation marker yet. It remains hidden
        // until the provider proves this is a tool-free final response.
        await emit({ type: 'text_delta', iteration, text: bufferedVisibleText });
      }

      await emit({
        type: 'model_iteration_completed',
        iteration,
        stopReason: finishReason,
      });
      if (blocks.length === 0 && finishReason === 'end_turn') {
        // Keep a provider's valid empty completion explicit so the canonical
        // message bridge can preserve the completed assistant turn.
        blocks.push({ type: 'text', text: '' });
      }
      const assistant: AgentModelMessage = {
        role: 'assistant',
        // Tool-round narration is neither useful UI nor useful future context.
        // Keep the provider's tool calls and thinking, but hide "let me read…"
        // preambles so the workspace feels like direct action rather than a
        // conversation about operating tools.
        content:
          calls.length > 0
            ? blocks.filter((block) => block.type !== 'text')
            : normalizedFinalResponseBlocks(blocks),
      };
      messages.push(assistant);

      if (finishReason === 'max_tokens') {
        throw new AgentRuntimeError('MODEL_MAX_TOKENS', 'Model reached its output token limit');
      }
      if (finishReason === 'content_filter') {
        modelFailure('Model response was blocked by a content filter');
      }
      if (finishReason === 'unknown') {
        modelFailure('Model returned an unknown stop reason');
      }

      if (calls.length > 0) await executeTools(calls);
      const toolResults = calls.map((call) => {
        if (!call.result) {
          throw new AgentRuntimeError(
            'INTERNAL_ERROR',
            `Tool call "${call.callId}" has no terminal result`,
          );
        }
        return call.result;
      });
      if (toolResults.length > 0) {
        messages.push({ role: 'tool', content: toolResults });
      }
      const successfulCompletionCalls = completionToolName
        ? calls.filter((call) => call.name === completionToolName && call.result?.ok === true)
        : [];
      if (successfulCompletionCalls.length > 1) {
        protocol(`Model called completion tool "${completionToolName}" more than once`);
      }
      const completionCall = successfulCompletionCalls[0];
      return {
        assistant,
        toolResults,
        repairToolNames: [
          ...new Set(calls.filter((call) => call.repairRequested).map((call) => call.name)),
        ],
        stopReason: finishReason,
        ...(completionCall?.validatedArguments && completionCall.result
          ? {
              completionTool: {
                callId: completionCall.callId,
                name: completionCall.name,
                arguments: clonePortableData(completionCall.validatedArguments),
                result: clonePortableData(completionCall.result),
              },
            }
          : {}),
      };
    };

    try {
      await emit({
        type: 'turn_started',
        prompt: input.prompt,
        ...(input.promptSource ? { promptSource: input.promptSource } : {}),
        ...(completionToolName ? { completionTool: completionToolName } : {}),
      });
      while (true) {
        checkBeforeWork();
        if (
          limits.maxModelIterations !== null &&
          state.modelIterations >= limits.maxModelIterations
        ) {
          throw new AgentRuntimeError(
            'MAX_MODEL_ITERATIONS',
            `maxModelIterations reached: ${limits.maxModelIterations}`,
          );
        }
        const iteration = state.modelIterations + 1;
        const result = await runModelIteration(iteration);
        await emitTail;
        repairToolNamesForNextIteration = new Set(result.repairToolNames);
        const successfulReadsInThisBatch = new Set<string>();
        const openedResultRefs = new Set<string>();
        const completedResultRefs = new Set<string>();
        for (const toolResult of result.toolResults) {
          const pageUpdate = pendingResultPageUpdateFromToolResult(toolResult);
          if (pageUpdate?.pending) {
            openedResultRefs.add(pageUpdate.resultRef);
          } else if (pageUpdate) {
            completedResultRefs.add(pageUpdate.resultRef);
          }
          const definition = availableDefinitionsByName.get(toolResult.name);
          if (!toolResult.ok) continue;
          if (definition?.access === 'write') {
            successfulReadsInThisBatch.clear();
            successfulReadNamesSinceLastWrite.clear();
          } else if (definition?.access === 'read') {
            successfulReadsInThisBatch.add(toolResult.name);
            successfulReadNamesSinceLastWrite.add(toolResult.name);
          }
        }
        for (const resultRef of openedResultRefs) {
          if (!completedResultRefs.has(resultRef)) {
            pendingResultRefs.add(resultRef);
          }
        }
        for (const resultRef of completedResultRefs) {
          pendingResultRefs.delete(resultRef);
        }
        successfulReadNamesInPreviousBatch = successfulReadsInThisBatch;
        if (result.toolResults.length > 0 && state.stopAfterToolRequested) {
          const reason = 'Agent stopped after the current tool completed.';
          await emit({ type: 'cancellation_requested', reason }, true);
          throw new AgentRuntimeAbortError(reason);
        }
        if (result.completionTool) {
          completedTool = result.completionTool;
          await emit({
            type: 'completion_tool_accepted',
            callId: result.completionTool.callId,
            name: result.completionTool.name,
          });
          acceptingControl = false;
          await emitTail;
          checkBeforeWork();
          completedContextCheckpoint = await awaitAbortable(
            planCompletedContextCheckpoint(controller.signal),
          );
          await finish('completed');
          break;
        }
        if (result.toolResults.length > 0) {
          await applyPendingSteering();
          continue;
        }
        if (result.toolResults.length === 0) {
          if (completionToolName) {
            messages.push({
              role: 'user',
              content:
                input.completionTool?.reminder?.trim() ||
                `This turn is not complete. Call "${completionToolName}" to submit the structured result.`,
            });
            continue;
          }
          acceptingControl = false;
          await emitTail;
          const appliedSteering = await applyPendingSteering();
          if (appliedSteering > 0) {
            acceptingControl = true;
            continue;
          }
          checkBeforeWork();
          completedContextCheckpoint = await awaitAbortable(
            planCompletedContextCheckpoint(controller.signal),
          );
          await finish('completed');
          break;
        }
      }
    } catch (error) {
      if (state.status === 'idle') {
        if (!controller.signal.aborted) controller.abort(error);
        throw error;
      }
      acceptingControl = false;
      const aborted =
        !deadlineTriggered &&
        (controller.signal.aborted || error instanceof AgentRuntimeAbortError);
      if (
        (aborted || state.status === 'waiting_permission' || state.status === 'waiting_user') &&
        state.status !== 'cancelling' &&
        state.status !== 'committing'
      ) {
        const reason =
          error instanceof AgentRuntimeAbortError ? error.message : abortReason(controller.signal);
        await emit({ type: 'cancellation_requested', reason }, true);
      }
      if (!controller.signal.aborted) controller.abort(error);
      const runtimeError =
        deadlineTriggered && deadlineError
          ? deadlineError
          : error instanceof AgentRuntimeError
            ? error
            : null;
      const code = runtimeError?.code ?? ('INTERNAL_ERROR' as const);
      const message = aborted
        ? abortReason(controller.signal)
        : (runtimeError?.message ?? toErrorMessage(error));
      await closeUnfinishedTools(aborted ? 'ABORTED' : code, message);
      await closeActiveIteration();
      appendRecoveredToolResults();
      if (
        !aborted &&
        (code === 'BUDGET_EXCEEDED' || code === 'MAX_MODEL_ITERATIONS') &&
        lastPlanningSelection
      ) {
        try {
          // An explicit execution boundary was reached, but checkpoint planning is a bounded
          // local durability step. It must see recovered tool results and must
          // not inherit the already-aborted provider signal.
          completedContextCheckpoint = await planCompletedContextCheckpoint(
            new AbortController().signal,
          );
        } catch {
          // Some boundaries (for example, a single protected assistant payload
          // larger than the provider window) cannot form a valid V2 projection.
          // Persistence retains its existing fail-safe V1 fallback.
          completedContextCheckpoint = undefined;
        }
      }
      if (aborted) {
        await finish('aborted', { message });
      } else if (code === 'BUDGET_EXCEEDED' || code === 'MAX_MODEL_ITERATIONS') {
        await finish('budget_exceeded', { code, message });
      } else {
        await finish('failed', { code, message });
      }
    } finally {
      acceptingControl = false;
      detachControl();
      input.control?.close(controller.signal.reason ?? new Error('Agent turn finished.'));
      deadlineController.abort('Agent turn finished');
      journalController.abort('Agent turn finished');
      detachParentAbort();
      detachParentJournalAbort();
    }

    return {
      state,
      entries,
      messages,
      ...(completedTool ? { completionTool: completedTool } : {}),
      ...(lastProviderCallContextEnvelope ? { lastProviderCallContextEnvelope } : {}),
      ...((state.status === 'completed' || state.status === 'budget_exceeded') &&
      completedContextCheckpoint
        ? { completedContextCheckpoint }
        : {}),
    };
  }

  private linkAbort(parent: AbortSignal | undefined, child: AbortController): () => void {
    if (!parent) return () => undefined;
    const abort = () => child.abort(parent.reason);
    if (parent.aborted) {
      abort();
      return () => undefined;
    }
    parent.addEventListener('abort', abort, { once: true });
    return () => parent.removeEventListener('abort', abort);
  }
}
