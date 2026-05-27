/**
 * CopilotRuntimeImpl — shared services every capability needs.
 *
 * Phase 0/1 responsibilities are minimal: own the lazy LLM client so all
 * capabilities share one provider/credentials chain (and one prompt cache
 * window). Later phases extend this with: metering attribution, request
 * coalescing across capabilities, capability-level rate limiting, etc.
 *
 * Process-wide singleton (`copilotRuntime`). Hook + capability code import
 * it directly rather than constructing per-mount instances — that way the
 * LLM client survives editor re-mounts and the Gemini context-cache TTL
 * isn't wasted on every focus change.
 */
import { buildDefaultLLMClient } from '../ai/client/build-default-client';
import type { LLMClient } from '../ai/client/llm-client';
import type { CopilotRuntime } from './capability';

class CopilotRuntimeImpl implements CopilotRuntime {
  private clientPromise: Promise<LLMClient> | null = null;

  getClient(): Promise<LLMClient> {
    if (!this.clientPromise) {
      // Don't poison the cache on failure — the user might fix their key
      // and retry. Re-arm by clearing the cached promise.
      this.clientPromise = buildDefaultLLMClient().catch((err) => {
        this.clientPromise = null;
        throw err;
      });
    }
    return this.clientPromise;
  }

  resetClient(): void {
    this.clientPromise = null;
  }
}

export const copilotRuntime: CopilotRuntime = new CopilotRuntimeImpl();
