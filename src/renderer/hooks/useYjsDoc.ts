import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import loglevel from 'loglevel';
import * as Y from 'yjs';
import { initDatabase } from '../lib/db';
import { createYjsRepository } from '../sqlite-repo/yjs-repo';
import {
  resetCursor,
  pullUpdates,
  compactUpdatesAfterSnapshot,
} from '../services/yjs-sync.service';
import { maybeCaptureSnapshotHistory } from '../services/snapshot-history.service';
import { isSyncEnabled } from '../lib/config';
import { registerLiveYDoc } from '../lib/yjs-doc-registry';

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
  /** Wait until every queued local update has reached SQLite. */
  flushPendingWrites: () => Promise<void>;
  /** Persist a full snapshot/compaction point, then drain the SQLite queue. */
  flushLocalState: () => Promise<void>;
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
  const writeErrorsRef = useRef<unknown[]>([]);
  const flushPendingWrites = useCallback(async () => {
    let observed: Promise<void>;
    do {
      observed = writeQueueRef.current;
      await observed;
    } while (observed !== writeQueueRef.current);

    if (writeErrorsRef.current.length > 0) {
      const failures = writeErrorsRef.current;
      writeErrorsRef.current = [];
      throw new AggregateError(
        failures,
        `${failures.length} Yjs SQLite write(s) failed to persist`,
      );
    }
  }, []);
  const flushLocalStateRef = useRef<() => Promise<void>>(flushPendingWrites);
  const flushLocalState = useCallback(async () => {
    await flushLocalStateRef.current();
  }, []);
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
        } else if (isSyncEnabled()) {
          // A second device can have a valid but stale local snapshot. Catch it
          // all the way up before exposing the editor, otherwise the user can
          // start typing while thousands of remote operations are still being
          // applied underneath the visible document.
          try {
            await pullUpdates(docId, ydoc, repo);
          } catch (err) {
            // Preserve offline-first availability when the server is down: the
            // existing local snapshot is still safe to edit and will converge
            // on a later periodic sync.
            log.warn(`[useYjsDoc] catch-up pull failed for ${docId}:`, err);
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
        writeErrorsRef.current.push(error);
        log.error(`[useYjsDoc] write failed for ${docId}:`, error);
      });
    };

    // Snapshot the full state, then prune the now-redundant update rows it
    // absorbed (capped at the push cursor — see compactUpdatesAfterSnapshot).
    // `fullState` is captured by the caller (synchronously, before the ydoc can
    // be destroyed on unmount); `coveredId` is read here while the write queue
    // is idle so it reflects exactly what `fullState` encodes.
    const persistSnapshotAndCompact = async (
      fullState: Uint8Array,
      reason: 'periodic' | 'close' = 'periodic',
    ) => {
      const coveredId = await repo.maxUpdateId(docId);
      await repo.upsertSnapshot(docId, fullState);
      // Time-machine trail: every materialized snapshot is a capture
      // opportunity (15-min gated inside; 'close' bypasses the gate so a
      // short writing session's final state isn't lost).
      maybeCaptureSnapshotHistory(docId, fullState, reason);
      await compactUpdatesAfterSnapshot(docId, coveredId, repo);
    };

    flushLocalStateRef.current = async () => {
      // Capture synchronously so the snapshot exactly reflects the live Y.Doc
      // at the lifecycle barrier, then serialize it behind every update row.
      const fullState = Y.encodeStateAsUpdate(ydoc);
      enqueueWrite(() => persistSnapshotAndCompact(fullState));
      await flushPendingWrites();
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
      // survives an application restart. Without this, the cursor.lastServerSeq
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
          await persistSnapshotAndCompact(Y.encodeStateAsUpdate(ydoc));
          localUpdatesSinceSnapshotRef.current = 0;
        }
      });
    };

    ydoc.on('update', handleUpdate);

    return () => {
      ydoc.off('update', handleUpdate);

      // Capture state synchronously — the ydoc.destroy() effect cleanup may run
      // right after this. The compaction itself happens inside the write queue.
      const fullState = Y.encodeStateAsUpdate(ydoc);
      enqueueWrite(() => persistSnapshotAndCompact(fullState, 'close'));
      flushLocalStateRef.current = flushPendingWrites;
    };
  }, [docId, flushPendingWrites, isReady, repo, ydoc]);

  // Publish this live Y.Doc so out-of-React callers (the agent's prose tools)
  // can apply edits to the exact doc an open editor is bound to. Gate on isReady
  // so it's only exposed once the persistence handler above is attached (an
  // agent edit before that would otherwise not be saved/pushed).
  useEffect(() => {
    if (!isReady) return;
    return registerLiveYDoc(docId, ydoc);
  }, [docId, ydoc, isReady]);

  useEffect(() => {
    return () => {
      ydoc.destroy();
    };
  }, [ydoc]);

  return {
    ydoc,
    isReady,
    hasLocalState,
    flushPendingWrites,
    flushLocalState,
  };
}
