import { describe, expect, it } from 'vitest';

import type { Sha256 } from '../protocol';
import {
  assertWriterFrontierInvariants,
  canAdvanceContiguousFrontier,
  contiguousFrontierSeq,
  createWriterFrontier,
  observeFrontierRange,
  setAppliedSegmentHead,
  type WriterFrontierState,
} from './frontier';

const hash = (character: string) => `sha256:${character.repeat(64)}` as Sha256;
const fresh = () =>
  createWriterFrontier({ syncGenerationId: 'sync-generation-a', writerId: 'writer-a', writerEpoch: 'epoch-a' });

describe('writer frontier and gaps', () => {
  it('tracks, shrinks, splits, and closes reordered received gaps', () => {
    let state = observeFrontierRange(fresh(), 'received', { firstSeq: 4, lastSeq: 8 });
    expect(state.received).toEqual({ maxSeq: 8, gaps: [{ firstSeq: 1, lastSeq: 3 }] });
    state = observeFrontierRange(state, 'received', { firstSeq: 2, lastSeq: 2 });
    expect(state.received.gaps).toEqual([
      { firstSeq: 1, lastSeq: 1 },
      { firstSeq: 3, lastSeq: 3 },
    ]);
    state = observeFrontierRange(state, 'received', { firstSeq: 1, lastSeq: 3 });
    expect(state.received).toEqual({ maxSeq: 8, gaps: [] });
    expect(contiguousFrontierSeq(state.received)).toBe(8);
    assertWriterFrontierInvariants(state);
  });

  it('is idempotent and converges for every delivery permutation', () => {
    const ranges = [
      { firstSeq: 1, lastSeq: 2 },
      { firstSeq: 3, lastSeq: 4 },
      { firstSeq: 5, lastSeq: 6 },
    ];
    const permutations = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    const results = permutations.map((order) => {
      let state = fresh();
      for (const index of order) {
        state = observeFrontierRange(state, 'received', ranges[index]!);
        state = observeFrontierRange(state, 'received', ranges[index]!);
      }
      return state.received;
    });
    expect(results.every((result) => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(
      true,
    );
    expect(results[0]).toEqual({ maxSeq: 6, gaps: [] });
  });

  it('does not apply bytes that are missing or precede a received dependency gap', () => {
    const state = observeFrontierRange(fresh(), 'received', { firstSeq: 3, lastSeq: 5 });
    expect(() =>
      observeFrontierRange(state, 'applied', { firstSeq: 1, lastSeq: 3 }),
    ).toThrow('durably received');
    expect(canAdvanceContiguousFrontier(state.applied, { firstSeq: 3, lastSeq: 5 })).toBe(false);
    expect(() =>
      observeFrontierRange(state, 'applied', { firstSeq: 3, lastSeq: 5 }),
    ).toThrow('missing predecessor');

    let contiguous = observeFrontierRange(state, 'received', { firstSeq: 1, lastSeq: 2 });
    expect(canAdvanceContiguousFrontier(contiguous.applied, { firstSeq: 1, lastSeq: 2 })).toBe(true);
    contiguous = observeFrontierRange(contiguous, 'applied', { firstSeq: 1, lastSeq: 2 });
    expect(canAdvanceContiguousFrontier(contiguous.applied, { firstSeq: 3, lastSeq: 5 })).toBe(true);
    contiguous = observeFrontierRange(contiguous, 'applied', { firstSeq: 3, lastSeq: 5 });
    expect(contiguous.applied).toEqual({ maxSeq: 5, gaps: [] });
    expect(observeFrontierRange(contiguous, 'applied', { firstSeq: 1, lastSeq: 2 })).toBe(contiguous);
  });

  it('advances a hash head only behind a complete applied chain', () => {
    let state: WriterFrontierState = fresh();
    state = observeFrontierRange(state, 'received', { firstSeq: 1, lastSeq: 2 });
    state = observeFrontierRange(state, 'applied', { firstSeq: 1, lastSeq: 2 });
    state = setAppliedSegmentHead(state, { lastSeq: 2, sha256: hash('a') });
    expect(setAppliedSegmentHead(state, { lastSeq: 2, sha256: hash('a') })).toBe(state);
    expect(setAppliedSegmentHead(state, { lastSeq: 2, sha256: hash('b') }).segmentHeadSha256).toBe(
      hash('b'),
    );
  });
});
