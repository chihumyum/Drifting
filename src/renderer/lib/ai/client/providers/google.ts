import type { GoogleProviderConfig } from './google-runtime';
import { loadGoogleProvider } from './provider-code';
import { DeferredProvider } from './deferred-provider';

export type { GoogleProviderConfig } from './google-runtime';

/** Keeps the public synchronous factory light; provider code loads on request. */
export class GoogleAIStudioProvider extends DeferredProvider {
  readonly id = 'google-ai-studio';

  constructor(config: GoogleProviderConfig) {
    const snapshot = { ...config };
    super(async () => {
      const { GoogleAIStudioProvider: Provider } = await loadGoogleProvider();
      return () => new Provider(snapshot);
    });
  }
}
