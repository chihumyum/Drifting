import { registerMarkdownProjectionFlush } from './markdown-projection-lifecycle';
import { platform } from '../platform';
import { getMarkdownProjectionStatus, publishMarkdownProjectionStatus as publish } from './markdown-projection-status';
import { getDbIfInitialized } from '../lib/db';
import { getActiveEditor } from '../lib/active-editor';
import { events } from '../lib/events';
import { onAuthoredChangeCommitted } from '../sync/journal/authored-transaction';
import { flushAllOpenYjsDocuments } from './yjs-local-durability.service';
import { readLocalRelationalMarkdownSource } from './export/relational-markdown.local-source';
import { buildRelationalMarkdownEntries } from './export/relational-markdown.service';

const workers = new Map<string, ReturnType<typeof createProjectionWorker>>();

/** Coalesce commits without starving a continuous writer. One capture at a time. */
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
  const flush = async (forced = true): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (running) { await running; if (dirty && !disposed && !suspended) await flush(forced); return; }
    if (!dirty || disposed || suspended) return;
    if (!forced && shouldDefer()) { request(); return; }
    dirty = false;
    running = refresh(forced).catch(error => { failed(error); }).finally(() => { running = undefined; });
    await running;
    if (dirty && !disposed) request();
  };
  const request = () => {
    if (disposed) return;
    dirty = true;
    if (suspended) return;
    // Keep the first deadline instead of resetting it on every keystroke.
    timer ??= setTimeout(() => { timer = undefined; void flush(false); }, 1000);
  };
  return {
    request, flush,
    suspend() {
      suspended++;
      if (timer) clearTimeout(timer);
      timer = undefined;
      return () => { suspended--; if (dirty && !disposed && !suspended) request(); };
    },
    dispose() { disposed = true; dirty = false; if (timer) clearTimeout(timer); },
  };
}

/** Project service, independent of whether an external MCP client is connected. */
export function installMarkdownProjection(projectId: string): () => void {
  let disposed = false;
  const database = getDbIfInitialized();
  const active = () => !disposed && getDbIfInitialized() === database;
  publish(projectId, { state: 'pending', readOnly: true, reverseSync: false });
  const shouldDefer = () => Boolean(getActiveEditor()?.view.composing);
  const worker = createProjectionWorker(async (forced) => {
    const yieldToComposition = () => {
      if (!forced && shouldDefer()) { worker.request(); return true; }
      return false;
    };
    if (!active()) return;
    publish(projectId, { state: 'pending', error: undefined });
    const info = await platform.markdownProjection.info(projectId);
    if (!active()) return;
    publish(projectId, { ...info, state: 'pending' });
    if (yieldToComposition()) return;
    await flushAllOpenYjsDocuments();
    if (!active()) return;
    if (yieldToComposition()) return;
    const source = await readLocalRelationalMarkdownSource(projectId);
    if (!active()) return;
    if (yieldToComposition()) return;
    if (source.books.length !== 1) throw new Error('Projection project no longer exists');
    const { entries } = await buildRelationalMarkdownEntries(source, true);
    if (!active()) return;
    if (yieldToComposition()) return;
    const result = await platform.markdownProjection.write(projectId, new Date().toISOString(), entries);
    if (active()) publish(projectId, { ...result, state: 'ready', error: undefined });
  }, error => {
    if (active()) publish(projectId, { state: 'error', error: error instanceof Error ? error.message : String(error) });
  }, shouldDefer);
  workers.get(projectId)?.dispose();
  workers.set(projectId, worker);
  const changed = (event: { projectId: string }) => { if (event.projectId === projectId) worker.request(); };
  const restored = (event: { projectIds: string[] }) => { if (event.projectIds.includes(projectId)) worker.request(); };
  const unsubscribe = onAuthoredChangeCommitted(changed);
  const unregisterFlush = registerMarkdownProjectionFlush(async () => { worker.request(); await worker.flush(); });
  events.on('sync:project-changed', changed);
  events.on('sync:projects-restored', restored);
  worker.request();
  void worker.flush(false);
  return () => {
    disposed = true;
    unsubscribe();
    unregisterFlush();
    events.off('sync:project-changed', changed);
    events.off('sync:projects-restored', restored);
    worker.dispose();
    if (workers.get(projectId) === worker) workers.delete(projectId);
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
