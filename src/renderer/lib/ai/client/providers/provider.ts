/**
 * LLMProvider — the L1 adapter contract. Each concrete provider (Google,
 * Anthropic, OpenAI, …) implements this and translates between our
 * provider-agnostic shape and the underlying SDK.
 *
 * Streaming will be added in a later PR (separate `stream(request)` method
 * returning an AsyncIterable). Phase 0 is request/response only.
 */
import type { AICompletionRequest, AICompletionResponse } from '../../types';

export interface LLMProvider {
  /** Stable id used by metering / logging to attribute requests. */
  readonly id: string;

  complete(request: AICompletionRequest): Promise<AICompletionResponse>;
}
