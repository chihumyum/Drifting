import { describe, expect, it } from 'vitest';

import { actForOrder, type BookAct } from './book-act';
import { CHAPTER_ORDER_STRIDE } from './book-node';
import { chapterOrderAfter } from './chapter-insert';

function act(id: string, startOrder: number | null): BookAct {
  return {
    id,
    projectId: 'p',
    name: id,
    color: null,
    startOrder,
    driftNodeId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('chapterOrderAfter', () => {
  it('appends one stride after the last chapter, like the sidebar', () => {
    expect(chapterOrderAfter([5, 10, 15], [], null)).toBe(15 + CHAPTER_ORDER_STRIDE);
    expect(chapterOrderAfter([], [], null)).toBe(CHAPTER_ORDER_STRIDE);
  });

  it('appends after the last chapter when inserting after it', () => {
    expect(chapterOrderAfter([5, 10, 15], [], 15)).toBe(20);
  });

  it('lands between a chapter and its successor', () => {
    expect(chapterOrderAfter([5, 10, 15], [], 10)).toBe(12.5);
    expect(chapterOrderAfter([5, 6], [], 5)).toBe(5.5);
  });

  it('stays adjacent to the predecessor inside a wide authored gap', () => {
    expect(chapterOrderAfter([5, 40], [], 5)).toBe(5 + CHAPTER_ORDER_STRIDE);
  });

  it('never crosses into the following act', () => {
    const acts = [act('a1', null), act('a2', 12)];
    const order = chapterOrderAfter([5, 10, 15], acts, 10);
    expect(order).toBe(11);
    expect(actForOrder(acts, order)?.id).toBe('a1');
  });

  it('keeps the last chapter of an act out of a trailing empty act', () => {
    const acts = [act('a1', null), act('a2', 16)];
    const order = chapterOrderAfter([5, 10, 15], acts, 15);
    expect(order).toBe(15.5);
    expect(actForOrder(acts, order)?.id).toBe('a1');
  });

  it('ignores an act boundary at the predecessor itself', () => {
    expect(chapterOrderAfter([5, 10, 15], [act('a2', 10)], 10)).toBe(12.5);
  });

  it('ties with the predecessor once the gap is below float resolution', () => {
    const after = 1;
    const successor = after + Number.EPSILON;
    expect(chapterOrderAfter([after, successor], [], after)).toBe(after);
  });
});
