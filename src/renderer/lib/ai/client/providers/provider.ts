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

  /**
   * Whether `stream()` preserves tool definitions/history and emits
   * incremental function-call fragments. `supportsTools` alone only promises
   * that the universal non-streaming `complete()` path can thread tools.
   */
  readonly supportsToolStreaming?: boolean;

  complete(request: AICompletionRequest): Promise<AICompletionResponse>;

  /**
   * Stream a completion as incremental chunks. Optional — providers without a
   * streaming SDK path fall back to `complete()`. Callers must check
   * `supportsToolStreaming` before using this path for a request with tools.
   */
  stream?(request: AICompletionRequest): AsyncIterable<AICompletionChunk>;
}
