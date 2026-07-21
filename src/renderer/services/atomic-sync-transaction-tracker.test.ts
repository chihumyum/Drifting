import { describe, expect, it } from 'vitest';
import {
  flushPendingAtomicSyncTransactions,
  trackAtomicSyncTransaction,
} from './atomic-sync-transaction-tracker';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('atomic sync transaction tracker', () => {
  it('keeps a force-flush waiting until an active transaction settles', async () => {
    const transaction = deferred<void>();
    expect(trackAtomicSyncTransaction(transaction.promise)).toBe(transaction.promise);

    let flushed = false;
    const flush = flushPendingAtomicSyncTransactions().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);

    transaction.resolve();
    await flush;
    expect(flushed).toBe(true);
  });

  it('also drains a transaction registered while a flush is in progress', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    trackAtomicSyncTransaction(first.promise);

    const flush = flushPendingAtomicSyncTransactions();
    trackAtomicSyncTransaction(second.promise);
    first.resolve();
    await Promise.resolve();

    let flushed = false;
    void flush.then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);

    second.resolve();
    await flush;
    expect(flushed).toBe(true);
  });

  it('reports a transaction failure after draining the remaining work', async () => {
    const failed = deferred<void>();
    const successful = deferred<void>();
    trackAtomicSyncTransaction(failed.promise);
    trackAtomicSyncTransaction(successful.promise);

    const flush = flushPendingAtomicSyncTransactions();
    failed.reject(new Error('commit failed'));
    successful.resolve();

    await expect(flush).rejects.toThrow('1 atomic entity transaction(s) failed');
    await expect(flushPendingAtomicSyncTransactions()).resolves.toBeUndefined();
  });
});
