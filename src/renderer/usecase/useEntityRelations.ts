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
    const mapped: EntityRelationLink[] = rows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      fromKind: row.fromKind as EntityRelationLink['fromKind'],
      fromId: row.fromId,
      toKind: row.toKind as StructuralEntityKind,
      toId: row.toId,
      kind: row.kind ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
    useDataStore.getState().setEntityRelations(mapped);
  }, [ensureDb, projectId]);

  const addRelation = useCallback(
    async (
      fromKind: EntityRefSourceKind,
      fromId: string,
      toKind: EntityRefTargetKind,
      toId: string,
      options?: { kind?: string | null },
    ) => {
      await ensureDb();
      if (!isStructuralEntityKind(toKind)) {
        throw new Error(
          `Cannot create entity relation: toKind '${toKind}' is not a structural kind ` +
            `(memo / material can only appear as fromKind).`,
        );
      }
      const kind = options?.kind?.trim() || null;
      const state = useDataStore.getState();
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
          (r.kind ?? null) === kind,
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
        kind,
        createdAt: now,
        updatedAt: now,
      };

      const prev = state.entityRelations.slice();
      return withOptimisticUpdate({
        apply: () => useDataStore.getState().setEntityRelations([...prev, newRow]),
        rollback: () => useDataStore.getState().setEntityRelations(prev),
        // Insert directly so the optimistic row id matches the persisted id
        // (otherwise rollback / sync would diverge).
        effect: async () => {
          return withAtomicSyncTransaction(projectId, async (tx, sync) => {
            await tx.insert(EntityRelationTable).values(newRow);
            if (!deferSyncForPendingLibraryItem) {
              await sync('entityRelation', 'create', newRow.id, projectId, {
                id: newRow.id,
                fromKind: newRow.fromKind,
                fromId: newRow.fromId,
                toKind: newRow.toKind,
                toId: newRow.toId,
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

  // Update the free-form relation category. Used by EdgeKindManager's rename
  // flow to retag all rows of a given kind at once.
  const updateRelationKind = useCallback(
    async (id: string, kind: string | null) => {
      await ensureDb();
      const state = useDataStore.getState();
      const existing = state.entityRelations.find((r) => r.id === id);
      if (!existing) return;
      const trimmed = typeof kind === 'string' ? kind.trim() || null : null;
      const prev = state.entityRelations.slice();
      const now = new Date().toISOString();
      const next = prev.map((r) =>
        r.id === id ? { ...r, kind: trimmed, updatedAt: now } : r,
      );
      return withOptimisticUpdate({
        apply: () => useDataStore.getState().setEntityRelations(next),
        rollback: () => useDataStore.getState().setEntityRelations(prev),
        effect: async () => {
          return withAtomicSyncTransaction(projectId, async (tx, sync) => {
            await tx
              .update(EntityRelationTable)
              .set({ kind: trimmed, updatedAt: now })
              .where(eq(EntityRelationTable.id, id));
            await sync('entityRelation', 'update', id, projectId, { kind: trimmed });
            return true;
          });
        },
      });
    },
    [ensureDb, projectId],
  );

  return useMemo(
    () => ({ loadInitial, addRelation, removeRelation, updateRelationKind }),
    [loadInitial, addRelation, removeRelation, updateRelationKind],
  );
}
