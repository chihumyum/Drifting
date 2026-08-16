import { useCallback, useMemo } from 'react';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import {
  genericAssociationRelationType,
  genericAssociationRelationTypeId,
  GENERIC_ASSOCIATION_SYSTEM_KEY,
  validateRelationAgainstType,
  type EntityRelationType,
} from '../domain/entity-relation-type';
import {
  isStructuralEntityKind,
  type EntityRefSourceKind,
  type EntityRefTargetKind,
  type StructuralEntityKind,
} from '../domain/entity-kinds';
import { getDb, initDatabase } from '../lib/db';
import { EntityRelationTable } from '../schema/drizzle';
import { createEntityRelationRepository } from '../sqlite-repo/entity-relation-repo';
import { createEntityRelationTypeRepository } from '../sqlite-repo/entity-relation-type-repo';
import { useDataStore, type EntityRelationLink } from '../store/data-store';
import { withOptimisticUpdate } from './optimistic';
import { withAtomicSyncTransaction } from './sync-helpers';

export interface UseEntityRelationsContext {
  projectId: string;
  userId: string;
}

type GenericAssociationSourceKind = Extract<
  EntityRefSourceKind,
  'comment' | 'library_item'
>;

/**
 * Manage user-curated cross-entity relations. Every relation is owned by one
 * first-class relation type; inline mentions remain a separate derived index.
 */
export function useEntityRelations({ projectId, userId }: UseEntityRelationsContext) {
  if (!projectId) throw new Error('useEntityRelations requires a projectId');
  if (!userId) throw new Error('useEntityRelations requires a userId');

  const ensureDb = useCallback(async () => {
    await initDatabase(userId);
  }, [userId]);

  const loadInitial = useCallback(async () => {
    await ensureDb();
    const rows = await getDb()
      .select()
      .from(EntityRelationTable)
      .where(eq(EntityRelationTable.projectId, projectId));
    const relationTypes = await createEntityRelationTypeRepository(projectId).list();
    const mapped: EntityRelationLink[] = rows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      fromKind: row.fromKind as EntityRelationLink['fromKind'],
      fromId: row.fromId,
      toKind: row.toKind as StructuralEntityKind,
      toId: row.toId,
      relationTypeId: row.relationTypeId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
    useDataStore.getState().setEntityRelations(mapped);
    useDataStore.getState().setEntityRelationTypes(relationTypes);
  }, [ensureDb, projectId]);

  const addTypedRelation = useCallback(
    async (
      fromKind: EntityRefSourceKind,
      fromId: string,
      toKind: EntityRefTargetKind,
      toId: string,
      relationType: EntityRelationType,
      createRelationType: boolean,
    ) => {
      if (!isStructuralEntityKind(toKind)) {
        throw new Error(
          `Cannot create entity relation: toKind '${toKind}' is not a structural kind ` +
            `(memo / material can only appear as fromKind).`,
        );
      }
      if (relationType.projectId !== projectId) {
        throw new Error('关系类型不存在或不属于当前项目');
      }
      const checked = validateRelationAgainstType(relationType, {
        fromKind,
        fromId,
        toKind,
        toId,
      });
      if (!checked.ok) throw new Error(checked.message);
      ({ fromKind, fromId, toKind, toId } = checked.relation);

      const state = useDataStore.getState();
      const duplicate = state.entityRelations.find(
        (relation) =>
          relation.projectId === projectId &&
          relation.fromKind === fromKind &&
          relation.fromId === fromId &&
          relation.toKind === toKind &&
          relation.toId === toId &&
          relation.relationTypeId === relationType.id,
      );
      if (duplicate) return duplicate;

      const now = new Date().toISOString();
      const newRow: EntityRelationLink = {
        id: uuidv7(),
        projectId,
        fromKind,
        fromId,
        toKind,
        toId,
        relationTypeId: relationType.id,
        createdAt: now,
        updatedAt: now,
      };
      const previousRelations = state.entityRelations.slice();
      const previousTypes = state.entityRelationTypes.slice();
      const nextTypes = previousTypes.some((type) => type.id === relationType.id)
        ? previousTypes
        : [...previousTypes, relationType];

      return withOptimisticUpdate({
        apply: () => {
          useDataStore.getState().setEntityRelations([...previousRelations, newRow]);
          useDataStore.getState().setEntityRelationTypes(nextTypes);
        },
        rollback: () => {
          useDataStore.getState().setEntityRelations(previousRelations);
          useDataStore.getState().setEntityRelationTypes(previousTypes);
        },
        effect: () =>
          withAtomicSyncTransaction(projectId, async (tx, sync) => {
            if (createRelationType) {
              await createEntityRelationTypeRepository(projectId, tx).create(relationType);
              await sync(
                'entityRelationType',
                'create',
                relationType.id,
                projectId,
                { ...relationType },
              );
            }
            await tx.insert(EntityRelationTable).values(newRow);
            await sync('entityRelation', 'create', newRow.id, projectId, {
              id: newRow.id,
              fromKind: newRow.fromKind,
              fromId: newRow.fromId,
              toKind: newRow.toKind,
              toId: newRow.toId,
              relationTypeId: newRow.relationTypeId,
            });
            return newRow;
          }),
      });
    },
    [projectId],
  );

  const addRelation = useCallback(
    async (
      fromKind: EntityRefSourceKind,
      fromId: string,
      toKind: EntityRefTargetKind,
      toId: string,
      options: { relationTypeId: string },
    ) => {
      await ensureDb();
      if (!options.relationTypeId?.trim()) {
        throw new Error('创建关系必须指定 relationTypeId');
      }
      const state = useDataStore.getState();
      const relationType =
        state.entityRelationTypes.find(
          (candidate) =>
            candidate.id === options.relationTypeId && candidate.projectId === projectId,
        ) ??
        (await createEntityRelationTypeRepository(projectId).findById(
          options.relationTypeId,
        ));
      if (!relationType) throw new Error('关系类型不存在或不属于当前项目');
      return addTypedRelation(fromKind, fromId, toKind, toId, relationType, false);
    },
    [addTypedRelation, ensureDb, projectId],
  );

  const addGenericAssociation = useCallback(
    async (
      fromKind: GenericAssociationSourceKind,
      fromId: string,
      toKind: EntityRefTargetKind,
      toId: string,
    ) => {
      await ensureDb();
      const typeRepo = createEntityRelationTypeRepository(projectId);
      const existing = await typeRepo.findBySystemKey(GENERIC_ASSOCIATION_SYSTEM_KEY);
      const expectedId = genericAssociationRelationTypeId(projectId);
      if (existing && (existing.id !== expectedId || !existing.locked)) {
        throw new Error('内建通用关联类型的系统身份无效');
      }
      const relationType =
        existing ?? genericAssociationRelationType(projectId, new Date().toISOString());
      return addTypedRelation(fromKind, fromId, toKind, toId, relationType, !existing);
    },
    [addTypedRelation, ensureDb, projectId],
  );

  const removeRelation = useCallback(
    async (id: string) => {
      await ensureDb();
      const state = useDataStore.getState();
      const existing = state.entityRelations.find(
        (relation) => relation.id === id && relation.projectId === projectId,
      );
      if (!existing) return;
      const previous = state.entityRelations.slice();
      return withOptimisticUpdate({
        apply: () =>
          useDataStore
            .getState()
            .setEntityRelations(previous.filter((relation) => relation.id !== id)),
        rollback: () => useDataStore.getState().setEntityRelations(previous),
        effect: () =>
          withAtomicSyncTransaction(projectId, async (tx, sync) => {
            await createEntityRelationRepository(tx).removeRelation(id);
            await sync('entityRelation', 'delete', id, projectId);
            return true;
          }),
      });
    },
    [ensureDb, projectId],
  );

  const updateRelationType = useCallback(
    async (
      id: string,
      relationTypeId: string,
      options: { swapEndpoints?: boolean } = {},
    ) => {
      await ensureDb();
      if (!relationTypeId?.trim()) throw new Error('关系必须指定 relationTypeId');
      const state = useDataStore.getState();
      const existing = state.entityRelations.find(
        (relation) => relation.id === id && relation.projectId === projectId,
      );
      if (!existing) return;
      const relationType =
        state.entityRelationTypes.find(
          (candidate) => candidate.id === relationTypeId && candidate.projectId === projectId,
        ) ?? (await createEntityRelationTypeRepository(projectId).findById(relationTypeId));
      if (!relationType) throw new Error('关系类型不存在或不属于当前项目');

      const candidate = options.swapEndpoints
        ? {
            fromKind: existing.toKind,
            fromId: existing.toId,
            toKind: existing.fromKind,
            toId: existing.fromId,
          }
        : {
            fromKind: existing.fromKind,
            fromId: existing.fromId,
            toKind: existing.toKind,
            toId: existing.toId,
          };
      if (!isStructuralEntityKind(candidate.toKind)) {
        throw new Error('交换后目标端不是结构实体，无法保存该方向');
      }
      const checked = validateRelationAgainstType(relationType, {
        ...candidate,
        toKind: candidate.toKind,
      });
      if (!checked.ok) throw new Error(checked.message);

      const now = new Date().toISOString();
      const nextRow: EntityRelationLink = {
        ...existing,
        ...checked.relation,
        relationTypeId,
        updatedAt: now,
      };
      const duplicate = state.entityRelations.find(
        (relation) =>
          relation.id !== id &&
          relation.projectId === projectId &&
          relation.fromKind === nextRow.fromKind &&
          relation.fromId === nextRow.fromId &&
          relation.toKind === nextRow.toKind &&
          relation.toId === nextRow.toId &&
          relation.relationTypeId === relationTypeId,
      );
      if (duplicate) throw new Error('相同类型的关系已存在');

      const previous = state.entityRelations.slice();
      return withOptimisticUpdate({
        apply: () =>
          useDataStore
            .getState()
            .setEntityRelations(
              previous.map((relation) => (relation.id === id ? nextRow : relation)),
            ),
        rollback: () => useDataStore.getState().setEntityRelations(previous),
        effect: () =>
          withAtomicSyncTransaction(projectId, async (tx, sync) => {
            await tx
              .update(EntityRelationTable)
              .set({
                fromKind: nextRow.fromKind,
                fromId: nextRow.fromId,
                toKind: nextRow.toKind,
                toId: nextRow.toId,
                relationTypeId,
                updatedAt: now,
              })
              .where(
                and(
                  eq(EntityRelationTable.id, id),
                  eq(EntityRelationTable.projectId, projectId),
                ),
              );
            await sync('entityRelation', 'update', id, projectId, {
              fromKind: nextRow.fromKind,
              fromId: nextRow.fromId,
              toKind: nextRow.toKind,
              toId: nextRow.toId,
              relationTypeId,
            });
            return nextRow;
          }),
      });
    },
    [ensureDb, projectId],
  );

  return useMemo(
    () => ({
      loadInitial,
      addRelation,
      addGenericAssociation,
      removeRelation,
      updateRelationType,
    }),
    [loadInitial, addRelation, addGenericAssociation, removeRelation, updateRelationType],
  );
}
