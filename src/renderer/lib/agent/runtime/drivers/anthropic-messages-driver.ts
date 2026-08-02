import { AgentModelDriverError } from '../errors';
import type {
  AgentModelDriver,
  AgentModelMessage,
  AgentModelRequest,
  AgentModelStopReason,
  AgentModelStreamEvent,
  AgentRuntimeUsage,
} from '../types';
import { resolveAgentProviderContextProfile } from '../agent-provider-contract';

type FetchLike = typeof fetch;

export interface AnthropicMessagesAgentDriverOptions {
  apiKey: string;
  defaultModel?: string;
  endpoint?: string;
  fetch?: FetchLike;
}

interface AnthropicBlockState {
  type: 'text' | 'thinking' | 'tool_use';
  callId?: string;
}

/** Native Anthropic Messages adapter; no Claude Agent SDK or Node host needed. */
export class AnthropicMessagesAgentDriver implements AgentModelDriver {
  readonly id = 'anthropic-messages-stream';
  readonly capabilities = {
    reasoning: false,
    context: resolveAgentProviderContextProfile('anthropic', 'claude-sonnet-5'),
  } as const;

  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly endpoint: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: AnthropicMessagesAgentDriverOptions) {
    if (!options.apiKey.trim()) throw new Error('Anthropic API key is empty');
    this.apiKey = options.apiKey;
    this.defaultModel = options.defaultModel ?? 'claude-sonnet-5';
    this.endpoint = options.endpoint ?? 'https://api.anthropic.com/v1/messages';
    this.fetchImpl = options.fetch ?? fetch;
  }

  async *stream(request: AgentModelRequest): AsyncIterable<AgentModelStreamEvent> {
    if (request.signal.aborted) throw abortError();
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
          model: request.model || this.defaultModel,
          max_tokens: request.maxOutputTokens,
          stream: true,
          system: request.context.systemPrompt,
          messages: projectAnthropicMessages(request.context.messages),
          ...(request.tools.length
            ? {
                tools: request.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  input_schema: tool.inputSchema,
                })),
                tool_choice: { type: 'auto' },
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
        if (blockType === 'text' || blockType === 'thinking') {
          blocks.set(index, { type: blockType });
        } else if (blockType === 'tool_use') {
          const callId = nonBlankString(content.id, 'tool call id');
          const name = nonBlankString(content.name, 'tool name');
          blocks.set(index, { type: 'tool_use', callId });
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
          if (thinking) yield { type: 'thinking_delta', text: thinking };
        } else if (deltaType === 'input_json_delta' && block.type === 'tool_use') {
          const partial = typeof delta.partial_json === 'string' ? delta.partial_json : '';
          if (partial) {
            yield { type: 'tool_args_delta', callId: block.callId!, delta: partial };
          }
        } else if (deltaType !== 'signature_delta') {
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
    yield { type: 'usage', usage };
    yield { type: 'finish', reason: finishReason };
  }
}

type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: string | Array<Record<string, unknown>>;
};

function projectAnthropicMessages(
  messages: AgentModelRequest['context']['messages'],
): AnthropicMessage[] {
  const projected: AnthropicMessage[] = [];
  for (const entry of messages) {
    if (entry.type === 'model_message') {
      projected.push(...projectCanonicalMessage(entry.message));
    } else if (entry.type === 'context_summary') {
      projected.push({
        role: 'user',
        content: JSON.stringify({
          type: 'drifting_verified_context_summary',
          provenance: {
            origin: 'drifting_runtime',
            summaryId: entry.summaryId,
            sourceCount: entry.sourceIds.length,
            sourceHash: entry.sourceHash,
          },
          content: entry.content,
        }),
      });
    } else {
      projected.push({
        role: 'user',
        content: JSON.stringify({
          type: 'drifting_verified_context_note',
          provenance: {
            origin: 'drifting_runtime',
            noteKind: entry.noteKind,
            sourceId: entry.sourceId,
            turnOrdinal: entry.turnOrdinal,
          },
          content: entry.content,
        }),
      });
    }
  }
  return projected;
}

function projectCanonicalMessage(message: AgentModelMessage): AnthropicMessage[] {
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
    } else if (block.type === 'thinking' && block.text) {
      throw new AgentModelDriverError(
        'Reasoning history cannot be replayed by the Anthropic adapter.',
      );
    }
  }
  return [{ role: 'assistant', content }];
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
