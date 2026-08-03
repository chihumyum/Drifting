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
const LEGACY_AGENT_ANTHROPIC_KEY_ID = 'byok.agent.anthropic';

function keyOf(provider: BYOKProvider): string {
  return `byok.${provider}`;
}

// Settings has several consumers for the active provider (provider row,
// Copilot warning, Shadow status), and React Strict Mode intentionally mounts
// effects twice in development. Coalesce only concurrent reads so one logical
// lookup produces one OS prompt without retaining secrets beyond the caller's
// own lifetime.
const pendingReads = new Map<string, Promise<string | null>>();
let pendingLegacyAnthropicMigration: Promise<string | null> | null = null;

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
    const current = await readSecret(keyOf(provider));
    if (current || provider !== 'anthropic') return current;
    return migrateLegacyAgentAnthropicKey();
  },
  async set(provider: BYOKProvider, value: string): Promise<boolean> {
    const saved = await platform.keychain.set(keyOf(provider), value);
    if (saved && provider === 'anthropic') {
      await platform.keychain.delete(LEGACY_AGENT_ANTHROPIC_KEY_ID);
    }
    return saved;
  },
  async clear(provider: BYOKProvider): Promise<boolean> {
    const cleared = await platform.keychain.delete(keyOf(provider));
    if (provider === 'anthropic') {
      const legacyCleared = await platform.keychain.delete(LEGACY_AGENT_ANTHROPIC_KEY_ID);
      return cleared || legacyCleared;
    }
    return cleared;
  },
};

/**
 * Old desktop builds stored General Agent's Anthropic key separately. Fold it
 * into the global provider credential on first read, then remove the obsolete
 * entry. The in-flight promise is cleared after settlement so the secret is not
 * retained by this module.
 */
function migrateLegacyAgentAnthropicKey(): Promise<string | null> {
  if (pendingLegacyAnthropicMigration) return pendingLegacyAnthropicMigration;
  const migration = (async () => {
    const legacy = await readSecret(LEGACY_AGENT_ANTHROPIC_KEY_ID);
    if (!legacy) return null;
    const saved = await platform.keychain.set(keyOf('anthropic'), legacy);
    if (saved) await platform.keychain.delete(LEGACY_AGENT_ANTHROPIC_KEY_ID);
    return saved ? legacy : null;
  })();
  pendingLegacyAnthropicMigration = migration;
  const clear = () => {
    if (pendingLegacyAnthropicMigration === migration) {
      pendingLegacyAnthropicMigration = null;
    }
  };
  void migration.then(clear, clear);
  return migration;
}

/**
 * Mask helper — UI-only. Renders the last 4 chars so users can confirm
 * which key they actually saved.
 */
export function maskBYOK(raw: string | null): string {
  if (!raw) return '';
  const tail = raw.length > 4 ? raw.slice(-4) : raw;
  return `${'•'.repeat(Math.max(6, Math.min(20, raw.length - 4)))}${tail}`;
}
