import { describe, expect, it, vi } from 'vitest';

import type { AICompletionRequest } from './types';
import {
  testByokProviderConnection,
  type TestProviderConnectionDependencies,
} from './test-provider-connection';

function dependencies(
  overrides: Partial<TestProviderConnectionDependencies> = {},
): TestProviderConnectionDependencies {
  return {
    hasKey: vi.fn(async () => true),
    getKey: vi.fn(async () => 'local-secret'),
    buildClient: vi.fn(() => ({
      complete: vi.fn(async () => ({
        text: 'OK',
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    })),
    requestOpenAI: vi.fn(async () =>
      new Response('data: {"type":"response.completed"}\n\n', { status: 200 }),
    ),
    ...overrides,
  };
}

describe('direct BYOK provider connectivity check', () => {
  it.each(['deepseek', 'anthropic', 'google'] as const)(
    'uses the direct %s adapter with the exact key and model',
    async (provider) => {
      const requests: AICompletionRequest[] = [];
      const deps = dependencies({
        buildClient: vi.fn((_provider, _apiKey, _model) => ({
          complete: vi.fn(async (request: AICompletionRequest) => {
            requests.push(request);
            return {
              text: 'OK',
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          }),
        })),
      });

      await testByokProviderConnection(provider, { model: `${provider}-model` }, deps);

      expect(deps.hasKey).toHaveBeenCalledWith(provider);
      expect(deps.getKey).toHaveBeenCalledWith(provider);
      expect(deps.buildClient).toHaveBeenCalledWith(
        provider,
        'local-secret',
        `${provider}-model`,
      );
      expect(requests[0]).toMatchObject({
        model: `${provider}-model`,
        metadata: { feature: 'settings-provider-test' },
      });
      expect(deps.requestOpenAI).not.toHaveBeenCalled();
    },
  );

  it('uses native fixed-origin OpenAI Responses without decrypting its key in JavaScript', async () => {
    const deps = dependencies({
      getKey: vi.fn(async () => {
        throw new Error('OpenAI key must stay native');
      }),
    });

    await testByokProviderConnection('openai', { model: 'gpt-test' }, deps);

    expect(deps.getKey).not.toHaveBeenCalled();
    expect(deps.buildClient).not.toHaveBeenCalled();
    expect(deps.requestOpenAI).toHaveBeenCalledOnce();
    const body = JSON.parse(
      (deps.requestOpenAI as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string,
    ) as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'gpt-test', stream: true, store: false });
  });

  it('fails closed without trying another provider when the selected key is absent', async () => {
    const deps = dependencies({ hasKey: vi.fn(async () => false) });

    await expect(
      testByokProviderConnection('google', {}, deps),
    ).rejects.toMatchObject({ kind: 'auth' });
    expect(deps.getKey).not.toHaveBeenCalled();
    expect(deps.buildClient).not.toHaveBeenCalled();
  });
});
