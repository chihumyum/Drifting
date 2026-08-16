/**
 * Process-wide Yjs local-durability coordination.
 *
 * Remote Yjs transport belongs exclusively to SyncEngine change-sets. This
 * module intentionally contains no provider cursor, HTTP call, Base64 wire
 * format, or server push/pull path. It owns only live-document drain,
 * snapshot compaction, and full-state capture used by checkpoints.
 */
import loglevel from 'loglevel';

import type { YjsRepository } from '../sqlite-repo/yjs-repo';

const log = loglevel.getLogger('yjs-local-durability');
log.setLevel(loglevel.levels.WARN);

interface ActiveYjsDocument {
  projectId: string;
  flushLocal: () => Promise<void>;
}

const activeDocuments = new Map<string, Set<ActiveYjsDocument>>();
const teardownWaiters = new Set<() => void>();
let teardownErrors: unknown[] = [];

function activeEntries(): Array<[string, ActiveYjsDocument]> {
  return [...activeDocuments.entries()].flatMap(([docId, entries]) =>
    [...entries].map((entry) => [docId, entry] as [string, ActiveYjsDocument]),
  );
}

function activeDocumentCount(): number {
  let count = 0;
  for (const entries of activeDocuments.values()) count += entries.size;
  return count;
}

function notifyDocumentsClosed(): void {
  if (activeDocuments.size > 0) return;
  for (const resolve of teardownWaiters) resolve();
  teardownWaiters.clear();
}

function assertSuccessfulTeardown(): void {
  if (teardownErrors.length === 0) return;
  const failures = teardownErrors;
  teardownErrors = [];
  throw new AggregateError(failures, `${failures.length} Yjs document(s) failed final teardown`);
}

export function registerLocalYjsDocument(
  projectId: string,
  docId: string,
  flushLocal: () => Promise<void>,
): () => void {
  if (!projectId.trim() || !docId.trim()) {
    throw new Error('A registered Yjs document requires projectId and docId');
  }
  const entry: ActiveYjsDocument = { projectId, flushLocal };
  const entries = activeDocuments.get(docId) ?? new Set<ActiveYjsDocument>();
  entries.add(entry);
  activeDocuments.set(docId, entries);

  return () => {
    if (!activeDocuments.get(docId)?.has(entry)) return;
    // A sibling React cleanup queues the final close snapshot synchronously.
    // Defer one microtask before draining so that snapshot is included.
    queueMicrotask(() => {
      void entry
        .flushLocal()
        .catch((error) => {
          teardownErrors.push(error);
          log.error(`[yjs lifecycle] final local flush failed for ${docId}:`, error);
        })
        .finally(() => {
          const current = activeDocuments.get(docId);
          current?.delete(entry);
          if (current?.size === 0) activeDocuments.delete(docId);
          notifyDocumentsClosed();
        });
    });
  };
}

export function waitForYjsDocumentTeardown(timeoutMs = 5_000): Promise<void> {
  if (activeDocuments.size === 0) {
    return Promise.resolve().then(assertSuccessfulTeardown);
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      teardownWaiters.delete(finish);
      resolve();
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      teardownWaiters.delete(finish);
      reject(
        new Error(`Timed out waiting for ${activeDocumentCount()} Yjs document(s) to close safely`),
      );
    }, timeoutMs);
    teardownWaiters.add(finish);
    if (activeDocuments.size === 0) finish();
  }).then(assertSuccessfulTeardown);
}

async function flushEntries(entries: Array<[string, ActiveYjsDocument]>): Promise<void> {
  const results = await Promise.allSettled(entries.map(([, entry]) => entry.flushLocal()));
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      `${failures.length} Yjs document persistence queue(s) failed to flush`,
    );
  }
}

export async function flushAllOpenYjsDocuments(): Promise<void> {
  await flushEntries(activeEntries());
}

export async function flushOpenYjsDocument(docId: string): Promise<void> {
  const entries = [...(activeDocuments.get(docId) ?? [])].map(
    (entry) => [docId, entry] as [string, ActiveYjsDocument],
  );
  if (entries.length === 0) {
    throw new Error(`No active Yjs persistence session is registered for ${docId}`);
  }
  await flushEntries(entries);
}

/** Cmd+S/lifecycle durability barrier. Remote publication is scheduled separately. */
export async function flushAllYjsDocumentsLocally(): Promise<void> {
  await flushAllOpenYjsDocuments();
}

export function activeYjsProjects(): readonly string[] {
  return [...new Set(activeEntries().map(([, entry]) => entry.projectId))].sort();
}

/**
 * A full snapshot is a durable superset of updates at or below the caller's
 * coverage watermark. Provider publication no longer controls local
 * compaction: every authored update must already have an immutable journal
 * mutation in the same transaction before this function may receive its id.
 */
export async function compactUpdatesAfterSnapshot(
  docId: string,
  snapshotCoveredId: number,
  repo: YjsRepository,
): Promise<number> {
  if (!Number.isSafeInteger(snapshotCoveredId) || snapshotCoveredId <= 0) return 0;
  const pruned = await repo.deleteUpdatesUpTo(docId, snapshotCoveredId);
  if (pruned > 0) {
    log.debug(`[compact] ${docId}: pruned ${pruned} updates (id <= ${snapshotCoveredId})`);
  }
  return pruned;
}
