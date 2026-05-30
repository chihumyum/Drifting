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

  complete(request: AICompletionRequest): Promise<AICompletionResponse>;

  /**
   * Stream a free-form text completion as incremental chunks. Optional —
   * present only on providers with a streaming SDK path. Tools are ignored in
   * stream mode (streaming is for interactive chat, not structured output).
   */
  stream?(request: AICompletionRequest): AsyncIterable<AICompletionChunk>;
}
