type ModuleState<T> =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; value: T }
  | { status: 'error'; error: unknown };

/** Shares code, never feature instances. Failed attempts can be retried explicitly. */
export function createDeferredModule<T>(loader: () => Promise<T>) {
  let state: ModuleState<T> = { status: 'idle' };
  let pending: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: ModuleState<T>) => {
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    load() {
      if (pending) return pending;
      if (state.status === 'ready') return Promise.resolve();
      // Invoke after assigning pending, including loaders that throw synchronously.
      pending = Promise.resolve().then(loader).then(
        (value) => { pending = null; publish({ status: 'ready', value }); },
        (error: unknown) => { pending = null; publish({ status: 'error', error }); },
      );
      publish({ status: 'loading' });
      return pending;
    },
  };
}
