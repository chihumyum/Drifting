import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ListTodo, MessageSquare, MessageSquarePlus, RotateCcw, Sparkles, Trash2, X } from 'lucide-react';
import type { EditorCommentRequest } from '../../hooks/useEntityEditor';
import {
  createPlainCommentDoc,
  extractTextFromCommentBody,
  getSelectedTextFromAnchor,
  type CommentTargetKind,
  type ManuscriptComment,
} from '../../domain/manuscript-comment';
import { decodeCopilotMetadata } from '../../domain/copilot-suggestion';
import {
  getCopilotCapabilityForMetadataKind,
  type CopilotServices,
} from '../../lib/copilot/capability';
import { copilotRuntime } from '../../lib/copilot/runtime';
import { getActiveEditor } from '../../lib/active-editor';
import { useAuthStore } from '../../store/auth';
import { useDataStore } from '../../store/data-store';
import { useBookElement } from '../../usecase/useBookElement';
import { useManuscriptComment } from '../../usecase/useManuscriptComment';
import { CopilotSuggestionCard } from '../copilot/CopilotSuggestionCard';

interface CommentRailProps {
  projectId: string;
  targetKind: CommentTargetKind;
  targetId: string;
  scrollEl: HTMLElement | null;
  pendingRequest: EditorCommentRequest | null;
  onPendingRequestChange: (request: EditorCommentRequest | null) => void;
}

// Switch to chip mode when the scroll area can't comfortably host the rail
// alongside the page (max-width 720) + 240 rail + ~32 gap/padding.
const CHIP_MODE_THRESHOLD = 720 + 240 + 32;

// How long a fresh copilot comment is keyboard-targetable. After this it goes
// stale: Tab/Esc no longer routes here (so a Tab burst can't accidentally
// accept an old suggestion when a new one arrives), but mouse-click still
// works and the card remains visible.
const COPILOT_ACTIVE_MS = 5000;

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
  const effectiveUserId = userId ?? 'local';
  const comments = useDataStore((state) => state.manuscriptComments);
  const commentUsecases = useManuscriptComment({ projectId, userId: effectiveUserId });
  const { createElement } = useBookElement({ projectId, userId: effectiveUserId });
  const services = useMemo<CopilotServices>(() => ({ createElement }), [createElement]);

  const marginRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [positions, setPositions] = useState<Record<string, number>>({});
  const [pendingTop, setPendingTop] = useState(28);
  const [draft, setDraft] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  // Active window — per copilot comment id. seenIds is the "ever activated"
  // set; presence in seenIds + absence in activeIds = stale.
  const [activeIds, setActiveIds] = useState<Set<string>>(new Set());
  const [seenIds, setSeenIds] = useState<Set<string>>(new Set());
  const timersRef = useRef<Map<string, number>>(new Map());

  // Chip-mode state — when the scroll area gets too narrow, the rail collapses
  // to a column of chips at the right edge of the page. Chips expand into
  // floating popovers on click. Multiple popovers may be open at once.
  const [chipMode, setChipMode] = useState(false);
  const [openPopovers, setOpenPopovers] = useState<Set<string>>(new Set());

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

  // ─── chip-mode detection ──────────────────────────────────────────────
  useEffect(() => {
    if (!scrollEl) return;
    const check = () => setChipMode(scrollEl.clientWidth < CHIP_MODE_THRESHOLD);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(scrollEl);
    return () => observer.disconnect();
  }, [scrollEl]);

  // ─── per-block position computation ───────────────────────────────────
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
    if (chipMode) {
      // Chip mode: keep chips anchored to their block top — no collision
      // resolution needed because chips are tiny. Overlapping chips at the
      // same line just stack visually; users rarely have many on one block.
      rawEntries.forEach(([id, top]) => {
        next[id] = top;
      });
    } else {
      // Rail mode: stack cards downward with a 12px min gap (~116px card
      // height + 12 = 128 stride).
      let cursor = -128;
      rawEntries.forEach(([id, top]) => {
        const stacked = Math.max(top, cursor + 12);
        next[id] = stacked;
        cursor = stacked + 116;
      });
    }
    setPositions(next);

    if (relevantPending) {
      const block = scrollEl.querySelector(blockSelector(relevantPending.targetBlockId)) as HTMLElement | null;
      const blockRect = block?.getBoundingClientRect();
      setPendingTop(Math.max(0, blockRect ? blockRect.top - marginRect.top - 4 : 28));
    }
  }, [scrollEl, visibleComments, relevantPending, chipMode]);

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

  // ─── anchor-highlight class application ───────────────────────────────
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

  // ─── composer focus on open ───────────────────────────────────────────
  useEffect(() => {
    setDraft('');
    if (relevantPending) {
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [relevantPending]);

  // ─── copilot activation timing ────────────────────────────────────────
  // Each new copilot comment starts a 5s active window. When the timer
  // fires it leaves activeIds (becomes stale). Independent per id so a
  // burst of suggestions stays Tab-acceptable in order.
  useEffect(() => {
    const currentIds = new Set(visibleComments.map((c) => c.id));
    const copilotIds = visibleComments
      .filter((c) => c.source === 'copilot')
      .map((c) => c.id);

    copilotIds.forEach((id) => {
      if (seenIds.has(id)) return;
      setSeenIds((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      setActiveIds((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      const timer = window.setTimeout(() => {
        setActiveIds((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        timersRef.current.delete(id);
      }, COPILOT_ACTIVE_MS);
      timersRef.current.set(id, timer);
    });

    // Drop tracking for comments that no longer exist (accepted/rejected).
    const removed: string[] = [];
    seenIds.forEach((id) => {
      if (!currentIds.has(id)) removed.push(id);
    });
    if (removed.length > 0) {
      removed.forEach((id) => {
        const t = timersRef.current.get(id);
        if (t) {
          window.clearTimeout(t);
          timersRef.current.delete(id);
        }
      });
      setSeenIds((prev) => {
        const next = new Set(prev);
        removed.forEach((id) => next.delete(id));
        return next;
      });
      setActiveIds((prev) => {
        const next = new Set(prev);
        removed.forEach((id) => next.delete(id));
        return next;
      });
    }
  }, [visibleComments, seenIds]);

  useEffect(
    () => () => {
      timersRef.current.forEach((t) => window.clearTimeout(t));
      timersRef.current.clear();
    },
    [],
  );

  // ─── accept / reject helpers (shared by mouse + keyboard) ─────────────
  const acceptCopilotComment = useCallback(
    async (comment: ManuscriptComment) => {
      const metadata = decodeCopilotMetadata(comment.metadataJson);
      const capability = metadata ? getCopilotCapabilityForMetadataKind(metadata.kind) : null;
      if (!metadata || !capability) return;
      const result = await capability.accept({
        runtime: copilotRuntime,
        services,
        comment,
        metadata,
        projectId,
        userId: effectiveUserId,
        editor: getActiveEditor(),
      });
      await commentUsecases.acceptCopilotSuggestion(comment.id, result);
    },
    [services, projectId, effectiveUserId, commentUsecases],
  );

  const rejectCopilotComment = useCallback(
    async (commentId: string) => {
      await commentUsecases.rejectCopilotSuggestion(commentId);
    },
    [commentUsecases],
  );

  const clearActivation = useCallback((id: string) => {
    setActiveIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    const t = timersRef.current.get(id);
    if (t) {
      window.clearTimeout(t);
      timersRef.current.delete(id);
    }
  }, []);

  // ─── Tab / Esc keyboard router (editor scroll scope) ──────────────────
  // Registered in capture phase on scrollEl so we intercept before TipTap's
  // own Tab handling on the contenteditable inside.
  useEffect(() => {
    if (!scrollEl) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' && e.key !== 'Escape') return;
      if (activeIds.size === 0) return;
      // Oldest active first — visibleComments is asc by createdAt, so a Tab
      // burst accepts suggestions in arrival order.
      const target = visibleComments.find(
        (c) => c.source === 'copilot' && activeIds.has(c.id),
      );
      if (!target) return;

      e.preventDefault();
      e.stopPropagation();

      clearActivation(target.id);

      if (e.key === 'Tab') {
        void acceptCopilotComment(target).catch((err) =>
          console.error('[CommentRail] copilot accept (Tab) failed', err),
        );
      } else {
        void rejectCopilotComment(target.id).catch((err) =>
          console.error('[CommentRail] copilot reject (Esc) failed', err),
        );
      }
    };
    scrollEl.addEventListener('keydown', handler, true);
    return () => scrollEl.removeEventListener('keydown', handler, true);
  }, [
    scrollEl,
    activeIds,
    visibleComments,
    acceptCopilotComment,
    rejectCopilotComment,
    clearActivation,
  ]);

  // ─── popover open/close ───────────────────────────────────────────────
  const togglePopover = useCallback((id: string) => {
    setOpenPopovers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const closePopover = useCallback((id: string) => {
    setOpenPopovers((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // Auto-open the popover for any newly-active copilot comment while in chip
  // mode, so the user actually sees the suggestion without first clicking
  // the chip. Stays open after going stale until the user closes it.
  useEffect(() => {
    if (!chipMode) return;
    if (activeIds.size === 0) return;
    setOpenPopovers((prev) => {
      let next = prev;
      activeIds.forEach((id) => {
        if (!next.has(id)) {
          if (next === prev) next = new Set(prev);
          next.add(id);
        }
      });
      return next;
    });
  }, [chipMode, activeIds]);

  // Drop popover state for comments that have been removed.
  useEffect(() => {
    const currentIds = new Set(visibleComments.map((c) => c.id));
    setOpenPopovers((prev) => {
      let next = prev;
      prev.forEach((id) => {
        if (!currentIds.has(id)) {
          if (next === prev) next = new Set(prev);
          next.delete(id);
        }
      });
      return next;
    });
  }, [visibleComments]);

  // ─── handlers ─────────────────────────────────────────────────────────
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

  // ─── card renderers ───────────────────────────────────────────────────
  const renderCopilotCard = (
    comment: ManuscriptComment,
    variant: 'rail' | 'floating',
  ) => (
    <CopilotSuggestionCard
      comment={comment}
      top={variant === 'rail' ? positions[comment.id] ?? 28 : undefined}
      variant={variant}
      isActive={activeIds.has(comment.id)}
      isStale={!activeIds.has(comment.id) && seenIds.has(comment.id)}
      onAccept={() => {
        clearActivation(comment.id);
        return acceptCopilotComment(comment);
      }}
      onReject={() => {
        clearActivation(comment.id);
        return rejectCopilotComment(comment.id);
      }}
      onClose={variant === 'floating' ? () => closePopover(comment.id) : undefined}
    />
  );

  const renderManualCard = (
    comment: ManuscriptComment,
    variant: 'rail' | 'floating',
  ) => {
    const quote = getSelectedTextFromAnchor(comment.anchorJson);
    const body = extractTextFromCommentBody(comment.bodyJson);
    const isResolved = comment.status === 'resolved';
    const busy = busyId === comment.id;
    const classes = ['mnote', 'mnote--manual'];
    if (isResolved) classes.push('mnote--resolved');
    if (variant === 'floating') classes.push('mnote--floating');
    const style = variant === 'rail' ? { top: positions[comment.id] ?? 28 } : undefined;
    return (
      <div className={classes.join(' ')} style={style}>
        {variant === 'rail' && <div className="mnote__leader" aria-hidden="true" />}
        <div className="mnote__head">
          <span className="mnote__head-l">
            <span className="mnote__head-glyph">§</span>
            <span>{comment.authorKind === 'user' ? 'COMMENT' : comment.authorKind}</span>
          </span>
          {variant === 'floating' ? (
            <button
              type="button"
              className="mnote__icon-btn"
              onClick={() => closePopover(comment.id)}
              aria-label="Close"
            >
              <X size={12} />
            </button>
          ) : (
            <span className="mnote__head-conf">{isResolved ? 'resolved' : 'open'}</span>
          )}
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
  };

  const renderCard = (comment: ManuscriptComment, variant: 'rail' | 'floating') =>
    comment.source === 'copilot'
      ? renderCopilotCard(comment, variant)
      : renderManualCard(comment, variant);

  const renderComposer = (variant: 'rail' | 'floating') => {
    if (!relevantPending) return null;
    const classes = ['mnote', 'mnote--composer'];
    if (variant === 'floating') classes.push('mnote--floating');
    const style = variant === 'rail' ? { top: pendingTop } : undefined;
    return (
      <div className={classes.join(' ')} style={style}>
        {variant === 'rail' && <div className="mnote__leader" aria-hidden="true" />}
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
    );
  };

  // ─── chip mode render ────────────────────────────────────────────────
  if (chipMode) {
    return (
      <aside
        ref={marginRef}
        className="editor__margin editor__margin--chip"
        aria-label="Manuscript comments"
      >
        {visibleComments.map((comment) => {
          const top = positions[comment.id] ?? 28;
          const isOpen = openPopovers.has(comment.id);
          const isActive = activeIds.has(comment.id);
          const isStale = !isActive && seenIds.has(comment.id);
          const chipClasses = ['comment-chip'];
          if (comment.source === 'copilot') chipClasses.push('comment-chip--copilot');
          if (comment.status === 'resolved') chipClasses.push('comment-chip--resolved');
          if (isActive) chipClasses.push('comment-chip--active');
          if (isStale) chipClasses.push('comment-chip--stale');
          if (isOpen) chipClasses.push('comment-chip--open');
          return (
            <Fragment key={comment.id}>
              <button
                type="button"
                className={chipClasses.join(' ')}
                style={{ top }}
                onClick={() => togglePopover(comment.id)}
                aria-label={comment.source === 'copilot' ? 'Copilot suggestion' : 'Comment'}
                aria-expanded={isOpen}
              >
                {comment.source === 'copilot' ? <Sparkles size={11} /> : <MessageSquare size={11} />}
              </button>
              {isOpen && (
                <div className="comment-popover" style={{ top }} role="dialog">
                  {renderCard(comment, 'floating')}
                </div>
              )}
            </Fragment>
          );
        })}

        {relevantPending && (
          <div className="comment-popover comment-popover--composer" style={{ top: pendingTop }} role="dialog">
            {renderComposer('floating')}
          </div>
        )}
      </aside>
    );
  }

  // ─── rail mode render (default) ──────────────────────────────────────
  return (
    <aside className="editor__margin" ref={marginRef} aria-label="Manuscript comments">
      {visibleComments.map((comment) => (
        <Fragment key={comment.id}>{renderCard(comment, 'rail')}</Fragment>
      ))}
      {renderComposer('rail')}
    </aside>
  );
}
