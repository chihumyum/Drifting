import { useMemo, useRef, useCallback } from 'react';
import { createBookNodeSqliteRepository } from '../sqlite-repo/node-repo';
import { createNodeTagRepository, createNodeTagLinkRepository } from '../sqlite-repo/node-tag-repo';
import { initDatabase, getDb } from '../lib/db';
import type { NodeTag } from '../domain/node-tag';
import { v7 as uuidv7 } from 'uuid';
import {
  syncNodeTagCreate,
  syncNodeTagDelete,
  syncNodeTagLinkCreate,
  syncNodeTagLinkDelete,
  syncNodeTagsSet,
} from './sync-helpers';

export interface CreateNodeTagInput {
  projectId?: string;
  name: string;
}

export interface UseNodeTagContext {
  projectId: string;
  userId: string;
}

export function useNodeTag({ projectId, userId }: UseNodeTagContext) {
  const activeProjectId = projectId;
  if (!activeProjectId) {
    throw new Error('useNodeTag requires a projectId');
  }
  if (!userId) {
    throw new Error('useNodeTag requires a userId');
  }
  const tagRepoRef = useRef(createNodeTagRepository());
  const tagLinkRepoRef = useRef(createNodeTagLinkRepository());

  const tagRepo = tagRepoRef.current;
  const tagLinkRepo = tagLinkRepoRef.current;

  const ensureProjectId = useCallback(
    (projectId?: string) => {
      const pid = projectId ?? activeProjectId;
      if (!pid) {
        throw new Error('Project ID is required to load tags');
      }
      return pid;
    },
    [activeProjectId],
  );

  const ensureDb = useCallback(
    async (projectId?: string) => {
      const pid = ensureProjectId(projectId);
      await initDatabase(userId);
      return pid;
    },
    [ensureProjectId, userId],
  );

  // Tag CRUD operations
  const loadTags = useCallback(
    async (projectId?: string) => {
      const pid = await ensureDb(projectId);
      return tagRepo.findAll(pid);
    },
    [tagRepo, ensureDb],
  );

  const getTagById = useCallback(
    async (id: string, projectId?: string) => {
      await ensureDb(projectId);
      return tagRepo.findById(id);
    },
    [tagRepo, ensureDb],
  );

  const createTag = useCallback(
    async (input: CreateNodeTagInput) => {
      const projectId = await ensureDb(input.projectId);
      const tag = await tagRepo.create({
        id: uuidv7(),
        projectId: projectId,
        name: input.name,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      syncNodeTagCreate(tag.id, projectId, { id: tag.id, name: tag.name });
      return tag;
    },
    [tagRepo, ensureDb],
  );

  const deleteTag = useCallback(
    async (id: string, projectId?: string) => {
      const pid = await ensureDb(projectId);
      const result = await tagRepo.delete(id);
      syncNodeTagDelete(id, pid);
      return result;
    },
    [tagRepo, ensureDb],
  );

  // Node-Tag link operations
  const getTagsForNode = useCallback(
    async (nodeId: string, projectId?: string) => {
      await ensureDb(projectId);
      return tagLinkRepo.findTagsByNodeId(nodeId);
    },
    [tagLinkRepo, ensureDb],
  );

  const getNodesWithTag = useCallback(
    async (tagId: string, projectId?: string) => {
      await ensureDb(projectId);
      return tagLinkRepo.findNodeIdsByTagId(tagId);
    },
    [tagLinkRepo, ensureDb],
  );

  const addTagToNode = useCallback(
    async (nodeId: string, tagId: string, projectId?: string) => {
      const pid = await ensureDb(projectId);
      const db = getDb();
      await db.transaction(async (tx) => {
        const nodeRepoTx = createBookNodeSqliteRepository(pid, tx);
        const tagLinkRepoTx = createNodeTagLinkRepository(tx);
        const updated = await nodeRepoTx.update(nodeId, { updatedAt: new Date().toISOString() });
        if (!updated) throw new Error(`Node with id ${nodeId} not found`);
        await tagLinkRepoTx.addTagToNode(nodeId, tagId);
      });
      syncNodeTagLinkCreate(nodeId, tagId, pid);
    },
    [ensureDb],
  );

  const removeTagFromNode = useCallback(
    async (nodeId: string, tagId: string, projectId?: string) => {
      const pid = await ensureDb(projectId);
      const db = getDb();
      await db.transaction(async (tx) => {
        const nodeRepoTx = createBookNodeSqliteRepository(pid, tx);
        const tagLinkRepoTx = createNodeTagLinkRepository(tx);
        const updated = await nodeRepoTx.update(nodeId, { updatedAt: new Date().toISOString() });
        if (!updated) throw new Error(`Node with id ${nodeId} not found`);
        await tagLinkRepoTx.removeTagFromNode(nodeId, tagId);
      });
      syncNodeTagLinkDelete(nodeId, tagId, pid);
    },
    [ensureDb],
  );

  const setNodeTags = useCallback(
    async (nodeId: string, tagIds: string[], projectId?: string) => {
      const pid = await ensureDb(projectId);
      const db = getDb();
      await db.transaction(async (tx) => {
        const nodeRepoTx = createBookNodeSqliteRepository(pid, tx);
        const tagLinkRepoTx = createNodeTagLinkRepository(tx);
        const updated = await nodeRepoTx.update(nodeId, { updatedAt: new Date().toISOString() });
        if (!updated) throw new Error(`Node with id ${nodeId} not found`);
        await tagLinkRepoTx.removeAllTagsFromNode(nodeId);
        for (const tagId of tagIds) {
          await tagLinkRepoTx.addTagToNode(nodeId, tagId);
        }
      });
      syncNodeTagsSet(nodeId, pid, tagIds);
    },
    [ensureDb],
  );

  const createAndAddTagToNode = useCallback(
    async (nodeId: string, input: CreateNodeTagInput) => {
      const projectId = await ensureDb(input.projectId);
      const db = getDb();
      let createdTag: NodeTag | null = null;

      await db.transaction(async (tx) => {
        const tagRepoTx = createNodeTagRepository(tx);
        const tagLinkRepoTx = createNodeTagLinkRepository(tx);
        const nodeRepoTx = createBookNodeSqliteRepository(projectId, tx);

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

        const updated = await nodeRepoTx.update(nodeId, { updatedAt: new Date().toISOString() });
        if (!updated) throw new Error(`Node with id ${nodeId} not found`);
        await tagLinkRepoTx.addTagToNode(nodeId, tag.id);
        createdTag = tag;
      });

      return createdTag;
    },
    [ensureDb],
  );

  return useMemo(
    () => ({
      loadTags,
      getTagById,
      createTag,
      deleteTag,
      getTagsForNode,
      getNodesWithTag,
      addTagToNode,
      removeTagFromNode,
      setNodeTags,
      createAndAddTagToNode,
    }),
    [
      loadTags,
      getTagById,
      createTag,
      deleteTag,
      getTagsForNode,
      getNodesWithTag,
      addTagToNode,
      removeTagFromNode,
      setNodeTags,
      createAndAddTagToNode,
    ],
  );
}
