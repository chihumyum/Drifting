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
  /**
   * Optional async seed: when the doc has neither a snapshot nor stored
   * updates on first load, this is called to pull the legacy "before-Yjs"
   * JSON state (e.g. nodeContent.contentJson). The Y.Doc is mutated inside
   * to absorb it, producing an initial update + snapshot. Subsequent loads
   * skip seeding because the snapshot now exists. Return null/undefined to
   * skip (truly empty doc).
   *
   * The seed must mutate `ydoc` synchronously inside `apply` — we wrap the
   * apply in a transaction so it's exactly one update.
   */
  seedFromLegacy?: (apply: (mutator: (ydoc: Y.Doc) => void) => void) => Promise<void> | void;
}

export interface UseYjsDocResult {
  ydoc: Y.Doc;
  isReady: boolean;
  hasLocalState: boolean;
}

export function useYjsDoc({ docId, userId, seedFromLegacy }: UseYjsDocOptions): UseYjsDocResult {
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
  // Hold a stable ref so the load effect doesn't re-fire when callers pass
  // an inline arrow function.
  const seedRef = useRef(seedFromLegacy);
  seedRef.current = seedFromLegacy;

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

        const hadAnything = Boolean(snapshot) || updates.length > 0;

        // Legacy seed: only when there's no local Yjs state at all. The first
        // such doc on a given device pulls the pre-Yjs JSON from SQLite (e.g.
        // nodeContent.contentJson), packs it into ydoc, and snapshots so the
        // next load skips the seed.
        if (!hadAnything && seedRef.current) {
          await seedRef.current((mutator) => {
            ydoc.transact(() => mutator(ydoc), 'seed');
          });
          const fullState = Y.encodeStateAsUpdate(ydoc);
          await repo.upsertSnapshot(docId, fullState);
        }

        if (cancelled) return;

        setHasLocalState(hadAnything || Boolean(seedRef.current));
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
