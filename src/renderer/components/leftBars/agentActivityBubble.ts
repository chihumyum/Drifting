/**
 * Agent-activity bubbling (#17). The per-cell glyph effect rolls UP two layers:
 *   cell (chapter/element/drift)  →  group (storyline/category)  →  tab switcher
 *
 * Every layer above a cell renders the same little state machine over the cells
 * beneath it:
 *   - busy (a child cell is being touched right now) → blink/glow in accent.
 *   - doneCount > 0 (children with unviewed changes)  → the leading glyph is
 *     REPLACED by that count (how many changed cells the user hasn't opened).
 *   - both → the count shows, but blinks (a new run is working while changes
 *     from the last one are still unviewed). We never fall back to the glyph
 *     while doneCount > 0 — only once the user has reviewed everything (count
 *     hits 0) does the glyph return.
 *
 * `aggregateActivity` does the roll-up; <AgentCountBadge> (its own file, so this
 * stays a logic-only module) paints the count.
 */
import type { ActivityMark } from '../../store/agent-activity-store';

export interface GroupActivity {
  /** A child cell is being touched right now → blink. */
  busy: boolean;
  /** Child cells with unviewed changes → shown in place of the layer's glyph. */
  doneCount: number;
}

/**
 * Roll per-cell activity up to a parent layer. `keys` are the `entityKey`s of
 * the cells beneath this layer (a storyline's chapters, a category's elements,
 * or every cell in a panel).
 */
export function aggregateActivity(
  active: Record<string, ActivityMark>,
  touched: Record<string, ActivityMark>,
  keys: Iterable<string>,
): GroupActivity {
  let busy = false;
  let doneCount = 0;
  for (const key of keys) {
    if (key in active) busy = true;
    if (key in touched) doneCount += 1;
  }
  return { busy, doneCount };
}
