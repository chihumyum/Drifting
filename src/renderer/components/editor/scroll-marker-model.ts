import { commentBlockIds, commentColorKey, type Comment, type CommentTargetKind } from '../../domain/comment';
import type { AgentBlockChange } from '../../lib/agent/block-diff';

export interface ScrollMarker {
  key: string;
  cls: string;
  laneCls: string;
  blockIds: readonly string[];
  titleKey: 'editorScrollMarkers.jumpToComment' | 'editorScrollMarkers.jumpToTodo' | 'editorScrollMarkers.jumpToChange';
}
export interface ScrollMarkerTick extends ScrollMarker { frac: number }
export const EMPTY_SCROLL_MARKERS: readonly ScrollMarkerTick[] = [];

export function sameScrollMarkers(a: readonly ScrollMarker[], b: readonly ScrollMarker[]): boolean {
  return a.length === b.length && a.every((marker, index) => {
    const other = b[index];
    return marker.key === other.key && marker.cls === other.cls && marker.laneCls === other.laneCls &&
      marker.titleKey === other.titleKey && marker.blockIds.length === other.blockIds.length &&
      marker.blockIds.every((id, blockIndex) => id === other.blockIds[blockIndex]);
  });
}

// One rebuildable lookup per immutable comments collection, shared by split and
// retained surfaces. Weak keys release old project/generation collections.
const commentIndexes = new WeakMap<readonly Comment[], Map<string, { comment: Comment; order: number }>>();
function commentIndex(comments: readonly Comment[]) {
  let index = commentIndexes.get(comments);
  if (!index) {
    index = new Map(comments.map((comment, order) => [comment.id, { comment, order }]));
    commentIndexes.set(comments, index);
  }
  return index;
}

/** Only membership, anchor and display semantics notify the marker consumer. */
export function createCommentMarkerSelector(projectId: string, kind: CommentTargetKind, id: string, visibleIds: readonly string[]) {
  let input: readonly Comment[] | undefined;
  let snapshot: readonly ScrollMarker[] = EMPTY_SCROLL_MARKERS;
  return (state: { comments: readonly Comment[] }): readonly ScrollMarker[] => {
    if (input === state.comments || visibleIds.length === 0) return snapshot;
    input = state.comments;
    const index = commentIndex(input);
    const candidates = [...new Set(visibleIds)].flatMap(id => {
      const record = index.get(id);
      return record ? [record] : [];
    }).sort((a, b) => a.order - b.order);
    const next: ScrollMarker[] = [];
    for (const { comment: c } of candidates) {
      if (c.projectId !== projectId || c.targetKind !== kind || c.targetId !== id ||
          c.targetBlockId === null || c.status === 'converted') continue;
      const blockIds = commentBlockIds(c);
      if (blockIds.length === 0) continue;
      next.push({ key: `c:${c.id}`, blockIds,
        cls: c.status === 'resolved' ? 'editor__scrollmap-tick--resolved' : `editor__scrollmap-tick--c-${commentColorKey(c)}`,
        laneCls: 'editor__scrollmap-tick--span',
        titleKey: c.kind === 'todo' ? 'editorScrollMarkers.jumpToTodo' : 'editorScrollMarkers.jumpToComment' });
    }
    if (!sameScrollMarkers(snapshot, next)) snapshot = next;
    return snapshot;
  };
}

/** The caller supplies one entity's changes, never the complete pending map. */
export function createAgentMarkerSelector() {
  let input: readonly AgentBlockChange[] | undefined;
  let snapshot: readonly ScrollMarker[] = EMPTY_SCROLL_MARKERS;
  return (changes: readonly AgentBlockChange[] | undefined): readonly ScrollMarker[] => {
    if (input === changes) return snapshot;
    input = changes;
    const next: ScrollMarker[] = [];
    for (const c of changes ?? []) {
      // Non-prose fields have no document anchor; deleted fields must not
      // accidentally become top-of-document ticks.
      if (c.field) continue;
      const anchor = c.op === 'deleted' ? c.afterPrevId : c.blockId;
      next.push({ key: `a:${c.op}:${c.blockId}`, blockIds: anchor ? [anchor] : [],
        cls: `editor__scrollmap-tick--agent-${c.op}`,
        laneCls: `editor__scrollmap-tick--lane${c.op === 'new' ? 0 : c.op === 'deleted' ? 2 : 1}`,
        titleKey: 'editorScrollMarkers.jumpToChange' });
    }
    if (!sameScrollMarkers(snapshot, next)) snapshot = next;
    return snapshot;
  };
}

export function scrollMarkerBlockSelector(id: string): string {
  const escaped = typeof CSS !== 'undefined' && 'escape' in CSS ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&');
  return `[data-block-id="${escaped}"]`;
}
