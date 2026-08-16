import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type * as Y from 'yjs';

import { registerLiveYDoc } from '../lib/yjs-doc-registry';
import {
  getYjsDocumentSession,
  type YjsDocumentSeed,
} from '../services/yjs-document-session';

export interface UseYjsDocOptions {
  /** Project whose active SyncGeneration owns the authored Yjs journal. */
  projectId: string;
  docId: string;
  userId: string;
  /**
   * Optional async seed used only when SQLite has no Yjs state. The generated
   * full-state update is journaled before its snapshot is persisted. All
   * consumers of a docId share one initial load, so seeding runs at most once
   * per process session.
   */
  seedFromContentJson?: YjsDocumentSeed;
}

export interface UseYjsDocResult {
  ydoc: Y.Doc;
  isReady: boolean;
  hasLocalState: boolean;
  /** Non-null when initial SQLite/Yjs replay failed. The document stays read-only. */
  error: Error | null;
  /** Wait until every queued local update has reached SQLite. */
  flushPendingWrites: () => Promise<void>;
  /** Persist a full snapshot/compaction point, then drain the SQLite queue. */
  flushLocalState: () => Promise<void>;
  /** Wait for load/close work without blocking account switches on corrupt input. */
  flushForLifecycle: () => Promise<void>;
}

export function useYjsDoc({
  projectId,
  docId,
  userId,
  seedFromContentJson,
}: UseYjsDocOptions): UseYjsDocResult {
  if (!projectId) throw new Error('useYjsDoc requires projectId');
  if (!userId) throw new Error('useYjsDoc requires userId');

  const session = useMemo(
    () => getYjsDocumentSession(projectId, docId, userId),
    [docId, projectId, userId],
  );
  const seedRef = useRef(seedFromContentJson);
  useEffect(() => {
    seedRef.current = seedFromContentJson;
  }, [seedFromContentJson]);

  const state = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );

  useEffect(() => {
    const currentSeed = seedRef.current;
    return session.retain(
      currentSeed
        ? (apply) => {
            const latestSeed = seedRef.current;
            return latestSeed?.(apply);
          }
        : undefined,
    );
  }, [session]);

  useEffect(() => {
    if (!state.isReady) return;
    return registerLiveYDoc(docId, session.ydoc);
  }, [docId, session, state.isReady]);

  const flushPendingWrites = useCallback(() => session.flushPendingWrites(), [session]);
  const flushLocalState = useCallback(() => session.flushLocalState(), [session]);
  const flushForLifecycle = useCallback(() => session.flushForLifecycle(), [session]);

  return useMemo(
    () => ({
      ydoc: session.ydoc,
      isReady: state.isReady,
      hasLocalState: state.hasLocalState,
      error: state.error,
      flushPendingWrites,
      flushLocalState,
      flushForLifecycle,
    }),
    [flushForLifecycle, flushLocalState, flushPendingWrites, session, state],
  );
}
