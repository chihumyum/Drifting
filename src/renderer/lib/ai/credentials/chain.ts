/**
 * Chain credentials — tries a sequence of providers in order, returning the
 * first one that succeeds. Used by the dev console to prefer env keys (for
 * smooth dev iteration) while falling back to the OS keychain in production.
 *
 * Order matters. If two providers are configured (env *and* keychain) the
 * first wins — that's deliberate: env is the explicit override.
 */
import type { BYOKProvider } from '../../byok-keychain';
import { AIError } from '../types';
import type { CredentialsMode, CredentialsProvider } from './credentials-provider';

export class ChainCredentialsProvider implements CredentialsProvider {
  readonly mode: CredentialsMode;

  constructor(private readonly providers: readonly CredentialsProvider[]) {
    if (providers.length === 0) {
      throw new Error('[ai] ChainCredentialsProvider requires at least one provider');
    }
    // The chain's "mode" surfaces the first provider's mode for telemetry.
    // Callers who care which one actually served a key can inspect the
    // (future) UsageEvent.credentialsMode field.
    this.mode = providers[0]!.mode;
  }

  async getApiKey(provider: BYOKProvider): Promise<string> {
    let lastErr: unknown;
    for (const p of this.providers) {
      try {
        return await p.getApiKey(provider);
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr instanceof AIError) throw lastErr;
    throw new AIError(
      'auth',
      `No credentials provider in the chain could resolve a key for "${provider}".`,
      lastErr,
    );
  }
}
