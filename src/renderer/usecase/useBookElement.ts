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
import { createEntityRelationRepository } from '../sqlite-repo/entity-relation-repo';
import { createInlineMentionRepository } from '../sqlite-repo/inline-mention-repo';
import { createShadowJobRepository } from '../sqlite-repo/shadow-job-repo';
import { unlinkEntityFromChapterProse } from '../lib/agent/chapter-prose';
import { initDatabase } from '../lib/db';
import { withOptimisticUpdate } from './optimistic';
import { events } from '../lib/events';
import {
  syncElementCreate,
  syncElementUpdate,
  syncElementDelete,
  syncElementSoftDelete,
  syncElementRestore,
  syncEntityRelationDelete,
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
  /**
   * Optional initial secondary group (groupName) within the category. Used by
   * the "+ element in this group" affordance on a group header. null/omitted =
   * ungrouped.
   */
  groupName?: string | null;
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
  const relationRepo = useMemo(() => createEntityRelationRepository(), []);
  const mentionRepo = useMemo(() => createInlineMentionRepository(), []);
  const shadowJobRepo = useMemo(() => createShadowJobRepository(), []);
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
            portraitAssetId: persisted.portraitAssetId,
          }),
      });
      // Let every open editor retroactively link prose that already mentioned
      // this element before it existed. Auto-detect only fires on freshly-typed
      // text, so without this, earlier blocks stay unlinked. Covers all creation
      // paths (Copilot element-candidate, @-picker create, manual add) since
      // they all funnel through here.
      events.emit('element:element-created', { element: created });
      return created;
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
          const persisted = await elementRepo.update(id, {
            categoryId: updatedElement.categoryId,
            name: updatedElement.name,
            summary: updatedElement.summary,
            contentJson: updatedElement.contentJson,
            kvJson: updatedElement.kvJson,
            aliases: updatedElement.aliases,
            groupName: updatedElement.groupName,
            portraitAssetId: updatedElement.portraitAssetId,
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
            portraitAssetId: persisted.portraitAssetId,
          }),
      });
    },
    [elementRepo, getElements, setElements, ensureDb, activeProjectId],
  );

  // Drop every relation that pointed at (or out of) a now hard-deleted element.
  // entity_relation / inline_mention carry polymorphic (kind, id) endpoints
  // with no element FK, so a hard delete leaves them orphaned unless we sweep
  // them here. Only call on a TRUE delete — soft-delete keeps these around so a
  // restore brings the links back.
  //   • entity_relation: curated, per-row synced → delete each + enqueue sync,
  //     and prune the in-memory store so graph / references update immediately.
  //   • inline_mention: a derived projection (no per-row sync); just clear both
  //     directions locally. The server reconciles on the next graph pull.
  const cleanupElementRelations = useCallback(
    async (id: string) => {
      const relations = useDataStore.getState().entityRelations;
      const doomedIds = relations
        .filter(
          (r) =>
            (r.fromKind === 'element' && r.fromId === id) ||
            (r.toKind === 'element' && r.toId === id),
        )
        .map((r) => r.id);
      if (doomedIds.length > 0) {
        const doomedSet = new Set(doomedIds);
        useDataStore.getState().setEntityRelations(relations.filter((r) => !doomedSet.has(r.id)));
        for (const relationId of doomedIds) {
          await relationRepo.removeRelation(relationId);
          syncEntityRelationDelete(relationId, activeProjectId);
        }
      }
      await mentionRepo.deleteAllForTarget('element', id);
      await mentionRepo.deleteAllForSource('element', id);
    },
    [relationRepo, mentionRepo, activeProjectId],
  );

  // Full association teardown for a PERMANENT delete (hard delete / purge — NOT
  // soft delete, which stays recoverable). Beyond cleanupElementRelations:
  //   • 解链保留文字 — strip the dangling entityLink marks from each chapter's prose
  //     so the link doesn't re-project into inline_mention on the next save
  //     (reference-projection reads ALL marks regardless of target liveness).
  //   • scrub shadow dep refs — a deleted dep would otherwise read as "changed"
  //     forever, keeping chapters perpetually stale (and auto-re-reviewing).
  const purgeElementAssociations = useCallback(
    async (id: string) => {
      // Capture the chapters that mention this element BEFORE cleanup deletes rows.
      let chapterIds: string[] = [];
      try {
        const backlinks = await mentionRepo.listBacklinksToTarget('element', id);
        chapterIds = [
          ...new Set(backlinks.filter((b) => b.fromKind === 'node').map((b) => b.fromId)),
        ];
      } catch {
        /* best-effort — fall through with whatever we have */
      }

      await cleanupElementRelations(id);

      for (const cid of chapterIds) {
        try {
          await unlinkEntityFromChapterProse(cid, id);
        } catch {
          /* best-effort per chapter — a single failure must not abort the delete */
        }
      }

      try {
        const changed = await shadowJobRepo.scrubEntityRefs(activeProjectId, 'element', id);
        for (const job of changed) useDataStore.getState().upsertShadowJob(job);
      } catch {
        /* best-effort telemetry cleanup */
      }
    },
    [mentionRepo, cleanupElementRelations, shadowJobRepo, activeProjectId],
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
          // Mark trashed so open editors dim (not strip) inline mentions to
          // this element — soft-deleted is recoverable, unlike a hard delete.
          apply: () => {
            setElements(filtered);
            useDataStore.getState().markTrashed('element', id);
          },
          rollback: () => {
            setElements(elements);
            useDataStore.getState().unmarkTrashed('element', id);
          },
          effect: () => elementRepo.softDelete(id),
          sync: () => syncElementSoftDelete(id, activeProjectId),
        });
      }

      // Free tier: hard delete — also sweep the now-orphaned relations.
      const result = await withOptimisticUpdate({
        apply: () => setElements(filtered),
        rollback: () => setElements(elements),
        effect: () => elementRepo.delete(id),
        sync: () => syncElementDelete(id, activeProjectId),
      });
      await purgeElementAssociations(id);
      return result;
    },
    [elementRepo, getElements, setElements, ensureDb, activeProjectId, purgeElementAssociations],
  );

  const restoreElement = useCallback(
    async (id: string) => {
      await ensureDb();
      await elementRepo.restore(id);
      syncElementRestore(id, activeProjectId);
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
      await elementRepo.delete(id);
      syncElementDelete(id, activeProjectId);
      // No longer trashed — it's gone for good. Mentions flip dim → stripped.
      useDataStore.getState().unmarkTrashed('element', id);
      await purgeElementAssociations(id);
    },
    [elementRepo, ensureDb, activeProjectId, purgeElementAssociations],
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
      purgeElement,
      listTrashedElements,
    }),
    [
      loadInitial,
      createElement,
      updateElement,
      removeElement,
      restoreElement,
      purgeElement,
      listTrashedElements,
    ],
  );
}
