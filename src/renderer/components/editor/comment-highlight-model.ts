import { isNoteTaskTodo, type Comment, type CommentTargetKind } from '../../domain/comment';

const EMPTY_COMMENTS: readonly Comment[] = [];

/**
 * Comments one prose surface may paint: same project and target, block-anchored
 * and not converted. Rail membership is irrelevant — anchors are always visible.
 * `targetId === null` admits every target of the kind: the whole-book reader
 * shows many chapters in one scroller and resolves anchors by block id.
 */
export function createCommentHighlightSelector(
  projectId: string,
  kind: CommentTargetKind,
  targetId: string | null,
) {
  let input: readonly Comment[] | undefined;
  let snapshot: readonly Comment[] = EMPTY_COMMENTS;
  return (state: { comments: readonly Comment[] }): readonly Comment[] => {
    if (input === state.comments) return snapshot;
    input = state.comments;
    const next = state.comments.filter((comment) =>
      comment.projectId === projectId &&
      comment.targetKind === kind &&
      (targetId === null || comment.targetId === targetId) &&
      comment.targetBlockId !== null &&
      comment.status !== 'converted' &&
      // A note's checklist line already shows its TODO.
      !isNoteTaskTodo(comment));
    const changed = next.length !== snapshot.length ||
      next.some((comment, index) => comment !== snapshot[index]);
    if (changed) snapshot = next.length > 0 ? next : EMPTY_COMMENTS;
    return snapshot;
  };
}
