/**
 * Yjs Sync Service — pushes local Yjs updates to server, pulls remote updates.
 * Append-only update log, cursor-based pagination.
 */
import * as Y from 'yjs';
import { eq } from 'drizzle-orm';
import { getDb } from '../lib/db';
import {
  BookElementTable,
  BookNodeTable,
  ElementCategoryTable,
  StorylineTable,
  yjsSyncCursor,
} from '../schema/drizzle';
import { isSyncEnabled } from '../lib/config';
import { apiClient } from '../lib/axios-config';
import { maybeCaptureSnapshotHistory } from './snapshot-history.service';
import { getDeviceId } from '../lib/device-id';
import { events, type SyncOperationEvent } from '../lib/events';
import { createYjsRepository, type YjsRepository } from '../sqlite-repo/yjs-repo';
import { parseDocId, entityTypeForDocKind } from '../lib/yjs-doc-id';
import loglevel from 'loglevel';

const log = loglevel.getLogger('yjs-sync');
log.setLevel(loglevel.levels.WARN);

const PUSH_BATCH_SIZE = 50;
const PULL_PAGE_SIZE = 1000;
const MAX_PULL_PAGES = 10_000;

interface ActiveSyncDocument {
  flushLocal: () => Promise<void>;
  syncNow: () => Promise<void>;
}

const activeSyncDocuments = new Map<string, Set<ActiveSyncDocument>>();
const teardownWaiters = new Set<() => void>();
let teardownErrors: unknown[] = [];

function activeDocumentEntries(): Array<[string, ActiveSyncDocument]> {
  return [...activeSyncDocuments.entries()].flatMap(([docId, entries]) =>
    [...entries].map((entry) => [docId, entry] as [string, ActiveSyncDocument]),
  );
}

function activeDocumentCount(): number {
  let count = 0;
  for (const entries of activeSyncDocuments.values()) count += entries.size;
  return count;
}

function notifyYjsDocumentsClosed(): void {
  if (activeSyncDocuments.size > 0) return;
  for (const resolve of teardownWaiters) resolve();
  teardownWaiters.clear();
}

function assertSuccessfulYjsTeardown(): void {
  if (teardownErrors.length === 0) return;
  const failures = teardownErrors;
  teardownErrors = [];
  throw new AggregateError(failures, `${failures.length} Yjs document(s) failed final teardown`);
}

/**
 * Register an open document for app-wide persistence.
 *
 * Registration is deliberately independent of server-sync configuration:
 * local-only documents still have an asynchronous SQLite write queue that
 * Cmd+S, suspend, logout and native shutdown must drain. On React teardown we
 * keep the entry alive until useYjsDoc's close snapshot (queued by its earlier
 * effect cleanup) has reached SQLite, so an account switch cannot close the
 * old database underneath that write.
 */
export function registerSyncDocument(
  docId: string,
  flushLocal: () => Promise<void>,
  syncNow: () => Promise<void>,
): () => void {
  const entry: ActiveSyncDocument = { flushLocal, syncNow };
  let entries = activeSyncDocuments.get(docId);
  if (!entries) {
    entries = new Set();
    activeSyncDocuments.set(docId, entries);
  }
  entries.add(entry);

  return () => {
    if (!activeSyncDocuments.get(docId)?.has(entry)) return;
    // React invokes sibling effect cleanups in the same commit. Defer one
    // microtask so useYjsDoc can synchronously capture its final Y.Doc state
    // and append the close snapshot task before we read the queue tail.
    queueMicrotask(() => {
      void entry
        .flushLocal()
        .catch((error) => {
          teardownErrors.push(error);
          log.error(`[yjs lifecycle] final local flush failed for ${docId}:`, error);
        })
        .finally(() => {
          const currentEntries = activeSyncDocuments.get(docId);
          currentEntries?.delete(entry);
          if (currentEntries?.size === 0) activeSyncDocuments.delete(docId);
          notifyYjsDocumentsClosed();
        });
    });
  };
}

/** Wait until every currently mounted Yjs document has completed unmount persistence. */
export function waitForYjsDocumentTeardown(timeoutMs = 5_000): Promise<void> {
  if (activeSyncDocuments.size === 0) {
    return Promise.resolve().then(assertSuccessfulYjsTeardown);
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
    // Close may have completed between the initial size check and registration.
    if (activeSyncDocuments.size === 0) finish();
  }).then(assertSuccessfulYjsTeardown);
}

/** Drain every open document's local SQLite write queue. */
export async function flushAllOpenYjsDocuments(): Promise<void> {
  await flushActiveEntries(activeDocumentEntries());
}

/**
 * Durably drain one live document. Agent writes call this before publishing a
 * successful tool result, so an open-editor mutation cannot be acknowledged
 * while its asynchronous SQLite queue is still pending.
 */
export async function flushOpenYjsDocument(docId: string): Promise<void> {
  const entries = [...(activeSyncDocuments.get(docId) ?? [])].map(
    (entry) => [docId, entry] as [string, ActiveSyncDocument],
  );
  if (entries.length === 0) {
    throw new Error(`No active Yjs persistence session is registered for ${docId}`);
  }
  await flushActiveEntries(entries);
}

async function flushActiveEntries(
  entries: Array<[string, ActiveSyncDocument]>,
): Promise<void> {
  const results = await Promise.allSettled(
    entries.map(([, { flushLocal }]) => flushLocal()),
  );
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => (failure as PromiseRejectedResult).reason),
      `${failures.length} Yjs document persistence queue(s) failed to flush`,
    );
  }
}

/**
 * Persist every open Yjs document, then (only when enabled) push/pull server
 * state. Local durability is always completed before any remote sync begins.
 */
export async function forceSyncAllDocuments(): Promise<void> {
  const activeEntries = activeDocumentEntries();
  await flushAllOpenYjsDocuments();
  if (!isSyncEnabled()) return;

  const activeIds = new Set(activeEntries.map(([docId]) => docId));
  const entriesByDoc = new Map<string, ActiveSyncDocument[]>();
  for (const [docId, entry] of activeEntries) {
    const entries = entriesByDoc.get(docId) ?? [];
    entries.push(entry);
    entriesByDoc.set(docId, entries);
  }
  const activeResults = await Promise.allSettled(
    [...entriesByDoc.values()].map(async (entries) => {
      // Duplicate mounts of the same logical doc share one SQLite cursor.
      // Sync them serially so push/pull cursor updates cannot race, while each
      // live Y.Doc still receives the remote state.
      for (const { syncNow } of entries) await syncNow();
    }),
  );
  const repo = createYjsRepository();
  const closedDocIds = (await repo.listDocIds()).filter((docId) => !activeIds.has(docId));
  const closedResults = await Promise.allSettled(
    closedDocIds.map(async (docId) => {
      const projectId = await resolveProjectIdForDoc(docId);
      if (!projectId) return;
      await pushUpdates(docId, projectId, repo);
    }),
  );
  const failures = [...activeResults, ...closedResults].filter(
    (result) => result.status === 'rejected',
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => (failure as PromiseRejectedResult).reason),
      `${failures.length} Yjs document(s) failed to sync`,
    );
  }
}

async function resolveProjectIdForDoc(docId: string): Promise<string | null> {
  const parsed = parseDocId(docId);
  if (!parsed?.entityId) return null;
  const table =
    parsed.kind === 'node-content'
      ? BookNodeTable
      : parsed.kind === 'element'
        ? BookElementTable
        : parsed.kind === 'storyline'
          ? StorylineTable
          : ElementCategoryTable;
  const rows = await getDb()
    .select({ projectId: table.projectId })
    .from(table)
    .where(eq(table.id, parsed.entityId))
    .limit(1);
  return rows[0]?.projectId ?? null;
}

export function getYjsDeviceId(): string {
  return getDeviceId();
}

function nowMs(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

function createRequestId(phase: SyncOperationEvent['phase'], docId: string): string {
  return `${phase}:${docId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

function getEntityMetaFromDocId(docId: string): {
  entityType: string;
  entityId: string | undefined;
} {
  const parsed = parseDocId(docId);
  if (!parsed) {
    // Unknown docId format — fall back to letting the event carry the raw
    // string so SyncActivityPanel still shows something useful.
    return { entityType: 'unknown', entityId: undefined };
  }
  return {
    entityType: entityTypeForDocKind(parsed.kind),
    entityId: parsed.entityId || undefined,
  };
}

function emitSyncOperation(event: Omit<SyncOperationEvent, 'at'>): void {
  events.emit('sync:operation', { ...event, at: Date.now() });
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// ───── Cursor helpers ─────

interface SyncCursor {
  docId: string;
  lastServerSeq: number;
  lastPushedLocalId: number;
  updatedAt: string;
}

export async function getCursor(docId: string): Promise<SyncCursor> {
  const rows = await getDb()
    .select()
    .from(yjsSyncCursor)
    .where(eq(yjsSyncCursor.docId, docId))
    .limit(1);

  if (rows[0]) return rows[0] as SyncCursor;

  const now = new Date().toISOString();
  const fresh: SyncCursor = { docId, lastServerSeq: 0, lastPushedLocalId: 0, updatedAt: now };
  await getDb().insert(yjsSyncCursor).values(fresh).onConflictDoNothing();
  return fresh;
}

export async function updateCursor(
  docId: string,
  patch: Partial<Pick<SyncCursor, 'lastServerSeq' | 'lastPushedLocalId'>>,
): Promise<void> {
  await getDb()
    .update(yjsSyncCursor)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(yjsSyncCursor.docId, docId));
}

/**
 * Drop the cursor for a doc. Forces the next pull to re-fetch from
 * `sinceSeq = 0` and the next push to re-scan all local updates. Used by
 * the load path when it finds no local Yjs state — without this reset,
 * a wiped sqlite + persisted cursor produces a "stuck empty ydoc"
 * deadlock: pull thinks everything is consumed, push thinks everything
 * is shipped, but the doc is actually empty.
 */
export async function resetCursor(docId: string): Promise<void> {
  await getDb().delete(yjsSyncCursor).where(eq(yjsSyncCursor.docId, docId));
}

// ───── Compaction ─────

/**
 * Prune the local `yjs_updates` log after a fresh snapshot has been written.
 *
 * The snapshot blob is a full-state superset of every update with id <=
 * `snapshotCoveredId`, so those rows are redundant for local reload. When
 * sync is on we additionally cap the deletion at the push cursor's
 * `lastPushedLocalId`, so a local edit the server hasn't durably received
 * yet is never dropped (it would otherwise never converge to other devices).
 * In local-only mode there is no server, so the snapshot alone is durable and
 * we compact up to `snapshotCoveredId`.
 *
 * Contract: the caller MUST upsert the snapshot BEFORE calling this, so a
 * snapshot always covers whatever rows we delete. Returns rows pruned.
 */
export async function compactUpdatesAfterSnapshot(
  docId: string,
  snapshotCoveredId: number,
  repo: YjsRepository,
): Promise<number> {
  if (snapshotCoveredId <= 0) return 0;

  let bound = snapshotCoveredId;
  if (isSyncEnabled()) {
    const cursor = await getCursor(docId);
    bound = Math.min(bound, cursor.lastPushedLocalId);
  }
  if (bound <= 0) return 0;

  const pruned = await repo.deleteUpdatesUpTo(docId, bound);
  if (pruned > 0) {
    log.debug(`[compact] ${docId}: pruned ${pruned} updates (id <= ${bound})`);
  }
  return pruned;
}

// ───── Encoding helpers ─────

export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ───── Push ─────

export async function pushUpdates(
  docId: string,
  projectId: string,
  repo?: YjsRepository,
): Promise<void> {
  if (!isSyncEnabled()) return;

  const r = repo ?? createYjsRepository();
  const cursor = await getCursor(docId);
  const unpushed = await r.listUpdates(docId, cursor.lastPushedLocalId);
  if (unpushed.length === 0) return;

  const deviceId = getYjsDeviceId();

  for (let i = 0; i < unpushed.length; i += PUSH_BATCH_SIZE) {
    const batch = unpushed.slice(i, i + PUSH_BATCH_SIZE);
    const requestId = createRequestId('push', docId);
    const startedAt = nowMs();
    const payload = {
      docId,
      projectId,
      deviceId,
      // clientUpdateId includes the row's createdAt timestamp so that the
      // unique key `(doc_id, client_update_id)` on the server doesn't collide
      // across local-sqlite resets. Older format `${docId}:${deviceId}:${id}`
      // collided if yjs_updates was wiped and ids restarted from 1 — server
      // dedupped silently, client cursor advanced anyway, data was lost.
      updates: batch.map((u) => ({
        clientUpdateId: `${docId}:${deviceId}:${u.createdAt}:${u.id}`,
        data: uint8ToBase64(u.updateBlob),
      })),
    };

    emitSyncOperation({
      requestId,
      kind: 'yjs',
      phase: 'push',
      state: 'started',
      operation: 'push',
      method: 'POST',
      endpoint: '/api/sync/push',
      docId,
      ...getEntityMetaFromDocId(docId),

      projectId,
      deviceId,
      localUpdateCount: batch.length,
    });

    try {
      const res = await apiClient.post('/api/sync/push', payload);
      if (!res.data?.success) {
        log.error(`[push] ${docId}: server returned failure`, res.data);
        throw new Error('Sync push failed');
      }

      const lastLocalId = batch[batch.length - 1].id;
      const serverSeqs = Array.isArray(res.data.serverSeqs) ? res.data.serverSeqs : [];
      // Defence: if the server accepted at least one update from the batch
      // OR returned an empty batch (all were already deduped through retry),
      // advance the cursor. Logging the discrepancy helps catch cases like
      // the historical clientUpdateId-collision bug (different rows producing
      // the same clientUpdateId, server silently dropping them, cursor
      // advancing past data that never landed).
      if (serverSeqs.length < batch.length) {
        log.warn(
          `[push] ${docId}: server accepted ${serverSeqs.length}/${batch.length} updates ` +
            `(${batch.length - serverSeqs.length} deduped). Advancing cursor anyway — ` +
            `likely safe if these were retries; if not, the missing rows are lost.`,
        );
      }
      await updateCursor(docId, { lastPushedLocalId: lastLocalId });
      emitSyncOperation({
        requestId,
        kind: 'yjs',
        phase: 'push',
        state: 'succeeded',
        operation: 'push',
        method: 'POST',
        endpoint: '/api/sync/push',
        docId,
        ...getEntityMetaFromDocId(docId),

        projectId,
        deviceId,
        localUpdateCount: batch.length,
        serverSeqCount: serverSeqs.length,
        durationMs: nowMs() - startedAt,
      });
      log.info(`[push] ${docId}: pushed ${batch.length} updates, lastLocalId=${lastLocalId}`);
    } catch (error) {
      emitSyncOperation({
        requestId,
        kind: 'yjs',
        phase: 'push',
        state: 'failed',
        operation: 'push',
        method: 'POST',
        endpoint: '/api/sync/push',
        docId,
        ...getEntityMetaFromDocId(docId),

        projectId,
        deviceId,
        localUpdateCount: batch.length,
        durationMs: nowMs() - startedAt,
        error: getErrorMessage(error),
      });
      throw error;
    }
  }
}

// ───── Pull ─────

export async function pullUpdates(docId: string, ydoc: Y.Doc, repo?: YjsRepository): Promise<void> {
  if (!isSyncEnabled()) return;

  const r = repo ?? createYjsRepository();
  const cursor = await getCursor(docId);
  const deviceId = getYjsDeviceId();
  const requestId = createRequestId('pull', docId);
  const startedAt = nowMs();

  emitSyncOperation({
    requestId,
    kind: 'yjs',
    phase: 'pull',
    state: 'started',
    operation: 'pull',
    method: 'GET',
    endpoint: '/api/sync/pull',
    docId,
    ...getEntityMetaFromDocId(docId),

    deviceId,
  });

  try {
    let maxSeq = cursor.lastServerSeq;
    let appliedCount = 0;
    let pageCount = 0;

    while (pageCount < MAX_PULL_PAGES) {
      const res = await apiClient.get('/api/sync/pull', {
        params: { docId, sinceSeq: maxSeq, limit: PULL_PAGE_SIZE },
      });
      const updates: Array<{
        serverSeq: number;
        data: string;
        clientUpdateId: string;
        deviceId: string | null;
      }> = res.data?.updates ?? [];
      if (updates.length === 0) break;

      const previousSeq = maxSeq;
      for (const update of updates) {
        // Yjs updates are idempotent, including updates originating on this
        // device. Applying every row also makes a wiped-device recovery safe.
        Y.applyUpdate(ydoc, base64ToUint8(update.data), 'remote');
        maxSeq = Math.max(maxSeq, update.serverSeq);
        appliedCount += 1;
      }
      if (maxSeq <= previousSeq) {
        throw new Error(`Sync pull made no cursor progress for ${docId}`);
      }
      pageCount += 1;
      if (res.data?.hasMore !== true) break;
    }

    if (pageCount >= MAX_PULL_PAGES) {
      throw new Error(`Sync pull exceeded ${MAX_PULL_PAGES} pages for ${docId}`);
    }

    if (appliedCount > 0) {
      // Persist only after the complete catch-up, so the editor remains in its
      // existing loading state instead of becoming editable halfway through.
      const fullState = Y.encodeStateAsUpdate(ydoc);
      await r.upsertSnapshot(docId, fullState, {
        source: { kind: 'remote' },
      });
      // The durable snapshot must land before the cursor advances. If a later
      // page or the process fails, leaving the old cursor simply replays
      // idempotent Yjs updates; advancing first could skip data not in SQLite.
      await updateCursor(docId, { lastServerSeq: maxSeq });
      maybeCaptureSnapshotHistory(docId, fullState);
    }

    emitSyncOperation({
      requestId,
      kind: 'yjs',
      phase: 'pull',
      state: 'succeeded',
      operation: 'pull',
      method: 'GET',
      endpoint: '/api/sync/pull',
      docId,
      ...getEntityMetaFromDocId(docId),

      deviceId,
      remoteUpdateCount: appliedCount,
      appliedUpdateCount: appliedCount,
      skippedUpdateCount: 0,
      durationMs: nowMs() - startedAt,
    });
    log.info(
      `[pull] ${docId}: applied ${appliedCount} remote updates in ${pageCount} page(s), ` +
        `lastServerSeq=${maxSeq}`,
    );
  } catch (error) {
    emitSyncOperation({
      requestId,
      kind: 'yjs',
      phase: 'pull',
      state: 'failed',
      operation: 'pull',
      method: 'GET',
      endpoint: '/api/sync/pull',
      docId,
      ...getEntityMetaFromDocId(docId),

      deviceId,
      durationMs: nowMs() - startedAt,
      error: getErrorMessage(error),
    });
    throw error;
  }
}

// ───── Full sync cycle ─────

export async function syncDocument(
  docId: string,
  projectId: string,
  ydoc: Y.Doc,
  repo?: YjsRepository,
): Promise<void> {
  if (!isSyncEnabled()) return;

  await pushUpdates(docId, projectId, repo);
  await pullUpdates(docId, ydoc, repo);
}
