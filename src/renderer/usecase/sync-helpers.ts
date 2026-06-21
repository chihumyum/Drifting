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
// write — see PatchCreateModal, PatchesSection, PatchEditorCard, the patch
// invalidation recheck (usecase/patch-validity.ts), and the elementPatch
// Copilot capability.

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

// ---- Block Section ----
// Rolling block-range summaries produced as a side-effect of Copilot
// debounce runs. Sync semantics match elementPatch — local write first,
// outbox push, server hydrate restores anything the server didn't echo
// back (defensive against partial server rollout).

export function syncBlockSectionCreate(
  id: string,
  projectId: string,
  payload: Record<string, unknown>,
) {
  enqueueSync('blockSection', 'create', id, projectId, payload);
}

export function syncBlockSectionUpdate(
  id: string,
  projectId: string,
  payload: Record<string, unknown>,
) {
  enqueueSync('blockSection', 'update', id, projectId, payload);
}

export function syncBlockSectionDelete(id: string, projectId: string) {
  enqueueSync('blockSection', 'delete', id, projectId);
}

export function syncLibraryItemCreate(
  id: string,
  projectId: string,
  payload: Record<string, unknown>,
) {
  enqueueSync('libraryItem', 'create', id, projectId, payload);
}

export function syncLibraryItemUpdate(
  id: string,
  projectId: string,
  payload: Record<string, unknown>,
) {
  enqueueSync('libraryItem', 'update', id, projectId, payload);
}

export function syncLibraryItemDelete(id: string, projectId: string) {
  enqueueSync('libraryItem', 'delete', id, projectId);
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

export function syncCommentCreate(
  id: string,
  projectId: string,
  payload: Record<string, unknown>,
) {
  enqueueSync('comment', 'create', id, projectId, payload);
}

export function syncCommentUpdate(
  id: string,
  projectId: string,
  payload: Record<string, unknown>,
) {
  enqueueSync('comment', 'update', id, projectId, payload);
}

export function syncCommentDelete(id: string, projectId: string) {
  enqueueSync('comment', 'delete', id, projectId);
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

// ---- Book Act (幕) ----
// Boundary-based segments of the global reading axis. Plain scalar rows —
// last-write-wins like everything else. All write sites live in
// usecase/useBookAct.ts.

export function syncBookActCreate(
  id: string,
  projectId: string,
  payload: Record<string, unknown>,
) {
  enqueueSync('bookAct', 'create', id, projectId, payload);
}

export function syncBookActUpdate(
  id: string,
  projectId: string,
  payload: Record<string, unknown>,
) {
  enqueueSync('bookAct', 'update', id, projectId, payload);
}

export function syncBookActDelete(id: string, projectId: string) {
  enqueueSync('bookAct', 'delete', id, projectId);
}

// ---- Drift Group (左栏分组) ----
// Nested folders for drift nodes. Plain scalar rows — last-write-wins like
// bookAct. Nesting / reparent-on-delete is client-side; the server stores the
// row. All write sites live in usecase/useDriftGroup.ts. (Drift membership
// itself rides the node update — book_node.drift_group_id — not these.)

export function syncDriftGroupCreate(
  id: string,
  projectId: string,
  payload: Record<string, unknown>,
) {
  enqueueSync('driftGroup', 'create', id, projectId, payload);
}

export function syncDriftGroupUpdate(
  id: string,
  projectId: string,
  payload: Record<string, unknown>,
) {
  enqueueSync('driftGroup', 'update', id, projectId, payload);
}

export function syncDriftGroupDelete(id: string, projectId: string) {
  enqueueSync('driftGroup', 'delete', id, projectId);
}

// ---- Timeline Marker ----
// Narrative-axis time pins, promoted from localStorage to a synced table
// because drift binding is a cross-device fact. Write sites:
// hooks/useTimelineMarkers.ts (incl. the one-time localStorage import and
// unbindMarkersForDrift).

export function syncTimelineMarkerCreate(
  id: string,
  projectId: string,
  payload: Record<string, unknown>,
) {
  enqueueSync('timelineMarker', 'create', id, projectId, payload);
}

export function syncTimelineMarkerUpdate(
  id: string,
  projectId: string,
  payload: Record<string, unknown>,
) {
  enqueueSync('timelineMarker', 'update', id, projectId, payload);
}

export function syncTimelineMarkerDelete(id: string, projectId: string) {
  enqueueSync('timelineMarker', 'delete', id, projectId);
}

// ---- Agent Memory ----
// Author-level standing guidance (preferences / vetoes / directives) the General
// agent persists. Local-first like the rest; soft-delete travels as an `update`
// carrying deletedAt (no separate softDelete mutation — the server has no trash
// route for memory). All write sites in useAgentMemory call these.

export function syncAgentMemoryCreate(
  id: string,
  projectId: string,
  payload: Record<string, unknown>,
) {
  enqueueSync('agentMemory', 'create', id, projectId, payload);
}

export function syncAgentMemoryUpdate(
  id: string,
  projectId: string,
  payload: Record<string, unknown>,
) {
  enqueueSync('agentMemory', 'update', id, projectId, payload);
}

export function syncAgentMemoryDelete(id: string, projectId: string) {
  enqueueSync('agentMemory', 'delete', id, projectId);
}
