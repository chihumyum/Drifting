// Wait for an editor to mount the requested BlockId-tagged DOM node, then
// scroll it into view and briefly flash it. Used after a tab switch where the
// editor hydrates asynchronously (patch card, block-anchored TODO) — a direct
// querySelector at the call site would race against the editor mount and
// silently miss.
//
// Why rAF-poll-and-resettle instead of a one-shot observer: opening a chapter
// is a multi-stage settle. The node's content loads async, the block-id plugin
// re-renders every block to stamp `data-block-id`, and the editor surface can
// remount once before it's stable. A single scroll fired the instant the block
// first appears lands on a transient layout — the editor then settles and the
// scroll snaps back to the top. So we keep re-centering for a short window after
// first contact, which absorbs late content, the id re-render, and a remount,
// THEN flash on the final, settled element so the highlight actually sticks.
//
// Scoping: if a wrapper with `data-chapter-id` exists (all-chapters / split-pane
// layouts), prefer the block inside that scope. Falls back to a document-wide
// search for the single-chapter view, where the editor isn't wrapped — block
// ids are uuids so the unscoped match is unambiguous.

export interface ScrollToBlockOptions {
  /** How long to keep waiting for the block to appear before giving up. */
  timeoutMs?: number;
  /** After first contact, how long to keep re-centering as the editor settles
   *  (absorbs async content load, the block-id re-render, and a remount). */
  settleMs?: number;
  /** Briefly flash the block on arrival so the eye lands on it. Default true. */
  flash?: boolean;
}

/**
 * Briefly highlight a block element — a fading accent background wash — so the
 * eye lands on it after a jump. Shared by every jump-to-block affordance (patch
 * card, block-anchored TODO, scrollbar tick) for a consistent landing cue.
 * Background only, no left bar (per user preference: no vertical accent bars).
 *
 * Uses the Web Animations API rather than a CSS class on purpose: the blocks
 * live inside ProseMirror, whose attribute reconciliation strips any externally
 * added `class` from the nodes it manages (which is exactly why the persistent
 * agent-change marks have to re-apply themselves on every DOM mutation). A WAAPI
 * animation is attached to the element object, not its `class`, so it survives
 * PM reusing the node — a one-shot class add would be wiped before it's seen.
 */
export function flashBlock(el: HTMLElement): void {
  // var() inside WAAPI keyframes doesn't resolve reliably, so read the computed
  // --accent triplet (e.g. "8 55% 33%") and build concrete hsl() colors.
  const accent = getComputedStyle(el).getPropertyValue('--accent').trim() || '8 55% 33%';
  el.animate(
    [
      { backgroundColor: `hsl(${accent} / 0.34)` },
      { backgroundColor: `hsl(${accent} / 0.26)`, offset: 0.5 },
      { backgroundColor: `hsl(${accent} / 0)` },
    ],
    { duration: 1400, easing: 'ease' },
  );
}

// (A sustained hover-highlight once lived here as a WAAPI hold; comment hover is
// now painted via the CSS Custom Highlight API — see lib/comment-highlight.ts —
// which also supports sub-text ranges. flashBlock stays WAAPI for the transient
// jump flash.)

// Bumped on every call so a newer jump supersedes any in-flight settle loop —
// two quick clicks won't have their rAF loops fight over the scroll position.
let jumpGeneration = 0;

export function scrollToBlockWhenReady(
  nodeId: string,
  blockId: string,
  opts: ScrollToBlockOptions = {},
): void {
  if (!blockId) return;
  const myGeneration = ++jumpGeneration;
  const doFlash = opts.flash !== false;
  const giveUpAt = Date.now() + (opts.timeoutMs ?? 3000);
  const settleMs = opts.settleMs ?? 280;
  const escapedBlock = cssEscape(blockId);
  const escapedNode = cssEscape(nodeId);
  const scopedSelector = `[data-chapter-id="${escapedNode}"] [data-block-id="${escapedBlock}"]`;
  const unscopedSelector = `[data-block-id="${escapedBlock}"]`;

  const find = (): HTMLElement | null =>
    document.querySelector<HTMLElement>(scopedSelector) ??
    document.querySelector<HTMLElement>(unscopedSelector);

  // 0 until the block is first seen; afterwards the timestamp to flash + stop at.
  let settleUntil = 0;

  const step = () => {
    if (myGeneration !== jumpGeneration) return; // a newer jump took over
    const el = find();
    const now = Date.now();
    if (el) {
      // Instant (not smooth) so the per-frame re-centering during the settle
      // window doesn't fight a running smooth animation; the net effect is a
      // single clean jump that tracks the block through layout shifts.
      el.scrollIntoView({ block: 'center' });
      if (settleUntil === 0) settleUntil = now + settleMs;
      if (now >= settleUntil) {
        if (doFlash) flashBlock(el);
        return;
      }
    } else if (now >= giveUpAt) {
      return; // block never mounted (deleted / stale id) — leave scroll as-is
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && 'escape' in CSS ? CSS.escape(value) : value;
}
