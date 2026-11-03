import { useCallback, useMemo } from 'react';

import type { CommentTargetKind } from '../../domain/comment';
import { useDataStore } from '../../store/data-store';
import { useSettingsStore } from '../../store/settings-store';
import { createCommentHighlightSelector } from './comment-highlight-model';

/**
 * The paper's comment toggle: whether the prose draws its notes' and TODOs'
 * anchors at rest (one preference for every paper), and how many open ones
 * this paper holds. A pointed-at or selected card still draws its anchor.
 * `targetId === null` counts every target of the kind (the whole-book reader).
 */
export function useCommentMarksToggle(projectId: string, kind: CommentTargetKind, targetId: string | null) {
  const enabled = useSettingsStore((state) => state.commentMarksVisible);
  const setEnabled = useSettingsStore((state) => state.setCommentMarksVisible);
  const select = useMemo(() => createCommentHighlightSelector(projectId, kind, targetId),
    [projectId, kind, targetId]);
  const anchored = useDataStore(select);
  const count = useMemo(() => anchored.filter((comment) => comment.status === 'open').length, [anchored]);
  const onToggle = useCallback(() => setEnabled(!enabled), [enabled, setEnabled]);
  return { enabled, count, onToggle };
}
