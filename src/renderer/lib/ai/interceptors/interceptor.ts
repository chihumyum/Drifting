/**
 * RequestInterceptor — cross-cutting hook contract for the substrate.
 *
 * Same pattern as Axios interceptors (see ../../axios-config.ts) and as
 * web-framework middleware in general. Each request flows through the
 * registered interceptor chain in order: `before` may mutate or block,
 * `after`/`onError` are observer hooks that must not throw.
 *
 * Concrete kinds we'll add over Phase 0-3:
 * - LoggingInterceptor  (observer)
 * - MeteringInterceptor (observer — writes UsageEvent rows)
 * - CacheInterceptor    (short-circuit before, write through after)
 * - QuotaInterceptor    (gate — may throw to block)
 * - BudgetInterceptor   (gate — checks single-request estimated cost)
 *
 * Design rule: gates throw, observers never throw. The LLMClient already
 * wraps observer hooks in try/catch to defend against accidental throws,
 * but implementations should treat that as belt-and-suspenders.
 */
import type { AICompletionRequest, AICompletionResponse } from '../types';

export interface RequestInterceptor {
  /**
   * Run before the provider sees the request. Return a new request to
   * replace the in-flight one, void to leave it unchanged, or throw to
   * block (used by Quota/Budget gates).
   */
  before?(
    req: AICompletionRequest,
  ): Promise<AICompletionRequest | void> | AICompletionRequest | void;

  /** Observer — runs after a successful response. Must not throw. */
  after?(req: AICompletionRequest, res: AICompletionResponse): Promise<void> | void;

  /** Observer — runs after a failed request. Must not throw. */
  onError?(req: AICompletionRequest, err: unknown): Promise<void> | void;
}
