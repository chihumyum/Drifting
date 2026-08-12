import { useCallback, useMemo } from 'react';
import { v7 as uuidv7 } from 'uuid';
import { useDataStore, type EntityRelationLink } from '../store/data-store';
import { createEntityRelationRepository } from '../sqlite-repo/entity-relation-repo';
import { initDatabase } from '../lib/db';
import { withOptimisticUpdate } from './optimistic';
import { withAtomicSyncTransaction } from './sync-helpers';
import { EntityRelationTable } from '../schema/drizzle';
import { eq } from 'drizzle-orm';
import {
  isStructuralEntityKind,
  type EntityRefSourceKind,
  type EntityRefTargetKind,
  type StructuralEntityKind,
} from '../domain/entity-kinds';
import {
  legacyRelationType,
  normalizeRelationTypeName,
  validateRelationAgainstType,
} from '../domain/entity-relation-type';
import type { EntityRelationType } from '../domain/entity-relation-type';
import { createEntityRelationTypeRepository } from '../sqlite-repo/entity-relation-type-repo';

export interface UseEntityRelationsContext {
  projectId: string;
  userId: string;
}

/**
 * Manage user-curated cross-entity relations (memo → node, material → element …).
 *
 * Inline mentions are NOT in scope here — they're a derived index handled by
 * `reference-index.service` + the editor's projection pass.
 */
export function useEntityRelations({ projectId, userId }: UseEntityRelationsContext) {
  if (!projectId) throw new Error('useEntityRelations requires a projectId');
  if (!userId) throw new Error('useEntityRelations requires a userId');

  const ensureDb = useCallback(async () => {
    await initDatabase(userId);
  }, [userId]);

  const loadInitial = useCallback(async () => {
    await ensureDb();
    const { getDb } = await import('../lib/db');
    const { EntityRelationTable } = await import('../schema/drizzle');
    const { eq } = await import('drizzle-orm');
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
      kind: row.kind ?? null,
      relationTypeId: row.relationTypeId ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
    useDataStore.getState().setEntityRelations(mapped);
    useDataStore.getState().setEntityRelationTypes(relationTypes);
  }, [ensureDb, projectId]);

  const addRelation = useCallback(
    async (
      fromKind: EntityRefSourceKind,
      fromId: string,
      toKind: EntityRefTargetKind,
      toId: string,
      options?: { kind?: string | null; relationTypeId?: string | null; allowUnconfigured?: boolean },
    ) => {
      await ensureDb();
      if (!isStructuralEntityKind(toKind)) {
        throw new Error(
          `Cannot create entity relation: toKind '${toKind}' is not a structural kind ` +
            `(memo / material can only appear as fromKind).`,
        );
      }
      let kind = options?.kind?.trim() || null;
      let relationTypeId = options?.relationTypeId ?? null;
      const state = useDataStore.getState();
      const typeRepo = createEntityRelationTypeRepository(projectId);
      let relationType = relationTypeId
        ? state.entityRelationTypes.find((type) => type.id === relationTypeId) ??
          (await typeRepo.findById(relationTypeId))
        : kind
          ? state.entityRelationTypes.find(
              (type) => type.normalizedName === normalizeRelationTypeName(kind!),
            ) ?? (await typeRepo.findByNormalizedName(normalizeRelationTypeName(kind)))
          : null;
      let createdRelationType: EntityRelationType | null = null;
      if (!relationType && kind) {
        relationType = legacyRelationType(projectId, kind, new Date().toISOString(), new Date().toISOString());
        createdRelationType = relationType;
      }
      if (relationType) {
        const checked = validateRelationAgainstType(
          relationType,
          { fromKind, fromId, toKind, toId },
          { allowUnconfigured: options?.allowUnconfigured ?? true },
        );
        if (!checked.ok) throw new Error(checked.message);
        ({ fromKind, fromId, toKind, toId } = checked.relation);
        relationTypeId = relationType.id;
        kind = relationType.name;
      }
      const deferSyncForPendingLibraryItem =
        fromKind === 'library_item' && !!state.libraryItemUploadStates[fromId];
      // Don't double-add the same pair with the same kind. Different kinds
      // between the same pair are allowed.
      const dup = state.entityRelations.find(
        (r) =>
          r.fromKind === fromKind &&
          r.fromId === fromId &&
          r.toKind === toKind &&
          r.toId === toId &&
          (r.relationTypeId ?? null) === relationTypeId &&
          (relationTypeId !== null || (r.kind ?? null) === kind),
      );
      if (dup) return dup;

      const now = new Date().toISOString();
      const newRow: EntityRelationLink = {
        id: uuidv7(),
        projectId,
        fromKind,
        fromId,
        toKind,
        toId,
        relationTypeId,
        kind,
        createdAt: now,
        updatedAt: now,
      };

      const prev = state.entityRelations.slice();
      const prevTypes = state.entityRelationTypes.slice();
      return withOptimisticUpdate({
        apply: () => {
          useDataStore.getState().setEntityRelations([...prev, newRow]);
          if (createdRelationType) {
            useDataStore.getState().setEntityRelationTypes([...prevTypes, createdRelationType]);
          }
        },
        rollback: () => {
          useDataStore.getState().setEntityRelations(prev);
          useDataStore.getState().setEntityRelationTypes(prevTypes);
        },
        // Insert directly so the optimistic row id matches the persisted id
        // (otherwise rollback / sync would diverge).
        effect: async () => {
          return withAtomicSyncTransaction(projectId, async (tx, sync) => {
            if (createdRelationType) {
              await createEntityRelationTypeRepository(projectId, tx).create(createdRelationType);
              await sync('entityRelationType', 'create', createdRelationType.id, projectId, {
                ...createdRelationType,
              });
            }
            await tx.insert(EntityRelationTable).values(newRow);
            if (!deferSyncForPendingLibraryItem) {
              await sync('entityRelation', 'create', newRow.id, projectId, {
                id: newRow.id,
                fromKind: newRow.fromKind,
                fromId: newRow.fromId,
                toKind: newRow.toKind,
                toId: newRow.toId,
                relationTypeId: newRow.relationTypeId,
                kind: newRow.kind,
              });
            }
            return newRow;
          });
        },
      });
    },
    [ensureDb, projectId],
  );

  const removeRelation = useCallback(
    async (id: string) => {
      await ensureDb();
      const state = useDataStore.getState();
      const existing = state.entityRelations.find((r) => r.id === id);
      if (!existing) return;
      const prev = state.entityRelations.slice();
      const filtered = prev.filter((r) => r.id !== id);
      return withOptimisticUpdate({
        apply: () => useDataStore.getState().setEntityRelations(filtered),
        rollback: () => useDataStore.getState().setEntityRelations(prev),
        effect: async () => {
          return withAtomicSyncTransaction(projectId, async (tx, sync) => {
            await createEntityRelationRepository(tx).removeRelation(id);
            await sync('entityRelation', 'delete', id, projectId);
            return true;
          });
        },
      });
    },
    [ensureDb, projectId],
  );

  // Rolling-upgrade compatibility for legacy callers that still update a
  // display label. First-class desktop and Agent flows use updateRelationType.
  const updateRelationKind = useCallback(
    async (id: string, kind: string | null) => {
      await ensureDb();
      const state = useDataStore.getState();
      const existing = state.entityRelations.find((r) => r.id === id);
      if (!existing) return;
      const trimmed = typeof kind === 'string' ? kind.trim() || null : null;
      const typeRepo = createEntityRelationTypeRepository(projectId);
      let relationType = trimmed
        ? state.entityRelationTypes.find(
            (type) => type.normalizedName === normalizeRelationTypeName(trimmed),
          ) ?? (await typeRepo.findByNormalizedName(normalizeRelationTypeName(trimmed)))
        : null;
      let createdRelationType: EntityRelationType | null = null;
      if (!relationType && trimmed) {
        relationType = legacyRelationType(
          projectId,
          trimmed,
          new Date().toISOString(),
          new Date().toISOString(),
        );
        createdRelationType = relationType;
      }
      const prev = state.entityRelations.slice();
      const prevTypes = state.entityRelationTypes.slice();
      const now = new Date().toISOString();
      const next = prev.map((r) =>
        r.id === id
          ? {
              ...r,
              kind: relationType?.name ?? trimmed,
              relationTypeId: relationType?.id ?? null,
              updatedAt: now,
            }
          : r,
      );
      return withOptimisticUpdate({
        apply: () => {
          useDataStore.getState().setEntityRelations(next);
          if (createdRelationType) {
            useDataStore.getState().setEntityRelationTypes([...prevTypes, createdRelationType]);
          }
        },
        rollback: () => {
          useDataStore.getState().setEntityRelations(prev);
          useDataStore.getState().setEntityRelationTypes(prevTypes);
        },
        effect: async () => {
          return withAtomicSyncTransaction(projectId, async (tx, sync) => {
            if (createdRelationType) {
              await createEntityRelationTypeRepository(projectId, tx).create(createdRelationType);
              await sync('entityRelationType', 'create', createdRelationType.id, projectId, {
                ...createdRelationType,
              });
            }
            await tx
              .update(EntityRelationTable)
              .set({
                kind: relationType?.name ?? trimmed,
                relationTypeId: relationType?.id ?? null,
                updatedAt: now,
              })
              .where(eq(EntityRelationTable.id, id));
            await sync('entityRelation', 'update', id, projectId, {
              kind: relationType?.name ?? trimmed,
              relationTypeId: relationType?.id ?? null,
            });
            return true;
          });
        },
      });
    },
    [ensureDb, projectId],
  );

  const updateRelationType = useCallback(
    async (
      id: string,
      relationTypeId: string | null,
      options: { swapEndpoints?: boolean; allowUnconfigured?: boolean } = {},
    ) => {
      await ensureDb();
      const state = useDataStore.getState();
      const existing = state.entityRelations.find((relation) => relation.id === id);
      if (!existing) return;
      const relationType = relationTypeId
        ? state.entityRelationTypes.find(
            (candidate) =>
              candidate.id === relationTypeId && candidate.projectId === projectId,
          ) ?? (await createEntityRelationTypeRepository(projectId).findById(relationTypeId))
        : null;
      if (relationTypeId && !relationType) throw new Error('关系类型不存在或不属于当前项目');
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
      const checked = relationType
        ? validateRelationAgainstType(
            relationType,
            { ...candidate, toKind: candidate.toKind },
            { allowUnconfigured: options.allowUnconfigured ?? true },
          )
        : { ok: true as const, relation: { ...candidate, toKind: candidate.toKind } };
      if (!checked.ok) throw new Error(checked.message);
      const now = new Date().toISOString();
      const nextRow: EntityRelationLink = {
        ...existing,
        ...checked.relation,
        relationTypeId: relationType?.id ?? null,
        kind: relationType?.name ?? null,
        updatedAt: now,
      };
      const previous = state.entityRelations.slice();
      return withOptimisticUpdate({
        apply: () =>
          useDataStore
            .getState()
            .setEntityRelations(previous.map((row) => (row.id === id ? nextRow : row))),
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
                relationTypeId: nextRow.relationTypeId,
                kind: nextRow.kind,
                updatedAt: now,
              })
              .where(eq(EntityRelationTable.id, id));
            await sync('entityRelation', 'update', id, projectId, {
              fromKind: nextRow.fromKind,
              fromId: nextRow.fromId,
              toKind: nextRow.toKind,
              toId: nextRow.toId,
              relationTypeId: nextRow.relationTypeId,
              kind: nextRow.kind,
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
      removeRelation,
      updateRelationKind,
      updateRelationType,
    }),
    [loadInitial, addRelation, removeRelation, updateRelationKind, updateRelationType],
  );
}
