import type { RetryConfig } from '../../../ai/client/retry';
import { AgentModelDriverError } from '../errors';
import {
  serializeAgentContextNoteBudgetPayload,
  serializeAgentContextSummaryProviderPayload,
} from '../context-planner';
import {
  DEFAULT_PROVIDER_ATTEMPT_RETRY,
  retryAfterMsFromHeader,
  streamProviderAttemptWithRetry,
} from './provider-attempt-retry';
import type {
  AgentModelDriver,
  AgentModelMessage,
  AgentModelRequest,
  AgentModelStopReason,
  AgentModelStreamEvent,
  AgentRuntimeUsage,
  AgentToolResultBlock,
} from '../types';
import {
  resolveAgentProviderContextProfile,
  resolveAgentProviderReasoningProfile,
} from '../agent-provider-contract';

type FetchLike = typeof fetch;
type ResponsesItem = Record<string, unknown>;

export interface OpenAIResponsesAgentDriverOptions {
  apiKey?: string;
  defaultModel?: string;
  endpoint?: string;
  fetch?: FetchLike;
  transport?: OpenAIResponsesTransport;
  /** Bounded pre-effect retry lease shared with every Agent driver. */
  providerAttemptRetry?: RetryConfig;
}

export interface OpenAIResponsesTransport {
  request(body: string, signal: AbortSignal): Promise<Response>;
}

interface OpenAIFunctionCallState {
  itemId: string;
  callId: string;
  name: string;
  arguments: string;
  ended: boolean;
}

/** Native Responses API adapter for GPT-5.6 reasoning plus Agent tools. */
export class OpenAIResponsesAgentDriver implements AgentModelDriver {
  readonly id = 'openai-responses-stream';
  readonly capabilities = {
    reasoning: true,
    context: resolveAgentProviderContextProfile('openai', 'gpt-5.6-sol'),
  } as const;

  private readonly apiKey: string | null;
  private readonly defaultModel: string;
  private readonly endpoint: string;
  private readonly fetchImpl: FetchLike;
  private readonly transport?: OpenAIResponsesTransport;
  private readonly providerAttemptRetry: RetryConfig;
  private readonly replayByCallId = new Map<string, readonly ResponsesItem[]>();
  private readonly nonReasoningCallIds = new Set<string>();

  constructor(options: OpenAIResponsesAgentDriverOptions) {
    const apiKey = options.apiKey?.trim() ?? '';
    if (!apiKey && !options.transport) throw new Error('OpenAI API key is empty');
    this.apiKey = apiKey || null;
    this.defaultModel = options.defaultModel ?? 'gpt-5.6-sol';
    this.endpoint = options.endpoint ?? 'https://api.openai.com/v1/responses';
    this.fetchImpl = options.fetch ?? fetch;
    this.transport = options.transport;
    this.providerAttemptRetry = options.providerAttemptRetry ?? DEFAULT_PROVIDER_ATTEMPT_RETRY;
  }

  async *stream(request: AgentModelRequest): AsyncIterable<AgentModelStreamEvent> {
    if (request.tools.length === 0) {
      // Tool-free synthesis keeps true progressive text streaming. Once
      // visible output escapes, automatically replaying it would duplicate
      // author-facing prose, so this path intentionally has no retry lease.
      yield* this.streamAttempt(request);
      return;
    }
    // A tool-capable provider attempt is transactional: the complete stream is
    // buffered and validated before any Agent event is published, so transient
    // transport failures, rate limits, and invalid samples are safely
    // resampleable — no tool call, usage, or UI activity has escaped yet.
    const events = await streamProviderAttemptWithRetry(
      () => this.streamAttempt(request),
      this.providerAttemptRetry,
      request.signal,
    );
    for (const event of events) yield event;
  }

  private async *streamAttempt(
    request: AgentModelRequest,
  ): AsyncIterable<AgentModelStreamEvent> {
    if (request.signal.aborted) throw abortError();
    const model = request.model || this.defaultModel;
    const reasoningProfile = resolveAgentProviderReasoningProfile('openai', model);
    const configuredReasoningEnabled = request.reasoning?.enabled === true;
    const reasoningEnabled =
      configuredReasoningEnabled &&
      request.executionMode !== 'required_tool_non_reasoning';
    if (reasoningEnabled && request.iteration > 1) {
      assertActiveResponsesReplay(
        request.context,
        this.replayByCallId,
        this.nonReasoningCallIds,
      );
    }
    const effort = reasoningEnabled
      ? reasoningProfile.efforts.includes(
          request.reasoning?.effort ?? reasoningProfile.defaultEffort,
        )
        ? request.reasoning?.effort ?? reasoningProfile.defaultEffort
        : reasoningProfile.defaultEffort
      : 'none';

    const input = projectResponsesInput(
      request.context,
      configuredReasoningEnabled ? this.replayByCallId : EMPTY_RESPONSES_REPLAY,
    );
    assertResponsesToolClosure(input);
    const body = JSON.stringify({
      model,
      instructions: requirePlannedSystem(request.context.systemPrompt),
      input,
      max_output_tokens: request.maxOutputTokens,
      stream: true,
      store: false,
      reasoning: {
        effort,
        ...(reasoningEnabled ? { summary: 'auto', context: 'current_turn' } : {}),
      },
      ...(reasoningEnabled ? { include: ['reasoning.encrypted_content'] } : {}),
      ...(request.tools.length > 0
        ? {
            tools: request.tools.map((tool) => ({
              type: 'function',
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            })),
            tool_choice: openAIToolChoice(request.toolChoice),
          }
        : {}),
    });

    let response: Response;
    try {
      response = this.transport
        ? await this.transport.request(body, request.signal)
        : await this.fetchImpl(this.endpoint, {
            method: 'POST',
            redirect: 'error',
            headers: {
              authorization: `Bearer ${this.apiKey!}`,
              'content-type': 'application/json',
            },
            body,
            signal: request.signal,
          });
    } catch (error) {
      if (request.signal.aborted) throw abortError();
      throw requestStartError(error);
    }
    if (!response.ok) throw responseError(response);

    const callsByItemId = new Map<string, OpenAIFunctionCallState>();
    const callIds = new Set<string>();
    let terminalSeen = false;

    for await (const event of parseSseJson(response, request.signal)) {
      if (terminalSeen) throw invalidStream();
      const type = stringField(event, 'type');
      if (type === 'error' || type === 'response.failed') {
        // Mid-stream provider failures surface here; under the buffered
        // tool-attempt lease a fresh sample is safe.
        throw new AgentModelDriverError('OpenAI response stream returned an error.', true);
      }
      if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
        const delta = typeof event.delta === 'string' ? event.delta : '';
        if (delta) yield { type: 'text_delta', text: delta };
        continue;
      }
      if (type === 'response.reasoning_summary_text.delta') {
        const delta = typeof event.delta === 'string' ? event.delta : '';
        if (delta) yield { type: 'thinking_delta', text: delta };
        continue;
      }
      if (type === 'response.output_item.added') {
        const item = recordField(event, 'item');
        if (item.type !== 'function_call') continue;
        const itemId = nonBlankString(item.id, 'function item id');
        const callId = nonBlankString(item.call_id, 'tool call id');
        const name = nonBlankString(item.name, 'tool name');
        if (callsByItemId.has(itemId) || callIds.has(callId)) throw invalidStream();
        const state: OpenAIFunctionCallState = {
          itemId,
          callId,
          name,
          arguments: typeof item.arguments === 'string' ? item.arguments : '',
          ended: false,
        };
        callsByItemId.set(itemId, state);
        callIds.add(callId);
        yield { type: 'tool_call_start', callId, name };
        if (state.arguments) {
          yield {
            type: 'tool_args_delta',
            callId,
            delta: state.arguments,
          };
        }
        continue;
      }
      if (type === 'response.function_call_arguments.delta') {
        const state = callsByItemId.get(nonBlankString(event.item_id, 'function item id'));
        if (!state || state.ended) throw invalidStream();
        const delta = typeof event.delta === 'string' ? event.delta : '';
        state.arguments += delta;
        if (delta) yield { type: 'tool_args_delta', callId: state.callId, delta };
        continue;
      }
      if (type === 'response.output_item.done') {
        const item = recordField(event, 'item');
        if (item.type !== 'function_call') continue;
        const state = callsByItemId.get(nonBlankString(item.id, 'function item id'));
        if (!state || state.ended) throw invalidStream();
        const completeArguments =
          typeof item.arguments === 'string' ? item.arguments : state.arguments;
        if (!state.arguments && completeArguments) {
          state.arguments = completeArguments;
          yield {
            type: 'tool_args_delta',
            callId: state.callId,
            delta: completeArguments,
          };
        } else if (completeArguments !== state.arguments) {
          throw invalidStream();
        }
        state.ended = true;
        yield { type: 'tool_call_end', callId: state.callId };
        continue;
      }
      if (type === 'response.completed' || type === 'response.incomplete') {
        if (terminalSeen) throw invalidStream();
        terminalSeen = true;
        const completed = recordField(event, 'response');
        const output = arrayOfRecords(completed.output, 'response output');
        finishOpenFunctionCalls(callsByItemId, output);
        const replay = output.map((item) => structuredClone(item));
        if (reasoningEnabled) {
          for (const callId of responseFunctionCallIds(output)) {
            this.nonReasoningCallIds.delete(callId);
            this.replayByCallId.set(callId, replay);
          }
        } else {
          for (const callId of responseFunctionCallIds(output)) {
            this.replayByCallId.delete(callId);
            this.nonReasoningCallIds.add(callId);
          }
        }
        for (const state of callsByItemId.values()) {
          if (!state.ended) {
            state.ended = true;
            yield { type: 'tool_call_end', callId: state.callId };
          }
        }
        yield { type: 'usage', usage: normalizeResponsesUsage(completed.usage) };
        yield {
          type: 'finish',
          reason: normalizeResponsesStopReason(type, completed, callIds.size > 0),
        };
        continue;
      }
      // Lifecycle and content-part events carry no additional authority.
    }
    if (!terminalSeen) throw invalidStream();
  }
}

function openAIToolChoice(
  choice: AgentModelRequest['toolChoice'],
): 'auto' | 'required' | { type: 'function'; name: string } {
  if (choice === 'required') return 'required';
  if (choice && typeof choice === 'object') {
    return { type: 'function', name: choice.force };
  }
  return 'auto';
}

const EMPTY_RESPONSES_REPLAY: ReadonlyMap<
  string,
  readonly ResponsesItem[]
> = new Map();

function projectResponsesInput(
  context: AgentModelRequest['context'],
  replayByCallId: ReadonlyMap<string, readonly ResponsesItem[]>,
): ResponsesItem[] {
  const projected: ResponsesItem[] = [];
  for (const entry of context.messages) {
    if (entry.type === 'model_message') {
      requireSourceIds(entry.sourceIds, 'canonical model context');
      projected.push(...projectCanonicalMessage(entry.message, replayByCallId));
    } else if (entry.type === 'context_summary') {
      requireSourceIds(entry.sourceIds, 'context summary');
      if (!entry.summaryId || !entry.sourceHash.startsWith('sha256:') || !entry.content) {
        invalidPlannedContext();
      }
      projected.push({
        role: 'user',
        content: serializeAgentContextSummaryProviderPayload(entry),
      });
    } else {
      if (
        !entry.sourceId ||
        (entry.noteKind !== 'write_receipt' &&
          entry.noteKind !== 'write_review' &&
          entry.noteKind !== 'write_revert' &&
          entry.noteKind !== 'read_progress' &&
          entry.noteKind !== 'freshness' &&
          entry.noteKind !== 'task_plan' &&
          entry.noteKind !== 'task_constraints') ||
        (entry.turnOrdinal !== null &&
          (!Number.isSafeInteger(entry.turnOrdinal) || entry.turnOrdinal < 0)) ||
        typeof entry.content !== 'string'
      ) {
        invalidPlannedContext();
      }
      projected.push({
        role: 'user',
        content: serializeAgentContextNoteBudgetPayload(entry),
      });
    }
  }
  return projected;
}

function projectCanonicalMessage(
  message: AgentModelMessage,
  replayByCallId: ReadonlyMap<string, readonly ResponsesItem[]>,
): ResponsesItem[] {
  if (message.role === 'user') return [{ role: 'user', content: message.content }];
  if (message.role === 'tool') {
    return message.content.map((result) => ({
      type: 'function_call_output',
      call_id: result.callId,
      output: projectToolResult(result),
    }));
  }

  const toolCalls = message.content.flatMap((block) =>
    block.type === 'tool_call' ? [block] : [],
  );
  const replay = resolveSharedResponsesReplay(
    toolCalls.map((call) => call.callId),
    replayByCallId,
  );
  if (replay) return replay.map((item) => structuredClone(item));

  const projected: ResponsesItem[] = [];
  const text = message.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('');
  if (text) projected.push({ role: 'assistant', content: text });
  for (const call of toolCalls) {
    projected.push({
      type: 'function_call',
      call_id: call.callId,
      name: call.name,
      arguments: call.rawArguments || JSON.stringify(call.arguments),
    });
  }
  return projected;
}

function resolveSharedResponsesReplay(
  callIds: readonly string[],
  replayByCallId: ReadonlyMap<string, readonly ResponsesItem[]>,
): readonly ResponsesItem[] | undefined {
  if (callIds.length === 0) return undefined;
  const values = callIds.flatMap((callId) => {
    const value = replayByCallId.get(callId);
    return value === undefined ? [] : [value];
  });
  if (values.length === 0) return undefined;
  if (values.length !== callIds.length || values.some((value) => value !== values[0])) {
    throw new AgentModelDriverError(
      'OpenAI reasoning replay state is incomplete for the active tool loop.',
    );
  }
  const replayCallIds = responseFunctionCallIds(values[0]!);
  if (
    replayCallIds.length !== callIds.length ||
    replayCallIds.some((callId, index) => callId !== callIds[index])
  ) {
    throw new AgentModelDriverError(
      'OpenAI reasoning replay cannot partially retain a parallel tool batch.',
    );
  }
  return values[0];
}

function assertResponsesToolClosure(input: readonly ResponsesItem[]): void {
  const pending = new Set<string>();
  for (const item of input) {
    if (item.type === 'function_call') {
      const callId = nonBlankString(item.call_id, 'tool call id');
      if (pending.has(callId)) {
        throw new AgentModelDriverError('OpenAI tool replay contains a duplicate call id.');
      }
      pending.add(callId);
      continue;
    }
    if (item.type !== 'function_call_output') continue;
    const callId = nonBlankString(item.call_id, 'tool call id');
    if (!pending.delete(callId)) {
      throw new AgentModelDriverError(
        'OpenAI tool replay contains an output without its function call.',
      );
    }
  }
  if (pending.size > 0) {
    throw new AgentModelDriverError(
      'OpenAI tool replay is missing a function call output.',
    );
  }
}

function assertActiveResponsesReplay(
  context: AgentModelRequest['context'],
  replayByCallId: ReadonlyMap<string, readonly ResponsesItem[]>,
  nonReasoningCallIds: ReadonlySet<string>,
): void {
  let activeCallIds: string[] = [];
  for (const entry of context.messages) {
    if (entry.type !== 'model_message') continue;
    if (entry.message.role === 'user') {
      activeCallIds = [];
      continue;
    }
    if (entry.message.role !== 'assistant') continue;
    const callIds = entry.message.content.flatMap((block) =>
      block.type === 'tool_call' ? [block.callId] : [],
    );
    if (callIds.length > 0) activeCallIds = callIds;
  }
  // Same-turn author steering is projected as a trailing user message and
  // deliberately starts a new reasoning segment. With no active calls there
  // is nothing to require; retained calls must still fail closed when their
  // exact provider replay state is missing.
  if (
    activeCallIds.some(
      (callId) =>
        !replayByCallId.has(callId) && !nonReasoningCallIds.has(callId),
    )
  ) {
    throw new AgentModelDriverError(
      'OpenAI reasoning replay state is unavailable for the active tool loop.',
    );
  }
}

function finishOpenFunctionCalls(
  callsByItemId: ReadonlyMap<string, OpenAIFunctionCallState>,
  output: readonly ResponsesItem[],
): void {
  const seen = new Set<string>();
  for (const item of output) {
    if (item.type !== 'function_call') continue;
    const itemId = nonBlankString(item.id, 'function item id');
    const state = callsByItemId.get(itemId);
    if (!state || state.callId !== item.call_id || state.name !== item.name) {
      throw invalidStream();
    }
    seen.add(itemId);
    if (typeof item.arguments !== 'string' || item.arguments !== state.arguments) {
      if (state.arguments || typeof item.arguments !== 'string') throw invalidStream();
      state.arguments = item.arguments;
    }
  }
  if (seen.size !== callsByItemId.size) throw invalidStream();
}

function responseFunctionCallIds(output: readonly ResponsesItem[]): string[] {
  return output.flatMap((item) =>
    item.type === 'function_call'
      ? [nonBlankString(item.call_id, 'tool call id')]
      : [],
  );
}

function normalizeResponsesUsage(value: unknown): AgentRuntimeUsage {
  const usage = recordValue(value, 'response usage');
  const inputTokens = nonNegativeInteger(usage.input_tokens, 'input tokens');
  const outputTokens = nonNegativeInteger(usage.output_tokens, 'output tokens');
  const inputDetails = optionalRecord(usage.input_tokens_details);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: optionalNonNegativeInteger(inputDetails?.cached_tokens),
    cacheWriteTokens: 0,
    costUsd: 0,
  };
}

function normalizeResponsesStopReason(
  eventType: string,
  response: ResponsesItem,
  hasToolCalls: boolean,
): AgentModelStopReason {
  if (hasToolCalls) return 'tool_use';
  if (eventType === 'response.completed') return 'end_turn';
  const details = optionalRecord(response.incomplete_details);
  switch (details?.reason) {
    case 'max_output_tokens':
      return 'max_tokens';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'unknown';
  }
}

async function* parseSseJson(
  response: Response,
  signal: AbortSignal,
): AsyncIterable<ResponsesItem> {
  if (!response.body) throw new AgentModelDriverError('OpenAI stream has no body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let totalBytes = 0;
  try {
    while (true) {
      if (signal.aborted) throw abortError();
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (error) {
        if (signal.aborted) throw abortError();
        throw responseStreamError(error);
      }
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > 32 * 1024 * 1024) {
        throw new AgentModelDriverError('OpenAI stream exceeded the response limit.');
      }
      buffer += decoder.decode(next.value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data && data !== '[DONE]') {
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            throw invalidStream();
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw invalidStream();
          }
          yield parsed as ResponsesItem;
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (buffer.trim()) throw invalidStream();
}

function requirePlannedSystem(value: string): string {
  if (!value.trim()) invalidPlannedContext();
  return value;
}

function requireSourceIds(sourceIds: readonly string[], label: string): void {
  if (
    sourceIds.length === 0 ||
    new Set(sourceIds).size !== sourceIds.length ||
    sourceIds.some((sourceId) => !sourceId)
  ) {
    throw new AgentModelDriverError(`The planned ${label} has invalid provenance.`);
  }
}

function projectToolResult(result: AgentToolResultBlock): string {
  return result.ok ? result.content : `Tool failed: ${result.content}`;
}

function arrayOfRecords(value: unknown, label: string): ResponsesItem[] {
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== 'object')) {
    throw new AgentModelDriverError(`OpenAI returned invalid ${label}.`);
  }
  return value as ResponsesItem[];
}

function recordField(value: ResponsesItem, key: string): ResponsesItem {
  return recordValue(value[key], key);
}

function recordValue(value: unknown, label: string): ResponsesItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentModelDriverError(`OpenAI returned invalid ${label}.`);
  }
  return value as ResponsesItem;
}

function optionalRecord(value: unknown): ResponsesItem | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as ResponsesItem)
    : undefined;
}

function stringField(value: ResponsesItem, key: string): string {
  if (typeof value[key] !== 'string') throw invalidStream();
  return value[key];
}

function nonBlankString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentModelDriverError(`OpenAI returned an invalid ${label}.`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new AgentModelDriverError(`OpenAI returned invalid ${label}.`);
  }
  return value as number;
}

function optionalNonNegativeInteger(value: unknown): number {
  return value === undefined ? 0 : nonNegativeInteger(value, 'cached tokens');
}

function responseError(response: Response): AgentModelDriverError {
  const status = response.status;
  const errorCode = response.headers.get('x-drifting-openai-error-code');
  const requestId = response.headers.get('x-request-id');
  const suffix =
    requestId && /^[A-Za-z0-9_.:-]{1,200}$/.test(requestId)
      ? ` Request ID: ${requestId}.`
      : '';
  if (errorCode === 'quota_exhausted') {
    return new AgentModelDriverError(`OpenAI quota or billing access is unavailable.${suffix}`);
  }
  if (errorCode === 'model_unavailable' || status === 404) {
    return new AgentModelDriverError(
      `The selected OpenAI model is unavailable to this API key.${suffix}`,
    );
  }
  if (status === 401 || status === 403) {
    return new AgentModelDriverError(`OpenAI authentication or project access failed.${suffix}`);
  }
  if (status === 429) {
    return new AgentModelDriverError(`OpenAI rate limit reached.${suffix}`, true, {
      retryAfterMs: retryAfterMsFromHeader(response.headers.get('retry-after')),
    });
  }
  if (status >= 500) {
    return new AgentModelDriverError(
      `OpenAI service is temporarily unavailable (HTTP ${status}).${suffix}`,
      true,
    );
  }
  return new AgentModelDriverError(`OpenAI request failed with HTTP ${status}.${suffix}`);
}

function requestStartError(error: unknown): AgentModelDriverError {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('OPENAI_CREDENTIAL_MISSING')) {
    return new AgentModelDriverError('OpenAI API key is not configured in Keychain.');
  }
  if (message.includes('OPENAI_CREDENTIAL_UNAVAILABLE')) {
    return new AgentModelDriverError(
      'OpenAI API key could not be read from Keychain. Check the macOS access prompt.',
    );
  }
  if (message.includes('OPENAI_NETWORK_TIMEOUT')) {
    return new AgentModelDriverError('OpenAI request timed out in the native runtime.', true);
  }
  if (message.includes('OPENAI_NETWORK_FAILED')) {
    return new AgentModelDriverError(
      'OpenAI could not be reached from the native runtime. Check the network or proxy.',
      true,
    );
  }
  if (message.includes('OPENAI_REQUEST_CANCELLED')) return abortError();
  if (message.includes('OPENAI_STREAM_TOO_LARGE')) {
    return new AgentModelDriverError('OpenAI stream exceeded the response limit.');
  }
  if (message.includes('OPENAI_STREAM_FAILED')) {
    return new AgentModelDriverError('OpenAI response stream was interrupted.', true);
  }
  return new AgentModelDriverError('OpenAI request could not be started.');
}

function responseStreamError(error: unknown): AgentModelDriverError {
  const projected = requestStartError(error);
  if (projected.publicMessage !== 'OpenAI request could not be started.') return projected;
  return new AgentModelDriverError('OpenAI response stream was interrupted.', true);
}

function invalidPlannedContext(): never {
  throw new AgentModelDriverError(
    'The runtime supplied an invalid planned model context.',
  );
}

function invalidStream(): AgentModelDriverError {
  // Invalid samples are retryable under the buffered tool-attempt lease,
  // matching the OpenAI-compatible driver's parse-retry policy.
  return new AgentModelDriverError('OpenAI returned an invalid Responses stream.', true);
}

function abortError(): AgentModelDriverError {
  return new AgentModelDriverError('OpenAI request was cancelled.');
}
