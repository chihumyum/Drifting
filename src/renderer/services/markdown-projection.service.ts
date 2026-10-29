import { registerMarkdownProjectionFlush } from './markdown-projection-lifecycle';
import { platform } from '../platform';
import { getMarkdownProjectionStatus, publishMarkdownProjectionStatus as publish } from './markdown-projection-status';
import { getDbIfInitialized } from '../lib/db';
import { getActiveEditor } from '../lib/active-editor';
import { beginDevActivity } from '../lib/dev-activity';
import { events } from '../lib/events';
import { onAuthoredChangeCommitted } from '../sync/journal/authored-transaction';
import { flushPendingAssetPersistence } from './asset-store.service';
import { flushPendingAtomicSyncTransactions } from './atomic-sync-transaction-tracker';
import { flushAllOpenYjsDocuments } from './yjs-local-durability.service';
import { readLocalRelationalMarkdownSource } from './export/relational-markdown.local-source';
import { createMarkdownProjectionRenderer } from './export/markdown-projection-client';

const workers = new Map<string, ReturnType<typeof createProjectionWorker>>();

/** An automatic capture waits for the author to pause this long. */
export const PROJECTION_QUIET_MS = 5000;
/** An author who never pauses still sees the projection refreshed this often. */
export const PROJECTION_MAX_WAIT_MS = 30_000;
/** How soon a capture deferred for an IME composition checks again. */
const PROJECTION_DEFER_MS = 1000;

/**
 * Coalesce commits until the author pauses, bounded by a maximum wait, so
 * continuous typing does not keep re-exporting the project. One capture at a time.
 */
export function createProjectionWorker(
  refresh: (forced: boolean) => Promise<void>,
  failed: (error: unknown) => void,
  shouldDefer: () => boolean = () => false,
) {
  let dirty = false;
  let disposed = false;
  let suspended = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  // When the oldest change not yet captured arrived.
  let pendingSince: number | undefined;
  const schedule = (delay: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void flush(false); }, Math.max(0, delay));
  };
  const flush = async (forced = true): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (running) { await running; if (dirty && !disposed && !suspended) await flush(forced); return; }
    if (!dirty || disposed || suspended) return;
    if (!forced && shouldDefer()) { schedule(PROJECTION_DEFER_MS); return; }
    dirty = false;
    pendingSince = undefined;
    const endActivity = beginDevActivity('markdown-projection', { forced });
    running = refresh(forced).catch(error => { failed(error); }).finally(() => { running = undefined; endActivity(); });
    await running;
    // Keep a deadline set during the capture (a later commit, or a deferral).
    if (dirty && !disposed && timer === undefined) request();
  };
  const request = () => {
    if (disposed) return;
    dirty = true;
    const now = Date.now();
    pendingSince ??= now;
    if (suspended) return;
    schedule(Math.min(now + PROJECTION_QUIET_MS, pendingSince + PROJECTION_MAX_WAIT_MS) - now);
  };
  return {
    request, flush,
    /** Retry soon without waiting for a pause, e.g. after yielding to an IME composition. */
    defer() {
      if (disposed) return;
      dirty = true;
      if (!suspended) schedule(PROJECTION_DEFER_MS);
    },
    suspend() {
      suspended++;
      if (timer) clearTimeout(timer);
      timer = undefined;
      return () => { suspended--; if (dirty && !disposed && !suspended) request(); };
    },
    dispose() { disposed = true; dirty = false; if (timer) clearTimeout(timer); },
  };
}

/**
 * Project service, independent of whether an external MCP client is connected.
 * The returned close resolves once the final capture finished and the renderer is released.
 */
export function installMarkdownProjection(projectId: string): () => Promise<void> {
  let disposed = false;
  const controller = new AbortController();
  // Holds the prose it hydrated until the project closes, so a capture only
  // reads the Yjs state of documents that changed since the last one.
  const renderer = createMarkdownProjectionRenderer();
  const stage = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
    const end = beginDevActivity(`markdown-projection:${name}`);
    try { return await operation(); } finally { end(); }
  };
  const database = getDbIfInitialized();
  const active = () => !disposed && getDbIfInitialized() === database;
  publish(projectId, { state: 'pending', readOnly: true, reverseSync: false });
  const shouldDefer = () => Boolean(getActiveEditor()?.view.composing);
  // A capture still running for this project, e.g. the final one of a close.
  // Waiting for it keeps an older capture from publishing over a newer one.
  const previous = workers.get(projectId);
  previous?.dispose();
  const previousCapture = previous?.flush();
  let lastFailed = false;
  const worker = createProjectionWorker(async (forced) => {
    const yieldToComposition = () => {
      if (!forced && shouldDefer()) { worker.defer(); return true; }
      return false;
    };
    await previousCapture;
    if (!active()) return;
    publish(projectId, { state: 'pending', error: undefined });
    const info = await platform.markdownProjection.info(projectId);
    if (!active()) return;
    publish(projectId, { ...info, state: 'pending' });
    if (yieldToComposition()) return;
    await stage('flush-prose', flushAllOpenYjsDocuments);
    if (!active()) return;
    if (yieldToComposition()) return;
    await stage('flush-assets', flushPendingAssetPersistence);
    if (!active()) return;
    if (yieldToComposition()) return;
    const source = await stage('capture', () => readLocalRelationalMarkdownSource(projectId, { knownProseVersions: renderer.knownProseVersions() }));
    if (!active()) return;
    if (yieldToComposition()) return;
    if (source.books.length !== 1) throw new Error('Projection project no longer exists');
    const capturedAt = new Date();
    const { entries, assets, documents } = await stage('render-worker', () => renderer.render(source, capturedAt, controller.signal));
    if (!active()) return;
    if (yieldToComposition()) return;
    const result = await stage('publish', () => platform.markdownProjection.write(projectId, capturedAt.toISOString(), entries, assets, documents));
    lastFailed = false;
    if (active()) publish(projectId, { ...result, state: 'ready', error: undefined });
  }, error => {
    lastFailed = true;
    if (active()) publish(projectId, { state: 'error', error: error instanceof Error ? error.message : String(error) });
  }, shouldDefer);
  workers.set(projectId, worker);
  const changed = (event: { projectId: string }) => { if (event.projectId === projectId) worker.request(); };
  const restored = (event: { projectIds: string[] }) => { if (event.projectIds.includes(projectId)) worker.request(); };
  const unsubscribe = onAuthoredChangeCommitted(changed);
  let closing = false;
  // Quitting the app runs this before exit: capture what the author wrote
  // since the last capture, or retry one that failed, without waiting for a pause.
  const unregisterFlush = registerMarkdownProjectionFlush(async () => {
    if (lastFailed && !closing) worker.request();
    await worker.flush();
  });
  events.on('sync:project-changed', changed);
  events.on('sync:projects-restored', restored);
  worker.request();
  void worker.flush(false);
  return () => {
    closing = true;
    // Closing the project publishes what was written since the last capture,
    // then releases the renderer. The last keystrokes commit only as the
    // editors unmount, so keep listening until their saves land. Until the
    // release, a quit, a deletion or a reopen waits for this capture.
    const saved = async () => {
      await flushAllOpenYjsDocuments().catch(() => undefined);
      await flushPendingAtomicSyncTransactions().catch(() => undefined);
    };
    return saved().then(() => {
      unsubscribe();
      events.off('sync:project-changed', changed);
      events.off('sync:projects-restored', restored);
      return worker.flush();
    }).finally(() => {
      disposed = true;
      controller.abort();
      renderer.dispose();
      unregisterFlush();
      worker.dispose();
      if (workers.get(projectId) === worker) workers.delete(projectId);
    });
  };
}

export async function refreshMarkdownProjection(projectId: string): Promise<void> {
  const worker = workers.get(projectId);
  if (!worker) throw new Error('Open the project in Drifting to refresh its Markdown projection');
  worker.request();
  await worker.flush();
  const status = getMarkdownProjectionStatus(projectId);
  if (workers.get(projectId) === worker && status?.state === 'error') {
    throw new Error(status.error ?? 'Markdown projection refresh failed');
  }
}

/** Drain any old capture before switching paths, then regenerate at the new location. */
export async function setMarkdownProjectionOutputRoot(projectId: string, customRoot: string | null): Promise<void> {
  const worker = workers.get(projectId);
  if (!worker) throw new Error('Open the project in Drifting to change its Markdown output location');
  const resume = worker.suspend();
  try {
    await worker.flush();
    if (workers.get(projectId) !== worker) throw new Error('Project closed while changing output location');
    const info = await platform.markdownProjection.setOutputRoot(projectId, customRoot);
    if (workers.get(projectId) === worker) publish(projectId, { ...info, state: 'pending', error: undefined });
  } finally { resume(); }
  if (workers.get(projectId) === worker) await refreshMarkdownProjection(projectId);
}

/** Called only after the project deletion committed; prevent a late capture from republishing it. */
export async function removeMarkdownProjection(projectId: string): Promise<void> {
  const worker = workers.get(projectId);
  if (worker) { worker.dispose(); await worker.flush(); workers.delete(projectId); }
  await platform.markdownProjection.remove(projectId);
}
