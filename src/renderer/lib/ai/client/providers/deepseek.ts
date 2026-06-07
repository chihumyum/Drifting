/**
 * DeepSeek provider — L1 adapter using the OpenAI SDK pointed at the
 * DeepSeek API endpoint. DeepSeek implements the OpenAI Chat Completions
 * protocol (including function calling), so a single SDK installation
 * covers both providers.
 *
 * Notable translations between our provider-agnostic AICompletionRequest
 * and OpenAI shape:
 *   - role 'model' → 'assistant'
 *   - system prompt becomes a leading `{ role: 'system' }` message
 *   - tools → `{ type: 'function', function: { name, description, parameters } }`
 *   - "ANY-mode + single allowed tool" (our Gemini convention) translates
 *     to `tool_choice: { type: 'function', function: { name } }`
 *   - tool-call arguments arrive as a JSON STRING and must be parsed
 *   - abortSignal flows through SDK request options to the underlying fetch
 *
 * Thinking mode (deepseek-v4-flash / -pro default to thinking-on):
 *   - Default on/off comes from provider config; a single request can override
 *     it via `request.thinking` (inline-ask forces reasoning on this way)
 *   - Sent as `{ thinking: { type: 'enabled' | 'disabled', reasoning_effort } }`
 *     — per the DeepSeek API `reasoning_effort` is NESTED inside `thinking`,
 *     NOT a top-level body field
 *   - When enabled, temperature/top_p/penalty params are silently ignored by
 *     DeepSeek (per their docs), so we omit them to keep wire traffic clean
 *
 * Thinking + tools: DeepSeek-V3.2+ supports tool calls in thinking mode, so it
 * composes with callStructured's forced tool_choice (this was NOT true on older
 * versions — an earlier note here claimed thinking ⊥ forced tool_choice; that's
 * outdated). One caveat (multi-round only): in a thinking turn that performs a tool
 * call, the assistant's `reasoning_content` MUST be passed back in subsequent
 * requests of that turn or the API 400s. callStructured is single-shot (force one
 * tool, read its args, stop) so there's no follow-up turn and nothing to pass back.
 *
 * Model substitution: prompts hardcode Gemini model ids (`gemini-3.5-flash`)
 * because they were written before multi-provider support. When DeepSeek is
 * active, we substitute the configured default model — the prompts don't
 * care which model serves them as long as it follows the schema. PR cleanup
 * later: introduce model-tier hints ('lite' | 'standard' | 'pro') in prompts
 * and let providers map them.
 */
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

export type DeepSeekReasoningEffort = 'high' | 'max';

export interface DeepSeekProviderConfig {
  apiKey: string;
  /**
   * Default model id sent to DeepSeek when the request carries a model id
   * that DeepSeek wouldn't recognize (e.g. inherited Gemini names from
   * provider-agnostic prompts). Pass-through happens for ids that look
   * DeepSeek-native (start with `deepseek-`).
   */
  defaultModel?: string;
  baseURL?: string;
  /**
   * Enable thinking mode. Defaults to false. See the file header for the
   * forced-tool_choice incompatibility — keep this off for any capability
   * that goes through callStructured.
   */
  thinking?: boolean;
  /**
   * Reasoning effort when thinking is enabled. Defaults to 'high'. Ignored
   * when thinking is disabled. (DeepSeek maps low/medium → high server-side
   * anyway, so we only expose the meaningful values.)
   */
  reasoningEffort?: DeepSeekReasoningEffort;
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
const DEFAULT_MODEL = 'deepseek-v4-flash';

export class DeepSeekProvider implements LLMProvider {
  readonly id = 'deepseek';
  // OpenAI-compatible Chat Completions ⇒ full function-calling (tools, auto
  // tool_choice, role:'tool' results, parallel tool_calls).
  readonly supportsTools = true;
  private readonly client: OpenAI;
  private readonly defaultModel: string;
  private readonly thinking: boolean;
  private readonly reasoningEffort?: DeepSeekReasoningEffort;

  constructor(config: DeepSeekProviderConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL ?? DEFAULT_BASE_URL,
      // Electron renderer is a browser-like environment; OpenAI SDK refuses
      // browser execution by default to discourage key exposure. We're safe:
      // BYOK keys live in the OS keychain (or env at dev time), not in the
      // bundle. This opt-in just acknowledges the SDK's warning.
      dangerouslyAllowBrowser: true,
    });
    this.defaultModel = config.defaultModel ?? DEFAULT_MODEL;
    this.thinking = config.thinking ?? false;
    this.reasoningEffort = this.thinking ? (config.reasoningEffort ?? 'high') : undefined;
  }

  /**
   * DeepSeek's thinking-mode extension (untyped by the OpenAI SDK). Per the
   * API, `reasoning_effort` lives INSIDE the `thinking` object; when thinking
   * is on we default the effort to 'high' if none was configured.
   */
  private thinkingExtension(thinkingOn: boolean): Record<string, unknown> {
    const thinking: Record<string, unknown> = {
      type: thinkingOn ? 'enabled' : 'disabled',
    };
    if (thinkingOn) {
      thinking.reasoning_effort = this.reasoningEffort ?? 'high';
    }
    return { thinking };
  }

  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    const { model, system, messages, tools, maxOutputTokens, temperature, signal } = request;

    if (signal?.aborted) {
      throw new AIError('aborted', 'Request aborted before send');
    }

    const chatMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (system) {
      chatMessages.push({ role: 'system', content: system });
    }
    for (const m of messages) {
      if (m.role === 'tool') {
        // A tool-call RESULT — must reference the originating tool_call id.
        chatMessages.push({ role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content });
      } else if (m.role === 'model') {
        const asst: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          // OpenAI wants null content on a pure tool-call turn.
          content: m.content || (m.toolCalls?.length ? null : ''),
        };
        if (m.toolCalls?.length) {
          asst.tool_calls = m.toolCalls.map((tc) => ({
            id: tc.id ?? '',
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
          }));
        }
        chatMessages.push(asst);
      } else {
        chatMessages.push({ role: 'user', content: m.content });
      }
    }

    const chatTools: OpenAI.Chat.ChatCompletionTool[] | undefined = tools?.length
      ? tools.map((t) => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parametersSchema as Record<string, unknown>,
          },
        }))
      : undefined;

    // tool_choice: an explicit request.toolChoice drives the FC loop (auto /
    // required / force-a-named-tool). When absent we keep the legacy "force the
    // first (single) tool" behavior that callStructured relies on for structured
    // JSON output.
    let toolChoice: OpenAI.Chat.ChatCompletionToolChoiceOption | undefined;
    if (request.toolChoice === 'auto' || request.toolChoice === 'required') {
      toolChoice = request.toolChoice;
    } else if (request.toolChoice && typeof request.toolChoice === 'object') {
      toolChoice = { type: 'function', function: { name: request.toolChoice.force } };
    } else if (tools && tools.length > 0) {
      toolChoice = { type: 'function', function: { name: tools[0]!.name } };
    }

    // Body construction — split standard OpenAI fields from DeepSeek
    // extensions. The OpenAI Node SDK doesn't type `thinking` /
    // `reasoning_effort`, so we attach via a typed widening at the bottom.
    const baseBody: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model: resolveModel(model, this.defaultModel),
      messages: chatMessages,
      tools: chatTools,
      tool_choice: toolChoice,
      max_tokens: maxOutputTokens,
    };
    // JSON Output mode — model returns a valid JSON string as content (no tool call).
    // Composes with thinking, unlike forced tool_choice.
    if (request.responseFormat === 'json_object') {
      baseBody.response_format = { type: 'json_object' };
    }
    // Per DeepSeek docs: thinking mode silently ignores temperature/top_p/
    // presence_penalty/frequency_penalty. Omit them to keep the wire clean.
    const effectiveThinking = request.thinking ?? this.thinking;
    if (!effectiveThinking && typeof temperature === 'number') {
      baseBody.temperature = temperature;
    }

    const deepseekExtensions = this.thinkingExtension(effectiveThinking);

    try {
      const response = await this.client.chat.completions.create(
        { ...baseBody, ...deepseekExtensions } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
        { signal: signal ?? undefined },
      );

      const choice = response.choices[0];
      const message = choice?.message;
      const rawToolCalls = message?.tool_calls ?? [];

      const toolCalls: AIToolCall[] = [];
      for (const raw of rawToolCalls) {
        if (raw.type !== 'function') continue;
        // OpenAI tool arguments come as a JSON string — parse here so the
        // higher layers see the same shape regardless of provider.
        let parsedArgs: unknown = {};
        try {
          parsedArgs = raw.function.arguments ? JSON.parse(raw.function.arguments) : {};
        } catch (err) {
          // DeepSeek (esp. flash) sometimes wraps the args in a ```json fence or
          // leaves a trailing comma — try a CONSERVATIVE repair before giving up.
          // Runs ONLY on the already-failed path, so it can never corrupt valid output.
          const repaired = tryRepairJsonArgs(raw.function.arguments);
          if (repaired !== undefined) {
            parsedArgs = repaired;
          } else {
            throw new AIError(
              'parse',
              `DeepSeek returned tool args that aren't valid JSON: ${
                err instanceof Error ? err.message : String(err)
              }`,
              { rawArguments: raw.function.arguments },
            );
          }
        }
        toolCalls.push({ id: raw.id, name: raw.function.name, arguments: parsedArgs });
      }
      const toolCall = toolCalls[0];

      const text =
        !toolCall && typeof message?.content === 'string' ? message.content : undefined;

      return {
        text,
        toolCall,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        usage: {
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
          // OpenAI doesn't expose cache hits in the same shape — leave undefined.
          cachedTokens: undefined,
        },
        raw: response,
      };
    } catch (err) {
      throw mapDeepSeekError(err);
    }
  }

  /**
   * Free-form streaming via the OpenAI SDK's `stream: true` (DeepSeek is
   * wire-compatible). Yields each chunk's `delta.content`; a terminal
   * empty-delta chunk carries usage (requested via
   * `stream_options.include_usage`). Only `content` is surfaced —
   * `reasoning_content` from thinking mode is intentionally dropped so the
   * visible answer excludes the model's chain of thought. Tools don't apply.
   */
  async *stream(request: AICompletionRequest): AsyncIterable<AICompletionChunk> {
    const { model, system, messages, temperature, signal } = request;

    if (signal?.aborted) {
      throw new AIError('aborted', 'Request aborted before send');
    }

    const chatMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (system) chatMessages.push({ role: 'system', content: system });
    for (const m of messages) {
      chatMessages.push({
        role: m.role === 'model' ? 'assistant' : 'user',
        content: m.content,
      });
    }

    const baseBody: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      model: resolveModel(model, this.defaultModel),
      messages: chatMessages,
      stream: true,
      stream_options: { include_usage: true },
    };
    const effectiveThinking = request.thinking ?? this.thinking;
    if (!effectiveThinking && typeof temperature === 'number') {
      baseBody.temperature = temperature;
    }

    const deepseekExtensions = this.thinkingExtension(effectiveThinking);

    try {
      const stream = await this.client.chat.completions.create(
        { ...baseBody, ...deepseekExtensions } as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
        { signal: signal ?? undefined },
      );

      let usage: AIUsage | undefined;
      for await (const chunk of stream) {
        if (signal?.aborted) throw new AIError('aborted', 'Request aborted');
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
            cachedTokens: undefined,
          };
        }
        const delta = chunk.choices[0]?.delta?.content ?? '';
        if (delta) yield { delta };
      }

      yield { delta: '', usage: usage ?? { inputTokens: 0, outputTokens: 0 } };
    } catch (err) {
      throw mapDeepSeekError(err);
    }
  }
}

/**
 * If the request comes in with a model id from another provider's namespace
 * (e.g. `gemini-3.5-flash` inherited from a prompt that predates multi-
 * provider support), substitute the configured default. Pass through ids
 * that already look DeepSeek-native.
 */
function resolveModel(requested: string, fallback: string): string {
  if (requested && requested.startsWith('deepseek-')) return requested;
  return fallback;
}

/**
 * Best-effort repair of tool-call arguments that failed JSON.parse. Handles the two
 * cheap, SAFE-to-fix cases DeepSeek occasionally produces: a ```json fence wrapping
 * the object, and a trailing comma before } / ]. Returns the parsed object on
 * success, or `undefined` if it still isn't valid JSON (caller then throws the
 * original parse error). Deliberately does NOT attempt to fix unescaped inner quotes
 * — that can't be done reliably without a tolerant parser, and the PRO model (and the
 * retry layer) handle that class far better than flash.
 */
function tryRepairJsonArgs(raw: string | undefined): unknown {
  if (!raw) return undefined;
  let s = raw.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence?.[1]) s = fence[1].trim();
  s = s.replace(/,(\s*[}\]])/g, '$1'); // drop trailing commas
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function mapDeepSeekError(err: unknown): AIError {
  if (err instanceof AIError) return err;
  if (err instanceof DOMException && err.name === 'AbortError') {
    return new AIError('aborted', 'Request was aborted', err);
  }
  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    if (status === 401 || status === 403) {
      return new AIError('auth', `DeepSeek auth failed: ${err.message}`, err);
    }
    if (status === 429) {
      return new AIError('rate-limit', `DeepSeek rate-limited: ${err.message}`, err);
    }
    if (status !== undefined && status >= 500) {
      return new AIError('network', `DeepSeek upstream ${status}: ${err.message}`, err);
    }
    return new AIError('unknown', `DeepSeek API error: ${err.message}`, err);
  }
  if (err instanceof TypeError) {
    return new AIError('network', err.message, err);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new AIError('unknown', message, err);
}
