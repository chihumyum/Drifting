import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  EyeOff,
  ListTodo,
  MessageSquare,
  MessageSquarePlus,
  Minimize2,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import type { EditorCommentRequest } from '../../hooks/useEntityEditor';
import {
  commentBelongsToEntity,
  commentColorKey,
  commentIdsRelatedToEntity,
  createPlainCommentDoc,
  extractTextFromCommentBody,
  getBlockSnapshotsFromAnchor,
  type Comment,
  type CommentColorKey,
  type CommentTargetKind,
} from '../../domain/comment';
import { decodeCopilotMetadata } from '../../domain/copilot-suggestion';
import {
  getCopilotCapabilityForMetadataKind,
  type CopilotServices,
} from '../../lib/copilot/capability';
import { copilotRuntime } from '../../lib/copilot/runtime';
import { getActiveEditor } from '../../lib/active-editor';
import { highlightComment } from '../../lib/comment-highlight';
import { events } from '../../lib/events';
import { useAuthStore } from '../../store/auth';
import { useDataStore } from '../../store/data-store';
import { useBookElement } from '../../usecase/useBookElement';
import { useComment } from '../../usecase/useComment';
import {
  COPILOT_ACTIVE_MS,
  COPILOT_FRESH_MS,
  commentBlockSelector as blockSelector,
  compareCommentsByCreatedAt as commentSort,
  flashedCopilotIds,
  hasCommentSourceDiverged as originalDiverged,
} from '../../features/comments/comment-rail-model';
import { CommentSnapshotModal } from '../../features/comments/CommentSnapshotModal';

interface CommentRailProps {
  projectId: string;
  targetKind: CommentTargetKind;
  targetId: string;
  scrollEl: HTMLElement | null;
  pendingRequest: EditorCommentRequest | null;
  onPendingRequestChange: (request: EditorCommentRequest | null) => void;
}

// Per-family rail micro-icon (head glyph + collapsed chip) — manual / copilot /
// todo are visually distinct (see commentColorKey + the .mnote--*
// colours in index.css).
function colorIcon(key: CommentColorKey, size = 11): ReactNode {
  switch (key) {
    case 'todo':
      return <ListTodo size={size} />;
    case 'copilot':
      return <Sparkles size={size} />;
    default:
      return <MessageSquare size={size} />;
  }
}

const COLOR_LABEL_KEY: Record<CommentColorKey, string> = {
  todo: 'commentRail.color.todo',
  copilot: 'commentRail.color.copilot',
  manual: 'commentRail.color.manual',
};

export function CommentRail({
  projectId,
  targetKind,
  targetId,
  scrollEl,
  pendingRequest,
  onPendingRequestChange,
}: CommentRailProps) {
  const { t } = useTranslation();
  const userId = useAuthStore((state) => state.user?.id);
  const effectiveUserId = userId ?? 'local';
  const comments = useDataStore((state) => state.comments);
  const entityRelations = useDataStore((state) => state.entityRelations);
  const commentUsecases = useComment({ projectId, userId: effectiveUserId });
  const { createElement } = useBookElement({ projectId, userId: effectiveUserId });
  const services = useMemo<CopilotServices>(() => ({ createElement }), [createElement]);

  const marginRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const entitySubmittingRef = useRef(false);
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
  // Which comment card is hovered -> the effect below highlights its anchored
  // block(s). Declare it before the chip callbacks that consume its setter so
  // the callbacks remain compatible with React Compiler's closure analysis.
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const collapseToChip = useCallback((id: string) => {
    setChipIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    // Collapsing swaps the card for a chip WITHOUT the card's onMouseLeave ever
    // firing, so its hover-highlight would stick. Drop it here; re-hovering the
    // chip re-applies it (renderChip carries the same mouse handlers).
    setHoveredId((prev) => (prev === id ? null : prev));
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

  // Comment ids carrying a curated entity_relation edge pointing at THIS entity
  // (the right-sidebar TodoPanel path). Unioned with the target_* match below so
  // those TODOs surface in the editor too. See domain/comment.
  const relatedCommentIds = useMemo(
    () => commentIdsRelatedToEntity(entityRelations, projectId, targetKind, targetId),
    [entityRelations, projectId, targetKind, targetId],
  );

  // Entity-level notes/TODOs — about this chapter/element but NOT anchored to a
  // prose block (targetBlockId === null). They have nothing to anchor to, so
  // instead of floating they collect in a stack pinned to the bottom of the
  // rail (see renderLooseStack). "About this entity" = target_* match OR a
  // relation edge. Purely floating project TODOs (neither) stay in the TodoPanel.
  const looseComments = useMemo(
    () =>
      comments
        .filter(
          (comment) =>
            comment.projectId === projectId &&
            comment.targetBlockId === null &&
            comment.status !== 'converted' &&
            commentBelongsToEntity(comment, targetKind, targetId, relatedCommentIds),
        )
        .sort(commentSort),
    [comments, projectId, targetKind, targetId, relatedCommentIds],
  );
  // The stack starts collapsed (an iOS-notification-style deck); clicking it
  // fans the cards out into a flat list. Session-local; not persisted.
  const [stackExpanded, setStackExpanded] = useState(false);
  // Inline composer for a NEW entity-level (block-less) comment — opened from the
  // bottom-right ball (when empty) or the "+" beside the collapse button.
  const [entityComposerOpen, setEntityComposerOpen] = useState(false);
  const [entityDraft, setEntityDraft] = useState('');
  // State-driven hover cleanup means the highlight never sticks: the old
  // inline classList toggling left marks behind on card unmount / delete / create.
  // Bumped after each (debounced) prose edit to this entity so the manual cards
  // re-evaluate snapshotsDiverged — the "view original" button must appear once
  // an anchored block is edited/deleted. The value is unused; the re-render is
  // the point. references:changed fires from the editor's persist pipeline.
  const [, bumpEditRevision] = useState(0);
  useEffect(() => {
    const onChange = (payload: { fromKind?: string; fromId?: string }) => {
      if (payload.fromKind === targetKind && payload.fromId === targetId) {
        bumpEditRevision((n) => n + 1);
      }
    };
    events.on('references:changed', onChange);
    return () => events.off('references:changed', onChange);
  }, [targetKind, targetId]);

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
    // Only transient copilot suggestions keep the top-of-page orphan stack.
    // Manual notes/TODOs whose block was deleted drop into the bottom stack
    // (renderLooseStack) as entity-level cards — see isStackOrphan below.
    const copilotOrphans: string[] = [];
    visibleComments.forEach((comment) => {
      const block = scrollEl.querySelector(
        blockSelector(comment.targetBlockId),
      ) as HTMLElement | null;
      if (!block) {
        orphans.push(comment.id);
        if (comment.source === 'copilot') copilotOrphans.push(comment.id);
        return;
      }
      const blockRect = block.getBoundingClientRect();
      // No clamp to 0 — when block scrolls above viewport, the card follows
      // (negative top means off-screen up).
      anchored.push({ id: comment.id, top: blockRect.top - marginRect.top - 4 });
    });

    // Copilot-orphan anchor point: top of .page (the manuscript container).
    // Falls back to a small fixed offset if the page hasn't mounted yet.
    const page = scrollEl.querySelector('.page') as HTMLElement | null;
    const pageRect = page?.getBoundingClientRect();
    const orphanBase = pageRect ? pageRect.top - marginRect.top - 4 : 4;

    const next: Record<string, number> = {};
    // Copilot orphans first — chronological order, stacked downward from the
    // manuscript top with a ~108px stride. They scroll with the page. (Manual
    // orphans are NOT positioned here — they render statically in the stack.)
    let oCursor = orphanBase;
    copilotOrphans.forEach((id) => {
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

  // ─── hover-highlight (state-driven, the ONLY in-prose mark) ───────────
  // The hovered comment's anchored region is washed ONLY while its card is
  // hovered — never persistently. Uses the CSS Custom Highlight API (see
  // highlightComment): it paints an arbitrary DOM Range — a precise text span
  // when the comment is text-anchored, else the whole block(s) — WITHOUT
  // mutating the DOM, so it survives ProseMirror reconciliation (which strips
  // class/attr changes) and supports fine-grained text highlighting. The
  // cleanup runs whenever hoveredId or the comment set changes, so the mark
  // can't stick after unmount / delete / create.
  useEffect(() => {
    if (!scrollEl || !hoveredId) return undefined;
    const hovered = visibleComments.find((c) => c.id === hoveredId);
    if (!hovered) return undefined;
    return highlightComment(scrollEl, hovered);
  }, [scrollEl, hoveredId, visibleComments]);

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
    const copilotComments = visibleComments.filter((c) => c.source === 'copilot');

    copilotComments.forEach((c) => {
      const id = c.id;
      if (seenIds.has(id)) return;
      // Mark seen for every copilot comment so we don't re-evaluate it each
      // render — but only a genuinely-new one (created just now AND not already
      // flashed this session) gets the active window + Tab-hint pulse. A
      // suggestion re-loaded from the DB on remount/reopen is neither.
      setSeenIds((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      const isFresh = Date.now() - Date.parse(c.createdAt) < COPILOT_FRESH_MS;
      if (flashedCopilotIds.has(id) || !isFresh) return;
      flashedCopilotIds.add(id);
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
      const target = visibleComments.find((c) => c.source === 'copilot' && activeIds.has(c.id));
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
      targetBlockIds: relevantPending.targetBlockIds,
      anchorJson: relevantPending.anchorJson,
      bodyJson: createPlainCommentDoc(body),
      authorKind: 'user',
      authorId: userId ?? null,
      source: 'manual',
    });
    setDraft('');
    onPendingRequestChange(null);
  };

  // Create an entity-level (block-less) comment about this chapter/element. No
  // anchor, no block — it joins looseComments / the bottom stack.
  const handleCreateEntityComment = async () => {
    const body = entityDraft.trim();
    if (!body) return;
    // Close the composer optimistically before awaiting so the store update
    // that adds the new comment doesn't render both cards simultaneously.
    // The submitting ref prevents the auto-collapse useEffect from firing
    // during the gap between composer close and comment arriving in the store.
    entitySubmittingRef.current = true;
    setEntityDraft('');
    setEntityComposerOpen(false);
    try {
      await commentUsecases.createComment({
        targetKind,
        targetId,
        bodyJson: createPlainCommentDoc(body),
        authorKind: 'user',
        authorId: userId ?? null,
        source: 'manual',
      });
    } finally {
      entitySubmittingRef.current = false;
    }
  };
  const openEntityComposer = () => {
    setStackExpanded(true);
    setEntityComposerOpen(true);
  };
  const closeEntityComposer = () => {
    setEntityComposerOpen(false);
    setEntityDraft('');
  };

  const runAction = async (commentId: string, action: () => Promise<unknown>) => {
    setBusyId(commentId);
    try {
      await action();
    } finally {
      setBusyId(null);
    }
  };

  // A manual comment whose anchor block was deleted. These leave the floating
  // margin and collect in the bottom stack as entity-level cards (copilot
  // orphans stay on the top stack — see applyPositions).
  const isStackOrphan = useCallback(
    (comment: Comment) => orphanIds.has(comment.id) && comment.source !== 'copilot',
    [orphanIds],
  );

  // ─── unified card renderer ────────────────────────────────────────────
  // ONE card for every comment — manual / copilot / todo. They share
  // structure, hover-highlight, the snapshot affordance, and the
  // resolve/转TODO/删除 actions; only the colour, icon, header label, and
  // (copilot-only) the accept/reject + capability summary differ. `loose` cards
  // (entity-level notes/TODOs with no block anchor) render flat in the bottom
  // stack: no leader line, no collapse-to-chip.
  const renderUnifiedCard = (comment: Comment, opts?: { loose?: boolean }) => {
    const loose = opts?.loose ?? false;
    const colorKey = commentColorKey(comment);
    const isCopilot = comment.source === 'copilot';
    const isTodo = comment.kind === 'todo';
    const isException = comment.kind === 'exception';
    const isResolved = comment.status === 'resolved';
    const isOrphan = orphanIds.has(comment.id);
    const busy = busyId === comment.id;

    // "View original" appears ONLY once the anchored prose has diverged from its
    // creation-time snapshot (edited/deleted) — anchor-aware (text vs block).
    const hasSnapshot = getBlockSnapshotsFromAnchor(comment.anchorJson).length > 0;
    const showOriginal = hasSnapshot && originalDiverged(comment, scrollEl);

    // Copilot capability summary (title / subtitle / evidence / accept label).
    const meta = isCopilot ? decodeCopilotMetadata(comment.metadataJson) : null;
    const capability = meta ? getCopilotCapabilityForMetadataKind(meta.kind) : null;
    const summary = capability && meta ? capability.renderSummary?.(meta) : null;

    const body = extractTextFromCommentBody(comment.bodyJson);
    const title = isCopilot
      ? (summary?.title ??
        (meta
          ? t('commentRail.card.copilotSuggestionWithKind', { kind: meta.kind })
          : t('commentRail.card.copilotSuggestion')))
      : body || t('commentRail.card.emptyComment');

    const isActive = activeIds.has(comment.id);
    // Tab/accept is copilot-only — but a copilot suggestion deferred into a TODO
    // behaves as a task, so it drops accept/reject and uses the shared actions.
    const showCopilotActions = isCopilot && !isTodo;

    // Going stale (active window expired) must NOT restyle the card — it only
    // stops the accept button's pulse (the glow class below is gated on isActive).
    // ONLY resolved/open changes the whole card's look (all comment types).
    const classes = ['mnote', `mnote--${colorKey}`];
    if (isResolved) classes.push('mnote--resolved');
    if (isOrphan) classes.push('mnote--orphan');
    if (loose) classes.push('mnote--loose');

    return (
      <div
        className={classes.join(' ')}
        data-comment-id={comment.id}
        onMouseEnter={() => setHoveredId(comment.id)}
        onMouseLeave={() => setHoveredId((prev) => (prev === comment.id ? null : prev))}
      >
        {!isOrphan && !loose && <div className="mnote__leader" aria-hidden="true" />}
        <div className="mnote__head">
          <span className="mnote__head-l">
            <span className="mnote__head-glyph">{colorIcon(colorKey)}</span>
            <span>
              {isCopilot && capability ? capability.displayName : t(COLOR_LABEL_KEY[colorKey])}
            </span>
          </span>
          <span className="mnote__head-r">
            <span className="mnote__head-conf">
              {isResolved ? t('commentRail.status.resolved') : t('commentRail.status.open')}
            </span>
            {!loose && (
              <button
                type="button"
                className="mnote__icon-btn"
                onClick={() => collapseToChip(comment.id)}
                aria-label={t('commentRail.actions.collapse')}
                title={t('commentRail.actions.collapseToChip')}
              >
                <Minimize2 size={11} />
              </button>
            )}
          </span>
        </div>
        <div className="mnote__title">{title}</div>
        {isCopilot && summary?.subtitle && (
          <div className="mnote__subtitle">{summary.subtitle}</div>
        )}
        {/* Suggestion body preview — element candidate's initial summary / the patch
            body. This is the model's DESCRIPTION, distinct from the anchored prose
            (which stays hover-only). */}
        {isCopilot && summary?.evidence && (
          <div className="mnote__evidence">{summary.evidence}</div>
        )}
        {/* No anchored prose is shown inline — hover highlights it in place. The
            source is recoverable via the "view original" button below, which
            appears only once the prose has diverged (same rule for every type). */}
        {showOriginal && (
          <button
            type="button"
            className={`mnote__tag${isOrphan ? ' mnote__tag--orphan' : ''}`}
            onClick={() => setSnapshotForId(comment.id)}
            title={t('commentRail.original.title')}
          >
            {isOrphan ? t('commentRail.original.deleted') : t('commentRail.original.changed')}
          </button>
        )}
        <div className="mnote__actions">
          {showCopilotActions && (
            <>
              <button
                type="button"
                className={`mnote__btn mnote__btn--primary${isActive ? ' mnote__btn--glow' : ''}`}
                disabled={busy}
                onClick={() => {
                  clearActivation(comment.id);
                  void acceptCopilotComment(comment).catch((err) =>
                    console.error('[CommentRail] copilot accept failed', err),
                  );
                }}
              >
                <Check size={12} />
                <span>{summary?.actionLabel ?? t('commentRail.actions.accept')}</span>
              </button>
              <button
                type="button"
                className="mnote__btn"
                disabled={busy}
                onClick={() => {
                  clearActivation(comment.id);
                  void rejectCopilotComment(comment.id).catch((err) =>
                    console.error('[CommentRail] copilot reject failed', err),
                  );
                }}
              >
                <X size={12} />
                <span>{t('commentRail.actions.reject')}</span>
              </button>
            </>
          )}
          {isResolved ? (
            <button
              type="button"
              className="mnote__btn"
              disabled={busy}
              onClick={() =>
                void runAction(comment.id, () => commentUsecases.reopenComment(comment.id))
              }
            >
              <RotateCcw size={12} />
              <span>{t('commentRail.actions.reopen')}</span>
            </button>
          ) : (
            <button
              type="button"
              className="mnote__btn"
              disabled={busy}
              // Manually resolving a floating card auto-collapses it to a chip —
              // the resolved note clears out of the margin but stays one click
              // away. Loose (bottom-stack) cards have no chip form, so skip them.
              onClick={() =>
                void runAction(comment.id, () => commentUsecases.resolveComment(comment.id))
                  .then(() => {
                    if (!loose) collapseToChip(comment.id);
                  })
                  .catch((err) => console.error('[CommentRail] resolve failed', err))
              }
            >
              <Check size={12} />
              <span>{t('commentRail.actions.resolve')}</span>
            </button>
          )}
          {isTodo ? (
            <button
              type="button"
              className="mnote__btn mnote__btn--ghost"
              disabled={busy}
              title={t('commentRail.actions.revertToNoteTitle')}
              onClick={() =>
                void runAction(comment.id, () => commentUsecases.revertToNote(comment.id))
              }
            >
              <ListTodo size={12} />
              <span>{t('commentRail.actions.toNote')}</span>
            </button>
          ) : (
            <button
              type="button"
              className="mnote__btn"
              disabled={busy}
              onClick={() =>
                void runAction(comment.id, () => commentUsecases.convertToTodo(comment.id))
              }
            >
              <ListTodo size={12} />
              <span>{t('commentRail.actions.toTodo')}</span>
            </button>
          )}
          {/* Manual comments can be marked as an author exception: an anchored
              "this is intentional" instruction for collaborators and Agent context. */}
          {comment.source === 'manual' &&
            (isException ? (
              <button
                type="button"
                className="mnote__btn mnote__btn--ghost"
                disabled={busy}
                title={t('commentRail.actions.unmarkExceptionTitle')}
                onClick={() =>
                  void runAction(comment.id, () =>
                    commentUsecases.setCommentKind(comment.id, 'note'),
                  )
                }
              >
                <EyeOff size={12} />
                <span>{t('commentRail.actions.unmarkException')}</span>
              </button>
            ) : (
              <button
                type="button"
                className="mnote__btn"
                disabled={busy}
                title={t('commentRail.actions.markExceptionTitle')}
                onClick={() =>
                  void runAction(comment.id, () =>
                    commentUsecases.setCommentKind(comment.id, 'exception'),
                  )
                }
              >
                <EyeOff size={12} />
                <span>{t('commentRail.actions.markException')}</span>
              </button>
            ))}
          <button
            type="button"
            className="mnote__btn"
            disabled={busy}
            onClick={() =>
              void runAction(comment.id, () => commentUsecases.deleteComment(comment.id))
            }
          >
            <Trash2 size={12} />
            <span>{t('common.delete')}</span>
          </button>
        </div>
      </div>
    );
  };

  const renderChip = (comment: Comment) => {
    const colorKey = commentColorKey(comment);
    const isCopilot = comment.source === 'copilot';
    const isActive = activeIds.has(comment.id);
    const isOrphan = orphanIds.has(comment.id);
    const classes = ['comment-chip', `comment-chip--${colorKey}`];
    if (comment.status === 'resolved') classes.push('comment-chip--resolved');
    if (isCopilot && isActive) classes.push('comment-chip--active');
    if (isOrphan) classes.push('comment-chip--orphan');
    return (
      <button
        type="button"
        className={classes.join(' ')}
        data-comment-id={comment.id}
        onClick={() => expandToCard(comment.id)}
        // Chips carry the same hover-highlight as cards — in the collapsed state
        // hovering the icon washes its anchored block/text, same as the card did.
        onMouseEnter={() => setHoveredId(comment.id)}
        onMouseLeave={() => setHoveredId((prev) => (prev === comment.id ? null : prev))}
        aria-label={t(COLOR_LABEL_KEY[colorKey])}
        title={t('commentRail.actions.expand')}
      >
        {colorIcon(colorKey)}
      </button>
    );
  };

  const renderCard = (comment: Comment) => {
    if (chipIds.has(comment.id)) return renderChip(comment);
    return renderUnifiedCard(comment);
  };

  const renderComposer = () => {
    if (!relevantPending) return null;
    return (
      <div className="mnote mnote--composer" data-comment-composer>
        <div className="mnote__leader" aria-hidden="true" />
        <div className="mnote__head">
          <span className="mnote__head-l">
            <MessageSquarePlus size={11} />
            <span>{t('commentRail.composer.newComment')}</span>
          </span>
          <button
            type="button"
            className="mnote__icon-btn"
            onClick={() => onPendingRequestChange(null)}
            aria-label={t('commentRail.actions.cancelComment')}
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
          placeholder={t('commentRail.composer.placeholder')}
          rows={4}
        />
        <div className="mnote__actions">
          <button type="button" className="mnote__btn" onClick={() => onPendingRequestChange(null)}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="mnote__btn mnote__btn--primary"
            disabled={!draft.trim()}
            onClick={() => void handleCreate()}
          >
            {t('commentRail.actions.add')}
          </button>
        </div>
      </div>
    );
  };

  // Auto-collapse the entity stack when expanded but there's nothing left to
  // show — all comments deleted, or the composer was closed without creating.
  // Skip while a creation is in-flight: the comment hasn't hit the store yet
  // so the stack looks empty, but it won't be once the await resolves.
  useEffect(() => {
    if (!stackExpanded) return;
    if (entitySubmittingRef.current) return;
    const stackComments = [...looseComments, ...visibleComments.filter(isStackOrphan)];
    if (stackComments.length === 0 && !entityComposerOpen) {
      setStackExpanded(false);
    }
  }, [stackExpanded, looseComments, visibleComments, isStackOrphan, entityComposerOpen]);

  // ─── block-less notes/TODOs (entity-level) ────────────────────────────
  // Collapsed to a single chip at the bottom of the rail (like a normal comment's
  // collapsed state) with a count; click to lay the cards out directly in a
  // floating column, which a small button collapses back.
  // Inline composer for a new entity-level comment — a flat card in the stack.
  const renderEntityComposer = () => (
    <div className="mnote mnote--manual mnote--loose mnote--entity-composer">
      <div className="mnote__head">
        <span className="mnote__head-l">
          <MessageSquarePlus size={11} />
          <span>{t('commentRail.entity.title')}</span>
        </span>
        <button
          type="button"
          className="mnote__icon-btn"
          onClick={closeEntityComposer}
          aria-label={t('common.cancel')}
        >
          <X size={12} />
        </button>
      </div>
      <textarea
        className="mnote__textarea"
        value={entityDraft}
        onChange={(e) => setEntityDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') closeEntityComposer();
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            void handleCreateEntityComment();
          }
        }}
        placeholder={t('commentRail.entity.placeholder')}
        rows={3}
        autoFocus
      />
      <div className="mnote__actions">
        <button type="button" className="mnote__btn" onClick={closeEntityComposer}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className="mnote__btn mnote__btn--primary"
          disabled={!entityDraft.trim()}
          onClick={() => void handleCreateEntityComment()}
        >
          {t('commentRail.actions.add')}
        </button>
      </div>
    </div>
  );

  const renderLooseStack = () => {
    // Entity-level notes/TODOs (no block anchor) + manual orphans (anchor block
    // deleted) share the bottom stack. Both render as flat, statically-placed
    // cards; orphans keep their "原文已删除 / 快照" affordance via renderUnifiedCard.
    const stackComments = [...looseComments, ...visibleComments.filter(isStackOrphan)].sort(
      commentSort,
    );
    const total = stackComments.length;

    // The ball is ALWAYS shown (even with no entity comments) so the author can
    // create a block-less note from here. Empty → click opens the composer;
    // non-empty → click expands the deck.
    if (!stackExpanded) {
      return (
        <div className="mnote-stack mnote-stack--collapsed">
          <button
            type="button"
            className="mnote-stack__ball"
            onClick={() => (total > 0 ? setStackExpanded(true) : openEntityComposer())}
            aria-label={
              total > 0
                ? t('commentRail.entity.noteCount', { count: total })
                : t('commentRail.entity.newNote')
            }
            title={
              total > 0
                ? t('commentRail.entity.noteCount', { count: total })
                : t('commentRail.entity.newNote')
            }
          >
            <MessageSquare size={11} />
            {total > 1 && <span className="mnote-stack__ball-count">{total}</span>}
          </button>
        </div>
      );
    }

    return (
      <div className="mnote-stack mnote-stack--open">
        <div className="mnote-stack__bar">
          <button
            type="button"
            className="mnote-stack__btn"
            onClick={() => setEntityComposerOpen(true)}
            aria-label={t('commentRail.entity.newNote')}
            title={t('commentRail.entity.newNote')}
          >
            <MessageSquarePlus size={11} />
          </button>
          <button
            type="button"
            className="mnote-stack__btn"
            onClick={() => {
              setStackExpanded(false);
              closeEntityComposer();
            }}
            aria-label={t('commentRail.actions.collapse')}
            title={t('commentRail.actions.collapse')}
          >
            <Minimize2 size={11} />
          </button>
        </div>
        <div className="mnote-stack__list">
          {entityComposerOpen && renderEntityComposer()}
          {stackComments.map((comment) => (
            <Fragment key={comment.id}>{renderUnifiedCard(comment, { loose: true })}</Fragment>
          ))}
        </div>
      </div>
    );
  };

  const snapshotComment =
    snapshotForId !== null
      ? ([...visibleComments, ...looseComments].find((c) => c.id === snapshotForId) ?? null)
      : null;
  const snapshotPayload = snapshotComment
    ? getBlockSnapshotsFromAnchor(snapshotComment.anchorJson)
    : [];
  // Block ids still in the live doc — lets the modal flag which snapshotted
  // blocks have since been edited away or deleted. Only walked when the modal
  // is actually open.
  const liveBlockIds = (() => {
    if (!snapshotComment || !scrollEl) return new Set<string>();
    const ids = new Set<string>();
    scrollEl.querySelectorAll('[data-block-id]').forEach((el) => {
      const id = (el as HTMLElement).dataset.blockId;
      if (id) ids.add(id);
    });
    return ids;
  })();

  return (
    <>
      <aside ref={marginRef} className="editor__margin" aria-label={t('commentRail.aria.margin')}>
        {visibleComments
          .filter((comment) => !isStackOrphan(comment))
          .map((comment) => (
            <Fragment key={comment.id}>{renderCard(comment)}</Fragment>
          ))}
        {renderComposer()}
        {renderLooseStack()}
      </aside>
      {snapshotComment && snapshotPayload.length > 0 && (
        <CommentSnapshotModal
          snapshots={snapshotPayload}
          liveBlockIds={liveBlockIds}
          onClose={() => setSnapshotForId(null)}
        />
      )}
    </>
  );
}
