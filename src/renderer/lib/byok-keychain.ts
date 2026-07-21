/**
 * BYOK keychain — thin renderer-side facade over Tauri secure-storage
 * commands. The renderer never
 * sees the raw secret in memory longer than necessary, and nothing ever
 * lands in localStorage or the Zustand persist payload.
 *
 * Key naming: `byok.<provider>` is the canonical id. Add a provider by
 * extending the union; old ids stay valid (keychain entries are by string).
 */

import { platform } from '../platform';

export type BYOKProvider = 'anthropic' | 'openai' | 'google' | 'deepseek';

function keyOf(provider: BYOKProvider): string {
  return `byok.${provider}`;
}

// Settings has several consumers for the active provider (provider row,
// Copilot warning, Shadow status), and React Strict Mode intentionally mounts
// effects twice in development. Coalesce only concurrent reads so one logical
// lookup produces one OS prompt without retaining secrets beyond the caller's
// own lifetime.
const pendingReads = new Map<string, Promise<string | null>>();

function readSecret(key: string): Promise<string | null> {
  const pending = pendingReads.get(key);
  if (pending) return pending;

  const read = Promise.resolve().then(() => platform.keychain.get(key));
  pendingReads.set(key, read);
  const clear = () => {
    if (pendingReads.get(key) === read) pendingReads.delete(key);
  };
  void read.then(clear, clear);
  return read;
}

export const byokKeychain = {
  async get(provider: BYOKProvider): Promise<string | null> {
    return readSecret(keyOf(provider));
  },
  async set(provider: BYOKProvider, value: string): Promise<boolean> {
    return platform.keychain.set(keyOf(provider), value);
  },
  async clear(provider: BYOKProvider): Promise<boolean> {
    return platform.keychain.delete(keyOf(provider));
  },
};

/**
 * Reserved Anthropic API key for a future General Agent transport. It remains
 * separate from Copilot's per-provider `byok.<provider>` keys and is not read by
 * the current unsupported transport.
 */
export const AGENT_API_KEY_ID = 'byok.agent.anthropic';

export const agentApiKeychain = {
  async get(): Promise<string | null> {
    return readSecret(AGENT_API_KEY_ID);
  },
  async set(value: string): Promise<boolean> {
    return platform.keychain.set(AGENT_API_KEY_ID, value);
  },
  async clear(): Promise<boolean> {
    return platform.keychain.delete(AGENT_API_KEY_ID);
  },
};

/**
 * Mask helper — UI-only. Renders the last 4 chars so users can confirm
 * which key they actually saved.
 */
export function maskBYOK(raw: string | null): string {
  if (!raw) return '';
  const tail = raw.length > 4 ? raw.slice(-4) : raw;
  return `${'•'.repeat(Math.max(6, Math.min(20, raw.length - 4)))}${tail}`;
}
