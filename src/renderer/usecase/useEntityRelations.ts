import { useCallback, useMemo } from 'react';
import { v7 as uuidv7 } from 'uuid';
import { useDataStore, type EntityReferenceLink } from '../store/data-store';
import { createReferenceRepository } from '../sqlite-repo/reference-repo';
import { initDatabase } from '../lib/db';
import { withOptimisticUpdate } from './optimistic';
import { syncEntityReferenceCreate, syncEntityReferenceDelete } from './sync-helpers';
import type { EntityKind } from '../lib/extensions/entity-link';

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
      origin: row.origin as 'manual' | 'auto' | 'ai',
      confidence: row.confidence,
      kind: row.kind ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
    useDataStore.getState().setManualReferences(mapped);
  }, [ensureDb, projectId]);

  const addRelation = useCallback(
    async (
      fromKind: EntityKind,
      fromId: string,
      toKind: EntityKind,
      toId: string,
      options?: { kind?: string | null },
    ) => {
      await ensureDb();
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
        origin: 'manual',
        confidence: null,
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
            origin: newRow.origin,
            confidence: newRow.confidence,
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
          await repo.removeManualRelation(
            existing.fromKind,
            existing.fromId,
            existing.toKind,
            existing.toId,
          );
          return true;
        },
        sync: () => syncEntityReferenceDelete(id, projectId),
      });
    },
    [repo, ensureDb, projectId],
  );

  return useMemo(
    () => ({ loadInitial, addRelation, removeRelation }),
    [loadInitial, addRelation, removeRelation],
  );
}
