/**
 * P1 adapter from Drifting's existing non-streaming LLMClient contract to the
 * provider-neutral AgentModelDriver stream.
 *
 * The existing OpenAI-compatible providers already own credentials, retries,
 * wire translation, and parsed function calls. This adapter deliberately does
 * not inspect provider errors or expose their messages. It only:
 *   - projects canonical AgentModelMessage blocks into AIMessage,
 *   - forces thinking off for the P1 completion path,
 *   - turns one completed response into canonical text/tool/usage/finish events.
 */
import type { LLMClient } from '../../../ai/client/llm-client';
import {
  AIError,
  type AICompletionRequest,
  type AICompletionResponse,
  type AIMessage,
  type AIToolCall,
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
  complete(request: AICompletionRequest): Promise<AICompletionResponse>;
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
        'Reasoning is not supported by the P1 completion driver.',
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
      // P1 deliberately does not round-trip provider reasoning state.
      thinking: false,
      toolChoice: 'auto',
      signal: request.signal,
      metadata: {
        feature: this.feature,
        agentSessionId: request.sessionId,
        agentTurnId: request.turnId,
        agentIteration: request.iteration,
      },
    };

    let response: AICompletionResponse;
    try {
      response = await this.client.complete(completionRequest);
    } catch (error) {
      throw safeCompletionError(error);
    }

    if (response.text) {
      yield { type: 'text_delta', text: response.text };
    }

    const toolCalls = responseToolCalls(response);
    for (const call of toolCalls) {
      const callId = requireProviderField(call.id, 'tool call id');
      const name = requireProviderField(call.name, 'tool name');
      const rawArguments = serializeToolArguments(call.arguments);
      yield { type: 'tool_call_start', callId, name };
      if (rawArguments) {
        yield { type: 'tool_args_delta', callId, delta: rawArguments };
      }
      yield { type: 'tool_call_end', callId };
    }

    yield {
      type: 'usage',
      usage: normalizeUsage(response),
    };
    yield {
      type: 'finish',
      reason: inferStopReason(response, toolCalls.length > 0),
    };
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
              'Reasoning history cannot be replayed by the P1 completion driver.',
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

function inferStopReason(
  response: AICompletionResponse,
  hasToolCalls: boolean,
): AgentModelStopReason {
  // Tool presence is authoritative: a provider may report a vague/incorrect
  // finish reason, but the runtime must still execute and answer every call.
  if (hasToolCalls) return 'tool_use';

  const rawReason = openAICompatibleFinishReason(response.raw);
  switch (rawReason) {
    case undefined:
    case 'stop':
      return 'end_turn';
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
    const serialized = JSON.stringify(argumentsValue ?? {});
    if (serialized === undefined) {
      throw new Error('not JSON serializable');
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
