// React hooks for Node Tag management
import { useMemo, useRef } from 'react';
import { 
  createNodeTagRepository,
  createNodeTagLinkRepository,
} from '../repositories/story_stage_sqlite';
import type { NodeTagUsecaseDeps } from '../usecase/story_stage';
import {
  loadNodeTags,
  getNodeTagById,
  createNodeTag,
  deleteNodeTag,
  getTagsForNode,
  getNodesWithTag,
  addTagToNode,
  removeTagFromNode,
  setNodeTags,
  createAndAddTagToNode,
  type CreateNodeTagInput,
} from '../usecase/story_stage';
import { initDatabase } from '../lib/db';
import { useAuthStore, getProjectId } from '../store/auth';

const getProjectIdForUser = () => {
  const user = useAuthStore.getState().user;
  return getProjectId(user?.id);
};

export function useNodeTagUsecases() {
  const depsRef = useRef<NodeTagUsecaseDeps | null>(null);

  if (!depsRef.current) {
    depsRef.current = {
      tagRepo: createNodeTagRepository(),
      tagLinkRepo: createNodeTagLinkRepository(),
      now: () => new Date(),
    };
  }

  const deps = depsRef.current!;

  return useMemo(() => ({
    // Tag CRUD operations
    loadTags: async (projectId: string = getProjectIdForUser()) => {
      await initDatabase(projectId);
      return loadNodeTags(deps, projectId);
    },
    getTagById: async (id: string, projectId: string = getProjectIdForUser()) => {
      await initDatabase(projectId);
      return getNodeTagById(deps, id);
    },
    createTag: async (input: CreateNodeTagInput) => {
      await initDatabase(input.projectId ?? getProjectIdForUser());
      return createNodeTag(deps, {
        ...input,
        projectId: input.projectId ?? getProjectIdForUser(),
      });
    },
    deleteTag: async (id: string, projectId: string = getProjectIdForUser()) => {
      await initDatabase(projectId);
      return deleteNodeTag(deps, id);
    },
    
    // Node-Tag link operations
    getTagsForNode: async (nodeId: string, projectId: string = getProjectIdForUser()) => {
      await initDatabase(projectId);
      return getTagsForNode(deps, nodeId);
    },
    getNodesWithTag: async (tagId: string, projectId: string = getProjectIdForUser()) => {
      await initDatabase(projectId);
      return getNodesWithTag(deps, tagId);
    },
    addTagToNode: async (nodeId: string, tagId: string, projectId: string = getProjectIdForUser()) => {
      await initDatabase(projectId);
      return addTagToNode(deps, nodeId, tagId);
    },
    removeTagFromNode: async (nodeId: string, tagId: string, projectId: string = getProjectIdForUser()) => {
      await initDatabase(projectId);
      return removeTagFromNode(deps, nodeId, tagId);
    },
    setNodeTags: async (nodeId: string, tagIds: string[], projectId: string = getProjectIdForUser()) => {
      await initDatabase(projectId);
      return setNodeTags(deps, nodeId, tagIds);
    },
    createAndAddTagToNode: async (nodeId: string, input: CreateNodeTagInput) => {
      await initDatabase(input.projectId ?? getProjectIdForUser());
      return createAndAddTagToNode(deps, nodeId, {
        ...input,
        projectId: input.projectId ?? getProjectIdForUser(),
      });
    },
    
    _deps: deps,
  }), [deps]);
}
