import { useCallback, useMemo } from 'react';
import { v7 as uuidv7 } from 'uuid';
import { useDataStore } from '../store/data-store';
import type { BookElement } from '../domain/book-element';
import { createBookElementSqliteRepository } from '../sqlite-repo/element-repo';
import { initDatabase } from '../lib/db';
import { withOptimisticUpdate } from './optimistic';
import { syncElementCreate, syncElementUpdate, syncElementDelete } from './sync-helpers';

export interface CreateBookElementInput {
  categoryId: string;
  // Optional initial name; when omitted the element is created as "New Element"
  // and renamed by the user via the editor.
  name?: string;
}
export type UpdateElementUsecaseInput = Partial<
  Omit<BookElement, 'id' | 'updatedAt' | 'projectId' | 'createdAt'>
>;

export interface UseBookElementContext {
  projectId: string;
  userId: string;
}

export function useBookElement({ projectId, userId }: UseBookElementContext) {
  if (!projectId) {
    throw new Error('useBookElement requires a projectId');
  }
  if (!userId) {
    throw new Error('useBookElement requires a userId');
  }
  const activeProjectId = projectId;

  const elementRepo = useMemo(
    () => createBookElementSqliteRepository(activeProjectId),
    [activeProjectId],
  );
  const ensureDb = useCallback(async () => {
    await initDatabase(userId);
  }, [userId]);

  const getElements = useCallback(() => useDataStore.getState().bookElements, []);
  const setElements = useCallback(
    (els: BookElement[]) => useDataStore.getState().setBookElements(els),
    [],
  );

  const loadInitial = useCallback(
    async (projectId?: string) => {
      if (projectId && projectId !== activeProjectId) {
        throw new Error('Cannot load elements for different projectId');
      }
      await ensureDb();
      const elements = await elementRepo.findAll();
      setElements(elements);
    },
    [elementRepo, setElements, activeProjectId, ensureDb],
  );

  const createElement = useCallback(
    async (input: CreateBookElementInput) => {
      await ensureDb();
      const prev = getElements().slice();
      const now = new Date().toISOString();
      // Seed the new element with its category's template doc. Empty template
      // ('{}') leaves the element blank — the TipTap loader treats that as
      // an empty doc. Only applies at creation; changing category later
      // does not re-apply the template (per scope decision).
      const category = useDataStore
        .getState()
        .bookElementCategories.find((c) => c.id === input.categoryId);
      const seededContentJson = category?.elementTemplateJson?.trim() || '{}';
      const newElement: BookElement = {
        id: uuidv7(),
        projectId: activeProjectId,
        categoryId: input.categoryId,
        name: input.name?.trim() || 'New Element',
        summary: '',
        contentJson: seededContentJson,
        createdAt: now,
        updatedAt: now,
      };

      return withOptimisticUpdate({
        apply: () => setElements([newElement, ...prev]),
        rollback: () => setElements(prev),
        effect: () => elementRepo.create(newElement),
        onSuccess: (persisted) => {
          const current = getElements();
          const updated = current.map((el) => (el.id === persisted.id ? persisted : el));
          setElements(updated);
        },
        sync: (persisted) =>
          syncElementCreate(persisted.id, activeProjectId, {
            id: persisted.id,
            categoryId: persisted.categoryId,
            name: persisted.name,
            summary: persisted.summary,
            contentJson: persisted.contentJson,
          }),
      });
    },
    [elementRepo, getElements, setElements, ensureDb, activeProjectId],
  );

  const updateElement = useCallback(
    async (id: string, updates: UpdateElementUsecaseInput) => {
      await ensureDb();
      const now = new Date();
      const elements = getElements();
      const existing = elements.find((e) => e.id === id);
      if (!existing) {
        throw new Error(`Element with id ${id} not found`);
      }

      const updatedElement: BookElement = {
        ...existing,
        categoryId: updates.categoryId ?? existing.categoryId,
        name: updates.name ?? existing.name,
        contentJson: updates.contentJson ?? existing.contentJson,
        summary: updates.summary ?? existing.summary,
        updatedAt: now.toISOString(),
      };

      return withOptimisticUpdate({
        apply: () => setElements(elements.map((el) => (el.id === id ? updatedElement : el))),
        rollback: () => setElements(elements),
        effect: async () => {
          const persisted = await elementRepo.update(id, {
            categoryId: updatedElement.categoryId,
            name: updatedElement.name,
            summary: updatedElement.summary,
            contentJson: updatedElement.contentJson,
            updatedAt: updatedElement.updatedAt,
          });
          if (!persisted) {
            throw new Error(`Element with id ${id} not found`);
          }
          return persisted;
        },
        onSuccess: (persisted) => {
          const current = getElements();
          setElements(current.map((el) => (el.id === id ? persisted : el)));
        },
        sync: (persisted) =>
          syncElementUpdate(id, activeProjectId, {
            categoryId: persisted.categoryId,
            name: persisted.name,
            summary: persisted.summary,
            contentJson: persisted.contentJson,
          }),
      });
    },
    [elementRepo, getElements, setElements, ensureDb, activeProjectId],
  );

  const removeElement = useCallback(
    async (id: string) => {
      await ensureDb();
      const elements = getElements();
      const existing = elements.find((e) => e.id === id);
      if (!existing) throw new Error(`Element with id ${id} not found`);

      const filtered = elements.filter((e) => e.id !== id);
      return withOptimisticUpdate({
        apply: () => setElements(filtered),
        rollback: () => setElements(elements),
        effect: () => elementRepo.delete(id),
        sync: () => syncElementDelete(id, activeProjectId),
      });
    },
    [elementRepo, getElements, setElements, ensureDb, activeProjectId],
  );

  return useMemo(
    () => ({
      loadInitial,
      createElement,
      updateElement,
      removeElement,
    }),
    [loadInitial, createElement, updateElement, removeElement],
  );
}
