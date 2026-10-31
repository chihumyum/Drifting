/**
 * Connect a model from the Agent panel's first run.
 *
 * The panel may only add a key and test it; editing, testing again and
 * removing keys stay in Settings → Models & API. A key is kept only after its
 * connection test passes, and the composer then routes to that provider, so a
 * new key never sits next to a selection that still points elsewhere.
 */
import { byokKeychain, type BYOKProvider } from '../byok-keychain';
import { testByokProviderConnection } from '../ai/test-provider-connection';
import { events } from '../events';
import { useSettingsStore, type AgentProviderId } from '../../store/settings-store';

export type ConnectAgentProviderResult =
  | { ok: true }
  | { ok: false; reason: 'empty' | 'storage' | 'auth' | 'request' };

export interface ConnectAgentProviderDependencies {
  /** False when the system keychain refused the key. */
  setKey(provider: BYOKProvider, key: string): Promise<boolean>;
  clearKey(provider: BYOKProvider): Promise<void>;
  test(provider: BYOKProvider): Promise<void>;
  select(provider: AgentProviderId): void;
  /** Tell the panel and Settings that credentials changed. */
  announce(): void;
}

const DEFAULT_DEPENDENCIES: ConnectAgentProviderDependencies = {
  setKey: (provider, key) => byokKeychain.set(provider, key),
  clearKey: async (provider) => { await byokKeychain.clear(provider); },
  test: (provider) => testByokProviderConnection(provider, { signal: new AbortController().signal }),
  select: (provider) => useSettingsStore.getState().setAgentProvider(provider),
  announce: () => {
    events.emit('byok:keys-changed');
    events.emit('agent:auth-changed');
  },
};

/** Route the composer to a provider that can already run (a stored key, a sign-in). */
export function selectAgentProvider(
  provider: AgentProviderId,
  dependencies: Pick<ConnectAgentProviderDependencies, 'select' | 'announce'> = DEFAULT_DEPENDENCIES,
): void {
  dependencies.select(provider);
  dependencies.announce();
}

/** Store a pasted key, test it once, and keep it only if the test passes. */
export async function connectAgentProviderKey(
  provider: BYOKProvider,
  key: string,
  dependencies: ConnectAgentProviderDependencies = DEFAULT_DEPENDENCIES,
): Promise<ConnectAgentProviderResult> {
  const value = key.trim();
  if (!value) return { ok: false, reason: 'empty' };
  if (!(await dependencies.setKey(provider, value))) return { ok: false, reason: 'storage' };
  try {
    await dependencies.test(provider);
  } catch (error) {
    await dependencies.clearKey(provider).catch(() => undefined);
    dependencies.announce();
    return { ok: false, reason: (error as { kind?: string } | null)?.kind === 'auth' ? 'auth' : 'request' };
  }
  selectAgentProvider(provider, dependencies);
  return { ok: true };
}
