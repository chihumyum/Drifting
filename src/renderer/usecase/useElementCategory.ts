import { useMemo, useCallback } from 'react';
import { createElementCategoryRepository } from '../sqlite-repo/element-category-repo';
import type { BookElementCategory } from '../domain/book-element';
import { v7 as uuidv7 } from 'uuid';
import { randomColor } from '../utils';
import { useDataStore } from '../store/data-store';
import { useUiStore } from '../store/ui-store';
import { initDatabase } from '../lib/db';
import { withOptimisticUpdate } from './optimistic';
import { withAtomicSyncTransaction } from './sync-helpers';
import { canUseFeature, ensureFeatureAccess } from '../lib/feature-access';
import loglevel from 'loglevel';
import {
  deleteEntityRelationsInTransaction,
  withoutRelationsForEntity,
} from './entity-relation-cleanup';
import { replaceEntityKvEntriesInTransaction } from './normalized-kv-alias-authority';
import {
  appendAuthoredProseSeedInTransaction,
  runDerivedTransaction,
} from '../sync/journal';
import { createEntitySeedUpdate } from '../hooks/useEntityYjsDoc';

const log = loglevel.getLogger('useElementCategory');
log.setLevel(loglevel.levels.WARN);

export type CreateElementCategoryInput = {
  name?: string;
  contentJson?: string;
  elementTemplateJson?: string;
  elementTemplateKvJson?: string;
};

export interface UpdateElementCategoryInput {
  name?: string;
  contentJson?: string;
  elementTemplateJson?: string;
  elementTemplateKvJson?: string;
  color?: string;
  // SuperElementView layout persistence. Setting layoutMode='pinned' with
  // grid coords stamps the user's drag; layoutMode='auto' returns the category
  // to the skyline solver.
  layoutMode?: 'auto' | 'pinned';
  gridX?: number | null;
  gridY?: number | null;
}

export interface UseElementCategoryContext {
  projectId: string;
  userId: string;
}

export function useElementCategory({ projectId, userId }: UseElementCategoryContext) {
  if (!projectId) {
    throw new Error('useElementCategory requires a projectId');
  }
  if (!userId) {
    throw new Error('useElementCategory requires a userId');
  }
  const activeProjectId = projectId;
  const repo = useMemo(() => createElementCategoryRepository(activeProjectId), [activeProjectId]);
  const ensureDb = useCallback(async () => {
    await initDatabase(userId);
  }, [userId]);

  const getCategoriesState = useCallback(() => useDataStore.getState().bookElementCategories, []);
  const setCategoriesState = useCallback((categories: BookElementCategory[]) => {
    useDataStore.getState().setBookElementCategories(categories);
  }, []);
  const addCategoryState = useCallback((category: BookElementCategory) => {
    useDataStore.getState().addBookElementCategory(category);
  }, []);
  const updateCategoryState = useCallback((id: string, updates: Partial<BookElementCategory>) => {
    useDataStore.getState().updateBookElementCategory(id, updates);
  }, []);
  const removeCategoryState = useCallback((id: string) => {
    useDataStore.getState().removeBookElementCategory(id);
  }, []);

  const createCategory = useCallback(
    async (input: CreateElementCategoryInput = {}): Promise<BookElementCategory> => {
      const resolved = input;
      await ensureDb();

      const now = new Date().toISOString();
      const newCategory: BookElementCategory = {
        id: uuidv7(),
        projectId: activeProjectId,
        name: resolved.name?.trim() || 'New Category',
        contentJson: resolved.contentJson ?? '{}',
        elementTemplateJson: resolved.elementTemplateJson ?? '{}',
        elementTemplateKvJson: resolved.elementTemplateKvJson ?? '[]',
        color: randomColor(),
        layoutMode: 'auto',
        gridX: null,
        gridY: null,
        createdAt: now,
        updatedAt: now,
      };
      const proseSeedState = await createEntitySeedUpdate(newCategory.contentJson);

      const prevCategories = getCategoriesState().slice();
      return withOptimisticUpdate({
        apply: () => addCategoryState(newCategory),
        rollback: () => setCategoriesState(prevCategories),
        effect: () =>
          withAtomicSyncTransaction(activeProjectId, async (tx, sync, changes) => {
            const categoryRepo = createElementCategoryRepository(activeProjectId, tx);
            await categoryRepo.create({ ...newCategory, elementTemplateKvJson: '[]' });
            await replaceEntityKvEntriesInTransaction(tx, changes, {
              projectId: activeProjectId,
              ownerKind: 'element-category',
              ownerId: newCategory.id,
              namespace: 'element-template',
              nextJson: newCategory.elementTemplateKvJson,
            });
            const created = (await categoryRepo.findAll()).find(
              (category) => category.id === newCategory.id,
            )!;
            await sync('elementCategory', 'create', created.id, activeProjectId, {
              id: created.id,
              name: created.name,
              elementTemplateJson: created.elementTemplateJson,
              color: created.color,
              layoutMode: created.layoutMode,
              gridX: created.gridX,
              gridY: created.gridY,
            });
            await appendAuthoredProseSeedInTransaction(tx, changes, {
              entityType: 'category',
              entityId: created.id,
              stateUpdate: proseSeedState,
            });
            return created;
          }),
        onSuccess: (created) => {
          const current = getCategoriesState();
          setCategoriesState(current.map((cat) => (cat.id === created.id ? created : cat)));
        },
      });
    },
    [activeProjectId, addCategoryState, ensureDb, getCategoriesState, setCategoriesState],
  );

  const loadCategories = useCallback(
    async (projectIdOverride?: string): Promise<BookElementCategory[]> => {
      if (projectIdOverride && projectIdOverride !== activeProjectId) {
        throw new Error('Input projectId does not match active projectId');
      }
      await ensureDb();
      const categories = await repo.findAll();
      setCategoriesState(categories);
      return categories;
    },
    [repo, activeProjectId, setCategoriesState, ensureDb],
  );

  const updateCategory = useCallback(
    async (
      categoryId: string,
      updates: UpdateElementCategoryInput,
    ): Promise<BookElementCategory> => {
      await ensureDb();
      let prevCategories = getCategoriesState().slice();
      let existing = prevCategories.find((cat) => cat.id === categoryId);
      if (!existing) {
        const freshCategories = await repo.findAll();
        setCategoriesState(freshCategories);
        prevCategories = freshCategories.slice();
        existing = freshCategories.find((cat) => cat.id === categoryId);
      }
      if (!existing) {
        throw new Error(`Category ${categoryId} not found`);
      }

      const now = new Date().toISOString();
      const updated: BookElementCategory = {
        ...existing,
        name: updates.name ?? existing.name,
        contentJson: updates.contentJson ?? existing.contentJson,
        elementTemplateJson: updates.elementTemplateJson ?? existing.elementTemplateJson,
        elementTemplateKvJson:
          updates.elementTemplateKvJson ?? existing.elementTemplateKvJson,
        color: updates.color ?? existing.color,
        layoutMode: updates.layoutMode ?? existing.layoutMode,
        gridX: updates.gridX !== undefined ? updates.gridX : existing.gridX,
        gridY: updates.gridY !== undefined ? updates.gridY : existing.gridY,
        updatedAt: now,
      };

      return withOptimisticUpdate({
        apply: () => updateCategoryState(categoryId, updated),
        rollback: () => setCategoriesState(prevCategories),
        effect: async () => {
          const projectionOnly = Object.keys(updates).every(
            (field) => field === 'contentJson',
          );
          if (projectionOnly) {
            return runDerivedTransaction('prose.category-projection', async (tx) => {
              const categoryRepo = createElementCategoryRepository(activeProjectId, tx);
              await categoryRepo.update(categoryId, {
                contentJson: updated.contentJson,
                updatedAt: updated.updatedAt,
              });
              const persisted = (await categoryRepo.findAll()).find(
                (category) => category.id === categoryId,
              );
              if (!persisted) throw new Error(`Category ${categoryId} not found`);
              return persisted;
            });
          }
          return withAtomicSyncTransaction(activeProjectId, async (tx, sync, changes) => {
            const categoryRepo = createElementCategoryRepository(activeProjectId, tx);
            await categoryRepo.update(
              categoryId,
              {
                name: updated.name,
                contentJson: updated.contentJson,
                elementTemplateJson: updated.elementTemplateJson,
                color: updated.color,
                layoutMode: updated.layoutMode,
                gridX: updated.gridX,
                gridY: updated.gridY,
                updatedAt: updated.updatedAt,
              },
            );
            if (updates.elementTemplateKvJson !== undefined) {
              await replaceEntityKvEntriesInTransaction(tx, changes, {
                projectId: activeProjectId,
                ownerKind: 'element-category',
                ownerId: categoryId,
                namespace: 'element-template',
                nextJson: updates.elementTemplateKvJson,
              });
            }
            const persisted = (await categoryRepo.findAll()).find(
              (category) => category.id === categoryId,
            );
            if (!persisted) throw new Error(`Category ${categoryId} not found`);
            const scalarPayload: Record<string, unknown> = {};
            if (updates.name !== undefined) scalarPayload.name = persisted.name;
            if (updates.elementTemplateJson !== undefined) {
              scalarPayload.elementTemplateJson = persisted.elementTemplateJson;
            }
            if (updates.color !== undefined) scalarPayload.color = persisted.color;
            if (updates.layoutMode !== undefined) scalarPayload.layoutMode = persisted.layoutMode;
            if (updates.gridX !== undefined) scalarPayload.gridX = persisted.gridX;
            if (updates.gridY !== undefined) scalarPayload.gridY = persisted.gridY;
            if (Object.keys(scalarPayload).length > 0) {
              await sync('elementCategory', 'update', categoryId, activeProjectId, scalarPayload);
            }
            return persisted;
          });
        },
        onSuccess: (persisted) => {
          updateCategoryState(categoryId, persisted);
        },
      });
    },
    [ensureDb, getCategoriesState, repo, setCategoriesState, updateCategoryState, activeProjectId],
  );

  const deleteCategory = useCallback(
    async (categoryId: string): Promise<void> => {
      await ensureDb();
      await ensureFeatureAccess(userId, { forceRefresh: true });
      let prevCategories = getCategoriesState().slice();
      let existing = prevCategories.find((cat) => cat.id === categoryId);
      if (!existing) {
        const freshCategories = await repo.findAll();
        setCategoriesState(freshCategories);
        prevCategories = freshCategories.slice();
        existing = freshCategories.find((cat) => cat.id === categoryId);
      }
      // Close any tab pointing at this category. Children (elements) detach
      // to the "未分类" bucket (categoryId → null) — see the repo's
      // softDelete/delete for the SQLite-side update.
      const uiStore = useUiStore.getState();
      uiStore.closeTabsForEntity(activeProjectId, { entityType: 'category', id: categoryId });

      // Snapshot bookElements so we can both update the in-memory store
      // alongside the SQLite update AND roll it back if the repo call fails.
      const dataStore = useDataStore.getState();
      const prevElements = dataStore.bookElements.slice();
      const previousRelations = dataStore.entityRelations;
      const remainingRelations = withoutRelationsForEntity(
        previousRelations,
        activeProjectId,
        'category',
        categoryId,
      );
      const detachedElements = prevElements.map((el) =>
        el.categoryId === categoryId ? { ...el, categoryId: null } : el,
      );

      if (canUseFeature('trash')) {
        return withOptimisticUpdate({
          apply: () => {
            removeCategoryState(categoryId);
            dataStore.setBookElements(detachedElements);
            dataStore.setEntityRelations(remainingRelations);
          },
          rollback: () => {
            setCategoriesState(prevCategories);
            dataStore.setBookElements(prevElements);
            dataStore.setEntityRelations(previousRelations);
          },
          effect: () =>
            withAtomicSyncTransaction(activeProjectId, async (tx, sync) => {
              await deleteEntityRelationsInTransaction(
                tx,
                sync,
                activeProjectId,
                'category',
                categoryId,
              );
              await createElementCategoryRepository(activeProjectId, tx).softDelete(categoryId);
              await sync('elementCategory', 'softDelete', categoryId, activeProjectId);
            }),
        });
      }

      return withOptimisticUpdate({
        apply: () => {
          removeCategoryState(categoryId);
          dataStore.setBookElements(detachedElements);
          dataStore.setEntityRelations(remainingRelations);
        },
        rollback: () => {
          setCategoriesState(prevCategories);
          dataStore.setBookElements(prevElements);
          dataStore.setEntityRelations(previousRelations);
        },
        effect: () =>
          withAtomicSyncTransaction(activeProjectId, async (tx, sync, changes) => {
            await deleteEntityRelationsInTransaction(
              tx,
              sync,
              activeProjectId,
              'category',
              categoryId,
            );
            await replaceEntityKvEntriesInTransaction(tx, changes, {
              projectId: activeProjectId,
              ownerKind: 'element-category',
              ownerId: categoryId,
              namespace: 'element-template',
              nextJson: '[]',
            });
            await createElementCategoryRepository(activeProjectId, tx).delete(categoryId);
            await sync('elementCategory', 'delete', categoryId, activeProjectId);
          }),
      });
    },
    [ensureDb, userId, getCategoriesState, removeCategoryState, repo, setCategoriesState, activeProjectId],
  );

  const restoreCategory = useCallback(
    async (categoryId: string): Promise<void> => {
      await ensureDb();
      await withAtomicSyncTransaction(activeProjectId, async (tx, sync) => {
        await createElementCategoryRepository(activeProjectId, tx).restore(categoryId);
        await sync('elementCategory', 'restore', categoryId, activeProjectId);
      });
      const fresh = await repo.findAll();
      setCategoriesState(fresh);
    },
    [ensureDb, repo, setCategoriesState, activeProjectId],
  );

  // Permanently delete an already-trashed category — the "立刻删除" path in the
  // trash UI. Child elements were detached to "未分类" at soft-delete time (and
  // the FK is `set null` anyway), so the hard delete just drops the row. The
  // category isn't in the active store, so nothing to mutate there.
  const purgeCategory = useCallback(
    async (categoryId: string): Promise<void> => {
      await ensureDb();
      await withAtomicSyncTransaction(activeProjectId, async (tx, sync, changes) => {
        await deleteEntityRelationsInTransaction(
          tx,
          sync,
          activeProjectId,
          'category',
          categoryId,
        );
        await replaceEntityKvEntriesInTransaction(tx, changes, {
          projectId: activeProjectId,
          ownerKind: 'element-category',
          ownerId: categoryId,
          namespace: 'element-template',
          nextJson: '[]',
        });
        await createElementCategoryRepository(activeProjectId, tx).delete(categoryId);
        await sync('elementCategory', 'delete', categoryId, activeProjectId);
      });
      const relations = useDataStore.getState().entityRelations;
      useDataStore
        .getState()
        .setEntityRelations(
          withoutRelationsForEntity(relations, activeProjectId, 'category', categoryId),
        );
    },
    [ensureDb, activeProjectId],
  );

  const listTrashedCategories = useCallback(async () => {
    await ensureDb();
    return await repo.findTrashed();
  }, [ensureDb, repo]);

  const getCategoryColor = useCallback(
    (categoryId: string): string => {
      if (!categoryId) {
        log.error('getCategoryColor called with empty categoryId');
      }

      const existing = getCategoriesState().find((cat) => cat.id === categoryId);
      const existingColor = existing?.color?.trim();
      if (existingColor) {
        return existingColor;
      } else {
        log.error(
          `Category ${categoryId} not found when getting color. Falling back to generated color.`,
        );
        return randomColor();
      }
    },
    [getCategoriesState],
  );

  return useMemo(
    () => ({
      createCategory,
      loadCategories,
      updateCategory,
      deleteCategory,
      restoreCategory,
      purgeCategory,
      listTrashedCategories,
      getCategoryColor,
    }),
    [
      createCategory,
      loadCategories,
      updateCategory,
      deleteCategory,
      restoreCategory,
      purgeCategory,
      listTrashedCategories,
      getCategoryColor,
    ],
  );
}
