import { describe, expect, it, vi } from 'vitest';
import {
  agentProviderKeySource,
  canAgentProviderRun,
  type AgentProviderReadinessDependencies,
} from './agent-provider-readiness';

function dependencies(overrides: Partial<AgentProviderReadinessDependencies> = {}): AgentProviderReadinessDependencies {
  return {
    readEnvKey: () => undefined,
    hasStoredKey: vi.fn(async () => false),
    chatgptSignedIn: vi.fn(async () => false),
    ...overrides,
  };
}

describe('Agent provider readiness', () => {
  it('reads a development key before the Keychain', async () => {
    const deps = dependencies({ readEnvKey: (provider) => (provider === 'deepseek' ? 'sk-dev' : undefined) });
    await expect(agentProviderKeySource('deepseek', deps)).resolves.toBe('env');
    expect(deps.hasStoredKey).not.toHaveBeenCalled();
  });

  it('runs a key provider with a stored key and not without one', async () => {
    const deps = dependencies({ hasStoredKey: vi.fn(async (provider) => provider === 'anthropic') });
    await expect(agentProviderKeySource('anthropic', deps)).resolves.toBe('keychain');
    await expect(canAgentProviderRun('anthropic', deps)).resolves.toBe(true);
    await expect(canAgentProviderRun('deepseek', deps)).resolves.toBe(false);
  });

  it('runs the ChatGPT route only while signed in, whatever keys exist', async () => {
    const signedOut = dependencies({ hasStoredKey: vi.fn(async () => true) });
    await expect(canAgentProviderRun('openai-codex', signedOut)).resolves.toBe(false);
    const signedIn = dependencies({ chatgptSignedIn: vi.fn(async () => true) });
    await expect(canAgentProviderRun('openai-codex', signedIn)).resolves.toBe(true);
  });

  it('treats an unanswered Keychain or sign-in check as not ready', async () => {
    const deps = dependencies({
      hasStoredKey: () => {
        throw new Error('keychain unavailable');
      },
      chatgptSignedIn: async () => {
        throw new Error('native bridge unavailable');
      },
    });
    await expect(canAgentProviderRun('openai', deps)).resolves.toBe(false);
    await expect(canAgentProviderRun('openai-codex', deps)).resolves.toBe(false);
  });
});
