/**
 * BYOK keychain — thin renderer-side facade over the main-process
 * `@napi-rs/keyring` handlers in `keyring-ipc.ts`. The renderer never
 * sees the raw secret in memory longer than necessary, and nothing ever
 * lands in localStorage or the Zustand persist payload.
 *
 * Key naming: `byok.<provider>` is the canonical id. Add a provider by
 * extending the union; old ids stay valid (keychain entries are by string).
 */

export type BYOKProvider = 'anthropic' | 'openai' | 'google';

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
 * Mask helper — UI-only. Renders the last 4 chars so users can confirm
 * which key they actually saved.
 */
export function maskBYOK(raw: string | null): string {
  if (!raw) return '';
  const tail = raw.length > 4 ? raw.slice(-4) : raw;
  return `${'•'.repeat(Math.max(6, Math.min(20, raw.length - 4)))}${tail}`;
}
