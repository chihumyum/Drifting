/**
 * Shared bounded pre-effect retry boundary for every Agent model driver.
 *
 * The invariant follows `AgentModelDriverError.retryable`: a provider attempt
 * may be resampled only while no tool call, usage, assistant block, or UI
 * activity has escaped to the runtime. Tool-capable iterations therefore
 * buffer and validate the complete stream before publishing any Agent event;
 * tool-free synthesis streams progressively and is never resampled, because
 * replaying visible prose would duplicate author-facing output.
 */
import { DEFAULT_RETRY, withRetry, type RetryConfig } from '../../../ai/client/retry';
import { AIError } from '../../../ai/types';
import { AgentModelDriverError } from '../errors';
import type { AgentModelStreamEvent } from '../types';

export const DEFAULT_PROVIDER_ATTEMPT_RETRY: RetryConfig = {
  ...DEFAULT_RETRY,
  maxAttempts: 6,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
};

export function isRetryableProviderAttemptError(error: unknown): boolean {
  if (error instanceof AIError) {
    return error.kind === 'parse' || error.kind === 'network' || error.kind === 'rate-limit';
  }
  return error instanceof AgentModelDriverError && error.retryable;
}

/**
 * Parse an HTTP `Retry-After` response header into a delay hint. Returns
 * undefined for absent or unusable values; HTTP-date forms resolve against
 * the current clock.
 */
export function retryAfterMsFromHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return undefined;
  const delta = dateMs - Date.now();
  return delta > 0 ? delta : undefined;
}

/**
 * Run one buffered tool-capable provider attempt per retry lease. Nothing is
 * published until an attempt's stream completes, so a retryable failure has
 * let no event escape and a fresh sample is safe.
 */
export async function streamProviderAttemptWithRetry(
  makeAttempt: () => AsyncIterable<AgentModelStreamEvent>,
  retry: RetryConfig,
  signal: AbortSignal,
): Promise<AgentModelStreamEvent[]> {
  const runAttempt = async () => {
    const events: AgentModelStreamEvent[] = [];
    for await (const event of makeAttempt()) events.push(event);
    return events;
  };
  // An already-cancelled request must surface the driver's own public
  // cancellation error, not the retry helper's generic pre-check message.
  if (signal.aborted) return runAttempt();
  return withRetry(runAttempt, isRetryableProviderAttemptError, retry, signal);
}
