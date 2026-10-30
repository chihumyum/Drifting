import { describe, expect, it } from 'vitest';
import {
  ISLES_LOD_ZOOM,
  isleAppearance,
  isleCompanions,
  isleKey,
  isleMarkWeight,
  isleNeighbours,
  islePairs,
  isleSection,
  islesLod,
  isleTicks,
} from './element-isles-model';

const pairs = new Map([
  [isleKey('lin', 'cap'), 7],
  [isleKey('lin', 'tower'), 3],
  [isleKey('cap', 'key'), 1],
  [isleKey('gone', 'lin'), 4],
]);

describe('element islands', () => {
  it('reads far, middle and near from the zoom, and each distance lands in its own band', () => {
    expect(islesLod(0.4)).toBe('far');
    expect(islesLod(0.9)).toBe('mid');
    expect(islesLod(1.6)).toBe('near');
    for (const lod of ['far', 'mid', 'near'] as const) expect(islesLod(ISLES_LOD_ZOOM[lod])).toBe(lod);
  });

  it('keys a pair the same whichever element comes first', () => {
    expect(isleKey('b', 'a')).toBe('a|b');
    expect(isleKey('a', 'b')).toBe('a|b');
  });

  it('draws only pairs at the threshold between elements still on the canvas', () => {
    const present = new Set(['lin', 'cap', 'tower', 'key']);
    expect(islePairs(pairs, 2, present).map((pair) => [pair.a, pair.b, pair.count])).toEqual([
      ['cap', 'lin', 7],
      ['lin', 'tower', 3],
    ]);
    expect(islePairs(pairs, 1, present)).toHaveLength(3);
  });

  it('counts drawn lines and drawn relations as neighbours, itself included', () => {
    const drawn = islePairs(pairs, 2, new Set(['lin', 'cap', 'tower', 'key']));
    expect([...isleNeighbours('lin', drawn, [{ a: 'log', b: 'lin' }])].sort()).toEqual(['cap', 'lin', 'log', 'tower']);
    expect([...isleNeighbours('key', drawn, [])]).toEqual(['key']);
  });

  it('lists who an element is mentioned with most, most first', () => {
    expect(isleCompanions('lin', pairs, 2)).toEqual([{ id: 'cap', count: 7 }, { id: 'gone', count: 4 }]);
  });

  it('sizes marks on a square-root scale, and an unmentioned element has none', () => {
    expect(isleMarkWeight(0, 50)).toBe(0);
    expect(isleMarkWeight(50, 50)).toBe(1);
    expect(isleMarkWeight(12.5, 50)).toBe(0.5);
  });

  it('lays an element out across the book in order and sums up where it appears', () => {
    const chapters = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((id) => ({ id, title: id.toUpperCase(), color: id === 'c2' ? '#88a' : null }));
    const ticks = isleTicks(chapters, new Map([['c2', 3], ['c3', 1], ['c6', 2]]));
    expect(ticks.map((tick) => tick.count)).toEqual([0, 3, 1, 0, 0, 2]);
    expect(ticks[1]).toMatchObject({ number: 2, title: 'C2', color: '#88a' });
    expect(isleAppearance(ticks)).toEqual({ appeared: 3, total: 6, first: 2, last: 6, longestGap: 2 });
    expect(isleAppearance(isleTicks(chapters, undefined))).toEqual({ appeared: 0, total: 6, first: null, last: null, longestGap: 0 });
    expect(isleSection(7)).toBe('§07');
  });
});
