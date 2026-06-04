/**
 * Shared AI types — provider-agnostic shape used across every layer of the
 * substrate. The provider adapter (e.g. `providers/google.ts`) is the only
 * place that knows what the underlying SDK's request/response shape looks
 * like; everything above L1 talks in these types.
 *
 * Keep this file free of runtime dependencies (no Zod, no SDK imports) so
 * cross-process consumers can import types without pulling the world in.
 */

/**
 * Model id. Typed as a union of known Gemini models plus an open-ended
 * string so feature code can pin to a specific model without TypeScript
 * blocking unknown ids — Google will release new models faster than we
 * update this union.
 */
export type GoogleModel =
  | 'gemini-2.5-pro'
  | 'gemini-2.5-flash'
  | 'gemini-2.5-flash-lite'
  | (string & {});

export type AIFeatureId = string;

export interface AIMessage {
  // 'tool' carries a tool-call RESULT back to the model (function-calling loop);
  // an assistant ('model') turn that called tools carries `toolCalls`.
  role: 'user' | 'model' | 'tool';
  content: string;
  /** For role 'tool': the id of the tool_call this message answers. */
  toolCallId?: string;
  /** For role 'model': the tool calls the assistant emitted this turn. */
  toolCalls?: AIToolCall[];
}

/**
 * A "virtual tool" used purely as a typed JSON-output channel. We never let
 * the model actually execute anything in Phase 0/1 — function calling is the
 * cleanest way to get structured output out of Gemini.
 */
export interface AITool {
  name: string;
  description: string;
  /** JSON Schema describing the tool's parameters (i.e. the desired output). */
  parametersSchema: object;
}

export interface AICompletionRequest {
  model: GoogleModel;
  system?: string;
  messages: AIMessage[];
  tools?: AITool[];
  maxOutputTokens?: number;
  temperature?: number;
  /**
   * Request thinking/reasoning mode for this single call, overriding the
   * provider's default. Honored by providers with a thinking toggle (DeepSeek);
   * ignored by the rest. Used by inline-ask to force reasoning on.
   */
  thinking?: boolean;
  /**
   * Tool-choice for a function-calling turn. Absent = the legacy "force the
   * single tool" behavior callStructured relies on (structured-output channel).
   * 'auto' lets the model pick; 'required' forces SOME tool; { force: name }
   * forces a specific tool (e.g. a terminal submit-verdict tool).
   */
  toolChoice?: 'auto' | 'required' | { force: string };
  signal?: AbortSignal;
  /**
   * Free-form metadata threaded through interceptors. `feature` is required
   * by the LoggingInterceptor and (later) MeteringInterceptor so they can
   * attribute cost to the right surface.
   */
  metadata?: {
    feature: AIFeatureId;
    promptId?: string;
    promptVersion?: number;
    [k: string]: unknown;
  };
}

export interface AIToolCall {
  /** Provider-assigned id, needed to thread the tool RESULT back (FC loop). */
  id?: string;
  name: string;
  arguments: unknown;
}

export interface AIUsage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from Gemini context cache, if any. */
  cachedTokens?: number;
}

export interface AICompletionResponse {
  /** Free-text content, when the model didn't (or wasn't forced to) call a tool. */
  text?: string;
  /** First tool call, if any. We force ANY-mode with a single allowed tool for structured output. */
  toolCall?: AIToolCall;
  /** All tool calls this turn (function-calling loop). `toolCall` is `toolCalls[0]`. */
  toolCalls?: AIToolCall[];
  usage: AIUsage;
  /** Raw provider response — kept for debugging, never relied on by upper layers. */
  raw?: unknown;
}

/**
 * One streamed chunk from `stream()`. Free-form text only (streaming is for
 * the interactive chat surface, never structured/tool output). `delta` is the
 * INCREMENTAL text for this chunk; `usage` is present only on the terminal
 * chunk, which may carry an empty delta.
 */
export interface AICompletionChunk {
  delta: string;
  usage?: AIUsage;
}

export type AIErrorKind =
  | 'auth' // 401/403 — bad or missing key
  | 'rate-limit' // 429
  | 'invalid-input' // Zod validation on the way in
  | 'parse' // Model output didn't fit the schema
  | 'network' // Transport / DNS / timeout
  | 'aborted' // AbortSignal fired
  | 'unknown';

export class AIError extends Error {
  constructor(
    public readonly kind: AIErrorKind,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AIError';
  }
}
