/**
 * Local-first Yjs hook.
 *
 * The historical name is retained because editor call sites consume its
 * `triggerSync` durability action. Remote transport is not implemented here:
 * SyncEngine publishes transaction-bound `yjs.update` mutations separately.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import loglevel from 'loglevel';

import { registerLocalYjsDocument } from '../services/yjs-local-durability.service';
import { useYjsDoc, type UseYjsDocResult } from './useYjsDoc';

const log = loglevel.getLogger('useYjsSync');
log.setLevel(loglevel.levels.WARN);

const MATERIALIZE_DEBOUNCE_MS = 5_000;

export interface UseYjsSyncOptions {
  docId: string;
  userId: string;
  projectId: string;
  /** Rebuildable JSON projection of the live Y.Doc. */
  onMaterialize?: (contentJson: string) => void;
  /** Seed from contentJson only when no persisted Yjs state exists. */
  seedFromContentJson?: Parameters<typeof useYjsDoc>[0]['seedFromContentJson'];
}

export type SyncStatus = 'idle' | 'syncing' | 'error';

export interface UseYjsSyncResult extends UseYjsDocResult {
  /** Status of the latest explicit local durability drain. */
  syncStatus: SyncStatus;
  /** Time of the latest successful local durability drain, not cloud convergence. */
  lastSyncAt: string | null;
  triggerSync: () => void;
}

export function useYjsSync({
  docId,
  userId,
  projectId,
  onMaterialize,
  seedFromContentJson,
}: UseYjsSyncOptions): UseYjsSyncResult {
  const yjsResult = useYjsDoc({ projectId, docId, userId, seedFromContentJson });
  const { ydoc, isReady, error, flushPendingWrites, flushForLifecycle } = yjsResult;
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const materializeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onMaterializeRef = useRef(onMaterialize);
  const flushPromiseRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    onMaterializeRef.current = onMaterialize;
  }, [onMaterialize]);

  const drainLocal = useCallback(async () => {
    if (error) throw error;
    if (!isReady) return;
    if (flushPromiseRef.current) return flushPromiseRef.current;

    const operation = (async () => {
      setSyncStatus('syncing');
      await flushPendingWrites();
      setLastSyncAt(new Date().toISOString());
      setSyncStatus('idle');
    })();
    flushPromiseRef.current = operation;
    try {
      await operation;
    } catch (cause) {
      log.error(`[useYjsSync] local durability drain failed for ${docId}:`, cause);
      setSyncStatus('error');
      throw cause;
    } finally {
      if (flushPromiseRef.current === operation) flushPromiseRef.current = null;
    }
  }, [docId, error, flushPendingWrites, isReady]);

  useEffect(() => {
    // Register while loading too. Database-switch teardown must wait for an
    // in-flight SQLite replay/seed before another local database can open.
    return registerLocalYjsDocument(projectId, docId, flushForLifecycle);
  }, [docId, flushForLifecycle, projectId]);

  useEffect(() => {
    if (!isReady || !onMaterializeRef.current) return;

    const flushProjection = async () => {
      const callback = onMaterializeRef.current;
      if (!callback) return;
      try {
        const { yDocToProsemirrorJSON } = await import('y-prosemirror');
        callback(JSON.stringify(yDocToProsemirrorJSON(ydoc, 'default')));
      } catch (cause) {
        log.warn('[useYjsSync] materialized projection failed:', cause);
      }
    };

    const handleUpdate = (_update: Uint8Array, origin: unknown) => {
      if (origin === 'load' || origin === 'remote' || origin === 'seed' || origin === 'restore') {
        return;
      }
      if (materializeTimerRef.current) clearTimeout(materializeTimerRef.current);
      materializeTimerRef.current = setTimeout(flushProjection, MATERIALIZE_DEBOUNCE_MS);
    };

    ydoc.on('update', handleUpdate);
    return () => {
      ydoc.off('update', handleUpdate);
      if (materializeTimerRef.current) clearTimeout(materializeTimerRef.current);
    };
  }, [isReady, ydoc]);

  const triggerSync = useCallback(() => {
    void drainLocal().catch(() => undefined);
  }, [drainLocal]);

  return useMemo(
    () => ({ ...yjsResult, syncStatus, lastSyncAt, triggerSync }),
    [lastSyncAt, syncStatus, triggerSync, yjsResult],
  );
}
