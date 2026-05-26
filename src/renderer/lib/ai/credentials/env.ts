/**
 * Env credentials — reads API keys from Vite environment variables.
 *
 * Intended for **development convenience only**: drop your key into
 * `.env.local` so dev console smoke tests work without poking the keychain
 * every restart. Vite inlines `import.meta.env.VITE_*` at build time, so
 * never commit a real key — and never ship a production build with one set.
 *
 * Looked up per provider (first match wins):
 *   google    →  VITE_GOOGLE_AI_API_KEY  |  VITE_GEMINI_API_KEY
 *   anthropic →  VITE_ANTHROPIC_API_KEY
 *   openai    →  VITE_OPENAI_API_KEY
 */
import type { BYOKProvider } from '../../byok-keychain';
import { AIError } from '../types';
import type { CredentialsMode, CredentialsProvider } from './credentials-provider';

export class EnvCredentialsProvider implements CredentialsProvider {
  readonly mode: CredentialsMode = 'byok';

  async getApiKey(provider: BYOKProvider): Promise<string> {
    const key = readEnvKey(provider);
    if (!key) {
      throw new AIError(
        'auth',
        `No env key configured for "${provider}". Set one of: ${envNames(provider).join(', ')}.`,
      );
    }
    return key;
  }
}

function readEnvKey(provider: BYOKProvider): string | undefined {
  const env = import.meta.env as Record<string, string | undefined>;
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
  }
}
