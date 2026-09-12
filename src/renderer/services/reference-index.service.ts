import loglevel from 'loglevel';
import { getDb, getDbIfInitialized, type DbClient } from '../lib/db';
import { events } from '../lib/events';
import { onAuthoredChangeCommitted } from '../sync/journal/authored-transaction';
import { boundedProseDocIds } from '../sync/prose-change-scope';
import { parseDocId } from '../lib/yjs-doc-id';
import { createReferenceIndexRepository } from './reference-index-repository';
import { createReferenceIndexQueue, type ReferenceIndexQueueSnapshot } from './reference-index-queue';

const log = loglevel.getLogger('ReferenceIndexService');
log.setLevel(loglevel.levels.WARN);

type Queue = ReturnType<typeof createReferenceIndexQueue>;
interface Entry { queue: Queue; retainers: number; stop: () => void }
const entries = new WeakMap<DbClient, Map<string, Entry>>();
const listeners = new Map<string, Set<() => void>>();
const INACTIVE: ReferenceIndexQueueSnapshot = { phase: 'disposed', hasError: false, lastRun: null };

function notify(projectId: string): void {
  for (const listener of [...(listeners.get(projectId) ?? [])]) {
    try { listener(); } catch { log.warn('Reference index status observer failed.'); }
  }
}

function currentEntry(projectId: string): Entry | undefined {
  const database = getDbIfInitialized();
  return database ? entries.get(database)?.get(projectId) : undefined;
}

export function getProjectReferenceIndexSnapshot(projectId: string): ReferenceIndexQueueSnapshot {
  return currentEntry(projectId)?.queue.getSnapshot() ?? INACTIVE;
}

/** Observing status never creates or retains a project worker. */
export function subscribeProjectReferenceIndex(projectId: string, listener: () => void): () => void {
  let subscribers = listeners.get(projectId);
  if (!subscribers) { subscribers = new Set(); listeners.set(projectId, subscribers); }
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0) listeners.delete(projectId);
  };
}

export function retryProjectReferenceIndex(projectId: string): void {
  currentEntry(projectId)?.queue.request(true);
}

/** Owned by the ready user/project runtime, independent of routes and tabs.
 * Startup always reconciles the complete catalog, including commits that
 * happened before event subscription or while the renderer was not running. */
export function retainProjectReferenceIndex(projectId: string): () => void {
  const database = getDb();
  let projects = entries.get(database);
  if (!projects) { projects = new Map(); entries.set(database, projects); }
  let entry = projects.get(projectId);
  if (entry?.queue.getSnapshot().phase === 'disposed') {
    entry.stop();
    entry = undefined;
  }
  if (!entry) {
    let stopped = false;
    const disposers: Array<() => void> = [];
    const queue = createReferenceIndexQueue({
      isCurrent: () => !stopped && getDbIfInitialized() === database,
      createRepository: (isCurrent) => createReferenceIndexRepository({ database, projectId, isCurrent }),
      onSnapshot: () => notify(projectId),
      onChanged: () => events.emit('references:changed', { projectId }),
      onError: () => log.warn('Reference index is incomplete; a bounded retry is scheduled.'),
    });
    const stop = () => {
      if (stopped) return;
      stopped = true;
      for (const dispose of disposers) dispose();
      projects.delete(projectId);
      queue.dispose();
    };
    entry = { queue, retainers: 0, stop };
    projects.set(projectId, entry);
    const request = (force = false, proseDocIds?: readonly string[]) => {
      if (getDbIfInitialized() !== database) { stop(); return; }
      const bounded = proseDocIds && boundedProseDocIds(proseDocIds);
      const sources = bounded?.map((docId) => {
        const parsed = parseDocId(docId)!;
        return { kind: parsed.kind === 'node-content' ? 'node' as const : parsed.kind, id: parsed.entityId };
      });
      queue.request(force, sources);
    };
    disposers.push(onAuthoredChangeCommitted((event) => {
      if (event.projectId === projectId) request(false, event.proseDocIds);
    }));
    const remote = (event: { projectId: string; projectionImpact: 'prose-only' | 'workspace'; proseDocIds?: readonly string[] }) => {
      if (event.projectId === projectId) request(false, event.projectionImpact === 'prose-only' ? event.proseDocIds : undefined);
    };
    const restored = (event: { projectIds: string[] }) => { if (event.projectIds.includes(projectId)) request(true); };
    const authority = () => request(true);
    const coverage = (event: { projectId: string }) => { if (event.projectId === projectId) request(true); };
    const databaseReady = () => { if (getDbIfInitialized() !== database) stop(); };
    events.on('sync:project-changed', remote);
    events.on('sync:projects-restored', restored);
    events.on('sync:authority-changed', authority);
    events.on('sync:reference-coverage-invalidated', coverage);
    events.on('db:ready', databaseReady);
    disposers.push(
      () => events.off('sync:project-changed', remote),
      () => events.off('sync:projects-restored', restored),
      () => events.off('sync:authority-changed', authority),
      () => events.off('sync:reference-coverage-invalidated', coverage),
      () => events.off('db:ready', databaseReady),
    );
    queue.request(true);
  }
  const retained = entry;
  retained.retainers += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    retained.retainers -= 1;
    if (retained.retainers === 0) retained.stop();
  };
}
