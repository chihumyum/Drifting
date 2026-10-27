import { useMemo } from 'react';
import { v7 as uuidv7 } from 'uuid';
import type { LibraryItem, LibraryItemPatch } from '../domain/library-item';
import { isValidMaterialProvenanceJson } from '../domain/material-provenance';
import { initDatabase } from '../lib/db';
import { assetStoreService } from '../services/asset-store.service';
import {
  prepareLocalProjectAsset,
  releasePickedMaterialImport,
} from '../services/local-project-asset.service';
import { createLibraryItemSqliteRepository } from '../sqlite-repo/library-item-repo';
import { createProjectAssetSqliteRepository } from '../sqlite-repo/project-asset-repo';
import { useDataStore } from '../store/data-store';
import { useUiStore } from '../store/ui-store';
import { withoutRelationsForEntity } from './entity-relation-cleanup';
import { deleteLibraryItemInTransaction } from './library-item-deletion';
import { withOptimisticUpdate } from './optimistic';
import { withAtomicSyncTransaction } from './sync-helpers';
import { runDerivedTransaction } from '../sync/journal/authored-transaction';
import {
  appendPlannedAuthoredOrderInTransaction,
  appendProjectAssetBindMutation,
} from '../sync/journal';
import { entityIdsByNumericPlacement } from '../sync/journal/order-authority';

type CreateLibraryItemCommon = {
  title?: string;
  /** Create inside this material folder; omitted = the root. */
  folderId?: string | null;
  notesJson?: string | null;
  /** Serialized `MaterialProvenance`; omitted for the author's own imports. */
  provenanceJson?: string | null;
};

export type CreateLibraryItemInput = CreateLibraryItemCommon &
  (
    | {
        kind: 'image' | 'pdf';
        sourcePath: string;
        /**
         * Release the picker import after commit (default). False when the
         * source is another app-owned file, e.g. an existing asset copied
         * into a new material.
         */
        releaseSourceImport?: boolean;
      }
    | { kind: 'text'; bodyJson?: string | null }
  );

export type UpdateLibraryItemUsecaseInput = Omit<LibraryItemPatch, 'updatedAt'>;

export interface UseLibraryItemContext {
  projectId: string;
  userId: string;
}

/** The authored sync payload of a material row. Exported for tests. */
export function libraryMutationPayload(item: LibraryItem): Record<string, unknown> {
  return {
    id: item.id,
    title: item.title,
    kind: item.kind,
    assetId: item.assetId,
    externalUrl: item.externalUrl,
    bodyJson: item.bodyJson,
    notesJson: item.notesJson,
    // Absent rather than null when unset: builds before migration 0009 reject
    // any provenanceJson field, so only materials that carry provenance need
    // every device on a current build.
    ...(item.provenanceJson !== null ? { provenanceJson: item.provenanceJson } : {}),
    // Likewise only filed materials and notes with TODOs switched off carry
    // the 0012 fields, so unfiled materials still sync to older builds.
    ...(item.folderId !== null ? { folderId: item.folderId } : {}),
    ...(item.taskTodos ? {} : { taskTodos: false }),
  };
}

function prependedLibraryOrder(items: readonly LibraryItem[]): number {
  const positions = items
    .map((item) => item.orderKey)
    .filter((position) => Number.isFinite(position));
  if (positions.length === 0) return 0;
  const minimum = Math.min(...positions);
  const previous = minimum - 1;
  if (!Number.isFinite(previous) || previous === minimum) {
    throw new Error('Library order space is exhausted; an explicit rebalance is required.');
  }
  return previous;
}

/** Plain (non-hook) library usecases, for services such as history restore. */
export function createLibraryItemUsecases({ projectId, userId }: UseLibraryItemContext) {
  if (!projectId) throw new Error('useLibraryItem requires a projectId');
  if (!userId) throw new Error('useLibraryItem requires a userId');

  const repo = createLibraryItemSqliteRepository(projectId);
  const ensureDb = async () => {
    await initDatabase(userId);
  };
  const getItems = () => useDataStore.getState().libraryItems;
  const setItems = (items: LibraryItem[]) => useDataStore.getState().setLibraryItems(items);

  const loadInitial = async () => {
    await ensureDb();
    setItems(await repo.findAll());
  };

  const createLibraryItem = async (input: CreateLibraryItemInput) => {
    await ensureDb();
    const previous = getItems().slice();
    const itemId = uuidv7();
    const now = new Date().toISOString();
    const orderKey = prependedLibraryOrder(previous);
    if (!isValidMaterialProvenanceJson(input.provenanceJson ?? null)) {
      throw new Error('Material provenance is not a valid current record');
    }
    const localAsset =
      input.kind === 'image' || input.kind === 'pdf'
        ? await prepareLocalProjectAsset({
            projectId,
            kind: input.kind,
            sourcePath: input.sourcePath,
          })
        : null;
    const common = {
      id: itemId,
      projectId,
      title: input.title?.trim() ?? '',
      notesJson: input.notesJson ?? null,
      provenanceJson: input.provenanceJson ?? null,
      orderKey,
      folderId: input.folderId ?? null,
      taskTodos: true,
      createdAt: now,
      updatedAt: now,
    };
    let newItem: LibraryItem;
    if (input.kind === 'image' || input.kind === 'pdf') {
      if (!localAsset) throw new Error('Binary library item import did not create an asset');
      newItem = {
        ...common,
        kind: input.kind,
        assetId: localAsset.id,
        externalUrl: null,
        previewImageUrl: null,
        bodyJson: null,
      };
    } else if (input.kind === 'text') {
      newItem = {
        ...common,
        kind: 'text',
        assetId: null,
        externalUrl: null,
        previewImageUrl: null,
        bodyJson: input.bodyJson ?? null,
      };
    } else {
      throw new Error('Unsupported library item kind');
    }
    try {
      const persisted = await withOptimisticUpdate({
        apply: () => setItems([newItem, ...previous]),
        rollback: () => setItems(previous),
        effect: () =>
          withAtomicSyncTransaction(projectId, async (tx, sync, changes) => {
            if (localAsset) {
              await createProjectAssetSqliteRepository(projectId, tx).create(localAsset);
              appendProjectAssetBindMutation(changes, projectId, localAsset, {
                kind: 'library-item',
                id: newItem.id,
              });
            }
            const item = await createLibraryItemSqliteRepository(projectId, tx).create(newItem);
            await sync('libraryItem', 'create', item.id, projectId, libraryMutationPayload(item));
            const desiredEntityIds = entityIdsByNumericPlacement(
              [item, ...previous].map((entry) => ({
                entityId: entry.id,
                projection: entry.orderKey,
              })),
            );
            await appendPlannedAuthoredOrderInTransaction(tx, changes, {
              projectId,
              listKind: 'library-item',
              scope: projectId,
              desiredEntityIds,
            });
            return item;
          }),
        onSuccess: (item) => {
          setItems(getItems().map((candidate) => (candidate.id === item.id ? item : candidate)));
          if (localAsset) useDataStore.getState().upsertProjectAsset(localAsset);
        },
      });
      if (localAsset && (input.kind === 'image' || input.kind === 'pdf')) {
        await assetStoreService.commitImport(projectId, localAsset.id).catch((error) => {
          // The SQLite row and source bytes are already committed. Leaving
          // the marker is safe: startup GC clears it from the retained set.
          console.warn('[material] failed to clear committed asset import marker:', error);
        });
        if (input.releaseSourceImport !== false) {
          void releasePickedMaterialImport(input.sourcePath).catch((error) => {
            console.warn('[material] failed to release committed picker import:', error);
          });
        }
      }
      return persisted;
    } catch (error) {
      if (localAsset) {
        await assetStoreService.deleteAsset(projectId, localAsset.id).catch((cleanupError) => {
          console.warn('[material] failed to clean an uncommitted local asset:', cleanupError);
        });
      }
      throw error;
    }
  };

  const updateLibraryItem = async (id: string, updates: UpdateLibraryItemUsecaseInput) => {
    await ensureDb();
    const items = getItems();
    const existing = items.find((item) => item.id === id);
    if (!existing) throw new Error(`Library item with id ${id} not found`);
    if (updates.bodyJson !== undefined) {
      // A note's body is its Yjs document; body_json is only its projection.
      throw new Error('Note bodies are edited through their document (projectNoteBody)');
    }

    const normalizedUpdates = updates;
    const updated = {
      ...existing,
      ...normalizedUpdates,
      updatedAt: new Date().toISOString(),
    } as LibraryItem;
    return withOptimisticUpdate({
      apply: () => setItems(items.map((item) => (item.id === id ? updated : item))),
      rollback: () => setItems(items),
      effect: () =>
        withAtomicSyncTransaction(projectId, async (tx, sync, changes) => {
          const persisted = await createLibraryItemSqliteRepository(projectId, tx).update(id, {
            ...normalizedUpdates,
            updatedAt: updated.updatedAt,
          });
          if (!persisted) throw new Error(`Library item with id ${id} not found`);
          const syncPayload: Record<string, unknown> = { ...normalizedUpdates };
          delete syncPayload.orderKey;
          if (Object.keys(syncPayload).length > 0) {
            await sync('libraryItem', 'update', id, projectId, syncPayload);
          }
          if (typeof updates.orderKey === 'number') {
            const desiredEntityIds = entityIdsByNumericPlacement(
              items.map((entry) => ({
                entityId: entry.id,
                projection: entry.id === id ? updates.orderKey! : entry.orderKey,
              })),
            );
            await appendPlannedAuthoredOrderInTransaction(tx, changes, {
              projectId,
              listKind: 'library-item',
              scope: projectId,
              desiredEntityIds,
            });
          }
          return persisted;
        }),
      onSuccess: (persisted) => {
        setItems(getItems().map((item) => (item.id === id ? persisted : item)));
      },
    });
  };

  /**
   * Writes a note's live document into body_json. The projection is a local
   * cache for lists, search and export; it is never journaled, because the
   * document already syncs as Yjs updates.
   */
  const projectNoteBody = async (id: string, bodyJson: string) => {
    await ensureDb();
    const items = getItems();
    const existing = items.find((item) => item.id === id);
    if (!existing || existing.kind !== 'text' || existing.bodyJson === bodyJson) return;
    const updated: LibraryItem = { ...existing, bodyJson, updatedAt: new Date().toISOString() };
    await withOptimisticUpdate({
      apply: () => setItems(items.map((item) => (item.id === id ? updated : item))),
      rollback: () => setItems(items),
      effect: () =>
        runDerivedTransaction('prose.library-item-projection', async (tx) => {
          const persisted = await createLibraryItemSqliteRepository(projectId, tx).update(id, {
            bodyJson,
            updatedAt: updated.updatedAt,
          });
          if (!persisted) throw new Error(`Library item with id ${id} not found`);
          return persisted;
        }),
      onSuccess: (persisted) => {
        setItems(getItems().map((item) => (item.id === id ? persisted : item)));
      },
    });
  };

  const removeLibraryItem = async (id: string) => {
    await ensureDb();
    const items = getItems();
    const existing = items.find((item) => item.id === id);
    if (!existing) throw new Error(`Library item with id ${id} not found`);
    // Drop tabs before the store loses the row, so no leaf renders an
    // untitled placeholder for a material that is being deleted.
    useUiStore.getState().closeTabsForEntity(projectId, { entityType: 'library_item', id });
    const relations = useDataStore.getState().entityRelations;
    const remainingRelations = withoutRelationsForEntity(
      relations,
      projectId,
      'library_item',
      id,
    );
    const comments = useDataStore.getState().comments;

    await withOptimisticUpdate({
      apply: () => {
        setItems(items.filter((item) => item.id !== id));
        useDataStore.getState().setEntityRelations(remainingRelations);
        useDataStore.getState().setComments(
          comments.filter((comment) => !(comment.targetKind === 'library_item' && comment.targetId === id)),
        );
      },
      rollback: () => {
        setItems(items);
        useDataStore.getState().setEntityRelations(relations);
        useDataStore.getState().setComments(comments);
      },
      effect: () =>
        withAtomicSyncTransaction(projectId, (tx, sync, changes) =>
          deleteLibraryItemInTransaction(tx, sync, changes, projectId, existing),
        ),
      onSuccess: ({ relationIds }) => {
        if (relationIds.length === 0) return;
        const deletedIds = new Set(relationIds);
        useDataStore
          .getState()
          .setEntityRelations(
            useDataStore
              .getState()
              .entityRelations.filter((relation) => !deletedIds.has(relation.id)),
          );
      },
    });
    if (existing.kind === 'image' || existing.kind === 'pdf') {
      useDataStore.getState().removeProjectAsset(existing.assetId);
      try {
        await assetStoreService.deleteAsset(projectId, existing.assetId);
      } catch (error) {
        // SQLite deletion already committed. Do not pretend the owner still
        // exists or invite a destructive retry; surface the orphan boundary.
        console.warn('[material] owner deleted but local asset cleanup failed:', error);
      }
    }
    return true;
  };

  return { loadInitial, createLibraryItem, updateLibraryItem, projectNoteBody, removeLibraryItem };
}

export type LibraryItemUsecases = ReturnType<typeof createLibraryItemUsecases>;

export function useLibraryItem({ projectId, userId }: UseLibraryItemContext): LibraryItemUsecases {
  return useMemo(() => createLibraryItemUsecases({ projectId, userId }), [projectId, userId]);
}
