import { useCallback, useMemo } from 'react';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { useDataStore } from '../store/data-store';
import { useUiStore } from '../store/ui-store';
import {
  ElementNameConflictError,
  findElementNameConflict,
  makeUniqueElementName,
  type BookElement,
} from '../domain/book-element';
import { createBookElementSqliteRepository } from '../sqlite-repo/element-repo';
import { createInlineMentionRepository } from '../sqlite-repo/inline-mention-repo';
import { createProjectAssetSqliteRepository } from '../sqlite-repo/project-asset-repo';
import { unlinkEntityFromChapterProse } from '../lib/agent/chapter-prose';
import { initDatabase } from '../lib/db';
import { withOptimisticUpdate } from './optimistic';
import { events } from '../lib/events';
import { withAtomicSyncTransaction } from './sync-helpers';
import { canUseFeature, ensureFeatureAccess } from '../lib/feature-access';
import {
  deleteEntityRelationsInTransaction,
  withoutRelationsForEntity,
} from './entity-relation-cleanup';
import { BookElementTable } from '../schema/drizzle';
import { assetStoreService } from '../services/asset-store.service';
import {
  prepareLocalProjectAsset,
  releasePickedMaterialImport,
} from '../services/local-project-asset.service';
import {
  appendAuthoredProseSeedInTransaction,
  appendProjectAssetBindMutation,
  appendProjectAssetUnbindMutation,
  runDerivedTransaction,
} from '../sync/journal';
import { createEntitySeedUpdate } from '../hooks/useEntityYjsDoc';
import {
  cloneEntityKvEntriesInTransaction,
  replaceElementAliasesInTransaction,
  replaceEntityKvEntriesInTransaction,
} from './normalized-kv-alias-authority';

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
  /**
   * Optional initial secondary group (groupName) within the category. Used by
   * the "+ element in this group" affordance on a group header. null/omitted =
   * ungrouped.
   */
  groupName?: string | null;
  /** Initial prose authority; when omitted the category template is used. */
  initialContentJson?: string;
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
  const mentionRepo = useMemo(() => createInlineMentionRepository(), []);
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
      const seededContentJson =
        input.initialContentJson?.trim() || category?.elementTemplateJson?.trim() || '{}';
      const proseSeedState = await createEntitySeedUpdate(seededContentJson);
      // This projection only feeds the optimistic row. The authored
      // transaction clones normalized category-template entries with fresh
      // IDs and reloads the element projection before committing UI state.
      const seededKvJson = category?.elementTemplateKvJson?.trim() || '[]';

      const explicitName = input.name?.trim();
      // No name supplied → this is the "+ element" placeholder path. Derive a
      // project-unique default ("New Element", "New Element 2", …) instead of
      // throwing, so the user can spin up several blank elements before
      // renaming them. An explicit name still goes through the uniqueness
      // check below and surfaces a conflict.
      const resolvedName =
        explicitName || makeUniqueElementName('New Element', prev, activeProjectId);
      const resolvedAliases = (input.aliases ?? [])
        .map((a) => a.trim())
        .filter((a) => a.length > 0);

      // Uniqueness check: name + every alias must not collide with any
      // existing element's name or aliases in this project. Throws
      // ElementNameConflictError so the caller can surface the offender
      // (CommentRail's CopilotSuggestionCard already shows error.message
      // inline; PatchCreateModal currently swallows — both will benefit).
      // The auto-derived placeholder is already conflict-free by construction;
      // this still guards the explicit-name and alias inputs.
      const conflict = findElementNameConflict(
        [resolvedName, ...resolvedAliases],
        prev,
        activeProjectId,
      );
      if (conflict) {
        throw new ElementNameConflictError(conflict.conflictingName, conflict.conflictingElement);
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
        groupName: input.groupName?.trim() || null,
        portraitAssetId: null,
        createdAt: now,
        updatedAt: now,
      };

      const created = await withOptimisticUpdate({
        apply: () => setElements([newElement, ...prev]),
        rollback: () => setElements(prev),
        effect: () =>
          withAtomicSyncTransaction(activeProjectId, async (tx, sync, changes) => {
            const elementRepo = createBookElementSqliteRepository(
              activeProjectId,
              tx,
            );
            await elementRepo.create({ ...newElement, kvJson: '[]', aliases: [] });
            await cloneEntityKvEntriesInTransaction(tx, changes, {
              source: {
                projectId: activeProjectId,
                ownerKind: 'element-category',
                ownerId: input.categoryId,
                namespace: 'element-template',
              },
              target: {
                projectId: activeProjectId,
                ownerKind: 'element',
                ownerId: newElement.id,
                namespace: 'facts',
              },
            });
            await replaceElementAliasesInTransaction(tx, changes, {
              projectId: activeProjectId,
              elementId: newElement.id,
              aliases: newElement.aliases,
            });
            const persisted = (await elementRepo.findById(newElement.id))!;
            await sync('element', 'create', persisted.id, activeProjectId, {
              id: persisted.id,
              categoryId: persisted.categoryId,
              name: persisted.name,
              summary: persisted.summary,
              groupName: persisted.groupName,
            });
            await appendAuthoredProseSeedInTransaction(tx, changes, {
              entityType: 'element',
              entityId: persisted.id,
              stateUpdate: proseSeedState,
            });
            return persisted;
          }),
        onSuccess: (persisted) => {
          const current = getElements();
          const updated = current.map((el) => (el.id === persisted.id ? persisted : el));
          setElements(updated);
        },
      });
      // Let every open editor retroactively link prose that already mentioned
      // this element before it existed. Auto-detect only fires on freshly-typed
      // text, so without this, earlier blocks stay unlinked. Covers all creation
      // paths (Copilot element-candidate, @-picker create, manual add) since
      // they all funnel through here.
      events.emit('element:element-created', { element: created });
      return created;
    },
    [getElements, setElements, ensureDb, activeProjectId],
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
          throw new ElementNameConflictError(conflict.conflictingName, conflict.conflictingElement);
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
        portraitAssetId:
          updates.portraitAssetId !== undefined
            ? updates.portraitAssetId
            : existing.portraitAssetId,
        updatedAt: now.toISOString(),
      };

      return withOptimisticUpdate({
        apply: () => setElements(elements.map((el) => (el.id === id ? updatedElement : el))),
        rollback: () => setElements(elements),
        effect: async () => {
          const projectionOnly = Object.keys(updates).every(
            (field) => field === 'contentJson',
          );
          if (projectionOnly) {
            return runDerivedTransaction('prose.element-projection', async (tx) => {
              const elementRepo = createBookElementSqliteRepository(activeProjectId, tx);
              await elementRepo.update(id, {
                contentJson: updatedElement.contentJson,
                updatedAt: updatedElement.updatedAt,
              });
              const persisted = await elementRepo.findById(id);
              if (!persisted) throw new Error(`Element with id ${id} not found`);
              return persisted;
            });
          }
          return withAtomicSyncTransaction(activeProjectId, async (tx, sync, changes) => {
            const elementRepo = createBookElementSqliteRepository(
              activeProjectId,
              tx,
            );
            await elementRepo.update(id, {
              categoryId: updatedElement.categoryId,
              name: updatedElement.name,
              summary: updatedElement.summary,
              contentJson: updatedElement.contentJson,
              groupName: updatedElement.groupName,
              portraitAssetId: updatedElement.portraitAssetId,
              updatedAt: updatedElement.updatedAt,
            });
            if (updates.kvJson !== undefined) {
              await replaceEntityKvEntriesInTransaction(tx, changes, {
                projectId: activeProjectId,
                ownerKind: 'element',
                ownerId: id,
                namespace: 'facts',
                nextJson: updates.kvJson,
              });
            }
            if (updates.aliases !== undefined) {
              await replaceElementAliasesInTransaction(tx, changes, {
                projectId: activeProjectId,
                elementId: id,
                aliases: updates.aliases,
              });
            }
            const persisted = await elementRepo.findById(id);
            if (!persisted) {
              throw new Error(`Element with id ${id} not found`);
            }
            const scalarPayload: Record<string, unknown> = {};
            if (updates.categoryId !== undefined) scalarPayload.categoryId = persisted.categoryId;
            if (updates.name !== undefined) scalarPayload.name = persisted.name;
            if (updates.summary !== undefined) scalarPayload.summary = persisted.summary;
            if (updates.groupName !== undefined) scalarPayload.groupName = persisted.groupName;
            if (updates.portraitAssetId !== undefined) {
              scalarPayload.portraitAssetId = persisted.portraitAssetId;
            }
            if (Object.keys(scalarPayload).length > 0) {
              await sync('element', 'update', id, activeProjectId, scalarPayload);
            }
            return persisted;
          });
        },
        onSuccess: (persisted) => {
          const current = getElements();
          setElements(current.map((el) => (el.id === id ? persisted : el)));
        },
      });
    },
    [getElements, setElements, ensureDb, activeProjectId],
  );

  // Full association teardown for a PERMANENT delete (hard delete / purge).
  // Curated relations are already removed when an element enters trash; this
  // repeats the sweep defensively and also removes derived mention rows. The
  // element row, any remaining relations, mentions, and outbox mutations
  // commit together.
  // Afterwards:
  //   • 解链保留文字 — strip the dangling entityLink marks from each chapter's prose
  //     so the link doesn't re-project into inline_mention on the next save
  //     (reference-projection reads ALL marks regardless of target liveness).
  const hardDeleteElement = useCallback(
    async (id: string) => {
      // Capture prose backlinks before the transaction deletes their projection.
      let chapterIds: string[] = [];
      try {
        const backlinks = await mentionRepo.listBacklinksToTarget('element', id);
        chapterIds = [
          ...new Set(backlinks.filter((b) => b.fromKind === 'node').map((b) => b.fromId)),
        ];
      } catch {
        /* best-effort — fall through with whatever we have */
      }

      const result = await withAtomicSyncTransaction(
        activeProjectId,
        async (tx, sync, changes) => {
        const [elementSnapshot] = await tx
          .select({ portraitAssetId: BookElementTable.portraitAssetId })
          .from(BookElementTable)
          .where(
            and(
              eq(BookElementTable.id, id),
              eq(BookElementTable.projectId, activeProjectId),
            ),
          )
          .limit(1);
        const relationIds = await deleteEntityRelationsInTransaction(
          tx,
          sync,
          activeProjectId,
          'element',
          id,
        );
        await replaceEntityKvEntriesInTransaction(tx, changes, {
          projectId: activeProjectId,
          ownerKind: 'element',
          ownerId: id,
          namespace: 'facts',
          nextJson: '[]',
        });
        await replaceElementAliasesInTransaction(tx, changes, {
          projectId: activeProjectId,
          elementId: id,
          aliases: [],
        });
        const deleted = await createBookElementSqliteRepository(activeProjectId, tx).delete(id);
        if (elementSnapshot?.portraitAssetId) {
          appendProjectAssetUnbindMutation(changes, elementSnapshot.portraitAssetId, {
            kind: 'element-portrait',
            id,
          });
          await createProjectAssetSqliteRepository(activeProjectId, tx).delete(
            elementSnapshot.portraitAssetId,
          );
        }
        const txMentionRepo = createInlineMentionRepository(tx);
        await txMentionRepo.deleteAllForTarget('element', id);
        await txMentionRepo.deleteAllForSource('element', id);
        await sync('element', 'delete', id, activeProjectId);
        return {
          deleted,
          relationIds,
          portraitAssetId: elementSnapshot?.portraitAssetId ?? null,
        };
        },
      );

      if (result.portraitAssetId) {
        const portraitAssetId = result.portraitAssetId;
        void assetStoreService.deleteAsset(activeProjectId, portraitAssetId).catch((error) => {
          console.warn('Failed to clean hard-deleted element portrait:', error);
        });
        useDataStore.getState().removeProjectAsset(portraitAssetId);
      }

      if (result.relationIds.length > 0) {
        const doomedSet = new Set(result.relationIds);
        const relations = useDataStore.getState().entityRelations;
        useDataStore.getState().setEntityRelations(relations.filter((r) => !doomedSet.has(r.id)));
      }

      for (const cid of chapterIds) {
        try {
          await unlinkEntityFromChapterProse(activeProjectId, cid, id);
        } catch {
          /* best-effort per chapter — a single failure must not abort the delete */
        }
      }

      return result.deleted;
    },
    [mentionRepo, activeProjectId],
  );

  const removeElement = useCallback(
    async (id: string) => {
      await ensureDb();
      await ensureFeatureAccess(userId, { forceRefresh: true });
      const elements = getElements();
      const existing = elements.find((e) => e.id === id);
      if (!existing) throw new Error(`Element with id ${id} not found`);

      const filtered = elements.filter((e) => e.id !== id);
      const relations = useDataStore.getState().entityRelations;
      const remainingRelations = withoutRelationsForEntity(
        relations,
        activeProjectId,
        'element',
        id,
      );
      useUiStore.getState().closeTabsForEntity(activeProjectId, { entityType: 'element', id });

      if (canUseFeature('trash')) {
        return withOptimisticUpdate({
          // Mark trashed so open editors dim (not strip) inline mentions to
          // this element — soft-deleted is recoverable, unlike a hard delete.
          apply: () => {
            setElements(filtered);
            useDataStore.getState().setEntityRelations(remainingRelations);
            useDataStore.getState().markTrashed('element', id);
          },
          rollback: () => {
            setElements(elements);
            useDataStore.getState().setEntityRelations(relations);
            useDataStore.getState().unmarkTrashed('element', id);
          },
          effect: async () => {
            return withAtomicSyncTransaction(activeProjectId, async (tx, sync) => {
              // A soft-deleted element is restorable, so its portrait binding
              // and app-owned bytes stay intact until permanent deletion.
              await deleteEntityRelationsInTransaction(
                tx,
                sync,
                activeProjectId,
                'element',
                id,
              );
              const result = await createBookElementSqliteRepository(
                activeProjectId,
                tx,
              ).softDelete(id);
              await sync('element', 'softDelete', id, activeProjectId);
              return result;
            });
          },
        });
      }

      // Free tier: hard delete and association sweep share one transaction.
      const result = await withOptimisticUpdate({
        apply: () => setElements(filtered),
        rollback: () => setElements(elements),
        effect: () => hardDeleteElement(id),
      });
      return result;
    },
    [getElements, setElements, ensureDb, userId, activeProjectId, hardDeleteElement],
  );

  const restoreElement = useCallback(
    async (id: string) => {
      await ensureDb();
      await withAtomicSyncTransaction(activeProjectId, async (tx, sync) => {
        await createBookElementSqliteRepository(activeProjectId, tx).restore(id);
        await sync('element', 'restore', id, activeProjectId);
      });
      useDataStore.getState().unmarkTrashed('element', id);
      const fresh = await elementRepo.findAll();
      setElements(fresh);
    },
    [elementRepo, ensureDb, setElements, activeProjectId],
  );

  // Permanently delete an already-trashed element — the "立刻删除" path in the
  // trash UI, skipping the 30-day cron. The row is gone for good (no restore).
  // The element isn't in the active store (it's soft-deleted), so there's
  // nothing to mutate there; the trash view reloads its own list afterward.
  const purgeElement = useCallback(
    async (id: string) => {
      await ensureDb();
      await hardDeleteElement(id);
      // No longer trashed — it's gone for good. Mentions flip dim → stripped.
      useDataStore.getState().unmarkTrashed('element', id);
    },
    [ensureDb, hardDeleteElement],
  );

  const listTrashedElements = useCallback(async () => {
    await ensureDb();
    return await elementRepo.findTrashed();
  }, [elementRepo, ensureDb]);

  const setElementPortraitFromLocalFile = useCallback(
    async (id: string, sourcePath: string) => {
      await ensureDb();
      const existing = getElements().find((element) => element.id === id);
      if (!existing) throw new Error(`Element with id ${id} not found`);

      const asset = await prepareLocalProjectAsset({
        projectId: activeProjectId,
        kind: 'image',
        sourcePath,
      });
      try {
        const persisted = await withAtomicSyncTransaction(
          activeProjectId,
          async (tx, _sync, changes) => {
            await createProjectAssetSqliteRepository(activeProjectId, tx).create(asset);
            if (existing.portraitAssetId && existing.portraitAssetId !== asset.id) {
              appendProjectAssetUnbindMutation(changes, existing.portraitAssetId, {
                kind: 'element-portrait',
                id,
              });
            }
            appendProjectAssetBindMutation(changes, activeProjectId, asset, {
              kind: 'element-portrait',
              id,
            });
            const element = await createBookElementSqliteRepository(activeProjectId, tx).update(
              id,
              {
                portraitAssetId: asset.id,
                updatedAt: asset.createdAt,
              },
            );
            if (!element) throw new Error(`Element with id ${id} not found`);
            if (existing.portraitAssetId && existing.portraitAssetId !== asset.id) {
              await createProjectAssetSqliteRepository(activeProjectId, tx).delete(
                existing.portraitAssetId,
              );
            }
            return element;
          },
        );
        useDataStore.getState().upsertProjectAsset(asset);
        useDataStore.getState().updateBookElement(id, persisted);
        if (existing.portraitAssetId && existing.portraitAssetId !== asset.id) {
          useDataStore.getState().removeProjectAsset(existing.portraitAssetId);
          void assetStoreService
            .deleteAsset(activeProjectId, existing.portraitAssetId)
            .catch((error) => console.warn('[portrait] failed to remove replaced asset:', error));
        }
        void releasePickedMaterialImport(sourcePath).catch((error) => {
          console.warn('[portrait] failed to release committed picker import:', error);
        });
        return persisted;
      } catch (error) {
        await assetStoreService.deleteAsset(activeProjectId, asset.id).catch(() => undefined);
        throw error;
      }
    },
    [activeProjectId, ensureDb, getElements],
  );

  const removeElementPortrait = useCallback(
    async (id: string) => {
      await ensureDb();
      const existing = getElements().find((element) => element.id === id);
      if (!existing) throw new Error(`Element with id ${id} not found`);
      const assetId = existing.portraitAssetId;
      if (!assetId) return existing;
      const persisted = await withAtomicSyncTransaction(activeProjectId, async (tx, _sync, changes) => {
        const element = await createBookElementSqliteRepository(activeProjectId, tx).update(id, {
          portraitAssetId: null,
          updatedAt: new Date().toISOString(),
        });
        if (!element) throw new Error(`Element with id ${id} not found`);
        appendProjectAssetUnbindMutation(changes, assetId, {
          kind: 'element-portrait',
          id,
        });
        await createProjectAssetSqliteRepository(activeProjectId, tx).delete(assetId);
        return element;
      });
      useDataStore.getState().updateBookElement(id, persisted);
      useDataStore.getState().removeProjectAsset(assetId);
      void assetStoreService
        .deleteAsset(activeProjectId, assetId)
        .catch((error) => console.warn('[portrait] failed to remove local asset:', error));
      return persisted;
    },
    [activeProjectId, ensureDb, getElements],
  );

  return useMemo(
    () => ({
      loadInitial,
      createElement,
      updateElement,
      removeElement,
      restoreElement,
      purgeElement,
      listTrashedElements,
      setElementPortraitFromLocalFile,
      removeElementPortrait,
    }),
    [
      loadInitial,
      createElement,
      updateElement,
      removeElement,
      restoreElement,
      purgeElement,
      listTrashedElements,
      setElementPortraitFromLocalFile,
      removeElementPortrait,
    ],
  );
}
