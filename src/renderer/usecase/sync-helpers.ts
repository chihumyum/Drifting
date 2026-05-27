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

export function syncNodeSoftDelete(id: string, projectId: string) {
  enqueueSync('node', 'softDelete', id, projectId);
}

export function syncNodeRestore(id: string, projectId: string) {
  enqueueSync('node', 'restore', id, projectId);
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

export function syncStorylineSoftDelete(id: string, projectId: string) {
  enqueueSync('storyline', 'softDelete', id, projectId);
}

export function syncStorylineRestore(id: string, projectId: string) {
  enqueueSync('storyline', 'restore', id, projectId);
}

export function syncNodeStorylineLinkCreate(
  nodeId: string,
  storylineId: string,
  projectId: string,
  options?: { isPrimary?: boolean },
) {
  enqueueSync(
    'nodeStorylineLink',
    'create',
    nodeId,
    projectId,
    options?.isPrimary ? { isPrimary: true } : undefined,
    storylineId,
  );
}

export function syncNodeStorylineLinkDelete(
  nodeId: string,
  storylineId: string,
  projectId: string,
) {
  enqueueSync('nodeStorylineLink', 'delete', nodeId, projectId, undefined, storylineId);
}

export function syncNodeStorylinesSet(
  nodeId: string,
  projectId: string,
  storylineIds: string[],
  options?: { primaryStorylineId?: string | null },
) {
  enqueueSync('nodeStorylineLink', 'update', nodeId, projectId, {
    storylineIds,
    primaryStorylineId: options?.primaryStorylineId ?? null,
  });
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

export function syncElementSoftDelete(id: string, projectId: string) {
  enqueueSync('element', 'softDelete', id, projectId);
}

export function syncElementRestore(id: string, projectId: string) {
  enqueueSync('element', 'restore', id, projectId);
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

export function syncCategorySoftDelete(id: string, projectId: string) {
  enqueueSync('elementCategory', 'softDelete', id, projectId);
}

export function syncCategoryRestore(id: string, projectId: string) {
  enqueueSync('elementCategory', 'restore', id, projectId);
}

// ---- Element Patch ----
// Patches were originally local-only; these helpers + matching server
// routes (added 2026-05) finally close the multi-device sync loop.
// All client write sites for patches must call these alongside the repo
// write — see PatchTargetModal, PatchesSection, PatchEditorCard, and
// the elementPatch Copilot capability.

export function syncElementPatchCreate(
  id: string,
  projectId: string,
  payload: Record<string, unknown>,
) {
  enqueueSync('elementPatch', 'create', id, projectId, payload);
}

export function syncElementPatchUpdate(
  id: string,
  projectId: string,
  payload: Record<string, unknown>,
) {
  enqueueSync('elementPatch', 'update', id, projectId, payload);
}

export function syncElementPatchDelete(id: string, projectId: string) {
  enqueueSync('elementPatch', 'delete', id, projectId);
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

export function syncEntityRelationCreate(
  id: string,
  projectId: string,
  payload: Record<string, unknown>,
) {
  enqueueSync('entityRelation', 'create', id, projectId, payload);
}

export function syncEntityRelationUpdate(
  id: string,
  projectId: string,
  payload: Record<string, unknown>,
) {
  enqueueSync('entityRelation', 'update', id, projectId, payload);
}

export function syncEntityRelationDelete(id: string, projectId: string) {
  enqueueSync('entityRelation', 'delete', id, projectId);
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
