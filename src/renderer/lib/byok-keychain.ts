/**
 * BYOK keychain — thin renderer-side facade over the main-process
 * `@napi-rs/keyring` handlers in `keyring-ipc.ts`. The renderer never
 * sees the raw secret in memory longer than necessary, and nothing ever
 * lands in localStorage or the Zustand persist payload.
 *
 * Key naming: `byok.<provider>` is the canonical id. Add a provider by
 * extending the union; old ids stay valid (keychain entries are by string).
 */

export type BYOKProvider = 'anthropic' | 'openai' | 'google' | 'deepseek';

function keyOf(provider: BYOKProvider): string {
  return `byok.${provider}`;
}

export const byokKeychain = {
  async get(provider: BYOKProvider): Promise<string | null> {
    if (!window.electronAPI?.keychain) return null;
    return window.electronAPI.keychain.get(keyOf(provider));
  },
  async set(provider: BYOKProvider, value: string): Promise<boolean> {
    if (!window.electronAPI?.keychain) return false;
    return window.electronAPI.keychain.set(keyOf(provider), value);
  },
  async clear(provider: BYOKProvider): Promise<boolean> {
    if (!window.electronAPI?.keychain) return false;
    return window.electronAPI.keychain.delete(keyOf(provider));
  },
};

/**
 * The General Agent (Claude Agent SDK) Anthropic API key — pay-as-you-go,
 * separate from copilot's per-provider `byok.<provider>` keys. The SDK reads
 * it as ANTHROPIC_API_KEY (resolved in the main process; see
 * `main/agent/runtime.ts`). Kept under its own id so it never collides with
 * copilot's anthropic BYOK key.
 */
export const AGENT_API_KEY_ID = 'byok.agent.anthropic';

export const agentApiKeychain = {
  async get(): Promise<string | null> {
    if (!window.electronAPI?.keychain) return null;
    return window.electronAPI.keychain.get(AGENT_API_KEY_ID);
  },
  async set(value: string): Promise<boolean> {
    if (!window.electronAPI?.keychain) return false;
    return window.electronAPI.keychain.set(AGENT_API_KEY_ID, value);
  },
  async clear(): Promise<boolean> {
    if (!window.electronAPI?.keychain) return false;
    return window.electronAPI.keychain.delete(AGENT_API_KEY_ID);
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
