/**
 * Acts (幕) usecase — boundary-based segmentation of the global reading axis.
 *
 * The model is deliberately thin (see domain/book-act.ts): an act is a row
 * with a `startOrder` boundary; everything else (membership, spans, empty
 * acts) derives. The orchestration this hook owns:
 *
 * - First split creates TWO acts (the null-start opener + the new boundary)
 *   so the rail is never a single unnamed band.
 * - Deleting the opener promotes the next act to null-start (merge into
 *   next); deleting any other act merges it into the PREVIOUS one (its
 *   boundary just disappears).
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
import {
  syncBookActCreate,
  syncBookActDelete,
  syncBookActUpdate,
} from './sync-helpers';
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
  const repo = createBookActRepository(projectId);
  const now = new Date().toISOString();
  const updated = await repo.unbindForDrift(driftNodeId, now);
  const store = useDataStore.getState();
  for (const act of updated) {
    store.updateBookAct(act.id, { driftNodeId: null, updatedAt: now });
    syncBookActUpdate(act.id, projectId, { driftNodeId: null, updatedAt: now });
  }
}

export function useBookAct({ projectId }: UseBookActContext) {
  const repo = useMemo(() => createBookActRepository(projectId), [projectId]);

  // Insert a boundary at `startOrder`. When the project has no acts yet this
  // creates the opener too, so a single gesture yields a complete partition.
  const splitAtOrder = useCallback(
    async (startOrder: number): Promise<BookAct | null> => {
      if (!projectId) return null;
      const store = useDataStore.getState();
      const existing = store.bookActs;
      if (existing.some((act) => act.startOrder === startOrder)) {
        log.warn(`act boundary already exists at ${startOrder}`);
        return null;
      }
      const now = new Date().toISOString();

      const persist = async (act: BookAct) => {
        await repo.create(act);
        useDataStore.getState().addBookAct(act);
        syncBookActCreate(act.id, projectId, {
          id: act.id,
          name: act.name,
          color: act.color,
          startOrder: act.startOrder,
          driftNodeId: act.driftNodeId,
          createdAt: act.createdAt,
          updatedAt: act.updatedAt,
        });
      };

      if (existing.length === 0) {
        const opener: BookAct = {
          id: uuidv7(),
          projectId,
          name: defaultActName(1),
          color: null,
          startOrder: null,
          driftNodeId: null,
          createdAt: now,
          updatedAt: now,
        };
        await persist(opener);
      }

      // Name by final position on the axis, not by creation order: splitting
      // the middle of a 3-act book yields 第三幕 inserted as the new #3, and
      // the user renames if they care. Count = acts whose start precedes ours.
      const after = useDataStore.getState().bookActs;
      const position =
        sortActs(after).filter(
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
      await persist(act);
      return act;
    },
    [projectId, repo],
  );

  const updateAct = useCallback(
    async (id: string, input: UpdateBookActInput): Promise<BookAct | null> => {
      const updatedAt = new Date().toISOString();
      const updated = await repo.update(id, { ...input, updatedAt });
      if (!updated) return null;
      useDataStore.getState().updateBookAct(id, updated);
      syncBookActUpdate(id, projectId, { ...input, updatedAt });
      return updated;
    },
    [projectId, repo],
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

      const remaining = acts.filter((act) => act.id !== id);
      // Deleting the opener: promote the next act to null-start so the
      // partition still covers the book head. With one act left after the
      // delete, demote it to "no acts" entirely? No — keep it as the lone
      // opener; the rail hides itself only when zero acts exist, and a
      // single named act is still meaningful structure.
      if (target.startOrder === null && remaining.length > 0) {
        const heir = remaining[0];
        const updatedAt = new Date().toISOString();
        await repo.update(heir.id, { startOrder: null, updatedAt });
        useDataStore.getState().updateBookAct(heir.id, { startOrder: null, updatedAt });
        syncBookActUpdate(heir.id, projectId, { startOrder: null, updatedAt });
      }

      await repo.delete(id);
      useDataStore.getState().removeBookAct(id);
      syncBookActDelete(id, projectId);
    },
    [projectId, repo],
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
      for (const patch of patches) {
        await updateAct(patch.id, { startOrder: patch.startOrder });
      }
    },
    [updateAct],
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
