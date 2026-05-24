/**
 * Yjs Sync Service — pushes local Yjs updates to server, pulls remote updates.
 * Append-only update log, cursor-based pagination.
 */
import * as Y from 'yjs';
import { eq } from 'drizzle-orm';
import { getDb } from '../lib/db';
import { yjsSyncCursor } from '../schema/drizzle';
import { isSyncEnabled } from '../lib/config';
import { apiClient } from '../lib/axios-config';
import { getDeviceId } from '../lib/device-id';
import { events, type SyncOperationEvent } from '../lib/events';
import { createYjsRepository, type YjsRepository } from '../sqlite-repo/yjs-repo';
import { parseDocId, entityTypeForDocKind } from '../lib/yjs-doc-id';
import loglevel from 'loglevel';

const log = loglevel.getLogger('yjs-sync');
log.setLevel(loglevel.levels.WARN);

const PUSH_BATCH_SIZE = 50;

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
    const res = await apiClient.get('/api/sync/pull', {
      params: { docId, sinceSeq: cursor.lastServerSeq },
    });

    const updates: Array<{
      serverSeq: number;
      data: string;
      clientUpdateId: string;
      deviceId: string | null;
    }> = res.data?.updates ?? [];

    if (updates.length === 0) {
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
        remoteUpdateCount: 0,
        appliedUpdateCount: 0,
        skippedUpdateCount: 0,
        durationMs: nowMs() - startedAt,
      });
      return;
    }

    let maxSeq = cursor.lastServerSeq;
    let appliedCount = 0;
    let skippedCount = 0;

    for (const u of updates) {
      // Apply unconditionally. The historical "skip when u.deviceId === me"
      // optimization assumed local sqlite still has the rows I pushed, so
      // re-applying them on pull is wasted work. That assumption breaks the
      // recovery case: if local sqlite is wiped but cursor.lastServerSeq is
      // preserved (or just trailing my push), every pulled update has my
      // own deviceId, gets skipped, and ydoc stays empty forever.
      //
      // Y.applyUpdate is idempotent so re-applying our own ops costs only a
      // few extra CPU cycles per pull. Keep the codepath simple.
      const blob = base64ToUint8(u.data);
      Y.applyUpdate(ydoc, blob, 'remote');
      maxSeq = Math.max(maxSeq, u.serverSeq);
      appliedCount += 1;
    }

    // Save a snapshot after applying remote updates
    const fullState = Y.encodeStateAsUpdate(ydoc);
    await r.upsertSnapshot(docId, fullState);

    await updateCursor(docId, { lastServerSeq: maxSeq });
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
      remoteUpdateCount: updates.length,
      appliedUpdateCount: appliedCount,
      skippedUpdateCount: skippedCount,
      durationMs: nowMs() - startedAt,
    });
    log.info(`[pull] ${docId}: applied ${appliedCount} remote updates, lastServerSeq=${maxSeq}`);
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
