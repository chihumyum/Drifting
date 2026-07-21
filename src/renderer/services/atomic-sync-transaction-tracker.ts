const pendingAtomicSyncTransactions = new Set<Promise<unknown>>();

/**
 * Register a domain-write + outbox transaction until it settles. Registration
 * is synchronous so a concurrent force-flush cannot miss an already-started
 * transaction whose outbox row is not visible yet.
 */
export function trackAtomicSyncTransaction<T>(operation: Promise<T>): Promise<T> {
  pendingAtomicSyncTransactions.add(operation);
  void operation.then(
    () => pendingAtomicSyncTransactions.delete(operation),
    () => pendingAtomicSyncTransactions.delete(operation),
  );
  return operation;
}

/** Wait for every transaction that was active or started while draining. */
export async function flushPendingAtomicSyncTransactions(): Promise<void> {
  const failures: unknown[] = [];

  while (pendingAtomicSyncTransactions.size > 0) {
    const batch = [...pendingAtomicSyncTransactions];
    const results = await Promise.allSettled(batch);
    for (let index = 0; index < batch.length; index += 1) {
      pendingAtomicSyncTransactions.delete(batch[index]);
      const result = results[index];
      if (result.status === 'rejected') failures.push(result.reason);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} atomic entity transaction(s) failed while flushing`,
    );
  }
}
