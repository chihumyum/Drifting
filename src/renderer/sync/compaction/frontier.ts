import { compareHlc, compareUtf8Bytewise, type Hlc, type SnapshotFrontierEntryV1 } from '../protocol';

/**
 * Applied sequence per writer lane. A lane absent from a frontier is covered
 * up to zero, so comparisons and minimums treat it as 0.
 */
export type LaneFrontier = ReadonlyMap<string, number>;

export function frontierLaneKey(writerId: string, writerEpoch: string): string {
  return JSON.stringify([writerId, writerEpoch]);
}

export function laneFrontierFromSnapshot(entries: readonly SnapshotFrontierEntryV1[]): LaneFrontier {
  const lanes = new Map<string, number>();
  for (const entry of entries) {
    if (entry.appliedSeq > 0) lanes.set(frontierLaneKey(entry.writerId, entry.writerEpoch), entry.appliedSeq);
  }
  return lanes;
}

/** True when `upper` covers at least `lower` on every lane. */
export function frontierDominates(upper: LaneFrontier, lower: LaneFrontier): boolean {
  for (const [lane, seq] of lower) {
    if ((upper.get(lane) ?? 0) < seq) return false;
  }
  return true;
}

/** The history every given frontier covers; empty for no frontiers. */
export function minimumFrontier(frontiers: readonly LaneFrontier[]): LaneFrontier {
  const [first, ...rest] = frontiers;
  if (!first) return new Map();
  const lanes = new Map<string, number>();
  for (const [lane, seq] of first) {
    const covered = rest.reduce((low, frontier) => Math.min(low, frontier.get(lane) ?? 0), seq);
    if (covered > 0) lanes.set(lane, covered);
  }
  return lanes;
}

export function frontierCovers(frontier: LaneFrontier, lane: string, lastSeq: number): boolean {
  return lastSeq <= (frontier.get(lane) ?? 0);
}

function totalApplied(frontier: LaneFrontier): number {
  let total = 0;
  for (const seq of frontier.values()) total += seq;
  return total;
}

export interface OrderedSnapshot {
  readonly frontier: LaneFrontier;
  readonly committedAt: Hlc;
  readonly snapshotId: string;
}

/**
 * A deterministic linear extension of frontier dominance: a snapshot that
 * strictly dominates another always sorts later. Commit time only breaks ties,
 * so a lagging device's late checkpoint can never outrank a fuller one.
 */
export function compareSnapshotOrder(left: OrderedSnapshot, right: OrderedSnapshot): number {
  return (
    totalApplied(left.frontier) - totalApplied(right.frontier) ||
    compareHlc(left.committedAt, right.committedAt) ||
    compareUtf8Bytewise(left.snapshotId, right.snapshotId)
  );
}
