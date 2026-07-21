import { useCallback, useMemo } from 'react';
import { v7 as uuidv7 } from 'uuid';
import { useDataStore } from '../store/data-store';
import type { LibraryItem, LibraryItemKind, LibraryItemSource } from '../domain/library-item';
import { createLibraryItemSqliteRepository } from '../sqlite-repo/library-item-repo';
import { createProjectAssetSqliteRepository } from '../sqlite-repo/project-asset-repo';
import { projectAssetService } from '../services/project-asset.service';
import { assetCacheService } from '../services/asset-cache.service';
import { initDatabase } from '../lib/db';
import { withOptimisticUpdate } from './optimistic';
import { withAtomicSyncTransaction } from './sync-helpers';
import {
  libraryItemServerPayload,
  libraryItemUploadPlaceholderPayload,
} from '../services/library-item-sync-boundary';
import {
  cancelAssetUploadForOwner,
  hydrateAssetUploadStates,
  insertAssetUploadJobInTransaction,
  makeLibraryMaterialUploadJob,
  retryAssetUploadForOwner,
  startAssetUploadJob,
} from '../services/durable-asset-upload.service';

export interface CreateLibraryItemInput {
  title?: string;
  kind: LibraryItemKind;
  source: LibraryItemSource;
  uri: string;
  localPath?: string | null;
  assetId?: string | null;
  mime?: string | null;
  sizeBytes?: number | null;
  bodyJson?: string | null;
  notesJson?: string | null;
  thumbnailUri?: string | null;
}

export type UpdateLibraryItemUsecaseInput = Partial<
  Omit<LibraryItem, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>
>;

export interface UseLibraryItemContext {
  projectId: string;
  userId: string;
}

function shouldUploadLibraryMaterial(input: CreateLibraryItemInput): boolean {
  return (
    input.source === 'local' &&
    !!input.localPath &&
    (input.kind === 'image' || input.kind === 'pdf')
  );
}

export function useLibraryItem({ projectId, userId }: UseLibraryItemContext) {
  if (!projectId) throw new Error('useLibraryItem requires a projectId');
  if (!userId) throw new Error('useLibraryItem requires a userId');

  const repo = useMemo(() => createLibraryItemSqliteRepository(projectId), [projectId]);
  const assetRepo = useMemo(() => createProjectAssetSqliteRepository(projectId), [projectId]);
  const ensureDb = useCallback(async () => {
    await initDatabase(userId);
  }, [userId]);

  const getItems = useCallback(() => useDataStore.getState().libraryItems, []);
  const setItems = useCallback(
    (items: LibraryItem[]) => useDataStore.getState().setLibraryItems(items),
    [],
  );

  const removeLocalAsset = useCallback(
    async (assetId: string) => {
      await ensureDb();
      await assetRepo.delete(assetId);
      useDataStore.getState().removeProjectAsset(assetId);
    },
    [assetRepo, ensureDb],
  );

  const loadInitial = useCallback(async () => {
    await ensureDb();
    const [items] = await Promise.all([repo.findAll(), hydrateAssetUploadStates(projectId)]);
    setItems(items);
  }, [repo, setItems, ensureDb, projectId]);

  const createLibraryItem = useCallback(
    async (input: CreateLibraryItemInput) => {
      await ensureDb();
      const itemId = uuidv7();
      const uploadToR2 = shouldUploadLibraryMaterial(input);
      const prev = getItems().slice();
      const now = new Date().toISOString();
      const newItem: LibraryItem = {
        id: itemId,
        projectId,
        title: input.title?.trim() ?? '',
        kind: input.kind,
        source: input.source,
        uri: input.uri,
        localPath: input.localPath ?? null,
        assetId: input.assetId ?? null,
        mime: input.mime ?? null,
        sizeBytes: input.sizeBytes ?? null,
        bodyJson: input.bodyJson ?? null,
        notesJson: input.notesJson ?? null,
        thumbnailUri: input.thumbnailUri ?? null,
        orderKey: 0,
        createdAt: now,
        updatedAt: now,
      };

      const result = await withOptimisticUpdate({
        apply: () => {
          setItems([newItem, ...prev]);
          if (uploadToR2) {
            useDataStore.getState().setLibraryItemUploadState(newItem.id, { state: 'uploading' });
          }
        },
        rollback: () => {
          setItems(prev);
          if (uploadToR2) {
            useDataStore.getState().clearLibraryItemUploadState(newItem.id);
          }
        },
        effect: () =>
          withAtomicSyncTransaction(projectId, async (tx, sync) => {
            const persisted = await createLibraryItemSqliteRepository(projectId, tx).create(
              newItem,
            );
            const job =
              uploadToR2 && input.localPath && (input.kind === 'image' || input.kind === 'pdf')
                ? await insertAssetUploadJobInTransaction(
                    tx,
                    makeLibraryMaterialUploadJob({
                      projectId,
                      libraryItemId: persisted.id,
                      kind: input.kind,
                      sourcePath: input.localPath,
                      sourceSizeBytes: input.sizeBytes,
                    }),
                  )
                : null;
            await sync(
              'libraryItem',
              'create',
              persisted.id,
              projectId,
              job
                ? libraryItemUploadPlaceholderPayload(persisted)
                : libraryItemServerPayload(persisted),
            );
            return { item: persisted, job };
          }),
        onSuccess: ({ item: persisted, job }) => {
          const current = getItems();
          setItems(current.map((m) => (m.id === persisted.id ? persisted : m)));
          if (job) startAssetUploadJob(job);
        },
      });
      return result.item;
    },
    [getItems, setItems, ensureDb, projectId],
  );

  const updateLibraryItem = useCallback(
    async (id: string, updates: UpdateLibraryItemUsecaseInput) => {
      await ensureDb();
      const now = new Date().toISOString();
      const items = getItems();
      const existing = items.find((m) => m.id === id);
      if (!existing) throw new Error(`Library item with id ${id} not found`);

      const updated: LibraryItem = { ...existing, ...updates, updatedAt: now };
      const uploadState = useDataStore.getState().libraryItemUploadStates[id] ?? null;
      return withOptimisticUpdate({
        apply: () => setItems(items.map((m) => (m.id === id ? updated : m))),
        rollback: () => setItems(items),
        effect: async () => {
          return withAtomicSyncTransaction(projectId, async (tx, sync) => {
            const persisted = await createLibraryItemSqliteRepository(projectId, tx).update(id, {
              title: updated.title,
              kind: updated.kind,
              source: updated.source,
              uri: updated.uri,
              localPath: updated.localPath,
              assetId: updated.assetId,
              mime: updated.mime,
              sizeBytes: updated.sizeBytes,
              bodyJson: updated.bodyJson,
              notesJson: updated.notesJson,
              thumbnailUri: updated.thumbnailUri,
              orderKey: updated.orderKey,
              updatedAt: updated.updatedAt,
            });
            if (!persisted) throw new Error(`Library item with id ${id} not found`);
            if (!uploadState) {
              await sync(
                'libraryItem',
                'update',
                id,
                projectId,
                libraryItemServerPayload(persisted),
              );
            }
            return persisted;
          });
        },
        onSuccess: (persisted) => {
          const current = getItems();
          setItems(current.map((m) => (m.id === id ? persisted : m)));
        },
      });
    },
    [getItems, setItems, ensureDb, projectId],
  );

  const removeLibraryItem = useCallback(
    async (id: string) => {
      await ensureDb();
      const items = getItems();
      const existing = items.find((m) => m.id === id);
      if (!existing) throw new Error(`Library item with id ${id} not found`);

      const filtered = items.filter((m) => m.id !== id);
      const previousUploadState = useDataStore.getState().libraryItemUploadStates[id] ?? null;
      const result = await withOptimisticUpdate({
        apply: () => {
          setItems(filtered);
          if (previousUploadState) {
            useDataStore.getState().clearLibraryItemUploadState(id);
          }
        },
        rollback: () => {
          setItems(items);
          if (previousUploadState) {
            useDataStore.getState().setLibraryItemUploadState(id, previousUploadState);
          }
        },
        effect: () =>
          withAtomicSyncTransaction(projectId, async (tx, sync) => {
            const canceledJob = await cancelAssetUploadForOwner(
              projectId,
              'library_item',
              id,
              tx,
              { deletePreviousAsset: true },
            );
            const deleted = await createLibraryItemSqliteRepository(projectId, tx).delete(id);
            // DELETE is idempotent server-side. Keep it even when the placeholder
            // create may still be in flight: a lost create response could mean
            // the row already exists remotely.
            await sync('libraryItem', 'delete', id, projectId);
            return { deleted, canceledJob };
          }),
      });
      if (result.canceledJob) startAssetUploadJob(result.canceledJob);
      if (existing.source === 'r2' && existing.assetId) {
        const assetId = existing.assetId;
        void projectAssetService.deleteAsset(projectId, assetId).catch(() => undefined);
        void assetCacheService.deleteAsset(projectId, assetId).catch(() => undefined);
        void removeLocalAsset(assetId).catch(() => undefined);
      }
      return result.deleted;
    },
    [getItems, setItems, ensureDb, projectId, removeLocalAsset],
  );

  const retryLibraryItemUpload = useCallback(
    async (id: string) => {
      await ensureDb();
      await retryAssetUploadForOwner(projectId, 'library_item', id);
    },
    [ensureDb, projectId],
  );

  return useMemo(
    () => ({
      loadInitial,
      createLibraryItem,
      updateLibraryItem,
      removeLibraryItem,
      retryLibraryItemUpload,
    }),
    [loadInitial, createLibraryItem, updateLibraryItem, removeLibraryItem, retryLibraryItemUpload],
  );
}
