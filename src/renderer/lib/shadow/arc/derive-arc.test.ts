import { describe, it, expect } from 'vitest';
import {
  buildAppearances,
  groupAppearances,
  formatProse,
  deriveElementArc,
  type ArcEngineDeps,
} from './derive-arc';
import type { ArcAppearance } from '../../../domain/element-arc';

function app(chapterId: string, order: number, fromNarrative = true): ArcAppearance {
  return { chapterId, chapterTitle: chapterId.toUpperCase(), order, fromNarrative };
}

describe('buildAppearances', () => {
  it('dedups, drops unplaced/unknown, falls back to bookOrder + fromTitle, sorts by order', () => {
    const backlinks = [
      { fromId: 'c2', fromTitle: 'B' },
      { fromId: 'c1', fromTitle: 'A' },
      { fromId: 'c1', fromTitle: 'A' }, // duplicate mention → one appearance
      { fromId: 'cD', fromTitle: 'D' },
      { fromId: 'cX', fromTitle: 'X' }, // unplaced (no axis) → skip
      { fromId: 'cMissing', fromTitle: 'M' }, // no node row → skip
    ];
    const nodeOrder = new Map([
      ['c2', { title: 'B', narrativeOrder: 10, bookOrder: 20, finished: true }],
      ['c1', { title: '', narrativeOrder: 5, bookOrder: 5, finished: true }], // empty title → use fromTitle
      ['cD', { title: 'D', narrativeOrder: null, bookOrder: 7, finished: true }], // bookOrder fallback
      ['cX', { title: 'X', narrativeOrder: null, bookOrder: null, finished: true }],
    ]);

    const apps = buildAppearances(backlinks, nodeOrder, true);

    expect(apps.map((a) => a.chapterId)).toEqual(['c1', 'cD', 'c2']);
    expect(apps.map((a) => a.order)).toEqual([5, 7, 10]);
    expect(apps[0]!.chapterTitle).toBe('A'); // fromTitle fallback when node title blank
    expect(apps[1]!.fromNarrative).toBe(false); // came from bookOrder
    expect(apps[2]!.fromNarrative).toBe(true);
  });

  it('drops draft chapters unless includeDrafts is set', () => {
    const backlinks = [
      { fromId: 'cf', fromTitle: 'F' },
      { fromId: 'cd', fromTitle: 'D' },
    ];
    const nodeOrder = new Map([
      ['cf', { title: 'F', narrativeOrder: 1, bookOrder: 1, finished: true }],
      ['cd', { title: 'D', narrativeOrder: 2, bookOrder: 2, finished: false }],
    ]);
    expect(buildAppearances(backlinks, nodeOrder, false).map((a) => a.chapterId)).toEqual(['cf']);
    expect(buildAppearances(backlinks, nodeOrder, true).map((a) => a.chapterId)).toEqual(['cf', 'cd']);
  });
});

describe('groupAppearances', () => {
  it('folds a small element into a single labeled group', () => {
    const groups = groupAppearances([app('a', 5), app('b', 10), app('c', 15)]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe('n5–n15');
    expect(groups[0]!.indices).toEqual([0, 1, 2]);
  });

  it('adapts the number of segments to the count (ceil(N/4))', () => {
    const eight = Array.from({ length: 8 }, (_, i) => app(`c${i}`, i + 1));
    expect(groupAppearances(eight).map((g) => g.indices)).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7],
    ]);

    const ten = Array.from({ length: 10 }, (_, i) => app(`c${i}`, i + 1));
    expect(groupAppearances(ten).map((g) => g.indices)).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7],
      [8, 9],
    ]);
  });

  it('labels a single-chapter group by its lone order', () => {
    expect(groupAppearances([app('a', 42)])[0]!.label).toBe('n42');
  });

  it('returns nothing for an empty work-list', () => {
    expect(groupAppearances([])).toEqual([]);
  });
});

describe('formatProse', () => {
  it('joins non-empty block text as plain prose (no block ids), dropping blanks', () => {
    const out = formatProse([
      { blockId: 'b1', type: 'paragraph', text: '第一段' },
      { blockId: null, type: 'paragraph', text: '无id段' },
      { blockId: 'b3', type: 'paragraph', text: '   ' }, // blank → dropped
    ]);
    expect(out).toBe('第一段\n无id段');
  });
});

describe('deriveElementArc (orchestration with fake deps)', () => {
  function makeDeps() {
    const apps = [app('c1', 5), app('c2', 10), app('c3', 15)];
    const calls = { leaf: 0, distill: 0, synth: [] as string[] };
    const deps: ArcEngineDeps = {
      loadElementCanon: async () => ({ name: '米拉', canonText: 'CANON' }),
      loadAppearances: async () => apps,
      loadProseBlocks: async (id) => [{ blockId: `${id}-b1`, type: 'paragraph', text: `prose ${id}` }],
      loadPatches: async () => [{ atOrder: 10, title: 'P1', body: 'patch body' }],
      runLeaf: async (input) => {
        calls.leaf++;
        return {
          oneLineState: `state ${input.order}`,
          observations: [{ text: 'o', signal: 'action' }],
          divergenceFromCanon: [],
        };
      },
      runDistill: async () => {
        calls.distill++;
        return {
          subArc: 'sub',
          trends: [{ dimension: '能力', trend: 'c' }],
          motivations: [{ claim: 'm', confidence: 'low', orders: [10] }],
        };
      },
      runSynthesize: async (input) => {
        calls.synth.push(input.patchesJson);
        return {
          narrative: 'N',
          points: [
            { order: 10, label: 'L', state: 'S', confidence: 'high' },
            { order: 99, label: 'ghost', state: '', confidence: 'low' }, // order not in work-list
          ],
          tensions: [{ kind: 'contrast', note: 't', orders: [5] }],
          patchOverlay: [{ atOrder: 10, patchTitle: 'P1', alignsWithDerived: true, note: 'ok' }],
        };
      },
      concurrency: 2,
    };
    return { deps, calls };
  }

  it('runs leaf-per-appearance → one distill group → synthesize, and assembles the ArcMap', async () => {
    const { deps, calls } = makeDeps();
    const arc = await deriveElementArc('el-1', 'proj-1', { deps });

    expect(calls.leaf).toBe(3); // one leaf per appearance
    expect(calls.distill).toBe(1); // 3 appearances → 1 segment
    expect(calls.synth).toHaveLength(1);
    expect(calls.synth[0]).toContain('P1'); // patches reach SYNTHESIZE for overlay

    expect(arc.elementName).toBe('米拉');
    expect(arc.axis).toBe('narrativeOrder');
    expect(arc.coverage).toEqual({ appearances: 3, generatedAtOrder: 15, skipped: 0 });
    expect(arc.patchOverlay[0]!.alignsWithDerived).toBe(true);
  });

  it('skips a chapter whose leaf keeps failing and derives from the survivors', async () => {
    const { deps } = makeDeps();
    const arc = await deriveElementArc('el-1', 'proj-1', {
      deps: {
        ...deps,
        runLeaf: async (input) => {
          if (input.order === 10) throw new Error('invalid JSON'); // this chapter is unrecoverable
          return { oneLineState: 's', observations: [], divergenceFromCanon: [] };
        },
      },
    });
    expect(arc.coverage.appearances).toBe(2); // 3 appearances, 1 dropped
    expect(arc.coverage.skipped).toBe(1);
    expect(arc.narrative).toBe('N'); // still synthesized from the rest
  });

  it('resolves point/tension orders → chapterId (chapter-level provenance)', async () => {
    const { deps } = makeDeps();
    const arc = await deriveElementArc('el-1', 'proj-1', { deps });

    const real = arc.points.find((p) => p.order === 10)!;
    expect(real.chapterId).toBe('c2'); // order → chapterId

    const ghost = arc.points.find((p) => p.order === 99)!;
    expect(ghost.chapterId).toBe(''); // order with no chapter resolves to empty, not a crash

    expect(arc.tensions[0]!.orders).toEqual([5]);
    expect(arc.tensions[0]!.chapterIds).toEqual(['c1']); // order 5 → c1
  });

  it('returns an empty ArcMap when the element never appears', async () => {
    const { deps } = makeDeps();
    const arc = await deriveElementArc('el-1', 'proj-1', {
      deps: { ...deps, loadAppearances: async () => [] },
    });
    expect(arc.points).toEqual([]);
    expect(arc.coverage.appearances).toBe(0);
    expect(arc.narrative).toBe('');
  });
});
