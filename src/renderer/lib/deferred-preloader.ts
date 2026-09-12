export interface PreloadResource {
  getSnapshot: () => { status: 'idle' | 'loading' | 'ready' | 'error' };
  preload: () => Promise<void>;
}

/** One speculative load and one latest intent; demand loads bypass this queue. */
export function createDeferredPreloader(options: {
  schedule: (run: () => void) => () => void;
  allowed: () => boolean;
}) {
  const attempted = new WeakSet<PreloadResource>();
  let active: PreloadResource | null = null;
  let queued: { resource: PreloadResource } | null = null;
  let cancelScheduled: (() => void) | null = null;

  const schedule = () => {
    if (active || !queued || cancelScheduled) return;
    if (!options.allowed()) { queued = null; return; }
    const intent = queued;
    cancelScheduled = options.schedule(() => {
      if (queued !== intent) return;
      cancelScheduled = null;
      queued = null;
      const { resource } = intent;
      if (!options.allowed() || resource.getSnapshot().status !== 'idle' || attempted.has(resource)) return;
      attempted.add(resource);
      active = resource;
      // Catch unexpected loaders too: speculation never produces an unhandled rejection.
      void Promise.resolve().then(() => resource.preload()).catch(() => undefined).finally(() => {
        active = null;
        schedule();
      });
    });
  };

  return {
    request(resource: PreloadResource) {
      if (!options.allowed() || attempted.has(resource) || active === resource || resource.getSnapshot().status !== 'idle') return () => {};
      cancelScheduled?.();
      cancelScheduled = null;
      const intent = { resource };
      queued = intent;
      schedule();
      return () => {
        if (queued !== intent) return;
        queued = null;
        cancelScheduled?.();
        cancelScheduled = null;
      };
    },
  };
}

function allowed() {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  return document.visibilityState === 'visible' && navigator.onLine !== false &&
    !connection?.saveData && !['slow-2g', '2g'].includes(connection?.effectiveType ?? '');
}

function scheduleIdleIntent(run: () => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let idle: number | null = null;
  let disposed = false;
  const cancel = () => {
    disposed = true;
    if (timer !== null) clearTimeout(timer);
    if (idle !== null) window.cancelIdleCallback(idle);
    document.removeEventListener('visibilitychange', onVisibility);
  };
  const finish = () => { if (!disposed) { cancel(); run(); } };
  // Hidden pages drop queued work instead of resuming it on a later visit.
  const onVisibility = () => { if (document.visibilityState !== 'visible') finish(); };
  document.addEventListener('visibilitychange', onVisibility);
  timer = setTimeout(() => {
    timer = null;
    if (typeof window.requestIdleCallback === 'function') {
      idle = window.requestIdleCallback(finish, { timeout: 1000 });
    } else {
      timer = setTimeout(finish, 0);
    }
  }, 120);
  return cancel;
}

// Construction has no timer, listener, import or browser-global side effect.
export const deferredPreloader = createDeferredPreloader({ schedule: scheduleIdleIntent, allowed });
