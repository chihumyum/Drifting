import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, ListTodo, MessageSquare, MessageSquarePlus, Minimize2, RotateCcw, Sparkles, Trash2, X } from 'lucide-react';
import type { EditorCommentRequest } from '../../hooks/useEntityEditor';
import {
  createPlainCommentDoc,
  extractTextFromCommentBody,
  getBlockSnapshotFromAnchor,
  getSelectedTextFromAnchor,
  type Comment,
  type CommentBlockSnapshot,
  type CommentTargetKind,
} from '../../domain/comment';
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
import { useComment } from '../../usecase/useComment';
import { CopilotSuggestionCard } from '../copilot/CopilotSuggestionCard';

interface CommentRailProps {
  projectId: string;
  targetKind: CommentTargetKind;
  targetId: string;
  scrollEl: HTMLElement | null;
  pendingRequest: EditorCommentRequest | null;
  onPendingRequestChange: (request: EditorCommentRequest | null) => void;
}

// How long a fresh copilot comment is keyboard-targetable. After this it goes
// stale: Tab/Esc no longer routes here (so a Tab burst can't accidentally
// accept an old suggestion when a new one arrives), but mouse-click still
// works and the card remains visible.
const COPILOT_ACTIVE_MS = 5000;

// Context window around the selection in the in-card quote. The full block
// snapshot is preserved in anchorJson — the modal shows it untrimmed.
const QUOTE_CONTEXT_PAD = 60;

function blockSelector(blockId: string): string {
  return `[data-block-id="${CSS.escape(blockId)}"]`;
}

function commentSort(a: Comment, b: Comment): number {
  return a.createdAt.localeCompare(b.createdAt);
}

/** Quote excerpt: ±PAD chars around the selected hit, hit bolded + tinted. */
function renderQuoteExcerpt(snapshot: CommentBlockSnapshot): ReactNode {
  const { blockText, from, to } = snapshot;
  if (from < 0 || to <= from || to > blockText.length) {
    // Snapshot exists but offsets aren't usable — fall back to plain text.
    return blockText;
  }
  const start = Math.max(0, from - QUOTE_CONTEXT_PAD);
  const end = Math.min(blockText.length, to + QUOTE_CONTEXT_PAD);
  return (
    <>
      {start > 0 ? '…' : null}
      {blockText.slice(start, from)}
      <mark className="mnote__quote-hit">{blockText.slice(from, to)}</mark>
      {blockText.slice(to, end)}
      {end < blockText.length ? '…' : null}
    </>
  );
}

/** Full block text with the hit highlighted — for the snapshot modal. */
function renderQuoteFull(snapshot: CommentBlockSnapshot): ReactNode {
  const { blockText, from, to } = snapshot;
  if (from < 0 || to <= from || to > blockText.length) {
    return blockText;
  }
  return (
    <>
      {blockText.slice(0, from)}
      <mark className="mnote__quote-hit">{blockText.slice(from, to)}</mark>
      {blockText.slice(to)}
    </>
  );
}

interface SnapshotModalProps {
  snapshot: CommentBlockSnapshot;
  onClose: () => void;
}

function SnapshotModal({ snapshot, onClose }: SnapshotModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="snapshot-modal__overlay" onClick={onClose} role="presentation">
      <div
        className="snapshot-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Source block snapshot"
      >
        <div className="snapshot-modal__head">
          <span>原文快照 · 已删除</span>
          <button
            type="button"
            className="mnote__icon-btn"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={12} />
          </button>
        </div>
        <div className="snapshot-modal__body">{renderQuoteFull(snapshot)}</div>
      </div>
    </div>
  );
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
  const comments = useDataStore((state) => state.comments);
  const commentUsecases = useComment({ projectId, userId: effectiveUserId });
  const { createElement } = useBookElement({ projectId, userId: effectiveUserId });
  const services = useMemo<CopilotServices>(() => ({ createElement }), [createElement]);

  const marginRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [orphanIds, setOrphanIds] = useState<Set<string>>(new Set());
  const [snapshotForId, setSnapshotForId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  // Active window — per copilot comment id. seenIds is the "ever activated"
  // set; presence in seenIds + absence in activeIds = stale.
  const [activeIds, setActiveIds] = useState<Set<string>>(new Set());
  const [seenIds, setSeenIds] = useState<Set<string>>(new Set());
  const timersRef = useRef<Map<string, number>>(new Map());

  // Per-comment chip state — when the user collapses a card, it renders
  // as a small chip at the same y position. Click to expand. Default is
  // expanded (card). Session-local; not persisted.
  const [chipIds, setChipIds] = useState<Set<string>>(new Set());
  const collapseToChip = useCallback((id: string) => {
    setChipIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);
  const expandToCard = useCallback((id: string) => {
    setChipIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const visibleComments = useMemo(
    () =>
      comments
        .filter(
          (comment): comment is Comment & { targetBlockId: string } =>
            comment.projectId === projectId &&
            comment.targetKind === targetKind &&
            comment.targetId === targetId &&
            comment.targetBlockId !== null &&
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

  // ─── per-block position computation + orphan detection ───────────────
  // Anchored cards sit at the exact y of their target block (no collision
  // stacking) — so as the user scrolls, cards track their blocks 1:1 and
  // simply go off-screen with them. Cards on adjacent blocks may overlap;
  // hover z-index surfaces whichever one the user reaches for.
  //
  // Orphans (target block deleted) anchor to the TOP of the manuscript
  // (.page) — they scroll with content like anchored cards, but stack in
  // a column above where the first real block would land. Scroll to top
  // of the chapter to see them.
  const applyPositions = useCallback(() => {
    const margin = marginRef.current;
    if (!scrollEl || !margin) return;
    const marginRect = margin.getBoundingClientRect();

    const anchored: Array<{ id: string; top: number }> = [];
    const orphans: string[] = [];
    visibleComments.forEach((comment) => {
      const block = scrollEl.querySelector(
        blockSelector(comment.targetBlockId),
      ) as HTMLElement | null;
      if (!block) {
        orphans.push(comment.id);
        return;
      }
      const blockRect = block.getBoundingClientRect();
      // No clamp to 0 — when block scrolls above viewport, the card follows
      // (negative top means off-screen up).
      anchored.push({ id: comment.id, top: blockRect.top - marginRect.top - 4 });
    });

    // Orphan anchor point: top of .page (the manuscript container). Falls
    // back to a small fixed offset if the page hasn't mounted yet.
    const page = scrollEl.querySelector('.page') as HTMLElement | null;
    const pageRect = page?.getBoundingClientRect();
    const orphanBase = pageRect ? pageRect.top - marginRect.top - 4 : 4;

    const next: Record<string, number> = {};
    // Orphans first — chronological order, stacked downward from the
    // manuscript top with a ~108px stride. They scroll with the page.
    let oCursor = orphanBase;
    orphans.forEach((id) => {
      next[id] = oCursor;
      oCursor += 108;
    });
    // Anchored cards — exact block-relative position, no collision logic.
    anchored.forEach(({ id, top }) => {
      next[id] = top;
    });

    // Write `top` straight to each card's DOM node rather than through React
    // state. The manuscript scrolls on the compositor and is painted the same
    // frame the scroll fires; routing positions through setState + reconcile
    // landed them a frame (or more) later, so cards visibly trailed the text.
    // A direct write in the scroll handler lands in that same frame.
    margin.querySelectorAll<HTMLElement>('[data-comment-id]').forEach((node) => {
      const id = node.dataset.commentId;
      if (id && next[id] != null) node.style.top = `${next[id]}px`;
    });

    if (relevantPending) {
      const block = scrollEl.querySelector(
        blockSelector(relevantPending.targetBlockId),
      ) as HTMLElement | null;
      const blockRect = block?.getBoundingClientRect();
      const composerTop = Math.max(0, blockRect ? blockRect.top - marginRect.top - 4 : 28);
      const composer = margin.querySelector<HTMLElement>('[data-comment-composer]');
      if (composer) composer.style.top = `${composerTop}px`;
    }

    // Orphan membership is structural (drives the card's render branch +
    // classes), so it stays in React state — but only flips a re-render when
    // the set actually changes, never on a plain scroll.
    setOrphanIds((prev) => {
      const nextSet = new Set(orphans);
      if (prev.size === nextSet.size && orphans.every((id) => prev.has(id))) {
        return prev;
      }
      return nextSet;
    });
  }, [scrollEl, visibleComments, relevantPending]);

  // Initial + structural positioning. A layout effect runs before paint, so a
  // freshly mounted card (or one toggled card↔chip) never paints at its CSS
  // fallback top first. relevantPending + visibleComments are baked into
  // applyPositions, so its identity change re-runs this; chipIds is explicit.
  useLayoutEffect(() => {
    applyPositions();
  }, [applyPositions, chipIds]);

  // Keep cards pinned to their blocks during scroll / resize. The scroll
  // handler writes synchronously (no rAF) so card tops update in the same
  // frame as the native content scroll — that's what kills the trailing lag.
  useEffect(() => {
    if (!scrollEl) return undefined;
    const onScroll = () => applyPositions();
    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    const observer = new ResizeObserver(onScroll);
    observer.observe(scrollEl);
    if (marginRef.current) observer.observe(marginRef.current);
    return () => {
      scrollEl.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      observer.disconnect();
    };
  }, [scrollEl, applyPositions]);

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

  // ─── composer focus ──────────────────────────────────────────────────
  // The composer's initial position is handled by applyPositions in the
  // layout effect above (pre-paint, no flash). preventScroll on focus stops
  // the browser from auto-scrolling the editor if the textarea is momentarily
  // off-screen during that transition.
  useEffect(() => {
    setDraft('');
    if (relevantPending) {
      requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
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
    async (comment: Comment) => {
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
  const renderCopilotCard = (comment: Comment) => {
    const isOrphan = orphanIds.has(comment.id);
    const snapshot = getBlockSnapshotFromAnchor(comment.anchorJson);
    return (
      <CopilotSuggestionCard
        comment={comment}
        isActive={activeIds.has(comment.id)}
        isStale={!activeIds.has(comment.id) && seenIds.has(comment.id)}
        isOrphan={isOrphan}
        onAccept={() => {
          clearActivation(comment.id);
          return acceptCopilotComment(comment);
        }}
        onReject={() => {
          clearActivation(comment.id);
          return rejectCopilotComment(comment.id);
        }}
        onShowSnapshot={isOrphan && snapshot ? () => setSnapshotForId(comment.id) : undefined}
        onCollapse={() => collapseToChip(comment.id)}
      />
    );
  };

  const renderManualCard = (comment: Comment) => {
    const snapshot = getBlockSnapshotFromAnchor(comment.anchorJson);
    const fallbackQuote = snapshot ? '' : getSelectedTextFromAnchor(comment.anchorJson);
    const body = extractTextFromCommentBody(comment.bodyJson);
    const isResolved = comment.status === 'resolved';
    const isOrphan = orphanIds.has(comment.id);
    const isTodo = comment.kind === 'todo';
    const busy = busyId === comment.id;
    const classes = ['mnote', 'mnote--manual'];
    if (isResolved) classes.push('mnote--resolved');
    if (isOrphan) classes.push('mnote--orphan');
    if (isTodo) classes.push('mnote--todo');
    return (
      <div className={classes.join(' ')} data-comment-id={comment.id}>
        {!isOrphan && <div className="mnote__leader" aria-hidden="true" />}
        <div className="mnote__head">
          <span className="mnote__head-l">
            <span className="mnote__head-glyph">{isTodo ? '☐' : '§'}</span>
            <span>{isTodo ? 'TODO' : comment.authorKind === 'user' ? 'COMMENT' : comment.authorKind}</span>
          </span>
          <span className="mnote__head-r">
            <span className="mnote__head-conf">{isResolved ? 'resolved' : 'open'}</span>
            <button
              type="button"
              className="mnote__icon-btn"
              onClick={() => collapseToChip(comment.id)}
              aria-label="折叠"
              title="折叠为 chip"
            >
              <Minimize2 size={11} />
            </button>
          </span>
        </div>
        <div className="mnote__title">{body || '空批注'}</div>
        {isOrphan ? (
          <button
            type="button"
            className="mnote__tag"
            onClick={() => snapshot && setSnapshotForId(comment.id)}
            disabled={!snapshot}
            title={snapshot ? '查看原文快照' : '无原文快照'}
          >
            原文已删除
          </button>
        ) : snapshot ? (
          <div className="mnote__quote">{renderQuoteExcerpt(snapshot)}</div>
        ) : (
          fallbackQuote && <div className="mnote__quote">{fallbackQuote}</div>
        )}
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
          {isTodo ? (
            <button
              type="button"
              className="mnote__btn mnote__btn--ghost"
              disabled={busy}
              title="降为批注"
              onClick={() => void runAction(comment.id, () => commentUsecases.revertToNote(comment.id))}
            >
              <ListTodo size={12} />
              <span>转批注</span>
            </button>
          ) : (
            <button
              type="button"
              className="mnote__btn mnote__btn--primary"
              disabled={busy}
              onClick={() => void runAction(comment.id, () => commentUsecases.convertToTodo(comment.id))}
            >
              <ListTodo size={12} />
              <span>转 TODO</span>
            </button>
          )}
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

  const renderChip = (comment: Comment) => {
    const isCopilot = comment.source === 'copilot';
    const isActive = activeIds.has(comment.id);
    const isStale = !isActive && seenIds.has(comment.id);
    const isOrphan = orphanIds.has(comment.id);
    const classes = ['comment-chip'];
    if (isCopilot) classes.push('comment-chip--copilot');
    if (comment.status === 'resolved') classes.push('comment-chip--resolved');
    if (isActive) classes.push('comment-chip--active');
    if (isStale) classes.push('comment-chip--stale');
    if (isOrphan) classes.push('comment-chip--orphan');
    return (
      <button
        type="button"
        className={classes.join(' ')}
        data-comment-id={comment.id}
        onClick={() => expandToCard(comment.id)}
        aria-label={isCopilot ? 'Copilot suggestion' : 'Comment'}
        title="展开"
      >
        {isCopilot ? <Sparkles size={11} /> : <MessageSquare size={11} />}
      </button>
    );
  };

  const renderCard = (comment: Comment) => {
    if (chipIds.has(comment.id)) return renderChip(comment);
    return comment.source === 'copilot' ? renderCopilotCard(comment) : renderManualCard(comment);
  };

  const renderComposer = () => {
    if (!relevantPending) return null;
    return (
      <div className="mnote mnote--composer" data-comment-composer>
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
    );
  };

  const snapshotComment =
    snapshotForId !== null
      ? visibleComments.find((c) => c.id === snapshotForId) ?? null
      : null;
  const snapshotPayload = snapshotComment
    ? getBlockSnapshotFromAnchor(snapshotComment.anchorJson)
    : null;

  return (
    <>
      <aside
        ref={marginRef}
        className="editor__margin"
        aria-label="Manuscript comments"
      >
        {visibleComments.map((comment) => (
          <Fragment key={comment.id}>{renderCard(comment)}</Fragment>
        ))}
        {renderComposer()}
      </aside>
      {snapshotPayload && (
        <SnapshotModal snapshot={snapshotPayload} onClose={() => setSnapshotForId(null)} />
      )}
    </>
  );
}
