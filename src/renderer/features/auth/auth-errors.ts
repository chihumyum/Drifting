import type { TFunction } from 'i18next';

// The Hosted service answers these when verification mail cannot go out
// (its docs/mail-pool-v1.md). The copy says writing never needs an account.
const MAIL_UNAVAILABLE: Record<string, string> = {
  MAIL_QUOTA_EXHAUSTED: 'auth.errors.mailQuotaExhausted',
  MAIL_DELIVERY_FAILED: 'auth.errors.mailDeliveryFailed',
};

/** What to tell the author about a failed auth request. */
export function authErrorMessage(
  error: { code?: string; message?: string },
  t: TFunction,
  fallbackKey: string,
): string {
  const key = error.code ? MAIL_UNAVAILABLE[error.code] : undefined;
  return key ? t(key) : error.message || t(fallbackKey);
}
