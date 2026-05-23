import { useCallback, useMemo } from 'react';
import { v7 as uuidv7 } from 'uuid';
import { useDataStore, type EntityReferenceLink } from '../store/data-store';
import { createReferenceRepository } from '../sqlite-repo/reference-repo';
import { initDatabase } from '../lib/db';
import { withOptimisticUpdate } from './optimistic';
import {
  syncEntityReferenceCreate,
  syncEntityReferenceDelete,
  syncEntityReferenceUpdate,
} from './sync-helpers';
import {
  isStructuralEntityKind,
  type EntityKind,
  type EntityRefSourceKind,
  type EntityRefTargetKind,
} from '../domain/entity-kinds';

export interface UseEntityRelationsContext {
  projectId: string;
  userId: string;
}

/**
 * Manage manual whole-to-whole entity references (memo → node, material → element …).
 *
 * Inline TipTap-mark refs are handled separately by `reference-index.service`;
 * this hook is for the right-sidebar relation picker only.
 */
export function useEntityRelations({ projectId, userId }: UseEntityRelationsContext) {
  if (!projectId) throw new Error('useEntityRelations requires a projectId');
  if (!userId) throw new Error('useEntityRelations requires a userId');

  const repo = useMemo(() => createReferenceRepository(), []);
  const ensureDb = useCallback(async () => {
    await initDatabase(userId);
  }, [userId]);

  const loadInitial = useCallback(async () => {
    await ensureDb();
    const { getDb } = await import('../lib/db');
    const { EntityReferenceTable } = await import('../schema/drizzle');
    const { and, eq, isNull } = await import('drizzle-orm');
    const rows = await getDb()
      .select()
      .from(EntityReferenceTable)
      .where(
        and(
          eq(EntityReferenceTable.projectId, projectId),
          isNull(EntityReferenceTable.fromBlockId),
        ),
      );
    const mapped: EntityReferenceLink[] = rows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      fromKind: row.fromKind as EntityKind,
      fromId: row.fromId,
      fromBlockId: row.fromBlockId,
      fromSpansJson: row.fromSpansJson,
      toKind: row.toKind as EntityKind,
      toId: row.toId,
      toBlockId: row.toBlockId,
      kind: row.kind ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
    useDataStore.getState().setManualReferences(mapped);
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
          `Cannot create entity reference: toKind '${toKind}' is not a structural kind ` +
            `(memo / material can only appear as fromKind).`,
        );
      }
      const kind = options?.kind?.trim() || null;
      const state = useDataStore.getState();
      // Don't double-add the SAME manual link with the SAME kind. Different
      // kinds between the same pair are allowed — that's how users surface
      // multiple relationships between two entities.
      const dup = state.manualReferences.find(
        (r) =>
          r.fromBlockId == null &&
          r.fromKind === fromKind &&
          r.fromId === fromId &&
          r.toKind === toKind &&
          r.toId === toId &&
          (r.kind ?? null) === kind,
      );
      if (dup) return dup;

      const now = new Date().toISOString();
      const newRow: EntityReferenceLink = {
        id: uuidv7(),
        projectId,
        fromKind,
        fromId,
        fromBlockId: null,
        fromSpansJson: null,
        toKind,
        toId,
        toBlockId: null,
        kind,
        createdAt: now,
        updatedAt: now,
      };

      const prev = state.manualReferences.slice();
      return withOptimisticUpdate({
        apply: () => useDataStore.getState().setManualReferences([...prev, newRow]),
        rollback: () => useDataStore.getState().setManualReferences(prev),
        // The existing repo helper inserts a row but assigns its own uuid;
        // bypass it for the manual flow so the optimistic row id matches the
        // persisted id (otherwise rollback / sync would diverge).
        effect: async () => {
          const { getDb } = await import('../lib/db');
          const { EntityReferenceTable } = await import('../schema/drizzle');
          await getDb().insert(EntityReferenceTable).values(newRow);
          return newRow;
        },
        sync: () =>
          syncEntityReferenceCreate(newRow.id, projectId, {
            id: newRow.id,
            fromKind: newRow.fromKind,
            fromId: newRow.fromId,
            fromBlockId: newRow.fromBlockId,
            fromSpansJson: newRow.fromSpansJson,
            toKind: newRow.toKind,
            toId: newRow.toId,
            toBlockId: newRow.toBlockId,
            kind: newRow.kind,
          }),
      });
    },
    [ensureDb, projectId],
  );

  const removeRelation = useCallback(
    async (id: string) => {
      await ensureDb();
      const state = useDataStore.getState();
      const existing = state.manualReferences.find((r) => r.id === id);
      if (!existing) return;
      const prev = state.manualReferences.slice();
      const filtered = prev.filter((r) => r.id !== id);
      return withOptimisticUpdate({
        apply: () => useDataStore.getState().setManualReferences(filtered),
        rollback: () => useDataStore.getState().setManualReferences(prev),
        effect: async () => {
          await repo.removeManualRelation(id);
          return true;
        },
        sync: () => syncEntityReferenceDelete(id, projectId),
      });
    },
    [repo, ensureDb, projectId],
  );

  // Update the free-form relation category on an existing manual link. Used
  // by EdgeKindManager's rename flow to retag all rows of a given kind at
  // once. Goes straight through the table (no repo method) since this is
  // currently the only update surface manual refs have.
  const updateRelationKind = useCallback(
    async (id: string, kind: string | null) => {
      await ensureDb();
      const state = useDataStore.getState();
      const existing = state.manualReferences.find((r) => r.id === id);
      if (!existing) return;
      const trimmed = typeof kind === 'string' ? kind.trim() || null : null;
      const prev = state.manualReferences.slice();
      const now = new Date().toISOString();
      const next = prev.map((r) =>
        r.id === id ? { ...r, kind: trimmed, updatedAt: now } : r,
      );
      return withOptimisticUpdate({
        apply: () => useDataStore.getState().setManualReferences(next),
        rollback: () => useDataStore.getState().setManualReferences(prev),
        effect: async () => {
          const { getDb } = await import('../lib/db');
          const { EntityReferenceTable } = await import('../schema/drizzle');
          const { eq } = await import('drizzle-orm');
          await getDb()
            .update(EntityReferenceTable)
            .set({ kind: trimmed, updatedAt: now })
            .where(eq(EntityReferenceTable.id, id));
          return true;
        },
        sync: () =>
          syncEntityReferenceUpdate(id, projectId, {
            kind: trimmed,
          }),
      });
    },
    [ensureDb, projectId],
  );

  return useMemo(
    () => ({ loadInitial, addRelation, removeRelation, updateRelationKind }),
    [loadInitial, addRelation, removeRelation, updateRelationKind],
  );
}
