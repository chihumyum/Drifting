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
import { canMoveGroupUnder, isDescendantGroup, type DriftGroup } from '../domain/drift-group';
import {
  syncDriftGroupCreate,
  syncDriftGroupDelete,
  syncDriftGroupUpdate,
  syncNodeUpdate,
} from './sync-helpers';
import loglevel from 'loglevel';

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

export function useDriftGroup({ projectId }: UseDriftGroupContext) {
  const groupRepo = useMemo(() => createDriftGroupRepository(projectId), [projectId]);
  const nodeRepo = useMemo(() => createBookNodeSqliteRepository(projectId), [projectId]);

  const createGroup = useCallback(
    async (input: CreateDriftGroupInput = {}): Promise<DriftGroup | null> => {
      if (!projectId) return null;
      const now = new Date().toISOString();
      const group: DriftGroup = {
        id: uuidv7(),
        projectId,
        name: input.name?.trim() || DEFAULT_DRIFT_GROUP_NAME,
        parentGroupId: input.parentGroupId ?? null,
        color: null,
        sortOrder: null,
        createdAt: now,
        updatedAt: now,
      };
      await groupRepo.create(group);
      useDataStore.getState().addDriftGroup(group);
      syncDriftGroupCreate(group.id, projectId, {
        id: group.id,
        name: group.name,
        parentGroupId: group.parentGroupId,
        color: group.color,
        sortOrder: group.sortOrder,
        createdAt: group.createdAt,
        updatedAt: group.updatedAt,
      });
      return group;
    },
    [projectId, groupRepo],
  );

  const updateGroup = useCallback(
    async (id: string, input: UpdateDriftGroupInput): Promise<DriftGroup | null> => {
      const updatedAt = new Date().toISOString();
      const updated = await groupRepo.update(id, { ...input, updatedAt });
      if (!updated) return null;
      useDataStore.getState().updateDriftGroup(id, updated);
      syncDriftGroupUpdate(id, projectId, { ...input, updatedAt });
      return updated;
    },
    [projectId, groupRepo],
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

      // 1. Reparent direct child groups.
      const childGroups = store.driftGroups.filter((g) => g.parentGroupId === id);
      for (const cg of childGroups) {
        await groupRepo.update(cg.id, { parentGroupId: newParent, updatedAt: now });
        useDataStore.getState().updateDriftGroup(cg.id, { parentGroupId: newParent, updatedAt: now });
        syncDriftGroupUpdate(cg.id, projectId, { parentGroupId: newParent, updatedAt: now });
      }

      // 2. Reparent member drifts (book_node.drift_group_id === id).
      const memberDrifts = store.bookNodes.filter((n) => n.driftGroupId === id);
      for (const n of memberDrifts) {
        await nodeRepo.update(n.id, { driftGroupId: newParent, updatedAt: now });
        useDataStore.getState().updateBookNode(n.id, { driftGroupId: newParent, updatedAt: now });
        syncNodeUpdate(n.id, projectId, { driftGroupId: newParent, updatedAt: now });
      }

      // 3. Remove the group row.
      await groupRepo.delete(id);
      useDataStore.getState().removeDriftGroup(id);
      syncDriftGroupDelete(id, projectId);
    },
    [projectId, groupRepo, nodeRepo],
  );

  // Move a drift into a group (or out to root with groupId = null). Drift-only;
  // chapters are never grouped. Rides the node update (drift_group_id).
  const moveDriftToGroup = useCallback(
    async (driftId: string, groupId: string | null): Promise<void> => {
      const node = useDataStore.getState().bookNodes.find((n) => n.id === driftId);
      if (!node || node.kind !== 'drift') return;
      if ((node.driftGroupId ?? null) === groupId) return; // no-op
      const updatedAt = new Date().toISOString();
      await nodeRepo.update(driftId, { driftGroupId: groupId, updatedAt });
      useDataStore.getState().updateBookNode(driftId, { driftGroupId: groupId, updatedAt });
      syncNodeUpdate(driftId, projectId, { driftGroupId: groupId, updatedAt });
    },
    [projectId, nodeRepo],
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
