import { describe, expect, it } from 'vitest';
import {
  actForOrder,
  defaultActName,
  deriveActSegments,
  remapActBoundariesForSpread,
  sortActs,
  type BookAct,
} from './book-act';

function act(id: string, startOrder: number | null, name = id): BookAct {
  return {
    id,
    projectId: 'p',
    name,
    summary: '',
    color: null,
    startOrder,
    driftNodeId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function ch(id: string, bookOrder: number | null) {
  return { id, bookOrder };
}

describe('sortActs', () => {
  it('puts the null-start opener first, then ascending startOrder', () => {
    const sorted = sortActs([act('b', 40), act('a', null), act('c', 10)]);
    expect(sorted.map((a) => a.id)).toEqual(['a', 'c', 'b']);
  });
});

describe('deriveActSegments', () => {
  const acts = [act('a1', null), act('a2', 20), act('a3', 47.5)];
  const chapters = [ch('c1', 5), ch('c2', 15), ch('c3', 20), ch('c4', 45), ch('c5', 50)];

  it('returns [] when no acts exist', () => {
    expect(deriveActSegments([], chapters)).toEqual([]);
  });

  it('assigns chapters by >= startOrder, < next startOrder', () => {
    const segs = deriveActSegments(acts, chapters);
    expect(segs.map((s) => s.chapters.map((c) => c.id))).toEqual([
      ['c1', 'c2'],
      ['c3', 'c4'], // c3 sits exactly ON the boundary → joins the act it opens
      ['c5'],
    ]);
  });

  it('keeps empty acts (planned 幕 with no chapters)', () => {
    const segs = deriveActSegments([...acts, act('a4', 100)], chapters);
    expect(segs[3].chapters).toEqual([]);
  });

  it('skips drift nodes (null bookOrder)', () => {
    const segs = deriveActSegments(acts, [...chapters, ch('d1', null)]);
    expect(segs.flatMap((s) => s.chapters.map((c) => c.id))).not.toContain('d1');
  });

  it('puts chapters before a leading positive boundary into segment 0 when no opener exists', () => {
    const segs = deriveActSegments([act('a2', 20), act('a3', 47.5)], chapters);
    expect(segs[0].chapters.map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4']);
  });
});

describe('actForOrder', () => {
  const acts = [act('a1', null), act('a2', 20)];
  it('resolves the covering act', () => {
    expect(actForOrder(acts, 5)?.id).toBe('a1');
    expect(actForOrder(acts, 20)?.id).toBe('a2');
    expect(actForOrder(acts, 999)?.id).toBe('a2');
    expect(actForOrder([], 5)).toBeNull();
  });
});

describe('remapActBoundariesForSpread', () => {
  // Chapters drifted to crowded orders 1,2,3,40 — spread reassigns 1,6,11,16
  // (stride 5). A boundary at 2.5 (between c2@2 and c3@3) must land at the
  // midpoint of their NEW orders: (6+11)/2 = 8.5.
  const oldOrders = new Map([
    ['c1', 1],
    ['c2', 2],
    ['c3', 3],
    ['c4', 40],
  ]);
  const newOrders = new Map([
    ['c1', 1],
    ['c2', 6],
    ['c3', 11],
    ['c4', 16],
  ]);

  it('remaps each boundary to the midpoint of its straddling pair', () => {
    const patches = remapActBoundariesForSpread(
      [act('a1', null), act('a2', 2.5), act('a3', 20)],
      oldOrders,
      newOrders,
      5,
    );
    // a2: between c2 and c3 → 8.5. a3 @20: between c3(3) and c4(40) → (11+16)/2.
    expect(patches).toEqual([
      { id: 'a2', startOrder: 8.5 },
      { id: 'a3', startOrder: 13.5 },
    ]);
  });

  it('keeps the opener (null) untouched and skips unchanged boundaries', () => {
    const patches = remapActBoundariesForSpread(
      [act('a1', null)],
      oldOrders,
      newOrders,
      5,
    );
    expect(patches).toEqual([]);
  });

  it('clamps boundaries hanging before/after all chapters by half a stride', () => {
    const patches = remapActBoundariesForSpread(
      [act('lead', 0.5), act('tail', 99)],
      oldOrders,
      newOrders,
      5,
    );
    expect(patches).toEqual([
      { id: 'lead', startOrder: 1 - 2.5 },
      { id: 'tail', startOrder: 16 + 2.5 },
    ]);
  });

  it('a boundary exactly ON a chapter order treats that chapter as its act opener (>= semantics)', () => {
    const patches = remapActBoundariesForSpread(
      [act('on', 3)],
      oldOrders,
      newOrders,
      5,
    );
    // straddling pair = c2 (old 2 < 3) and c3 (old 3 >= 3) → (6+11)/2
    expect(patches).toEqual([{ id: 'on', startOrder: 8.5 }]);
  });
});

describe('defaultActName', () => {
  it('renders Chinese ordinals', () => {
    expect(defaultActName(1)).toBe('第一幕');
    expect(defaultActName(2)).toBe('第二幕');
    expect(defaultActName(10)).toBe('第十幕');
    expect(defaultActName(12)).toBe('第十二幕');
    expect(defaultActName(21)).toBe('第二十一幕');
    expect(defaultActName(30)).toBe('第三十幕');
  });
});
