import type { DeepSeekProviderConfig } from './deepseek-runtime';
import { loadOpenAIProviders } from './provider-code';
import { DeferredProvider } from './deferred-provider';

export type { DeepSeekProviderConfig, DeepSeekReasoningEffort } from './deepseek-runtime';

/** Keeps the public synchronous factory light; provider code loads on request. */
export class DeepSeekProvider extends DeferredProvider {
  readonly id = 'deepseek';
  readonly supportsTools = true;
  readonly supportsToolStreaming = true;

  constructor(config: DeepSeekProviderConfig) {
    const snapshot = { ...config };
    super(async () => {
      const { DeepSeekProvider: Provider } = await loadOpenAIProviders();
      return () => new Provider(snapshot);
    });
  }
}
