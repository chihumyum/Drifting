import { useMemo, useRef, useCallback } from 'react';
import { createBookElementSqliteRepository } from '../sqlite-repo/element-repo';
import { createElementTagRepository, createElementTagLinkRepository } from '../sqlite-repo/element-tag-repo';
import { initDatabase, getDb } from '../lib/db';
import type { ElementTag } from '../domain/element-tag';
import { useDataStore } from '../store/data-store';
import { withOptimisticUpdate } from './optimistic';
import { v7 as uuidv7 } from 'uuid';

export interface CreateElementTagInput {
  projectId?: string;
  name: string;
  color?: string | null;
}

export interface UseElementTagContext {
  projectId: string;
  userId: string;
}

export function useElementTag({ projectId, userId }: UseElementTagContext) {
  const activeProjectId = projectId;
  if (!activeProjectId) {
    throw new Error('useElementTag requires a projectId');
  }
  if (!userId) {
    throw new Error('useElementTag requires a userId');
  }
  const tagRepoRef = useRef(createElementTagRepository());
  const tagLinkRepoRef = useRef(createElementTagLinkRepository());

  const tagRepo = tagRepoRef.current;
  const tagLinkRepo = tagLinkRepoRef.current;

  const ensureProjectId = useCallback((projectId?: string) => {
    const pid = projectId ?? activeProjectId;
    if (!pid) {
      throw new Error('Project ID is required to load tags');
    }
    return pid;
  }, [activeProjectId]);

  const ensureDb = useCallback(async (projectId?: string) => {
    const pid = ensureProjectId(projectId);
    await initDatabase(userId);
    return pid;
  }, [ensureProjectId, userId]);

  const updateElementTagIdsInStore = useCallback((elementId: string, tagIds: string[], updatedAt?: string) => {
    const updates: Partial<{ tagIds: string[]; updatedAt: string }> = { tagIds };
    if (updatedAt) updates.updatedAt = updatedAt;
    useDataStore.getState().updateBookElement(elementId, updates);
  }, []);

  // Tag CRUD operations
  const loadTags = useCallback(async (projectId?: string) => {
    const pid = await ensureDb(projectId);
    return tagRepo.findAll(pid);
  }, [tagRepo, ensureDb]);

  const getTagById = useCallback(async (id: string, projectId?: string) => {
    await ensureDb(projectId);
    return tagRepo.findById(id);
  }, [tagRepo, ensureDb]);

  const createTag = useCallback(async (input: CreateElementTagInput) => {
    const projectId = await ensureDb(input.projectId);
    return tagRepo.create({
      id: uuidv7(),
      projectId,
      name: input.name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }, [tagRepo, ensureDb]);

  const deleteTag = useCallback(async (id: string, projectId?: string) => {
    await ensureDb(projectId);
    return tagRepo.delete(id);
  }, [tagRepo, ensureDb]);

  // Element-Tag link operations
  const getTagsForElement = useCallback(async (elementId: string, projectId?: string) => {
    await ensureDb(projectId);
    return tagLinkRepo.findTagsByElementId(elementId);
  }, [tagLinkRepo, ensureDb]);

  const getElementsWithTag = useCallback(async (tagId: string, projectId?: string) => {
    await ensureDb(projectId);
    return tagLinkRepo.findElementIdsByTagId(tagId);
  }, [tagLinkRepo, ensureDb]);

  const addTagToElement = useCallback(async (elementId: string, tagId: string, projectId?: string) => {
    const pid = await ensureDb(projectId);
    const db = getDb();
    const updatedAt = new Date().toISOString();

    const current = useDataStore.getState().bookElements.find(el => el.id === elementId);
    const prevTagIds = current?.tagIds ?? [];
    const prevUpdatedAt = current?.updatedAt;
    const nextTagIds = current
      ? (current.tagIds.includes(tagId) ? current.tagIds : [...current.tagIds, tagId])
      : null;

    const apply = () => {
      if (nextTagIds) updateElementTagIdsInStore(elementId, nextTagIds, updatedAt);
    };
    const rollback = () => {
      if (current) updateElementTagIdsInStore(elementId, prevTagIds, prevUpdatedAt);
    };

    return withOptimisticUpdate({
      apply,
      rollback,
      effect: async () => {
        await db.transaction(async (tx) => {
          const elementRepoTx = createBookElementSqliteRepository(pid, tx);
          const tagLinkRepoTx = createElementTagLinkRepository(tx);
          const updated = await elementRepoTx.update(elementId, { updatedAt });
          if (!updated) throw new Error(`Element with id ${elementId} not found`);
          await tagLinkRepoTx.addTagToElement(elementId, tagId);
        });
      },
    });
  }, [ensureDb, updateElementTagIdsInStore]);

  const removeTagFromElement = useCallback(async (elementId: string, tagId: string, projectId?: string) => {
    const pid = await ensureDb(projectId);
    const db = getDb();
    const updatedAt = new Date().toISOString();

    const current = useDataStore.getState().bookElements.find(el => el.id === elementId);
    const prevTagIds = current?.tagIds ?? [];
    const prevUpdatedAt = current?.updatedAt;
    const nextTagIds = current ? current.tagIds.filter(id => id !== tagId) : null;

    const apply = () => {
      if (nextTagIds) updateElementTagIdsInStore(elementId, nextTagIds, updatedAt);
    };
    const rollback = () => {
      if (current) updateElementTagIdsInStore(elementId, prevTagIds, prevUpdatedAt);
    };

    return withOptimisticUpdate({
      apply,
      rollback,
      effect: async () => {
        await db.transaction(async (tx) => {
          const elementRepoTx = createBookElementSqliteRepository(pid, tx);
          const tagLinkRepoTx = createElementTagLinkRepository(tx);
          const updated = await elementRepoTx.update(elementId, { updatedAt });
          if (!updated) throw new Error(`Element with id ${elementId} not found`);
          await tagLinkRepoTx.removeTagFromElement(elementId, tagId);
        });
      },
    });
  }, [ensureDb, updateElementTagIdsInStore]);

  const setElementTags = useCallback(async (elementId: string, tagIds: string[], projectId?: string) => {
    const pid = await ensureDb(projectId);
    const db = getDb();
    const updatedAt = new Date().toISOString();

    const current = useDataStore.getState().bookElements.find(el => el.id === elementId);
    const prevTagIds = current?.tagIds ?? [];
    const prevUpdatedAt = current?.updatedAt;

    const apply = () => {
      updateElementTagIdsInStore(elementId, tagIds, updatedAt);
    };
    const rollback = () => {
      if (current) updateElementTagIdsInStore(elementId, prevTagIds, prevUpdatedAt);
    };

    return withOptimisticUpdate({
      apply,
      rollback,
      effect: async () => {
        await db.transaction(async (tx) => {
          const elementRepoTx = createBookElementSqliteRepository(pid, tx);
          const tagLinkRepoTx = createElementTagLinkRepository(tx);
          const updated = await elementRepoTx.update(elementId, { updatedAt });
          if (!updated) throw new Error(`Element with id ${elementId} not found`);
          await tagLinkRepoTx.setTagsForElement(elementId, tagIds);
        });
      },
    });
  }, [ensureDb, updateElementTagIdsInStore]);

  const createAndAddTagToElement = useCallback(async (elementId: string, input: CreateElementTagInput) => {
    const projectId = await ensureDb(input.projectId);
    const db = getDb();
    let createdTag: ElementTag | null = null;
    const updatedAt = new Date().toISOString();


    return withOptimisticUpdate({
      apply: () => {},
      rollback: () => {},
      effect: async () => {
        await db.transaction(async (tx) => {
          const tagRepoTx = createElementTagRepository(tx);
          const tagLinkRepoTx = createElementTagLinkRepository(tx);
          const elementRepoTx = createBookElementSqliteRepository(projectId, tx);

          let tag = await tagRepoTx.findByName(projectId, input.name);
          if (!tag) {
            tag = await tagRepoTx.create({
              id: uuidv7(),
              projectId,
              name: input.name,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          }

          const updated = await elementRepoTx.update(elementId, { updatedAt });
          if (!updated) throw new Error(`Element with id ${elementId} not found`);
          await tagLinkRepoTx.addTagToElement(elementId, tag.id);
          createdTag = tag;
        });
        return createdTag;
      },
      onSuccess: (tag) => {
        if (!tag) return;
        const latestCurrent = useDataStore.getState().bookElements.find(el => el.id === elementId);
        
        const nextTagIds = latestCurrent
          ? (latestCurrent.tagIds.includes(tag.id) ? latestCurrent.tagIds : [...latestCurrent.tagIds, tag.id])
          : null;
          
        if (nextTagIds) updateElementTagIdsInStore(elementId, nextTagIds, updatedAt);
      },
    });
  }, [ensureDb, updateElementTagIdsInStore]);

  
  return useMemo(() => ({
    loadTags,
    getTagById,
    createTag,
    deleteTag,
    getTagsForElement,
    getElementsWithTag,
    addTagToElement,
    removeTagFromElement,
    setElementTags,
    createAndAddTagToElement,
  }), [
    loadTags,
    getTagById,
    createTag,
    deleteTag,
    getTagsForElement,
    getElementsWithTag,
    addTagToElement,
    removeTagFromElement,
    setElementTags,
    createAndAddTagToElement,
  ]);
}
