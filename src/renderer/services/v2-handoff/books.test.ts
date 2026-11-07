import { describe, expect, it } from 'vitest';

import { captureV2HandoffBooks, normalizeV2HandoffBooks, WRITING_STATS_STORAGE_KEY } from './books';

function storageOf(entries: Record<string, string>): Storage {
  const values = new Map(Object.entries(entries));
  return {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
  } as Storage;
}

const writingStats = (plans: Record<string, unknown>, version = 3, history: unknown = {}) =>
  JSON.stringify({ state: { plans, history }, version });
const edgeMeta = (byRelationTypeId: unknown, v: unknown = 2) => JSON.stringify({ v, byRelationTypeId });

describe('v2 handoff books', () => {
  it("reads each book's writing plan, relation-type colors and element pins", () => {
    const storage = storageOf({
      [WRITING_STATS_STORAGE_KEY]: writingStats(
        { 'book-a': { projectWordTarget: 80000, dailyWordGoal: 0 }, 'book-b': { projectWordTarget: 0, dailyWordGoal: 1200 } },
        3,
        { 'book-a': { '2026-11-06': { startTotal: 10, latestTotal: 900 } } },
      ),
      'drifting:edge-kind-meta:book-a': edgeMeta({ 'type-2': { color: '#112233' }, 'type-1': { color: '#aabbcc' }, 'type-3': {} }),
      'super-element-view:relate:book-a': JSON.stringify({
        v: 1, mode: 'isles', signature: 'sig',
        positions: { 'element-1': [1, 2], 'element-9': [3, 4] },
        pins: { 'element-2': [-8, 0.5], 'element-1': [12.5, -40] },
      }),
    });

    expect(captureV2HandoffBooks(['book-b', 'book-a'], storage)).toEqual({
      'book-a': {
        wordTarget: 80000,
        dailyWordTarget: 0,
        relationTypeColors: { 'type-1': '#aabbcc', 'type-2': '#112233' },
        elementPins: { 'element-1': [12.5, -40], 'element-2': [-8, 0.5] },
      },
      // A target of 0 is the author turning it off, not a missing plan.
      'book-b': { wordTarget: 0, dailyWordTarget: 1200 },
    });
  });

  it('writes only the books it is asked for and leaves out a book with nothing to say', () => {
    const storage = storageOf({
      [WRITING_STATS_STORAGE_KEY]: writingStats({ 'other-library': { projectWordTarget: 5000, dailyWordGoal: 100 } }),
      'drifting:edge-kind-meta:other-library': edgeMeta({ t: { color: '#000000' } }),
      'super-element-view:relate:other-library': JSON.stringify({ pins: { e: [1, 1] } }),
      // Layout without pins: nothing of the author's.
      'super-element-view:relate:book-a': JSON.stringify({ mode: 'relate', positions: { e: [1, 1] }, pins: {} }),
    });
    expect(captureV2HandoffBooks(['book-a'], storage)).toEqual({});
  });

  it('ignores malformed values and payloads the stores themselves would not read', () => {
    const storage = storageOf({
      [WRITING_STATS_STORAGE_KEY]: '{not json',
      'drifting:edge-kind-meta:book-a': edgeMeta({ t: { color: '#aabbcc' } }, 1),
      'drifting:edge-kind-meta:book-b': edgeMeta(null),
      'drifting:edge-kind-meta:book-c': '[]',
      'super-element-view:relate:book-a': '{"pins":',
      'super-element-view:relate:book-b': JSON.stringify({ pins: { e1: [1], e2: ['1', 2], e3: [Number.NaN, 0], e4: [0, 0] } }),
    });
    expect(captureV2HandoffBooks(['book-a', 'book-b', 'book-c'], storage)).toEqual({
      'book-b': { elementPins: { e4: [0, 0] } },
    });

    // A plan stored without both numbers keeps the one that is there.
    const partial = storageOf({ [WRITING_STATS_STORAGE_KEY]: writingStats({ 'book-a': { projectWordTarget: -1, dailyWordGoal: 700 }, 'book-b': 5 }) });
    expect(captureV2HandoffBooks(['book-a', 'book-b'], partial)).toEqual({ 'book-a': { dailyWordTarget: 700 } });
  });

  it('reads an older writing-stats payload through the store migration', () => {
    // Version 2 kept one total per day; its plans hydrate unchanged.
    const v2 = storageOf({
      [WRITING_STATS_STORAGE_KEY]: writingStats({ 'book-a': { projectWordTarget: 90000, dailyWordGoal: 500 } }, 2, { 'book-a': { '2026-01-01': 10 } }),
    });
    expect(captureV2HandoffBooks(['book-a'], v2)).toEqual({ 'book-a': { wordTarget: 90000, dailyWordTarget: 500 } });
    // A payload the migration cannot read hydrates no plans in the app either.
    const broken = storageOf({
      [WRITING_STATS_STORAGE_KEY]: writingStats({ 'book-a': { projectWordTarget: 90000, dailyWordGoal: 500 } }, 2, null),
    });
    expect(captureV2HandoffBooks(['book-a'], broken)).toEqual({});
  });

  it('captures nothing when storage is unavailable', () => {
    expect(captureV2HandoffBooks(['book-a'], null)).toBeNull();
    const throwing = { get length() { return 0; }, key: () => null, getItem: () => { throw new Error('denied'); } } as unknown as Storage;
    expect(captureV2HandoffBooks(['book-a'], throwing)).toBeNull();
  });

  it('reads a stored section leniently, keeping only the named books', () => {
    expect(normalizeV2HandoffBooks({
      'book-a': { wordTarget: 1, relationTypeColors: { t: '#fff', u: 3 }, elementPins: { e: [1, 2, 3] }, extra: true },
      'book-b': { wordTarget: 'many' },
      'book-c': { dailyWordTarget: 5 },
    }, ['book-a', 'book-b'])).toEqual({ 'book-a': { wordTarget: 1, relationTypeColors: { t: '#fff' } } });
    expect(normalizeV2HandoffBooks(null, ['book-a'])).toEqual({});
  });
});
