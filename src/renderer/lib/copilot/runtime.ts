/**
 * CopilotRuntimeImpl — shared services every capability needs.
 *
 * Responsibilities are intentionally narrow: own the lazy LLM client so all
 * capabilities share one provider/credentials chain (and one prompt cache
 * window). Later phases extend this with: metering attribution, request
 * coalescing across capabilities, capability-level rate limiting, etc.
 *
 * Process-wide singleton (`copilotRuntime`). Hook + capability code import
 * it directly rather than constructing per-mount instances — that way the
 * LLM client survives editor re-mounts and provider setup is not repeated on
 * every focus change.
 */
import { buildCopilotLLMClient } from '../ai/client/build-default-client';
import type { LLMClient } from '../ai/client/llm-client';
import type { BYOKProvider } from '../byok-keychain';
import { useSettingsStore } from '../../store/settings-store';
import type { CopilotRuntime } from './capability';

export interface CopilotRuntimeDependencies {
  getProvider(): BYOKProvider;
  buildClient(provider: BYOKProvider): Promise<LLMClient>;
}

const DEFAULT_DEPENDENCIES: CopilotRuntimeDependencies = {
  getProvider: () => useSettingsStore.getState().copilotByokProvider,
  buildClient: (provider) => buildCopilotLLMClient(provider),
};

export class CopilotRuntimeImpl implements CopilotRuntime {
  private clientPromise: Promise<LLMClient> | null = null;
  private provider: BYOKProvider | null = null;

  constructor(private readonly dependencies: CopilotRuntimeDependencies = DEFAULT_DEPENDENCIES) {}

  getClient(expectedProvider?: BYOKProvider): Promise<LLMClient> {
    // Callers that already captured a provider/model route pass the provider
    // explicitly so a concurrent Settings change cannot mix client B with
    // model A. Compatibility callers may omit it and use the current setting.
    const provider = expectedProvider ?? this.dependencies.getProvider();
    if (this.provider !== provider) {
      this.clientPromise = null;
      this.provider = provider;
    }
    if (!this.clientPromise) {
      // Don't poison the cache on failure — the user might fix their key
      // and retry. Clear only the promise that failed: an older provider's
      // in-flight failure must not evict a newer provider's client.
      const clientPromise = this.dependencies.buildClient(provider).catch((err) => {
        if (this.clientPromise === clientPromise) this.clientPromise = null;
        throw err;
      });
      this.clientPromise = clientPromise;
    }
    return this.clientPromise;
  }

  resetClient(): void {
    this.clientPromise = null;
    this.provider = null;
  }
}

export const copilotRuntime: CopilotRuntime = new CopilotRuntimeImpl();
