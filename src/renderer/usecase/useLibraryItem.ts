import { useCallback, useMemo } from 'react';
import { v7 as uuidv7 } from 'uuid';
import { useDataStore } from '../store/data-store';
import type { LibraryItem, LibraryItemKind, LibraryItemSource } from '../domain/library-item';
import { createLibraryItemSqliteRepository } from '../sqlite-repo/library-item-repo';
import { createProjectAssetSqliteRepository } from '../sqlite-repo/project-asset-repo';
import { projectAssetService } from '../services/project-asset.service';
import { assetCacheService, extForMime } from '../services/asset-cache.service';
import { initDatabase } from '../lib/db';
import { withOptimisticUpdate } from './optimistic';
import {
  syncLibraryItemCreate,
  syncLibraryItemUpdate,
  syncLibraryItemDelete,
  syncEntityRelationCreate,
} from './sync-helpers';

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

function libraryItemSyncPayload(item: LibraryItem): Record<string, unknown> {
  return {
    id: item.id,
    title: item.title,
    kind: item.kind,
    source: item.source,
    uri: item.uri,
    localPath: item.localPath,
    assetId: item.assetId,
    mime: item.mime,
    sizeBytes: item.sizeBytes,
    bodyJson: item.bodyJson,
    notesJson: item.notesJson,
    thumbnailUri: item.thumbnailUri,
    orderKey: item.orderKey,
  };
}

function uploadErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

  const upsertLocalAsset = useCallback(
    async (asset: Awaited<ReturnType<typeof projectAssetService.completeUpload>>) => {
      await ensureDb();
      const persisted = await assetRepo.upsert(asset);
      useDataStore.getState().upsertProjectAsset(persisted);
      return persisted;
    },
    [assetRepo, ensureDb],
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
    const items = await repo.findAll();
    setItems(items);
  }, [repo, setItems, ensureDb]);

  const cleanupUploadedAsset = useCallback(
    (assetId: string) => {
      void Promise.allSettled([
        projectAssetService.deleteAsset(projectId, assetId),
        removeLocalAsset(assetId),
        assetCacheService.deleteAsset(projectId, assetId),
      ]);
    },
    [projectId, removeLocalAsset],
  );

  const syncLibraryItemRelations = useCallback(
    (libraryItemId: string) => {
      const relations = useDataStore
        .getState()
        .entityRelations.filter(
          (relation) =>
            relation.fromKind === 'library_item' && relation.fromId === libraryItemId,
        );
      relations.forEach((relation) => {
        syncEntityRelationCreate(relation.id, projectId, {
          id: relation.id,
          fromKind: relation.fromKind,
          fromId: relation.fromId,
          toKind: relation.toKind,
          toId: relation.toId,
          kind: relation.kind,
        });
      });
    },
    [projectId],
  );

  const uploadLibraryMaterialAsset = useCallback(
    async (initialItem: LibraryItem, input: CreateLibraryItemInput) => {
      if (!input.localPath || (input.kind !== 'image' && input.kind !== 'pdf')) return;

      const localPath = input.localPath;
      let createdAssetId: string | null = null;
      try {
        let readyAsset: Awaited<ReturnType<typeof projectAssetService.completeUpload>>;
        let mime: string;
        let sizeBytes: number | null;

        if (input.kind === 'image') {
          const [inspection, display, thumbnail] = await Promise.all([
            window.electronAPI.material.inspectImage(localPath),
            window.electronAPI.material.createImageVariant(localPath, 1600, 82),
            window.electronAPI.material.createImageVariant(localPath, 512, 72),
          ]);
          if (!inspection.ok) throw new Error(inspection.error);
          if (!display.ok) throw new Error(display.error);
          if (!thumbnail.ok) throw new Error(thumbnail.error);

          const upload = await projectAssetService.createLibraryMaterialUpload(projectId, {
            libraryItemId: initialItem.id,
            kind: 'image',
            sourceMime: inspection.mime,
            sourceSizeBytes: inspection.sizeBytes,
            displayMime: display.mime,
            displaySizeBytes: display.sizeBytes,
            thumbnailMime: thumbnail.mime,
            thumbnailSizeBytes: thumbnail.sizeBytes,
            width: inspection.width,
            height: inspection.height,
          });
          createdAssetId = upload.asset.id;
          await upsertLocalAsset(upload.asset);

          const sourceExt = extForMime(inspection.mime, 'png');
          await Promise.all([
            assetCacheService.copyFile(projectId, upload.asset.id, 'source', sourceExt, localPath),
            assetCacheService.writeBytes(projectId, upload.asset.id, 'display', 'jpg', display.bytes),
            assetCacheService.writeBytes(
              projectId,
              upload.asset.id,
              'thumbnail',
              'jpg',
              thumbnail.bytes,
            ),
          ]);

          await Promise.all([
            assetCacheService.uploadFile({
              url: upload.uploads.source.url,
              projectId,
              assetId: upload.asset.id,
              variant: 'source',
              ext: sourceExt,
              contentType: upload.uploads.source.contentType,
            }),
            upload.uploads.display
              ? assetCacheService.uploadFile({
                  url: upload.uploads.display.url,
                  projectId,
                  assetId: upload.asset.id,
                  variant: 'display',
                  ext: 'jpg',
                  contentType: upload.uploads.display.contentType,
                })
              : Promise.resolve(0),
            assetCacheService.uploadFile({
              url: upload.uploads.thumbnail.url,
              projectId,
              assetId: upload.asset.id,
              variant: 'thumbnail',
              ext: 'jpg',
              contentType: upload.uploads.thumbnail.contentType,
            }),
          ]);

          readyAsset = await projectAssetService.completeUpload(projectId, upload.asset.id);
          await upsertLocalAsset(readyAsset);
          mime = inspection.mime;
          sizeBytes = inspection.sizeBytes;
        } else {
          const sourceMime = 'application/pdf';
          let sourceSizeBytes = input.sizeBytes ?? null;
          if (sourceSizeBytes == null) {
            const sourceBytes = await window.electronAPI.material.readBytes(localPath);
            if (!sourceBytes.ok) throw new Error(sourceBytes.error);
            sourceSizeBytes = sourceBytes.bytes.byteLength;
          }

          const thumbnail = await window.electronAPI.material.createThumbnailVariant(
            localPath,
            512,
            72,
          );
          if (!thumbnail.ok) throw new Error(thumbnail.error);

          const upload = await projectAssetService.createLibraryMaterialUpload(projectId, {
            libraryItemId: initialItem.id,
            kind: 'pdf',
            sourceMime,
            sourceSizeBytes,
            displayMime: null,
            displaySizeBytes: null,
            thumbnailMime: thumbnail.mime,
            thumbnailSizeBytes: thumbnail.sizeBytes,
            width: null,
            height: null,
          });
          createdAssetId = upload.asset.id;
          await upsertLocalAsset(upload.asset);

          await Promise.all([
            assetCacheService.copyFile(projectId, upload.asset.id, 'source', 'pdf', localPath),
            assetCacheService.writeBytes(
              projectId,
              upload.asset.id,
              'thumbnail',
              'jpg',
              thumbnail.bytes,
            ),
          ]);

          await Promise.all([
            assetCacheService.uploadFile({
              url: upload.uploads.source.url,
              projectId,
              assetId: upload.asset.id,
              variant: 'source',
              ext: 'pdf',
              contentType: upload.uploads.source.contentType,
            }),
            assetCacheService.uploadFile({
              url: upload.uploads.thumbnail.url,
              projectId,
              assetId: upload.asset.id,
              variant: 'thumbnail',
              ext: 'jpg',
              contentType: upload.uploads.thumbnail.contentType,
            }),
          ]);

          readyAsset = await projectAssetService.completeUpload(projectId, upload.asset.id);
          await upsertLocalAsset(readyAsset);
          mime = sourceMime;
          sizeBytes = sourceSizeBytes;
        }

        const currentItem =
          getItems().find((item) => item.id === initialItem.id) ??
          (await repo.findById(initialItem.id));
        if (!currentItem) {
          cleanupUploadedAsset(readyAsset.id);
          useDataStore.getState().clearLibraryItemUploadState(initialItem.id);
          return;
        }

        const updatedAt = new Date().toISOString();
        const persisted = await repo.update(initialItem.id, {
          source: 'r2',
          uri: `asset://${readyAsset.id}`,
          localPath: null,
          assetId: readyAsset.id,
          mime,
          sizeBytes,
          thumbnailUri: null,
          updatedAt,
        });
        if (!persisted) {
          cleanupUploadedAsset(readyAsset.id);
          useDataStore.getState().clearLibraryItemUploadState(initialItem.id);
          return;
        }

        const latest = getItems();
        if (!latest.some((item) => item.id === initialItem.id)) {
          await repo.delete(initialItem.id).catch(() => undefined);
          cleanupUploadedAsset(readyAsset.id);
          useDataStore.getState().clearLibraryItemUploadState(initialItem.id);
          return;
        }

        setItems(latest.map((item) => (item.id === initialItem.id ? persisted : item)));
        useDataStore.getState().clearLibraryItemUploadState(initialItem.id);
        syncLibraryItemCreate(persisted.id, projectId, libraryItemSyncPayload(persisted));
        syncLibraryItemRelations(persisted.id);
      } catch (error) {
        if (createdAssetId) {
          cleanupUploadedAsset(createdAssetId);
        }
        if (getItems().some((item) => item.id === initialItem.id)) {
          useDataStore.getState().setLibraryItemUploadState(initialItem.id, {
            state: 'failed',
            error: uploadErrorMessage(error),
          });
        } else {
          useDataStore.getState().clearLibraryItemUploadState(initialItem.id);
        }
        console.warn('[material] async upload failed:', error);
      }
    },
    [
      repo,
      getItems,
      setItems,
      projectId,
      upsertLocalAsset,
      cleanupUploadedAsset,
      syncLibraryItemRelations,
    ],
  );

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

      return withOptimisticUpdate({
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
        effect: () => repo.create(newItem),
        onSuccess: (persisted) => {
          const current = getItems();
          setItems(current.map((m) => (m.id === persisted.id ? persisted : m)));
          if (uploadToR2) {
            void uploadLibraryMaterialAsset(persisted, input);
          }
        },
        sync: uploadToR2
          ? undefined
          : (persisted) =>
              syncLibraryItemCreate(persisted.id, projectId, libraryItemSyncPayload(persisted)),
      });
    },
    [repo, getItems, setItems, ensureDb, projectId, uploadLibraryMaterialAsset],
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
          const persisted = await repo.update(id, {
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
          return persisted;
        },
        onSuccess: (persisted) => {
          const current = getItems();
          setItems(current.map((m) => (m.id === id ? persisted : m)));
        },
        sync: uploadState
          ? undefined
          : (persisted) =>
              syncLibraryItemUpdate(id, projectId, libraryItemSyncPayload(persisted)),
      });
    },
    [repo, getItems, setItems, ensureDb, projectId],
  );

  const removeLibraryItem = useCallback(
    async (id: string) => {
      await ensureDb();
      const items = getItems();
      const existing = items.find((m) => m.id === id);
      if (!existing) throw new Error(`Library item with id ${id} not found`);

      const filtered = items.filter((m) => m.id !== id);
      const previousUploadState = useDataStore.getState().libraryItemUploadStates[id] ?? null;
      const shouldSyncDelete = !previousUploadState;
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
        effect: () => repo.delete(id),
        sync: shouldSyncDelete ? () => syncLibraryItemDelete(id, projectId) : undefined,
      });
      if (existing.source === 'r2' && existing.assetId) {
        const assetId = existing.assetId;
        void projectAssetService.deleteAsset(projectId, assetId).catch(() => undefined);
        void assetCacheService.deleteAsset(projectId, assetId).catch(() => undefined);
        void removeLocalAsset(assetId).catch(() => undefined);
      }
      return result;
    },
    [repo, getItems, setItems, ensureDb, projectId, removeLocalAsset],
  );

  return useMemo(
    () => ({ loadInitial, createLibraryItem, updateLibraryItem, removeLibraryItem }),
    [loadInitial, createLibraryItem, updateLibraryItem, removeLibraryItem],
  );
}
