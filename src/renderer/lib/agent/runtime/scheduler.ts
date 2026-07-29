import {
  abortReason,
  AgentRuntimeAbortError,
  throwIfAgentAborted,
} from './errors';
import type {
  AgentRuntimeScheduler,
  AgentToolExecutionRequest,
} from './types';

/**
 * Fair reader/writer barrier shared by every local AgentRuntime in this
 * renderer. Adjacent reads may overlap; a queued write waits for prior reads,
 * and later reads wait behind that write.
 */
export class ReaderWriterAgentRuntimeScheduler implements AgentRuntimeScheduler {
  private tail: Promise<void> = Promise.resolve();
  private readonly reads = new Set<Promise<unknown>>();

  runRead<T>(
    request: AgentToolExecutionRequest,
    execute: () => Promise<T>,
  ): Promise<T> {
    const work = this.tail.then(() => {
      throwIfAgentAborted(request.signal);
      return execute();
    });
    const result = releaseReadLeaseOnAbort(work, request.signal);
    this.reads.add(result);
    void result.finally(() => this.reads.delete(result)).catch(() => undefined);
    return result;
  }

  runWrite<T>(
    request: AgentToolExecutionRequest,
    execute: () => Promise<T>,
  ): Promise<T> {
    const priorReads = [...this.reads];
    const result = Promise.all([this.tail, ...priorReads]).then(() => {
      throwIfAgentAborted(request.signal);
      return execute();
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export const sharedAgentRuntimeScheduler = new ReaderWriterAgentRuntimeScheduler();

/**
 * A read tool is contractually side-effect free. If it ignores cancellation,
 * its abandoned work must not retain the reader lease forever and starve all
 * later writes. The underlying promise remains observed to avoid unhandled
 * rejections, while the scheduler lease follows the turn's AbortSignal.
 */
function releaseReadLeaseOnAbort<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };

    const onAbort = () => {
      finish(() => reject(new AgentRuntimeAbortError(abortReason(signal))));
    };

    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();

    void work.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}
