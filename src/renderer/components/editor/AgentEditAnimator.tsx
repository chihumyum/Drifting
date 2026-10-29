import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { createPortal, flushSync } from 'react-dom';
import { useAgentEditStore } from '../../store/agent-edit-store';
import { useAgentActivityStore } from '../../store/agent-activity-store';
import { useSettingsStore } from '../../store/settings-store';
import { entityKey, type ActivityEntityType } from '../../lib/agent/tool-entity-ref';
import { AgentRevealText } from './AgentRevealText';
import { diffTokens, type AgentBlockChange } from '../../lib/agent/block-diff';
import { agentChangeUsesAutoRevealMask } from '../../lib/extensions/agent-diff-decoration';
import {
  agentEditAnimationKey,
  agentEditOpaqueBackground,
  agentEditProseStyle,
  agentEditRectInScrollHost,
  agentEditRevealCount,
  agentEditRevealTiming,
  agentRevealPieces,
  agentRevealSteps,
  createAgentEditSeenTracker,
} from './agent-edit-animation';
import { recordAgentRecentChange } from '../../lib/agent-recent-changes';
import { getPlatformRuntime } from '../../platform/runtime';

/** Displays committed Agent edits until viewed or acknowledged in the sidebar.
 * This layer owns presentation only; it never accepts, rejects or changes prose. */
interface AgentEditAnimatorProps {
  scrollEl: HTMLElement | null;
  /** Owning project; canonical write receipts remain project-scoped. */
  projectId: string;
  entityType: ActivityEntityType;
  id: string | null | undefined;
}

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
  prose: CSSProperties;
}

function sameAnchorBox(a: AnchorBox | null, b: AnchorBox | null): boolean {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.top === b.top &&
      a.left === b.left &&
      a.width === b.width &&
      a.height === b.height &&
      Object.keys(a.prose).every((key) => a.prose[key as keyof CSSProperties] === b.prose[key as keyof CSSProperties]))
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
        ? {
          ...agentEditRectInScrollHost(
            el.getBoundingClientRect(),
            host.getBoundingClientRect(),
            host.scrollTop,
            host.scrollLeft,
            host.clientTop,
            host.clientLeft,
          ),
          prose: readProseStyle(el),
        }
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
    mo.observe(page ?? host, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['style', 'class', 'dir', 'lang'],
    });
    // Preferences update root CSS variables; an equal-height paragraph can
    // change its wrapping/indent without triggering ResizeObserver.
    mo.observe(document.documentElement, {
      attributes: true, attributeFilter: ['style', 'class', 'dir', 'lang'],
    });
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
function readProseStyle(el: HTMLElement): CSSProperties {
  const backgroundCandidates: string[] = [];
  let backgroundNode: HTMLElement | null = el;
  while (backgroundNode) {
    backgroundCandidates.push(getComputedStyle(backgroundNode).backgroundColor);
    backgroundNode = backgroundNode.parentElement;
  }
  return {
    ...agentEditProseStyle(getComputedStyle(el)),
    background: agentEditOpaqueBackground(backgroundCandidates),
  };
}

/**
 * One block's reveal (auto mode). On the desktop each changed place plays in
 * place, one character a step (agentRevealFrame): longer old words are deleted
 * from the front until both sides are as long and then overwritten, shorter
 * ones are overwritten and the rest of the new words inserted; new words show
 * green, rewritten ones purple. The paused mobile shell keeps the typewriter:
 * the deleted characters erase one by one (on a red ground), then the inserted
 * ones type in (green ground), driven by one char counter `progress`:
 *   progress ∈ [0, delChars]            → erasing
 *   progress ∈ (delChars, delChars+ins] → typing
 * Either way it then swaps (or fades) onto the real block.
 */
function RevealOverlay({
  scrollEl,
  host,
  change,
  revealCount,
  onDone,
  crossfade = true,
  offsetTop = 0,
  onMeasure,
}: {
  scrollEl: HTMLElement;
  host: HTMLElement;
  change: AgentBlockChange;
  revealCount: number;
  onDone: () => void;
  /** Auto changed/new blocks stay masked in ProseMirror while typing. At
   *  completion they swap atomically to the real block, so no crossfade. */
  crossfade?: boolean;
  /** Extra vertical offset so a run of deletions sharing one anchor stacks
   *  instead of all pinning to the anchor's bottom (the parent sums the earlier
   *  deletes' heights). 0 for everything else. */
  offsetTop?: number;
  /** Report this overlay's live height up so the parent can stack the run (and
   *  let the column compact as each deletion finishes). Only wired for deletions. */
  onMeasure?: (key: string, height: number) => void;
}) {
  const revealAnimationEnabled = useSettingsStore((s) => s.agentEditRevealAnimation);
  const rect = useAnchorBox(scrollEl, host, change);
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
  const [mode] = useState<'overwrite' | 'typewriter'>(() =>
    (getPlatformRuntime().isMobileShell ? 'typewriter' : 'overwrite'));
  const steps = useMemo(() => agentRevealSteps(agentRevealPieces(segs)), [segs]);
  const total = mode === 'overwrite' ? steps : delChars + insChars;
  const [countAtStart] = useState(revealCount);
  const { durationMs, exitMs } = agentEditRevealTiming(total, countAtStart);

  const [progress, setProgress] = useState(0);
  const [fading, setFading] = useState(false);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });

  // Report the overlay's live height so the parent can stack a run of deletions
  // that share one anchor (and let the column compact as each finishes). Gated to
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
    if (!revealAnimationEnabled) {
      // Finish outside React's effect phase: the owner atomically clears its
      // presentation with flushSync. No frame, typewriter or fade is needed.
      let cancelled = false;
      queueMicrotask(() => { if (!cancelled) done.current(); });
      return () => { cancelled = true; };
    }
    let raf = 0;
    let exitTimer = 0;
    let start = 0;
    const tick = (ts: number) => {
      if (!start) start = ts;
      const t = total === 0 ? 1 : Math.min(1, (ts - start) / durationMs);
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
        exitTimer = window.setTimeout(() => done.current(), exitMs);
      }
    };
    raf = window.requestAnimationFrame(tick);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      if (exitTimer) window.clearTimeout(exitTimer);
    };
  }, [total, change.op, crossfade, revealAnimationEnabled, durationMs, exitMs]);

  if (!rect || !revealAnimationEnabled) return null;

  // A deletion hangs just BELOW its surviving predecessor (no-ghost fallback);
  // anchored to its in-place ghost or the first block, it sits at that top.
  const aEl = anchorEl(scrollEl, change);
  const onGhost = !!aEl && aEl.classList.contains('agent-diff-deleted-block');
  const top = aEl && deletionHangsBelow(aEl, change) ? rect.top + rect.height : rect.top;
  const pos: CSSProperties = {
    ...rect.prose,
    // The overlay host is an in-flow child of `.editor-scroll`, so these stable
    // content coordinates move in the same compositor transaction as the prose.
    position: 'absolute',
    // offsetTop stacks a run of deletions sharing this anchor (0 otherwise).
    top: top + offsetTop,
    left: rect.left,
    width: rect.width,
    transitionDuration: `${exitMs}ms`,
    // Keep occluding the anchor when the animation switches between the old and
    // new text layouts. A deletion over its struck ghost must cover that ghost
    // until the owner removes both together. Unanchored deletions use auto-height.
    minHeight: change.op === 'deleted' ? (onGhost ? rect.height : undefined) : rect.height,
  };
  return (
    <div
      ref={setNode}
      aria-hidden="true"
      className={`agent-reveal agent-reveal--${change.op}${fading ? ' agent-reveal--fade' : ''}`}
      style={pos}
    >
      <AgentRevealText segments={segs} progress={progress} showCaret={!fading} mode={mode} />
    </div>
  );
}

const EMPTY: AgentBlockChange[] = [];

export function AgentEditAnimator({ scrollEl, entityType, id }: AgentEditAnimatorProps) {
  const revealAnimationEnabled = useSettingsStore((s) => s.agentEditRevealAnimation);
  const pending = useAgentEditStore((s) => s.pending);
  const editKey = id ? entityKey(entityType, id) : null;
  const entry = editKey ? pending[editKey] : undefined;
  const allChanges = entry?.changes ?? EMPTY;
  // Old approval-mode receipts are presentation-only too; canonical recovery
  // settles their remaining decisions without asking the author.
  const changes = useMemo(() => allChanges.filter((c) => !c.field).map((c) =>
    c.mode === 'auto' ? c : { ...c, mode: 'auto' as const },
  ), [allChanges]);
  const changesKey = changes.map(keyOf).join('|');
  const autoChanges = changes;

  const [revealing, setRevealing] = useState<Map<string, AgentBlockChange>>(() => new Map());
  const revealCount = useMemo(
    () => agentEditRevealCount(changes, revealing.values()),
    [changes, revealing],
  );

  // Live heights (keyed) of the deletion overlays currently revealing, reported
  // by each RevealOverlay — used to STACK a run of deletions that share one
  // anchor. A run of consecutive deletes all hangs under the same surviving
  // predecessor (block-diff anchors every delete to its nearest survivor), so
  // without an offset they'd pin to the same spot and overlap. Each delete sits
  // below the summed heights of the earlier deletes in its run; the column
  // compacts as each deletion resolves out of the run.
  const [heights, setHeights] = useState<Map<string, number>>(() => new Map());
  useLayoutEffect(() => useSettingsStore.subscribe((state, previous) => {
    if (previous.agentEditRevealAnimation && !state.agentEditRevealAnimation) {
      setRevealing(new Map());
      setHeights(new Map());
    }
  }), []);
  useLayoutEffect(() => useAgentEditStore.subscribe((state, previous) => {
    if (editKey && previous.pending[editKey] && !state.pending[editKey]) {
      setRevealing(new Map());
      setHeights(new Map());
    }
  }), [editKey]);
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
      const store = useAgentEditStore.getState();
      store.resolveBlocks(entityType, id, [c.blockId]);
      // The desktop keeps what the Agent wrote coloured until the author's
      // pointer rests on it (AgentRecentChangeHighlights).
      if (!getPlatformRuntime().isMobileShell) recordAgentRecentChange(entityType, id, c);
      if (c.reviewId) {
        const current = useAgentEditStore.getState();
        const key = entityKey(entityType, id);
        const hasAutoVisualChanges = Boolean(
          current.pending[key]?.changes.some(
            (change) =>
              change.reviewId,
          ),
        );
        if (!hasAutoVisualChanges) {
          current.resolveReviews(
            current.reviewOrder.filter((reviewId) => {
              const batch = current.reviewBatches[reviewId];
              return Boolean(
                batch &&
                  batch.entityType === entityType &&
                  batch.id === id,
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
    const seenTracker = createAgentEditSeenTracker(resolve);

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
          if (revealAnimationEnabled) fired.add(k);
          toFire.push(c);
        }
      }
      if (!revealAnimationEnabled) {
        seenTracker.update(toFire);
        return;
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
      seenTracker.dispose();
      scrollEl.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      mo.disconnect();
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [scrollEl, id, changesKey, revealAnimationEnabled, resolve]); // eslint-disable-line react-hooks/exhaustive-deps

  // Portal into the positioned in-flow spread. The ancestor `.editor-scroll`
  // clips it naturally, and WebKit scrolls the overlay in the same compositor
  // transaction as the manuscript instead of waiting on main-thread rect state.
  const layerHost = scrollEl ? editOverlayHost(scrollEl) : null;
  const hasLayer =
    !!scrollEl &&
    !!layerHost &&
    !!id &&
    (changes.length > 0 || revealing.size > 0);

  // Safety net (per-change, AUTO changes only) so a tick / "M" can't get wedged
  // when a reveal never plays. After a grace period an auto change clears if
  // EITHER (a) it has no anchor (the block never rendered), or (b) it's anchored
  // and resting within the editor viewport yet still pending — i.e. its reveal
  // never fired (the block came only partly into view, under the reveal ratio). A
  // block fully OFF the viewport is left alone: its reveal — and its marker clear
  // — happen when the user scrolls it in (the tick is the "find me" handle for it).
  useEffect(() => {
    if (!scrollEl || !id || autoChanges.length === 0) return;
    const t = window.setTimeout(() => {
      for (const c of autoChanges) {
        const el = anchorEl(scrollEl, c);
        if (!el || (revealAnimationEnabled && intersectsViewport(el, scrollEl))) resolve(c);
      }
    }, ANCHOR_GRACE_MS);
    return () => window.clearTimeout(t);
  }, [scrollEl, id, changesKey, resolve, revealAnimationEnabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the layer mounted while unread changes or active reveals remain.
  if (!scrollEl || !layerHost || !id || !hasLayer) return null;

  return (
    <>
      {createPortal(
        <div className="agent-edit-layer">
          {/* Auto changes: each plays its reveal concurrently as it enters the
              viewport. Rendered off `revealing` alone — that map is only ever
              populated by the auto effect, so a reveal still finishes if its change
              resolves out from under it. */}
          {revealAnimationEnabled && [...revealing.values()].filter((change) =>
            autoChanges.some((current) => keyOf(current) === keyOf(change)),
          ).map((c) => {
            const maskedAutoReveal = agentChangeUsesAutoRevealMask(c);
            return (
              <RevealOverlay
                key={keyOf(c)}
                scrollEl={scrollEl}
                host={layerHost}
                change={c}
                revealCount={revealCount}
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
        </div>,
        layerHost,
      )}
    </>
  );
}
