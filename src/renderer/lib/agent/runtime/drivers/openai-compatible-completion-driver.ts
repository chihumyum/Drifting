/**
 * Adapter from Drifting's provider-neutral LLMClient contract to the canonical
 * AgentModelDriver stream.
 *
 * The existing OpenAI-compatible providers already own credentials, retries,
 * wire translation, and function calls. This adapter deliberately does
 * not inspect provider errors or expose their messages. It only:
 *   - projects canonical AgentModelMessage blocks into AIMessage,
 *   - forces thinking off until reasoning-state replay is installed,
 *   - forwards true text/tool deltas when the provider supports them,
 *   - retains a completion-to-stream compatibility path for older providers.
 */
import type { LLMClient } from '../../../ai/client/llm-client';
import {
  AIError,
  type AICompletionChunk,
  type AICompletionRequest,
  type AICompletionResponse,
  type AIMessage,
  type AIToolCall,
  type AIUsage,
} from '../../../ai/types';
import { AgentModelDriverError } from '../errors';
import type {
  AgentModelDriver,
  AgentModelMessage,
  AgentModelRequest,
  AgentModelStopReason,
  AgentModelStreamEvent,
  AgentRuntimeUsage,
  AgentToolResultBlock,
} from '../types';

export interface AgentCompletionClient {
  readonly supportsTools: boolean;
  readonly supportsToolStreaming?: boolean;
  complete(request: AICompletionRequest): Promise<AICompletionResponse>;
  stream?(
    request: AICompletionRequest,
  ): AsyncIterable<AICompletionChunk>;
}

export interface OpenAICompatibleCompletionDriverOptions {
  client: AgentCompletionClient | LLMClient;
  /** Used when the runtime did not pin a model for this turn. */
  defaultModel: string;
  /** Stable runtime/journal id, not a provider display name. */
  id?: string;
  /** Existing AI interceptor attribution key. */
  feature?: string;
}

const DEFAULT_DRIVER_ID = 'openai-compatible-completion';
const DEFAULT_FEATURE = 'general-agent';

export class OpenAICompatibleCompletionDriver implements AgentModelDriver {
  readonly id: string;
  readonly capabilities = { reasoning: false } as const;

  private readonly client: AgentCompletionClient;
  private readonly defaultModel: string;
  private readonly feature: string;

  constructor(options: OpenAICompatibleCompletionDriverOptions) {
    this.client = options.client;
    this.defaultModel = requireNonEmpty(options.defaultModel, 'defaultModel');
    this.id = requireNonEmpty(options.id ?? DEFAULT_DRIVER_ID, 'id');
    this.feature = requireNonEmpty(options.feature ?? DEFAULT_FEATURE, 'feature');
  }

  async *stream(request: AgentModelRequest): AsyncIterable<AgentModelStreamEvent> {
    if (request.reasoning?.enabled) {
      throw new AgentModelDriverError(
        'Reasoning is not supported by the General Agent driver.',
      );
    }
    if (request.tools.length > 0 && !this.client.supportsTools) {
      throw new AgentModelDriverError(
        'The configured model provider does not support agent tools.',
      );
    }

    const completionRequest: AICompletionRequest = {
      model: request.model ?? this.defaultModel,
      system: requirePlannedSystem(request.context.systemPrompt),
      messages: projectPlannedMessages(request.context),
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parametersSchema: tool.inputSchema,
      })),
      maxOutputTokens: request.maxOutputTokens,
      // The General Agent does not round-trip provider reasoning state.
      thinking: false,
      terminalRequirements: {
        finishReason: true,
        usage: true,
      },
      ...(request.tools.length > 0
        ? { toolChoice: 'auto' as const }
        : {}),
      signal: request.signal,
      metadata: {
        feature: this.feature,
        agentSessionId: request.sessionId,
        agentTurnId: request.turnId,
        agentIteration: request.iteration,
      },
    };

    if (
      this.client.stream &&
      (request.tools.length === 0 ||
        this.client.supportsToolStreaming === true)
    ) {
      try {
        yield* streamCompletion(this.client, completionRequest);
      } catch (error) {
        throw safeCompletionError(error);
      }
      return;
    }

    let response: AICompletionResponse;
    try {
      response = await this.client.complete(completionRequest);
    } catch (error) {
      throw safeCompletionError(error);
    }

    const toolCalls = responseToolCalls(response);
    const projectedToolCalls = toolCalls.map((call) => ({
      callId: requireProviderField(call.id, 'tool call id'),
      name: requireProviderField(call.name, 'tool name'),
      rawArguments: serializeToolArguments(call.arguments),
    }));
    const stopReason = inferStopReason(response, toolCalls.length > 0);
    const normalizedUsage = normalizeUsage(response);
    if (response.text) {
      yield { type: 'text_delta', text: response.text };
    }

    for (const { callId, name, rawArguments } of projectedToolCalls) {
      yield { type: 'tool_call_start', callId, name };
      if (rawArguments) {
        yield { type: 'tool_args_delta', callId, delta: rawArguments };
      }
      yield { type: 'tool_call_end', callId };
    }

    yield {
      type: 'usage',
      usage: normalizedUsage,
    };
    yield {
      type: 'finish',
      reason: stopReason,
    };
  }
}

interface StreamingToolCall {
  index: number;
  id?: string;
  name: string;
  started: boolean;
  readyToStart: boolean;
  pendingArguments: string;
}

const TEXT_FLUSH_INTERVAL_MS = 24;
const TEXT_FLUSH_MAX_CHARS = 256;

type StreamInput =
  | { kind: 'next'; result: IteratorResult<AICompletionChunk> }
  | { kind: 'flush' };

function hasNonTextPayload(chunk: AICompletionChunk): boolean {
  return Boolean(
    chunk.toolCallDeltas?.length ||
      chunk.finishReason ||
      chunk.usage,
  );
}

function waitForStreamInput(
  next: Promise<IteratorResult<AICompletionChunk>>,
  deadlineMs: number,
): Promise<StreamInput> {
  const remainingMs = Math.max(0, deadlineMs - Date.now());
  if (remainingMs === 0) return Promise.resolve({ kind: 'flush' });
  return new Promise<StreamInput>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ kind: 'flush' });
    }, remainingMs);
    next.then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: 'next', result });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Preserve the first visible token immediately, then batch subsequent network
 * chunks with a real maximum-latency timer. This keeps the panel smooth without
 * creating one durable runtime journal row per provider token.
 */
async function* coalesceVisibleText(
  source: AsyncIterable<AICompletionChunk>,
): AsyncIterable<AICompletionChunk> {
  const iterator = source[Symbol.asyncIterator]();
  let next: Promise<IteratorResult<AICompletionChunk>> | undefined;
  let pendingText = '';
  let flushDeadlineMs = 0;
  let visibleTextEmitted = false;
  let iteratorCompleted = false;
  try {
    while (true) {
      next ??= iterator.next();
      const input =
        pendingText && visibleTextEmitted
          ? await waitForStreamInput(next, flushDeadlineMs)
          : {
              kind: 'next' as const,
              result: await next,
            };
      if (input.kind === 'flush') {
        yield { delta: pendingText };
        pendingText = '';
        flushDeadlineMs = 0;
        continue;
      }

      next = undefined;
      if (input.result.done) {
        iteratorCompleted = true;
        break;
      }
      const chunk = input.result.value;
      const nonText = hasNonTextPayload(chunk);
      if (chunk.delta) {
        if (!visibleTextEmitted && !pendingText) {
          visibleTextEmitted = true;
          yield chunk;
          continue;
        }
        if (!pendingText) {
          flushDeadlineMs = Date.now() + TEXT_FLUSH_INTERVAL_MS;
        }
        pendingText += chunk.delta;
      }

      if (
        pendingText &&
        (nonText || pendingText.length >= TEXT_FLUSH_MAX_CHARS)
      ) {
        yield {
          ...chunk,
          delta: pendingText,
        };
        pendingText = '';
        flushDeadlineMs = 0;
        continue;
      }
      if (nonText) yield chunk;
    }
    if (pendingText) yield { delta: pendingText };
  } finally {
    if (!iteratorCompleted) {
      try {
        await iterator.return?.();
      } catch {
        // The caller's cancellation/error is authoritative.
      }
    }
  }
}

async function* streamCompletion(
  client: AgentCompletionClient,
  request: AICompletionRequest,
): AsyncIterable<AgentModelStreamEvent> {
  if (!client.stream) {
    throw new AgentModelDriverError(
      'The configured model provider does not support streaming.',
    );
  }

  const calls = new Map<number, StreamingToolCall>();
  const callIds = new Set<string>();
  let nextToolStartIndex = 0;
  let usage: AIUsage | undefined;
  let providerFinishReason: string | undefined;

  for await (const chunk of coalesceVisibleText(client.stream(request))) {
    if (providerFinishReason && hasStreamPayload(chunk)) {
      throw invalidToolStream();
    }

    if (chunk.delta) {
      yield { type: 'text_delta', text: chunk.delta };
    }

    if (chunk.toolCallDeltas?.length) {
      for (const delta of chunk.toolCallDeltas) {
        if (!Number.isSafeInteger(delta.index) || delta.index < 0) {
          throw invalidToolStream();
        }
        const call = calls.get(delta.index) ?? {
          index: delta.index,
          name: '',
          started: false,
          readyToStart: false,
          pendingArguments: '',
        };
        if (delta.id) {
          if (call.id && call.id !== delta.id) {
            throw invalidToolStream();
          }
          if (!call.id && callIds.has(delta.id)) {
            throw invalidToolStream();
          }
          call.id = delta.id;
          callIds.add(delta.id);
        }
        if (delta.nameDelta) {
          if (call.started) {
            throw invalidToolStream();
          }
          call.name += delta.nameDelta;
        }
        calls.set(delta.index, call);

        // OpenAI-compatible providers are allowed to fragment function names.
        // The first argument fragment is the only unambiguous boundary that
        // the name has finished; no-argument calls are started at stream end.
        if (
          !call.started &&
          delta.argumentsDelta !== undefined
        ) {
          call.readyToStart = true;
        }

        if (delta.argumentsDelta) {
          call.pendingArguments += delta.argumentsDelta;
          if (call.started && call.id) {
            yield {
              type: 'tool_args_delta',
              callId: call.id,
              delta: call.pendingArguments,
            };
            call.pendingArguments = '';
          }
        }
      }

      // Provider call indexes define canonical execution order. Buffer a call
      // that arrives before an earlier index instead of letting network chunk
      // order reverse serialized writes in AgentRuntime.
      while (true) {
        const call = calls.get(nextToolStartIndex);
        if (
          !call?.readyToStart ||
          !call.id ||
          !call.name.trim()
        ) {
          break;
        }
        call.started = true;
        yield {
          type: 'tool_call_start',
          callId: call.id,
          name: call.name,
        };
        if (call.pendingArguments) {
          yield {
            type: 'tool_args_delta',
            callId: call.id,
            delta: call.pendingArguments,
          };
          call.pendingArguments = '';
        }
        nextToolStartIndex += 1;
      }
    }

    if (chunk.usage) {
      if (usage) throw invalidToolStream();
      usage = chunk.usage;
    }
    if (chunk.finishReason) {
      if (
        providerFinishReason &&
        providerFinishReason !== chunk.finishReason
      ) {
        throw invalidToolStream();
      }
      providerFinishReason = chunk.finishReason;
    }
  }

  const orderedCalls = [...calls.values()].sort(
    (left, right) => left.index - right.index,
  );
  for (const [index, call] of orderedCalls.entries()) {
    if (call.index !== index || !call.id || !call.name.trim()) {
      throw invalidToolStream();
    }
  }
  const stopReason = inferStreamStopReason(
    providerFinishReason,
    orderedCalls.length > 0,
  );
  if (!usage) {
    throw new AgentModelDriverError(
      'Model provider stream ended without usage.',
    );
  }
  const normalizedUsage = normalizeStreamUsage(usage);
  for (const call of orderedCalls) {
    const callId = call.id;
    if (!callId) throw invalidToolStream();
    if (!call.started) {
      call.started = true;
      yield {
        type: 'tool_call_start',
        callId,
        name: call.name,
      };
    }
    if (call.pendingArguments) {
      yield {
        type: 'tool_args_delta',
        callId,
        delta: call.pendingArguments,
      };
      call.pendingArguments = '';
    }
    yield { type: 'tool_call_end', callId };
  }

  yield { type: 'usage', usage: normalizedUsage };
  yield {
    type: 'finish',
    reason: stopReason,
  };
}

function hasStreamPayload(chunk: AICompletionChunk): boolean {
  return Boolean(
    chunk.delta ||
      chunk.toolCallDeltas?.length ||
      chunk.finishReason,
  );
}

function invalidToolStream(): AgentModelDriverError {
  return new AgentModelDriverError(
    'Model provider returned an invalid tool stream.',
  );
}

function normalizeStreamUsage(usage: AIUsage): AgentRuntimeUsage {
  assertValidUsage(usage);
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cachedTokens ?? 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };
}

function inferStreamStopReason(
  finishReason: string | undefined,
  hasToolCalls: boolean,
): AgentModelStopReason {
  if (finishReason === undefined) {
    throw new AgentModelDriverError(
      'Model provider stream ended without a finish reason.',
    );
  }
  if (hasToolCalls) {
    if (finishReason !== 'tool_calls') throw invalidToolStream();
    return 'tool_use';
  }
  switch (finishReason) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
    case 'function_call':
      throw invalidToolStream();
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'unknown';
  }
}

function projectPlannedMessages(
  context: AgentModelRequest['context'],
): AIMessage[] {
  const projected: AIMessage[] = [];
  for (const message of context.messages) {
    switch (message.type) {
      case 'model_message':
        requireSourceIds(message.sourceIds, 'canonical model context');
        projected.push(...projectMessages([message.message]));
        break;
      case 'context_summary':
        requireSourceIds(message.sourceIds, 'context summary');
        if (
          !message.summaryId ||
          !message.sourceHash.startsWith('sha256:') ||
          !message.content
        ) {
          invalidPlannedContext();
        }
        projected.push({
          role: 'user',
          content: JSON.stringify({
            type: 'drifting_verified_context_summary',
            provenance: {
              origin: 'drifting_runtime',
              summaryId: message.summaryId,
              sourceCount: message.sourceIds.length,
              sourceHash: message.sourceHash,
            },
            content: message.content,
          }),
        });
        break;
      case 'context_note':
        if (
          !message.sourceId ||
          (message.noteKind !== 'write_review' &&
            message.noteKind !== 'write_revert' &&
            message.noteKind !== 'freshness') ||
          (message.turnOrdinal !== null &&
            (!Number.isSafeInteger(message.turnOrdinal) ||
              message.turnOrdinal < 0)) ||
          typeof message.content !== 'string'
        ) {
          invalidPlannedContext();
        }
        projected.push({
          role: 'user',
          content: JSON.stringify({
            type: 'drifting_verified_context_note',
            provenance: {
              origin: 'drifting_runtime',
              noteKind: message.noteKind,
              sourceId: message.sourceId,
              turnOrdinal: message.turnOrdinal,
            },
            content: message.content,
          }),
        });
        break;
    }
  }
  return projected;
}

function projectMessages(messages: readonly AgentModelMessage[]): AIMessage[] {
  const projected: AIMessage[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      projected.push({ role: 'user', content: message.content });
      continue;
    }
    if (message.role === 'tool') {
      for (const result of message.content) {
        projected.push({
          role: 'tool',
          toolCallId: result.callId,
          content: projectToolResult(result),
        });
      }
      continue;
    }

    let content = '';
    const toolCalls: AIToolCall[] = [];
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          content += block.text;
          break;
        case 'thinking':
          if (block.text) {
            throw new AgentModelDriverError(
              'Reasoning history cannot be replayed by the General Agent driver.',
            );
          }
          break;
        case 'tool_call':
          toolCalls.push({
            id: block.callId,
            name: block.name,
            arguments: block.arguments,
          });
          break;
      }
    }
    projected.push({
      role: 'model',
      content,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    });
  }
  return projected;
}

function requirePlannedSystem(systemPrompt: string): string {
  if (typeof systemPrompt !== 'string' || systemPrompt.trim().length === 0) {
    invalidPlannedContext();
  }
  return systemPrompt;
}

function requireSourceIds(sourceIds: readonly string[], label: string): void {
  if (
    !Array.isArray(sourceIds) ||
    sourceIds.length === 0 ||
    new Set(sourceIds).size !== sourceIds.length ||
    sourceIds.some((sourceId) => !sourceId)
  ) {
    throw new AgentModelDriverError(
      `The planned ${label} has invalid provenance.`,
    );
  }
}

function invalidPlannedContext(): never {
  throw new AgentModelDriverError(
    'The runtime supplied an invalid planned model context.',
  );
}

function projectToolResult(result: AgentToolResultBlock): string {
  return result.ok ? result.content : `Tool failed: ${result.content}`;
}

function responseToolCalls(response: AICompletionResponse): AIToolCall[] {
  if (response.toolCalls?.length) return response.toolCalls;
  return response.toolCall ? [response.toolCall] : [];
}

function normalizeUsage(response: AICompletionResponse): AgentRuntimeUsage {
  assertValidUsage(response.usage);
  return {
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    cacheReadTokens: response.usage.cachedTokens ?? 0,
    cacheWriteTokens: 0,
    // The existing LLMClient meters cost outside AICompletionResponse. P1 keeps
    // the runtime cost field explicit rather than inventing provider pricing.
    costUsd: 0,
  };
}

function assertValidUsage(usage: AIUsage): void {
  if (
    !Number.isSafeInteger(usage.inputTokens) ||
    usage.inputTokens < 0 ||
    !Number.isSafeInteger(usage.outputTokens) ||
    usage.outputTokens < 0 ||
    (usage.cachedTokens !== undefined &&
      (!Number.isSafeInteger(usage.cachedTokens) ||
        usage.cachedTokens < 0))
  ) {
    throw new AgentModelDriverError(
      'Model provider returned invalid usage.',
    );
  }
}

function inferStopReason(
  response: AICompletionResponse,
  hasToolCalls: boolean,
): AgentModelStopReason {
  const rawReason =
    response.finishReason ??
    openAICompatibleFinishReason(response.raw);
  if (hasToolCalls) {
    if (rawReason !== 'tool_calls') {
      throw new AgentModelDriverError(
        'Model provider returned an invalid tool completion.',
      );
    }
    return 'tool_use';
  }
  switch (rawReason) {
    case 'stop':
      return 'end_turn';
    case undefined:
      throw new AgentModelDriverError(
        'Model provider completion ended without a finish reason.',
      );
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'unknown';
  }
}

function openAICompatibleFinishReason(raw: unknown): string | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.choices)) return undefined;
  const choice = raw.choices[0];
  if (!isRecord(choice)) return undefined;
  return typeof choice.finish_reason === 'string'
    ? choice.finish_reason
    : undefined;
}

function serializeToolArguments(argumentsValue: unknown): string {
  try {
    if (!isRecord(argumentsValue)) {
      throw new TypeError('tool arguments must be a JSON object');
    }
    const seen = new WeakSet<object>();
    const serialized = JSON.stringify(
      argumentsValue,
      (_key, current: unknown) => {
        if (
          current === undefined ||
          typeof current === 'function' ||
          typeof current === 'symbol' ||
          typeof current === 'bigint' ||
          (typeof current === 'number' && !Number.isFinite(current))
        ) {
          throw new TypeError('tool arguments contain a non-JSON value');
        }
        if (typeof current === 'object' && current !== null) {
          if (seen.has(current)) {
            throw new TypeError('tool arguments contain a cycle');
          }
          seen.add(current);
        }
        return current;
      },
    );
    if (serialized === undefined) {
      throw new Error('not JSON serializable');
    }
    const roundTrip = JSON.parse(serialized) as unknown;
    if (!isRecord(roundTrip)) {
      throw new TypeError('tool arguments must serialize to a JSON object');
    }
    return serialized;
  } catch {
    throw new AgentModelDriverError(
      'Model provider returned invalid tool arguments.',
    );
  }
}

function safeCompletionError(error: unknown): AgentModelDriverError {
  if (error instanceof AgentModelDriverError) return error;
  if (error instanceof AIError) {
    switch (error.kind) {
      case 'auth':
        return new AgentModelDriverError(
          'Model provider authentication failed.',
        );
      case 'rate-limit':
        return new AgentModelDriverError(
          'Model provider rate limit was reached.',
        );
      case 'invalid-input':
        return new AgentModelDriverError('Model request was rejected.');
      case 'parse':
        return new AgentModelDriverError(
          'Model provider returned an invalid response.',
        );
      case 'network':
        return new AgentModelDriverError(
          'Model provider request failed because of a network error.',
        );
      case 'aborted':
        return new AgentModelDriverError('Model provider request was aborted.');
      case 'unknown':
        return new AgentModelDriverError('Model provider request failed.');
    }
  }
  return new AgentModelDriverError('Model provider request failed.');
}

function requireProviderField(
  value: string | undefined,
  label: string,
): string {
  if (typeof value === 'string' && value.trim()) return value;
  throw new AgentModelDriverError(
    `Model provider returned a tool call without a ${label}.`,
  );
}

function requireNonEmpty(value: string, label: string): string {
  if (value.trim()) return value;
  throw new Error(`${label} must not be empty`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
