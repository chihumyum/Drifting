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
} from '../types';
import {
  resolveAgentProviderContextProfile,
  resolveAgentProviderReasoningProfile,
} from '../agent-provider-contract';

type FetchLike = typeof fetch;

export interface AnthropicMessagesAgentDriverOptions {
  apiKey: string;
  defaultModel?: string;
  endpoint?: string;
  fetch?: FetchLike;
}

interface AnthropicBlockState {
  type: 'text' | 'thinking' | 'redacted_thinking' | 'tool_use';
  callId?: string;
  thinking?: string;
  signature?: string;
  data?: string;
}

type AnthropicReasoningReplayBlock =
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string };

/** Native Anthropic Messages adapter; no Claude Agent SDK or Node host needed. */
export class AnthropicMessagesAgentDriver implements AgentModelDriver {
  readonly id = 'anthropic-messages-stream';
  readonly capabilities = {
    reasoning: true,
    context: resolveAgentProviderContextProfile('anthropic', 'claude-sonnet-5'),
  } as const;

  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly endpoint: string;
  private readonly fetchImpl: FetchLike;
  private readonly reasoningReplayByCallId = new Map<
    string,
    readonly AnthropicReasoningReplayBlock[]
  >();
  private readonly nonReasoningCallIds = new Set<string>();

  constructor(options: AnthropicMessagesAgentDriverOptions) {
    if (!options.apiKey.trim()) throw new Error('Anthropic API key is empty');
    this.apiKey = options.apiKey;
    this.defaultModel = options.defaultModel ?? 'claude-sonnet-5';
    this.endpoint = options.endpoint ?? 'https://api.anthropic.com/v1/messages';
    this.fetchImpl = options.fetch ?? fetch;
  }

  async *stream(request: AgentModelRequest): AsyncIterable<AgentModelStreamEvent> {
    if (request.signal.aborted) throw abortError();
    const model = request.model || this.defaultModel;
    const reasoningProfile = resolveAgentProviderReasoningProfile(
      'anthropic',
      model,
    );
    const configuredReasoningEnabled = request.reasoning?.enabled === true;
    const reasoningEnabled =
      configuredReasoningEnabled &&
      request.executionMode !== 'required_tool_non_reasoning';
    if (
      reasoningEnabled &&
      !reasoningProfile.thinkingModes.includes('adaptive')
    ) {
      throw new AgentModelDriverError(
        'The selected Anthropic model does not support certified thinking.',
      );
    }
    if (reasoningEnabled && request.iteration > 1) {
      assertActiveAnthropicReplay(
        request.context,
        this.reasoningReplayByCallId,
        this.nonReasoningCallIds,
      );
    }
    const effort = reasoningProfile.efforts.includes(
      request.reasoning?.effort ?? reasoningProfile.defaultEffort,
    )
      ? request.reasoning?.effort ?? reasoningProfile.defaultEffort
      : reasoningProfile.defaultEffort;
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model,
          max_tokens: request.maxOutputTokens,
          stream: true,
          system: request.context.systemPrompt,
          messages: projectAnthropicMessages(
            request.context.messages,
            configuredReasoningEnabled ? this.reasoningReplayByCallId : undefined,
          ),
          ...(reasoningEnabled
            ? { thinking: { type: 'adaptive', display: 'summarized' } }
            : {}),
          ...(reasoningProfile.efforts.length > 0 &&
          request.executionMode !== 'required_tool_non_reasoning'
            ? { output_config: { effort } }
            : {}),
          ...(request.tools.length
            ? {
                tools: request.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  input_schema: tool.inputSchema,
                })),
                tool_choice: anthropicToolChoice(request.toolChoice),
              }
            : {}),
        }),
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal.aborted) throw abortError();
      void error;
      throw new AgentModelDriverError('Anthropic request could not be started.');
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new AgentModelDriverError('Anthropic authentication failed.');
      }
      if (response.status === 429) {
        throw new AgentModelDriverError('Anthropic rate limit reached.');
      }
      throw new AgentModelDriverError('Anthropic request failed.');
    }

    const blocks = new Map<number, AnthropicBlockState>();
    let inputTokens: number | null = null;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let outputTokens: number | null = null;
    let finishReason: AgentModelStopReason | null = null;
    let messageStarted = false;
    let messageStopped = false;
    const reasoningReplay: AnthropicReasoningReplayBlock[] = [];
    const responseToolCallIds: string[] = [];

    for await (const event of parseSseJson(response, request.signal)) {
      const type = stringField(event, 'type');
      if (type === 'ping') continue;
      if (type === 'error') {
        throw new AgentModelDriverError('Anthropic stream returned an error.');
      }
      if (type === 'message_start') {
        if (messageStarted) throw invalidStream();
        messageStarted = true;
        const message = recordField(event, 'message');
        const usage = recordField(message, 'usage');
        inputTokens = nonNegativeInteger(usage.input_tokens, 'input_tokens');
        cacheReadTokens = optionalNonNegativeInteger(usage.cache_read_input_tokens);
        cacheWriteTokens = optionalNonNegativeInteger(usage.cache_creation_input_tokens);
        continue;
      }
      if (!messageStarted || messageStopped) throw invalidStream();
      if (type === 'content_block_start') {
        const index = nonNegativeInteger(event.index, 'content block index');
        if (blocks.has(index)) throw invalidStream();
        const content = recordField(event, 'content_block');
        const blockType = stringField(content, 'type');
        if (blockType === 'text') {
          blocks.set(index, { type: blockType });
        } else if (blockType === 'thinking') {
          blocks.set(index, {
            type: 'thinking',
            thinking: typeof content.thinking === 'string' ? content.thinking : '',
            signature: typeof content.signature === 'string' ? content.signature : '',
          });
        } else if (blockType === 'redacted_thinking') {
          blocks.set(index, {
            type: 'redacted_thinking',
            data: nonBlankString(content.data, 'redacted thinking data'),
          });
        } else if (blockType === 'tool_use') {
          const callId = nonBlankString(content.id, 'tool call id');
          const name = nonBlankString(content.name, 'tool name');
          blocks.set(index, { type: 'tool_use', callId });
          responseToolCallIds.push(callId);
          yield { type: 'tool_call_start', callId, name };
          const initialInput = content.input;
          if (
            initialInput &&
            typeof initialInput === 'object' &&
            !Array.isArray(initialInput) &&
            Object.keys(initialInput).length > 0
          ) {
            yield {
              type: 'tool_args_delta',
              callId,
              delta: JSON.stringify(initialInput),
            };
          }
        } else {
          // New Anthropic block types are ignored only if they emit no payload
          // that Drifting would need to replay for a tool loop.
          blocks.set(index, { type: 'text' });
        }
        continue;
      }
      if (type === 'content_block_delta') {
        const index = nonNegativeInteger(event.index, 'content block index');
        const block = blocks.get(index);
        if (!block) throw invalidStream();
        const delta = recordField(event, 'delta');
        const deltaType = stringField(delta, 'type');
        if (deltaType === 'text_delta' && block.type === 'text') {
          const text = typeof delta.text === 'string' ? delta.text : '';
          if (text) yield { type: 'text_delta', text };
        } else if (deltaType === 'thinking_delta' && block.type === 'thinking') {
          const thinking = typeof delta.thinking === 'string' ? delta.thinking : '';
          block.thinking = (block.thinking ?? '') + thinking;
          if (thinking) yield { type: 'thinking_delta', text: thinking };
        } else if (deltaType === 'input_json_delta' && block.type === 'tool_use') {
          const partial = typeof delta.partial_json === 'string' ? delta.partial_json : '';
          if (partial) {
            yield { type: 'tool_args_delta', callId: block.callId!, delta: partial };
          }
        } else if (deltaType === 'signature_delta' && block.type === 'thinking') {
          const signature = typeof delta.signature === 'string' ? delta.signature : '';
          block.signature = (block.signature ?? '') + signature;
        } else {
          throw invalidStream();
        }
        continue;
      }
      if (type === 'content_block_stop') {
        const index = nonNegativeInteger(event.index, 'content block index');
        const block = blocks.get(index);
        if (!block) throw invalidStream();
        blocks.delete(index);
        if (block.type === 'tool_use') {
          yield { type: 'tool_call_end', callId: block.callId! };
        } else if (block.type === 'thinking') {
          reasoningReplay.push({
            type: 'thinking',
            thinking: block.thinking ?? '',
            signature: nonBlankString(block.signature, 'thinking signature'),
          });
        } else if (block.type === 'redacted_thinking') {
          reasoningReplay.push({
            type: 'redacted_thinking',
            data: nonBlankString(block.data, 'redacted thinking data'),
          });
        }
        continue;
      }
      if (type === 'message_delta') {
        const delta = recordField(event, 'delta');
        const stopReason = delta.stop_reason;
        if (typeof stopReason === 'string') {
          if (finishReason) throw invalidStream();
          finishReason = normalizeAnthropicStopReason(stopReason);
        }
        const usage = recordField(event, 'usage');
        outputTokens = nonNegativeInteger(usage.output_tokens, 'output_tokens');
        continue;
      }
      if (type === 'message_stop') {
        if (blocks.size > 0 || messageStopped) throw invalidStream();
        messageStopped = true;
        continue;
      }
      // The Messages API may add ignorable events. Unknown event types do not
      // receive authority and cannot synthesize tool calls.
    }
    if (
      !messageStarted ||
      !messageStopped ||
      inputTokens === null ||
      outputTokens === null ||
      finishReason === null
    ) {
      throw invalidStream();
    }
    const usage: AgentRuntimeUsage = {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      costUsd: 0,
    };
    if (reasoningEnabled && finishReason === 'tool_use') {
      const exact = reasoningReplay.map((block) => ({ ...block }));
      for (const callId of responseToolCallIds) {
        this.nonReasoningCallIds.delete(callId);
        this.reasoningReplayByCallId.set(callId, exact);
      }
    } else if (finishReason === 'tool_use') {
      for (const callId of responseToolCallIds) {
        this.reasoningReplayByCallId.delete(callId);
        this.nonReasoningCallIds.add(callId);
      }
    }
    yield { type: 'usage', usage };
    yield { type: 'finish', reason: finishReason };
  }
}

function anthropicToolChoice(
  choice: AgentModelRequest['toolChoice'],
): { type: 'auto' | 'any' } | { type: 'tool'; name: string } {
  if (choice === 'required') return { type: 'any' };
  if (choice && typeof choice === 'object') return { type: 'tool', name: choice.force };
  return { type: 'auto' };
}

type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: string | Array<Record<string, unknown>>;
};

function projectAnthropicMessages(
  messages: AgentModelRequest['context']['messages'],
  reasoningReplayByCallId?: ReadonlyMap<
    string,
    readonly AnthropicReasoningReplayBlock[]
  >,
): AnthropicMessage[] {
  const projected: AnthropicMessage[] = [];
  for (const entry of messages) {
    if (entry.type === 'model_message') {
      projected.push(
        ...projectCanonicalMessage(entry.message, reasoningReplayByCallId),
      );
    } else if (entry.type === 'context_summary') {
      projected.push({
        role: 'user',
        content: serializeAgentContextSummaryProviderPayload(entry),
      });
    } else {
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
  reasoningReplayByCallId?: ReadonlyMap<
    string,
    readonly AnthropicReasoningReplayBlock[]
  >,
): AnthropicMessage[] {
  if (message.role === 'user') return [{ role: 'user', content: message.content }];
  if (message.role === 'tool') {
    return [
      {
        role: 'user',
        content: message.content.map((result) => ({
          type: 'tool_result',
          tool_use_id: result.callId,
          content: result.content,
          is_error: !result.ok,
        })),
      },
    ];
  }
  const content: Array<Record<string, unknown>> = [];
  const toolCallIds = message.content.flatMap((block) =>
    block.type === 'tool_call' ? [block.callId] : [],
  );
  const reasoningReplay = resolveSharedAnthropicReplay(
    toolCallIds,
    reasoningReplayByCallId,
  );
  if (reasoningReplay) content.push(...reasoningReplay.map((block) => ({ ...block })));
  for (const block of message.content) {
    if (block.type === 'text' && block.text) {
      content.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_call') {
      content.push({
        type: 'tool_use',
        id: block.callId,
        name: block.name,
        input: block.arguments,
      });
    }
  }
  return [{ role: 'assistant', content }];
}

function resolveSharedAnthropicReplay(
  callIds: readonly string[],
  replayByCallId?: ReadonlyMap<
    string,
    readonly AnthropicReasoningReplayBlock[]
  >,
): readonly AnthropicReasoningReplayBlock[] | undefined {
  if (!replayByCallId || callIds.length === 0) return undefined;
  const values = callIds.flatMap((callId) => {
    const value = replayByCallId.get(callId);
    return value === undefined ? [] : [value];
  });
  if (values.length === 0) return undefined;
  if (
    values.length !== callIds.length ||
    values.some((value) => value !== values[0])
  ) {
    throw new AgentModelDriverError(
      'Anthropic reasoning replay state is incomplete for the active tool loop.',
    );
  }
  return values[0];
}

function assertActiveAnthropicReplay(
  context: AgentModelRequest['context'],
  replayByCallId: ReadonlyMap<
    string,
    readonly AnthropicReasoningReplayBlock[]
  >,
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
  if (
    activeCallIds.length === 0 ||
    activeCallIds.some(
      (callId) =>
        !replayByCallId.has(callId) && !nonReasoningCallIds.has(callId),
    )
  ) {
    throw new AgentModelDriverError(
      'Anthropic reasoning replay state is unavailable for the active tool loop.',
    );
  }
}

async function* parseSseJson(
  response: Response,
  signal: AbortSignal,
): AsyncIterable<Record<string, unknown>> {
  if (!response.body) throw new AgentModelDriverError('Anthropic stream has no body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let totalBytes = 0;
  try {
    while (true) {
      if (signal.aborted) throw abortError();
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > 32 * 1024 * 1024) {
        throw new AgentModelDriverError('Anthropic stream exceeded the response limit.');
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
        if (data) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            throw invalidStream();
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw invalidStream();
          }
          yield parsed as Record<string, unknown>;
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (buffer.trim()) throw invalidStream();
}

function normalizeAnthropicStopReason(value: string): AgentModelStopReason {
  switch (value) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'content_filter';
    default:
      return 'unknown';
  }
}

function recordField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const field = value[key];
  if (!field || typeof field !== 'object' || Array.isArray(field)) throw invalidStream();
  return field as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== 'string') throw invalidStream();
  return value[key];
}

function nonBlankString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentModelDriverError(`Anthropic stream has an invalid ${label}.`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new AgentModelDriverError(`Anthropic stream has an invalid ${label}.`);
  }
  return value as number;
}

function optionalNonNegativeInteger(value: unknown): number {
  return value === undefined ? 0 : nonNegativeInteger(value, 'cache usage');
}

function invalidStream(): AgentModelDriverError {
  return new AgentModelDriverError('Anthropic returned an invalid model stream.');
}

function abortError(): AgentModelDriverError {
  return new AgentModelDriverError('Anthropic request was cancelled.');
}
