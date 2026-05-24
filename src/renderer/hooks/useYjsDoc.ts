import { useEffect, useMemo, useRef, useState } from 'react';
import loglevel from 'loglevel';
import * as Y from 'yjs';
import { initDatabase } from '../lib/db';
import { createYjsRepository } from '../sqlite-repo/yjs-repo';
import { resetCursor, pullUpdates } from '../services/yjs-sync.service';
import { isSyncEnabled } from '../lib/config';

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

        if (!hadAnything) {
          // No local Yjs state for this doc — either fresh install, fresh
          // device, or a wiped DB. Drop the sync cursor so the next pull
          // re-fetches the full update log from the server.
          await resetCursor(docId);

          // Try the server FIRST before falling back to seed. The seed turns
          // the legacy node_content.contentJson into Yjs ops with a fresh
          // random clientID — if the server already has its own ops for this
          // doc (created by another device's Yjs path), seeding produces
          // duplicates because Yjs treats the two clientID streams as
          // independent insertions of the same content.
          //
          // If pull brings any ops, we trust those and skip seed. If pull
          // returns empty (or errors), we fall back to seed for the legacy
          // migration case (pre-Yjs content that exists only in PG).
          if (isSyncEnabled()) {
            try {
              await pullUpdates(docId, ydoc, repo);
            } catch (err) {
              log.warn(`[useYjsDoc] initial pull failed for ${docId}:`, err);
            }
            if (cancelled) return;
          }

          if (seedRef.current && ydoc.getXmlFragment('default').length === 0) {
            await seedRef.current((mutator) => {
              ydoc.transact(() => {
                // Idempotency guard. Two concurrent load runs (StrictMode
                // double-mount, rapid dep changes) can each pass !hadAnything
                // because the first's snapshot hasn't landed yet. Each call
                // to mutator runs prosemirrorJSONToYDoc with a fresh random
                // clientID, so re-applying produces a SECOND independent set
                // of Yjs ops representing the same content. The editor then
                // renders N copies of the seed paragraph.
                //
                // Inside transact, the fragment.length check + mutator call
                // are atomic at the JS level: a second transact() can't
                // interleave between the check and the apply.
                if (ydoc.getXmlFragment('default').length > 0) return;
                mutator(ydoc);
              }, 'seed');
            });
            if (cancelled) return;
            const fullState = Y.encodeStateAsUpdate(ydoc);
            await repo.upsertSnapshot(docId, fullState);
          }
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
      // 'load' is the replay-from-sqlite path; skip entirely so we don't
      // re-persist what we just loaded.
      if (origin === 'load') return;

      // Local edits (no origin / undefined origin) need to be appended to
      // yjs_updates so the push path can ship them. Remote / seed / restore
      // updates already exist on the server side or are bootstrapping —
      // they must NOT be appended (push would echo them back) but they DO
      // need to participate in snapshotting so the in-memory ydoc state
      // survives an Electron restart. Without this, the cursor.lastServerSeq
      // advances past these updates, but the local replay path has nothing
      // to play back, and the next pull is a no-op → ydoc starts empty.
      const isLocalEdit = origin !== 'remote' && origin !== 'seed' && origin !== 'restore';
      const updateCopy = new Uint8Array(update);

      enqueueWrite(async () => {
        if (isLocalEdit) {
          await repo.appendUpdate(docId, updateCopy);
        }
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
