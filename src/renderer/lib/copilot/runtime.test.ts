import { describe, expect, it, vi } from 'vitest';

import type { BYOKProvider } from '../byok-keychain';
import type { LLMClient } from '../ai/client/llm-client';
import { CopilotRuntimeImpl } from './runtime';

function client(id: string): LLMClient {
  return { providerId: id } as LLMClient;
}

describe('CopilotRuntimeImpl', () => {
  it('reuses one client until the author selects a different provider', async () => {
    let provider: BYOKProvider = 'deepseek';
    const clients = {
      deepseek: client('deepseek'),
      google: client('google-ai-studio'),
    };
    const buildClient = vi.fn(async (selected: BYOKProvider) =>
      selected === 'google' ? clients.google : clients.deepseek,
    );
    const runtime = new CopilotRuntimeImpl({ getProvider: () => provider, buildClient });

    await expect(runtime.getClient()).resolves.toBe(clients.deepseek);
    await expect(runtime.getClient()).resolves.toBe(clients.deepseek);
    expect(buildClient).toHaveBeenCalledTimes(1);

    provider = 'google';
    await expect(runtime.getClient()).resolves.toBe(clients.google);
    expect(buildClient).toHaveBeenNthCalledWith(2, 'google');
  });

  it('honors an already captured provider route instead of re-reading Settings', async () => {
    const deepseek = client('deepseek');
    const buildClient = vi.fn(async () => deepseek);
    const runtime = new CopilotRuntimeImpl({
      getProvider: () => 'google',
      buildClient,
    });

    await expect(runtime.getClient('deepseek')).resolves.toBe(deepseek);
    expect(buildClient).toHaveBeenCalledWith('deepseek');
  });

  it('does not let an old provider failure evict the newer provider client', async () => {
    let provider: BYOKProvider = 'deepseek';
    let rejectDeepSeek: (error: Error) => void = () => undefined;
    const google = client('google-ai-studio');
    const buildClient = vi.fn((selected: BYOKProvider): Promise<LLMClient> => {
      if (selected === 'google') return Promise.resolve(google);
      return new Promise((_resolve, reject) => {
        rejectDeepSeek = reject;
      });
    });
    const runtime = new CopilotRuntimeImpl({ getProvider: () => provider, buildClient });

    const oldRequest = runtime.getClient();
    const oldFailure = expect(oldRequest).rejects.toThrow('old provider failed');
    provider = 'google';
    await expect(runtime.getClient()).resolves.toBe(google);

    rejectDeepSeek(new Error('old provider failed'));
    await oldFailure;
    await expect(runtime.getClient()).resolves.toBe(google);
    expect(buildClient).toHaveBeenCalledTimes(2);
  });

  it('re-arms the active route after failure or an explicit credential reset', async () => {
    const ready = client('anthropic');
    const buildClient = vi
      .fn<() => Promise<LLMClient>>()
      .mockRejectedValueOnce(new Error('bad key'))
      .mockResolvedValue(ready);
    const runtime = new CopilotRuntimeImpl({
      getProvider: () => 'anthropic',
      buildClient,
    });

    await expect(runtime.getClient()).rejects.toThrow('bad key');
    await expect(runtime.getClient()).resolves.toBe(ready);
    runtime.resetClient();
    await expect(runtime.getClient()).resolves.toBe(ready);
    expect(buildClient).toHaveBeenCalledTimes(3);
  });
});
