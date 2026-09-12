import {
  type createReferenceIndexRepository, type ReferenceIndexScope, type ReferenceSourceVersion,
  referenceSourceKey, sameReferenceIndexScope, sameReferenceSourceVersion,
} from './reference-index-repository';

type Repository = ReturnType<typeof createReferenceIndexRepository>;

export interface ReferenceIndexRunStats {
  sources: number;
  prepared: number;
  written: number;
  reused: number;
  removedSources: number;
  failedSources: number;
  stale: boolean;
}

export interface ReferenceIndexQueueSnapshot {
  readonly phase: 'idle' | 'waiting' | 'running' | 'failed' | 'disposed';
  readonly hasError: boolean;
  readonly lastRun: Readonly<ReferenceIndexRunStats> | null;
}

export const REFERENCE_INDEX_QUIET_MS = 250;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const SOURCES_PER_YIELD = 16;

/** One bounded pending request, one worker, and one acknowledged version per
 * current source. The map is disposable acceleration, never recovery truth:
 * each new owner/explicit repair starts with a complete authoritative pass. */
export function createReferenceIndexQueue(options: {
  createRepository: (isCurrent: () => boolean) => Repository;
  isCurrent: () => boolean;
  onSnapshot: () => void;
  onChanged: () => void;
  onError: () => void;
}) {
  let active = true;
  let epoch = 0;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerDue = 0;
  let yieldTimer: ReturnType<typeof setTimeout> | null = null;
  let releaseYield: (() => void) | null = null;
  let running: Promise<void> | null = null;
  let retryDelay: number | null = null;
  let failures = 0;
  let scope: ReferenceIndexScope | null = null;
  const acknowledged = new Map<string, { source: ReferenceSourceVersion; references: number }>();
  let snapshot: ReferenceIndexQueueSnapshot = { phase: 'idle', hasError: false, lastRun: null };

  const current = () => active && options.isCurrent();
  const makeRepository = () => {
    const ownerEpoch = epoch;
    return options.createRepository(() => current() && epoch === ownerEpoch);
  };
  let repository = makeRepository();

  function notify(callback: () => void): void {
    try { callback(); } catch { /* A display observer cannot invalidate committed work. */ }
  }

  function publish(next: ReferenceIndexQueueSnapshot): void {
    snapshot = next;
    notify(options.onSnapshot);
  }

  function clearTimer(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function finishYield(): void {
    if (yieldTimer !== null) clearTimeout(yieldTimer);
    yieldTimer = null;
    const resolve = releaseYield;
    releaseYield = null;
    resolve?.();
  }

  function yieldToHost(): Promise<void> {
    return new Promise((resolve) => {
      releaseYield = resolve;
      yieldTimer = setTimeout(finishYield, 0);
    });
  }

  function schedule(delay: number): void {
    if (!current()) { dispose(); return; }
    const due = performance.now() + delay;
    // The first request fixes the window; a continuous stream cannot postpone
    // it indefinitely. A new commit can bring a backed-off retry forward.
    if (timer !== null && timerDue <= due) return;
    clearTimer();
    timerDue = due;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, delay);
    if (!snapshot.hasError) publish({ ...snapshot, phase: 'waiting' });
  }

  function request(force = false): void {
    if (!current()) { dispose(); return; }
    if (force) {
      // Revocation reaches the repository's pre-commit guard, including SQL
      // already in flight when a checkpoint/authority replacement arrives.
      epoch += 1;
      scope = null;
      acknowledged.clear();
      repository = makeRepository();
      failures = 0;
      retryDelay = null;
      finishYield();
    }
    pending = true;
    if (!running) schedule(force ? 0 : REFERENCE_INDEX_QUIET_MS);
  }

  async function runPass(): Promise<void> {
    if (!current()) { dispose(); return; }
    pending = false;
    retryDelay = null;
    const passEpoch = epoch;
    const passRepository = repository;
    const ownsPass = () => current() && epoch === passEpoch;
    const stats: ReferenceIndexRunStats = {
      sources: 0, prepared: 0, written: 0, reused: 0, removedSources: 0, failedSources: 0, stale: false,
    };
    let failed = false;
    publish({ ...snapshot, phase: 'running' });
    try {
      const catalog = await passRepository.captureCatalog();
      if (!ownsPass()) return;
      if (!catalog) {
        acknowledged.clear();
        scope = null;
      } else {
        stats.sources = catalog.sources.length;
        if (!scope || !sameReferenceIndexScope(scope, catalog.scope)) {
          acknowledged.clear();
          scope = catalog.scope;
        }
        const removed = await passRepository.pruneOrphanSources(catalog.scope);
        if (!ownsPass()) return;
        if (removed === null) {
          stats.stale = true;
          pending = true;
        } else {
          stats.removedSources = removed;
          const keys = new Set(catalog.sources.map(referenceSourceKey));
          for (const key of acknowledged.keys()) if (!keys.has(key)) acknowledged.delete(key);
          let attemptedSinceYield = 0;
          for (const source of catalog.sources) {
            if (!ownsPass()) return;
            const key = referenceSourceKey(source);
            const previous = acknowledged.get(key);
            if (previous && sameReferenceSourceVersion(previous.source, source)
              && previous.references === (catalog.indexedCounts.get(key) ?? 0)) {
              stats.reused += 1;
              continue;
            }
            try {
              const prepared = await passRepository.prepareSource(catalog.scope, source);
              if (!ownsPass()) return;
              if (!prepared) { stats.stale = true; pending = true; break; }
              stats.prepared += 1;
              const accepted = await passRepository.replaceSource(prepared);
              if (!ownsPass()) return;
              if (!accepted) { stats.stale = true; pending = true; break; }
              // A failure or stale result can never acknowledge a version.
              acknowledged.set(key, { source: prepared.source, references: prepared.drafts.length });
              stats.written += 1;
            } catch {
              if (!ownsPass()) return;
              failed = true;
              stats.failedSources += 1;
            }
            attemptedSinceYield += 1;
            if (attemptedSinceYield === SOURCES_PER_YIELD) {
              attemptedSinceYield = 0;
              await yieldToHost();
            }
          }
        }
      }
    } catch {
      if (!ownsPass()) return;
      failed = true;
    } finally {
      if (ownsPass()) {
        if (failed) {
          failures += 1;
          retryDelay = Math.min(RETRY_BASE_MS * 2 ** Math.min(failures - 1, 5), RETRY_MAX_MS);
          publish({ phase: 'failed', hasError: true, lastRun: stats });
          notify(options.onError);
        } else if (stats.stale) {
          publish({ ...snapshot, phase: 'waiting', lastRun: stats });
        } else {
          failures = 0;
          publish({ phase: 'idle', hasError: false, lastRun: stats });
        }
        // Even a metadata-only pass refreshes joined backlink titles. A source
        // error may still leave other sources successfully updated this pass.
        if (ownsPass() && !stats.stale && (!failed || stats.written > 0 || stats.removedSources > 0)) notify(options.onChanged);
      } else if (active && !options.isCurrent()) {
        dispose();
      }
    }
  }

  /** Drain one pass now (used by deterministic acceptance/explicit repair).
   * A request arriving during the pass stays pending for a following pass. */
  function flush(): Promise<void> {
    clearTimer();
    if (running) return running;
    running = Promise.resolve().then(runPass).finally(() => {
      running = null;
      if (!current()) { dispose(); return; }
      if (pending) schedule(REFERENCE_INDEX_QUIET_MS);
      else if (retryDelay !== null) schedule(retryDelay);
    });
    return running;
  }

  function dispose(): void {
    if (!active) return;
    active = false;
    epoch += 1;
    pending = false;
    scope = null;
    acknowledged.clear();
    clearTimer();
    finishYield();
    publish({ phase: 'disposed', hasError: false, lastRun: null });
  }

  return { request, flush, dispose, getSnapshot: () => snapshot };
}
