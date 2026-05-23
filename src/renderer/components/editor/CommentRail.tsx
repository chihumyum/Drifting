import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ListTodo, MessageSquarePlus, RotateCcw, Trash2, X } from 'lucide-react';
import type { EditorCommentRequest } from '../../hooks/useEntityEditor';
import {
  createPlainCommentDoc,
  extractTextFromCommentBody,
  getSelectedTextFromAnchor,
  type CommentTargetKind,
  type ManuscriptComment,
} from '../../domain/manuscript-comment';
import { useAuthStore } from '../../store/auth';
import { useDataStore } from '../../store/data-store';
import { useManuscriptComment } from '../../usecase/useManuscriptComment';

interface CommentRailProps {
  projectId: string;
  targetKind: CommentTargetKind;
  targetId: string;
  scrollEl: HTMLElement | null;
  pendingRequest: EditorCommentRequest | null;
  onPendingRequestChange: (request: EditorCommentRequest | null) => void;
}

function blockSelector(blockId: string): string {
  return `[data-block-id="${CSS.escape(blockId)}"]`;
}

function commentSort(a: ManuscriptComment, b: ManuscriptComment): number {
  return a.createdAt.localeCompare(b.createdAt);
}

export function CommentRail({
  projectId,
  targetKind,
  targetId,
  scrollEl,
  pendingRequest,
  onPendingRequestChange,
}: CommentRailProps) {
  const userId = useAuthStore((state) => state.user?.id);
  const comments = useDataStore((state) => state.manuscriptComments);
  const commentUsecases = useManuscriptComment({ projectId, userId: userId ?? 'local' });
  const marginRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [positions, setPositions] = useState<Record<string, number>>({});
  const [pendingTop, setPendingTop] = useState(28);
  const [draft, setDraft] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const visibleComments = useMemo(
    () =>
      comments
        .filter(
          (comment) =>
            comment.projectId === projectId &&
            comment.targetKind === targetKind &&
            comment.targetId === targetId &&
            comment.status !== 'converted',
        )
        .sort(commentSort),
    [comments, projectId, targetKind, targetId],
  );

  const relevantPending =
    pendingRequest &&
    pendingRequest.projectId === projectId &&
    pendingRequest.sourceKind === targetKind &&
    pendingRequest.sourceId === targetId
      ? pendingRequest
      : null;

  const recomputePositions = useCallback(() => {
    const margin = marginRef.current;
    if (!scrollEl || !margin) return;
    const marginRect = margin.getBoundingClientRect();
    const rawEntries = visibleComments.map((comment) => {
      const block = scrollEl.querySelector(blockSelector(comment.targetBlockId)) as HTMLElement | null;
      const blockRect = block?.getBoundingClientRect();
      const top = blockRect ? blockRect.top - marginRect.top - 4 : 28;
      return [comment.id, Math.max(0, top)] as const;
    });
    rawEntries.sort((a, b) => a[1] - b[1]);

    const next: Record<string, number> = {};
    let cursor = -128;
    rawEntries.forEach(([id, top]) => {
      const stacked = Math.max(top, cursor + 12);
      next[id] = stacked;
      cursor = stacked + 116;
    });
    setPositions(next);

    if (relevantPending) {
      const block = scrollEl.querySelector(blockSelector(relevantPending.targetBlockId)) as HTMLElement | null;
      const blockRect = block?.getBoundingClientRect();
      setPendingTop(Math.max(0, blockRect ? blockRect.top - marginRect.top - 4 : 28));
    }
  }, [scrollEl, visibleComments, relevantPending]);

  useEffect(() => {
    recomputePositions();
    if (!scrollEl) return undefined;
    let frame = 0;
    const schedule = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(recomputePositions);
    };
    scrollEl.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(scrollEl);
    if (marginRef.current) observer.observe(marginRef.current);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      scrollEl.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      observer.disconnect();
    };
  }, [scrollEl, recomputePositions]);

  useEffect(() => {
    if (!scrollEl) return;
    scrollEl.querySelectorAll('.comment-anchor-mark').forEach((node) => {
      node.classList.remove('comment-anchor-mark', 'comment-anchor-resolved');
    });

    const byBlock = new Map<string, { open: number; resolved: number }>();
    visibleComments.forEach((comment) => {
      const current = byBlock.get(comment.targetBlockId) ?? { open: 0, resolved: 0 };
      if (comment.status === 'resolved') current.resolved += 1;
      else current.open += 1;
      byBlock.set(comment.targetBlockId, current);
    });

    byBlock.forEach((count, blockId) => {
      const block = scrollEl.querySelector(blockSelector(blockId));
      if (!block) return;
      block.classList.add('comment-anchor-mark');
      if (count.open === 0 && count.resolved > 0) block.classList.add('comment-anchor-resolved');
    });

    return () => {
      scrollEl.querySelectorAll('.comment-anchor-mark').forEach((node) => {
        node.classList.remove('comment-anchor-mark', 'comment-anchor-resolved');
      });
    };
  }, [scrollEl, visibleComments]);

  useEffect(() => {
    setDraft('');
    if (relevantPending) {
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [relevantPending]);

  const handleCreate = async () => {
    if (!relevantPending) return;
    const body = draft.trim();
    if (!body) return;
    await commentUsecases.createComment({
      targetKind,
      targetId,
      targetBlockId: relevantPending.targetBlockId,
      anchorJson: relevantPending.anchorJson,
      bodyJson: createPlainCommentDoc(body),
      authorKind: 'user',
      authorId: userId ?? null,
      source: 'manual',
    });
    setDraft('');
    onPendingRequestChange(null);
  };

  const runAction = async (commentId: string, action: () => Promise<unknown>) => {
    setBusyId(commentId);
    try {
      await action();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <aside className="editor__margin" ref={marginRef} aria-label="Manuscript comments">
      {visibleComments.map((comment) => {
        const quote = getSelectedTextFromAnchor(comment.anchorJson);
        const body = extractTextFromCommentBody(comment.bodyJson);
        const isResolved = comment.status === 'resolved';
        const busy = busyId === comment.id;
        return (
          <div
            key={comment.id}
            className={`mnote mnote--manual${isResolved ? ' mnote--resolved' : ''}`}
            style={{ top: positions[comment.id] ?? 28 }}
          >
            <div className="mnote__leader" aria-hidden="true" />
            <div className="mnote__head">
              <span className="mnote__head-l">
                <span className="mnote__head-glyph">§</span>
                <span>{comment.authorKind === 'user' ? 'COMMENT' : comment.authorKind}</span>
              </span>
              <span className="mnote__head-conf">{isResolved ? 'resolved' : 'open'}</span>
            </div>
            <div className="mnote__title">{body || '空批注'}</div>
            {quote && <div className="mnote__quote">{quote}</div>}
            <div className="mnote__actions">
              {isResolved ? (
                <button
                  type="button"
                  className="mnote__btn"
                  disabled={busy}
                  onClick={() => void runAction(comment.id, () => commentUsecases.reopenComment(comment.id))}
                >
                  <RotateCcw size={12} />
                  <span>未解决</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="mnote__btn"
                  disabled={busy}
                  onClick={() => void runAction(comment.id, () => commentUsecases.resolveComment(comment.id))}
                >
                  <Check size={12} />
                  <span>解决</span>
                </button>
              )}
              <button
                type="button"
                className="mnote__btn mnote__btn--primary"
                disabled={busy}
                onClick={() => void runAction(comment.id, () => commentUsecases.convertToMemo(comment.id))}
              >
                <ListTodo size={12} />
                <span>转 TODO</span>
              </button>
              <button
                type="button"
                className="mnote__btn"
                disabled={busy}
                onClick={() => void runAction(comment.id, () => commentUsecases.deleteComment(comment.id))}
              >
                <Trash2 size={12} />
                <span>删除</span>
              </button>
            </div>
          </div>
        );
      })}

      {relevantPending && (
        <div className="mnote mnote--composer" style={{ top: pendingTop }}>
          <div className="mnote__leader" aria-hidden="true" />
          <div className="mnote__head">
            <span className="mnote__head-l">
              <MessageSquarePlus size={11} />
              <span>NEW COMMENT</span>
            </span>
            <button
              type="button"
              className="mnote__icon-btn"
              onClick={() => onPendingRequestChange(null)}
              aria-label="Cancel comment"
            >
              <X size={12} />
            </button>
          </div>
          <div className="mnote__quote">{relevantPending.selectedText}</div>
          <textarea
            ref={textareaRef}
            className="mnote__textarea"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onPendingRequestChange(null);
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                void handleCreate();
              }
            }}
            placeholder="写批注…"
            rows={4}
          />
          <div className="mnote__actions">
            <button
              type="button"
              className="mnote__btn"
              onClick={() => onPendingRequestChange(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="mnote__btn mnote__btn--primary"
              disabled={!draft.trim()}
              onClick={() => void handleCreate()}
            >
              添加
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
