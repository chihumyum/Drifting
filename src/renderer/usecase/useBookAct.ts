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
import { withAtomicSyncTransaction } from './sync-helpers';
import loglevel from 'loglevel';
import { appendPlannedAuthoredOrderInTransaction } from '../sync/journal';
import {
  appendAuthoredOrderRebalance,
  authoredOrderRebalanceEntries,
} from '../sync/journal/order-authority';
import { compareUtf8Bytewise } from '../sync/protocol';

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

      const createdActs: BookAct[] = [];
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
        createdActs.push(opener);
      }

      // Name by final position on the axis, not by creation order: splitting
      // the middle of a 3-act book yields 第三幕 inserted as the new #3, and
      // the user renames if they care. Count = acts whose start precedes ours.
      const after = [...existing, ...createdActs];
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
      createdActs.push(act);
      await withAtomicSyncTransaction(projectId, async (tx, sync, changes) => {
        const repoTx = createBookActRepository(projectId, tx);
        for (const created of createdActs) {
          await repoTx.create(created);
          await sync('bookAct', 'create', created.id, projectId, {
            id: created.id,
            name: created.name,
            color: created.color,
            driftNodeId: created.driftNodeId,
            createdAt: created.createdAt,
            updatedAt: created.updatedAt,
          });
        }
        const desiredIds = [...existing, ...createdActs]
          .sort((left, right) =>
            (left.startOrder ?? Number.NEGATIVE_INFINITY) -
              (right.startOrder ?? Number.NEGATIVE_INFINITY) ||
            compareUtf8Bytewise(left.id, right.id),
          )
          .map(({ id }) => id);
        await appendPlannedAuthoredOrderInTransaction(tx, changes, {
          projectId,
          listKind: 'book-act',
          scope: projectId,
          desiredEntityIds: desiredIds,
        });
      });
      for (const created of createdActs) useDataStore.getState().addBookAct(created);
      return act;
    },
    [projectId],
  );

  const updateAct = useCallback(
    async (id: string, input: UpdateBookActInput): Promise<BookAct | null> => {
      const normalizedInput = input;
      const updatedAt = new Date().toISOString();
      const updated = await withAtomicSyncTransaction(projectId, async (tx, sync, changes) => {
        const result = await createBookActRepository(projectId, tx).update(id, {
          ...normalizedInput,
          updatedAt,
        });
        if (result) {
          const syncPayload: Record<string, unknown> = { ...normalizedInput, updatedAt };
          delete syncPayload.startOrder;
          if (Object.keys(syncPayload).length > 1) {
            await sync('bookAct', 'update', id, projectId, syncPayload);
          }
          if (input.startOrder !== undefined) {
            const desiredIds = useDataStore
              .getState()
              .bookActs.map((entry) =>
                entry.id === id ? { ...entry, startOrder: input.startOrder! } : entry,
              )
              .sort((left, right) =>
                (left.startOrder ?? Number.NEGATIVE_INFINITY) -
                  (right.startOrder ?? Number.NEGATIVE_INFINITY) ||
                compareUtf8Bytewise(left.id, right.id),
              )
              .map((entry) => entry.id);
            await appendPlannedAuthoredOrderInTransaction(tx, changes, {
              projectId,
              listKind: 'book-act',
              scope: projectId,
              desiredEntityIds: desiredIds,
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

      const remaining = acts.filter((act) => act.id !== id);
      // Deleting the opener: promote the next act to null-start so the
      // partition still covers the book head. With one act left after the
      // delete, demote it to "no acts" entirely? No — keep it as the lone
      // opener; the rail hides itself only when zero acts exist, and a
      // single named act is still meaningful structure.
      const heir = target.startOrder === null && remaining.length > 0 ? remaining[0] : null;
      const updatedAt = new Date().toISOString();
      await withAtomicSyncTransaction(projectId, async (tx, sync) => {
        const repoTx = createBookActRepository(projectId, tx);
        if (heir) {
          await repoTx.update(heir.id, { startOrder: null, updatedAt });
        }
        await repoTx.delete(id);
        await sync('bookAct', 'delete', id, projectId);
      });
      if (heir) {
        useDataStore.getState().updateBookAct(heir.id, { startOrder: null, updatedAt });
      }
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
      await withAtomicSyncTransaction(projectId, async (tx, _sync, changes) => {
        const repoTx = createBookActRepository(projectId, tx);
        for (const patch of patches) {
          await repoTx.update(patch.id, {
            startOrder: patch.startOrder,
            updatedAt,
          });
        }
        const patchById = new Map(patches.map((patch) => [patch.id, patch.startOrder] as const));
        const desiredIds = acts
          .map((entry) => ({
            ...entry,
            startOrder: patchById.get(entry.id) ?? entry.startOrder,
          }))
          .sort((left, right) =>
            (left.startOrder ?? Number.NEGATIVE_INFINITY) -
              (right.startOrder ?? Number.NEGATIVE_INFINITY) ||
            compareUtf8Bytewise(left.id, right.id),
          )
          .map((entry) => entry.id);
        appendAuthoredOrderRebalance(changes, {
          listKind: 'book-act',
          scope: projectId,
          entries: authoredOrderRebalanceEntries(desiredIds),
        });
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
