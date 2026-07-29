import { AgentRuntimeAbortError, abortReason } from './errors';
import type { AgentClock } from './types';

/** Real clock adapter. Runtime logic receives this through dependency injection. */
export const systemAgentClock: AgentClock = {
  wallNowMs: () => Date.now(),
  monotonicNowMs: () => globalThis.performance.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new AgentRuntimeAbortError(abortReason(signal)));
        return;
      }
      const timer = globalThis.setTimeout(() => {
        cleanup();
        resolve();
      }, Math.max(0, ms));
      const onAbort = () => {
        globalThis.clearTimeout(timer);
        cleanup();
        reject(new AgentRuntimeAbortError(signal ? abortReason(signal) : undefined));
      };
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};
