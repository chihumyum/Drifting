import { commentBlockIds, commentColorKey, isNoteTaskTodo, type Comment, type CommentTargetKind } from '../../domain/comment';
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

/** Only membership, anchor and display semantics notify the marker consumer.
 *  With the paper's comment toggle on, every open note and TODO anchored in
 *  this paper gets a tick, the same anchors the prose draws at rest; off, none. */
export function createCommentMarkerSelector(projectId: string, kind: CommentTargetKind, id: string, visible: boolean) {
  let input: readonly Comment[] | undefined;
  let snapshot: readonly ScrollMarker[] = EMPTY_SCROLL_MARKERS;
  return (state: { comments: readonly Comment[] }): readonly ScrollMarker[] => {
    if (input === state.comments || !visible) return snapshot;
    input = state.comments;
    const next: ScrollMarker[] = [];
    for (const c of input) {
      if (c.projectId !== projectId || c.targetKind !== kind || c.targetId !== id ||
          c.targetBlockId === null || c.status !== 'open' || isNoteTaskTodo(c)) continue;
      const blockIds = commentBlockIds(c);
      if (blockIds.length === 0) continue;
      next.push({ key: `c:${c.id}`, blockIds,
        cls: `editor__scrollmap-tick--c-${commentColorKey(c)}`,
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
        cls: `editor__scrollmap-tick--agent-${c.op}${c.source === 'file' ? ' editor__scrollmap-tick--external' : ''}`,
        laneCls: `editor__scrollmap-tick--lane${c.op === 'new' ? 0 : c.op === 'deleted' ? 2 : 1}`,
        titleKey: 'editorScrollMarkers.jumpToChange' });
    }
    if (!sameScrollMarkers(snapshot, next)) snapshot = next;
    return snapshot;
  };
}

/** Six sand seals; each tick is pressed once, its shape and turn fixed by its key. */
export const SCROLL_MARKER_SEALS = 6;

export function scrollMarkerSeal(key: string): { shape: number; turn: number } {
  // FNV-1a: stable across sessions, so a tick never changes its seal on reload.
  let hash = 2166136261;
  for (let index = 0; index < key.length; index++) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  hash >>>= 0;
  return { shape: hash % SCROLL_MARKER_SEALS, turn: Math.floor(hash / SCROLL_MARKER_SEALS) % 360 };
}

export function scrollMarkerBlockSelector(id: string): string {
  const escaped = typeof CSS !== 'undefined' && 'escape' in CSS ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&');
  return `[data-block-id="${escaped}"]`;
}
