// Readers' comments drawn in sand over the words by the editor's own painter
// (renderer/lib/comment-sand.ts), so a passage reads the same here as on the
// author's page. Reader comments are handed to it in the shape of the
// author's comments; the one being written is drawn along its lines.
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Comment } from '../renderer/domain/comment';
import { CommentSandPainter } from '../renderer/lib/comment-sand';
import type { ShareCommentAnchor } from '../shared/share-document';
import type { ReaderComment } from './api';

export const DRAFT_COMMENT_ID = 'draft';

export function sandComment(id: string, anchor: ShareCommentAnchor, status: Comment['status'], createdAt: string): Comment {
  return {
    id,
    projectId: '',
    kind: 'note',
    targetKind: null,
    targetId: null,
    targetBlockId: anchor.targetBlockId,
    anchorJson: JSON.stringify({
      selectedText: anchor.selectedText,
      blockText: anchor.blockText,
      blockSelectionFrom: anchor.blockSelectionFrom,
      blockSelectionTo: anchor.blockSelectionTo,
      blockSnapshots: anchor.blockSnapshots,
      ...(anchor.textAnchor ? { textAnchor: anchor.textAnchor } : {}),
    }),
    authorKind: 'external',
    authorId: null,
    authorName: null,
    bodyJson: '{}',
    status,
    priority: null,
    source: 'api',
    metadataJson: null,
    targetBlockIdsJson: JSON.stringify(anchor.targetBlockIds),
    resolvedAt: null,
    createdAt,
    updatedAt: createdAt,
  };
}

/**
 * Open comments rest as a light swash; the one whose card is pointed at, and
 * the passage being commented on, turn to the stronger one. Resolved comments
 * have no resting sand, as on the author's page.
 */
export function useCommentSand(
  scrollRef: RefObject<HTMLElement | null>,
  comments: readonly ReaderComment[],
  activeId: string | null,
  draft: ShareCommentAnchor | null,
) {
  const [painter, setPainter] = useState<CommentSandPainter | null>(null);
  const nonce = useRef(0);
  const [selected, setSelected] = useState<{ id: string; nonce: number } | null>(null);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const next = new CommentSandPainter(scroller);
    const detach = next.attach();
    setPainter(next);
    return () => {
      detach();
      next.dispose();
    };
  }, [scrollRef]);
  // A new draft draws its stroke along the lines once, like a selected comment.
  useEffect(() => {
    setSelected(draft ? { id: DRAFT_COMMENT_ID, nonce: ++nonce.current } : null);
  }, [draft]);
  useEffect(() => {
    if (!painter) return;
    const list = comments.map(comment => sandComment(comment.id, comment.anchor, comment.status, comment.createdAt));
    if (draft) list.push(sandComment(DRAFT_COMMENT_ID, draft, 'open', new Date(0).toISOString()));
    painter.update(list, draft ? DRAFT_COMMENT_ID : activeId, selected);
  }, [painter, comments, activeId, draft, selected]);
}
