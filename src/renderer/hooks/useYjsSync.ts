/**
 * useYjsSync — wraps useYjsDoc with periodic server sync.
 *
 * Provides the same interface as useYjsDoc plus:
 *   syncStatus  — 'idle' | 'syncing' | 'error' | 'disabled'
 *   lastSyncAt  — ISO timestamp of last successful sync
 *   triggerSync  — manually kick a push+pull cycle
 */
import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useYjsDoc, type UseYjsDocResult } from './useYjsDoc';
import { syncDocument } from '../services/yjs-sync.service';
import { isSyncEnabled } from '../lib/config';
import loglevel from 'loglevel';

const log = loglevel.getLogger('useYjsSync');
log.setLevel(loglevel.levels.WARN);

const INITIAL_SYNC_DELAY_MS = 1_000;
const PERIODIC_SYNC_MS = 15_000;
const DEBOUNCE_PUSH_MS = 3_000;

export interface UseYjsSyncOptions {
  docId: string;
  userId: string;
  projectId: string;
}

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'disabled';

export interface UseYjsSyncResult extends UseYjsDocResult {
  syncStatus: SyncStatus;
  lastSyncAt: string | null;
  triggerSync: () => void;
}

export function useYjsSync({ docId, userId, projectId }: UseYjsSyncOptions): UseYjsSyncResult {
  const yjsResult = useYjsDoc({ docId, userId });
  const { ydoc, isReady } = yjsResult;

  const [syncStatus, setSyncStatus] = useState<SyncStatus>(isSyncEnabled() ? 'idle' : 'disabled');
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      if (origin === 'load' || origin === 'remote') return;

      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(doSync, DEBOUNCE_PUSH_MS);
    };

    ydoc.on('update', handleUpdate);
    return () => {
      ydoc.off('update', handleUpdate);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [isReady, ydoc, doSync]);

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
