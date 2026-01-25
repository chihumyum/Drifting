import { useMemo, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { createBookElementSqliteRepository } from '../sqlite-repo/element-repo';
import { createElementTagRepository, createElementTagLinkRepository } from '../sqlite-repo/element-tag-repo';
import { initDatabase, getDb } from '../lib/db';
import type { ElementTag } from '../domain/element-tag';
import { useDataStore } from '../store/data-store';

export interface CreateElementTagInput {
  projectId?: string;
  name: string;
  color?: string | null;
}

export function useElementTag() {
  const { projectId: routeProjectId } = useParams<{ projectId: string }>();
  const tagRepoRef = useRef(createElementTagRepository());
  const tagLinkRepoRef = useRef(createElementTagLinkRepository());

  const tagRepo = tagRepoRef.current;
  const tagLinkRepo = tagLinkRepoRef.current;
  type DbClient = ReturnType<typeof getDb>;

  const ensureProjectId = useCallback((projectId?: string) => {
    const pid = projectId ?? routeProjectId;
    if (!pid) {
      throw new Error('Project ID is required to load tags');
    }
    return pid;
  }, [routeProjectId]);

  const ensureDb = useCallback(async (projectId?: string) => {
    const pid = ensureProjectId(projectId);
    await initDatabase(pid);
    return pid;
  }, [ensureProjectId]);

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
      projectId,
      name: input.name,
      color: input.color ?? null,
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
    await db.transaction(async (tx) => {
      const elementRepoTx = createBookElementSqliteRepository(pid, tx as DbClient);
      const tagLinkRepoTx = createElementTagLinkRepository(tx as DbClient);
      const updated = await elementRepoTx.update(elementId, { updatedAt });
      if (!updated) throw new Error(`Element with id ${elementId} not found`);
      await tagLinkRepoTx.addTagToElement(elementId, tagId);
    });

    const current = useDataStore.getState().bookElements.find(el => el.id === elementId);
    if (!current) return;
    const nextTagIds = current.tagIds.includes(tagId) ? current.tagIds : [...current.tagIds, tagId];
    updateElementTagIdsInStore(elementId, nextTagIds, updatedAt);
  }, [ensureDb, updateElementTagIdsInStore]);

  const removeTagFromElement = useCallback(async (elementId: string, tagId: string, projectId?: string) => {
    const pid = await ensureDb(projectId);
    const db = getDb();
    const updatedAt = new Date().toISOString();
    await db.transaction(async (tx) => {
      const elementRepoTx = createBookElementSqliteRepository(pid, tx as DbClient);
      const tagLinkRepoTx = createElementTagLinkRepository(tx as DbClient);
      const updated = await elementRepoTx.update(elementId, { updatedAt });
      if (!updated) throw new Error(`Element with id ${elementId} not found`);
      await tagLinkRepoTx.removeTagFromElement(elementId, tagId);
    });

    const current = useDataStore.getState().bookElements.find(el => el.id === elementId);
    if (!current) return;
    const nextTagIds = current.tagIds.filter(id => id !== tagId);
    updateElementTagIdsInStore(elementId, nextTagIds, updatedAt);
  }, [ensureDb, updateElementTagIdsInStore]);

  const setElementTags = useCallback(async (elementId: string, tagIds: string[], projectId?: string) => {
    const pid = await ensureDb(projectId);
    const db = getDb();
    const updatedAt = new Date().toISOString();
    await db.transaction(async (tx) => {
      const elementRepoTx = createBookElementSqliteRepository(pid, tx as DbClient);
      const tagLinkRepoTx = createElementTagLinkRepository(tx as DbClient);
      const updated = await elementRepoTx.update(elementId, { updatedAt });
      if (!updated) throw new Error(`Element with id ${elementId} not found`);
      await tagLinkRepoTx.setTagsForElement(elementId, tagIds);
    });

    updateElementTagIdsInStore(elementId, tagIds, updatedAt);
  }, [ensureDb, updateElementTagIdsInStore]);

  const createAndAddTagToElement = useCallback(async (elementId: string, input: CreateElementTagInput) => {
    const projectId = await ensureDb(input.projectId);
    const db = getDb();
    let createdTag: ElementTag | null = null;
    const updatedAt = new Date().toISOString();

    await db.transaction(async (tx) => {
      const tagRepoTx = createElementTagRepository(tx as DbClient);
      const tagLinkRepoTx = createElementTagLinkRepository(tx as DbClient);
      const elementRepoTx = createBookElementSqliteRepository(projectId, tx as DbClient);

      let tag = await tagRepoTx.findByName(projectId, input.name);
      if (!tag) {
        tag = await tagRepoTx.create({
          projectId,
          name: input.name,
          color: input.color ?? null,
        });
      }

      const updated = await elementRepoTx.update(elementId, { updatedAt });
      if (!updated) throw new Error(`Element with id ${elementId} not found`);
      await tagLinkRepoTx.addTagToElement(elementId, tag.id);
      createdTag = tag;
    });

    if (createdTag) {
      const current = useDataStore.getState().bookElements.find(el => el.id === elementId);
      if (current) {
        const nextTagIds = current.tagIds.includes(createdTag.id)
          ? current.tagIds
          : [...current.tagIds, createdTag.id];
        updateElementTagIdsInStore(elementId, nextTagIds, updatedAt);
      }
    }

    return createdTag;
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
