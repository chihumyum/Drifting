import { useEffect } from 'react';
import { useAgentActivityStore, type SeenSpot } from '../store/agent-activity-store';
import { entityKey, type ActivityEntityType } from '../lib/agent/tool-entity-ref';

/**
 * Agent-change perception in the editor (#17, part 2). When the agent has
 * touched the open entity, its changed spots — prose blocks (by uuid) and the
 * summary — get a git-gutter highlight, and the breathing "M" on the left-panel
 * cell auto-clears as the user actually scrolls each spot into view (not merely
 * on click). Structural changes (block removals, whole-body rewrites, renames,
 * fresh creates) have no single anchor, so they clear the moment the entity is
 * opened. Spots we can't anchor in the DOM after a grace period also clear on
 * open, so the dot can never get stuck.
 *
 * Nodes are tracked precisely (blocks + summary). Elements are coarse — their
 * writes arrive as `structural`, cleared on open.
 */
const VISIBLE_MS = 500; // dwell before a visible spot counts as "read"
const FALLBACK_MS = 2500; // grace before unanchorable spots clear on open
const SUMMARY_SEL = '[data-agent-summary]';
const blockSel = (id: string) => `[data-block-id="${CSS.escape(id)}"]`;

export function useAgentChangeMarks(
  scrollEl: HTMLElement | null,
  entityType: ActivityEntityType,
  id: string | null | undefined,
) {
  const markSpotSeen = useAgentActivityStore((s) => s.markSpotSeen);

  useEffect(() => {
    if (!scrollEl || !id) return undefined;
    const key = entityKey(entityType, id);
    const getEntry = () => useAgentActivityStore.getState().touched[key];

    let io: IntersectionObserver | null = null;
    const dwell = new Map<Element, number>();
    const tracked = new Map<Element, SeenSpot>();
    let appliedEls: Element[] = [];

    const clearClasses = () => {
      for (const el of appliedEls) {
        el.classList.remove(
          'agent-change-block',
          'agent-change-block--seen',
          'agent-change-summary',
          'agent-change-summary--seen',
        );
      }
      appliedEls = [];
    };

    const onIntersect: IntersectionObserverCallback = (entries) => {
      for (const e of entries) {
        const spot = tracked.get(e.target);
        if (!spot) continue;
        // "Enough visible" = ≥60% of the block, or — for blocks taller than the
        // viewport — at least half the viewport filled by it.
        const enough =
          e.isIntersecting &&
          (e.intersectionRatio >= 0.6 ||
            (!!e.rootBounds && e.intersectionRect.height >= e.rootBounds.height * 0.5));
        if (enough) {
          if (!dwell.has(e.target)) {
            const t = window.setTimeout(() => {
              dwell.delete(e.target);
              markSpotSeen(entityType, id, spot);
            }, VISIBLE_MS);
            dwell.set(e.target, t);
          }
        } else {
          const t = dwell.get(e.target);
          if (t !== undefined) {
            window.clearTimeout(t);
            dwell.delete(e.target);
          }
        }
      }
    };

    // (Re)highlight changed spots and (re)observe the unseen, located ones.
    // Cheap to rebuild from scratch — a run touches only a handful of spots.
    const apply = () => {
      io?.disconnect();
      dwell.forEach((t) => window.clearTimeout(t));
      dwell.clear();
      tracked.clear();
      clearClasses();

      const entry = getEntry();
      if (!entry) return; // all spots seen → entry gone, classes already cleared

      // Opening the entity is "reading" a structural change — nothing to scroll
      // to. (Re-runs apply via the store subscription once seen.)
      if (entry.spots.structural && !entry.seen.structural) {
        markSpotSeen(entityType, id, { structural: true });
        return;
      }

      const observer = new IntersectionObserver(onIntersect, {
        root: scrollEl,
        threshold: [0, 0.6, 1],
      });
      io = observer;

      // Prose-block reveals + their seen-tracking are owned by AgentEditAnimator
      // now (it plays the diff animation, then clears the spot — so the tick /
      // "M" drop only AFTER the reveal). Here we just paint the static gutter
      // highlight, with NO IntersectionObserver, so a mere glance won't clear it.
      entry.spots.blocks.forEach((blockId) => {
        const el = scrollEl.querySelector(blockSel(blockId));
        if (!el) return;
        const seen = entry.seen.blocks.has(blockId);
        el.classList.add('agent-change-block');
        if (seen) el.classList.add('agent-change-block--seen');
        appliedEls.push(el);
      });

      if (entry.spots.summary) {
        const el = scrollEl.querySelector(SUMMARY_SEL);
        if (el) {
          const seen = entry.seen.summary;
          el.classList.add('agent-change-summary');
          if (seen) el.classList.add('agent-change-summary--seen');
          appliedEls.push(el);
          if (!seen) {
            tracked.set(el, { summary: true });
            observer.observe(el);
          }
        }
      }
    };

    // The observers below only run while a touched entry exists for this entity,
    // so an editor with no pending agent changes carries no overhead.
    let mo: MutationObserver | null = null;
    let fallback = 0;
    let raf = 0;
    let started = false;

    const start = () => {
      if (started) return;
      started = true;
      // Re-apply on editor hydration / prose edits (blocks may mount after us).
      mo = new MutationObserver(() => {
        if (raf) return;
        raf = window.requestAnimationFrame(() => {
          raf = 0;
          apply();
        });
      });
      mo.observe(scrollEl, { childList: true, subtree: true });
      // Spots still unanchorable after the grace period (e.g. an element summary
      // with no [data-agent-summary]) clear on open — located spots stay for the
      // observer to confirm.
      fallback = window.setTimeout(() => {
        const entry = getEntry();
        if (!entry) return;
        if (entry.spots.summary && !entry.seen.summary && !scrollEl.querySelector(SUMMARY_SEL)) {
          markSpotSeen(entityType, id, { summary: true });
        }
        // Prose blocks are cleared by AgentEditAnimator (which has its own
        // unanchorable grace), so they're intentionally not fallen back here.
      }, FALLBACK_MS);
      apply();
    };

    const stop = () => {
      if (!started) return;
      started = false;
      mo?.disconnect();
      mo = null;
      if (fallback) window.clearTimeout(fallback);
      if (raf) window.cancelAnimationFrame(raf);
      raf = 0;
      io?.disconnect();
      io = null;
      dwell.forEach((t) => window.clearTimeout(t));
      dwell.clear();
      tracked.clear();
      clearClasses();
    };

    // React to the entity gaining / losing / changing its touched entry — covers
    // both "open an already-changed entity" and "watch it change live".
    const unsub = useAgentActivityStore.subscribe((s, prev) => {
      if (s.touched[key] === prev.touched[key]) return;
      if (getEntry()) {
        if (started) apply();
        else start();
      } else {
        stop();
      }
    });

    if (getEntry()) start();

    return () => {
      unsub();
      stop();
    };
  }, [scrollEl, entityType, id, markSpotSeen]);
}
