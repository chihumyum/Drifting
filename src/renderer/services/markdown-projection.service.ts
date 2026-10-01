import { registerMarkdownProjectionFlush } from './markdown-projection-lifecycle';
import { platform } from '../platform';
import { publishMarkdownProjectionStatus as publish } from './markdown-projection-status';
import { getDbIfInitialized } from '../lib/db';
import { events } from '../lib/events';
import { onAuthoredChangeCommitted } from '../sync/journal/authored-transaction';
import { flushAllOpenYjsDocuments } from './yjs-local-durability.service';
import { readLocalRelationalMarkdownSource } from './export/relational-markdown.local-source';
import { buildRelationalMarkdownEntries } from './export/relational-markdown.service';

const workers = new Map<string, ReturnType<typeof createProjectionWorker>>();

/** Coalesce commits without starving a continuous writer. One capture at a time. */
export function createProjectionWorker(refresh: () => Promise<void>, failed: (error: unknown) => void) {
  let dirty = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  const flush = async (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (running) { await running; if (dirty && !disposed) await flush(); return; }
    if (!dirty || disposed) return;
    dirty = false;
    running = refresh().catch(error => { failed(error); }).finally(() => { running = undefined; });
    await running;
    if (dirty && !disposed) request();
  };
  const request = () => {
    if (disposed) return;
    dirty = true;
    // Keep the first deadline instead of resetting it on every keystroke.
    timer ??= setTimeout(() => { timer = undefined; void flush(); }, 1000);
  };
  return { request, flush, dispose() { disposed = true; dirty = false; if (timer) clearTimeout(timer); } };
}

/** Project service, independent of whether an external MCP client is connected. */
export function installMarkdownProjection(projectId: string): () => void {
  let disposed = false;
  const database = getDbIfInitialized();
  const active = () => !disposed && getDbIfInitialized() === database;
  publish(projectId, { state: 'pending', readOnly: true, reverseSync: false });
  const worker = createProjectionWorker(async () => {
    if (!active()) return;
    publish(projectId, { state: 'pending', error: undefined });
    const info = await platform.markdownProjection.info(projectId);
    if (!active()) return;
    publish(projectId, { ...info, state: 'pending' });
    await flushAllOpenYjsDocuments();
    if (!active()) return;
    const source = await readLocalRelationalMarkdownSource(projectId);
    if (!active()) return;
    if (source.books.length !== 1) throw new Error('Projection project no longer exists');
    const { entries } = await buildRelationalMarkdownEntries(source, true);
    if (!active()) return;
    const result = await platform.markdownProjection.write(projectId, new Date().toISOString(), entries);
    if (active()) publish(projectId, { ...result, state: 'ready', error: undefined });
  }, error => {
    if (active()) publish(projectId, { state: 'error', error: error instanceof Error ? error.message : String(error) });
  });
  workers.get(projectId)?.dispose();
  workers.set(projectId, worker);
  const changed = (event: { projectId: string }) => { if (event.projectId === projectId) worker.request(); };
  const restored = (event: { projectIds: string[] }) => { if (event.projectIds.includes(projectId)) worker.request(); };
  const unsubscribe = onAuthoredChangeCommitted(changed);
  const unregisterFlush = registerMarkdownProjectionFlush(async () => { worker.request(); await worker.flush(); });
  events.on('sync:project-changed', changed);
  events.on('sync:projects-restored', restored);
  worker.request();
  void worker.flush();
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
}

/** Called only after the project deletion committed; prevent a late capture from republishing it. */
export async function removeMarkdownProjection(projectId: string): Promise<void> {
  const worker = workers.get(projectId);
  if (worker) { worker.dispose(); await worker.flush(); workers.delete(projectId); }
  await platform.markdownProjection.remove(projectId);
}
