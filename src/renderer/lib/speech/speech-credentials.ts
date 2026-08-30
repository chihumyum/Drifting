/**
 * Speech transcription credential — a keychain slot separate from the
 * `BYOKProvider` union on purpose: widening that union would silently add the
 * vendor to the Copilot provider picker and several exhaustive maps. The
 * transcription key is not an LLM credential; it only unlocks voice capture.
 *
 * Key naming follows the `byok.<provider>` keychain convention, so the Rust
 * secure-storage layer needs no changes.
 */

import { platform } from '../../platform';
import { runtimeViteEnv } from '../vite-runtime-env';

export type SpeechProviderId = 'dashscope';

const KEY_ID = 'byok.dashscope';

/** Dev convenience only, mirroring the LLM EnvCredentialsProvider. */
function envSpeechApiKey(): string | undefined {
  const env = runtimeViteEnv as Record<string, string | undefined>;
  const value = env.VITE_DASHSCOPE_API_KEY;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export const speechKeychain = {
  async has(): Promise<boolean> {
    if (envSpeechApiKey()) return true;
    return platform.keychain.has(KEY_ID);
  },
  async get(): Promise<string | null> {
    const fromEnv = envSpeechApiKey();
    if (fromEnv) return fromEnv;
    return platform.keychain.get(KEY_ID);
  },
  async set(value: string): Promise<boolean> {
    return platform.keychain.set(KEY_ID, value);
  },
  async clear(): Promise<boolean> {
    return platform.keychain.delete(KEY_ID);
  },
};
