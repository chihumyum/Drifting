import { useTranslation } from 'react-i18next';

import { createPlainCommentDoc, type CommentTargetKind } from '../../domain/comment';
import { CommentComposer } from '../../features/comments/CommentComposer';
import type { EditorCommentRequest } from '../../hooks/useEntityEditor';
import { selectCommentHighlight } from '../../lib/comment-highlight';
import { useAuthStore } from '../../store/auth';
import { useComment } from '../../usecase/useComment';

/**
 * Writes a note or TODO on the passage the author asked to comment on, in the
 * floating composer beside the selection. A request for another paper is not
 * this one's. Writing it is the author's own trace: its anchor is drawn in.
 */
export function EditorCommentComposer({
  projectId,
  targetKind,
  targetId,
  request,
  onClose,
}: {
  projectId: string;
  targetKind: CommentTargetKind;
  targetId: string | null | undefined;
  request: EditorCommentRequest | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const userId = useAuthStore((state) => state.user?.id) ?? 'local';
  const commentUsecases = useComment({ projectId, userId });
  if (!request || !targetId || request.projectId !== projectId || request.sourceKind !== targetKind ||
      request.sourceId !== targetId) return null;

  const create = async (body: string, asTodo: boolean) => {
    const created = await commentUsecases.createComment({
      kind: asTodo ? 'todo' : 'note',
      targetKind,
      targetId,
      targetBlockId: request.targetBlockId,
      targetBlockIds: request.targetBlockIds,
      anchorJson: request.anchorJson,
      bodyJson: createPlainCommentDoc(body),
      authorKind: 'user',
      authorId: userId,
      source: 'manual',
    });
    onClose();
    selectCommentHighlight(created.id);
  };

  return (
    <CommentComposer
      key={`${request.sourceId}:${request.anchorJson}`}
      anchor={{ x: request.clientX, y: request.clientY }}
      label={t('reviewPanel.comment')}
      placeholder={t('commentRail.composer.placeholder')}
      onSubmit={(body, asTodo) => void create(body, asTodo)}
      onCancel={onClose}
    />
  );
}
