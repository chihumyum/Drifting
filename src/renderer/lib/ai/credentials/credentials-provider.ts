/**
 * CredentialsProvider — abstraction over "where does my API key come from".
 *
 * Phase 0 ships only BYOK (the OS keychain via byok-keychain.ts).
 * Phase 4 will add a Hosted implementation that exchanges a better-auth
 * session for a short-lived proxy token. Upstream callers never know which
 * mode is active; they just ask for a key.
 */
import type { BYOKProvider } from '../../byok-keychain';

export type CredentialsMode = 'byok' | 'hosted';

export interface CredentialsProvider {
  readonly mode: CredentialsMode;
  /** Resolve the API key for the given AI provider. Throws if not configured. */
  getApiKey(provider: BYOKProvider): Promise<string>;
}
