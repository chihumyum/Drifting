import { systemAgentClock } from './clock';
import {
  abortReason,
  AgentRuntimeAbortError,
  AgentRuntimeError,
  publicModelDriverErrorMessage,
} from './errors';
import {
  agentRuntimeEventId,
  createAgentRuntimeState,
  reduceAgentRuntimeJournal,
} from './reducer';
import { clonePortableData } from './portable-data';
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
  type AgentToolExecutionResult,
  type AgentToolResultBlock,
  type AgentToolRuntime,
  type AgentToolSelectionStrategy,
  type AgentToolValidationResult,
} from './types';

export const DEFAULT_AGENT_RUNTIME_LIMITS: AgentRuntimeLimits = {
  maxModelIterations: 8,
  maxToolCalls: 32,
  maxInputTokens: 200_000,
  maxOutputTokens: 32_000,
  maxTotalTokens: 232_000,
  maxCostUsd: 1,
  maxDurationMs: 5 * 60_000,
  maxOutputTokensPerIteration: 8_192,
  maxToolArgumentBytes: 64 * 1024,
  maxToolResultBytes: 128 * 1024,
};

const emptyToolRuntime: AgentToolRuntime = {
  listDefinitions: () => [],
  execute: async () => ({ ok: false, error: 'No tool runtime is installed' }),
};

export interface AgentRuntimeDependencies {
  driver: import('./types').AgentModelDriver;
  tools?: AgentToolRuntime;
  toolSelector?: AgentToolSelectionStrategy;
  contextPlanning?: AgentRuntimeContextPlanningOptions;
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
  ended: boolean;
  block: AgentAssistantToolCallBlock;
  definition?: AgentToolDefinition;
  validatedArguments?: Record<string, unknown>;
  result?: AgentToolResultBlock;
}

interface ModelIterationResult {
  assistant: AgentModelMessage;
  toolResults: AgentToolResultBlock[];
  stopReason: AgentModelStopReason;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function mergeLimits(overrides?: Partial<AgentRuntimeLimits>): AgentRuntimeLimits {
  const limits = { ...DEFAULT_AGENT_RUNTIME_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new AgentRuntimeError('INTERNAL_ERROR', `Invalid runtime limit ${name}=${value}`);
    }
  }
  return limits;
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

function stringifyToolData(data: unknown): { ok: true; text: string } | { ok: false; error: string } {
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

function protocol(message: string): never {
  throw new AgentRuntimeError('PROTOCOL_VIOLATION', message);
}

function modelFailure(message: string): never {
  throw new AgentRuntimeError('MODEL_ERROR', message);
}

function modelDriverFailure(error: unknown): never {
  throw new AgentRuntimeError(
    'MODEL_ERROR',
    publicModelDriverErrorMessage(error),
  );
}

function budget(message: string): never {
  throw new AgentRuntimeError('BUDGET_EXCEEDED', message);
}

function normalizeToolExecution(
  result: AgentToolExecutionResult,
  access: AgentToolDefinition['access'],
): { ok: boolean; text: string; source: 'executor' | 'runtime'; errorCode?: string } {
  if (!result.ok) return { ok: false, text: result.error, source: 'executor' };
  const serialized = stringifyToolData(result.data);
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
      .map((result) => `${result.name}: ${result.content}`)
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
  private readonly clock: AgentClock;
  private readonly journal?: AgentJournalSink;
  private readonly scheduler: AgentRuntimeScheduler;
  private readonly encoder = new TextEncoder();

  constructor(dependencies: AgentRuntimeDependencies) {
    this.driver = dependencies.driver;
    this.tools = dependencies.tools ?? emptyToolRuntime;
    this.toolSelector = dependencies.toolSelector;
    this.contextPlanning = new AgentRuntimeContextPlanningCoordinator(
      dependencies.contextPlanning,
    );
    this.clock = dependencies.clock ?? systemAgentClock;
    this.journal = dependencies.journal;
    this.scheduler = dependencies.scheduler ?? sharedAgentRuntimeScheduler;
  }

  async runTurn(input: AgentRuntimeRunInput): Promise<AgentRuntimeRunResult> {
    const limits = mergeLimits(input.limits);
    const route = deepFreeze(clonePortableData(input.route));
    const context: AgentRuntimeContext = { route };
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
    const toolSearch = input.toolSearch ?? 'off';
    if (
      toolSearch !== 'off' &&
      toolSearch !== 'auto' &&
      toolSearch !== 'on'
    ) {
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
    const deadlineError = new AgentRuntimeError(
      'BUDGET_EXCEEDED',
      `maxDurationMs reached: ${limits.maxDurationMs}`,
    );
    void this.clock
      .sleep(limits.maxDurationMs, deadlineController.signal)
      .then(() => {
        if (!controller.signal.aborted) {
          deadlineTriggered = true;
          controller.abort(deadlineError);
        }
        if (!journalController.signal.aborted) {
          journalController.abort(deadlineError);
        }
      })
      .catch(() => undefined);
    const entries: AgentRuntimeJournalEntry[] = [];
    let seq = 0;
    let totalToolCalls = 0;
    let journalDisabled = false;
    let lastProviderCallContextEnvelope:
      | import('./context-message-adapter').AgentContextProviderEnvelopeV2
      | undefined;
    let completedContextCheckpoint:
      | NonNullable<AgentRuntimeRunResult['completedContextCheckpoint']>
      | undefined;
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
    const awaitWithSignal = async <T>(
      work: PromiseLike<T>,
      signal: AbortSignal,
    ): Promise<T> => {
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
    const appendEvent = async (
      event: AgentRuntimeEvent,
      cleanup = false,
    ): Promise<void> => {
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
            Promise.resolve(
              this.journal.append(entry, journalController.signal),
            ),
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
        throw new AgentRuntimeError(
          'JOURNAL_ERROR',
          'Agent journal persistence failed',
        );
      }
    };
    let emitTail: Promise<void> = Promise.resolve();
    const emit = (
      event: AgentRuntimeEvent,
      cleanup = false,
    ): Promise<void> => {
      const operation = emitTail.then(() => appendEvent(event, cleanup));
      emitTail = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    };

    const checkDurationBudget = (): void => {
      if (durationMs() > limits.maxDurationMs) {
        budget(`maxDurationMs exceeded: ${durationMs()} > ${limits.maxDurationMs}`);
      }
    };
    const checkUsageBudget = (): void => {
      const usage = state.usage;
      if (usage.inputTokens > limits.maxInputTokens) {
        budget(`maxInputTokens exceeded: ${usage.inputTokens} > ${limits.maxInputTokens}`);
      }
      if (usage.outputTokens > limits.maxOutputTokens) {
        budget(`maxOutputTokens exceeded: ${usage.outputTokens} > ${limits.maxOutputTokens}`);
      }
      const totalTokens = usage.inputTokens + usage.outputTokens;
      if (totalTokens > limits.maxTotalTokens) {
        budget(`maxTotalTokens exceeded: ${totalTokens} > ${limits.maxTotalTokens}`);
      }
      if (usage.costUsd > limits.maxCostUsd) {
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
    ): Promise<void> => {
      if (call.result) return;
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

    const closeUnfinishedTools = async (errorCode: string, message: string): Promise<void> => {
      for (const callId of state.toolOrder) {
        const tool = state.tools[callId];
        if (!tool || tool.status === 'completed') continue;
        await emit({
          type: 'tool_result',
          callId,
          name: tool.name,
          ok: false,
          content: message,
          source: 'runtime',
          errorCode,
        }, true);
      }
    };

    const closeActiveIteration = async (): Promise<void> => {
      const active = state.activeIteration;
      if (active === null) return;
      await emit({
        type: 'model_iteration_completed',
        iteration: active,
        stopReason: 'unknown',
      }, true);
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
      await emit({
        type: 'turn_finished',
        outcome,
        ...(failure?.code ? { failureCode: failure.code } : {}),
        ...(failure?.message ? { message: failure.message } : {}),
        usage: state.usage,
        modelIterations: state.modelIterations,
        durationMs: durationMs(),
      }, true);
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
        context,
        signal: controller.signal,
      };
      let executionStarted = false;
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
            context,
            signal: controller.signal,
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
            const result = await awaitAbortable(
              this.scheduler.runRead(request, execute),
            );
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
      const flushReads = async (): Promise<void> => {
        if (readBatch.length === 0) return;
        const batch = readBatch;
        readBatch = [];
        await executeReadBatch(batch);
      };

      for (const call of calls) {
        if (call.result || !call.definition || !call.validatedArguments) continue;
        if (call.definition.access === 'read') {
          readBatch.push(call);
          continue;
        }
        await flushReads();
        await executeOne(call);
      }
      await flushReads();
      throwIfStopped();
    };

    const runModelIteration = async (iteration: number): Promise<ModelIterationResult> => {
      checkBeforeWork();
      if (state.modelIterations > 0 && state.usage.inputTokens >= limits.maxInputTokens) {
        budget('No input token budget remains for another model iteration');
      }
      if (state.modelIterations > 0 && state.usage.costUsd >= limits.maxCostUsd) {
        budget('No cost budget remains for another model iteration');
      }
      const usedTotalTokens = state.usage.inputTokens + state.usage.outputTokens;
      const remainingOutputTokens = limits.maxOutputTokens - state.usage.outputTokens;
      const remainingTotalTokens = limits.maxTotalTokens - usedTotalTokens;
      const requestMaxOutputTokens = Math.floor(
        Math.min(
          limits.maxOutputTokensPerIteration,
          remainingOutputTokens,
          remainingTotalTokens,
        ),
      );
      if (requestMaxOutputTokens <= 0) {
        budget('No output token budget remains for another model iteration');
      }
      const shouldSearch =
        toolSearch === 'on' ||
        (toolSearch === 'auto' &&
          definitions.length > AGENT_RUNTIME_TOOL_SEARCH_LIMIT);
      let iterationDefinitions = definitions;
      if (shouldSearch) {
        if (!this.toolSelector) {
          throw new AgentRuntimeError(
            'INTERNAL_ERROR',
            'Tool search was requested but no selection strategy is installed',
          );
        }
        let selectedNames: readonly string[];
        try {
          selectedNames = this.toolSelector.select({
            definitions,
            context,
            iteration,
            query: buildAgentToolSearchQuery(input.prompt, messages),
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
        const selected = new Set<string>();
        iterationDefinitions = selectedNames.map((name) => {
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
      const definitionsByName = groupDefinitions(iterationDefinitions);
      const providerTools = iterationDefinitions.map(
        ({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema: clonePortableData(inputSchema),
        }),
      );
      const plannedContext = await awaitAbortable(
        this.contextPlanning.plan({
          purpose: 'provider_call',
          sessionId: input.sessionId,
          turnId: input.turnId,
          iteration,
          driverId: this.driver.id,
          ...(input.model ? { model: input.model } : {}),
          context,
          ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
          messages,
          executableDefinitions: definitions,
          selectedTools: providerTools,
          requestedOutputTokens: requestMaxOutputTokens,
          signal: controller.signal,
        }),
      );
      lastProviderCallContextEnvelope = deepFreeze(
        clonePortableData(plannedContext.envelope),
      );
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

      const blocks: AgentAssistantContentBlock[] = [];
      const calls: MutableToolCall[] = [];
      const callsById = new Map<string, MutableToolCall>();
      let finishReason: AgentModelStopReason | null = null;
      let usageSeen = false;

      const request: AgentModelRequest = {
        sessionId: input.sessionId,
        turnId: input.turnId,
        iteration,
        ...(input.model ? { model: input.model } : {}),
        ...(input.reasoning ? { reasoning: input.reasoning } : {}),
        context: deepFreeze(
          clonePortableData(plannedContext.envelope.providerContext),
        ),
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
              appendContentDelta(blocks, 'text', frame.text);
              await emit({ type: 'text_delta', iteration, text: frame.text });
              break;

            case 'thinking_delta':
              appendContentDelta(blocks, 'thinking', frame.text);
              await emit({ type: 'thinking_delta', iteration, text: frame.text });
              break;

            case 'tool_call_start': {
              if (!frame.callId || !frame.name) {
                protocol('Provider emitted a tool call without callId/name');
              }
              if (seenToolCallIds.has(frame.callId)) {
                protocol(`Duplicate provider tool call id "${frame.callId}"`);
              }
              seenToolCallIds.add(frame.callId);
              totalToolCalls += 1;
              if (totalToolCalls > limits.maxToolCalls) {
                budget(`maxToolCalls exceeded: ${totalToolCalls} > ${limits.maxToolCalls}`);
              }
              const block: AgentAssistantToolCallBlock = {
                type: 'tool_call',
                callId: frame.callId,
                name: frame.name,
                arguments: {},
                rawArguments: '',
              };
              const call: MutableToolCall = {
                callId: frame.callId,
                name: frame.name,
                iteration,
                rawArguments: '',
                argumentBytes: 0,
                argumentsTooLarge: false,
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
              await emit({
                type: 'tool_args_delta',
                iteration,
                callId: call.callId,
                delta: frame.delta,
              });
              break;
            }

            case 'tool_call_end': {
              const call = callsById.get(frame.callId);
              if (!call) protocol(`End for unknown tool call "${frame.callId}"`);
              if (call.ended) protocol(`Duplicate end for tool call "${frame.callId}"`);
              call.ended = true;
              if (call.argumentsTooLarge) {
                await emitRuntimeToolResult(
                  call,
                  `Tool arguments exceeded ${limits.maxToolArgumentBytes} bytes`,
                  'TOOL_ARGUMENTS_TOO_LARGE',
                );
                break;
              }
              let parsed: unknown;
              try {
                parsed = call.rawArguments.trim() ? JSON.parse(call.rawArguments) : {};
              } catch (error) {
                await emitRuntimeToolResult(
                  call,
                  `Malformed JSON arguments: ${toErrorMessage(error)}`,
                  'MALFORMED_TOOL_ARGUMENTS',
                );
                break;
              }
              if (!isRecord(parsed)) {
                await emitRuntimeToolResult(
                  call,
                  'Tool arguments must be a JSON object',
                  'INVALID_TOOL_ARGUMENT_SHAPE',
                );
                break;
              }
              const definition = definitionsByName.get(call.name);
              if (!definition) {
                await emitRuntimeToolResult(
                  call,
                  agentRuntimeUnknownToolResultContent(call.name),
                  AGENT_RUNTIME_UNKNOWN_TOOL_ERROR_CODE,
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
                );
                break;
              }
              const canonical = canonicalizeArguments(validated.value);
              if (!canonical.ok) {
                await emitRuntimeToolResult(
                  call,
                  `Invalid normalized arguments for "${call.name}": ${canonical.error}`,
                  'INVALID_NORMALIZED_TOOL_ARGUMENTS',
                );
                break;
              }
              if (this.encoder.encode(canonical.text).byteLength > limits.maxToolArgumentBytes) {
                await emitRuntimeToolResult(
                  call,
                  `Normalized tool arguments exceeded ${limits.maxToolArgumentBytes} bytes`,
                  'TOOL_ARGUMENTS_TOO_LARGE',
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
          try {
            void iterator.return?.();
          } catch {
            // The runtime signal is authoritative; late provider cleanup is best-effort.
          }
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
        content: blocks,
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
      return {
        assistant,
        toolResults,
        stopReason: finishReason,
      };
    };

    try {
      await emit({ type: 'turn_started', prompt: input.prompt });
      while (true) {
        checkBeforeWork();
        if (state.modelIterations >= limits.maxModelIterations) {
          throw new AgentRuntimeError(
            'MAX_MODEL_ITERATIONS',
            `maxModelIterations reached: ${limits.maxModelIterations}`,
          );
        }
        const iteration = state.modelIterations + 1;
        const result = await runModelIteration(iteration);
        if (result.toolResults.length === 0) {
          checkBeforeWork();
          if (!lastPlanningSelection) {
            throw new AgentRuntimeError(
              'INTERNAL_ERROR',
              'Completed turn has no provider context planning state',
            );
          }
          const completedPlan = await awaitAbortable(
            this.contextPlanning.plan({
              purpose: 'completed_turn',
              sessionId: input.sessionId,
              turnId: input.turnId,
              iteration: lastPlanningSelection.iteration,
              driverId: this.driver.id,
              ...(input.model ? { model: input.model } : {}),
              context,
              ...(input.systemPrompt
                ? { systemPrompt: input.systemPrompt }
                : {}),
              messages,
              executableDefinitions: definitions,
              selectedTools: lastPlanningSelection.tools,
              requestedOutputTokens:
                lastPlanningSelection.requestedOutputTokens,
              signal: controller.signal,
            }),
          );
          completedContextCheckpoint = deepFreeze({
            canonicalSourceRows: clonePortableData(
              completedPlan.canonicalSourceRows,
            ),
            providerEnvelope: clonePortableData(completedPlan.envelope),
          });
          await finish('completed');
          break;
        }
      }
    } catch (error) {
      if (state.status === 'idle') {
        if (!controller.signal.aborted) controller.abort(error);
        throw error;
      }
      const aborted = controller.signal.aborted && !deadlineTriggered;
      if (!controller.signal.aborted) controller.abort(error);
      const runtimeError =
        deadlineTriggered
          ? deadlineError
          : error instanceof AgentRuntimeError
            ? error
            : null;
      const code = runtimeError?.code ?? ('INTERNAL_ERROR' as const);
      const message = aborted
        ? abortReason(controller.signal)
        : runtimeError?.message ?? toErrorMessage(error);
      await closeUnfinishedTools(aborted ? 'ABORTED' : code, message);
      await closeActiveIteration();
      appendRecoveredToolResults();
      if (aborted) {
        await finish('aborted', { message });
      } else if (code === 'BUDGET_EXCEEDED' || code === 'MAX_MODEL_ITERATIONS') {
        await finish('budget_exceeded', { code, message });
      } else {
        await finish('failed', { code, message });
      }
    } finally {
      deadlineController.abort('Agent turn finished');
      journalController.abort('Agent turn finished');
      detachParentAbort();
      detachParentJournalAbort();
    }

    return {
      state,
      entries,
      messages,
      ...(lastProviderCallContextEnvelope
        ? { lastProviderCallContextEnvelope }
        : {}),
      ...(state.status === 'completed' && completedContextCheckpoint
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
