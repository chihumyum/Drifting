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

export function syncMemoCreate(id: string, projectId: string, payload: Record<string, unknown>) {
  enqueueSync('memo', 'create', id, projectId, payload);
}

export function syncMemoUpdate(id: string, projectId: string, payload: Record<string, unknown>) {
  enqueueSync('memo', 'update', id, projectId, payload);
}

export function syncMemoDelete(id: string, projectId: string) {
  enqueueSync('memo', 'delete', id, projectId);
}

export function syncMaterialCreate(
  id: string,
  projectId: string,
  payload: Record<string, unknown>,
) {
  enqueueSync('material', 'create', id, projectId, payload);
}

export function syncMaterialUpdate(
  id: string,
  projectId: string,
  payload: Record<string, unknown>,
) {
  enqueueSync('material', 'update', id, projectId, payload);
}

export function syncMaterialDelete(id: string, projectId: string) {
  enqueueSync('material', 'delete', id, projectId);
}

export function syncEntityReferenceCreate(
  id: string,
  projectId: string,
  payload: Record<string, unknown>,
) {
  enqueueSync('entityReference', 'create', id, projectId, payload);
}

export function syncEntityReferenceUpdate(
  id: string,
  projectId: string,
  payload: Record<string, unknown>,
) {
  enqueueSync('entityReference', 'update', id, projectId, payload);
}

export function syncEntityReferenceDelete(id: string, projectId: string) {
  enqueueSync('entityReference', 'delete', id, projectId);
}

export function syncManuscriptCommentCreate(
  id: string,
  projectId: string,
  payload: Record<string, unknown>,
) {
  enqueueSync('manuscriptComment', 'create', id, projectId, payload);
}

export function syncManuscriptCommentUpdate(
  id: string,
  projectId: string,
  payload: Record<string, unknown>,
) {
  enqueueSync('manuscriptComment', 'update', id, projectId, payload);
}

export function syncManuscriptCommentDelete(id: string, projectId: string) {
  enqueueSync('manuscriptComment', 'delete', id, projectId);
}

export function syncCommentActionCreate(
  id: string,
  projectId: string,
  payload: Record<string, unknown>,
) {
  enqueueSync('commentAction', 'create', id, projectId, payload);
}

export function syncCommentActionUpdate(
  id: string,
  projectId: string,
  payload: Record<string, unknown>,
) {
  enqueueSync('commentAction', 'update', id, projectId, payload);
}

export function syncCommentActionDelete(id: string, projectId: string) {
  enqueueSync('commentAction', 'delete', id, projectId);
}
