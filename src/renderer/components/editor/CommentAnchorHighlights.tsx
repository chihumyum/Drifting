import { useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import type { CommentTargetKind } from '../../domain/comment';
import {
  CommentHighlightPainter,
  getActiveCommentHighlight,
  subscribeActiveCommentHighlight,
} from '../../lib/comment-highlight';
import { useDataStore } from '../../store/data-store';
import { createCommentHighlightSelector } from './comment-highlight-model';
import { useEditorSurfaceLifecycle } from './editor-surface-lifecycle-context';

interface CommentAnchorHighlightsProps {
  scrollEl: HTMLElement | null;
  projectId: string;
  targetKind: CommentTargetKind;
  /** `null` paints every target of the kind (the whole-book reader). */
  targetId: string | null;
}

const getNoActiveComment = () => null;

/** Washes prose anchored by unresolved notes and TODOs and strengthens the
 * hovered card's anchor. Painting never mutates the DOM; hidden surfaces
 * release their ranges and stop observing prose mutations. */
export function CommentAnchorHighlights({ scrollEl, projectId, targetKind, targetId }: CommentAnchorHighlightsProps) {
  const { isVisible, isPreparing } = useEditorSurfaceLifecycle();
  const selectComments = useMemo(() => createCommentHighlightSelector(projectId, targetKind, targetId),
    [projectId, targetKind, targetId]);
  const comments = useDataStore(selectComments);
  const activeId = useSyncExternalStore(subscribeActiveCommentHighlight, getActiveCommentHighlight,
    getNoActiveComment);
  const painter = useMemo(() => scrollEl ? new CommentHighlightPainter(scrollEl) : null, [scrollEl]);
  const presented = isVisible || isPreparing;
  useLayoutEffect(() => (presented ? painter?.attach() : undefined), [painter, presented]);
  useLayoutEffect(() => painter?.update(comments, activeId), [painter, comments, activeId]);
  return null;
}
