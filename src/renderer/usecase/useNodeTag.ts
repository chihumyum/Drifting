import { useMemo, useRef, useCallback } from 'react';
import { 
  createNodeTagRepository,
  createNodeTagLinkRepository,
} from '../repositories/story_stage_sqlite';
import { initDatabase } from '../lib/db';
import { useAuthStore, getProjectId } from '../store/auth';

const getProjectIdForUser = () => {
  const user = useAuthStore.getState().user;
  return getProjectId(user?.id);
};

export interface CreateNodeTagInput {
  projectId?: string;
  name: string;
  color?: string | null;
}

export function useNodeTag() {
  const tagRepoRef = useRef(createNodeTagRepository());
  const tagLinkRepoRef = useRef(createNodeTagLinkRepository());
  
  const tagRepo = tagRepoRef.current;
  const tagLinkRepo = tagLinkRepoRef.current;

  // Tag CRUD operations
  const loadTags = useCallback(async (projectId: string = getProjectIdForUser()) => {
    await initDatabase(projectId);
    return tagRepo.findAll(projectId);
  }, [tagRepo]);

  const getTagById = useCallback(async (id: string, projectId: string = getProjectIdForUser()) => {
    await initDatabase(projectId);
    return tagRepo.findById(id);
  }, [tagRepo]);

  const createTag = useCallback(async (input: CreateNodeTagInput) => {
    const projectId = input.projectId ?? getProjectIdForUser();
    await initDatabase(projectId);
    return tagRepo.create({
      projectId,
      name: input.name,
      color: input.color ?? null,
    });
  }, [tagRepo]);

  const deleteTag = useCallback(async (id: string, projectId: string = getProjectIdForUser()) => {
    await initDatabase(projectId);
    return tagRepo.delete(id);
  }, [tagRepo]);
  
  // Node-Tag link operations
  const getTagsForNode = useCallback(async (nodeId: string, projectId: string = getProjectIdForUser()) => {
    await initDatabase(projectId);
    return tagLinkRepo.findTagsByNodeId(nodeId);
  }, [tagLinkRepo]);

  const getNodesWithTag = useCallback(async (tagId: string, projectId: string = getProjectIdForUser()) => {
    await initDatabase(projectId);
    return tagLinkRepo.findNodeIdsByTagId(tagId);
  }, [tagLinkRepo]);

  const addTagToNode = useCallback(async (nodeId: string, tagId: string, projectId: string = getProjectIdForUser()) => {
    await initDatabase(projectId);
    return tagLinkRepo.addTagToNode(nodeId, tagId);
  }, [tagLinkRepo]);

  const removeTagFromNode = useCallback(async (nodeId: string, tagId: string, projectId: string = getProjectIdForUser()) => {
    await initDatabase(projectId);
    return tagLinkRepo.removeTagFromNode(nodeId, tagId);
  }, [tagLinkRepo]);

  const setNodeTags = useCallback(async (nodeId: string, tagIds: string[], projectId: string = getProjectIdForUser()) => {
    await initDatabase(projectId);
    // Remove all existing tags
    await tagLinkRepo.removeAllTagsFromNode(nodeId);
    
    // Add new tags
    for (const tagId of tagIds) {
      await tagLinkRepo.addTagToNode(nodeId, tagId);
    }
  }, [tagLinkRepo]);

  const createAndAddTagToNode = useCallback(async (nodeId: string, input: CreateNodeTagInput) => {
    const projectId = input.projectId ?? getProjectIdForUser();
    await initDatabase(projectId);
    
    // Try to find existing tag first
    let tag = await tagRepo.findByName(projectId, input.name);
    
    // If doesn't exist, create it
    if (!tag) {
      tag = await tagRepo.create({
        projectId,
        name: input.name,
        color: input.color ?? null,
      });
    }
    
    // Link tag to node
    await tagLinkRepo.addTagToNode(nodeId, tag.id);
    
    return tag;
  }, [tagRepo, tagLinkRepo]);

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
