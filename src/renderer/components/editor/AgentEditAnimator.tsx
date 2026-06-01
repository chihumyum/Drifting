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
 *                  No scrollbar ticks in this mode.
 *
 * Pure UI: the entity content already holds the agent's edit. Nothing here writes
 * the doc except an explicit ✗ (reject), which calls revertNodeBlock.
 */
interface AgentEditAnimatorProps {
  scrollEl: HTMLElement | null;
  entityType: ActivityEntityType;
  id: string | null | undefined;
}

// Reveal timing: erase the deleted chars then type the inserted chars, one at a
// time (typewriter), then fade out onto the real block. Pace is per-character,
// clamped so tiny edits still register and big rewrites don't drag.
const CHAR_MS = 25;
const MIN_REVEAL_MS = 500;
const MAX_REVEAL_MS = 3000;
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
    position: 'fixed',
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
    scrollEl.addEventListener('scroll', place, { passive: true });
    window.addEventListener('resize', place);
    // Observe the scroll container AND its content (.page) so the control also
    // re-glues when blocks above it grow/shrink, not only on scroll.
    const ro = new ResizeObserver(place);
    ro.observe(scrollEl);
    const page = scrollEl.querySelector('.page');
    if (page) ro.observe(page);
    return () => {
      scrollEl.removeEventListener('scroll', place);
      window.removeEventListener('resize', place);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollEl, change.blockId, change.op, change.afterPrevId]);

  const label = change.op === 'new' ? '新增' : change.op === 'deleted' ? '删除' : '改写';
  return (
    <div
      ref={ref}
      className={`agent-approve agent-approve--${change.op}`}
      style={{ position: 'fixed', top: 0, left: 0, visibility: 'hidden' }}
    >
      <span className="agent-approve__tag">{label}</span>
      <button type="button" className="agent-approve__btn agent-approve__btn--ok" title="批准这处改动" onClick={onApprove}>
        <Check size={13} />
      </button>
      <button type="button" className="agent-approve__btn agent-approve__btn--no" title="拒绝并还原" onClick={onReject}>
        <X size={13} />
      </button>
    </div>
  );
}

const EMPTY: AgentBlockChange[] = [];

export function AgentEditAnimator({ scrollEl, entityType, id }: AgentEditAnimatorProps) {
  const editMode = useSettingsStore((s) => s.agentEditMode);
  const pending = useAgentEditStore((s) => s.pending);
  const entry = id ? pending[entityKey(entityType, id)] : undefined;
  const changes = entry?.changes ?? EMPTY;
  const changesKey = changes.map(keyOf).join('|');

  // Auto mode: the block whose scheduled reveal is playing right now (serial).
  const [activeKey, setActiveKey] = useState<string | null>(null);
  // Approve mode: the just-approved block, played as a one-off commit reveal
  // (held in local state because it's already resolved out of the store).
  const [committing, setCommitting] = useState<AgentBlockChange | null>(null);

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

  // Auto mode: observe each pending block; once visible, schedule its reveal in
  // document (top-to-bottom) order, one at a time.
  useEffect(() => {
    if (editMode !== 'auto' || !scrollEl || !id || changes.length === 0) return;
    if (activeKey) return; // a reveal is in flight — let it finish first

    const seen = new Set<string>();
    const byEl = new Map<Element, AgentBlockChange>();

    const schedule = () => {
      const ready = changes.filter((c) => seen.has(keyOf(c)));
      if (ready.length === 0) return;
      ready.sort((a, b) => {
        const ea = anchorEl(scrollEl, a);
        const eb = anchorEl(scrollEl, b);
        return (ea?.getBoundingClientRect().top ?? Infinity) - (eb?.getBoundingClientRect().top ?? Infinity);
      });
      setActiveKey(keyOf(ready[0]));
    };

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const c = byEl.get(e.target);
          if (!c) continue;
          if (e.isIntersecting && e.intersectionRatio >= 0.35) seen.add(keyOf(c));
        }
        schedule();
      },
      { root: scrollEl, threshold: [0, 0.35, 1] },
    );

    for (const c of changes) {
      const el = anchorEl(scrollEl, c);
      if (el) {
        byEl.set(el, c);
        io.observe(el);
      }
    }
    return () => io.disconnect();
  }, [editMode, scrollEl, id, changesKey, activeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Safety net: a change we can never anchor (block didn't render) clears after a
  // grace period so its tick / "M" can't get stuck.
  useEffect(() => {
    if (!scrollEl || !id || changes.length === 0) return;
    const t = window.setTimeout(() => {
      for (const c of changes) if (!anchorEl(scrollEl, c)) resolve(c);
    }, ANCHOR_GRACE_MS);
    return () => window.clearTimeout(t);
  }, [scrollEl, id, changesKey, resolve]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!scrollEl || !id || changes.length === 0) return null;

  const active = changes.find((c) => keyOf(c) === activeKey) ?? null;

  return createPortal(
    <div className="agent-edit-layer">
      {/* Auto: one scheduled typewriter reveal at a time, as blocks scroll in. */}
      {editMode === 'auto' && active && (
        <RevealOverlay
          key={keyOf(active)}
          scrollEl={scrollEl}
          change={active}
          onDone={() => {
            resolve(active);
            setActiveKey(null);
          }}
        />
      )}
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
              // Best-effort undo; clear the pending block either way so the review
              // can't get stuck if the revert can't apply.
              void revertNodeBlock(id, c)
                .catch(() => {})
                .finally(() => resolve(c));
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
