/**
 * Drift groups (左栏分组) usecase — nested folders for organizing drift nodes
 * in the left panel.
 *
 * The model is thin (see domain/drift-group.ts): a group is a row with a
 * `parentGroupId` link; drift membership lives on book_node.drift_group_id.
 * Following useBookAct, every mutation is a direct repo → store → sync triple
 * (no optimistic rollback — these are cheap scalar writes). The orchestration
 * this hook owns:
 *
 * - moveGroup guards against cycles (a group can't be dropped into its own
 *   subtree) via domain isDescendantGroup.
 * - deleteGroup reparents the group's direct child groups AND its member
 *   drifts up to the deleted group's parent (root if it was top-level), then
 *   removes the row — deleting a folder must never lose the ideas inside it.
 */
import { useCallback, useMemo } from 'react';
import { v7 as uuidv7 } from 'uuid';

import { useDataStore } from '../store/data-store';
import { createDriftGroupRepository } from '../sqlite-repo/drift-group-repo';
import { createBookNodeSqliteRepository } from '../sqlite-repo/node-repo';
import {
  canMoveGroupUnder,
  compareDriftGroups,
  isDescendantGroup,
  type DriftGroup,
} from '../domain/drift-group';
import { withAtomicSyncTransaction } from './sync-helpers';
import loglevel from 'loglevel';
import { appendPlannedAuthoredOrderInTransaction } from '../sync/journal';
import {
  appendAuthoredOrderRebalance,
  authoredOrderRebalanceEntries,
  driftGroupOrderScope,
  entityIdsByNumericPlacement,
} from '../sync/journal/order-authority';

const log = loglevel.getLogger('useDriftGroup');
log.setLevel(loglevel.levels.WARN);

export const DEFAULT_DRIFT_GROUP_NAME = '新分组';

/** App bootstrap: load the project's drift groups into the data store. */
export async function loadDriftGroups(projectId: string): Promise<void> {
  const repo = createDriftGroupRepository(projectId);
  const groups = await repo.findAll();
  useDataStore.getState().setDriftGroups(groups);
}

export interface UseDriftGroupContext {
  projectId: string;
}

export interface CreateDriftGroupInput {
  name?: string;
  parentGroupId?: string | null;
}

export interface UpdateDriftGroupInput {
  name?: string;
  color?: string | null;
  parentGroupId?: string | null;
  sortOrder?: number | null;
}

function nextSiblingSortOrder(
  groups: readonly DriftGroup[],
  parentGroupId: string | null,
  excludedIds: ReadonlySet<string> = new Set(),
): number {
  const positions = groups
    .filter(
      (group) =>
        !excludedIds.has(group.id) &&
        group.parentGroupId === parentGroupId &&
        typeof group.sortOrder === 'number' &&
        Number.isFinite(group.sortOrder),
    )
    .map((group) => group.sortOrder as number);
  if (positions.length === 0) return 0;
  const maximum = Math.max(...positions);
  const next = maximum + 1;
  if (!Number.isFinite(next) || next === maximum) {
    throw new Error('Drift-group order space is exhausted; an explicit rebalance is required.');
  }
  return next;
}

export function useDriftGroup({ projectId }: UseDriftGroupContext) {
  const createGroup = useCallback(
    async (input: CreateDriftGroupInput = {}): Promise<DriftGroup | null> => {
      if (!projectId) return null;
      const now = new Date().toISOString();
      const parentGroupId = input.parentGroupId ?? null;
      const existingGroups = useDataStore.getState().driftGroups;
      const group: DriftGroup = {
        id: uuidv7(),
        projectId,
        name: input.name?.trim() || DEFAULT_DRIFT_GROUP_NAME,
        parentGroupId,
        color: null,
        sortOrder: nextSiblingSortOrder(existingGroups, parentGroupId),
        createdAt: now,
        updatedAt: now,
      };
      await withAtomicSyncTransaction(projectId, async (tx, sync, changes) => {
        await createDriftGroupRepository(projectId, tx).create(group);
        await sync('driftGroup', 'create', group.id, projectId, {
          id: group.id,
          name: group.name,
          parentGroupId: group.parentGroupId,
          color: group.color,
          createdAt: group.createdAt,
          updatedAt: group.updatedAt,
        });
        await appendPlannedAuthoredOrderInTransaction(tx, changes, {
          projectId,
          listKind: 'drift-group',
          scope: driftGroupOrderScope(projectId, group.parentGroupId),
          desiredEntityIds: entityIdsByNumericPlacement(
            [...existingGroups, group]
              .filter((entry) => entry.parentGroupId === group.parentGroupId)
              .map((entry) => ({
                entityId: entry.id,
                projection: entry.sortOrder ?? 0,
              })),
          ),
        });
      });
      useDataStore.getState().addDriftGroup(group);
      return group;
    },
    [projectId],
  );

  const updateGroup = useCallback(
    async (id: string, input: UpdateDriftGroupInput): Promise<DriftGroup | null> => {
      const groups = useDataStore.getState().driftGroups;
      const existing = groups.find((group) => group.id === id);
      if (!existing) return null;
      if (input.sortOrder === null) {
        throw new Error('Drift-group sortOrder must be a finite authored position.');
      }
      const nextParentGroupId =
        input.parentGroupId === undefined
          ? existing.parentGroupId
          : input.parentGroupId;
      const requestedSortOrder =
        typeof input.sortOrder === 'number'
          ? input.sortOrder
          : input.parentGroupId !== undefined && input.parentGroupId !== existing.parentGroupId
            ? nextSiblingSortOrder(groups, nextParentGroupId, new Set([id]))
            : undefined;
      const normalizedInput = {
        ...input,
        ...(requestedSortOrder !== undefined
          ? { sortOrder: requestedSortOrder }
          : {}),
      };
      const updatedAt = new Date().toISOString();
      const updated = await withAtomicSyncTransaction(projectId, async (tx, sync, changes) => {
        const result = await createDriftGroupRepository(projectId, tx).update(id, {
          ...normalizedInput,
          updatedAt,
        });
        if (result) {
          const syncPayload: Record<string, unknown> = { ...normalizedInput, updatedAt };
          delete syncPayload.sortOrder;
          if (Object.keys(syncPayload).length > 1) {
            await sync('driftGroup', 'update', id, projectId, syncPayload);
          }
          if (requestedSortOrder !== undefined) {
            const desiredEntityIds = entityIdsByNumericPlacement(
              groups
                .map((entry) =>
                  entry.id === id
                    ? {
                        ...entry,
                        parentGroupId: nextParentGroupId,
                        sortOrder: requestedSortOrder,
                      }
                    : entry,
                )
                .filter((entry) => entry.parentGroupId === nextParentGroupId)
                .map((entry) => ({
                  entityId: entry.id,
                  projection: entry.sortOrder ?? 0,
                })),
            );
            await appendPlannedAuthoredOrderInTransaction(tx, changes, {
              projectId,
              listKind: 'drift-group',
              scope: driftGroupOrderScope(projectId, nextParentGroupId),
              desiredEntityIds,
            });
          }
        }
        return result;
      });
      if (!updated) return null;
      useDataStore.getState().updateDriftGroup(id, updated);
      return updated;
    },
    [projectId],
  );

  const renameGroup = useCallback(
    (id: string, name: string) => updateGroup(id, { name: name.trim() || DEFAULT_DRIFT_GROUP_NAME }),
    [updateGroup],
  );

  // Reparent a group. Rejects a move that would create a cycle (dropping a
  // group into itself or its own subtree). newParentGroupId = null → root.
  const moveGroup = useCallback(
    async (id: string, newParentGroupId: string | null): Promise<DriftGroup | null> => {
      const groups = useDataStore.getState().driftGroups;
      if (newParentGroupId != null && isDescendantGroup(groups, newParentGroupId, id)) {
        log.warn(`moveGroup: rejected cyclic move of ${id} into ${newParentGroupId}`);
        return null;
      }
      // Temporary 2-level nesting cap — reject a move that would push this
      // group's subtree past MAX_DRIFT_GROUP_DEPTH.
      if (!canMoveGroupUnder(groups, id, newParentGroupId)) {
        log.warn(`moveGroup: rejected over-deep move of ${id} into ${newParentGroupId}`);
        return null;
      }
      return updateGroup(id, { parentGroupId: newParentGroupId });
    },
    [updateGroup],
  );

  // Delete a group, reparenting its child groups + member drifts up to its
  // parent (root if it was top-level). Direct repo → store → sync per affected
  // row, mirroring useBookAct.unbindActsForDrift's cross-entity cleanup.
  const deleteGroup = useCallback(
    async (id: string): Promise<void> => {
      const store = useDataStore.getState();
      const target = store.driftGroups.find((g) => g.id === id);
      if (!target) return;
      const newParent = target.parentGroupId; // children rise to here
      const now = new Date().toISOString();

      const childGroups = store.driftGroups
        .filter((g) => g.parentGroupId === id)
        .sort(compareDriftGroups);
      const memberDrifts = store.bookNodes.filter((n) => n.driftGroupId === id);
      const excluded = new Set([id, ...childGroups.map((group) => group.id)]);
      const firstChildOrder = nextSiblingSortOrder(store.driftGroups, newParent, excluded);
      await withAtomicSyncTransaction(projectId, async (tx, sync, changes) => {
        const groupRepoTx = createDriftGroupRepository(projectId, tx);
        const nodeRepoTx = createBookNodeSqliteRepository(projectId, tx);

        // 1. Reparent direct child groups.
        for (const [index, cg] of childGroups.entries()) {
          await groupRepoTx.update(cg.id, {
            parentGroupId: newParent,
            sortOrder: firstChildOrder + index,
            updatedAt: now,
          });
          await sync('driftGroup', 'update', cg.id, projectId, {
            parentGroupId: newParent,
            updatedAt: now,
          });
        }

        const desiredSiblings = store.driftGroups
          .filter((group) => group.id !== id)
          .map((group) => {
            const movedIndex = childGroups.findIndex((child) => child.id === group.id);
            return movedIndex < 0
              ? group
              : { ...group, parentGroupId: newParent, sortOrder: firstChildOrder + movedIndex };
          })
          .filter((group) => group.parentGroupId === newParent)
          .sort(compareDriftGroups)
          .map(({ id: entityId }) => entityId);
        if (desiredSiblings.length > 0) {
          appendAuthoredOrderRebalance(changes, {
            listKind: 'drift-group',
            scope: driftGroupOrderScope(projectId, newParent),
            entries: authoredOrderRebalanceEntries(desiredSiblings),
          });
        }

        // 2. Reparent member drifts (book_node.drift_group_id === id).
        for (const n of memberDrifts) {
          await nodeRepoTx.update(n.id, { driftGroupId: newParent, updatedAt: now });
          await sync('node', 'update', n.id, projectId, {
            driftGroupId: newParent,
            updatedAt: now,
          });
        }

        // 3. Remove the group row.
        await groupRepoTx.delete(id);
        await sync('driftGroup', 'delete', id, projectId);
      });

      for (const [index, cg] of childGroups.entries()) {
        useDataStore.getState().updateDriftGroup(cg.id, {
          parentGroupId: newParent,
          sortOrder: firstChildOrder + index,
          updatedAt: now,
        });
      }
      for (const n of memberDrifts) {
        useDataStore.getState().updateBookNode(n.id, {
          driftGroupId: newParent,
          updatedAt: now,
        });
      }
      useDataStore.getState().removeDriftGroup(id);
    },
    [projectId],
  );

  // Move a drift into a group (or out to root with groupId = null). Drift-only;
  // chapters are never grouped. Rides the node update (drift_group_id).
  const moveDriftToGroup = useCallback(
    async (driftId: string, groupId: string | null): Promise<void> => {
      const node = useDataStore.getState().bookNodes.find((n) => n.id === driftId);
      if (!node || node.kind !== 'drift') return;
      if ((node.driftGroupId ?? null) === groupId) return; // no-op
      const updatedAt = new Date().toISOString();
      await withAtomicSyncTransaction(projectId, async (tx, sync) => {
        await createBookNodeSqliteRepository(projectId, tx).update(driftId, {
          driftGroupId: groupId,
          updatedAt,
        });
        await sync('node', 'update', driftId, projectId, {
          driftGroupId: groupId,
          updatedAt,
        });
      });
      useDataStore.getState().updateBookNode(driftId, { driftGroupId: groupId, updatedAt });
    },
    [projectId],
  );

  return useMemo(
    () => ({
      createGroup,
      updateGroup,
      renameGroup,
      moveGroup,
      deleteGroup,
      moveDriftToGroup,
    }),
    [createGroup, updateGroup, renameGroup, moveGroup, deleteGroup, moveDriftToGroup],
  );
}
