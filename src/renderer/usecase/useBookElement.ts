import { useCallback, useMemo } from 'react';
import { v7 as uuidv7 } from 'uuid';
import { useDataStore } from '../store/data-store';
import { useUiStore } from '../store/ui-store';
import {
  ElementNameConflictError,
  encodeAliases,
  findElementNameConflict,
  makeUniqueElementName,
  type BookElement,
} from '../domain/book-element';
import { createBookElementSqliteRepository } from '../sqlite-repo/element-repo';
import { initDatabase } from '../lib/db';
import { withOptimisticUpdate } from './optimistic';
import {
  syncElementCreate,
  syncElementUpdate,
  syncElementDelete,
  syncElementSoftDelete,
  syncElementRestore,
} from './sync-helpers';
import { canUseFeature } from '../lib/feature-access';

export interface CreateBookElementInput {
  categoryId: string;
  // Optional initial name; when omitted the element is created as "New Element"
  // and renamed by the user via the editor.
  name?: string;
  /** Optional initial aliases. Each must be unique across the project. */
  aliases?: string[];
  /**
   * Optional initial summary text. Used by element-candidate accept to seed
   * the element page with the model's brief description. Empty / omitted
   * means the element starts with no summary (user fills in later).
   */
  summary?: string;
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
      // Same logic as the contentJson seed: pull the category's KV template
      // and stamp it onto the new element. Existing elements stay untouched
      // when the template later changes.
      const seededKvJson = category?.elementTemplateKvJson?.trim() || '[]';

      const explicitName = input.name?.trim();
      // No name supplied → this is the "+ element" placeholder path. Derive a
      // project-unique default ("New Element", "New Element 2", …) instead of
      // throwing, so the user can spin up several blank elements before
      // renaming them. An explicit name still goes through the uniqueness
      // check below and surfaces a conflict.
      const resolvedName = explicitName || makeUniqueElementName('New Element', prev, activeProjectId);
      const resolvedAliases = (input.aliases ?? [])
        .map((a) => a.trim())
        .filter((a) => a.length > 0);

      // Uniqueness check: name + every alias must not collide with any
      // existing element's name or aliases in this project. Throws
      // ElementNameConflictError so the caller can surface the offender
      // (CommentRail's CopilotSuggestionCard already shows error.message
      // inline; PatchTargetModal currently swallows — both will benefit).
      // The auto-derived placeholder is already conflict-free by construction;
      // this still guards the explicit-name and alias inputs.
      const conflict = findElementNameConflict(
        [resolvedName, ...resolvedAliases],
        prev,
        activeProjectId,
      );
      if (conflict) {
        throw new ElementNameConflictError(
          conflict.conflictingName,
          conflict.conflictingElement,
        );
      }

      const newElement: BookElement = {
        id: uuidv7(),
        projectId: activeProjectId,
        categoryId: input.categoryId,
        name: resolvedName,
        summary: input.summary?.trim() || '',
        contentJson: seededContentJson,
        kvJson: seededKvJson,
        aliases: resolvedAliases,
        groupName: null,
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
            kvJson: persisted.kvJson,
            aliasesJson: encodeAliases(persisted.aliases),
            groupName: persisted.groupName,
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

      const nextName = (updates.name ?? existing.name).trim() || existing.name;
      const nextAliases = updates.aliases
        ? updates.aliases.map((a) => a.trim()).filter((a) => a.length > 0)
        : existing.aliases;

      // If name or aliases changed, re-run the uniqueness check. Skip when
      // neither field is in the updates payload (saves a scan on every
      // content/summary tweak).
      if (updates.name !== undefined || updates.aliases !== undefined) {
        const conflict = findElementNameConflict(
          [nextName, ...nextAliases],
          elements,
          activeProjectId,
          id, // exclude self — renaming an element to its own name isn't a conflict
        );
        if (conflict) {
          throw new ElementNameConflictError(
            conflict.conflictingName,
            conflict.conflictingElement,
          );
        }
      }

      const updatedElement: BookElement = {
        ...existing,
        categoryId: updates.categoryId ?? existing.categoryId,
        name: nextName,
        contentJson: updates.contentJson ?? existing.contentJson,
        kvJson: updates.kvJson ?? existing.kvJson,
        summary: updates.summary ?? existing.summary,
        aliases: nextAliases,
        groupName: updates.groupName !== undefined ? updates.groupName : existing.groupName,
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
            kvJson: updatedElement.kvJson,
            aliases: updatedElement.aliases,
            groupName: updatedElement.groupName,
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
            kvJson: persisted.kvJson,
            aliasesJson: encodeAliases(persisted.aliases),
            groupName: persisted.groupName,
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
      useUiStore.getState().closeTabsForEntity(activeProjectId, { entityType: 'element', id });

      if (canUseFeature('trash')) {
        return withOptimisticUpdate({
          apply: () => setElements(filtered),
          rollback: () => setElements(elements),
          effect: () => elementRepo.softDelete(id),
          sync: () => syncElementSoftDelete(id, activeProjectId),
        });
      }

      return withOptimisticUpdate({
        apply: () => setElements(filtered),
        rollback: () => setElements(elements),
        effect: () => elementRepo.delete(id),
        sync: () => syncElementDelete(id, activeProjectId),
      });
    },
    [elementRepo, getElements, setElements, ensureDb, activeProjectId],
  );

  const restoreElement = useCallback(
    async (id: string) => {
      await ensureDb();
      await elementRepo.restore(id);
      syncElementRestore(id, activeProjectId);
      const fresh = await elementRepo.findAll();
      setElements(fresh);
    },
    [elementRepo, ensureDb, setElements, activeProjectId],
  );

  const listTrashedElements = useCallback(async () => {
    await ensureDb();
    return await elementRepo.findTrashed();
  }, [elementRepo, ensureDb]);

  return useMemo(
    () => ({
      loadInitial,
      createElement,
      updateElement,
      removeElement,
      restoreElement,
      listTrashedElements,
    }),
    [loadInitial, createElement, updateElement, removeElement, restoreElement, listTrashedElements],
  );
}
