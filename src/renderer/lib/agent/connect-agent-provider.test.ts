import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});

import { AIError } from '../ai/types';
import {
  connectAgentProviderKey,
  selectAgentProvider,
  type ConnectAgentProviderDependencies,
} from './connect-agent-provider';

function fakes(test: () => Promise<void> = async () => undefined, saved = true) {
  const calls: string[] = [];
  const dependencies: ConnectAgentProviderDependencies = {
    setKey: async (provider, key) => { calls.push(`set:${provider}:${key}`); return saved; },
    clearKey: async (provider) => { calls.push(`clear:${provider}`); },
    test: async (provider) => { calls.push(`test:${provider}`); await test(); },
    select: (provider) => { calls.push(`select:${provider}`); },
    announce: () => { calls.push('announce'); },
  };
  return { calls, dependencies };
}

describe('connecting a model from the Agent panel', () => {
  it('keeps a key that passes its test and routes the composer to that provider', async () => {
    const { calls, dependencies } = fakes();
    await expect(connectAgentProviderKey('anthropic', '  sk-ant-1  ', dependencies)).resolves.toEqual({ ok: true });
    expect(calls).toEqual(['set:anthropic:sk-ant-1', 'test:anthropic', 'select:anthropic', 'announce']);
  });

  it('removes a rejected key and keeps the selection where it was', async () => {
    const { calls, dependencies } = fakes(async () => { throw new AIError('auth', 'bad key'); });
    await expect(connectAgentProviderKey('deepseek', 'sk-bad', dependencies)).resolves.toEqual({ ok: false, reason: 'auth' });
    expect(calls).toEqual(['set:deepseek:sk-bad', 'test:deepseek', 'clear:deepseek', 'announce']);
  });

  it('reports a failed request apart from a bad key', async () => {
    const { calls, dependencies } = fakes(async () => { throw new AIError('network', 'offline'); });
    await expect(connectAgentProviderKey('openai', 'sk-1', dependencies)).resolves.toEqual({ ok: false, reason: 'request' });
    expect(calls).toContain('clear:openai');
    expect(calls).not.toContain('select:openai');
  });

  it('stops when the keychain refuses the key, and ignores an empty paste', async () => {
    const refused = fakes(undefined, false);
    await expect(connectAgentProviderKey('openai', 'sk-1', refused.dependencies)).resolves.toEqual({ ok: false, reason: 'storage' });
    expect(refused.calls).toEqual(['set:openai:sk-1']);
    const empty = fakes();
    await expect(connectAgentProviderKey('openai', '   ', empty.dependencies)).resolves.toEqual({ ok: false, reason: 'empty' });
    expect(empty.calls).toEqual([]);
  });

  it('routes to a provider that can already run without touching any key', () => {
    const { calls, dependencies } = fakes();
    selectAgentProvider('openai-codex', dependencies);
    expect(calls).toEqual(['select:openai-codex', 'announce']);
  });
});
