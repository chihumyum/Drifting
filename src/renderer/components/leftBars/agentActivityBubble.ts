/**
 * Agent-activity bubbling (#17). The per-cell glyph effect rolls UP two layers:
 *   cell (chapter/element/drift)  →  group (storyline/category)  →  tab switcher
 *
 * Every layer above a cell renders the same little state machine over the cells
 * beneath it:
 *   - busy (a child cell is being touched right now) → the layer keeps its
 *     glyph and blinks/glows it in accent.
 *   - not busy + doneCount > 0 (children with unviewed changes) → the leading
 *     glyph is REPLACED by a plain count (how many changed cells the user hasn't
 *     opened). The count returns to the glyph once they've reviewed all (→ 0).
 *   - both → busy wins: the glyph blinks and the count stays hidden until the
 *     run finishes, so a working layer never shows a static number.
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
