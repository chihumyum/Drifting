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
  /** Do not retain, register, or persist a session until its entity exists. */
  enabled?: boolean;
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
  enabled = true,
}: UseYjsDocOptions): UseYjsDocResult {
  if (enabled && !projectId) throw new Error('useYjsDoc requires projectId');
  if (enabled && !userId) throw new Error('useYjsDoc requires userId');

  const sessionProjectId = enabled ? projectId : '__disabled_project__';
  const sessionDocId = enabled ? docId : '__disabled_doc__';
  const sessionUserId = enabled ? userId : '__disabled_user__';

  const session = useMemo(
    () => getYjsDocumentSession(sessionProjectId, sessionDocId, sessionUserId),
    [sessionDocId, sessionProjectId, sessionUserId],
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
    if (!enabled) return undefined;
    const currentSeed = seedRef.current;
    return session.retain(
      currentSeed
        ? (apply) => {
            const latestSeed = seedRef.current;
            return latestSeed?.(apply);
          }
        : undefined,
    );
  }, [enabled, session]);

  useEffect(() => {
    if (!enabled || !state.isReady) return;
    return registerLiveYDoc(docId, session.ydoc);
  }, [docId, enabled, session, state.isReady]);

  const flushPendingWrites = useCallback(
    () => (enabled ? session.flushPendingWrites() : Promise.resolve()),
    [enabled, session],
  );
  const flushLocalState = useCallback(
    () => (enabled ? session.flushLocalState() : Promise.resolve()),
    [enabled, session],
  );
  const flushForLifecycle = useCallback(
    () => (enabled ? session.flushForLifecycle() : Promise.resolve()),
    [enabled, session],
  );

  return useMemo(
    () => ({
      ydoc: session.ydoc,
      isReady: enabled && state.isReady,
      hasLocalState: enabled && state.hasLocalState,
      error: enabled ? state.error : null,
      flushPendingWrites,
      flushLocalState,
      flushForLifecycle,
    }),
    [enabled, flushForLifecycle, flushLocalState, flushPendingWrites, session, state],
  );
}
