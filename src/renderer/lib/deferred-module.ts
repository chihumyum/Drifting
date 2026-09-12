type ModuleState<T> =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; value: T }
  | { status: 'error'; error: unknown };

/** Shares code, never feature instances. Failed demand loads require explicit retry. */
export function createDeferredModule<T>(loader: () => Promise<T>) {
  let state: ModuleState<T> = { status: 'idle' };
  let pending: Promise<void> | null = null;
  let demanded = false;
  const listeners = new Set<() => void>();
  const publish = (next: ModuleState<T>) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const start = (foreground: boolean) => {
    if (state.status === 'ready') return Promise.resolve();
    if (pending) {
      if (foreground && !demanded) {
        demanded = true;
        publish({ status: 'loading' });
      }
      return pending;
    }
    demanded = foreground;
    // Invoke after assigning pending, including loaders that throw synchronously.
    pending = Promise.resolve().then(loader).then(
      (value) => { pending = null; demanded = false; publish({ status: 'ready', value }); },
      (error: unknown) => {
        pending = null;
        const visibleFailure = demanded;
        demanded = false;
        if (visibleFailure) publish({ status: 'error', error });
        // An unused preload leaves the idle snapshot unchanged on failure.
      },
    );
    if (foreground) publish({ status: 'loading' });
    return pending;
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    load: () => start(true),
    preload: () => state.status === 'error' ? Promise.resolve() : start(false),
  };
}
