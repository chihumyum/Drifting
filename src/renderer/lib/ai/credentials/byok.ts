/**
 * BYOK credentials — thin wrapper over the existing byok-keychain facade.
 *
 * The actual secret lives in the OS keychain via the main-process
 * `@napi-rs/keyring` bindings (see ../../byok-keychain.ts and
 * src/main/keyring-ipc.ts). This class adds nothing on top of that flow
 * except the CredentialsProvider contract — its job is to be swappable with
 * the future HostedCredentialsProvider without touching call sites.
 */
import { byokKeychain, type BYOKProvider } from '../../byok-keychain';
import { AIError } from '../types';
import type { CredentialsMode, CredentialsProvider } from './credentials-provider';

export class BYOKCredentialsProvider implements CredentialsProvider {
  readonly mode: CredentialsMode = 'byok';

  async getApiKey(provider: BYOKProvider): Promise<string> {
    const key = await byokKeychain.get(provider);
    if (!key) {
      throw new AIError(
        'auth',
        `No BYOK key configured for provider "${provider}". Set one in Settings > AI.`,
      );
    }
    return key;
  }
}
