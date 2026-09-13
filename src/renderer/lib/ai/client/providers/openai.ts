import type { OpenAIProviderConfig } from './openai-runtime';
import { loadOpenAIProviders } from './provider-code';
import { DeferredProvider } from './deferred-provider';

export type { OpenAIProviderConfig } from './openai-runtime';

/** Keeps the public synchronous factory light; provider code loads on request. */
export class OpenAIProvider extends DeferredProvider {
  readonly id = 'openai';
  readonly supportsTools = true;
  readonly supportsToolStreaming = true;

  constructor(config: OpenAIProviderConfig) {
    const snapshot = { ...config };
    super(async () => {
      const { OpenAIProvider: Provider } = await loadOpenAIProviders();
      return () => new Provider(snapshot);
    });
  }
}
