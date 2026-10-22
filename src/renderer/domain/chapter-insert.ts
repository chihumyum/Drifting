import { CHAPTER_ORDER_STRIDE } from './book-node';
import type { BookAct } from './book-act';

/**
 * Reading-order coordinate for a chapter inserted directly after the chapter
 * at `afterOrder` (the ⁂ insert at a chapter's end). `afterOrder = null`
 * appends after the last chapter, matching the sidebar's 新章节.
 *
 * The new chapter must land between its predecessor and whatever follows it
 * in the read-through: the next chapter, or the next act boundary — acts are
 * boundary-based (see book-act.ts), so crossing a boundary would silently move
 * the new chapter into the following act. Within that gap it sits one stride
 * after the predecessor when there is room (the timeline tile stays adjacent
 * instead of floating in an authored gap), otherwise at the midpoint.
 */
export function chapterOrderAfter(
  chapterOrders: readonly number[],
  acts: readonly Pick<BookAct, 'startOrder'>[],
  afterOrder: number | null,
): number {
  if (afterOrder == null) {
    return chapterOrders.reduce((max, order) => Math.max(max, order), 0) + CHAPTER_ORDER_STRIDE;
  }
  let ceiling = Number.POSITIVE_INFINITY;
  for (const order of chapterOrders) {
    if (order > afterOrder && order < ceiling) ceiling = order;
  }
  for (const { startOrder } of acts) {
    if (startOrder != null && startOrder > afterOrder && startOrder < ceiling) ceiling = startOrder;
  }
  const next = afterOrder + Math.min(CHAPTER_ORDER_STRIDE, (ceiling - afterOrder) / 2);
  // Repeated inserts at one spot halve the gap each time; once it is below
  // float resolution, tie with the predecessor. Equal bookOrders break ties by
  // id, and the new uuidv7 sorts after every existing chapter.
  return next > afterOrder && next < ceiling ? next : afterOrder;
}
