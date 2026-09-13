import OpenAI from 'openai';

import type { LLMProvider } from './provider';
import {
  AIError,
  type AICompletionChunk,
  type AICompletionRequest,
  type AICompletionResponse,
  type AIToolCall,
  type AIUsage,
} from '../../types';

export interface OpenAIProviderConfig {
  apiKey: string;
  defaultModel?: string;
  baseURL?: string;
}

/** OpenAI Chat Completions adapter with strict Agent terminal accounting. */
export class OpenAIProvider implements LLMProvider {
  readonly id = 'openai';
  readonly supportsTools = true;
  readonly supportsToolStreaming = true;

  private readonly client: OpenAI;
  private readonly defaultModel: string;

  constructor(config: OpenAIProviderConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      dangerouslyAllowBrowser: true,
    });
    this.defaultModel = config.defaultModel ?? 'gpt-5.6-sol';
  }

  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    assertNotAborted(request.signal);
    const model = request.model || this.defaultModel;
    try {
      const response = await this.client.chat.completions.create(
        {
          model,
          messages: buildMessages(request),
          tools: buildTools(request),
          tool_choice: buildToolChoice(request),
          max_completion_tokens: request.maxOutputTokens,
          ...(model.startsWith('gpt-5.6')
            ? { reasoning_effort: 'none' as const }
            : {}),
          ...(typeof request.temperature === 'number'
            ? { temperature: request.temperature }
            : {}),
          ...(request.responseFormat === 'json_object'
            ? { response_format: { type: 'json_object' as const } }
            : {}),
        },
        { signal: request.signal },
      );
      const choice = response.choices[0];
      const toolCalls = parseToolCalls(choice?.message.tool_calls ?? []);
      const usage = normalizeUsage(response.usage);
      if (request.terminalRequirements?.finishReason && !choice?.finish_reason) {
        throw new AIError('parse', 'OpenAI completion ended without a finish reason.');
      }
      if (request.terminalRequirements?.usage && !response.usage) {
        throw new AIError('parse', 'OpenAI completion ended without usage.');
      }
      return {
        ...(choice?.message.content ? { text: choice.message.content } : {}),
        ...(toolCalls[0] ? { toolCall: toolCalls[0] } : {}),
        ...(toolCalls.length ? { toolCalls } : {}),
        ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}),
        usage,
        raw: response,
      };
    } catch (error) {
      throw mapOpenAIError(error, request.signal);
    }
  }

  async *stream(request: AICompletionRequest): AsyncIterable<AICompletionChunk> {
    assertNotAborted(request.signal);
    const model = request.model || this.defaultModel;
    try {
      const stream = await this.client.chat.completions.create(
        {
          model,
          messages: buildMessages(request),
          tools: buildTools(request),
          tool_choice: buildToolChoice(request),
          max_completion_tokens: request.maxOutputTokens,
          ...(model.startsWith('gpt-5.6')
            ? { reasoning_effort: 'none' as const }
            : {}),
          stream: true,
          stream_options: { include_usage: true },
          ...(typeof request.temperature === 'number'
            ? { temperature: request.temperature }
            : {}),
          ...(request.responseFormat === 'json_object'
            ? { response_format: { type: 'json_object' as const } }
            : {}),
        },
        { signal: request.signal },
      );
      let usageSeen = false;
      let finishSeen = false;
      for await (const chunk of stream) {
        assertNotAborted(request.signal);
        const choice = chunk.choices[0];
        const finishReason = choice?.finish_reason ?? undefined;
        const usage = chunk.usage ? normalizeUsage(chunk.usage) : undefined;
        if (finishReason) finishSeen = true;
        if (usage) usageSeen = true;
        const toolCallDeltas = (choice?.delta.tool_calls ?? []).map((call) => ({
          index: call.index,
          ...(call.id ? { id: call.id } : {}),
          ...(call.function?.name ? { nameDelta: call.function.name } : {}),
          ...(call.function?.arguments
            ? { argumentsDelta: call.function.arguments }
            : {}),
        }));
        const delta = choice?.delta.content ?? '';
        if (delta || toolCallDeltas.length || finishReason || usage) {
          yield {
            delta,
            ...(toolCallDeltas.length ? { toolCallDeltas } : {}),
            ...(finishReason ? { finishReason } : {}),
            ...(usage ? { usage } : {}),
          };
        }
      }
      if ((request.tools?.length || request.terminalRequirements?.finishReason) && !finishSeen) {
        throw new AIError('parse', 'OpenAI stream ended without a finish reason.');
      }
      if ((request.tools?.length || request.terminalRequirements?.usage) && !usageSeen) {
        throw new AIError('parse', 'OpenAI stream ended without terminal usage.');
      }
    } catch (error) {
      throw mapOpenAIError(error, request.signal);
    }
  }
}

function buildMessages(request: AICompletionRequest): OpenAI.Chat.ChatCompletionMessageParam[] {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (request.system) messages.push({ role: 'system', content: request.system });
  for (const message of request.messages) {
    if (message.role === 'user') {
      messages.push({ role: 'user', content: message.content });
    } else if (message.role === 'tool') {
      if (!message.toolCallId) {
        throw new AIError('invalid-input', 'OpenAI tool result is missing toolCallId.');
      }
      messages.push({ role: 'tool', tool_call_id: message.toolCallId, content: message.content });
    } else {
      messages.push({
        role: 'assistant',
        content: message.content || null,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => {
                if (!call.id) {
                  throw new AIError('invalid-input', 'OpenAI assistant tool call is missing id.');
                }
                return {
                  id: call.id,
                  type: 'function' as const,
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.arguments ?? {}),
                  },
                };
              }),
            }
          : {}),
      });
    }
  }
  return messages;
}

function buildTools(
  request: AICompletionRequest,
): OpenAI.Chat.ChatCompletionTool[] | undefined {
  return request.tools?.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parametersSchema as Record<string, unknown>,
    },
  }));
}

function buildToolChoice(
  request: AICompletionRequest,
): OpenAI.Chat.ChatCompletionToolChoiceOption | undefined {
  if (!request.tools?.length) return undefined;
  if (request.toolChoice === 'auto') return 'auto';
  if (request.toolChoice === 'required') return 'required';
  const forced =
    typeof request.toolChoice === 'object'
      ? request.toolChoice.force
      : request.tools.length === 1
        ? request.tools[0].name
        : null;
  return forced
    ? { type: 'function', function: { name: forced } }
    : 'auto';
}

function parseToolCalls(
  calls: readonly OpenAI.Chat.ChatCompletionMessageToolCall[],
): AIToolCall[] {
  return calls.flatMap((call) => {
    if (call.type !== 'function') return [];
    let args: unknown;
    try {
      args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      throw new AIError('parse', 'OpenAI returned invalid JSON tool arguments.');
    }
    return [{ id: call.id, name: call.function.name, arguments: args }];
  });
}

function normalizeUsage(usage: {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number | null } | null;
} | null | undefined): AIUsage {
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    ...(usage?.prompt_tokens_details?.cached_tokens
      ? { cachedTokens: usage.prompt_tokens_details.cached_tokens }
      : {}),
  };
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AIError('aborted', 'Request aborted');
}

function mapOpenAIError(error: unknown, signal?: AbortSignal): AIError {
  if (error instanceof AIError) return error;
  if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
    return new AIError('aborted', 'Request aborted', error);
  }
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 401 || status === 403) return new AIError('auth', 'OpenAI authentication failed.');
  if (status === 429) return new AIError('rate-limit', 'OpenAI rate limit reached.');
  if (typeof status === 'number' && status >= 500) {
    return new AIError('network', 'OpenAI service is temporarily unavailable.');
  }
  return new AIError('network', 'OpenAI request failed.');
}
