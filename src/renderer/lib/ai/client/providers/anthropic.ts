import type { LLMProvider } from './provider';
import {
  AIError,
  type AICompletionRequest,
  type AICompletionResponse,
  type AIToolCall,
  type AIUsage,
} from '../../types';

type FetchLike = typeof fetch;

export interface AnthropicProviderConfig {
  apiKey: string;
  defaultModel?: string;
  endpoint?: string;
  fetch?: FetchLike;
}

/**
 * Anthropic Messages adapter for one-shot structured calls. Multi-round General-Agent work uses the
 * native AnthropicMessagesAgentDriver so reasoning replay remains exact.
 */
export class AnthropicProvider implements LLMProvider {
  readonly id = 'anthropic';

  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly endpoint: string;
  private readonly fetchImpl: FetchLike;

  constructor(config: AnthropicProviderConfig) {
    if (!config.apiKey.trim()) throw new AIError('auth', 'Anthropic API key is empty.');
    this.apiKey = config.apiKey;
    this.defaultModel = config.defaultModel ?? 'claude-sonnet-5';
    this.endpoint = config.endpoint ?? 'https://api.anthropic.com/v1/messages';
    this.fetchImpl = config.fetch ?? fetch;
  }

  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    if (request.signal?.aborted) throw new AIError('aborted', 'Request aborted before send.');
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
          max_tokens: request.maxOutputTokens ?? 8_192,
          ...(request.system ? { system: request.system } : {}),
          messages: projectMessages(request),
          ...(request.tools?.length
            ? {
                tools: request.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  input_schema: tool.parametersSchema,
                })),
                tool_choice: projectToolChoice(request),
              }
            : {}),
          ...(typeof request.temperature === 'number' ? { temperature: request.temperature } : {}),
        }),
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal?.aborted) throw new AIError('aborted', 'Request aborted.', error);
      throw new AIError('network', 'Anthropic request could not be started.', error);
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new AIError('auth', 'Anthropic authentication failed.');
      }
      if (response.status === 429) {
        throw new AIError('rate-limit', 'Anthropic rate limit reached.');
      }
      throw new AIError('network', 'Anthropic request failed.');
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new AIError('parse', 'Anthropic returned invalid JSON.', error);
    }
    const message = asRecord(payload);
    const blocks = Array.isArray(message.content) ? message.content.map(asRecord) : [];
    const text = blocks
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('');
    const toolCalls: AIToolCall[] = blocks.flatMap((block) => {
      if (block.type !== 'tool_use' || typeof block.name !== 'string') return [];
      return [
        {
          ...(typeof block.id === 'string' ? { id: block.id } : {}),
          name: block.name,
          arguments: asRecord(block.input),
        },
      ];
    });
    return {
      ...(text ? { text } : {}),
      ...(toolCalls[0] ? { toolCall: toolCalls[0] } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(typeof message.stop_reason === 'string' ? { finishReason: message.stop_reason } : {}),
      usage: normalizeUsage(message.usage),
      raw: payload,
    };
  }
}

function projectMessages(request: AICompletionRequest): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  for (const message of request.messages) {
    if (message.role === 'user') {
      messages.push({ role: 'user', content: message.content });
      continue;
    }
    if (message.role === 'model') {
      const content: Record<string, unknown>[] = [];
      if (message.content) content.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls ?? []) {
        content.push({
          type: 'tool_use',
          ...(call.id ? { id: call.id } : {}),
          name: call.name,
          input: asRecord(call.arguments),
        });
      }
      messages.push({ role: 'assistant', content });
      continue;
    }
    if (!message.toolCallId) {
      throw new AIError('invalid-input', 'Anthropic tool result is missing toolCallId.');
    }
    messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: message.content,
        },
      ],
    });
  }
  return messages;
}

function projectToolChoice(
  request: AICompletionRequest,
): { type: 'auto' | 'any' } | { type: 'tool'; name: string } {
  if (request.toolChoice === 'auto') return { type: 'auto' };
  if (request.toolChoice === 'required') return { type: 'any' };
  if (request.toolChoice && typeof request.toolChoice === 'object') {
    return { type: 'tool', name: request.toolChoice.force };
  }
  if (request.tools?.length === 1) {
    return { type: 'tool', name: request.tools[0].name };
  }
  return { type: 'any' };
}

function normalizeUsage(value: unknown): AIUsage {
  const usage = asRecord(value);
  return {
    inputTokens: nonNegativeNumber(usage.input_tokens),
    outputTokens: nonNegativeNumber(usage.output_tokens),
    ...(nonNegativeNumber(usage.cache_read_input_tokens) > 0
      ? { cachedTokens: nonNegativeNumber(usage.cache_read_input_tokens) }
      : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}
