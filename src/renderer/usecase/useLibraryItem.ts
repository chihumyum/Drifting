import { useCallback, useMemo } from 'react';
import { v7 as uuidv7 } from 'uuid';
import { useDataStore } from '../store/data-store';
import type { LibraryItem, LibraryItemKind, LibraryItemSource } from '../domain/library-item';
import { createLibraryItemSqliteRepository } from '../sqlite-repo/library-item-repo';
import { initDatabase } from '../lib/db';
import { withOptimisticUpdate } from './optimistic';
import {
  syncLibraryItemCreate,
  syncLibraryItemUpdate,
  syncLibraryItemDelete,
} from './sync-helpers';

export interface CreateLibraryItemInput {
  title?: string;
  kind: LibraryItemKind;
  source: LibraryItemSource;
  uri: string;
  localPath?: string | null;
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
    const items = await repo.findAll();
    setItems(items);
  }, [repo, setItems, ensureDb]);

  const createLibraryItem = useCallback(
    async (input: CreateLibraryItemInput) => {
      await ensureDb();
      const prev = getItems().slice();
      const now = new Date().toISOString();
      const newItem: LibraryItem = {
        id: uuidv7(),
        projectId,
        title: input.title?.trim() ?? '',
        kind: input.kind,
        source: input.source,
        uri: input.uri,
        localPath: input.localPath ?? null,
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
        apply: () => setItems([newItem, ...prev]),
        rollback: () => setItems(prev),
        effect: () => repo.create(newItem),
        onSuccess: (persisted) => {
          const current = getItems();
          setItems(current.map((m) => (m.id === persisted.id ? persisted : m)));
        },
        sync: (persisted) =>
          syncLibraryItemCreate(persisted.id, projectId, {
            id: persisted.id,
            title: persisted.title,
            kind: persisted.kind,
            source: persisted.source,
            uri: persisted.uri,
            localPath: persisted.localPath,
            mime: persisted.mime,
            sizeBytes: persisted.sizeBytes,
            bodyJson: persisted.bodyJson,
            notesJson: persisted.notesJson,
            thumbnailUri: persisted.thumbnailUri,
            orderKey: persisted.orderKey,
          }),
      });
    },
    [repo, getItems, setItems, ensureDb, projectId],
  );

  const updateLibraryItem = useCallback(
    async (id: string, updates: UpdateLibraryItemUsecaseInput) => {
      await ensureDb();
      const now = new Date().toISOString();
      const items = getItems();
      const existing = items.find((m) => m.id === id);
      if (!existing) throw new Error(`Library item with id ${id} not found`);

      const updated: LibraryItem = { ...existing, ...updates, updatedAt: now };
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
        sync: (persisted) =>
          syncLibraryItemUpdate(id, projectId, {
            title: persisted.title,
            kind: persisted.kind,
            source: persisted.source,
            uri: persisted.uri,
            localPath: persisted.localPath,
            mime: persisted.mime,
            sizeBytes: persisted.sizeBytes,
            bodyJson: persisted.bodyJson,
            notesJson: persisted.notesJson,
            thumbnailUri: persisted.thumbnailUri,
            orderKey: persisted.orderKey,
          }),
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
      return withOptimisticUpdate({
        apply: () => setItems(filtered),
        rollback: () => setItems(items),
        effect: () => repo.delete(id),
        sync: () => syncLibraryItemDelete(id, projectId),
      });
    },
    [repo, getItems, setItems, ensureDb, projectId],
  );

  return useMemo(
    () => ({ loadInitial, createLibraryItem, updateLibraryItem, removeLibraryItem }),
    [loadInitial, createLibraryItem, updateLibraryItem, removeLibraryItem],
  );
}
