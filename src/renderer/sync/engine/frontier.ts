import type { Sha256 } from '../protocol';

export const FRONTIER_LANES = ['received', 'applied', 'published'] as const;
export type FrontierLane = (typeof FRONTIER_LANES)[number];

export interface SequenceRange {
  readonly firstSeq: number;
  readonly lastSeq: number;
}

export interface FrontierLaneState {
  /** Highest sequence observed on this lane; open gaps describe missing ranges below it. */
  readonly maxSeq: number;
  readonly gaps: readonly SequenceRange[];
}

export interface WriterFrontierState {
  readonly syncGenerationId: string;
  readonly writerId: string;
  readonly writerEpoch: string;
  readonly received: FrontierLaneState;
  readonly applied: FrontierLaneState;
  readonly published: FrontierLaneState;
  readonly segmentHeadSha256: Sha256 | null;
}

function assertSequence(value: number, label: string, allowZero = false): void {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${label} must be a safe integer >= ${minimum}`);
  }
}

function assertRange(range: SequenceRange): void {
  assertSequence(range.firstSeq, 'firstSeq');
  assertSequence(range.lastSeq, 'lastSeq');
  if (range.lastSeq < range.firstSeq) throw new RangeError('lastSeq must not precede firstSeq');
}

function removeCoveredRange(
  gaps: readonly SequenceRange[],
  covered: SequenceRange,
): SequenceRange[] {
  const next: SequenceRange[] = [];
  for (const gap of gaps) {
    if (covered.lastSeq < gap.firstSeq || covered.firstSeq > gap.lastSeq) {
      next.push(gap);
      continue;
    }
    if (covered.firstSeq > gap.firstSeq) {
      next.push({ firstSeq: gap.firstSeq, lastSeq: covered.firstSeq - 1 });
    }
    if (covered.lastSeq < gap.lastSeq) {
      next.push({ firstSeq: covered.lastSeq + 1, lastSeq: gap.lastSeq });
    }
  }
  return next;
}

function observeLaneRange(state: FrontierLaneState, range: SequenceRange): FrontierLaneState {
  assertRange(range);
  let gaps = [...state.gaps];
  if (range.firstSeq > state.maxSeq + 1) {
    gaps.push({ firstSeq: state.maxSeq + 1, lastSeq: range.firstSeq - 1 });
  }
  gaps.sort((left, right) => left.firstSeq - right.firstSeq);
  gaps = removeCoveredRange(gaps, range);
  return Object.freeze({ maxSeq: Math.max(state.maxSeq, range.lastSeq), gaps: Object.freeze(gaps) });
}

function overlaps(left: SequenceRange, right: SequenceRange): boolean {
  return left.firstSeq <= right.lastSeq && right.firstSeq <= left.lastSeq;
}

export function isFrontierRangeComplete(
  state: FrontierLaneState,
  range: SequenceRange,
): boolean {
  assertRange(range);
  return range.lastSeq <= state.maxSeq && !state.gaps.some((gap) => overlaps(gap, range));
}

export function contiguousFrontierSeq(state: FrontierLaneState): number {
  return state.gaps[0] ? state.gaps[0].firstSeq - 1 : state.maxSeq;
}

/**
 * Returns true when a range contains the next sequence that can advance a
 * contiguous lane. A fully observed duplicate is intentionally false: it has
 * no work left to advance.
 */
export function canAdvanceContiguousFrontier(
  state: FrontierLaneState,
  range: SequenceRange,
): boolean {
  assertRange(range);
  if (isFrontierRangeComplete(state, range)) return false;
  const nextSeq = contiguousFrontierSeq(state) + 1;
  return range.firstSeq <= nextSeq && range.lastSeq >= nextSeq;
}

export function createWriterFrontier(input: {
  syncGenerationId: string;
  writerId: string;
  writerEpoch: string;
}): WriterFrontierState {
  const empty = (): FrontierLaneState => Object.freeze({ maxSeq: 0, gaps: Object.freeze([]) });
  return Object.freeze({
    ...input,
    received: empty(),
    applied: empty(),
    published: empty(),
    segmentHeadSha256: null,
  });
}

/**
 * Advances one durable frontier lane. Out-of-order ranges are represented as
 * normalized gaps, making duplicate and reordered delivery idempotent.
 */
export function observeFrontierRange(
  state: WriterFrontierState,
  lane: FrontierLane,
  range: SequenceRange,
): WriterFrontierState {
  assertRange(range);
  if (lane !== 'received' && !isFrontierRangeComplete(state.received, range)) {
    throw new Error(`${lane} frontier cannot advance before the range is durably received`);
  }
  if (lane === 'applied' && !canAdvanceContiguousFrontier(state.applied, range)) {
    if (isFrontierRangeComplete(state.applied, range)) return state;
    throw new Error('applied frontier cannot advance across a missing predecessor');
  }
  return Object.freeze({ ...state, [lane]: observeLaneRange(state[lane], range) });
}

export function setAppliedSegmentHead(
  state: WriterFrontierState,
  input: { lastSeq: number; sha256: Sha256 },
): WriterFrontierState {
  assertSequence(input.lastSeq, 'segment head lastSeq');
  if (contiguousFrontierSeq(state.applied) < input.lastSeq) {
    throw new Error('segment head cannot advance beyond the contiguous applied frontier');
  }
  if (input.lastSeq !== state.applied.maxSeq) {
    throw new Error('segment head must describe the highest applied writer sequence');
  }
  if (state.segmentHeadSha256 === input.sha256) return state;
  return Object.freeze({ ...state, segmentHeadSha256: input.sha256 });
}

export function assertWriterFrontierInvariants(state: WriterFrontierState): void {
  for (const lane of FRONTIER_LANES) {
    assertSequence(state[lane].maxSeq, `${lane}.maxSeq`, true);
    let previousLast = 0;
    for (const gap of state[lane].gaps) {
      assertRange(gap);
      if (gap.firstSeq <= previousLast + (previousLast === 0 ? 0 : 1)) {
        throw new Error(`${lane} gaps must be sorted, disjoint, and non-adjacent`);
      }
      if (gap.lastSeq > state[lane].maxSeq) {
        throw new Error(`${lane} gap cannot extend beyond its maximum sequence`);
      }
      previousLast = gap.lastSeq;
    }
  }
  if (state.applied.maxSeq > state.received.maxSeq) {
    throw new Error('applied frontier cannot exceed received frontier');
  }
  if (state.published.maxSeq > state.received.maxSeq) {
    throw new Error('published frontier cannot exceed received frontier');
  }
  if (
    state.segmentHeadSha256 &&
    (state.applied.maxSeq === 0 || contiguousFrontierSeq(state.applied) !== state.applied.maxSeq)
  ) {
    throw new Error('segment head requires a non-empty contiguous applied frontier');
  }
}
