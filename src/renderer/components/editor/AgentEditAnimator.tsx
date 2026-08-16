import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal, flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Check, X } from 'lucide-react';
import {
  useAgentEditStore,
  type AgentEditReviewBatch,
} from '../../store/agent-edit-store';
import { useAgentActivityStore } from '../../store/agent-activity-store';
import { entityKey, type ActivityEntityType } from '../../lib/agent/tool-entity-ref';
import { diffTokens, type AgentBlockChange } from '../../lib/agent/block-diff';
import { revertEntityBlock } from '../../lib/agent/chapter-prose';
import {
  acceptDriftingAgentWriteReviewBlock,
  rejectDriftingAgentWriteReviewBlock,
} from '../../lib/agent/useDriftingAgentRuntime';
import type { AgentWriteReviewBlockDecisionResult } from '../../lib/agent/runtime/drifting-write-tool-runtime';
import { agentChangeUsesAutoRevealMask } from '../../lib/extensions/agent-diff-decoration';
import {
  agentEditAnimationKey,
  agentEditOpaqueBackground,
  agentEditRectInScrollHost,
  bulkAgentEditRevealChanges,
} from './agent-edit-animation';

/**
 * Agent prose-edit reveal layer (#3 / #4). Renders OVER the manuscript inside
 * the manuscript's native scrolling content tree and:
 *
 *  - auto mode:    as each agent-changed block scrolls into view, plays a
 *                  text-level reveal — the old text shows, deletions erase and
 *                  insertions type in (typewriter), then it settles onto the real
 *                  block. Reveals run CONCURRENTLY (every change in view animates
 *                  at once); a run of deletions sharing one anchor stacks
 *                  vertically in document order. Only AFTER a block's reveal runs
 *                  do its scrollbar tick + the panel "M" clear (the edit-store
 *                  entry and the activity spot drop in lockstep).
 *  - approve mode: the diff renders IN PLACE as editor decorations (see
 *                  useEntityEditor + agent-diff-decoration) — insertions inline
 *                  green, deletions as red struck widgets — so it reflows + scrolls
 *                  with the prose. This component only floats a ✓ / ✗ just outside
 *                  the column: ✓ accepts (text already applied), ✗ reverts via Yjs.
 *                  Scrollbar ticks still show (BOTH modes) so pending edits stay
 *                  findable in a long chapter — see EditorScrollMarkers.
 *
 * `agentEditMode` is stamped onto each durable batch when the write is prepared.
 * Changing the toggle affects future edits only, so an already-visible approval
 * cannot silently turn into auto mode midway through review.
 *
 * Durable runtime changes settle their canonical review before this layer clears
 * presentation state. Only legacy changes without reviewId may still use the old
 * local block reverter.
 */
interface AgentEditAnimatorProps {
  scrollEl: HTMLElement | null;
  /** The project these edits belong to — tags queued reverts so they reach the
   *  agent's next turn in the right project. */
  projectId: string;
  entityType: ActivityEntityType;
  id: string | null | undefined;
}

// Reveal timing: erase the deleted chars then type the inserted chars, one at a
// time (typewriter), then fade out onto the real block. Pace is per-character,
// clamped so tiny edits still register and big rewrites don't drag.
const CHAR_MS = 25;
const MIN_REVEAL_MS = 500;
const MAX_REVEAL_MS = 2500;
const EXIT_MS = 320;
// A change whose anchor never appears in the DOM clears after this, so a tick /
// "M" can never get wedged on a block that won't render.
const ANCHOR_GRACE_MS = 4500;

// A block is "in view enough to reveal" when ≥35% of the BLOCK is visible, OR its
// visible slice covers ≥35% of the VIEWPORT — the latter handles a block taller
// than the viewport, whose visible fraction OF ITSELF can never reach 35%.
const REVEAL_RATIO = 0.35;

const keyOf = agentEditAnimationKey;
const sel = (blockId: string): string => `[data-block-id="${CSS.escape(blockId)}"]`;

/** The DOM element a change hangs on: the block itself, or — for a deletion —
 *  its in-place struck ghost (approve mode), else its surviving predecessor, else
 *  the first prose block. */
function anchorEl(scrollEl: HTMLElement, c: AgentBlockChange): HTMLElement | null {
  if (c.op === 'deleted') {
    // Approve mode renders the deleted text as an in-place struck widget tagged
    // with the block id — anchor to it directly: it's always in the right editor
    // at the right spot, even for a first-block deletion (no predecessor).
    const ghost = scrollEl.querySelector(
      `[data-agent-deleted-block="${CSS.escape(c.blockId)}"]`,
    ) as HTMLElement | null;
    if (ghost) return ghost;
    // Auto mode (no ghost): hang on the surviving predecessor…
    if (c.afterPrevId) {
      const prev = scrollEl.querySelector(sel(c.afterPrevId)) as HTMLElement | null;
      if (prev) return prev;
    }
    // …else the first PROSE block. NOT .page's firstElementChild — in structured
    // element/category/storyline editors .page wraps a header + several sections,
    // so its first child is the title, which floated the control at the page top.
    return scrollEl.querySelector('[data-block-id]') as HTMLElement | null;
  }
  return scrollEl.querySelector(sel(c.blockId));
}

/** Does this element's box overlap the editor's scroll viewport at all? The grace
 *  net uses it to tell an in-view edit whose reveal never fired (clear it, so the
 *  tick / "M" can't wedge) from one resting fully off-screen (leave it — its
 *  reveal legitimately waits until the user scrolls it into view). */
function intersectsViewport(el: HTMLElement, scrollEl: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  const v = scrollEl.getBoundingClientRect();
  return r.bottom > v.top && r.top < v.bottom && r.right > v.left && r.left < v.right;
}

/** A deletion is anchored to its surviving PREDECESSOR (so the control sits just
 *  below it) only in the no-ghost fallback; when anchored to the in-place ghost
 *  or the first block, it hugs that element's TOP. */
function deletionHangsBelow(el: HTMLElement, c: AgentBlockChange): boolean {
  return (
    c.op === 'deleted' &&
    c.afterPrevId != null &&
    !el.classList.contains('agent-diff-deleted-block') &&
    el.hasAttribute('data-block-id')
  );
}

/** Prefer the positioned in-flow spread as the portal host. Falling back to the
 * scroll container keeps non-standard prose surfaces functional. */
function editOverlayHost(scrollEl: HTMLElement): HTMLElement {
  return (
    (scrollEl.querySelector('.editor__spread') as HTMLElement | null) ?? scrollEl
  );
}

interface AnchorBox {
  top: number;
  left: number;
  width: number;
  height: number;
}

function sameAnchorBox(a: AnchorBox | null, b: AnchorBox | null): boolean {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.top === b.top &&
      a.left === b.left &&
      a.width === b.width &&
      a.height === b.height)
  );
}

/**
 * Track an anchor in the overlay host's CONTENT coordinates. There is
 * deliberately no scroll listener: the host is inside `.editor-scroll`, so
 * WebKit's compositor moves prose and overlay together in the same native scroll
 * transaction instead of waiting for rAF + React state to catch up.
 */
function useAnchorBox(
  scrollEl: HTMLElement,
  host: HTMLElement,
  c: AgentBlockChange,
): AnchorBox | null {
  const [box, setBox] = useState<AnchorBox | null>(null);
  useLayoutEffect(() => {
    let raf = 0;
    let observedAnchor: HTMLElement | null = null;
    const ro = new ResizeObserver(() => schedule());
    const update = () => {
      const el = anchorEl(scrollEl, c);
      if (observedAnchor !== el) {
        if (observedAnchor) ro.unobserve(observedAnchor);
        observedAnchor = el;
        if (observedAnchor) ro.observe(observedAnchor);
      }
      const next = el
        ? agentEditRectInScrollHost(
            el.getBoundingClientRect(),
            host.getBoundingClientRect(),
            host.scrollTop,
            host.scrollLeft,
            host.clientTop,
            host.clientLeft,
          )
        : null;
      setBox((previous) => (sameAnchorBox(previous, next) ? previous : next));
    };
    function schedule() {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        update();
      });
    }

    update();
    ro.observe(scrollEl);
    if (host !== scrollEl) ro.observe(host);
    const page = scrollEl.querySelector('.page');
    if (page) ro.observe(page);
    const mo = new MutationObserver(schedule);
    mo.observe(page ?? host, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('resize', schedule);
      ro.disconnect();
      mo.disconnect();
      if (raf) window.cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollEl, host, c.blockId, c.op, c.afterPrevId]);
  return box;
}

/** Copy the prose typography of the anchor block so the overlay reads as the
 *  same text morphing in place (and an opaque background to occlude the real
 *  block underneath during the crossfade). */
function useProseStyle(scrollEl: HTMLElement, c: AgentBlockChange): CSSProperties {
  // Read the anchor block's typography once so the overlay reads as the same
  // text morphing in place — via useMemo (not an effect) so the style is ready
  // on first paint and we never setState-in-effect.
  return useMemo<CSSProperties>(() => {
    const el = anchorEl(scrollEl, c);
    if (!el) return {};
    const cs = getComputedStyle(el);
    const backgroundCandidates: string[] = [];
    let backgroundNode: HTMLElement | null = el;
    while (backgroundNode) {
      backgroundCandidates.push(getComputedStyle(backgroundNode).backgroundColor);
      backgroundNode = backgroundNode.parentElement;
    }
    const bg = agentEditOpaqueBackground(backgroundCandidates);
    return {
      fontFamily: cs.fontFamily,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight as CSSProperties['fontWeight'],
      lineHeight: cs.lineHeight,
      letterSpacing: cs.letterSpacing,
      color: cs.color,
      textAlign: cs.textAlign as CSSProperties['textAlign'],
      paddingTop: cs.paddingTop,
      paddingBottom: cs.paddingBottom,
      paddingLeft: cs.paddingLeft,
      paddingRight: cs.paddingRight,
      background: bg,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollEl, c.blockId, c.op]);
}

/**
 * One block's typewriter reveal (auto mode). The old text shows first (deletions
 * on a red ground); the deleted characters erase one by one, the inserted ones
 * type in one by one (green ground), then it fades onto the real block. Driven by
 * a single char counter `progress`:
 *   progress ∈ [0, delChars]            → erasing
 *   progress ∈ (delChars, delChars+ins] → typing
 */
function RevealOverlay({
  scrollEl,
  host,
  change,
  onDone,
  crossfade = true,
  offsetTop = 0,
  onMeasure,
}: {
  scrollEl: HTMLElement;
  host: HTMLElement;
  change: AgentBlockChange;
  onDone: () => void;
  /** Auto changed/new blocks stay masked in ProseMirror while typing. At
   *  completion they swap atomically to the real block, so no crossfade. */
  crossfade?: boolean;
  /** Extra vertical offset so a run of deletions sharing one anchor stacks
   *  instead of all pinning to the anchor's bottom (the parent sums the earlier
   *  deletes' heights). 0 for everything else. */
  offsetTop?: number;
  /** Report this overlay's live height up so the parent can stack the run (and
   *  let the column compact as each delete erases). Only wired for deletions. */
  onMeasure?: (key: string, height: number) => void;
}) {
  const rect = useAnchorBox(scrollEl, host, change);
  const prose = useProseStyle(scrollEl, change);
  const segs = useMemo(() => diffTokens(change.oldText, change.newText), [change.oldText, change.newText]);
  const { delChars, insChars } = useMemo(() => {
    let d = 0;
    let i = 0;
    for (const s of segs) {
      if (s.kind === 'del') d += s.text.length;
      else if (s.kind === 'ins') i += s.text.length;
    }
    return { delChars: d, insChars: i };
  }, [segs]);
  const total = delChars + insChars;

  const [progress, setProgress] = useState(0);
  const [fading, setFading] = useState(false);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });

  // Report the overlay's live height so the parent can stack a run of deletions
  // that share one anchor (and let the column compact as each erases). Gated to
  // deletions — they're the only changes that can collapse onto a shared anchor;
  // a changed/new block owns its own anchor and never stacks.
  const key = keyOf(change);
  const isDeletion = change.op === 'deleted';
  const onMeasureRef = useRef(onMeasure);
  useEffect(() => {
    onMeasureRef.current = onMeasure;
  });
  const roRef = useRef<ResizeObserver | null>(null);
  const setNode = useCallback(
    (node: HTMLDivElement | null) => {
      roRef.current?.disconnect();
      roRef.current = null;
      // Only deletions stack, and only when a measure sink is wired (the approve
      // commit reveal passes none) — skip the observer otherwise.
      if (!node || !isDeletion || !onMeasureRef.current) return;
      const report = () => onMeasureRef.current?.(key, node.getBoundingClientRect().height);
      report();
      const ro = new ResizeObserver(report);
      ro.observe(node);
      roRef.current = ro;
    },
    [key, isDeletion],
  );

  useEffect(() => {
    const duration = Math.max(MIN_REVEAL_MS, Math.min(MAX_REVEAL_MS, total * CHAR_MS));
    let raf = 0;
    let exitTimer = 0;
    let start = 0;
    const tick = (ts: number) => {
      if (!start) start = ts;
      const t = total === 0 ? 1 : Math.min(1, (ts - start) / duration);
      setProgress(Math.round(t * total));
      if (t < 1) {
        raf = window.requestAnimationFrame(tick);
      } else if (change.op === 'deleted') {
        // A deletion has nothing to crossfade ONTO — the typewriter erase IS the
        // disappearance. Resolve immediately (the struck ghost is removed
        // synchronously via the edit store), so it can't flash through a fading
        // overlay. The EXIT crossfade is only for changed/new blocks.
        done.current();
      } else if (!crossfade) {
        done.current();
      } else {
        setFading(true);
        exitTimer = window.setTimeout(() => done.current(), EXIT_MS);
      }
    };
    raf = window.requestAnimationFrame(tick);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      if (exitTimer) window.clearTimeout(exitTimer);
    };
  }, [total, change.op, crossfade]);

  if (!rect) return null;

  const erased = Math.min(progress, delChars);
  const shownIns = Math.max(0, progress - delChars);
  const nodes: ReactNode[] = [];
  let delOff = 0;
  let insOff = 0;
  segs.forEach((s, idx) => {
    if (s.kind === 'equal') {
      nodes.push(<span key={idx}>{s.text}</span>);
      return;
    }
    if (s.kind === 'del') {
      // Erase from the front, so the remaining (un-erased) tail is the slice.
      const removed = Math.min(Math.max(erased - delOff, 0), s.text.length);
      delOff += s.text.length;
      const rest = s.text.slice(removed);
      if (rest) nodes.push(<span key={idx} className="agent-reveal__del">{rest}</span>);
      return;
    }
    const shown = Math.min(Math.max(shownIns - insOff, 0), s.text.length);
    insOff += s.text.length;
    if (shown) nodes.push(<span key={idx} className="agent-reveal__ins">{s.text.slice(0, shown)}</span>);
  });
  if (!fading && progress < total) {
    nodes.push(<span key="caret" className="agent-reveal__caret" />);
  }

  // A deletion hangs just BELOW its surviving predecessor (no-ghost fallback);
  // anchored to its in-place ghost or the first block, it sits at that top.
  const aEl = anchorEl(scrollEl, change);
  const onGhost = !!aEl && aEl.classList.contains('agent-diff-deleted-block');
  const top = aEl && deletionHangsBelow(aEl, change) ? rect.top + rect.height : rect.top;
  const pos: CSSProperties = {
    ...prose,
    // The overlay host is an in-flow child of `.editor-scroll`, so these stable
    // content coordinates move in the same compositor transaction as the prose.
    position: 'absolute',
    // offsetTop stacks a run of deletions sharing this anchor (0 otherwise).
    top: top + offsetTop,
    left: rect.left,
    width: rect.width,
    // Hold the FULL height so the overlay keeps occluding what's underneath as its
    // text erases. Crucial for a deletion over its struck ghost: without this the
    // overlay shrinks with the shrinking text and progressively UNCOVERS the ghost,
    // which fully shows for an instant at the end (the "flash"). Auto-mode
    // deletions (no ghost to occlude) keep auto-height.
    minHeight: change.op === 'deleted' ? (onGhost ? rect.height : undefined) : rect.height,
  };
  return (
    <div
      ref={setNode}
      aria-hidden="true"
      className={`agent-reveal agent-reveal--${change.op}${fading ? ' agent-reveal--fade' : ''}`}
      style={pos}
    >
      {nodes}
    </div>
  );
}

/**
 * Floating ✓ / ✗ for one block (approve mode), in the right margin hugging the
 * block's top. It shares the prose's scrolling coordinate space, so native
 * scrolling moves both together without any main-thread scroll handler.
 */
function ApproveControl({
  scrollEl,
  host,
  change,
  busy,
  onApprove,
  onReject,
}: {
  scrollEl: HTMLElement;
  host: HTMLElement;
  change: AgentBlockChange;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const { t } = useTranslation();
  const rect = useAnchorBox(scrollEl, host, change);
  const aEl = anchorEl(scrollEl, change);
  const top =
    rect && aEl && deletionHangsBelow(aEl, change)
      ? rect.top + rect.height
      : (rect?.top ?? 0);

  const label =
    change.op === 'new'
      ? t('agentEditAnimator.op.new')
      : change.op === 'deleted'
        ? t('agentEditAnimator.op.deleted')
        : t('agentEditAnimator.op.changed');
  return (
    <div
      className={`agent-approve agent-approve--${change.op}`}
      style={{
        position: 'absolute',
        top: top - 2,
        left: rect ? rect.left + rect.width + 12 : 0,
        visibility: rect ? 'visible' : 'hidden',
      }}
    >
      <span className="agent-approve__tag">{label}</span>
      <button type="button" className="agent-approve__btn agent-approve__btn--ok" title={t('fieldReview.acceptTitle')} disabled={busy} onClick={onApprove}>
        <Check size={13} />
      </button>
      <button type="button" className="agent-approve__btn agent-approve__btn--no" title={t('fieldReview.rejectTitle')} disabled={busy} onClick={onReject}>
        <X size={13} />
      </button>
    </div>
  );
}

function ReviewAllControl({
  scrollEl,
  count,
  busy,
  onApproveAll,
  onRejectAll,
}: {
  scrollEl: HTMLElement;
  count: number;
  busy: boolean;
  onApproveAll: () => void;
  onRejectAll: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const place = () => {
      const rect = scrollEl.getBoundingClientRect();
      node.style.top = `${rect.top + 12}px`;
      node.style.left = `${Math.max(rect.left + 12, rect.right - node.offsetWidth - 16)}px`;
    };
    place();
    window.addEventListener('resize', place);
    const observer = new ResizeObserver(place);
    observer.observe(scrollEl);
    observer.observe(node);
    return () => {
      window.removeEventListener('resize', place);
      observer.disconnect();
    };
  }, [scrollEl]);

  return (
    <div ref={ref} className="agent-review-all" role="group" aria-label={t('agentEditAnimator.reviewAll')}>
      <span className="agent-review-all__count">
        {t('agentEditAnimator.pendingCount', { count })}
      </span>
      <button type="button" disabled={busy} onClick={onRejectAll}>
        {t('agentEditAnimator.rejectAll')}
      </button>
      <button type="button" className="agent-review-all__accept" disabled={busy} onClick={onApproveAll}>
        {t('agentEditAnimator.acceptAll')}
      </button>
    </div>
  );
}

const EMPTY: AgentBlockChange[] = [];

function unresolvedBatchChanges(batch: AgentEditReviewBatch): AgentBlockChange[] {
  return batch.changes.filter(
    (change) => !batch.blockDecisions?.[change.blockId],
  );
}

function matchingReviewBatches(
  state: ReturnType<typeof useAgentEditStore.getState>,
  entityType: ActivityEntityType,
  id: string,
): AgentEditReviewBatch[] {
  return state.reviewOrder
    .map((reviewId) => state.reviewBatches[reviewId])
    .filter(
      (batch): batch is AgentEditReviewBatch =>
        Boolean(
          batch &&
            batch.entityType === entityType &&
            batch.id === id &&
            unresolvedBatchChanges(batch).some(
              (change) => (change.mode ?? 'approve') === 'approve',
            ),
        ),
    );
}

function syncDurableBlockDecisions(
  result: AgentWriteReviewBlockDecisionResult,
): boolean {
  const decisions: Record<string, 'accepted' | 'reverted'> = {};
  for (const block of result.blocks) {
    if (block.status === 'accepted' || block.status === 'reverted') {
      decisions[block.blockId] = block.status;
    }
  }
  const state = useAgentEditStore.getState();
  state.syncReviewBlockDecisions(result.review.id, decisions);
  const settled =
    result.review.status === 'accepted_effect' ||
    result.review.status === 'reverted';
  if (settled) state.resolveReviews([result.review.id]);
  return settled;
}

export function AgentEditAnimator({ scrollEl, projectId, entityType, id }: AgentEditAnimatorProps) {
  // Each change carries its OWN mode (stamped at record time), so the global
  // toggle only governs future edits: an 'auto' change reveals + auto-applies, an
  // 'approve' change shows ✓/✗ — even after the toggle flips. No global read here.
  const pending = useAgentEditStore((s) => s.pending);
  const editKey = id ? entityKey(entityType, id) : null;
  const entry = editKey ? pending[editKey] : undefined;
  const allChanges = entry?.changes ?? EMPTY;
  // Field (summary/kv) changes are reviewed by the in-page field affordances, not
  // this prose overlay — exclude them so we never try to anchor a `field:*` id as
  // a prose block (which would silently grace-net-resolve it unseen).
  const changes = useMemo(() => allChanges.filter((c) => !c.field), [allChanges]);
  const changesKey = changes.map(keyOf).join('|');
  // Default to 'approve' for an unstamped (legacy) change — safer to ask than to
  // silently auto-apply something the user never reviewed.
  const autoChanges = useMemo(() => changes.filter((c) => (c.mode ?? 'approve') === 'auto'), [changes]);
  const approveChanges = useMemo(
    () => changes.filter((c) => (c.mode ?? 'approve') === 'approve'),
    [changes],
  );

  // Auto mode: every change currently playing its reveal, keyed. CONCURRENT —
  // each fires the moment it enters the viewport, not serially. Held as captured
  // change data so an overlay still finishes after its change resolves out of the
  // store. Approve/reject commits live in `committing`, also concurrently.
  const [revealing, setRevealing] = useState<Map<string, AgentBlockChange>>(() => new Map());
  const [committing, setCommitting] = useState<Map<string, AgentBlockChange>>(
    () => new Map(),
  );
  const [bulkBusy, setBulkBusy] = useState(false);
  const settlingRef = useRef(new Set<string>());

  const markBlockSeen = useCallback(
    (change: AgentBlockChange) => {
      if (!id) return;
      useAgentActivityStore
        .getState()
        .markSpotSeen(entityType, id, { block: change.blockId });
    },
    [entityType, id],
  );

  const markBatchSeen = useCallback(
    (batch: AgentEditReviewBatch) => {
      for (const change of batch.changes) markBlockSeen(change);
    },
    [markBlockSeen],
  );

  // Live heights (keyed) of the deletion overlays currently revealing, reported
  // by each RevealOverlay — used to STACK a run of deletions that share one
  // anchor. A run of consecutive deletes all hangs under the same surviving
  // predecessor (block-diff anchors every delete to its nearest survivor), so
  // without an offset they'd pin to the same spot and overlap. Each delete sits
  // below the summed heights of the earlier deletes in its run; the column
  // compacts as they erase (and as each resolves out of the run).
  const [heights, setHeights] = useState<Map<string, number>>(() => new Map());
  const reportHeight = useCallback((k: string, h: number) => {
    setHeights((prev) => (prev.get(k) === h ? prev : new Map(prev).set(k, h)));
  }, []);
  // Document-order index so a run stacks the way it reads in the manuscript, not
  // in `revealing`'s firing order (deletes can enter the viewport out of order).
  const orderIndex = useMemo(() => {
    const m = new Map<string, number>();
    changes.forEach((c, i) => m.set(keyOf(c), i));
    return m;
  }, [changesKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const stackOffsets = useMemo(() => {
    // Group the revealing DELETIONS by their shared anchor (afterPrevId, or the
    // first-block fallback when null) — only deletions can collapse onto one
    // anchor; a changed/new block owns its own.
    const groups = new Map<string, AgentBlockChange[]>();
    for (const c of revealing.values()) {
      if (c.op !== 'deleted') continue;
      const g = c.afterPrevId ?? '#first';
      const list = groups.get(g);
      if (list) list.push(c);
      else groups.set(g, [c]);
    }
    const offsets = new Map<string, number>();
    for (const list of groups.values()) {
      if (list.length < 2) continue; // a lone delete needs no offset
      list.sort((a, b) => (orderIndex.get(keyOf(a)) ?? 0) - (orderIndex.get(keyOf(b)) ?? 0));
      let acc = 0;
      for (const c of list) {
        offsets.set(keyOf(c), acc);
        acc += heights.get(keyOf(c)) ?? 0;
      }
    }
    return offsets;
  }, [revealing, heights, orderIndex]);

  const stopRevealing = useCallback((c: AgentBlockChange) => {
    setRevealing((prev) => {
      if (!prev.has(keyOf(c))) return prev;
      const next = new Map(prev);
      next.delete(keyOf(c));
      return next;
    });
    // Drop its reported height too, so the stacking map tracks the live run (and
    // doesn't accumulate stale keys across a session).
    setHeights((prev) => {
      if (!prev.has(keyOf(c))) return prev;
      const next = new Map(prev);
      next.delete(keyOf(c));
      return next;
    });
  }, []);

  const startCommitting = useCallback((nextChanges: readonly AgentBlockChange[]) => {
    setCommitting((previous) => {
      const next = new Map(previous);
      for (const change of nextChanges) {
        next.set(keyOf(change), change);
      }
      return next;
    });
  }, []);

  const stopCommitting = useCallback((change: AgentBlockChange) => {
    setCommitting((previous) => {
      const key = keyOf(change);
      if (!previous.has(key)) return previous;
      const next = new Map(previous);
      next.delete(key);
      return next;
    });
  }, []);

  const resolve = useCallback(
    (c: AgentBlockChange) => {
      if (!id) return;
      const store = useAgentEditStore.getState();
      store.resolveBlocks(entityType, id, [c.blockId]);
      if (c.reviewId && (c.mode ?? 'approve') === 'auto') {
        const current = useAgentEditStore.getState();
        const key = entityKey(entityType, id);
        const hasAutoVisualChanges = Boolean(
          current.pending[key]?.changes.some(
            (change) =>
              change.reviewId &&
              (change.mode ?? 'approve') === 'auto',
          ),
        );
        if (!hasAutoVisualChanges) {
          current.resolveReviews(
            current.reviewOrder.filter((reviewId) => {
              const batch = current.reviewBatches[reviewId];
              return Boolean(
                batch &&
                  batch.entityType === entityType &&
                  batch.id === id &&
                  batch.changes.every(
                    (change) => change.mode === 'auto',
                  ),
              );
            }),
          );
        }
      }
      // Clearing the activity spot is what drops the panel "M" once every change
      // has been revealed — so the badge tracks "unrevealed edits", not "unclicked".
      useAgentActivityStore.getState().markSpotSeen(entityType, id, { block: c.blockId });
    },
    [entityType, id],
  );

  const approveOne = useCallback(
    (change: AgentBlockChange) => {
      if (!id) return;
      if (!change.reviewId) {
        if (change.op !== 'deleted') resolve(change);
        startCommitting([change]);
        return;
      }
      const reviewId = change.reviewId;
      const settlementKey = `${reviewId}:${change.blockId}:accept`;
      if (settlingRef.current.has(settlementKey)) return;
      const state = useAgentEditStore.getState();
      const batch = state.reviewBatches[reviewId];
      if (!batch) return;
      settlingRef.current.add(settlementKey);
      void acceptDriftingAgentWriteReviewBlock(
        reviewId,
        change.blockId,
        'Accepted block from editor review',
      )
        .then((result) => {
          if (result.block.status !== 'accepted') {
            throw new Error(
              `Agent review block ${reviewId}/${change.blockId} did not accept (status: ${result.block.status})`,
            );
          }
          flushSync(() => startCommitting([change]));
          const settled = syncDurableBlockDecisions(result);
          markBlockSeen(change);
          if (settled) markBatchSeen(batch);
        })
        .catch((error) => {
          console.error(
            '[agent] approve block: durable review failed, keeping block pending',
            error,
          );
        })
        .finally(() => {
          settlingRef.current.delete(settlementKey);
        });
    },
    [id, markBatchSeen, markBlockSeen, resolve, startCommitting],
  );

  const rejectOne = useCallback(
    (change: AgentBlockChange) => {
      if (!id) return;
      if (!change.reviewId) {
        void revertEntityBlock(entityType, id, change, undefined, projectId)
          .then(() => {
            resolve(change);
            useAgentEditStore
              .getState()
              .recordRevert(projectId, entityType, id, change);
          })
          .catch((error) => {
            console.error('[agent] reject: revert failed, keeping edit pending', error);
          });
        return;
      }

      const reviewId = change.reviewId;
      const settlementKey = `${reviewId}:${change.blockId}:reject`;
      if (settlingRef.current.has(settlementKey)) return;
      const initial = useAgentEditStore.getState();
      const batch = initial.reviewBatches[reviewId];
      if (!batch) return;
      settlingRef.current.add(settlementKey);

      const settle = async () => {
        const result = await rejectDriftingAgentWriteReviewBlock(
          reviewId,
          change.blockId,
          'Rejected block from editor review',
        );
        if (result.block.status !== 'reverted') {
          throw new Error(
            `Agent review block ${reviewId}/${change.blockId} did not revert (status: ${result.block.status})`,
          );
        }
        const reverted = bulkAgentEditRevealChanges([change], 'reverted');
        flushSync(() => startCommitting(reverted));
        const current = useAgentEditStore.getState();
        current.recordRevert(projectId, entityType, id, change);
        const reviewSettled = syncDurableBlockDecisions(result);
        markBlockSeen(change);
        if (reviewSettled) {
          markBatchSeen(batch);
        }
      };

      void settle()
        .catch((error) => {
          console.error(
            '[agent] reject block: guarded inverse failed, keeping block pending',
            error,
          );
        })
        .finally(() => {
          settlingRef.current.delete(settlementKey);
        });
    },
    [
      entityType,
      id,
      markBatchSeen,
      markBlockSeen,
      projectId,
      resolve,
      startCommitting,
    ],
  );

  const approveAll = useCallback(() => {
    if (!id || bulkBusy) return;
    const state = useAgentEditStore.getState();
    const batches = matchingReviewBatches(state, entityType, id);
    if (batches.length === 0) return;
    setBulkBusy(true);
    void (async () => {
      for (const batch of batches) {
        for (const change of unresolvedBatchChanges(batch)) {
          const result = await acceptDriftingAgentWriteReviewBlock(
            batch.reviewId,
            change.blockId,
            'Accepted all from editor review',
          );
          if (result.block.status !== 'accepted') {
            throw new Error(
              `Agent review block ${batch.reviewId}/${change.blockId} did not accept (status: ${result.block.status})`,
            );
          }
          // Start the reveal before the SQLite-backed projection removes the
          // in-editor diff anchor. Each completed block is projected at once so
          // a later failure cannot visually resurrect already-durable decisions.
          flushSync(() => startCommitting([change]));
          const settled = syncDurableBlockDecisions(result);
          markBlockSeen(change);
          if (settled) markBatchSeen(batch);
        }
      }
    })()
      .catch((error) => {
        console.error(
          '[agent] approve all: durable review failed, keeping unresolved blocks pending',
          error,
        );
      })
      .finally(() => setBulkBusy(false));
  }, [bulkBusy, entityType, id, markBatchSeen, markBlockSeen, startCommitting]);

  const rejectAll = useCallback(() => {
    if (!id || bulkBusy) return;
    const state = useAgentEditStore.getState();
    const batches = matchingReviewBatches(state, entityType, id);
    if (batches.length === 0) return;
    setBulkBusy(true);
    const settle = async () => {
      // Newest effects are reverted first so overlapping edits unwind in the
      // same order as a stack. Every block owns a durable `revert_started`
      // checkpoint before the guarded Yjs inverse runs.
      for (const batch of [...batches].reverse()) {
        const rejected = [...unresolvedBatchChanges(batch)].reverse();
        for (const change of rejected) {
          const result = await rejectDriftingAgentWriteReviewBlock(
            batch.reviewId,
            change.blockId,
            'Rejected all from editor review',
          );
          if (result.block.status !== 'reverted') {
            throw new Error(
              `Agent review block ${batch.reviewId}/${change.blockId} did not revert (status: ${result.block.status})`,
            );
          }
          flushSync(() =>
            startCommitting(
              bulkAgentEditRevealChanges([change], 'reverted'),
            ),
          );
          const current = useAgentEditStore.getState();
          current.recordRevert(projectId, entityType, id, change);
          const reviewSettled = syncDurableBlockDecisions(result);
          markBlockSeen(change);
          if (reviewSettled) markBatchSeen(batch);
        }
      }
    };

    void settle()
      .catch((error) => {
        console.error(
          '[agent] reject all: durable inverse failed, keeping unresolved blocks pending',
          error,
        );
      })
      .finally(() => setBulkBusy(false));
  }, [
    bulkBusy,
    entityType,
    id,
    markBatchSeen,
    markBlockSeen,
    projectId,
    startCommitting,
  ]);

  // Auto mode: as each pending block comes into view, fire its reveal —
  // concurrently, so every change on screen animates at once. Driven by a RECT
  // CHECK that re-queries the anchor every pass, NOT a one-shot
  // IntersectionObserver.observe(node), because the anchor element is not stable:
  // when the agent edits the OPEN chapter the change lands in Yjs + the store
  // synchronously (re-running this effect), but ProseMirror re-syncs its DOM a
  // tick LATER and, for an edited block, commonly REPLACES the <p> node
  // (delete+insert). An observer pinned to the original node then watches a
  // detached element forever — its callback never fires, so the reveal silently
  // never plays and the tick / "M" wedge (the frequent "edit didn't animate"
  // bug). Re-running anchorEl() on scroll / resize / DOM-mutation always tests
  // the CURRENT node, so a replaced or late-rendered block is picked up next frame.
  useLayoutEffect(() => {
    if (!scrollEl || !id || autoChanges.length === 0) return undefined;

    const fired = new Set<string>(); // change keys whose reveal has been kicked off

    const check = () => {
      const v = scrollEl.getBoundingClientRect();
      const toFire: AgentBlockChange[] = [];
      for (const c of autoChanges) {
        const k = keyOf(c);
        if (fired.has(k)) continue;
        const el = anchorEl(scrollEl, c);
        if (!el || !el.isConnected) continue;
        const r = el.getBoundingClientRect();
        const visible = Math.min(r.bottom, v.bottom) - Math.max(r.top, v.top);
        if (visible <= 0) continue;
        // ≥35% of the block is visible, OR its visible slice covers ≥35% of the
        // viewport (the block-taller-than-viewport case).
        if (visible >= r.height * REVEAL_RATIO || visible >= v.height * REVEAL_RATIO) {
          fired.add(k);
          toFire.push(c);
        }
      }
      if (toFire.length === 0) return;
      setRevealing((prev) => {
        let next = prev;
        for (const c of toFire) {
          const k = keyOf(c);
          if (next.has(k)) continue;
          if (next === prev) next = new Map(prev);
          next.set(k, c);
        }
        return next;
      });
    };

    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        check();
      });
    };

    check(); // an in-view edit fires at once — no wait for a scroll / observer tick
    scrollEl.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    // The Yjs→ProseMirror DOM sync (and any later node replacement) lands as a
    // childList/subtree mutation — re-check so a block absent (or swapped out) on
    // the first pass reveals once its node settles into the DOM.
    const mo = new MutationObserver(schedule);
    mo.observe(scrollEl, { childList: true, subtree: true });

    return () => {
      scrollEl.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      mo.disconnect();
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [scrollEl, id, changesKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Portal into the positioned in-flow spread. The ancestor `.editor-scroll`
  // clips it naturally, and WebKit scrolls the overlay in the same compositor
  // transaction as the manuscript instead of waiting on main-thread rect state.
  const layerHost = scrollEl ? editOverlayHost(scrollEl) : null;
  const hasLayer =
    !!scrollEl &&
    !!layerHost &&
    !!id &&
    (changes.length > 0 || committing.size > 0 || revealing.size > 0);

  // Safety net (per-change, AUTO changes only) so a tick / "M" can't get wedged
  // when a reveal never plays. After a grace period an auto change clears if
  // EITHER (a) it has no anchor (the block never rendered), or (b) it's anchored
  // and resting within the editor viewport yet still pending — i.e. its reveal
  // never fired (the block came only partly into view, under the reveal ratio). A
  // block fully OFF the viewport is left alone: its reveal — and its marker clear
  // — happen when the user scrolls it in (the tick is the "find me" handle for it).
  // An APPROVE change is never auto-resolved here — that would silently ACCEPT an
  // edit the user never approved; it waits for the user to scroll to it and ✓/✗.
  useEffect(() => {
    if (!scrollEl || !id || autoChanges.length === 0) return;
    const t = window.setTimeout(() => {
      for (const c of autoChanges) {
        const el = anchorEl(scrollEl, c);
        if (!el || intersectsViewport(el, scrollEl)) resolve(c);
      }
    }, ANCHOR_GRACE_MS);
    return () => window.clearTimeout(t);
  }, [scrollEl, id, changesKey, resolve]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep rendering while a reveal (auto) or commit (approve) is in flight even
  // after its change resolves out of the store — otherwise the overlay would
  // unmount mid-animation the instant `changes` empties.
  if (!scrollEl || !layerHost || !id || !hasLayer) return null;

  return (
    <>
      {createPortal(
        <div className="agent-edit-layer">
          {/* Auto changes: each plays its reveal concurrently as it enters the
              viewport. Rendered off `revealing` alone — that map is only ever
              populated by the auto effect, so a reveal still finishes if its change
              resolves out from under it. */}
          {[...revealing.values()].map((c) => {
            const maskedAutoReveal = agentChangeUsesAutoRevealMask(c);
            return (
              <RevealOverlay
                key={keyOf(c)}
                scrollEl={scrollEl}
                host={layerHost}
                change={c}
                crossfade={!maskedAutoReveal}
                offsetTop={stackOffsets.get(keyOf(c)) ?? 0}
                onMeasure={reportHeight}
                onDone={() => {
                  // Every auto changed/new block stays masked in the real editor
                  // until the overlay contains the complete text. Resolve the
                  // mask and remove that identical overlay in one React commit:
                  // existing and Added files share the same no-double-paint rule.
                  if (maskedAutoReveal) {
                    flushSync(() => {
                      resolve(c);
                      stopRevealing(c);
                    });
                    return;
                  }
                  resolve(c);
                  // Drop the occluder in the SAME frame the doc change lands
                  // (flushSync forces the React unmount synchronous) — a
                  // deletion otherwise leaves an empty opaque box for one paint.
                  if (c.op === 'deleted') flushSync(() => stopRevealing(c));
                  else stopRevealing(c);
                }}
              />
            );
          })}
          {/* Approve changes: the diff itself renders IN PLACE via editor decorations
              (see useEntityEditor); here we float the ✓ / ✗ just outside the column.
              ✓ clears the pending block (text already applied) AND plays a one-off
              typewriter commit over it; ✗ reverts via Yjs. Per-change, so approve and
              auto changes can coexist on the same entity. */}
          {approveChanges.map((c) => (
            <ApproveControl
              key={keyOf(c)}
              scrollEl={scrollEl}
              host={layerHost}
              change={c}
              busy={bulkBusy || committing.size > 0}
              onApprove={() => approveOne(c)}
              onReject={() => rejectOne(c)}
            />
          ))}
          {/* The approved block's one-off commit reveal (occludes it, plays, fades).
              For a DELETION the pending change was kept (placeholder held the space) —
              resolve it now that the erase animation is done, so the collapse happens
              AFTER the reveal, not before it. */}
          {[...committing.values()].map((change) => (
            <RevealOverlay
              key={`commit:${keyOf(change)}`}
              scrollEl={scrollEl}
              host={layerHost}
              change={change}
              onDone={() => {
                if (change.op === 'deleted') {
                  resolve(change);
                  // flushSync: unmount the occluder synchronously with the (synchronous)
                  // ghost removal, so neither the struck ghost nor an empty box ever
                  // paints alone — kills both the flash and the residual flicker.
                  flushSync(() => stopCommitting(change));
                } else {
                  stopCommitting(change);
                }
              }}
            />
          ))}
        </div>,
        layerHost,
      )}
      {approveChanges.length > 0 &&
        createPortal(
          <ReviewAllControl
            scrollEl={scrollEl}
            count={approveChanges.length}
            busy={bulkBusy || committing.size > 0}
            onApproveAll={approveAll}
            onRejectAll={rejectAll}
          />,
          document.body,
        )}
    </>
  );
}
