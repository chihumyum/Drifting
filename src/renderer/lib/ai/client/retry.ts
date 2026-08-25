/**
 * Exponential backoff with jitter — the canonical "don't hammer a recovering
 * service" pattern. We retry only on errors the caller marks retryable (e.g.
 * rate-limit, network); auth and parse errors are surfaced immediately.
 *
 * Theory: AWS Architecture blog "Exponential Backoff And Jitter". Jitter
 * matters because synchronized retries from many clients defeat the purpose
 * of backoff — staggering avoids the thundering-herd second wave.
 */
import { AIError } from '../types';

export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
}

export const DEFAULT_RETRY: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  jitter: true,
};

/**
 * A provider `Retry-After` hint on the error wins over shorter computed
 * backoff, capped so a hostile header cannot park a turn for minutes.
 */
const MAX_RETRY_AFTER_HINT_MS = 60_000;

function retryAfterHintMs(err: unknown): number | null {
  const value = (err as { retryAfterMs?: unknown } | null | undefined)?.retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export async function withRetry<T>(
  task: () => Promise<T>,
  shouldRetry: (err: unknown) => boolean,
  config: RetryConfig = DEFAULT_RETRY,
  signal?: AbortSignal,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
    if (signal?.aborted) throw new AIError('aborted', 'Aborted before retry');
    try {
      return await task();
    } catch (err) {
      lastErr = err;
      const lastAttempt = attempt === config.maxAttempts - 1;
      if (lastAttempt || !shouldRetry(err)) throw err;
      const exp = Math.min(config.baseDelayMs * 2 ** attempt, config.maxDelayMs);
      const backoff = config.jitter ? exp * (0.5 + Math.random() * 0.5) : exp;
      const hinted = retryAfterHintMs(err);
      const delay =
        hinted === null ? backoff : Math.max(backoff, Math.min(hinted, MAX_RETRY_AFTER_HINT_MS));
      await sleepAbortable(delay, signal);
    }
  }
  throw lastErr;
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AIError('aborted', 'Aborted during retry wait'));
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new AIError('aborted', 'Aborted during retry wait'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
