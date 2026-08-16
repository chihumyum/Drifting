export const SYNC_RETRY_BASE_MS = 1_000;
export const SYNC_RETRY_CAP_MS = 5 * 60_000;

export function fullJitterBackoffMs(input: {
  readonly failureAttempt: number;
  readonly random: () => number;
  readonly retryAfterMs?: number;
}): number {
  if (!Number.isSafeInteger(input.failureAttempt) || input.failureAttempt < 0) {
    throw new RangeError('failureAttempt must be a non-negative safe integer');
  }
  const random = input.random();
  if (!Number.isFinite(random) || random < 0 || random >= 1) {
    throw new RangeError('random must return a finite value in [0, 1)');
  }
  if (
    input.retryAfterMs !== undefined &&
    (!Number.isSafeInteger(input.retryAfterMs) || input.retryAfterMs < 0)
  ) {
    throw new RangeError('retryAfterMs must be a non-negative safe integer');
  }
  const exponent = Math.min(input.failureAttempt, 30);
  const ceiling = Math.min(SYNC_RETRY_CAP_MS, SYNC_RETRY_BASE_MS * 2 ** exponent);
  const jitter = Math.floor(random * ceiling);
  return Math.max(jitter, input.retryAfterMs ?? 0);
}
