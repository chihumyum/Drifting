import { describe, expect, it } from 'vitest';

import {
  OUTLINE_RAIL_HIDDEN_BELOW,
  OUTLINE_RAIL_LABEL_LANE,
  OUTLINE_RAIL_LABELS_AT,
  flattenOutlineEntries,
  layoutOutlineRailLabels,
  outlineRailFit,
  planOutlineRail,
  visibleOutlineIds,
  type OutlineEntry,
  type OutlineRailFit,
} from './outline-rail-model';

function chapter(index: number, childCount = 0): OutlineEntry {
  return {
    id: `chapter-${index}`,
    kind: 'chapter',
    level: 2,
    text: `Chapter ${index}`,
    children: Array.from({ length: childCount }, (_, child) => ({
      id: `chapter-${index}-h1-${child}`,
      kind: 'heading' as const,
      level: 1 as const,
      text: `H1 ${child}`,
    })),
  };
}

describe('semantic outline rail density planning', () => {
  it('keeps every chapter and nested heading when the rail has room', () => {
    const flat = flattenOutlineEntries([chapter(1, 2), chapter(2, 2)]);
    const plan = planOutlineRail(flat, 'chapter-1-h1-0', 500);

    expect(plan.mode).toBe('all');
    expect(plan.labels.map((label) => label.key)).toEqual(flat.map((entry) => entry.id));
  });

  it('collapses non-current chapter descendants before dropping chapter labels', () => {
    const flat = flattenOutlineEntries(Array.from({ length: 12 }, (_, index) => chapter(index, 3)));
    const plan = planOutlineRail(flat, 'chapter-6-h1-1', 300);
    const ids = plan.labels.flatMap((label) => (label.type === 'entry' ? [label.entry.id] : []));

    expect(plan.mode).toBe('active-branch');
    expect(ids).toContain('chapter-0');
    expect(ids).toContain('chapter-11');
    expect(ids).toContain('chapter-6-h1-0');
    expect(ids).toContain('chapter-6-h1-2');
    expect(ids).not.toContain('chapter-5-h1-0');
    expect(ids).not.toContain('chapter-7-h1-0');
  });

  it('windows hundreds of chapters around the current one with two omission handles', () => {
    const flat = flattenOutlineEntries(
      Array.from({ length: 240 }, (_, index) => chapter(index, index === 120 ? 2 : 0)),
    );
    const plan = planOutlineRail(flat, 'chapter-120-h1-0', 360);
    const entries = plan.labels.filter((label) => label.type === 'entry');
    const omissions = plan.labels.filter((label) => label.type === 'omission');

    expect(plan.mode).toBe('windowed');
    expect(plan.labels.length).toBeLessThanOrEqual(plan.capacity);
    expect(omissions).toHaveLength(2);
    expect(entries.some((label) => label.entry.id === 'chapter-120')).toBe(true);
    expect(entries.some((label) => label.entry.id === 'chapter-120-h1-0')).toBe(true);
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
    const plan = planOutlineRail(flat, 'chapter-10-h1-0', 500, {}, 34);
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
          { id: 'h1-a', kind: 'heading', level: 1, text: 'A' },
          { id: 'h1-b', kind: 'heading', level: 1, text: 'B' },
          { id: 'h1-c', kind: 'heading', level: 1, text: 'C' },
        ],
      },
    ]);
    const visible = visibleOutlineIds(
      flat,
      { chapter: 0, 'h1-a': 100, 'h1-b': 300, 'h1-c': 600 },
      250,
      650,
      900,
    );

    expect([...visible]).toEqual(
      expect.arrayContaining(['chapter', 'h1-a', 'h1-b', 'h1-c']),
    );
  });
});

describe('semantic outline rail fit beside the paper', () => {
  // The paper is centred, at most 720px wide, with 48px of side padding: the
  // gutter of an editor column of width w is (w - 720) / 2 + 48.
  const gutterOf = (column: number) => Math.max(0, (column - 720) / 2) + 48;

  it('keeps the labels while the lane clears the text and hides the rail once it would reach it', () => {
    expect(OUTLINE_RAIL_LABEL_LANE).toBe(12 + 176);
    expect(outlineRailFit(gutterOf(1280), 'labels')).toBe('labels');
    expect(outlineRailFit(OUTLINE_RAIL_HIDDEN_BELOW, 'labels')).toBe('labels');
    expect(outlineRailFit(OUTLINE_RAIL_HIDDEN_BELOW - 0.5, 'labels')).toBe('hidden');
    // Two side panels open: a ~400px column has only the paper's own padding.
    expect(outlineRailFit(gutterOf(400), 'labels')).toBe('hidden');
    expect(outlineRailFit(gutterOf(1000), 'labels')).toBe('hidden');
  });

  it('shows the labels again only with clear room, so the boundary never flickers', () => {
    expect(OUTLINE_RAIL_LABELS_AT - OUTLINE_RAIL_HIDDEN_BELOW).toBeGreaterThan(4 * 2);
    expect(outlineRailFit(OUTLINE_RAIL_HIDDEN_BELOW, 'hidden')).toBe('hidden');
    expect(outlineRailFit(OUTLINE_RAIL_LABELS_AT - 0.5, 'hidden')).toBe('hidden');
    expect(outlineRailFit(OUTLINE_RAIL_LABELS_AT, 'hidden')).toBe('labels');
    // A scrollbar appearing re-centres the paper by 4px back and forth.
    let fit: OutlineRailFit = 'labels';
    const settled: OutlineRailFit[] = [];
    for (const gutter of [200, 193, 197, 193, 197, 193]) settled.push((fit = outlineRailFit(gutter, fit)));
    expect(settled).toEqual(['labels', 'hidden', 'hidden', 'hidden', 'hidden', 'hidden']);
    fit = 'hidden';
    settled.length = 0;
    for (const gutter of [214, 210, 214, 210]) settled.push((fit = outlineRailFit(gutter, fit)));
    expect(settled).toEqual(['labels', 'labels', 'labels', 'labels']);
  });

  it('keeps the previous fit until a paper has been measured', () => {
    expect(outlineRailFit(null, 'labels')).toBe('labels');
    expect(outlineRailFit(null, 'hidden')).toBe('hidden');
    expect(outlineRailFit(Number.NaN, 'hidden')).toBe('hidden');
  });
});
