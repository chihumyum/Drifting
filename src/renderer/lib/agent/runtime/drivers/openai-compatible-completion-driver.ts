/**
 * Adapter from Drifting's provider-neutral LLMClient contract to the canonical
 * AgentModelDriver stream.
 *
 * The existing OpenAI-compatible providers own credentials, wire translation,
 * and function calls. This adapter owns the bounded pre-effect sample retry
 * boundary without exposing raw provider errors. It:
 *   - projects canonical AgentModelMessage blocks into AIMessage,
 *   - preserves DeepSeek reasoning_content inside the active tool loop,
 *   - forwards true text/tool deltas when the provider supports them,
 *   - retains a completion-to-stream compatibility path for older providers.
 */
import {
  isMalformedStreamedToolArgumentsError,
  isMissingReasoningToolCallError,
  type LLMClient,
} from '../../../ai/client/llm-client';
import { DEFAULT_RETRY, withRetry, type RetryConfig } from '../../../ai/client/retry';
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
import {
  serializeAgentContextNoteBudgetPayload,
  serializeAgentContextSummaryProviderPayload,
} from '../context-planner';
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
  stream?(request: AICompletionRequest): AsyncIterable<AICompletionChunk>;
}

export interface OpenAICompatibleCompletionDriverOptions {
  client: AgentCompletionClient | LLMClient;
  /** Used when the runtime did not pin a model for this turn. */
  defaultModel: string;
  /** Stable runtime/journal id, not a provider display name. */
  id?: string;
  /** Existing AI interceptor attribution key. */
  feature?: string;
  /** Enables the certified DeepSeek thinking/replay wire contract. */
  reasoningMode?: 'disabled' | 'deepseek';
  /** Bounded pre-effect retry lease for malformed streamed model samples. */
  providerAttemptRetry?: RetryConfig;
}

const DEFAULT_DRIVER_ID = 'openai-compatible-completion';
const DEFAULT_FEATURE = 'general-agent';
const DEFAULT_PROVIDER_ATTEMPT_RETRY: RetryConfig = {
  ...DEFAULT_RETRY,
  maxAttempts: 6,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
};

type ProviderSampleRecovery =
  | {
      reason: 'max_tokens_before_action';
      planningExcerpt: string;
    }
  | {
      reason: 'unavailable_tool';
      availableToolNames: readonly string[];
    }
  | {
      reason: 'malformed_tool_arguments';
      availableToolNames: readonly string[];
    }
  | {
      reason: 'missing_reasoning_content';
      availableToolNames: readonly string[];
    }
  | {
      reason: 'invalid_response';
      availableToolNames: readonly string[];
    };

class RetryableProviderSampleError extends AgentModelDriverError {
  constructor(
    public readonly recovery: ProviderSampleRecovery,
    publicMessage: string,
  ) {
    super(publicMessage, true);
    this.name = 'RetryableProviderSampleError';
  }
}

export class OpenAICompatibleCompletionDriver implements AgentModelDriver {
  readonly id: string;
  readonly capabilities: { readonly reasoning: boolean };

  private readonly client: AgentCompletionClient;
  private readonly defaultModel: string;
  private readonly feature: string;
  private readonly reasoningMode: 'disabled' | 'deepseek';
  private readonly providerAttemptRetry: RetryConfig;
  private readonly reasoningReplayByCallId = new Map<string, string>();
  private readonly nonReasoningCallIds = new Set<string>();
  private readonly recoveryPlanningByCallId = new Map<string, string>();

  constructor(options: OpenAICompatibleCompletionDriverOptions) {
    this.client = options.client;
    this.defaultModel = requireNonEmpty(options.defaultModel, 'defaultModel');
    this.id = requireNonEmpty(options.id ?? DEFAULT_DRIVER_ID, 'id');
    this.feature = requireNonEmpty(options.feature ?? DEFAULT_FEATURE, 'feature');
    this.reasoningMode = options.reasoningMode ?? 'disabled';
    this.providerAttemptRetry = options.providerAttemptRetry ?? DEFAULT_PROVIDER_ATTEMPT_RETRY;
    this.capabilities = { reasoning: this.reasoningMode === 'deepseek' };
  }

  async *stream(request: AgentModelRequest): AsyncIterable<AgentModelStreamEvent> {
    const configuredReasoningEnabled = request.reasoning?.enabled === true;
    // DeepSeek requires every assistant tool-call message in a thinking-mode
    // segment to carry the exact reasoning_content that produced it. A bounded
    // action-recovery attempt intentionally turns thinking off so it can force
    // one complete tool call. On the next iteration we insert a transport-only
    // provider-user boundary immediately after that tool result. This closes
    // the non-reasoning segment, restores the author's configured reasoning
    // mode, and can hand the discarded private scratchpad back to the model
    // without pretending it was the reasoning_content for the recovered call.
    const hasReasoningResumeBoundary =
      configuredReasoningEnabled &&
      request.iteration > 1 &&
      hasActiveNonReasoningToolCall(request.context, this.nonReasoningCallIds);
    const reasoningEnabled =
      configuredReasoningEnabled && request.executionMode !== 'required_tool_non_reasoning';
    if (reasoningEnabled && this.reasoningMode !== 'deepseek') {
      throw new AgentModelDriverError('Reasoning is not supported by the General Agent driver.');
    }
    if (reasoningEnabled && request.iteration > 1 && !hasReasoningResumeBoundary) {
      assertActiveReasoningReplay(request.context, this.reasoningReplayByCallId);
    }
    if (request.tools.length > 0 && !this.client.supportsTools) {
      throw new AgentModelDriverError(
        'The configured model provider does not support agent tools.',
      );
    }

    const plannedMessages = projectPlannedMessages(
      request.context,
      this.reasoningMode,
      configuredReasoningEnabled ? this.reasoningReplayByCallId : undefined,
    );
    const providerMessages =
      reasoningEnabled && hasReasoningResumeBoundary
        ? insertReasoningResumeBoundary({
            messages: plannedMessages,
            activeNonReasoningCallIds: activeToolCallIds(request.context).filter((callId) =>
              this.nonReasoningCallIds.has(callId),
            ),
            recoveryPlanningByCallId: this.recoveryPlanningByCallId,
          })
        : plannedMessages;
    if (reasoningEnabled && hasReasoningResumeBoundary) {
      assertReasoningReplayAfterResumeBoundary(providerMessages);
    }

    const completionRequest: AICompletionRequest = {
      model: request.model ?? this.defaultModel,
      system: requirePlannedSystem(request.context.systemPrompt),
      messages: providerMessages,
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parametersSchema: tool.inputSchema,
      })),
      maxOutputTokens: request.maxOutputTokens,
      thinking: reasoningEnabled,
      ...(reasoningEnabled && request.reasoning?.effort
        ? { reasoningEffort: request.reasoning.effort }
        : {}),
      terminalRequirements: {
        finishReason: true,
        usage: true,
        ...(reasoningEnabled ? { reasoningContentForToolCalls: true } : {}),
      },
      ...(request.tools.length > 0 ? { toolChoice: request.toolChoice ?? ('auto' as const) } : {}),
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
      (request.tools.length === 0 || this.client.supportsToolStreaming === true)
    ) {
      try {
        const rememberReasoning = reasoningEnabled
          ? (callIds: readonly string[], reasoningContent: string) =>
              this.rememberReasoningReplay(callIds, reasoningContent)
          : undefined;
        if (request.tools.length === 0) {
          // Tool-free synthesis keeps true progressive text streaming. Once
          // visible output escapes, automatically replaying it would duplicate
          // author-facing prose, so this path intentionally has no mid-stream
          // resample lease.
          yield* streamCompletion(this.client, completionRequest, rememberReasoning);
        } else {
          // A tool-capable provider attempt is transactional: consume and
          // validate its entire stream before publishing any Agent event. This
          // makes malformed JSON, missing reasoning, incomplete identities and
          // transient transport failures safely resampleable because no tool
          // call, usage, assistant block or UI activity has escaped yet.
          let providerAttempt = 0;
          let recovery: ProviderSampleRecovery | undefined;
          const events = await withRetry(
            async () => {
              providerAttempt += 1;
              const attemptRequest = withProviderAttemptMetadata(
                recovery
                  ? withProviderSampleRecovery(completionRequest, recovery, providerAttempt)
                  : completionRequest,
                providerAttempt,
              );
              try {
                const collected = await collectModelEvents(
                  streamCompletion(this.client, attemptRequest),
                );
                assertCompleteProviderSample(
                  collected,
                  attemptRequest.tools?.map((tool) => tool.name) ?? [],
                );
                const callIds = collected.flatMap((event) =>
                  event.type === 'tool_call_start' ? [event.callId] : [],
                );
                if (callIds.length > 0) {
                  if (attemptRequest.thinking === true) {
                    this.rememberReasoningReplay(
                      callIds,
                      collected
                        .flatMap((event) => (event.type === 'thinking_delta' ? [event.text] : []))
                        .join(''),
                    );
                  } else {
                    this.rememberNonReasoningToolCalls(
                      callIds,
                      recovery?.reason === 'max_tokens_before_action'
                        ? recovery.planningExcerpt
                        : undefined,
                    );
                  }
                }
                return collected;
              } catch (error) {
                const nextRecovery = providerSampleRecovery(
                  error,
                  attemptRequest.tools?.map((tool) => tool.name) ?? [],
                );
                if (nextRecovery) {
                  recovery = mergeProviderSampleRecovery(recovery, nextRecovery);
                }
                throw error;
              }
            },
            isRetryableProviderAttemptError,
            this.providerAttemptRetry,
            request.signal,
          );
          for (const event of events) yield event;
        }
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
    if (reasoningEnabled && response.thinking) {
      yield { type: 'thinking_delta', text: response.thinking };
    }
    if (reasoningEnabled && toolCalls.length > 0) {
      this.rememberReasoningReplay(
        projectedToolCalls.map((call) => call.callId),
        requireProviderField(response.thinking, 'reasoning content'),
      );
    } else if (toolCalls.length > 0) {
      this.rememberNonReasoningToolCalls(projectedToolCalls.map((call) => call.callId));
    }
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

  private rememberReasoningReplay(callIds: readonly string[], reasoningContent: string): void {
    const exact = requireProviderField(reasoningContent, 'reasoning content');
    for (const callId of callIds) {
      this.nonReasoningCallIds.delete(callId);
      this.recoveryPlanningByCallId.delete(callId);
      this.reasoningReplayByCallId.set(callId, exact);
    }
  }

  private rememberNonReasoningToolCalls(
    callIds: readonly string[],
    recoveryPlanning?: string,
  ): void {
    const boundedPlanning = boundedPlanningExcerpt(recoveryPlanning ?? '');
    for (const callId of callIds) {
      this.reasoningReplayByCallId.delete(callId);
      this.nonReasoningCallIds.add(callId);
      if (boundedPlanning) {
        this.recoveryPlanningByCallId.set(callId, boundedPlanning);
      } else {
        this.recoveryPlanningByCallId.delete(callId);
      }
    }
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

type StreamInput = { kind: 'next'; result: IteratorResult<AICompletionChunk> } | { kind: 'flush' };

function hasNonTextPayload(chunk: AICompletionChunk): boolean {
  return Boolean(
    chunk.thinkingDelta || chunk.toolCallDeltas?.length || chunk.finishReason || chunk.usage,
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

      if (pendingText && (nonText || pendingText.length >= TEXT_FLUSH_MAX_CHARS)) {
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
  rememberReasoningReplay?: (callIds: readonly string[], reasoningContent: string) => void,
): AsyncIterable<AgentModelStreamEvent> {
  if (!client.stream) {
    throw new AgentModelDriverError('The configured model provider does not support streaming.');
  }

  const calls = new Map<number, StreamingToolCall>();
  const callIds = new Set<string>();
  let nextToolStartIndex = 0;
  let usage: AIUsage | undefined;
  let providerFinishReason: string | undefined;
  let reasoningContent = '';

  for await (const chunk of coalesceVisibleText(client.stream(request))) {
    if (providerFinishReason && hasStreamPayload(chunk)) {
      throw invalidToolStream();
    }

    if (chunk.delta) {
      yield { type: 'text_delta', text: chunk.delta };
    }
    if (chunk.thinkingDelta) {
      reasoningContent += chunk.thinkingDelta;
      yield { type: 'thinking_delta', text: chunk.thinkingDelta };
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
        if (!call.started && delta.argumentsDelta !== undefined) {
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
        if (!call?.readyToStart || !call.id || !call.name.trim()) {
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
      if (providerFinishReason && providerFinishReason !== chunk.finishReason) {
        throw invalidToolStream();
      }
      providerFinishReason = chunk.finishReason;
    }
  }

  const orderedCalls = [...calls.values()].sort((left, right) => left.index - right.index);
  for (const [index, call] of orderedCalls.entries()) {
    if (call.index !== index || !call.id || !call.name.trim()) {
      throw invalidToolStream();
    }
  }
  const stopReason = inferStreamStopReason(providerFinishReason, orderedCalls.length > 0);
  if (!usage) {
    throw new AgentModelDriverError('Model provider stream ended without usage.', true);
  }
  const normalizedUsage = normalizeStreamUsage(usage);
  if (orderedCalls.length > 0 && rememberReasoningReplay) {
    rememberReasoningReplay(
      orderedCalls.map((call) => call.id!),
      reasoningContent,
    );
  }
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

async function collectModelEvents(
  source: AsyncIterable<AgentModelStreamEvent>,
): Promise<AgentModelStreamEvent[]> {
  const events: AgentModelStreamEvent[] = [];
  for await (const event of source) {
    const previous = events[events.length - 1];
    if (event.type === 'thinking_delta' && previous?.type === 'thinking_delta') {
      events[events.length - 1] = {
        type: 'thinking_delta',
        text: previous.text + event.text,
      };
      continue;
    }
    if (event.type === 'text_delta' && previous?.type === 'text_delta') {
      events[events.length - 1] = {
        type: 'text_delta',
        text: previous.text + event.text,
      };
      continue;
    }
    if (
      event.type === 'tool_args_delta' &&
      previous?.type === 'tool_args_delta' &&
      previous.callId === event.callId
    ) {
      events[events.length - 1] = {
        type: 'tool_args_delta',
        callId: event.callId,
        delta: previous.delta + event.delta,
      };
      continue;
    }
    events.push(event);
  }
  return events;
}

function withProviderAttemptMetadata(
  request: AICompletionRequest,
  attempt: number,
): AICompletionRequest {
  return {
    ...request,
    metadata: {
      ...(request.metadata ?? { feature: DEFAULT_FEATURE }),
      agentProviderAttempt: attempt,
    },
  };
}

function withProviderSampleRecovery(
  request: AICompletionRequest,
  recovery: ProviderSampleRecovery,
  providerAttempt: number,
): AICompletionRequest {
  const instruction = providerSampleRecoveryInstruction(recovery, providerAttempt);
  if (recovery.reason === 'unavailable_tool') {
    return {
      ...request,
      messages: [
        ...request.messages,
        {
          role: 'user',
          content: JSON.stringify(instruction),
        },
      ],
    };
  }
  const { reasoningEffort: _discardedReasoningEffort, ...actionRequest } = request;
  void _discardedReasoningEffort;
  if (recovery.reason === 'invalid_response') {
    return {
      ...actionRequest,
      thinking: false,
      terminalRequirements: {
        finishReason: true,
        usage: true,
      },
      ...(request.tools?.length ? { toolChoice: 'required' as const } : {}),
      messages: [
        ...request.messages,
        {
          role: 'user',
          content: JSON.stringify(
            providerSampleRecoveryInstruction(recovery, providerAttempt),
          ),
        },
      ],
    };
  }
  return {
    ...actionRequest,
    thinking: false,
    terminalRequirements: {
      finishReason: true,
      usage: true,
    },
    ...(request.tools?.length ? { toolChoice: 'required' as const } : {}),
    messages: [
      ...request.messages,
      {
        role: 'user',
        content: JSON.stringify(instruction),
      },
    ],
  };
}

function providerSampleRecoveryInstruction(
  recovery: ProviderSampleRecovery,
  providerAttempt: number,
): Record<string, unknown> {
  switch (recovery.reason) {
    case 'max_tokens_before_action':
      return {
        type: 'drifting_runtime_provider_retry',
        provenance: { origin: 'drifting_runtime' },
        cause: 'previous_sample_exhausted_output_before_action',
        retryAttempt: providerAttempt,
        instruction:
          'The previous private reasoning sample spent its entire output allowance without completing an action. Its bounded scratchpad is supplied below. This is an action-serialization recovery call: do not restart analysis, restate a plan, broaden discovery, or produce an ordinary answer. Select one available tool and emit exactly one complete useful tool call supported by the gathered evidence.',
        discardedPlanningExcerpt: recovery.planningExcerpt,
      };
    case 'unavailable_tool':
      return {
        type: 'drifting_runtime_provider_retry',
        provenance: { origin: 'drifting_runtime' },
        cause: 'previous_sample_called_unavailable_tool',
        retryAttempt: providerAttempt,
        availableTools: [...recovery.availableToolNames],
        instruction:
          'The previous sample selected a tool that is not available in this recovery call. Do not restart analysis or broaden discovery. Emit exactly one complete useful tool call, choosing only from availableTools.',
      };
    case 'malformed_tool_arguments':
      return {
        type: 'drifting_runtime_provider_retry',
        provenance: { origin: 'drifting_runtime' },
        cause: 'previous_sample_malformed_tool_arguments',
        retryAttempt: providerAttempt,
        availableTools: [...recovery.availableToolNames],
        instruction:
          'The previous sample produced malformed or truncated tool arguments. Reuse the evidence already gathered; do not restart analysis or broaden discovery. Emit exactly one complete, smaller tool call using only availableTools. Keep long prose or large cleanup work focused enough to serialize fully, then continue the remaining work in later model iterations.',
      };
    case 'missing_reasoning_content':
      return {
        type: 'drifting_runtime_provider_retry',
        provenance: { origin: 'drifting_runtime' },
        cause: 'previous_sample_omitted_required_reasoning_content',
        retryAttempt: providerAttempt,
        availableTools: [...recovery.availableToolNames],
        instruction:
          'The previous reasoning-enabled sample emitted a tool call without the provider-required reasoning field, so it was discarded. This is a non-reasoning action-serialization recovery call. Reuse the gathered evidence, do not restart analysis or broaden discovery, and emit exactly one complete useful tool call using only availableTools.',
      };
    case 'invalid_response':
      return {
        type: 'drifting_runtime_provider_retry',
        provenance: { origin: 'drifting_runtime' },
        cause: 'previous_sample_was_invalid',
        retryAttempt: providerAttempt,
        availableTools: [...recovery.availableToolNames],
        instruction:
          'The previous sample was invalid and was discarded before any action escaped. Continue from the authored evidence already gathered. Emit exactly one complete, small, useful author-domain tool call using only availableTools. Do not reconstruct a large checklist or batch several actions in this recovery sample; the remaining work can continue in later iterations. Do not discuss the discarded sample, retry, provider, or operation mechanics.',
      };
  }
}

function assertCompleteProviderSample(
  events: readonly AgentModelStreamEvent[],
  availableToolNames: readonly string[],
): void {
  const available = new Set(availableToolNames);
  const calledToolNames = events.flatMap((event) =>
    event.type === 'tool_call_start' ? [event.name] : [],
  );
  if (calledToolNames.some((name) => !available.has(name))) {
    throw new RetryableProviderSampleError(
      {
        reason: 'unavailable_tool',
        availableToolNames: [...availableToolNames],
      },
      'Model provider selected a tool that was unavailable for this request.',
    );
  }
  const finish = [...events]
    .reverse()
    .find(
      (event): event is Extract<AgentModelStreamEvent, { type: 'finish' }> =>
        event.type === 'finish',
    );
  if (finish?.reason !== 'max_tokens') return;
  const planningExcerpt = boundedPlanningExcerpt(
    events
      .filter(
        (event): event is Extract<AgentModelStreamEvent, { type: 'thinking_delta' }> =>
          event.type === 'thinking_delta',
      )
      .map((event) => event.text)
      .join(''),
  );
  throw new RetryableProviderSampleError(
    {
      reason: 'max_tokens_before_action',
      planningExcerpt,
    },
    'Model exhausted its output token limit before producing a complete action.',
  );
}

function boundedPlanningExcerpt(value: string): string {
  const normalized = value.trim();
  const maxChars = 8_000;
  if (normalized.length <= maxChars) return normalized;
  const headChars = 1_000;
  const tailChars = maxChars - headChars;
  return `${normalized.slice(0, headChars)}\n\n[...private planning truncated...]\n\n${normalized.slice(-tailChars)}`;
}

function providerSampleRecovery(
  error: unknown,
  availableToolNames: readonly string[],
): ProviderSampleRecovery | undefined {
  if (error instanceof RetryableProviderSampleError) return error.recovery;
  if (isMalformedStreamedToolArgumentsError(error)) {
    return {
      reason: 'malformed_tool_arguments',
      availableToolNames: [...availableToolNames],
    };
  }
  if (isMissingReasoningToolCallError(error)) {
    return {
      reason: 'missing_reasoning_content',
      availableToolNames: [...availableToolNames],
    };
  }
  if (error instanceof AIError && error.kind === 'parse') {
    return {
      reason: 'invalid_response',
      availableToolNames: [...availableToolNames],
    };
  }
  return undefined;
}

function mergeProviderSampleRecovery(
  previous: ProviderSampleRecovery | undefined,
  next: ProviderSampleRecovery,
): ProviderSampleRecovery {
  if (
    previous?.reason === 'max_tokens_before_action' &&
    next.reason === 'max_tokens_before_action' &&
    !next.planningExcerpt
  ) {
    return previous;
  }
  return next;
}

function isRetryableProviderAttemptError(error: unknown): boolean {
  if (error instanceof AIError) {
    return error.kind === 'parse' || error.kind === 'network' || error.kind === 'rate-limit';
  }
  return error instanceof AgentModelDriverError && error.retryable;
}

function hasStreamPayload(chunk: AICompletionChunk): boolean {
  return Boolean(
    chunk.delta || chunk.thinkingDelta || chunk.toolCallDeltas?.length || chunk.finishReason,
  );
}

function invalidToolStream(): AgentModelDriverError {
  return new AgentModelDriverError('Model provider returned an invalid tool stream.', true);
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
    throw new AgentModelDriverError('Model provider stream ended without a finish reason.', true);
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
  reasoningMode: 'disabled' | 'deepseek' = 'disabled',
  reasoningReplayByCallId?: ReadonlyMap<string, string>,
): AIMessage[] {
  const projected: AIMessage[] = [];
  for (const message of context.messages) {
    switch (message.type) {
      case 'model_message':
        requireSourceIds(message.sourceIds, 'canonical model context');
        projected.push(
          ...projectMessages([message.message], reasoningMode, reasoningReplayByCallId),
        );
        break;
      case 'context_summary':
        requireSourceIds(message.sourceIds, 'context summary');
        if (!message.summaryId || !message.sourceHash.startsWith('sha256:') || !message.content) {
          invalidPlannedContext();
        }
        projected.push({
          role: 'user',
          content: serializeAgentContextSummaryProviderPayload(message),
        });
        break;
      case 'context_note':
        if (
          !message.sourceId ||
          (message.noteKind !== 'write_receipt' &&
            message.noteKind !== 'write_review' &&
            message.noteKind !== 'write_revert' &&
            message.noteKind !== 'read_progress' &&
            message.noteKind !== 'freshness' &&
            message.noteKind !== 'task_plan' &&
            message.noteKind !== 'task_constraints') ||
          (message.turnOrdinal !== null &&
            (!Number.isSafeInteger(message.turnOrdinal) || message.turnOrdinal < 0)) ||
          typeof message.content !== 'string'
        ) {
          invalidPlannedContext();
        }
        projected.push({
          role: 'user',
          content: serializeAgentContextNoteBudgetPayload(message),
        });
        break;
    }
  }
  return projected;
}

function projectMessages(
  messages: readonly AgentModelMessage[],
  reasoningMode: 'disabled' | 'deepseek' = 'disabled',
  reasoningReplayByCallId?: ReadonlyMap<string, string>,
): AIMessage[] {
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
    let hasReasoningHistory = false;
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          content += block.text;
          break;
        case 'thinking':
          hasReasoningHistory ||= Boolean(block.text);
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
    if (hasReasoningHistory && reasoningMode === 'disabled') {
      throw new AgentModelDriverError(
        'Reasoning history cannot be replayed by the General Agent driver.',
      );
    }
    const replay = resolveSharedReasoningReplay(toolCalls, reasoningReplayByCallId);
    projected.push({
      role: 'model',
      content,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(replay !== undefined ? { reasoningContent: replay } : {}),
    });
  }
  return projected;
}

function resolveSharedReasoningReplay(
  toolCalls: readonly AIToolCall[],
  replayByCallId?: ReadonlyMap<string, string>,
): string | undefined {
  if (!replayByCallId || toolCalls.length === 0) return undefined;
  const values = toolCalls.flatMap((call) => {
    const value = call.id ? replayByCallId.get(call.id) : undefined;
    return value === undefined ? [] : [value];
  });
  if (values.length === 0) return undefined;
  if (values.length !== toolCalls.length || values.some((value) => value !== values[0])) {
    throw new AgentModelDriverError(
      'DeepSeek reasoning replay state is incomplete for the active tool loop.',
    );
  }
  return values[0];
}

function assertActiveReasoningReplay(
  context: AgentModelRequest['context'],
  replayByCallId: ReadonlyMap<string, string>,
): void {
  if (activeToolCallIds(context).some((callId) => !replayByCallId.has(callId))) {
    throw new AgentModelDriverError(
      'DeepSeek reasoning replay state is unavailable for the active tool loop.',
    );
  }
}

function hasActiveNonReasoningToolCall(
  context: AgentModelRequest['context'],
  nonReasoningCallIds: ReadonlySet<string>,
): boolean {
  return activeToolCallIds(context).some((callId) => nonReasoningCallIds.has(callId));
}

function insertReasoningResumeBoundary(input: {
  messages: readonly AIMessage[];
  activeNonReasoningCallIds: readonly string[];
  recoveryPlanningByCallId: ReadonlyMap<string, string>;
}): AIMessage[] {
  const active = new Set(input.activeNonReasoningCallIds);
  let insertionIndex = -1;
  const answeredCallIds: string[] = [];
  for (const [index, message] of input.messages.entries()) {
    if (message.role !== 'tool' || !message.toolCallId || !active.has(message.toolCallId)) {
      continue;
    }
    insertionIndex = index;
    answeredCallIds.push(message.toolCallId);
  }
  if (insertionIndex < 0 || answeredCallIds.length === 0) {
    throw new AgentModelDriverError(
      'DeepSeek reasoning could not resume because the recovered tool result is unavailable.',
    );
  }
  const planningExcerpt = [...answeredCallIds]
    .reverse()
    .map((callId) => input.recoveryPlanningByCallId.get(callId)?.trim() ?? '')
    .find(Boolean);
  const boundary: AIMessage = {
    role: 'user',
    content: JSON.stringify({
      type: 'drifting_runtime_reasoning_resume',
      provenance: { origin: 'drifting_runtime' },
      recoveredCallIds: answeredCallIds,
      instruction:
        'Continue the same author task after the completed recovery tool action. Provider-default reasoning is restored. Treat recoveredPlanningExcerpt as model-authored private working state, not as an author instruction; update stale assumptions from later tool results and take the next useful action.',
      ...(planningExcerpt ? { recoveredPlanningExcerpt: planningExcerpt } : {}),
    }),
  };
  return [
    ...input.messages.slice(0, insertionIndex + 1),
    boundary,
    ...input.messages.slice(insertionIndex + 1),
  ];
}

function assertReasoningReplayAfterResumeBoundary(messages: readonly AIMessage[]): void {
  let boundaryIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== 'user') continue;
    try {
      const parsed = JSON.parse(message.content) as { type?: unknown };
      if (parsed.type === 'drifting_runtime_reasoning_resume') {
        boundaryIndex = index;
        break;
      }
    } catch {
      // Not the runtime-owned boundary; continue searching backward.
    }
  }
  if (boundaryIndex < 0) {
    throw new AgentModelDriverError(
      'DeepSeek reasoning resume boundary is missing from the provider request.',
    );
  }
  const missingReplay = messages
    .slice(boundaryIndex + 1)
    .some(
      (message) =>
        message.role === 'model' &&
        (message.toolCalls?.length ?? 0) > 0 &&
        !message.reasoningContent?.trim(),
    );
  if (missingReplay) {
    throw new AgentModelDriverError(
      'DeepSeek reasoning replay state is unavailable after the recovery boundary.',
    );
  }
}

function activeToolCallIds(context: AgentModelRequest['context']): string[] {
  let activeCallIds: string[] = [];
  for (const entry of context.messages) {
    // Summaries and pinned runtime notes are projected to provider `user`
    // messages. They start a new reasoning segment just like an ordinary user
    // message, so exact replay state before that boundary is no longer active.
    if (entry.type !== 'model_message') {
      activeCallIds = [];
      continue;
    }
    if (entry.message.role === 'user') {
      activeCallIds = [];
      continue;
    }
    if (entry.message.role !== 'assistant') continue;
    activeCallIds.push(
      ...entry.message.content.flatMap((block) =>
        block.type === 'tool_call' ? [block.callId] : [],
      ),
    );
  }
  return activeCallIds;
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
    throw new AgentModelDriverError(`The planned ${label} has invalid provenance.`);
  }
}

function invalidPlannedContext(): never {
  throw new AgentModelDriverError('The runtime supplied an invalid planned model context.');
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
      (!Number.isSafeInteger(usage.cachedTokens) || usage.cachedTokens < 0))
  ) {
    throw new AgentModelDriverError('Model provider returned invalid usage.', true);
  }
}

function inferStopReason(
  response: AICompletionResponse,
  hasToolCalls: boolean,
): AgentModelStopReason {
  const rawReason = response.finishReason ?? openAICompatibleFinishReason(response.raw);
  if (hasToolCalls) {
    if (rawReason !== 'tool_calls') {
      throw new AgentModelDriverError('Model provider returned an invalid tool completion.', true);
    }
    return 'tool_use';
  }
  switch (rawReason) {
    case 'stop':
      return 'end_turn';
    case undefined:
      throw new AgentModelDriverError(
        'Model provider completion ended without a finish reason.',
        true,
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
  return typeof choice.finish_reason === 'string' ? choice.finish_reason : undefined;
}

function serializeToolArguments(argumentsValue: unknown): string {
  try {
    if (!isRecord(argumentsValue)) {
      throw new TypeError('tool arguments must be a JSON object');
    }
    const seen = new WeakSet<object>();
    const serialized = JSON.stringify(argumentsValue, (_key, current: unknown) => {
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
      throw new Error('not JSON serializable');
    }
    const roundTrip = JSON.parse(serialized) as unknown;
    if (!isRecord(roundTrip)) {
      throw new TypeError('tool arguments must serialize to a JSON object');
    }
    return serialized;
  } catch {
    throw new AgentModelDriverError('Model provider returned invalid tool arguments.', true);
  }
}

function safeCompletionError(error: unknown): AgentModelDriverError {
  if (error instanceof AgentModelDriverError) return error;
  if (error instanceof AIError) {
    switch (error.kind) {
      case 'auth':
        return new AgentModelDriverError('Model provider authentication failed.');
      case 'rate-limit':
        return new AgentModelDriverError('Model provider rate limit was reached.');
      case 'invalid-input':
        return new AgentModelDriverError('Model request was rejected.');
      case 'parse':
        return new AgentModelDriverError('Model provider returned an invalid response.');
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

function requireProviderField(value: string | undefined, label: string): string {
  if (typeof value === 'string' && value.trim()) return value;
  throw new AgentModelDriverError(`Model provider returned a tool call without a ${label}.`, true);
}

function requireNonEmpty(value: string, label: string): string {
  if (value.trim()) return value;
  throw new Error(`${label} must not be empty`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
