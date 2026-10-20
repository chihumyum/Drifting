import { describe, expect, it } from 'vitest';

import type { Hlc } from '../protocol';
import {
  compareSnapshotOrder,
  frontierCovers,
  frontierDominates,
  frontierLaneKey,
  laneFrontierFromSnapshot,
  minimumFrontier,
} from './frontier';

const a = frontierLaneKey('writer-a', 'epoch-1');
const b = frontierLaneKey('writer-b', 'epoch-1');
const hlc = (wallMs: number) => ({ wallMs, counter: 0, nodeId: 'node' }) as unknown as Hlc;

describe('lane frontiers', () => {
  it('reads snapshot entries and treats absent lanes as zero', () => {
    const frontier = laneFrontierFromSnapshot([
      { writerId: 'writer-a', writerEpoch: 'epoch-1', appliedSeq: 4, segmentHeadHash: null },
      { writerId: 'writer-b', writerEpoch: 'epoch-1', appliedSeq: 0, segmentHeadHash: null },
    ]);
    expect([...frontier]).toEqual([[a, 4]]);
    expect(frontierCovers(frontier, a, 4)).toBe(true);
    expect(frontierCovers(frontier, a, 5)).toBe(false);
    expect(frontierCovers(frontier, b, 1)).toBe(false);
  });

  it('compares by dominance on every lane', () => {
    const fuller = new Map([[a, 5], [b, 2]]);
    const partial = new Map([[a, 5]]);
    const crossed = new Map([[a, 3], [b, 9]]);
    expect(frontierDominates(fuller, partial)).toBe(true);
    expect(frontierDominates(partial, fuller)).toBe(false);
    expect(frontierDominates(fuller, crossed)).toBe(false);
    expect(frontierDominates(crossed, fuller)).toBe(false);
  });

  it('keeps only history every frontier covers', () => {
    expect([...minimumFrontier([new Map([[a, 5], [b, 2]]), new Map([[a, 3]])])]).toEqual([[a, 3]]);
    expect(minimumFrontier([]).size).toBe(0);
  });

  it('orders a dominating snapshot after a later but lagging one', () => {
    const fuller = { frontier: new Map([[a, 5], [b, 2]]), committedAt: hlc(1), snapshotId: 'fuller' };
    const lagging = { frontier: new Map([[a, 5]]), committedAt: hlc(9), snapshotId: 'lagging' };
    expect([lagging, fuller].sort(compareSnapshotOrder).map((entry) => entry.snapshotId)).toEqual([
      'lagging',
      'fuller',
    ]);
    const twin = { ...fuller, committedAt: hlc(2), snapshotId: 'twin' };
    expect([twin, fuller].sort(compareSnapshotOrder).map((entry) => entry.snapshotId)).toEqual([
      'fuller',
      'twin',
    ]);
  });
});
