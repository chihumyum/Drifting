/**
 * LLMProvider — the L1 adapter contract. Each concrete provider (Google,
 * Anthropic, OpenAI, …) implements this and translates between our
 * provider-agnostic shape and the underlying SDK.
 *
 * Non-streaming `complete()` is the universal contract. `stream()` is OPTIONAL:
 * providers that support token streaming implement it; the LLMClient falls back
 * to wrapping `complete()` as a single chunk for those that don't.
 */
import type {
  AICompletionChunk,
  AICompletionRequest,
  AICompletionResponse,
} from '../../types';

export interface LLMProvider {
  /** Stable id used by metering / logging to attribute requests. */
  readonly id: string;

  /**
   * Whether this provider supports a real multi-tool function-calling loop
   * (auto tool-choice + tool-result messages), not just the single-forced-tool
   * structured-output channel. Absent ⇒ false. OpenAI-compatible providers set
   * this; gateways/proxies that haven't wired tool threading leave it off so
   * callers fall back to the structured-menu path.
   */
  readonly supportsTools?: boolean;

  complete(request: AICompletionRequest): Promise<AICompletionResponse>;

  /**
   * Stream a free-form text completion as incremental chunks. Optional —
   * present only on providers with a streaming SDK path. Tools are ignored in
   * stream mode (streaming is for interactive chat, not structured output).
   */
  stream?(request: AICompletionRequest): AsyncIterable<AICompletionChunk>;
}
