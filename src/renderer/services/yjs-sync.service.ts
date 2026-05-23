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
      updates: batch.map((u) => ({
        clientUpdateId: `${docId}:${deviceId}:${u.id}`,
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
      // Skip self-originated updates (already in local DB)
      if (u.deviceId === deviceId) {
        maxSeq = Math.max(maxSeq, u.serverSeq);
        skippedCount += 1;
        continue;
      }

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
