/**
 * How many words this device added to a book today, from the book's running
 * total (docs/writing-days.md). Pure; the recorder feeds it.
 *
 * The day's words are the total minus a baseline: the total at which the day
 * would read zero. When a day is first seen, the baseline is put below the
 * total by the words already stored for it, so reopening the book keeps the
 * morning's words. Words that arrive from another device move the baseline
 * with them, so they are counted on the device that wrote them and not again
 * here. Deleting more than was written reads as zero, as the stats panel does.
 */
import type { ISODate } from '../../store/writing-stats-store';

export interface WritingDayTallyState {
  day: ISODate;
  baseline: number;
  lastTotal: number;
  words: number;
}

export function tallyWritingDay(
  state: WritingDayTallyState | null,
  input: {
    total: number;
    day: ISODate;
    /** Words already kept for `day` by this device; read only when the day is new to the tally. */
    storedWords: number;
    /** The total moved because a change from another device was applied. */
    remote: boolean;
  },
): WritingDayTallyState {
  const total = Math.max(0, Math.floor(input.total || 0));
  if (!state || state.day !== input.day) {
    const stored = Math.max(0, Math.floor(input.storedWords || 0));
    return { day: input.day, baseline: total - stored, lastTotal: total, words: stored };
  }
  const baseline = input.remote ? state.baseline + (total - state.lastTotal) : state.baseline;
  return { day: input.day, baseline, lastTotal: total, words: Math.max(0, total - baseline) };
}
