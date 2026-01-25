import { useMemo, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { createBookNodeSqliteRepository } from '../sqlite-repo/node-repo';
import { createNodeTagRepository, createNodeTagLinkRepository } from '../sqlite-repo/node-tag-repo';
import { initDatabase, getDb } from '../lib/db';
import type { NodeTag } from '../domain/node-tag';

export interface CreateNodeTagInput {
  projectId?: string;
  name: string;
  color?: string | null;
}

export function useNodeTag() {
  const { projectId: routeProjectId } = useParams<{ projectId: string }>();
  const tagRepoRef = useRef(createNodeTagRepository());
  const tagLinkRepoRef = useRef(createNodeTagLinkRepository());
  
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
  
  // Tag CRUD operations
  const loadTags = useCallback(async (projectId?: string) => {
    const pid = await ensureDb(projectId);
    return tagRepo.findAll(pid);
  }, [tagRepo, ensureDb]);

  const getTagById = useCallback(async (id: string, projectId?: string) => {
    await ensureDb(projectId);
    return tagRepo.findById(id);
  }, [tagRepo, ensureDb]);

  const createTag = useCallback(async (input: CreateNodeTagInput) => {
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
  
  // Node-Tag link operations
  const getTagsForNode = useCallback(async (nodeId: string, projectId?: string) => {
    await ensureDb(projectId);
    return tagLinkRepo.findTagsByNodeId(nodeId);
  }, [tagLinkRepo, ensureDb]);

  const getNodesWithTag = useCallback(async (tagId: string, projectId?: string) => {
    await ensureDb(projectId);
    return tagLinkRepo.findNodeIdsByTagId(tagId);
  }, [tagLinkRepo, ensureDb]);

  const addTagToNode = useCallback(async (nodeId: string, tagId: string, projectId?: string) => {
    const pid = await ensureDb(projectId);
    const db = getDb();
    await db.transaction(async (tx) => {
      const nodeRepoTx = createBookNodeSqliteRepository(pid, tx as DbClient);
      const tagLinkRepoTx = createNodeTagLinkRepository(tx as DbClient);
      const updated = await nodeRepoTx.update(nodeId, { updatedAt: new Date().toISOString() });
      if (!updated) throw new Error(`Node with id ${nodeId} not found`);
      await tagLinkRepoTx.addTagToNode(nodeId, tagId);
    });
  }, [ensureDb]);

  const removeTagFromNode = useCallback(async (nodeId: string, tagId: string, projectId?: string) => {
    const pid = await ensureDb(projectId);
    const db = getDb();
    await db.transaction(async (tx) => {
      const nodeRepoTx = createBookNodeSqliteRepository(pid, tx as DbClient);
      const tagLinkRepoTx = createNodeTagLinkRepository(tx as DbClient);
      const updated = await nodeRepoTx.update(nodeId, { updatedAt: new Date().toISOString() });
      if (!updated) throw new Error(`Node with id ${nodeId} not found`);
      await tagLinkRepoTx.removeTagFromNode(nodeId, tagId);
    });
  }, [ensureDb]);

  const setNodeTags = useCallback(async (nodeId: string, tagIds: string[], projectId?: string) => {
    const pid = await ensureDb(projectId);
    const db = getDb();
    await db.transaction(async (tx) => {
      const nodeRepoTx = createBookNodeSqliteRepository(pid, tx as DbClient);
      const tagLinkRepoTx = createNodeTagLinkRepository(tx as DbClient);
      const updated = await nodeRepoTx.update(nodeId, { updatedAt: new Date().toISOString() });
      if (!updated) throw new Error(`Node with id ${nodeId} not found`);
      await tagLinkRepoTx.removeAllTagsFromNode(nodeId);
      for (const tagId of tagIds) {
        await tagLinkRepoTx.addTagToNode(nodeId, tagId);
      }
    });
  }, [ensureDb]);

  const createAndAddTagToNode = useCallback(async (nodeId: string, input: CreateNodeTagInput) => {
    const projectId = await ensureDb(input.projectId);
    const db = getDb();
    let createdTag: NodeTag | null = null;

    await db.transaction(async (tx) => {
      const tagRepoTx = createNodeTagRepository(tx as DbClient);
      const tagLinkRepoTx = createNodeTagLinkRepository(tx as DbClient);
      const nodeRepoTx = createBookNodeSqliteRepository(projectId, tx as DbClient);

      let tag = await tagRepoTx.findByName(projectId, input.name);
      if (!tag) {
        tag = await tagRepoTx.create({
          projectId,
          name: input.name,
          color: input.color ?? null,
        });
      }

      const updated = await nodeRepoTx.update(nodeId, { updatedAt: new Date().toISOString() });
      if (!updated) throw new Error(`Node with id ${nodeId} not found`);
      await tagLinkRepoTx.addTagToNode(nodeId, tag.id);
      createdTag = tag;
    });

    return createdTag;
  }, [ensureDb]);

  return useMemo(() => ({
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
  }), [
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
  ]);
}
