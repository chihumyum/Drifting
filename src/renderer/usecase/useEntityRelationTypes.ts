import { useCallback, useMemo } from 'react';
import { v7 as uuidv7 } from 'uuid';

import {
  normalizeRelationTypeDefinition,
  validateRelationAgainstType,
  type EntityRelationType,
  type EntityRelationTypeDefinition,
} from '../domain/entity-relation-type';
import { createEntityRelationTypeRepository } from '../sqlite-repo/entity-relation-type-repo';
import { useDataStore } from '../store/data-store';
import { withOptimisticUpdate } from './optimistic';
import { withAtomicSyncTransaction } from './sync-helpers';

export function useEntityRelationTypes({ projectId }: { projectId: string }) {
  if (!projectId) throw new Error('useEntityRelationTypes requires a projectId');

  const createRelationType = useCallback(
    async (definition: EntityRelationTypeDefinition): Promise<EntityRelationType> => {
      const normalized = normalizeRelationTypeDefinition(definition);
      const state = useDataStore.getState();
      if (
        state.entityRelationTypes.some(
          (type) =>
            type.projectId === projectId && type.normalizedName === normalized.normalizedName,
        )
      ) {
        throw new Error(`关系类型「${normalized.name}」已存在`);
      }
      const now = new Date().toISOString();
      const value: EntityRelationType = {
        id: uuidv7(),
        projectId,
        ...normalized,
        systemKey: null,
        locked: false,
        createdAt: now,
        updatedAt: now,
      };
      const previous = state.entityRelationTypes.slice();
      return withOptimisticUpdate({
        apply: () => useDataStore.getState().setEntityRelationTypes([...previous, value]),
        rollback: () => useDataStore.getState().setEntityRelationTypes(previous),
        effect: () =>
          withAtomicSyncTransaction(projectId, async (tx, sync) => {
            await createEntityRelationTypeRepository(projectId, tx).create(value);
            await sync('entityRelationType', 'create', value.id, projectId, { ...value });
            return value;
          }),
      });
    },
    [projectId],
  );

  const updateRelationType = useCallback(
    async (
      id: string,
      definition: EntityRelationTypeDefinition,
    ): Promise<EntityRelationType> => {
      const state = useDataStore.getState();
      const previousType = state.entityRelationTypes.find(
        (type) => type.id === id && type.projectId === projectId,
      );
      if (!previousType) throw new Error('关系类型不存在或不属于当前项目');
      if (previousType.locked) throw new Error('内建关系类型不能修改');
      const normalized = normalizeRelationTypeDefinition(definition);
      const duplicate = state.entityRelationTypes.find(
        (type) =>
          type.id !== id &&
          type.projectId === projectId &&
          type.normalizedName === normalized.normalizedName,
      );
      if (duplicate) throw new Error(`关系类型「${normalized.name}」已存在`);

      const nextType: EntityRelationType = {
        ...previousType,
        ...normalized,
        updatedAt: new Date().toISOString(),
      };
      const affected = state.entityRelations.filter(
        (relation) => relation.projectId === projectId && relation.relationTypeId === id,
      );
      for (const relation of affected) {
        const checked = validateRelationAgainstType(nextType, relation);
        if (!checked.ok) {
          throw new Error(`关系「${relation.id}」不符合新约束：${checked.message}`);
        }
        if (
          checked.relation.fromKind !== relation.fromKind ||
          checked.relation.fromId !== relation.fromId ||
          checked.relation.toKind !== relation.toKind ||
          checked.relation.toId !== relation.toId
        ) {
          throw new Error(
            `关系「${relation.id}」需要先交换两端，才能把该类型改为对称关系`,
          );
        }
      }

      const previousTypes = state.entityRelationTypes.slice();
      return withOptimisticUpdate({
        apply: () =>
          useDataStore.getState().setEntityRelationTypes(
            previousTypes.map((type) => (type.id === id ? nextType : type)),
          ),
        rollback: () => useDataStore.getState().setEntityRelationTypes(previousTypes),
        effect: () =>
          withAtomicSyncTransaction(projectId, async (tx, sync) => {
            await createEntityRelationTypeRepository(projectId, tx).update(nextType);
            await sync('entityRelationType', 'update', nextType.id, projectId, { ...nextType });
            return nextType;
          }),
      });
    },
    [projectId],
  );

  const deleteRelationType = useCallback(
    async (id: string): Promise<void> => {
      const state = useDataStore.getState();
      const value = state.entityRelationTypes.find(
        (type) => type.id === id && type.projectId === projectId,
      );
      if (!value) return;
      if (value.locked) throw new Error('内建关系类型不能删除');
      const previous = state.entityRelationTypes.slice();
      await withOptimisticUpdate({
        apply: () => useDataStore.getState().removeEntityRelationType(id),
        rollback: () => useDataStore.getState().setEntityRelationTypes(previous),
        effect: () =>
          withAtomicSyncTransaction(projectId, async (tx, sync) => {
            await createEntityRelationTypeRepository(projectId, tx).remove(id);
            await sync('entityRelationType', 'delete', id, projectId);
          }),
      });
    },
    [projectId],
  );

  return useMemo(
    () => ({ createRelationType, updateRelationType, deleteRelationType }),
    [createRelationType, deleteRelationType, updateRelationType],
  );
}
