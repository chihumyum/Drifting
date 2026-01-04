// Use cases for Story Stage and Node Tag management
import type { StoryStage, NodeTag } from '../domain/story_stage';
import type { 
  StoryStageRepository, 
  NodeTagRepository, 
  NodeTagLinkRepository 
} from '../repositories/story_stage';

// ==================== Dependencies ====================

export interface StoryStageUsecaseDeps {
  stageRepo: StoryStageRepository;
  now?: () => Date;
}

export interface NodeTagUsecaseDeps {
  tagRepo: NodeTagRepository;
  tagLinkRepo: NodeTagLinkRepository;
  now?: () => Date;
}

// ==================== Story Stage Use Cases ====================

export async function loadStoryStages(
  deps: StoryStageUsecaseDeps,
  projectId: string
): Promise<StoryStage[]> {
  return deps.stageRepo.findAll(projectId);
}

export async function getStoryStageById(
  deps: StoryStageUsecaseDeps,
  id: string
): Promise<StoryStage | null> {
  return deps.stageRepo.findById(id);
}

export interface CreateStoryStageInput {
  projectId: string;
  name: string;
  description?: string | null;
  orderKey?: number;
  color?: string | null;
}

export async function createStoryStage(
  deps: StoryStageUsecaseDeps,
  input: CreateStoryStageInput
): Promise<StoryStage> {
  // If orderKey not provided, get max and add 1
  const stages = await deps.stageRepo.findAll(input.projectId);
  const maxOrder = stages.reduce((max, stage) => Math.max(max, stage.orderKey), 0);
  const orderKey = input.orderKey ?? maxOrder + 1;

  return deps.stageRepo.create({
    projectId: input.projectId,
    name: input.name,
    description: input.description ?? null,
    orderKey,
    color: input.color ?? null,
  });
}

export interface UpdateStoryStageInput {
  name?: string;
  description?: string | null;
  orderKey?: number;
  color?: string | null;
}

export async function updateStoryStage(
  deps: StoryStageUsecaseDeps,
  id: string,
  input: UpdateStoryStageInput
): Promise<StoryStage | null> {
  return deps.stageRepo.update(id, input);
}

export async function deleteStoryStage(
  deps: StoryStageUsecaseDeps,
  id: string
): Promise<boolean> {
  return deps.stageRepo.delete(id);
}

export async function reorderStoryStage(
  deps: StoryStageUsecaseDeps,
  projectId: string,
  id: string,
  direction: 'up' | 'down'
): Promise<void> {
  const stages = await deps.stageRepo.findAll(projectId);
  const sortedStages = stages.slice().sort((a, b) => a.orderKey - b.orderKey);
  const index = sortedStages.findIndex((stage) => stage.id === id);
  
  if (index === -1) return;
  
  const swapIndex = direction === 'up' ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= sortedStages.length) return;

  const current = sortedStages[index];
  const target = sortedStages[swapIndex];
  
  // Swap order keys
  await deps.stageRepo.update(current.id, { orderKey: target.orderKey });
  await deps.stageRepo.update(target.id, { orderKey: current.orderKey });
}

// ==================== Node Tag Use Cases ====================

export async function loadNodeTags(
  deps: NodeTagUsecaseDeps,
  projectId: string
): Promise<NodeTag[]> {
  return deps.tagRepo.findAll(projectId);
}

export async function getNodeTagById(
  deps: NodeTagUsecaseDeps,
  id: string
): Promise<NodeTag | null> {
  return deps.tagRepo.findById(id);
}

export interface CreateNodeTagInput {
  projectId: string;
  name: string;
  color?: string | null;
}

export async function createNodeTag(
  deps: NodeTagUsecaseDeps,
  input: CreateNodeTagInput
): Promise<NodeTag> {
  // Check if tag with same name already exists
  const existing = await deps.tagRepo.findByName(input.projectId, input.name);
  if (existing) {
    throw new Error(`Tag with name "${input.name}" already exists in this project`);
  }

  return deps.tagRepo.create({
    projectId: input.projectId,
    name: input.name,
    color: input.color ?? null,
  });
}

export async function deleteNodeTag(
  deps: NodeTagUsecaseDeps,
  id: string
): Promise<boolean> {
  return deps.tagRepo.delete(id);
}

// ==================== Node-Tag Link Use Cases ====================

export async function getTagsForNode(
  deps: NodeTagUsecaseDeps,
  nodeId: string
): Promise<NodeTag[]> {
  return deps.tagLinkRepo.findTagsByNodeId(nodeId);
}

export async function getNodesWithTag(
  deps: NodeTagUsecaseDeps,
  tagId: string
): Promise<string[]> {
  return deps.tagLinkRepo.findNodeIdsByTagId(tagId);
}

export async function addTagToNode(
  deps: NodeTagUsecaseDeps,
  nodeId: string,
  tagId: string
): Promise<void> {
  await deps.tagLinkRepo.addTagToNode(nodeId, tagId);
}

export async function removeTagFromNode(
  deps: NodeTagUsecaseDeps,
  nodeId: string,
  tagId: string
): Promise<boolean> {
  return deps.tagLinkRepo.removeTagFromNode(nodeId, tagId);
}

export async function setNodeTags(
  deps: NodeTagUsecaseDeps,
  nodeId: string,
  tagIds: string[]
): Promise<void> {
  // Remove all existing tags
  await deps.tagLinkRepo.removeAllTagsFromNode(nodeId);
  
  // Add new tags
  for (const tagId of tagIds) {
    await deps.tagLinkRepo.addTagToNode(nodeId, tagId);
  }
}

export async function createAndAddTagToNode(
  deps: NodeTagUsecaseDeps,
  nodeId: string,
  input: CreateNodeTagInput
): Promise<NodeTag> {
  // Try to find existing tag first
  let tag = await deps.tagRepo.findByName(input.projectId, input.name);
  
  // If doesn't exist, create it
  if (!tag) {
    tag = await createNodeTag(deps, input);
  }
  
  // Link tag to node
  await deps.tagLinkRepo.addTagToNode(nodeId, tag.id);
  
  return tag;
}
