import { useEffect, useMemo, useRef, useState } from 'react';
import loglevel from 'loglevel';
import * as Y from 'yjs';
import { initDatabase } from '../lib/db';
import { createYjsRepository } from '../sqlite-repo/yjs-repo';

const log = loglevel.getLogger('useYjsDoc');
log.setLevel(loglevel.levels.WARN);

const SNAPSHOT_EVERY_UPDATES = 50;

export interface UseYjsDocOptions {
  docId: string;
  userId: string;
}

export interface UseYjsDocResult {
  ydoc: Y.Doc;
  isReady: boolean;
  hasLocalState: boolean;
}

export function useYjsDoc({ docId, userId }: UseYjsDocOptions): UseYjsDocResult {
  if (!userId) {
    throw new Error('useYjsDoc requires userId');
  }

  const ydoc = useMemo(() => new Y.Doc(), [docId]);
  const repoRef = useRef(createYjsRepository());
  const repo = repoRef.current;
  const [isReady, setIsReady] = useState(false);
  const [hasLocalState, setHasLocalState] = useState(false);
  const localUpdatesSinceSnapshotRef = useRef(0);
  const writeQueueRef = useRef(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    setIsReady(false);
    setHasLocalState(false);
    localUpdatesSinceSnapshotRef.current = 0;

    const load = async () => {
      try {
        await initDatabase(userId);

        const snapshot = await repo.getSnapshot(docId);
        if (snapshot) {
          Y.applyUpdate(ydoc, snapshot.stateBlob, 'load');
        }

        const updates = await repo.listUpdates(docId);
        for (const item of updates) {
          Y.applyUpdate(ydoc, item.updateBlob, 'load');
        }

        if (cancelled) return;

        setHasLocalState(Boolean(snapshot) || updates.length > 0);
        setIsReady(true);
      } catch (error) {
        if (!cancelled) {
          log.error(`[useYjsDoc] failed to load doc ${docId}:`, error);
          setIsReady(true);
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [docId, repo, userId, ydoc]);

  useEffect(() => {
    if (!isReady) return;

    const enqueueWrite = (task: () => Promise<void>) => {
      writeQueueRef.current = writeQueueRef.current.then(task).catch((error) => {
        log.error(`[useYjsDoc] write failed for ${docId}:`, error);
      });
    };

    const handleUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === 'load' || origin === 'remote') return;
      const updateCopy = new Uint8Array(update);

      enqueueWrite(async () => {
        await repo.appendUpdate(docId, updateCopy);
        localUpdatesSinceSnapshotRef.current += 1;

        if (localUpdatesSinceSnapshotRef.current >= SNAPSHOT_EVERY_UPDATES) {
          const fullState = Y.encodeStateAsUpdate(ydoc);
          await repo.upsertSnapshot(docId, fullState);
          localUpdatesSinceSnapshotRef.current = 0;
        }
      });
    };

    ydoc.on('update', handleUpdate);

    return () => {
      ydoc.off('update', handleUpdate);

      const fullState = Y.encodeStateAsUpdate(ydoc);
      enqueueWrite(async () => {
        await repo.upsertSnapshot(docId, fullState);
      });
    };
  }, [docId, isReady, repo, ydoc]);

  useEffect(() => {
    return () => {
      ydoc.destroy();
    };
  }, [ydoc]);

  return {
    ydoc,
    isReady,
    hasLocalState,
  };
}
