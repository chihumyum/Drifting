/**
 * Whether an Agent provider can be called right now, without decrypting a key:
 * a development `.env` key or a Keychain entry for a key provider, the native
 * ChatGPT sign-in for the subscription route. The Agent panel's connect rows
 * and the background check-in and organize passes read the same answer.
 */
import { byokKeychain, type BYOKProvider } from '../byok-keychain';
import { readEnvApiKey } from '../ai/credentials/env';
import { codexSubscription } from '../codex-subscription';
import type { AgentProviderId } from './runtime/agent-provider-contract';

export type AgentProviderKeySource = 'env' | 'keychain';

export interface AgentProviderReadinessDependencies {
  readEnvKey(provider: BYOKProvider): string | undefined;
  hasStoredKey(provider: BYOKProvider): Promise<boolean>;
  chatgptSignedIn(): Promise<boolean>;
}

const DEFAULT_DEPENDENCIES: AgentProviderReadinessDependencies = {
  readEnvKey: readEnvApiKey,
  hasStoredKey: (provider) => byokKeychain.has(provider),
  chatgptSignedIn: async () => (await codexSubscription.status()).signedIn === true,
};

/** Where a key provider's key comes from, or null when it has none. */
export async function agentProviderKeySource(
  provider: BYOKProvider,
  dependencies: AgentProviderReadinessDependencies = DEFAULT_DEPENDENCIES,
): Promise<AgentProviderKeySource | null> {
  if (dependencies.readEnvKey(provider)) return 'env';
  const stored = await Promise.resolve()
    .then(() => dependencies.hasStoredKey(provider))
    .catch(() => false);
  return stored ? 'keychain' : null;
}

/** Whether the Agent can call `provider` now. Unknown answers count as no. */
export async function canAgentProviderRun(
  provider: AgentProviderId,
  dependencies: AgentProviderReadinessDependencies = DEFAULT_DEPENDENCIES,
): Promise<boolean> {
  if (provider === 'openai-codex') {
    return Promise.resolve()
      .then(() => dependencies.chatgptSignedIn())
      .catch(() => false);
  }
  return (await agentProviderKeySource(provider, dependencies)) !== null;
}

export type AgentProviderReadiness = Partial<Record<AgentProviderId, boolean>>;

/** Every listed provider's answer at once, for the model menu. */
export async function readAgentProviderReadiness(
  providers: readonly AgentProviderId[],
  dependencies: AgentProviderReadinessDependencies = DEFAULT_DEPENDENCIES,
): Promise<AgentProviderReadiness> {
  const answers = await Promise.all(
    providers.map((provider) => canAgentProviderRun(provider, dependencies)),
  );
  return Object.fromEntries(providers.map((provider, index) => [provider, answers[index]]));
}

/**
 * A provider's models can be chosen unless the check said it has no usable
 * credential; one not answered yet stays choosable so a slow check never
 * blocks a choice.
 */
export function isAgentProviderSelectable(
  readiness: AgentProviderReadiness,
  provider: AgentProviderId,
): boolean {
  return readiness[provider] !== false;
}
