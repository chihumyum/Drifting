import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BYOKProvider } from '../../byok-keychain';
import {
  buildDirectBYOKClient,
  buildGeneralAgentClient,
  isProxyTransport,
} from './build-default-client';

describe('direct BYOK client factory', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['deepseek', 'deepseek'],
    ['anthropic', 'anthropic'],
    ['openai', 'openai'],
    ['google', 'google-ai-studio'],
  ] as const)('builds the explicitly selected %s adapter', (provider, providerId) => {
    const client = buildDirectBYOKClient(provider as BYOKProvider, 'synthetic-test-key');
    expect(client.providerId).toBe(providerId);
  });

  it('does not enable the hosted proxy in the default local-only build', () => {
    expect(isProxyTransport()).toBe(false);
  });

  it('rejects General Agent provider construction before reading credentials while offline', async () => {
    vi.stubGlobal('navigator', { onLine: false });

    await expect(buildGeneralAgentClient()).rejects.toMatchObject({ kind: 'network' });
  });

  it('rechecks the BYOK capability immediately before a request', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    const client = buildDirectBYOKClient('deepseek', 'synthetic-test-key');
    vi.stubGlobal('navigator', { onLine: false });

    await expect(
      client.complete({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    ).rejects.toMatchObject({ kind: 'network' });
  });
});
