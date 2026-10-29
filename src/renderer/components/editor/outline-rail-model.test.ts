import { describe, expect, it } from 'vitest';

import {
  flattenOutlineEntries,
  layoutOutlineRailLabels,
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
  it('keeps every chapter and nested heading when the rail has room', () => {
    const flat = flattenOutlineEntries([chapter(1, 2), chapter(2, 2)]);
    const plan = planOutlineRail(flat, 'chapter-1-scene-0', 500);

    expect(plan.mode).toBe('all');
    expect(plan.labels.map((label) => label.key)).toEqual(flat.map((entry) => entry.id));
  });

  it('collapses non-current chapter descendants before dropping chapter labels', () => {
    const flat = flattenOutlineEntries(Array.from({ length: 12 }, (_, index) => chapter(index, 3)));
    const plan = planOutlineRail(flat, 'chapter-6-scene-1', 300);
    const ids = plan.labels.flatMap((label) => (label.type === 'entry' ? [label.entry.id] : []));

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

  it('reduces density and preserves touch pitch for the mobile rail', () => {
    const flat = flattenOutlineEntries(Array.from({ length: 20 }, (_, index) => chapter(index, 1)));
    const plan = planOutlineRail(flat, 'chapter-10-scene-0', 500, {}, 34);
    const laidOut = layoutOutlineRailLabels(plan.labels, 500, 34);

    expect(plan.capacity).toBe(Math.floor((500 - 18) / 34));
    expect(plan.labels.length).toBeLessThanOrEqual(plan.capacity);
    for (let index = 1; index < laidOut.length; index += 1) {
      expect(laidOut[index].y - laidOut[index - 1].y).toBeGreaterThanOrEqual(34);
    }
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

    expect([...visible]).toEqual(
      expect.arrayContaining(['chapter', 'scene-a', 'scene-b', 'scene-c']),
    );
  });
});
