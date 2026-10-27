/**
 * Material folders usecase — the material panel's nested folders.
 *
 * Mirrors useDriftGroup: every mutation is a repo → sync → store triple in one
 * atomic transaction (cheap scalar writes, no optimistic rollback). What this
 * hook owns:
 *
 * - moveFolder refuses a move into the folder's own subtree.
 * - deleteFolder moves the folder's direct sub-folders and materials up to
 *   its parent (the root for a top-level folder) before removing the row, so
 *   deleting a folder never deletes what it holds.
 * - moveMaterialsToFolder files any number of materials in one transaction.
 */
import { useMemo } from 'react';
import { v7 as uuidv7 } from 'uuid';

import { useDataStore } from '../store/data-store';
import { createMaterialFolderRepository } from '../sqlite-repo/material-folder-repo';
import { createLibraryItemSqliteRepository } from '../sqlite-repo/library-item-repo';
import { isDescendantFolder, type MaterialFolder } from '../domain/material-folder';
import { withAtomicSyncTransaction } from './sync-helpers';

export interface CreateMaterialFolderInput {
  name: string;
  parentFolderId?: string | null;
}

export function createMaterialFolderUsecases(projectId: string) {
  const folders = () => useDataStore.getState().materialFolders;
  const setFolders = (next: MaterialFolder[]) => useDataStore.getState().setMaterialFolders(next);

  const createFolder = async ({ name, parentFolderId = null }: CreateMaterialFolderInput): Promise<MaterialFolder> => {
    const now = new Date().toISOString();
    const folder: MaterialFolder = {
      id: uuidv7(),
      projectId,
      name: name.trim(),
      parentFolderId,
      createdAt: now,
      updatedAt: now,
    };
    if (!folder.name) throw new Error('A material folder needs a name');
    await withAtomicSyncTransaction(projectId, async (tx, sync) => {
      await createMaterialFolderRepository(projectId, tx).create(folder);
      await sync('materialFolder', 'create', folder.id, projectId, {
        id: folder.id,
        name: folder.name,
        parentFolderId: folder.parentFolderId,
        createdAt: folder.createdAt,
        updatedAt: folder.updatedAt,
      });
    });
    setFolders([...folders(), folder]);
    return folder;
  };

  const updateFolder = async (
    id: string,
    patch: { name?: string; parentFolderId?: string | null },
  ): Promise<MaterialFolder | null> => {
    const updatedAt = new Date().toISOString();
    const updated = await withAtomicSyncTransaction(projectId, async (tx, sync) => {
      const result = await createMaterialFolderRepository(projectId, tx).update(id, { ...patch, updatedAt });
      if (result) await sync('materialFolder', 'update', id, projectId, { ...patch, updatedAt });
      return result;
    });
    if (updated) setFolders(folders().map((folder) => (folder.id === id ? updated : folder)));
    return updated;
  };

  const renameFolder = async (id: string, name: string) => {
    const trimmed = name.trim();
    const existing = folders().find((folder) => folder.id === id);
    if (!existing || !trimmed || trimmed === existing.name) return existing ?? null;
    return updateFolder(id, { name: trimmed });
  };

  /** Moves a folder under another (null = root). False when it would loop. */
  const moveFolder = async (id: string, parentFolderId: string | null): Promise<boolean> => {
    const existing = folders().find((folder) => folder.id === id);
    if (!existing || existing.parentFolderId === parentFolderId) return false;
    if (parentFolderId !== null && isDescendantFolder(folders(), parentFolderId, id)) return false;
    await updateFolder(id, { parentFolderId });
    return true;
  };

  const deleteFolder = async (id: string): Promise<void> => {
    const store = useDataStore.getState();
    const target = store.materialFolders.find((folder) => folder.id === id);
    if (!target) return;
    const parent = target.parentFolderId;
    const now = new Date().toISOString();
    const childFolders = store.materialFolders.filter((folder) => folder.parentFolderId === id);
    const members = store.libraryItems.filter((item) => item.folderId === id);
    await withAtomicSyncTransaction(projectId, async (tx, sync) => {
      const folderRepo = createMaterialFolderRepository(projectId, tx);
      const itemRepo = createLibraryItemSqliteRepository(projectId, tx);
      for (const child of childFolders) {
        await folderRepo.update(child.id, { parentFolderId: parent, updatedAt: now });
        await sync('materialFolder', 'update', child.id, projectId, { parentFolderId: parent, updatedAt: now });
      }
      for (const item of members) {
        await itemRepo.update(item.id, { folderId: parent, updatedAt: now });
        await sync('libraryItem', 'update', item.id, projectId, { folderId: parent, updatedAt: now });
      }
      await folderRepo.delete(id);
      await sync('materialFolder', 'delete', id, projectId);
    });
    const childIds = new Set(childFolders.map((folder) => folder.id));
    const memberIds = new Set(members.map((item) => item.id));
    const state = useDataStore.getState();
    state.setMaterialFolders(
      state.materialFolders
        .filter((folder) => folder.id !== id)
        .map((folder) => (childIds.has(folder.id) ? { ...folder, parentFolderId: parent, updatedAt: now } : folder)),
    );
    state.setLibraryItems(
      state.libraryItems.map((item) => (memberIds.has(item.id) ? { ...item, folderId: parent, updatedAt: now } : item)),
    );
  };

  const moveMaterialsToFolder = async (libraryItemIds: readonly string[], folderId: string | null): Promise<void> => {
    const moving = useDataStore
      .getState()
      .libraryItems.filter((item) => libraryItemIds.includes(item.id) && item.folderId !== folderId);
    if (moving.length === 0) return;
    const now = new Date().toISOString();
    await withAtomicSyncTransaction(projectId, async (tx, sync) => {
      const itemRepo = createLibraryItemSqliteRepository(projectId, tx);
      for (const item of moving) {
        await itemRepo.update(item.id, { folderId, updatedAt: now });
        await sync('libraryItem', 'update', item.id, projectId, { folderId, updatedAt: now });
      }
    });
    const movedIds = new Set(moving.map((item) => item.id));
    const state = useDataStore.getState();
    state.setLibraryItems(
      state.libraryItems.map((item) => (movedIds.has(item.id) ? { ...item, folderId, updatedAt: now } : item)),
    );
  };

  return { createFolder, renameFolder, moveFolder, deleteFolder, moveMaterialsToFolder };
}

export type MaterialFolderUsecases = ReturnType<typeof createMaterialFolderUsecases>;

export function useMaterialFolder(projectId: string): MaterialFolderUsecases {
  return useMemo(() => createMaterialFolderUsecases(projectId), [projectId]);
}
