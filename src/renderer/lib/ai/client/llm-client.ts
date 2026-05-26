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
import { AIError, type AICompletionRequest, type AICompletionResponse } from '../types';
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
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof AIError)) return false;
  return err.kind === 'rate-limit' || err.kind === 'network';
}
