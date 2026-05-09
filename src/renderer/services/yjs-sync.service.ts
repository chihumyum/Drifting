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
import { createYjsRepository, type YjsRepository } from '../sqlite-repo/yjs-repo';
import loglevel from 'loglevel';

const log = loglevel.getLogger('yjs-sync');
log.setLevel(loglevel.levels.WARN);

const PUSH_BATCH_SIZE = 50;

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

  for (let i = 0; i < unpushed.length; i += PUSH_BATCH_SIZE) {
    const batch = unpushed.slice(i, i + PUSH_BATCH_SIZE);
    const payload = {
      docId,
      projectId,
      updates: batch.map((u) => ({
        clientUpdateId: `${docId}:${u.id}`,
        data: uint8ToBase64(u.updateBlob),
      })),
    };

    const res = await apiClient.post('/api/sync/push', payload);
    if (res.data?.success) {
      const lastLocalId = batch[batch.length - 1].id;
      await updateCursor(docId, { lastPushedLocalId: lastLocalId });
      log.info(`[push] ${docId}: pushed ${batch.length} updates, lastLocalId=${lastLocalId}`);
    } else {
      log.error(`[push] ${docId}: server returned failure`, res.data);
      throw new Error('Sync push failed');
    }
  }
}

// ───── Pull ─────

export async function pullUpdates(docId: string, ydoc: Y.Doc, repo?: YjsRepository): Promise<void> {
  if (!isSyncEnabled()) return;

  const r = repo ?? createYjsRepository();
  const cursor = await getCursor(docId);

  const res = await apiClient.get('/api/sync/pull', {
    params: { docId, sinceSeq: cursor.lastServerSeq },
  });

  const updates: Array<{ serverSeq: number; data: string; clientUpdateId: string }> =
    res.data?.updates ?? [];

  if (updates.length === 0) return;

  let maxSeq = cursor.lastServerSeq;

  for (const u of updates) {
    // Skip self-originated updates (already in local DB)
    if (u.clientUpdateId && u.clientUpdateId.startsWith(`${docId}:`)) {
      maxSeq = Math.max(maxSeq, u.serverSeq);
      continue;
    }

    const blob = base64ToUint8(u.data);
    Y.applyUpdate(ydoc, blob, 'remote');
    maxSeq = Math.max(maxSeq, u.serverSeq);
  }

  // Save a snapshot after applying remote updates
  const fullState = Y.encodeStateAsUpdate(ydoc);
  await r.upsertSnapshot(docId, fullState);

  await updateCursor(docId, { lastServerSeq: maxSeq });
  log.info(`[pull] ${docId}: applied ${updates.length} remote updates, lastServerSeq=${maxSeq}`);
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
