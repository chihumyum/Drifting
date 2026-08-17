/**
 * Acts (幕) usecase — boundary-based segmentation of the global reading axis.
 *
 * The model is deliberately thin (see domain/book-act.ts): an act is a row
 * with a `startOrder` boundary; everything else (membership, spans, empty
 * acts) derives. The orchestration this hook owns:
 *
 * - The first split creates one named act at the authored cursor coordinate.
 * - Deleting any act removes only that boundary. Chapters in a newly
 *   uncovered interval intentionally belong to no act.
 * - 打散 (spread) repair: remapAfterSpread applies the deterministic
 *   boundary remap from domain/remapActBoundariesForSpread — call it from
 *   every spread site with the old→new order maps.
 */
import { useCallback, useMemo } from 'react';
import { v7 as uuidv7 } from 'uuid';

import { useDataStore } from '../store/data-store';
import { createBookActRepository } from '../sqlite-repo/book-act-repo';
import {
  defaultActName,
  remapActBoundariesForSpread,
  sortActs,
  type BookAct,
} from '../domain/book-act';
import { CHAPTER_ORDER_STRIDE } from '../domain/book-node';
import { withAtomicSyncTransaction } from './sync-helpers';
import loglevel from 'loglevel';

const log = loglevel.getLogger('useBookAct');
log.setLevel(loglevel.levels.WARN);

/** App bootstrap: load the project's acts into the data store. */
export async function loadBookActs(projectId: string): Promise<void> {
  const repo = createBookActRepository(projectId);
  const acts = await repo.findAll();
  useDataStore.getState().setBookActs(acts);
}

export interface UseBookActContext {
  projectId: string;
}

export interface UpdateBookActInput {
  name?: string;
  color?: string | null;
  startOrder?: number;
  driftNodeId?: string | null;
}

/**
 * Clear the drift binding on every act pointing at a drift. MUST be called
 * when a drift is deleted/trashed or converted to a chapter — FKs aren't
 * enforced, so nothing else will. Parallels unbindMarkersForDrift; both run
 * on the drift-leaves-the-board paths.
 */
export async function unbindActsForDrift(
  projectId: string,
  driftNodeId: string,
): Promise<void> {
  const now = new Date().toISOString();
  const updated = await withAtomicSyncTransaction(projectId, async (tx, sync) => {
    const rows = await createBookActRepository(projectId, tx).unbindForDrift(driftNodeId, now);
    for (const act of rows) {
      await sync('bookAct', 'update', act.id, projectId, {
        driftNodeId: null,
        updatedAt: now,
      });
    }
    return rows;
  });
  const store = useDataStore.getState();
  for (const act of updated) {
    store.updateBookAct(act.id, { driftNodeId: null, updatedAt: now });
  }
}

export function useBookAct({ projectId }: UseBookActContext) {
  // Insert one boundary at the authored coordinate. There is no implicit
  // book-head act: chapters left of the first boundary remain unacted.
  const splitAtOrder = useCallback(
    async (startOrder: number): Promise<BookAct | null> => {
      if (!projectId || !Number.isFinite(startOrder)) return null;
      const store = useDataStore.getState();
      const existing = store.bookActs;
      if (existing.some((act) => act.startOrder === startOrder)) {
        log.warn(`act boundary already exists at ${startOrder}`);
        return null;
      }
      const now = new Date().toISOString();

      // Name by final position on the axis, not by creation order: splitting
      // the middle of a 3-act book yields 第三幕 inserted as the new #3, and
      // the user renames if they care. Count = acts whose start precedes ours.
      const position =
        sortActs(existing).filter(
          (act) => (act.startOrder ?? Number.NEGATIVE_INFINITY) < startOrder,
        ).length + 1;
      const act: BookAct = {
        id: uuidv7(),
        projectId,
        name: defaultActName(position),
        color: null,
        startOrder,
        driftNodeId: null,
        createdAt: now,
        updatedAt: now,
      };
      await withAtomicSyncTransaction(projectId, async (tx, sync) => {
        const repoTx = createBookActRepository(projectId, tx);
        await repoTx.create(act);
        await sync('bookAct', 'create', act.id, projectId, {
          id: act.id,
          name: act.name,
          color: act.color,
          startOrder: act.startOrder,
          driftNodeId: act.driftNodeId,
          createdAt: act.createdAt,
          updatedAt: act.updatedAt,
        });
      });
      useDataStore.getState().addBookAct(act);
      return act;
    },
    [projectId],
  );

  const updateAct = useCallback(
    async (id: string, input: UpdateBookActInput): Promise<BookAct | null> => {
      const normalizedInput = input;
      const updatedAt = new Date().toISOString();
      const updated = await withAtomicSyncTransaction(projectId, async (tx, sync) => {
        const result = await createBookActRepository(projectId, tx).update(id, {
          ...normalizedInput,
          updatedAt,
        });
        if (result) {
          if (Object.keys(normalizedInput).length > 0) {
            await sync('bookAct', 'update', id, projectId, {
              ...normalizedInput,
              updatedAt,
            });
          }
        }
        return result;
      });
      if (!updated) return null;
      useDataStore.getState().updateBookAct(id, updated);
      return updated;
    },
    [projectId],
  );

  // Drag a boundary to a new position. Caller is responsible for clamping
  // between neighboring boundaries (the rail does); this just persists.
  const moveBoundary = useCallback(
    (id: string, startOrder: number) => updateAct(id, { startOrder }),
    [updateAct],
  );

  // Bind / unbind a drift node as the act's notes. Thin wrappers over
  // updateAct so the store + sync paths stay single-sourced.
  const bindDrift = useCallback(
    (id: string, driftNodeId: string) => updateAct(id, { driftNodeId }),
    [updateAct],
  );
  const unbindDrift = useCallback(
    (id: string) => updateAct(id, { driftNodeId: null }),
    [updateAct],
  );

  const deleteAct = useCallback(
    async (id: string): Promise<void> => {
      const store = useDataStore.getState();
      const acts = sortActs(store.bookActs);
      const target = acts.find((act) => act.id === id);
      if (!target) return;

      await withAtomicSyncTransaction(projectId, async (tx, sync) => {
        const repoTx = createBookActRepository(projectId, tx);
        await repoTx.delete(id);
        await sync('bookAct', 'delete', id, projectId);
      });
      useDataStore.getState().removeBookAct(id);
    },
    [projectId],
  );

  /**
   * 打散 repair — remap every boundary against the spread's old→new order
   * mapping. MUST be called by each spread handler right after it persists
   * the chapter order rewrites.
   */
  const remapAfterSpread = useCallback(
    async (
      oldOrderById: Map<string, number>,
      newOrderById: Map<string, number>,
    ): Promise<void> => {
      const acts = useDataStore.getState().bookActs;
      const patches = remapActBoundariesForSpread(
        acts,
        oldOrderById,
        newOrderById,
        CHAPTER_ORDER_STRIDE,
      );
      if (patches.length === 0) return;
      const updatedAt = new Date().toISOString();
      await withAtomicSyncTransaction(projectId, async (tx, sync) => {
        const repoTx = createBookActRepository(projectId, tx);
        for (const patch of patches) {
          await repoTx.update(patch.id, {
            startOrder: patch.startOrder,
            updatedAt,
          });
          await sync('bookAct', 'update', patch.id, projectId, {
            startOrder: patch.startOrder,
            updatedAt,
          });
        }
      });
      for (const patch of patches) {
        useDataStore.getState().updateBookAct(patch.id, {
          startOrder: patch.startOrder,
          updatedAt,
        });
      }
    },
    [projectId],
  );

  return useMemo(
    () => ({
      splitAtOrder,
      updateAct,
      moveBoundary,
      bindDrift,
      unbindDrift,
      deleteAct,
      remapAfterSpread,
    }),
    [splitAtOrder, updateAct, moveBoundary, bindDrift, unbindDrift, deleteAct, remapAfterSpread],
  );
}
