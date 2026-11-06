import { useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import type { CommentTargetKind } from '../../domain/comment';
import {
  getActiveCommentHighlight,
  getPointedCommentHighlights,
  getSelectedCommentHighlight,
  subscribeActiveCommentHighlight,
  subscribePointedCommentHighlights,
  subscribeSelectedCommentHighlight,
} from '../../lib/comment-highlight';
import { CommentSandPainter } from '../../lib/comment-sand';
import { useDataStore } from '../../store/data-store';
import { useSettingsStore } from '../../store/settings-store';
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
const NO_POINTED: readonly string[] = [];
const getNoPointedComments = () => NO_POINTED;

/** Draws prose anchored by unresolved notes and TODOs and strengthens the
 * anchor of a hovered or selected card, or one pointed at in the prose (whose
 * card lights up in turn): in sand under the prose on the desktop,
 * as a `::highlight()` wash in the paused mobile shell. With the paper's
 * comment toggle off only that hovered or selected anchor is drawn; the rest
 * fade out. Painting never mutates the prose DOM; hidden surfaces stop
 * observing prose mutations. */
export function CommentAnchorHighlights({ scrollEl, projectId, targetKind, targetId }: CommentAnchorHighlightsProps) {
  const { isVisible, isPreparing } = useEditorSurfaceLifecycle();
  const selectComments = useMemo(() => createCommentHighlightSelector(projectId, targetKind, targetId),
    [projectId, targetKind, targetId]);
  const anchored = useDataStore(selectComments);
  const marksVisible = useSettingsStore((state) => state.commentMarksVisible);
  const activeId = useSyncExternalStore(subscribeActiveCommentHighlight, getActiveCommentHighlight,
    getNoActiveComment);
  const selected = useSyncExternalStore(subscribeSelectedCommentHighlight, getSelectedCommentHighlight,
    getNoActiveComment);
  const pointed = useSyncExternalStore(subscribePointedCommentHighlights, getPointedCommentHighlights,
    getNoPointedComments);
  const comments = useMemo(
    () => marksVisible ? anchored
      : anchored.filter((comment) => comment.id === activeId || comment.id === selected?.id),
    [activeId, anchored, marksVisible, selected],
  );
  const painter = useMemo(() => (scrollEl ? new CommentSandPainter(scrollEl) : null), [scrollEl]);
  const presented = isVisible || isPreparing;
  useLayoutEffect(() => (presented ? painter?.attach() : undefined), [painter, presented]);
  useLayoutEffect(() => {
    painter?.update(comments, activeId, selected, pointed);
  }, [painter, comments, activeId, selected, pointed]);
  useLayoutEffect(() => () => {
    painter?.dispose();
  }, [painter]);
  return null;
}
