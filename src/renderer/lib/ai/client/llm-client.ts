/**
 * LLMClient — L2 transport facade.
 *
 * Wraps a provider with three pieces of "industrial-grade" behavior:
 *   1. Interceptor chain (cross-cutting: logging, metering, quota, cache, …)
 *   2. Retry-with-backoff for transient failures (rate limit, network)
 *   3. AbortSignal propagation (delegated to the provider's complete())
 *
 * Everything above this layer (Context, Prompt, Feature) interacts only with
 * this class. Provider swap (Google → Anthropic) only requires constructing
 * with a different provider.
 */
import type { LLMProvider } from './providers/provider';
import type { RequestInterceptor } from '../interceptors/interceptor';
import {
  AIError,
  type AICompletionChunk,
  type AICompletionRequest,
  type AICompletionResponse,
  type AIToolCall,
  type AIUsage,
} from '../types';
import { withRetry, type RetryConfig } from './retry';

export const MALFORMED_STREAMED_TOOL_ARGUMENTS_CODE = 'MALFORMED_STREAMED_TOOL_ARGUMENTS' as const;
export const MISSING_REASONING_TOOL_CALL_CODE = 'MISSING_REASONING_TOOL_CALL' as const;

export function isMalformedStreamedToolArgumentsError(error: unknown): error is AIError {
  if (!(error instanceof AIError) || error.kind !== 'parse') return false;
  const cause = error.cause;
  return Boolean(
    cause &&
    typeof cause === 'object' &&
    'code' in cause &&
    cause.code === MALFORMED_STREAMED_TOOL_ARGUMENTS_CODE,
  );
}

export function isMissingReasoningToolCallError(error: unknown): error is AIError {
  if (!(error instanceof AIError) || error.kind !== 'parse') return false;
  const cause = error.cause;
  return Boolean(
    cause &&
    typeof cause === 'object' &&
    'code' in cause &&
    cause.code === MISSING_REASONING_TOOL_CALL_CODE,
  );
}

export interface LLMClientOptions {
  retry?: RetryConfig;
}

export class LLMClient {
  private readonly interceptors: RequestInterceptor[] = [];

  constructor(
    private readonly provider: LLMProvider,
    private readonly options: LLMClientOptions = {},
  ) {}

  /** Register an interceptor. Order matters — registered first runs first in `before`. */
  use(interceptor: RequestInterceptor): this {
    this.interceptors.push(interceptor);
    return this;
  }

  /** Whether the underlying provider supports a real function-calling loop. */
  get supportsTools(): boolean {
    return this.provider.supportsTools === true;
  }

  /** Stable provider capability id; callers must not infer wire behavior from model names. */
  get providerId(): string {
    return this.provider.id;
  }

  /** Whether the provider's stream preserves the full function-calling loop. */
  get supportsToolStreaming(): boolean {
    return (
      this.provider.supportsToolStreaming === true && typeof this.provider.stream === 'function'
    );
  }

  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    let req = request;
    for (const it of this.interceptors) {
      const next = await it.before?.(req);
      if (next) req = next;
    }

    try {
      const res = await withRetry(
        async () => {
          const response = await this.provider.complete(req);
          // Terminal validation belongs inside the retry lease. A syntactically
          // successful HTTP response can still be a stochastic, unusable model
          // sample (truncated tool JSON, missing finish/usage/reasoning).
          validateCompletionTerminal(req, response);
          return response;
        },
        isRetryable,
        this.options.retry,
        req.signal,
      );
      for (const it of this.interceptors) {
        try {
          await it.after?.(req, res);
        } catch (e) {
          // Observer interceptors must not affect business flow. Log and continue.
          console.warn('[ai] observer after() threw', e);
        }
      }
      return res;
    } catch (err) {
      for (const it of this.interceptors) {
        try {
          await it.onError?.(req, err);
        } catch (e) {
          console.warn('[ai] observer onError() threw', e);
        }
      }
      throw err;
    }
  }

  /**
   * Stream a completion as incremental text/tool chunks. Runs the same
   * interceptor chain as complete(): `before` hooks first, then on completion a
   * synthesized final response is handed to `after` so the ai-log captures
   * text, parallel tool calls, and usage exactly like a non-streaming call.
   * No retry — a mid-stream retry would replay partial output. Providers
   * without `stream()` fall back to one chunk wrapping `complete()`.
   */
  async *stream(request: AICompletionRequest): AsyncIterable<AICompletionChunk> {
    let req = request;
    for (const it of this.interceptors) {
      const next = await it.before?.(req);
      if (next) req = next;
    }

    let text = '';
    let thinking = '';
    let usage: AIUsage | undefined;
    let finishReason: string | undefined;
    const streamedCalls = new Map<number, { id?: string; name: string; rawArguments: string }>();
    let fallbackResponse: AICompletionResponse | undefined;
    let observerSettled = false;
    let completed = false;
    let terminalSeen = false;
    try {
      const canUseProviderStream =
        typeof this.provider.stream === 'function' &&
        (!req.tools?.length || this.provider.supportsToolStreaming === true);
      if (canUseProviderStream && this.provider.stream) {
        for await (const chunk of this.provider.stream(req)) {
          if (terminalSeen && (chunk.delta || chunk.toolCallDeltas?.length || chunk.finishReason)) {
            throw invalidTerminalResponse(
              'Model provider emitted payload after the finish reason.',
            );
          }
          if (chunk.delta) text += chunk.delta;
          if (chunk.thinkingDelta) thinking += chunk.thinkingDelta;
          for (const delta of chunk.toolCallDeltas ?? []) {
            if (!Number.isSafeInteger(delta.index) || delta.index < 0) {
              throw invalidTerminalResponse('Model provider returned an invalid tool-call index.');
            }
            const call = streamedCalls.get(delta.index) ?? {
              name: '',
              rawArguments: '',
            };
            if (delta.id) {
              if (call.id && call.id !== delta.id) {
                throw invalidTerminalResponse('Model provider changed a streamed tool-call id.');
              }
              call.id = delta.id;
            }
            if (delta.nameDelta) call.name += delta.nameDelta;
            if (delta.argumentsDelta) {
              call.rawArguments += delta.argumentsDelta;
            }
            streamedCalls.set(delta.index, call);
          }
          if (chunk.usage) {
            if (usage) {
              throw invalidTerminalResponse(
                'Model provider emitted terminal usage more than once.',
              );
            }
            usage = chunk.usage;
          }
          if (chunk.finishReason) {
            if (finishReason) {
              throw invalidTerminalResponse(
                'Model provider emitted a finish reason more than once.',
              );
            }
            finishReason = chunk.finishReason;
            terminalSeen = true;
          }
          yield chunk;
        }
      } else {
        const res = await this.provider.complete(req);
        validateCompletionTerminal(req, res);
        fallbackResponse = res;
        text = res.text ?? '';
        thinking = res.thinking ?? '';
        usage = res.usage;
        if (text) yield { delta: text };
        if (thinking) yield { delta: '', thinkingDelta: thinking };
        const calls = res.toolCalls?.length ? res.toolCalls : res.toolCall ? [res.toolCall] : [];
        for (const [index, call] of calls.entries()) {
          const rawArguments = stringifyStreamedArguments(
            call.arguments,
            requiresStrictTerminal(req),
          );
          streamedCalls.set(index, {
            ...(call.id ? { id: call.id } : {}),
            name: call.name,
            rawArguments,
          });
          yield {
            delta: '',
            toolCallDeltas: [
              {
                index,
                ...(call.id ? { id: call.id } : {}),
                nameDelta: call.name,
                argumentsDelta: rawArguments,
              },
            ],
          };
        }
        const explicitFinishReason = completionFinishReason(res);
        finishReason =
          explicitFinishReason ??
          (requiresExplicitFinish(req) ? undefined : calls.length > 0 ? 'tool_calls' : 'stop');
        yield {
          delta: '',
          usage,
          ...(finishReason ? { finishReason } : {}),
        };
      }

      const orderedStreamedCalls = [...streamedCalls.entries()].sort(
        ([left], [right]) => left - right,
      );
      const strictTerminal = requiresStrictTerminal(req);
      const toolCalls = orderedStreamedCalls.map(([index, call], orderedIndex): AIToolCall => {
        if (strictTerminal && index !== orderedIndex) {
          throw invalidTerminalResponse(
            'Model provider returned a non-contiguous tool-call sequence.',
          );
        }
        return {
          ...(call.id ? { id: call.id } : {}),
          name: call.name,
          arguments: parseStreamedArguments(call.rawArguments, strictTerminal),
        };
      });
      validateTerminalParts(req, {
        finishReason,
        usage,
        toolCalls,
        reasoningContent: thinking,
      });
      const finalRes: AICompletionResponse = {
        ...(text ? { text } : {}),
        ...(thinking ? { thinking } : {}),
        ...(toolCalls.length ? { toolCall: toolCalls[0], toolCalls } : {}),
        ...(finishReason ? { finishReason } : {}),
        usage: usage ?? { inputTokens: 0, outputTokens: 0 },
      };
      completed = true;
      for (const it of this.interceptors) {
        try {
          await it.after?.(req, fallbackResponse ?? finalRes);
        } catch (e) {
          console.warn('[ai] observer after() threw', e);
        }
      }
      observerSettled = true;
    } catch (err) {
      for (const it of this.interceptors) {
        try {
          await it.onError?.(req, err);
        } catch (e) {
          console.warn('[ai] observer onError() threw', e);
        }
      }
      observerSettled = true;
      throw err;
    } finally {
      // Async-generator consumers may call return() while suspended at a yield
      // (panel unmount, turn abort, driver failure). That bypasses the catch
      // body. Settle observers once so CaptureInterceptor never keeps a stale
      // in-flight entry or records a partial stream as success.
      if (!completed && !observerSettled) {
        const cancellation = new AIError(
          'aborted',
          'Streaming response consumption was cancelled.',
        );
        for (const it of this.interceptors) {
          try {
            await it.onError?.(req, cancellation);
          } catch (e) {
            console.warn('[ai] observer onError() threw', e);
          }
        }
        observerSettled = true;
      }
    }
  }
}

function parseStreamedArguments(raw: string, strict: boolean): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    if (strict) {
      throw new AIError('parse', 'Model provider returned malformed streamed tool arguments.', {
        code: MALFORMED_STREAMED_TOOL_ARGUMENTS_CODE,
        cause: error,
      });
    }
    // The runtime consumes and validates raw deltas independently. Preserve a
    // malformed provider payload for diagnostics without making an observer
    // snapshot throw after output has already reached the user.
    return raw;
  }
}

function stringifyStreamedArguments(value: unknown, strict = false): string {
  try {
    const input = value ?? (strict ? value : {});
    if (strict && (typeof input !== 'object' || input === null || Array.isArray(input))) {
      throw new TypeError('tool arguments must be a JSON object');
    }
    const seen = new WeakSet<object>();
    const serialized = JSON.stringify(input, (_key, current: unknown) => {
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
    });
    if (serialized === undefined) {
      throw new TypeError('tool arguments are not JSON serializable');
    }
    if (strict) {
      const roundTrip = JSON.parse(serialized) as unknown;
      if (typeof roundTrip !== 'object' || roundTrip === null || Array.isArray(roundTrip)) {
        throw new TypeError('tool arguments must serialize to a JSON object');
      }
    }
    return serialized;
  } catch (error) {
    if (strict) {
      throw new AIError('parse', 'Model provider returned non-JSON tool arguments.', error);
    }
    return '{}';
  }
}

function completionFinishReason(response: AICompletionResponse): string | undefined {
  if (response.finishReason) return response.finishReason;
  const raw = response.raw;
  if (raw && typeof raw === 'object' && Array.isArray((raw as { choices?: unknown }).choices)) {
    const choice = (raw as { choices: unknown[] }).choices[0];
    if (
      choice &&
      typeof choice === 'object' &&
      typeof (choice as { finish_reason?: unknown }).finish_reason === 'string'
    ) {
      return (choice as { finish_reason: string }).finish_reason;
    }
  }
  return undefined;
}

function requiresExplicitFinish(request: AICompletionRequest): boolean {
  return request.terminalRequirements?.finishReason === true;
}

function requiresStrictTerminal(request: AICompletionRequest): boolean {
  return Boolean(
    request.terminalRequirements?.finishReason ||
    request.terminalRequirements?.usage ||
    request.terminalRequirements?.reasoningContentForToolCalls,
  );
}

function completionToolCalls(response: AICompletionResponse): AIToolCall[] {
  if (response.toolCalls?.length) return response.toolCalls;
  return response.toolCall ? [response.toolCall] : [];
}

function validateCompletionTerminal(
  request: AICompletionRequest,
  response: AICompletionResponse,
): void {
  const toolCalls = completionToolCalls(response);
  if (
    requiresStrictTerminal(request) &&
    response.toolCall &&
    response.toolCalls?.length &&
    response.toolCalls[0] !== response.toolCall &&
    (response.toolCalls[0].id !== response.toolCall.id ||
      response.toolCalls[0].name !== response.toolCall.name)
  ) {
    throw invalidTerminalResponse('Model provider returned inconsistent primary tool-call fields.');
  }
  validateTerminalParts(request, {
    finishReason: completionFinishReason(response),
    usage: response.usage,
    toolCalls,
    reasoningContent: response.thinking,
  });
}

function validateTerminalParts(
  request: AICompletionRequest,
  terminal: {
    finishReason: string | undefined;
    usage: AIUsage | undefined;
    toolCalls: readonly AIToolCall[];
    reasoningContent?: string;
  },
): void {
  if (request.terminalRequirements?.usage) {
    if (!terminal.usage) {
      throw invalidTerminalResponse('Model provider stream ended without terminal usage.');
    }
    if (
      !Number.isSafeInteger(terminal.usage.inputTokens) ||
      terminal.usage.inputTokens < 0 ||
      !Number.isSafeInteger(terminal.usage.outputTokens) ||
      terminal.usage.outputTokens < 0 ||
      (terminal.usage.cachedTokens !== undefined &&
        (!Number.isSafeInteger(terminal.usage.cachedTokens) || terminal.usage.cachedTokens < 0))
    ) {
      throw invalidTerminalResponse('Model provider returned invalid terminal usage.');
    }
  }
  if (request.terminalRequirements?.finishReason && !terminal.finishReason) {
    throw invalidTerminalResponse('Model provider stream ended without a finish reason.');
  }
  if (!requiresStrictTerminal(request)) return;

  if (
    request.terminalRequirements?.reasoningContentForToolCalls &&
    terminal.toolCalls.length > 0 &&
    !terminal.reasoningContent?.trim()
  ) {
    throw new AIError('parse', 'Model provider returned a tool call without reasoning content.', {
      code: MISSING_REASONING_TOOL_CALL_CODE,
    });
  }

  const forcedToolName = typeof request.toolChoice === 'object' ? request.toolChoice.force : null;
  if (
    (request.toolChoice === 'required' || forcedToolName !== null) &&
    terminal.toolCalls.length === 0
  ) {
    throw invalidTerminalResponse('Model provider ignored the required tool call.');
  }
  if (forcedToolName !== null && terminal.toolCalls.some((call) => call.name !== forcedToolName)) {
    throw invalidTerminalResponse(
      'Model provider returned a different tool than the forced tool call.',
    );
  }

  const callIds = new Set<string>();
  for (const call of terminal.toolCalls) {
    if (!call.id?.trim() || !call.name.trim() || callIds.has(call.id)) {
      throw invalidTerminalResponse('Model provider returned invalid streamed tool-call identity.');
    }
    callIds.add(call.id);
    stringifyStreamedArguments(call.arguments, true);
  }
  if (terminal.toolCalls.length > 0 && terminal.finishReason !== 'tool_calls') {
    throw invalidTerminalResponse(
      'Model provider returned tool calls without a tool_calls finish reason.',
    );
  }
  if (
    terminal.toolCalls.length === 0 &&
    (terminal.finishReason === 'tool_calls' || terminal.finishReason === 'function_call')
  ) {
    throw invalidTerminalResponse(
      'Model provider returned a tool finish reason without tool calls.',
    );
  }
}

function invalidTerminalResponse(message: string): AIError {
  return new AIError('parse', message);
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof AIError)) return false;
  // 'parse' = the model's output didn't parse (e.g. DeepSeek-flash emitting tool
  // args with an unescaped inner quote). That's a STOCHASTIC glitch — a fresh
  // sample almost always parses — so re-sampling is the right move (this is the
  // "retry layer handles that class" the deepseek provider's repair note assumes).
  // A genuine schema-mismatch is rare here and bounded to maxAttempts; worth it.
  return err.kind === 'rate-limit' || err.kind === 'network' || err.kind === 'parse';
}
