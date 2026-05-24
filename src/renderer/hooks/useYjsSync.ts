/**
 * useYjsSync — wraps useYjsDoc with periodic server sync.
 *
 * Provides the same interface as useYjsDoc plus:
 *   syncStatus  — 'idle' | 'syncing' | 'error' | 'disabled'
 *   lastSyncAt  — ISO timestamp of last successful sync
 *   triggerSync  — manually kick a push+pull cycle
 */
import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import * as Y from 'yjs';
import { useYjsDoc, type UseYjsDocResult } from './useYjsDoc';
import { syncDocument } from '../services/yjs-sync.service';
import { isSyncEnabled } from '../lib/config';
import loglevel from 'loglevel';

const log = loglevel.getLogger('useYjsSync');
log.setLevel(loglevel.levels.WARN);

const INITIAL_SYNC_DELAY_MS = 1_000;
const PERIODIC_SYNC_MS = 15_000;
const DEBOUNCE_PUSH_MS = 3_000;
// Mutation-log double-write debounce. Longer than the Yjs push debounce so we
// don't spam the PG materialized cache; this row is stale-OK.
const MATERIALIZE_DEBOUNCE_MS = 5_000;

export interface UseYjsSyncOptions {
  docId: string;
  userId: string;
  projectId: string;
  /**
   * Called on a 5s debounce after local edits to flush a serialized JSON
   * snapshot of the Y.Doc into the PG materialized cache (via the existing
   * mutation log path). Server never reconstructs Y.Doc — this keeps the
   * PG `contentJson` column eventually consistent with the CRDT state.
   *
   * The callback receives the latest TipTap-shaped JSON. Implementations
   * are responsible for calling the right `syncXxxUpdate(...)` helper.
   * Omit to skip the double-write (e.g. for read-only docs).
   */
  onMaterialize?: (contentJson: string) => void;
  /** Pre-seed for legacy docs — see useYjsDoc.UseYjsDocOptions. */
  seedFromLegacy?: Parameters<typeof useYjsDoc>[0]['seedFromLegacy'];
}

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'disabled';

export interface UseYjsSyncResult extends UseYjsDocResult {
  syncStatus: SyncStatus;
  lastSyncAt: string | null;
  triggerSync: () => void;
}

export function useYjsSync({
  docId,
  userId,
  projectId,
  onMaterialize,
  seedFromLegacy,
}: UseYjsSyncOptions): UseYjsSyncResult {
  const yjsResult = useYjsDoc({ docId, userId, seedFromLegacy });
  const { ydoc, isReady } = yjsResult;

  const [syncStatus, setSyncStatus] = useState<SyncStatus>(isSyncEnabled() ? 'idle' : 'disabled');
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const materializeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onMaterializeRef = useRef(onMaterialize);
  onMaterializeRef.current = onMaterialize;
  const syncingRef = useRef(false);

  const doSync = useCallback(async () => {
    if (!isSyncEnabled() || syncingRef.current) return;
    syncingRef.current = true;
    setSyncStatus('syncing');
    try {
      await syncDocument(docId, projectId, ydoc);
      setLastSyncAt(new Date().toISOString());
      setSyncStatus('idle');
    } catch (e) {
      log.error(`[useYjsSync] sync failed for ${docId}:`, e);
      setSyncStatus('error');
    } finally {
      syncingRef.current = false;
    }
  }, [docId, projectId, ydoc]);

  // Initial sync + periodic timer
  useEffect(() => {
    if (!isReady || !isSyncEnabled()) return;

    const initialTimer = setTimeout(doSync, INITIAL_SYNC_DELAY_MS);
    const periodicTimer = setInterval(doSync, PERIODIC_SYNC_MS);

    return () => {
      clearTimeout(initialTimer);
      clearInterval(periodicTimer);
    };
  }, [isReady, doSync]);

  // Debounced push on local edits
  useEffect(() => {
    if (!isReady || !isSyncEnabled()) return;

    const handleUpdate = (_update: Uint8Array, origin: unknown) => {
      if (origin === 'load' || origin === 'remote' || origin === 'seed' || origin === 'restore') {
        return;
      }

      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(doSync, DEBOUNCE_PUSH_MS);
    };

    ydoc.on('update', handleUpdate);
    return () => {
      ydoc.off('update', handleUpdate);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [isReady, ydoc, doSync]);

  // Mutation-log double-write. Serializes the Y.Doc's TipTap-shaped JSON and
  // hands it to the caller's onMaterialize on a 5s debounce. The server stays
  // oblivious to Y.Doc — it just writes the JSON into contentJson via the
  // existing mutation log path.
  useEffect(() => {
    if (!isReady) return;
    if (!onMaterializeRef.current) return;

    const flush = async () => {
      const cb = onMaterializeRef.current;
      if (!cb) return;
      try {
        // Y.XmlFragment.toJSON() returns an XML string ("<paragraph>...</paragraph>")
        // not TipTap-shaped JSON. Use y-prosemirror's converter so the cached
        // contentJson is consumable by parseContentJson on next load.
        const { yDocToProsemirrorJSON } = await import('y-prosemirror');
        const json = yDocToProsemirrorJSON(ydoc, 'default');
        cb(JSON.stringify(json));
      } catch (err) {
        log.warn('[useYjsSync] materialize failed:', err);
      }
    };

    const handleUpdate = (_u: Uint8Array, origin: unknown) => {
      if (origin === 'load' || origin === 'remote' || origin === 'seed' || origin === 'restore') {
        return;
      }
      if (materializeTimerRef.current) clearTimeout(materializeTimerRef.current);
      materializeTimerRef.current = setTimeout(flush, MATERIALIZE_DEBOUNCE_MS);
    };

    ydoc.on('update', handleUpdate);
    return () => {
      ydoc.off('update', handleUpdate);
      if (materializeTimerRef.current) clearTimeout(materializeTimerRef.current);
    };
  }, [isReady, ydoc]);

  // Suppress unused-import warning when Y is only used via narrow paths above.
  void Y;

  return useMemo(
    () => ({
      ...yjsResult,
      syncStatus,
      lastSyncAt,
      triggerSync: doSync,
    }),
    [yjsResult, syncStatus, lastSyncAt, doSync],
  );
}
