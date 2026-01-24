import { useMemo, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { createNodeTagRepository, createNodeTagLinkRepository } from '../repositories/story-stage-repo';
import { initDatabase } from '../lib/db';
import { useAuthStore } from '../store/auth';

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

  // Tag CRUD operations
  const loadTags = useCallback(async (projectId?: string) => {
    const pid = projectId ?? routeProjectId;
    if (!pid) {
      throw new Error('Project ID is required to load tags');
    }
    await initDatabase(pid);
    return tagRepo.findAll(pid);
  }, [tagRepo, routeProjectId]);

  const getTagById = useCallback(async (id: string, projectId?: string) => {
    const pid = projectId ?? routeProjectId;
    if (!pid) {
      throw new Error('Project ID is required to get tag');
    }
    await initDatabase(pid);
    return tagRepo.findById(id);
  }, [tagRepo, routeProjectId]);

  const createTag = useCallback(async (input: CreateNodeTagInput) => {
    const projectId = input.projectId ?? routeProjectId;
    if (!projectId) {
      throw new Error('Project ID is required to create tag');
    }
    await initDatabase(projectId);
    return tagRepo.create({
      projectId,
      name: input.name,
      color: input.color ?? null,
    });
  }, [tagRepo, routeProjectId]);

  const deleteTag = useCallback(async (id: string, projectId?: string) => {
    const pid = projectId ?? routeProjectId;
    if (!pid) {
      throw new Error('Project ID is required to delete tag');
    }
    await initDatabase(pid);
    return tagRepo.delete(id);
  }, [tagRepo, routeProjectId]);
  
  // Node-Tag link operations
  const getTagsForNode = useCallback(async (nodeId: string, projectId?: string) => {
    const pid = projectId ?? routeProjectId;
    if (!pid) {
      throw new Error('Project ID is required to get tags for node');
    }
    await initDatabase(pid);
    return tagLinkRepo.findTagsByNodeId(nodeId);
  }, [tagLinkRepo, routeProjectId]);

  const getNodesWithTag = useCallback(async (tagId: string, projectId?: string) => {
    const pid = projectId ?? routeProjectId;
    if (!pid) {
      throw new Error('Project ID is required to get nodes with tag');
    }
    await initDatabase(pid);
    return tagLinkRepo.findNodeIdsByTagId(tagId);
  }, [tagLinkRepo, routeProjectId]);

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
