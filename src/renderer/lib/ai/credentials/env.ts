/**
 * Env credentials — reads API keys from Vite environment variables.
 *
 * Intended for **development convenience only**. The development launchers
 * read `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` from the ignored `.env` /
 * `.env.local` and hand them to the dev server under these names
 * (scripts/dev-agent-keys.mjs), so every fresh development profile starts
 * connected. Vite inlines `import.meta.env.VITE_*` at build time, so never
 * commit a real key — and never ship a production build with one set.
 *
 * Looked up per provider (first match wins):
 *   google    →  VITE_GOOGLE_AI_API_KEY  |  VITE_GEMINI_API_KEY
 *   anthropic →  VITE_ANTHROPIC_API_KEY
 *   openai    →  VITE_OPENAI_API_KEY
 *   deepseek  →  VITE_DEEPSEEK_AI_API_KEY  |  VITE_DEEPSEEK_API_KEY
 */
import type { BYOKProvider } from '../../byok-keychain';
import { AIError } from '../types';
import type { CredentialsMode, CredentialsProvider } from './credentials-provider';
import { runtimeViteEnv } from '../../vite-runtime-env';

export class EnvCredentialsProvider implements CredentialsProvider {
  readonly mode: CredentialsMode = 'byok';

  async getApiKey(provider: BYOKProvider): Promise<string> {
    const key = readEnvApiKey(provider);
    if (!key) {
      throw new AIError(
        'auth',
        `No env key configured for "${provider}". Set one of: ${envNames(provider).join(', ')}.`,
      );
    }
    return key;
  }
}

/** The development key for `provider`, if the dev server was given one. */
export function readEnvApiKey(provider: BYOKProvider): string | undefined {
  const env = runtimeViteEnv as Record<string, string | undefined>;
  for (const name of envNames(provider)) {
    const v = env[name];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function envNames(provider: BYOKProvider): string[] {
  switch (provider) {
    case 'google':
      return ['VITE_GOOGLE_AI_API_KEY', 'VITE_GEMINI_API_KEY'];
    case 'anthropic':
      return ['VITE_ANTHROPIC_API_KEY'];
    case 'openai':
      return ['VITE_OPENAI_API_KEY'];
    case 'deepseek':
      return ['VITE_DEEPSEEK_AI_API_KEY', 'VITE_DEEPSEEK_API_KEY'];
  }
}
