import { useCallback, useMemo } from 'react';
import { v7 as uuidv7 } from 'uuid';
import type { LibraryItem, LibraryItemPatch } from '../domain/library-item';
import { initDatabase } from '../lib/db';
import { assetStoreService } from '../services/asset-store.service';
import {
  prepareLocalProjectAsset,
  releasePickedMaterialImport,
} from '../services/local-project-asset.service';
import { createLibraryItemSqliteRepository } from '../sqlite-repo/library-item-repo';
import { createProjectAssetSqliteRepository } from '../sqlite-repo/project-asset-repo';
import { useDataStore } from '../store/data-store';
import { withoutRelationsForEntity } from './entity-relation-cleanup';
import { deleteLibraryItemInTransaction } from './library-item-deletion';
import { withOptimisticUpdate } from './optimistic';
import { withAtomicSyncTransaction } from './sync-helpers';
import {
  appendPlannedAuthoredOrderInTransaction,
  appendProjectAssetBindMutation,
} from '../sync/journal';
import { entityIdsByNumericPlacement } from '../sync/journal/order-authority';

type CreateLibraryItemCommon = {
  title?: string;
  notesJson?: string | null;
};

export type CreateLibraryItemInput = CreateLibraryItemCommon &
  (
    | { kind: 'image' | 'pdf'; sourcePath: string }
    | { kind: 'url'; externalUrl: string; previewImageUrl?: string | null }
    | { kind: 'text'; bodyJson?: string | null }
  );

export type UpdateLibraryItemUsecaseInput = Omit<LibraryItemPatch, 'updatedAt'>;

export interface UseLibraryItemContext {
  projectId: string;
  userId: string;
}

function libraryMutationPayload(item: LibraryItem): Record<string, unknown> {
  return {
    id: item.id,
    title: item.title,
    kind: item.kind,
    assetId: item.assetId,
    externalUrl: item.externalUrl,
    bodyJson: item.bodyJson,
    notesJson: item.notesJson,
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

export function useLibraryItem({ projectId, userId }: UseLibraryItemContext) {
  if (!projectId) throw new Error('useLibraryItem requires a projectId');
  if (!userId) throw new Error('useLibraryItem requires a userId');

  const repo = useMemo(() => createLibraryItemSqliteRepository(projectId), [projectId]);
  const ensureDb = useCallback(async () => {
    await initDatabase(userId);
  }, [userId]);
  const getItems = useCallback(() => useDataStore.getState().libraryItems, []);
  const setItems = useCallback(
    (items: LibraryItem[]) => useDataStore.getState().setLibraryItems(items),
    [],
  );

  const loadInitial = useCallback(async () => {
    await ensureDb();
    setItems(await repo.findAll());
  }, [ensureDb, repo, setItems]);

  const createLibraryItem = useCallback(
    async (input: CreateLibraryItemInput) => {
      await ensureDb();
      const previous = getItems().slice();
      const itemId = uuidv7();
      const now = new Date().toISOString();
      const orderKey = prependedLibraryOrder(previous);
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
        orderKey,
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
      } else if (input.kind === 'url') {
        newItem = {
          ...common,
          kind: 'url',
          assetId: null,
          externalUrl: input.externalUrl,
          previewImageUrl: input.previewImageUrl ?? null,
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
          void releasePickedMaterialImport(input.sourcePath).catch((error) => {
            console.warn('[material] failed to release committed picker import:', error);
          });
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
    },
    [ensureDb, getItems, projectId, setItems],
  );

  const updateLibraryItem = useCallback(
    async (id: string, updates: UpdateLibraryItemUsecaseInput) => {
      await ensureDb();
      const items = getItems();
      const existing = items.find((item) => item.id === id);
      if (!existing) throw new Error(`Library item with id ${id} not found`);
      if (updates.bodyJson !== undefined && existing.kind !== 'text') {
        throw new Error('Only text library items can update bodyJson');
      }
      if (updates.previewImageUrl !== undefined && existing.kind !== 'url') {
        throw new Error('Only URL library items can update previewImageUrl');
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
    },
    [ensureDb, getItems, projectId, setItems],
  );

  const removeLibraryItem = useCallback(
    async (id: string) => {
      await ensureDb();
      const items = getItems();
      const existing = items.find((item) => item.id === id);
      if (!existing) throw new Error(`Library item with id ${id} not found`);
      const relations = useDataStore.getState().entityRelations;
      const remainingRelations = withoutRelationsForEntity(
        relations,
        projectId,
        'library_item',
        id,
      );

      await withOptimisticUpdate({
        apply: () => {
          setItems(items.filter((item) => item.id !== id));
          useDataStore.getState().setEntityRelations(remainingRelations);
        },
        rollback: () => {
          setItems(items);
          useDataStore.getState().setEntityRelations(relations);
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
    },
    [ensureDb, getItems, projectId, setItems],
  );

  return useMemo(
    () => ({ loadInitial, createLibraryItem, updateLibraryItem, removeLibraryItem }),
    [createLibraryItem, loadInitial, removeLibraryItem, updateLibraryItem],
  );
}
