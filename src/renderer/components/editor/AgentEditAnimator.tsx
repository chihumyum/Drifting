import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, X } from 'lucide-react';
import { useAgentEditStore } from '../../store/agent-edit-store';
import { useAgentActivityStore } from '../../store/agent-activity-store';
import { useSettingsStore } from '../../store/settings-store';
import { entityKey, type ActivityEntityType } from '../../lib/agent/tool-entity-ref';
import { diffTokens, type AgentBlockChange } from '../../lib/agent/block-diff';
import { revertNodeBlock } from '../../lib/agent/chapter-prose';

/**
 * Agent prose-edit reveal layer (#3 / #4). Renders OVER the manuscript (a fixed
 * portal that tracks each block's live rect) and:
 *
 *  - auto mode:    as each agent-changed block scrolls into view, plays a
 *                  text-level reveal — the old text shows, deletions erase and
 *                  insertions type in (typewriter), then it settles onto the real
 *                  block. Plays serially in document order. Only AFTER a block's
 *                  reveal runs do its scrollbar tick + the panel "M" clear (the
 *                  edit-store entry and the activity spot drop in lockstep).
 *  - approve mode: the diff renders IN PLACE as editor decorations (see
 *                  useEntityEditor + agent-diff-decoration) — insertions inline
 *                  green, deletions as red struck widgets — so it reflows + scrolls
 *                  with the prose. This component only floats a ✓ / ✗ just outside
 *                  the column: ✓ accepts (text already applied), ✗ reverts via Yjs.
 *                  Scrollbar ticks still show (BOTH modes) so pending edits stay
 *                  findable in a long chapter — see EditorScrollMarkers.
 *
 * The mode that governs a given entity's review is the one FROZEN when its edits
 * were recorded (PendingEntityEdits.mode), not the live global setting — flipping
 * the toggle mid-review must not retro-reclassify edits already on screen.
 *
 * Pure UI: the entity content already holds the agent's edit. Nothing here writes
 * the doc except an explicit ✗ (reject), which calls revertNodeBlock.
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

const keyOf = (c: AgentBlockChange): string => `${c.op}:${c.blockId}`;
const sel = (blockId: string): string => `[data-block-id="${CSS.escape(blockId)}"]`;

/** The DOM element a change hangs on: the block itself, or — for a deletion —
 *  its surviving predecessor (or the first block when it led the chapter). */
function anchorEl(scrollEl: HTMLElement, c: AgentBlockChange): HTMLElement | null {
  if (c.op === 'deleted') {
    if (c.afterPrevId) return scrollEl.querySelector(sel(c.afterPrevId));
    const page = scrollEl.querySelector('.page');
    return (page?.firstElementChild as HTMLElement | null) ?? null;
  }
  return scrollEl.querySelector(sel(c.blockId));
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
}: {
  scrollEl: HTMLElement;
  change: AgentBlockChange;
  onDone: () => void;
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
      } else {
        setFading(true);
        window.setTimeout(() => done.current(), EXIT_MS);
      }
    };
    raf = window.requestAnimationFrame(tick);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [total]);

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

  // Deletions show their old text BELOW the surviving predecessor; everything
  // else sits on top of its own (post-edit) block.
  const top = change.op === 'deleted' && change.afterPrevId ? rect.bottom : rect.top;
  const pos: CSSProperties = {
    ...prose,
    // absolute (not fixed) so the layer's clip-path crops it to the editor
    // viewport; the layer is inset:0 fixed, so these viewport coords still apply.
    position: 'absolute',
    top,
    left: rect.left,
    width: rect.width,
    minHeight: change.op === 'deleted' ? undefined : rect.height,
  };
  return (
    <div
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
      const top = change.op === 'deleted' && change.afterPrevId ? r.bottom : r.top;
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
  const globalEditMode = useSettingsStore((s) => s.agentEditMode);
  const pending = useAgentEditStore((s) => s.pending);
  const entry = id ? pending[entityKey(entityType, id)] : undefined;
  const changes = entry?.changes ?? EMPTY;
  // Use the mode FROZEN on this entry, not the live global setting, so flipping
  // the toggle mid-review doesn't reclassify edits already on screen. Falls back
  // to the global only when there's no entry (nothing to render anyway).
  const editMode = entry?.mode ?? globalEditMode;
  const changesKey = changes.map(keyOf).join('|');

  // Auto mode: every change currently playing its reveal, keyed. CONCURRENT —
  // each fires the moment it enters the viewport, not serially. Held as captured
  // change data so an overlay still finishes after its change resolves out of the
  // store. Approve commit (one-off) lives in `committing`.
  const [revealing, setRevealing] = useState<Map<string, AgentBlockChange>>(() => new Map());
  const [committing, setCommitting] = useState<AgentBlockChange | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);

  const stopRevealing = useCallback((c: AgentBlockChange) => {
    setRevealing((prev) => {
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

  // Auto mode: observe each pending block; the MOMENT it enters the viewport,
  // fire its reveal — concurrently, so every change in view animates at once
  // (not one-at-a-time). A MutationObserver re-wires blocks as their DOM appears:
  // when the agent edits the OPEN chapter, the edit lands in Yjs + the store
  // synchronously (re-running this effect) but the ProseMirror DOM syncs a tick
  // LATER — so the anchor isn't there on the first pass, and without this the
  // reveal would never fire (tick stuck).
  useEffect(() => {
    if (editMode !== 'auto' || !scrollEl || !id || changes.length === 0) return undefined;

    const byEl = new Map<Element, AgentBlockChange>();
    const wired = new Set<string>(); // change keys already attached to the IO

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const c = byEl.get(e.target);
          if (!c) continue;
          if (e.isIntersecting && e.intersectionRatio >= 0.35) {
            io.unobserve(e.target); // started — don't re-fire it
            setRevealing((prev) => (prev.has(keyOf(c)) ? prev : new Map(prev).set(keyOf(c), c)));
          }
        }
      },
      { root: scrollEl, threshold: [0, 0.35, 1] },
    );

    // Attach any pending block whose anchor is now in the DOM but not yet observed.
    const wire = () => {
      for (const c of changes) {
        const k = keyOf(c);
        if (wired.has(k)) continue;
        const el = anchorEl(scrollEl, c);
        if (el) {
          wired.add(k);
          byEl.set(el, c);
          io.observe(el);
        }
      }
    };

    let raf = 0;
    const mo = new MutationObserver(() => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        wire();
      });
    });
    mo.observe(scrollEl, { childList: true, subtree: true });
    wire();

    return () => {
      io.disconnect();
      mo.disconnect();
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [editMode, scrollEl, id, changesKey]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Safety net (AUTO mode only): a change we can never anchor (block didn't
  // render) clears after a grace period so its tick / "M" can't get stuck. In
  // APPROVE mode this must NOT run — resolving an un-anchored block would silently
  // ACCEPT an edit the user never approved; instead it stays pending until the
  // user scrolls it into view and clicks ✓/✗.
  useEffect(() => {
    if (editMode !== 'auto' || !scrollEl || !id || changes.length === 0) return;
    const t = window.setTimeout(() => {
      for (const c of changes) if (!anchorEl(scrollEl, c)) resolve(c);
    }, ANCHOR_GRACE_MS);
    return () => window.clearTimeout(t);
  }, [editMode, scrollEl, id, changesKey, resolve]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep rendering while a reveal (auto) or commit (approve) is in flight even
  // after its change resolves out of the store — otherwise the overlay would
  // unmount mid-animation the instant `changes` empties.
  if (!scrollEl || !id || !hasLayer) return null;

  return createPortal(
    <div ref={layerRef} className="agent-edit-layer">
      {/* Auto: every change in the viewport plays its reveal concurrently.
          Rendered off `revealing` alone (no editMode gate) — that map is only
          ever populated by the auto-mode effect, so a reveal still finishes if
          its entry resolves out from under it and editMode falls back to global. */}
      {[...revealing.values()].map((c) => (
        <RevealOverlay
          key={keyOf(c)}
          scrollEl={scrollEl}
          change={c}
          onDone={() => {
            resolve(c);
            stopRevealing(c);
          }}
        />
      ))}
      {/* Approve: the diff itself renders IN PLACE via editor decorations (see
          useEntityEditor); here we float the ✓ / ✗ just outside the column. ✓
          clears the pending block (text already applied) AND plays a one-off
          typewriter commit over it; ✗ reverts via Yjs. */}
      {editMode === 'approve' &&
        changes.map((c) => (
          <ApproveControl
            key={keyOf(c)}
            scrollEl={scrollEl}
            change={c}
            onApprove={() => {
              resolve(c); // clears the in-place decoration (text already applied)
              setCommitting(c); // …then play the commit reveal over the real block
            }}
            onReject={() => {
              // Only clear the review marker once the undo ACTUALLY applies. If
              // the revert throws (block id moved, doc unregistered), the agent's
              // text is still in the doc — so keep the block flagged (the ✓/✗
              // control stays, the user can retry) instead of silently looking
              // reverted while the edit secretly remains.
              void revertNodeBlock(id, c)
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
      {/* The approved block's one-off commit reveal (occludes it, plays, fades). */}
      {committing && (
        <RevealOverlay
          key={`commit:${keyOf(committing)}`}
          scrollEl={scrollEl}
          change={committing}
          onDone={() => setCommitting(null)}
        />
      )}
    </div>,
    document.body,
  );
}
