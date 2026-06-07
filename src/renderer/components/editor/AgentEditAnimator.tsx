import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal, flushSync } from 'react-dom';
import { Check, X } from 'lucide-react';
import { useAgentEditStore } from '../../store/agent-edit-store';
import { useAgentActivityStore } from '../../store/agent-activity-store';
import { entityKey, type ActivityEntityType } from '../../lib/agent/tool-entity-ref';
import { diffTokens, type AgentBlockChange } from '../../lib/agent/block-diff';
import { revertEntityBlock } from '../../lib/agent/chapter-prose';

/**
 * Agent prose-edit reveal layer (#3 / #4). Renders OVER the manuscript (a fixed
 * portal that tracks each block's live rect) and:
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
 * The live GLOBAL `agentEditMode` governs behavior (the toggle is authoritative):
 * switching to auto auto-applies pending edits, switching to approve surfaces ✓/✗.
 *
 * Pure UI: the entity content already holds the agent's edit. Nothing here writes
 * the doc except an explicit ✗ (reject), which calls revertEntityBlock.
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

const keyOf = (c: AgentBlockChange): string => `${c.op}:${c.blockId}`;
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

/** Track an anchor element's viewport rect, refreshed on scroll/resize. */
function useAnchorRect(scrollEl: HTMLElement, c: AgentBlockChange): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    let raf = 0;
    const update = () => {
      const el = anchorEl(scrollEl, c);
      setRect(el ? el.getBoundingClientRect() : null);
    };
    update();
    const onScroll = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        update();
      });
    };
    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      scrollEl.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) window.cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollEl, c.blockId, c.op, c.afterPrevId]);
  return rect;
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
    const page = scrollEl.querySelector('.page') as HTMLElement | null;
    const bg = (page ? getComputedStyle(page).backgroundColor : cs.backgroundColor) || '#fff';
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
  change,
  onDone,
  offsetTop = 0,
  onMeasure,
}: {
  scrollEl: HTMLElement;
  change: AgentBlockChange;
  onDone: () => void;
  /** Extra vertical offset so a run of deletions sharing one anchor stacks
   *  instead of all pinning to the anchor's bottom (the parent sums the earlier
   *  deletes' heights). 0 for everything else. */
  offsetTop?: number;
  /** Report this overlay's live height up so the parent can stack the run (and
   *  let the column compact as each delete erases). Only wired for deletions. */
  onMeasure?: (key: string, height: number) => void;
}) {
  const rect = useAnchorRect(scrollEl, change);
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
      } else {
        setFading(true);
        window.setTimeout(() => done.current(), EXIT_MS);
      }
    };
    raf = window.requestAnimationFrame(tick);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [total, change.op]);

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
  const top = aEl && deletionHangsBelow(aEl, change) ? rect.bottom : rect.top;
  const pos: CSSProperties = {
    ...prose,
    // absolute (not fixed) so the layer's clip-path crops it to the editor
    // viewport; the layer is inset:0 fixed, so these viewport coords still apply.
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
 * block's top. Positioned IMPERATIVELY in the scroll handler (no requestAnimation
 * Frame deferral, no React state) so it tracks the block frame-for-frame instead
 * of lagging a frame behind the prose on scroll.
 */
function ApproveControl({
  scrollEl,
  change,
  onApprove,
  onReject,
}: {
  scrollEl: HTMLElement;
  change: AgentBlockChange;
  onApprove: () => void;
  onReject: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const place = () => {
      const a = anchorEl(scrollEl, change);
      if (!a) {
        node.style.visibility = 'hidden';
        return;
      }
      const r = a.getBoundingClientRect();
      const top = deletionHangsBelow(a, change) ? r.bottom : r.top;
      node.style.visibility = 'visible';
      node.style.top = `${top - 2}px`;
      node.style.left = `${r.right + 12}px`;
    };
    place();
    // Scroll handler runs synchronously (no rAF) so the control tracks the block
    // frame-for-frame instead of lagging behind on scroll.
    scrollEl.addEventListener('scroll', place, { passive: true });
    window.addEventListener('resize', place);
    // Observe the scroll container AND its content (.page) so the control also
    // re-glues when blocks above it grow/shrink, not only on scroll.
    const ro = new ResizeObserver(place);
    ro.observe(scrollEl);
    const page = scrollEl.querySelector('.page');
    if (page) ro.observe(page);
    // …and a MutationObserver, because when the agent edits the OPEN chapter the
    // target block's DOM (esp. a freshly appended/inserted one at the end) syncs
    // from Yjs a tick after this mounts — so the anchor isn't there on first place.
    let raf = 0;
    const mo = new MutationObserver(() => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        place();
      });
    });
    mo.observe(scrollEl, { childList: true, subtree: true });
    return () => {
      scrollEl.removeEventListener('scroll', place);
      window.removeEventListener('resize', place);
      ro.disconnect();
      mo.disconnect();
      if (raf) window.cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollEl, change.blockId, change.op, change.afterPrevId]);

  const label = change.op === 'new' ? '新增' : change.op === 'deleted' ? '删除' : '改写';
  return (
    <div
      ref={ref}
      className={`agent-approve agent-approve--${change.op}`}
      // absolute so the layer's clip-path crops it to the editor viewport (layer
      // is inset:0 fixed, so the viewport coords place() writes still apply).
      style={{ position: 'absolute', top: 0, left: 0, visibility: 'hidden' }}
    >
      <span className="agent-approve__tag">{label}</span>
      <button type="button" className="agent-approve__btn agent-approve__btn--ok" title="采纳这处改动" onClick={onApprove}>
        <Check size={13} />
      </button>
      <button type="button" className="agent-approve__btn agent-approve__btn--no" title="拒绝并还原" onClick={onReject}>
        <X size={13} />
      </button>
    </div>
  );
}

const EMPTY: AgentBlockChange[] = [];

export function AgentEditAnimator({ scrollEl, projectId, entityType, id }: AgentEditAnimatorProps) {
  // Each change carries its OWN mode (stamped at record time), so the global
  // toggle only governs future edits: an 'auto' change reveals + auto-applies, an
  // 'approve' change shows ✓/✗ — even after the toggle flips. No global read here.
  const pending = useAgentEditStore((s) => s.pending);
  const entry = id ? pending[entityKey(entityType, id)] : undefined;
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
  // store. Approve commit (one-off) lives in `committing`.
  const [revealing, setRevealing] = useState<Map<string, AgentBlockChange>>(() => new Map());
  const [committing, setCommitting] = useState<AgentBlockChange | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);

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

  const resolve = useCallback(
    (c: AgentBlockChange) => {
      if (!id) return;
      useAgentEditStore.getState().resolveBlocks(entityType, id, [c.blockId]);
      // Clearing the activity spot is what drops the panel "M" once every change
      // has been revealed — so the badge tracks "unrevealed edits", not "unclicked".
      useAgentActivityStore.getState().markSpotSeen(entityType, id, { block: c.blockId });
    },
    [entityType, id],
  );

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
  useEffect(() => {
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

  // Clip the overlay layer to the editor's scroll viewport, so a reveal/control
  // anchored to a block scrolled near the bottom doesn't spill over the
  // BottomTimeline (or above the toolbar). Recomputed on layout change only —
  // scrollEl's own rect doesn't move while the content scrolls inside it.
  const hasLayer = !!scrollEl && !!id && (changes.length > 0 || !!committing || revealing.size > 0);
  useEffect(() => {
    if (!hasLayer || !scrollEl) return undefined;
    const layer = layerRef.current;
    if (!layer) return undefined;
    const clip = () => {
      const r = scrollEl.getBoundingClientRect();
      const t = Math.max(0, r.top);
      const right = Math.max(0, window.innerWidth - r.right);
      const b = Math.max(0, window.innerHeight - r.bottom);
      const l = Math.max(0, r.left);
      layer.style.clipPath = `inset(${t}px ${right}px ${b}px ${l}px)`;
    };
    clip();
    window.addEventListener('resize', clip);
    const ro = new ResizeObserver(clip);
    ro.observe(scrollEl);
    return () => {
      window.removeEventListener('resize', clip);
      ro.disconnect();
    };
  }, [scrollEl, hasLayer]);

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
  if (!scrollEl || !id || !hasLayer) return null;

  return createPortal(
    <div ref={layerRef} className="agent-edit-layer">
      {/* Auto changes: each plays its reveal concurrently as it enters the
          viewport. Rendered off `revealing` alone — that map is only ever
          populated by the auto effect, so a reveal still finishes if its change
          resolves out from under it. */}
      {[...revealing.values()].map((c) => (
        <RevealOverlay
          key={keyOf(c)}
          scrollEl={scrollEl}
          change={c}
          offsetTop={stackOffsets.get(keyOf(c)) ?? 0}
          onMeasure={reportHeight}
          onDone={() => {
            resolve(c);
            // Drop the occluder in the SAME frame the doc change lands (flushSync
            // forces the React unmount synchronous) — a deletion otherwise leaves
            // an empty opaque box for one paint (flicker). Non-deletions keep their
            // crossfade, so a plain unmount is fine.
            if (c.op === 'deleted') flushSync(() => stopRevealing(c));
            else stopRevealing(c);
          }}
        />
      ))}
      {/* Approve changes: the diff itself renders IN PLACE via editor decorations
          (see useEntityEditor); here we float the ✓ / ✗ just outside the column.
          ✓ clears the pending block (text already applied) AND plays a one-off
          typewriter commit over it; ✗ reverts via Yjs. Per-change, so approve and
          auto changes can coexist on the same entity. */}
      {approveChanges.map((c) => (
          <ApproveControl
            key={keyOf(c)}
            scrollEl={scrollEl}
            change={c}
            onApprove={() => {
              // changed / new: the real (post-edit) block already holds the space,
              // so clear the in-place decoration now and play the commit reveal over
              // it. DELETION: the struck placeholder IS the decoration — keep it
              // until the erase reveal finishes (resolve in the commit's onDone)
              // so blocks below don't jump up and overlap the animation.
              if (c.op !== 'deleted') resolve(c);
              setCommitting(c);
            }}
            onReject={() => {
              // Only clear the review marker once the undo ACTUALLY applies. If
              // the revert throws (block id moved, doc unregistered), the agent's
              // text is still in the doc — so keep the block flagged (the ✓/✗
              // control stays, the user can retry) instead of silently looking
              // reverted while the edit secretly remains.
              void revertEntityBlock(entityType, id, c)
                .then(() => {
                  resolve(c);
                  // Tell the agent on its next turn that this edit was undone — it
                  // ran bypassPermissions and otherwise believes the edit stuck.
                  // Queue ONLY on a successful revert (mirrors keeping the block
                  // pending when the revert throws).
                  useAgentEditStore.getState().recordRevert(projectId, entityType, id, c);
                })
                .catch((err) => {
                  console.error('[agent] reject: revert failed, keeping edit pending', err);
                });
            }}
          />
        ))}
      {/* The approved block's one-off commit reveal (occludes it, plays, fades).
          For a DELETION the pending change was kept (placeholder held the space) —
          resolve it now that the erase animation is done, so the collapse happens
          AFTER the reveal, not before it. */}
      {committing && (
        <RevealOverlay
          key={`commit:${keyOf(committing)}`}
          scrollEl={scrollEl}
          change={committing}
          onDone={() => {
            if (committing.op === 'deleted') {
              resolve(committing);
              // flushSync: unmount the occluder synchronously with the (synchronous)
              // ghost removal, so neither the struck ghost nor an empty box ever
              // paints alone — kills both the flash and the residual flicker.
              flushSync(() => setCommitting(null));
            } else {
              setCommitting(null);
            }
          }}
        />
      )}
    </div>,
    document.body,
  );
}
