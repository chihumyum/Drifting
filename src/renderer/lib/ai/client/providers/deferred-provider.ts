import { canUseByokProvider } from '../../../config';
import { AIError, type AICompletionChunk, type AICompletionRequest } from '../../types';
import type { LLMProvider } from './provider';

type StreamingProvider = LLMProvider & Required<Pick<LLMProvider, 'stream'>>;

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new AIError('aborted', 'Request aborted before send');
}

/** Cancellation releases this waiter without cancelling code needed by peers. */
function waitForCode<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(new AIError('aborted', 'Request aborted while loading its provider')); };
    signal.addEventListener('abort', abort, { once: true });
    pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    // Cover a signal aborted before listener registration.
    if (signal.aborted) abort();
  });
}

/** Per-client instance ownership; code alone is shared by the loader. */
export abstract class DeferredProvider implements LLMProvider {
  abstract readonly id: string;
  private provider: StreamingProvider | undefined;

  protected constructor(private readonly load: () => Promise<() => StreamingProvider>) {}

  private async ready(signal?: AbortSignal) {
    assertNotAborted(signal);
    if (!this.provider) {
      let create: () => StreamingProvider;
      try { create = await waitForCode(this.load(), signal); }
      catch (error) {
        if (error instanceof AIError) throw error;
        throw new AIError('network', 'Could not load the selected model provider. Retry the request.', error);
      }
      assertNotAborted(signal);
      if (!canUseByokProvider()) throw new AIError('network', 'The selected BYOK provider is unavailable while offline.');
      // Concurrent calls on one facade create at most one credential-bound client.
      if (!this.provider) this.provider = create();
    }
    // Loading adds an await after the request interceptor's capability check.
    if (!canUseByokProvider()) throw new AIError('network', 'The selected BYOK provider is unavailable while offline.');
    return this.provider;
  }

  async complete(request: AICompletionRequest) {
    return (await this.ready(request.signal)).complete(request);
  }

  async *stream(request: AICompletionRequest): AsyncIterable<AICompletionChunk> {
    const provider = await this.ready(request.signal);
    yield* provider.stream(request);
  }
}
