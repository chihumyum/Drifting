/**
 * CredentialsProvider — abstraction over "where does my API key come from".
 *
 * Public local-only builds use BYOK from native secure storage via
 * byok-keychain.ts. A separately operated compatible service may implement a
 * hosted credential contract, but renderer-local Copilot never silently falls
 * back to it.
 */
import type { BYOKProvider } from '../../byok-keychain';

export type CredentialsMode = 'byok' | 'hosted';

export interface CredentialsProvider {
  readonly mode: CredentialsMode;
  /** Resolve the API key for the given AI provider. Throws if not configured. */
  getApiKey(provider: BYOKProvider): Promise<string>;
}
