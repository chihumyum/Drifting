/**
 * LLMClient — L2 transport facade.
 *
 * Wraps a provider with three pieces of "industrial-grade" behavior:
 *   1. Interceptor chain (cross-cutting: logging, metering, quota, cache, …)
 *   2. Retry-with-backoff for transient failures (rate limit, network)
 *   3. AbortSignal propagation (delegated to the provider's complete())
 *
 * Everything above this layer (Context, Prompt, Feature) interacts only with
 * this class. Provider swap (Google → Anthropic) only requires constructing
 * with a different provider.
 */
import type { LLMProvider } from './providers/provider';
import type { RequestInterceptor } from '../interceptors/interceptor';
import {
  AIError,
  type AICompletionChunk,
  type AICompletionRequest,
  type AICompletionResponse,
  type AIUsage,
} from '../types';
import { withRetry, type RetryConfig } from './retry';

export interface LLMClientOptions {
  retry?: RetryConfig;
}

export class LLMClient {
  private readonly interceptors: RequestInterceptor[] = [];

  constructor(
    private readonly provider: LLMProvider,
    private readonly options: LLMClientOptions = {},
  ) {}

  /** Register an interceptor. Order matters — registered first runs first in `before`. */
  use(interceptor: RequestInterceptor): this {
    this.interceptors.push(interceptor);
    return this;
  }

  /** Whether the underlying provider supports a real function-calling loop. */
  get supportsTools(): boolean {
    return this.provider.supportsTools === true;
  }

  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    let req = request;
    for (const it of this.interceptors) {
      const next = await it.before?.(req);
      if (next) req = next;
    }

    try {
      const res = await withRetry(
        () => this.provider.complete(req),
        isRetryable,
        this.options.retry,
        req.signal,
      );
      for (const it of this.interceptors) {
        try {
          await it.after?.(req, res);
        } catch (e) {
          // Observer interceptors must not affect business flow. Log and continue.
          console.warn('[ai] observer after() threw', e);
        }
      }
      return res;
    } catch (err) {
      for (const it of this.interceptors) {
        try {
          await it.onError?.(req, err);
        } catch (e) {
          console.warn('[ai] observer onError() threw', e);
        }
      }
      throw err;
    }
  }

  /**
   * Stream a free-form completion as incremental text chunks. Runs the same
   * interceptor chain as complete(): `before` hooks first, then on completion a
   * synthesized final response (accumulated text + usage) is handed to `after`
   * so the ai-log captures it exactly like a non-streaming call; `onError`
   * fires on failure. No retry — a mid-stream retry would replay partial text,
   * and this path is interactive (the user just re-asks). Providers without a
   * `stream()` fall back to one chunk wrapping `complete()`.
   */
  async *stream(request: AICompletionRequest): AsyncIterable<AICompletionChunk> {
    let req = request;
    for (const it of this.interceptors) {
      const next = await it.before?.(req);
      if (next) req = next;
    }

    let text = '';
    let usage: AIUsage | undefined;
    try {
      if (this.provider.stream) {
        for await (const chunk of this.provider.stream(req)) {
          if (chunk.delta) text += chunk.delta;
          if (chunk.usage) usage = chunk.usage;
          yield chunk;
        }
      } else {
        const res = await this.provider.complete(req);
        text = res.text ?? '';
        usage = res.usage;
        if (text) yield { delta: text };
        yield { delta: '', usage };
      }

      const finalRes: AICompletionResponse = {
        text,
        usage: usage ?? { inputTokens: 0, outputTokens: 0 },
      };
      for (const it of this.interceptors) {
        try {
          await it.after?.(req, finalRes);
        } catch (e) {
          console.warn('[ai] observer after() threw', e);
        }
      }
    } catch (err) {
      for (const it of this.interceptors) {
        try {
          await it.onError?.(req, err);
        } catch (e) {
          console.warn('[ai] observer onError() threw', e);
        }
      }
      throw err;
    }
  }
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof AIError)) return false;
  return err.kind === 'rate-limit' || err.kind === 'network';
}
