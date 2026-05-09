/**
 * Sync Helpers
 *
 * Convenience functions that build SyncMutation objects
 * for the entity sync service. Used by usecases.
 */

import {
  enqueueSyncMutation,
  type EntityType,
  type MutationType,
} from '../services/entity-sync.service';

export function enqueueSync(
  entityType: EntityType,
  mutationType: MutationType,
  entityId: string,
  projectId: string,
  payload?: Record<string, unknown>,
  parentId?: string,
): void {
  enqueueSyncMutation({
    entityType,
    mutationType,
    entityId,
    projectId,
    payload,
    parentId,
    timestamp: Date.now(),
  });
}

// ---- Per-entity convenience functions ----

export function syncProjectCreate(id: string, payload: Record<string, unknown>) {
  enqueueSync('project', 'create', id, id, payload);
}

export function syncProjectUpdate(id: string, payload: Record<string, unknown>) {
  enqueueSync('project', 'update', id, id, payload);
}

export function syncProjectDelete(id: string) {
  enqueueSync('project', 'delete', id, id);
}

export function syncNodeCreate(id: string, projectId: string, payload: Record<string, unknown>) {
  enqueueSync('node', 'create', id, projectId, payload);
}

export function syncNodeUpdate(id: string, projectId: string, payload: Record<string, unknown>) {
  enqueueSync('node', 'update', id, projectId, payload);
}

export function syncNodeDelete(id: string, projectId: string) {
  enqueueSync('node', 'delete', id, projectId);
}

export function syncNodeContentUpdate(
  nodeId: string,
  projectId: string,
  payload: Record<string, unknown>,
) {
  enqueueSync('nodeContent', 'update', nodeId, projectId, payload);
}

export function syncEdgeCreate(id: string, projectId: string, payload: Record<string, unknown>) {
  enqueueSync('nodeEdge', 'create', id, projectId, payload);
}

export function syncEdgeUpdate(id: string, projectId: string, payload: Record<string, unknown>) {
  enqueueSync('nodeEdge', 'update', id, projectId, payload);
}

export function syncEdgeDelete(id: string, projectId: string) {
  enqueueSync('nodeEdge', 'delete', id, projectId);
}

export function syncStorylineCreate(
  id: string,
  projectId: string,
  payload: Record<string, unknown>,
) {
  enqueueSync('storyline', 'create', id, projectId, payload);
}

export function syncStorylineUpdate(
  id: string,
  projectId: string,
  payload: Record<string, unknown>,
) {
  enqueueSync('storyline', 'update', id, projectId, payload);
}

export function syncStorylineDelete(id: string, projectId: string) {
  enqueueSync('storyline', 'delete', id, projectId);
}

export function syncNodeStorylineLinkCreate(
  nodeId: string,
  storylineId: string,
  projectId: string,
) {
  enqueueSync('nodeStorylineLink', 'create', nodeId, projectId, undefined, storylineId);
}

export function syncNodeStorylineLinkDelete(
  nodeId: string,
  storylineId: string,
  projectId: string,
) {
  enqueueSync('nodeStorylineLink', 'delete', nodeId, projectId, undefined, storylineId);
}

export function syncNodeStorylinesSet(nodeId: string, projectId: string, storylineIds: string[]) {
  enqueueSync('nodeStorylineLink', 'update', nodeId, projectId, { storylineIds });
}

export function syncElementCreate(id: string, projectId: string, payload: Record<string, unknown>) {
  enqueueSync('element', 'create', id, projectId, payload);
}

export function syncElementUpdate(id: string, projectId: string, payload: Record<string, unknown>) {
  enqueueSync('element', 'update', id, projectId, payload);
}

export function syncElementDelete(id: string, projectId: string) {
  enqueueSync('element', 'delete', id, projectId);
}

export function syncCategoryCreate(
  id: string,
  projectId: string,
  payload: Record<string, unknown>,
) {
  enqueueSync('elementCategory', 'create', id, projectId, payload);
}

export function syncCategoryUpdate(
  id: string,
  projectId: string,
  payload: Record<string, unknown>,
) {
  enqueueSync('elementCategory', 'update', id, projectId, payload);
}

export function syncCategoryDelete(id: string, projectId: string) {
  enqueueSync('elementCategory', 'delete', id, projectId);
}

export function syncStageCreate(id: string, projectId: string, payload: Record<string, unknown>) {
  enqueueSync('storyStage', 'create', id, projectId, payload);
}

export function syncStageUpdate(id: string, projectId: string, payload: Record<string, unknown>) {
  enqueueSync('storyStage', 'update', id, projectId, payload);
}

export function syncStageDelete(id: string, projectId: string) {
  enqueueSync('storyStage', 'delete', id, projectId);
}

export function syncNodeTagCreate(id: string, projectId: string, payload: Record<string, unknown>) {
  enqueueSync('nodeTag', 'create', id, projectId, payload);
}

export function syncNodeTagDelete(id: string, projectId: string) {
  enqueueSync('nodeTag', 'delete', id, projectId);
}

export function syncNodeTagLinkCreate(nodeId: string, tagId: string, projectId: string) {
  enqueueSync('nodeTagLink', 'create', nodeId, projectId, undefined, tagId);
}

export function syncNodeTagLinkDelete(nodeId: string, tagId: string, projectId: string) {
  enqueueSync('nodeTagLink', 'delete', nodeId, projectId, undefined, tagId);
}

export function syncNodeTagsSet(nodeId: string, projectId: string, tagIds: string[]) {
  enqueueSync('nodeTagLink', 'update', nodeId, projectId, { tagIds });
}

export function syncElementTagCreate(
  id: string,
  projectId: string,
  payload: Record<string, unknown>,
) {
  enqueueSync('elementTag', 'create', id, projectId, payload);
}

export function syncElementTagDelete(id: string, projectId: string) {
  enqueueSync('elementTag', 'delete', id, projectId);
}

export function syncElementTagLinkCreate(elementId: string, tagId: string, projectId: string) {
  enqueueSync('elementTagLink', 'create', elementId, projectId, undefined, tagId);
}

export function syncElementTagLinkDelete(elementId: string, tagId: string, projectId: string) {
  enqueueSync('elementTagLink', 'delete', elementId, projectId, undefined, tagId);
}

export function syncElementTagsSet(elementId: string, projectId: string, tagIds: string[]) {
  enqueueSync('elementTagLink', 'update', elementId, projectId, { tagIds });
}
