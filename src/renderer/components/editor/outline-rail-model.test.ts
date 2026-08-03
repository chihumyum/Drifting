import { describe, expect, it } from 'vitest';

import {
  flattenOutlineEntries,
  layoutOutlineRailLabels,
  outlineVisibleLabelRange,
  planOutlineRailPlacement,
  planOutlineRail,
  visibleOutlineIds,
  type OutlineEntry,
} from './outline-rail-model';

function chapter(index: number, childCount = 0): OutlineEntry {
  return {
    id: `chapter-${index}`,
    kind: 'chapter',
    level: 2,
    text: `Chapter ${index}`,
    children: Array.from({ length: childCount }, (_, child) => ({
      id: `chapter-${index}-scene-${child}`,
      kind: 'heading' as const,
      level: 1 as const,
      text: `Scene ${child}`,
    })),
  };
}

describe('semantic outline rail density planning', () => {
  it('switches from the manuscript gutter to the left edge when width is insufficient', () => {
    expect(planOutlineRailPlacement(220)).toEqual({
      mode: 'resident',
      left: 62,
      width: 152,
    });
    expect(planOutlineRailPlacement(97)).toEqual({ mode: 'edge', left: 0, width: 0 });
    expect(planOutlineRailPlacement(98)).toEqual({
      mode: 'resident',
      left: 4,
      width: 88,
    });
  });

  it('keeps every chapter and nested heading when the rail has room', () => {
    const flat = flattenOutlineEntries([chapter(1, 2), chapter(2, 2)]);
    const plan = planOutlineRail(flat, 'chapter-1-scene-0', 500);

    expect(plan.mode).toBe('all');
    expect(plan.labels.map((label) => label.key)).toEqual(flat.map((entry) => entry.id));
  });

  it('collapses non-current chapter descendants before dropping chapter labels', () => {
    const flat = flattenOutlineEntries(
      Array.from({ length: 12 }, (_, index) => chapter(index, 3)),
    );
    const plan = planOutlineRail(flat, 'chapter-6-scene-1', 300);
    const ids = plan.labels.flatMap((label) =>
      label.type === 'entry' ? [label.entry.id] : [],
    );

    expect(plan.mode).toBe('active-branch');
    expect(ids).toContain('chapter-0');
    expect(ids).toContain('chapter-11');
    expect(ids).toContain('chapter-6-scene-0');
    expect(ids).toContain('chapter-6-scene-2');
    expect(ids).not.toContain('chapter-5-scene-0');
    expect(ids).not.toContain('chapter-7-scene-0');
  });

  it('windows hundreds of chapters around the current one with two omission handles', () => {
    const flat = flattenOutlineEntries(
      Array.from({ length: 240 }, (_, index) => chapter(index, index === 120 ? 2 : 0)),
    );
    const plan = planOutlineRail(flat, 'chapter-120-scene-0', 360);
    const entries = plan.labels.filter((label) => label.type === 'entry');
    const omissions = plan.labels.filter((label) => label.type === 'omission');

    expect(plan.mode).toBe('windowed');
    expect(plan.labels.length).toBeLessThanOrEqual(plan.capacity);
    expect(omissions).toHaveLength(2);
    expect(entries.some((label) => label.entry.id === 'chapter-120')).toBe(true);
    expect(entries.some((label) => label.entry.id === 'chapter-120-scene-0')).toBe(true);
    expect(entries.some((label) => label.entry.id === 'chapter-0')).toBe(false);
    expect(entries.some((label) => label.entry.id === 'chapter-239')).toBe(false);
  });

  it('only displaces labels when their true document positions collide', () => {
    const flat = flattenOutlineEntries([chapter(1), chapter(2), chapter(3)]);
    const plan = planOutlineRail(flat, 'chapter-1', 500, {
      'chapter-1': 0.1,
      'chapter-2': 0.5,
      'chapter-3': 0.9,
    });
    const spacious = layoutOutlineRailLabels(plan.labels, 500);
    expect(spacious.map((item) => Math.round(item.y))).toEqual([57, 250, 443]);

    const crowdedPlan = planOutlineRail(flat, 'chapter-1', 100, {
      'chapter-1': 0.48,
      'chapter-2': 0.49,
      'chapter-3': 0.5,
    });
    const crowded = layoutOutlineRailLabels(crowdedPlan.labels, 100);
    expect(crowded[1].y - crowded[0].y).toBeGreaterThanOrEqual(17);
    expect(crowded[2].y - crowded[1].y).toBeGreaterThanOrEqual(17);
  });

  it('keeps a stepwise outer range around the visible TOC labels', () => {
    const flat = flattenOutlineEntries([chapter(1), chapter(2), chapter(3)]);
    const plan = planOutlineRail(flat, 'chapter-2', 240, {
      'chapter-1': 0.1,
      'chapter-2': 0.5,
      'chapter-3': 0.9,
    });
    const laidOut = layoutOutlineRailLabels(plan.labels, 240);

    expect(outlineVisibleLabelRange(laidOut, new Set(['chapter-2']))).toEqual({
      firstY: 120,
      nextY: 208.8,
      count: 1,
    });
    const spread = outlineVisibleLabelRange(
      laidOut,
      new Set(['chapter-1', 'chapter-3']),
    );
    expect(spread?.firstY).toBeCloseTo(31.2);
    expect(spread?.nextY).toBeNull();
    expect(spread?.count).toBe(2);
  });

  it('extends a nested selection to the next chapter label boundary', () => {
    const flat = flattenOutlineEntries([
      {
        id: 'chapter-00',
        kind: 'chapter',
        level: 2,
        text: '00',
        children: [
          { id: 'scene-1', kind: 'heading', level: 1, text: 'Act one' },
          { id: 'scene-2', kind: 'heading', level: 1, text: 'Act two' },
        ],
      },
      { id: 'chapter-01', kind: 'chapter', level: 2, text: '01' },
    ]);
    const yById = new Map([
      ['chapter-00', 50],
      ['scene-1', 80],
      ['scene-2', 110],
      ['chapter-01', 190],
    ]);
    const laidOut = flat.map((entry) => ({
      label: {
        type: 'entry' as const,
        key: entry.id,
        entry,
        preferredFraction: 0,
      },
      y: yById.get(entry.id) ?? 0,
    }));

    expect(
      outlineVisibleLabelRange(laidOut, new Set(['chapter-00', 'scene-2'])),
    ).toEqual({ firstY: 50, nextY: 190, count: 2 });
  });

  it('selects every section intersecting the viewport plus its ancestor path', () => {
    const flat = flattenOutlineEntries([
      {
        id: 'chapter',
        kind: 'chapter',
        level: 2,
        text: 'Chapter',
        children: [
          { id: 'scene-a', kind: 'heading', level: 1, text: 'A' },
          { id: 'scene-b', kind: 'heading', level: 1, text: 'B' },
          { id: 'scene-c', kind: 'heading', level: 1, text: 'C' },
        ],
      },
    ]);
    const visible = visibleOutlineIds(
      flat,
      { chapter: 0, 'scene-a': 100, 'scene-b': 300, 'scene-c': 600 },
      250,
      650,
      900,
    );

    expect([...visible]).toEqual(expect.arrayContaining(['chapter', 'scene-a', 'scene-b', 'scene-c']));
  });
});
