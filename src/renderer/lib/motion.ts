/**
 * The motion vocabulary (docs/design-system/motion.md). Each kind of movement
 * has one duration and one curve, defined here once; components reference
 * these names instead of copying the numbers. CSS reads the same values from
 * the `--motion-*` custom properties in materials.css (motion.test.ts keeps
 * the two in step). Under `prefers-reduced-motion: reduce` every one of these
 * movements skips straight to where it ends.
 */

// Structural open and close: the workspace's structure changed (a sidebar
// opens or closes, a pane splits or merges, the place under the paper opens).
export const STRUCTURAL_MS = 420;
export const STRUCTURAL_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)';

// Heavy-ice push: a whole block of content is pushed away for another, slow
// to start, then fast. The arriving panel's outline fades after it lands.
export const PUSH_MS = 265;
export const PUSH_EASING = 'cubic-bezier(0.8, 0, 0.66, 1)';
export const PUSH_OUTLINE_FADE_MS = 340;

// Weighted spring: something with weight in the hand. Critically damped, a
// little behind the hand and never springing back; where a fixed length is
// needed it is normalised to land on SPRING_MS.
export const SPRING_K = 150;
export const SPRING_W = Math.sqrt(SPRING_K);
export const SPRING_MS = 520;

/** Progress of the spring at `t` seconds, normalised to land exactly on 1. */
function springProgress(t: number) {
  const settle = 1 - (1 + SPRING_W * SPRING_MS / 1000) * Math.exp(-SPRING_W * SPRING_MS / 1000);
  return (1 - (1 + SPRING_W * t) * Math.exp(-SPRING_W * t)) / settle;
}

/** The spring as a CSS `linear()` easing over SPRING_MS. */
export function springEasing() {
  const points = Array.from({ length: 25 }, (_, index) =>
    Number(springProgress((index / 24) * SPRING_MS / 1000).toFixed(4)));
  return `linear(${points.join(', ')})`;
}

let weighted: string | null = null;
/** The spring's easing where `linear()` is supported, else the closest cubic. */
export function weightedEasing() {
  if (weighted === null) {
    const linear = springEasing();
    weighted = typeof CSS !== 'undefined' && CSS.supports?.('animation-timing-function', linear)
      ? linear
      : 'cubic-bezier(0.25, 1, 0.5, 1)';
  }
  return weighted;
}

// Dock pill: a dock mark grows into its pill, and a closed pill folds back
// to a mark's width and fades where it stood, over DOCK_PILL_MS; the
// neighbours that make room or close the gap move on the same curve and land
// with it.
export const DOCK_PILL_MS = 340;
export const DOCK_PILL_EASING = 'cubic-bezier(0.3, 0.7, 0.2, 1)';

// Water wave: a selection flows from the old item to the new one, taking a
// little longer for each item it crosses (up to WAVE_MAX_ITEMS), then fades.
export const WAVE_BASE_MS = 230;
export const WAVE_PER_ITEM_MS = 70;
export const WAVE_MAX_ITEMS = 4;
export const WAVE_SETTLE_MS = 300;

// Sand drawn: a trace the author's own action leaves is drawn along its path,
// SAND_DRAW_MS for its first line of prose and SAND_DRAW_PER_LINE_MS more for
// each further one, easing out. Sand that comes or goes for any other reason
// fades as a whole over SAND_FADE_MS; a change of strength (pointing at its
// card) takes SAND_SHIFT_MS.
export const SAND_DRAW_MS = 380;
export const SAND_DRAW_PER_LINE_MS = 120;
export const SAND_FADE_MS = 300;
export const SAND_SHIFT_MS = 240;

/** When, as a fraction of the whole draw, the stroke has reached `drawn` (0–1) of its length. */
export function sandDrawTimeAt(drawn: number) {
  return 1 - Math.pow(1 - Math.min(1, Math.max(0, drawn)), 1 / 2.2);
}

// Page turn: the paper changes to another page (a tab, an entity opened from
// a list). The next page dissolves in, in place, over the one in front, which
// stays whole underneath until it is covered: the ink on the paper never thins.
export const PAGE_BLEND_MS = 180;
export const PAGE_BLEND_EASING = 'cubic-bezier(0.4, 0, 0.2, 1)';
// (CSS: --motion-page-blend, --motion-page-blend-ease; the first-run card's steps cross the same way.)

// First run (PreAlphaFirstRunGate): the app's name stands on the sea this long
// before it lets go and its ring leaves the first-run card behind.
export const FIRST_RUN_TITLE_MS = 1300;
// The sample book a first launch wrote lands on the shelf this long after its
// card comes up, on a ring of its own.
export const SAMPLE_LANDING_DELAY_MS = 240;
// The first-run card fades as the shelf comes up under it (CSS: --motion-glass-bleed).
export const FIRST_RUN_LEAVE_MS = 240;

// Waiting: a wait shorter than this shows nothing, so a quick read never
// flashes a loading mark (CSS: --motion-loading-delay).
export const LOADING_DELAY_MS = 240;
// Past it, glass that asked for what is still being prepared drifts on its
// own, one lap of the texture in this long, until it arrives
// (CSS: --motion-glass-loading).
export const GLASS_LOADING_DRIFT_MS = 2400;

// Sync on the paper (features/sync-status): a long transfer's cloud breathes
// once in this long and a retrying one blinks once in this long
// (CSS: --motion-sync-breathe, --motion-sync-blink). A cloud that stepped
// aside for typing comes back this long after the last keystroke.
export const SYNC_MARK_BREATHE_MS = 1800;
export const SYNC_MARK_BLINK_MS = 2400;
export const SYNC_MARK_TYPING_SETTLE_MS = 2000;

// Dwell and grace.
/** How long the pointer rests on a thing before its hover card shows. */
export const HOVER_PREVIEW_DELAY_MS = 220;
/** How long leaving a thing gives the pointer to reach its card. */
export const HOVER_CARD_GRACE_MS = 220;
/** How long a list must have stopped scrolling before rows under a resting pointer count as pointed at. */
export const SCROLL_REST_MS = 180;
/** How long a text selection must settle before the selection bar floats in. */
export const SELECTION_BAR_SETTLE_MS = 180;
/** How long leaving Format and its formats pill waits before folding it (enough to cross the gap). */
export const FORMATS_CLOSE_MS = 140;
/** How long leaving the dock waits before its pills fold back to dots. */
export const DOCK_COLLAPSE_DELAY_MS = 260;
/** How long leaving a collapsed choice and its options waits before folding them (enough to cross the gap). */
export const OPTIONS_CLOSE_MS = 160;
/** How long the colour of words the Agent just wrote takes to ease back to ink once the pointer touches them. */
export const RECENT_CHANGE_FADE_MS = 300;
/** How long a drag's reported leave of the window waits for proof it is still here (WebKit reports one before a drop). */
export const DRAG_LEAVE_GRACE_MS = 150;
/** How long after a press a selection still counts as made by that press. */
export const PRESS_WINDOW_MS = 1500;
