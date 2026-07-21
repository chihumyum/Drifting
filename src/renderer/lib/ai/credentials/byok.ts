/**
 * BYOK credentials — thin wrapper over the existing byok-keychain facade.
 *
 * The actual secret lives in the OS keychain through the typed Tauri platform
 * adapter (see ../../byok-keychain.ts). This class adds only the
 * CredentialsProvider contract so it can later be swapped with a hosted
 * provider without touching call sites.
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
