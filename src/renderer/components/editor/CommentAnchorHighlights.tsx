import { useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import type { CommentTargetKind } from '../../domain/comment';
import {
  CommentHighlightPainter,
  getActiveCommentHighlight,
  getSelectedCommentHighlight,
  subscribeActiveCommentHighlight,
  subscribeSelectedCommentHighlight,
} from '../../lib/comment-highlight';
import { CommentSandPainter } from '../../lib/comment-sand';
import { getPlatformRuntime } from '../../platform/runtime';
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

/** Draws prose anchored by unresolved notes and TODOs and strengthens the
 * hovered or selected card's anchor: in sand under the prose on the desktop,
 * as a `::highlight()` wash in the paused mobile shell. Painting never mutates
 * the prose DOM; hidden surfaces stop observing prose mutations. */
export function CommentAnchorHighlights({ scrollEl, projectId, targetKind, targetId }: CommentAnchorHighlightsProps) {
  const { isVisible, isPreparing } = useEditorSurfaceLifecycle();
  const selectComments = useMemo(() => createCommentHighlightSelector(projectId, targetKind, targetId),
    [projectId, targetKind, targetId]);
  const comments = useDataStore(selectComments);
  const activeId = useSyncExternalStore(subscribeActiveCommentHighlight, getActiveCommentHighlight,
    getNoActiveComment);
  const selected = useSyncExternalStore(subscribeSelectedCommentHighlight, getSelectedCommentHighlight,
    getNoActiveComment);
  const painter = useMemo(() => {
    if (!scrollEl) return null;
    return getPlatformRuntime().isMobileShell
      ? new CommentHighlightPainter(scrollEl)
      : new CommentSandPainter(scrollEl);
  }, [scrollEl]);
  const presented = isVisible || isPreparing;
  useLayoutEffect(() => (presented ? painter?.attach() : undefined), [painter, presented]);
  useLayoutEffect(() => {
    if (painter instanceof CommentSandPainter) painter.update(comments, activeId, selected);
    else painter?.update(comments, activeId);
  }, [painter, comments, activeId, selected]);
  useLayoutEffect(() => () => {
    if (painter instanceof CommentSandPainter) painter.dispose();
  }, [painter]);
  return null;
}
