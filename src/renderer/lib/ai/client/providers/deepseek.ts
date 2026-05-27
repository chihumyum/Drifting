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
 *   - Controlled explicitly via `thinking: boolean` on the provider config
 *   - Sent on every request as `{ thinking: { type: 'enabled' | 'disabled' } }`
 *     at the request body root (DeepSeek's OpenAI-compatible extension)
 *   - When enabled, also sends `reasoning_effort` ('high' default)
 *   - When enabled, temperature/top_p/penalty params are silently ignored by
 *     DeepSeek (per their docs), so we omit them to keep wire traffic clean
 *
 * KNOWN INTERACTION: thinking mode does NOT accept forced
 * `tool_choice: { type: 'function', name: ... }` (HTTP 400 from upstream).
 * Capabilities using callStructured must run with thinking disabled. The
 * toggle exists for future capabilities that use natural language or JSON
 * mode for output (e.g. inline-chat).
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
  type AICompletionRequest,
  type AICompletionResponse,
  type AIToolCall,
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
      chatMessages.push({
        role: m.role === 'model' ? 'assistant' : 'user',
        content: m.content,
      });
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

    // Force the first (and in our usage, only) tool. Matches Gemini's
    // ANY-mode-with-single-allowed-name convention used by callStructured.
    const toolChoice: OpenAI.Chat.ChatCompletionToolChoiceOption | undefined =
      tools && tools.length > 0
        ? { type: 'function', function: { name: tools[0]!.name } }
        : undefined;

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
    // Per DeepSeek docs: thinking mode silently ignores temperature/top_p/
    // presence_penalty/frequency_penalty. Omit them to keep the wire clean.
    if (!this.thinking && typeof temperature === 'number') {
      baseBody.temperature = temperature;
    }

    const deepseekExtensions: Record<string, unknown> = {
      thinking: { type: this.thinking ? 'enabled' : 'disabled' },
    };
    if (this.reasoningEffort) {
      deepseekExtensions.reasoning_effort = this.reasoningEffort;
    }

    try {
      const response = await this.client.chat.completions.create(
        { ...baseBody, ...deepseekExtensions } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
        { signal: signal ?? undefined },
      );

      const choice = response.choices[0];
      const message = choice?.message;
      const rawToolCall = message?.tool_calls?.[0];

      let toolCall: AIToolCall | undefined;
      if (rawToolCall && rawToolCall.type === 'function') {
        // OpenAI tool arguments come as a JSON string — parse here so the
        // higher layers see the same shape regardless of provider.
        let parsedArgs: unknown = {};
        try {
          parsedArgs = rawToolCall.function.arguments
            ? JSON.parse(rawToolCall.function.arguments)
            : {};
        } catch (err) {
          throw new AIError(
            'parse',
            `DeepSeek returned tool args that aren't valid JSON: ${
              err instanceof Error ? err.message : String(err)
            }`,
            { rawArguments: rawToolCall.function.arguments },
          );
        }
        toolCall = {
          name: rawToolCall.function.name,
          arguments: parsedArgs,
        };
      }

      const text =
        !toolCall && typeof message?.content === 'string' ? message.content : undefined;

      return {
        text,
        toolCall,
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
