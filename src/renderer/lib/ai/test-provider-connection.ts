/**
 * Explicit Models & API connectivity check.
 *
 * This path is author-triggered and talks straight to the selected provider.
 * It never calls a Drifting account, hosted-AI, or proxy endpoint. OpenAI uses
 * the fixed-origin native Responses transport so its credential never enters
 * renderer JavaScript; the other provider adapters read their key only after
 * the author presses Test connection.
 */
import type { BYOKProvider } from '../byok-keychain';
import { byokKeychain } from '../byok-keychain';
import { canUseByokProvider } from '../config';
import { platform } from '../../platform';
import { buildDirectBYOKClient } from './client/build-default-client';
import type { LLMClient } from './client/llm-client';
import { COPILOT_DEFAULT_MODEL_BY_PROVIDER } from './copilot-route';
import { AIError } from './types';

export interface TestProviderConnectionOptions {
  model?: string;
  signal?: AbortSignal;
}

type CompletionClient = Pick<LLMClient, 'complete'>;

export interface TestProviderConnectionDependencies {
  hasKey(provider: BYOKProvider): Promise<boolean>;
  getKey(provider: BYOKProvider): Promise<string | null>;
  buildClient(provider: BYOKProvider, apiKey: string, model: string): CompletionClient;
  requestOpenAI(body: string, signal: AbortSignal): Promise<Response>;
}

const DEFAULT_DEPENDENCIES: TestProviderConnectionDependencies = {
  hasKey: (provider) => byokKeychain.has(provider),
  getKey: (provider) => byokKeychain.get(provider),
  buildClient: (provider, apiKey, model) =>
    buildDirectBYOKClient(provider, apiKey, {
      logTag: 'settings-provider-test',
      model,
    }),
  requestOpenAI: (body, signal) => platform.openAIResponses.request(body, signal),
};

export async function testByokProviderConnection(
  provider: BYOKProvider,
  options: TestProviderConnectionOptions = {},
  dependencies: TestProviderConnectionDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
  if (!canUseByokProvider()) {
    throw new AIError('network', 'The selected BYOK provider is unavailable while offline.');
  }

  const model =
    options.model?.trim() || COPILOT_DEFAULT_MODEL_BY_PROVIDER[provider];
  const signal = options.signal ?? new AbortController().signal;
  if (!(await dependencies.hasKey(provider))) {
    throw new AIError('auth', `No ${provider} key is configured.`);
  }

  if (provider === 'openai') {
    await testOpenAIConnection(model, signal, dependencies.requestOpenAI);
    return;
  }

  const apiKey = await dependencies.getKey(provider);
  if (!apiKey) throw new AIError('auth', `No ${provider} key is configured.`);
  const client = dependencies.buildClient(provider, apiKey, model);
  const response = await client.complete({
    model,
    messages: [{ role: 'user', content: 'Return exactly OK.' }],
    maxOutputTokens: 32,
    temperature: 0,
    signal,
    metadata: { feature: 'settings-provider-test' },
  });
  if (!response.text?.trim()) {
    throw new AIError('parse', `${provider} returned an empty connectivity-check response.`);
  }
}

async function testOpenAIConnection(
  model: string,
  signal: AbortSignal,
  request: TestProviderConnectionDependencies['requestOpenAI'],
): Promise<void> {
  const response = await request(
    JSON.stringify({
      model,
      instructions: 'Return exactly OK.',
      input: 'Drifting native connectivity check.',
      max_output_tokens: 32,
      stream: true,
      store: false,
      ...(model.startsWith('gpt-5.6') ? { reasoning: { effort: 'none' } } : {}),
    }),
    signal,
  );
  if (!response.ok) {
    const message =
      response.headers.get('x-drifting-openai-error-message') ??
      `OpenAI connectivity check failed (HTTP ${response.status}).`;
    if (response.status === 401 || response.status === 403) {
      throw new AIError('auth', message);
    }
    if (response.status === 429) throw new AIError('rate-limit', message);
    throw new AIError('network', message);
  }

  const stream = await response.text();
  if (!/"type"\s*:\s*"response\.completed"/.test(stream)) {
    throw new AIError('parse', 'OpenAI connectivity check ended without response.completed.');
  }
}
