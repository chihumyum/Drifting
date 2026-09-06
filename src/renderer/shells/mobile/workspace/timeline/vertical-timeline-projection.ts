/**
 * Vertical timeline entry projection.
 *
 * The track dots are the coordinate authority: every dot sits at exactly
 * orderToPosition(order). The entries on the right are only a PROJECTION of
 * those dots — they never own a coordinate, never accept a gesture, and
 * re-layout whenever a dot moves or the scale changes. This module is pure so
 * the layout rules can be tested without a DOM:
 *
 *   • an entry's detail level follows the free space below its dot
 *     (large ≥ 120px shows a summary, medium ≥ 64px title + meta, small ≥ 36px
 *     one title line, minimal = 24px);
 *   • entries never overlap — an entry that does not fit slides down and a
 *     hairline leader connects it back to its dot (every entry carries one so
 *     dot ↔ entry ownership is never ambiguous);
 *   • when three or more consecutive chapters pile up under one dot the run
 *     collapses into a single cluster entry with a bracket over its dots;
 *   • act boundaries and time markers project as 22px chips that take part in
 *     the packing but never cluster.
 */
export type VerticalTimelineItemKind = 'chapter' | 'act' | 'marker';

export interface VerticalTimelineItem {
  readonly id: string;
  readonly kind: VerticalTimelineItemKind;
  /** Track-space y in px (orderToPosition + top padding). */
  readonly y: number;
}

export type VerticalTimelineLevel = 'L' | 'M' | 'S' | 'X';

export const VERTICAL_TIMELINE_LEVELS: Record<VerticalTimelineLevel, { minGap: number; height: number }> =
  {
    L: { minGap: 120, height: 110 },
    M: { minGap: 64, height: 62 },
    S: { minGap: 36, height: 36 },
    X: { minGap: 0, height: 24 },
  };

export const VERTICAL_TIMELINE_CHIP_HEIGHT = 22;
export const VERTICAL_TIMELINE_CLUSTER_HEIGHT = 48;
export const VERTICAL_TIMELINE_ENTRY_GAP = 2;
/** A chapter entry's number line sits this far below its top edge; it aligns with the dot. */
export const VERTICAL_TIMELINE_ENTRY_ANCHOR = 12;
export const VERTICAL_TIMELINE_CHIP_ANCHOR = VERTICAL_TIMELINE_CHIP_HEIGHT / 2;
/** Consecutive displaced chapters (plus the one they piled under) that form a cluster. */
export const VERTICAL_TIMELINE_CLUSTER_RUN = 3;

export interface VerticalTimelineLeader {
  /** The dot (or the cluster's first dot). */
  readonly fromY: number;
  /** The entry's anchor line. */
  readonly toY: number;
}

export interface VerticalTimelineEntry {
  readonly kind: VerticalTimelineItemKind | 'cluster';
  /** The item id, or the cluster's first member id. */
  readonly id: string;
  /** Members in axis order (one for plain items). */
  readonly ids: readonly string[];
  readonly level: VerticalTimelineLevel | null;
  readonly top: number;
  readonly height: number;
  /** Track y of the owning dot (first dot for a cluster). */
  readonly y: number;
  /** How far the entry slid below its preferred spot. */
  readonly displaced: number;
  readonly leader: VerticalTimelineLeader;
  /** Cluster only: the dots it stands for. */
  readonly bracket?: { readonly fromY: number; readonly toY: number };
}

export interface VerticalTimelineProjectionOptions {
  /** Entries never start above this y (the list's top padding). */
  readonly minTop?: number;
}

interface PackItem {
  readonly kind: VerticalTimelineItemKind | 'cluster';
  readonly id: string;
  readonly ids: readonly string[];
  readonly y: number;
  readonly lastY: number;
}

function sortItems<T extends { id: string; y: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.y === b.y ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.y - b.y));
}

function levelForGap(gap: number): VerticalTimelineLevel {
  if (gap >= VERTICAL_TIMELINE_LEVELS.L.minGap) return 'L';
  if (gap >= VERTICAL_TIMELINE_LEVELS.M.minGap) return 'M';
  if (gap >= VERTICAL_TIMELINE_LEVELS.S.minGap) return 'S';
  return 'X';
}

function pack(items: readonly PackItem[], minTop: number): VerticalTimelineEntry[] {
  const entries: VerticalTimelineEntry[] = [];
  let cursor = minTop;
  items.forEach((item, index) => {
    const next = items[index + 1];
    const gap = next ? next.y - item.y : Number.POSITIVE_INFINITY;
    let level: VerticalTimelineLevel | null = null;
    let height: number;
    let anchor: number;
    if (item.kind === 'chapter') {
      level = levelForGap(gap);
      height = VERTICAL_TIMELINE_LEVELS[level].height;
      anchor = VERTICAL_TIMELINE_ENTRY_ANCHOR;
    } else if (item.kind === 'cluster') {
      height = VERTICAL_TIMELINE_CLUSTER_HEIGHT;
      anchor = 0;
    } else {
      height = VERTICAL_TIMELINE_CHIP_HEIGHT;
      anchor = VERTICAL_TIMELINE_CHIP_ANCHOR;
    }
    const desiredTop = Math.max(minTop, item.y - anchor);
    const top = Math.max(desiredTop, cursor);
    const displaced = top - desiredTop;
    cursor = top + height + VERTICAL_TIMELINE_ENTRY_GAP;
    entries.push({
      kind: item.kind,
      id: item.id,
      ids: item.ids,
      level,
      top,
      height,
      y: item.y,
      displaced,
      leader: { fromY: item.y, toY: top + anchor },
      ...(item.kind === 'cluster' ? { bracket: { fromY: item.y, toY: item.lastY } } : {}),
    });
  });
  return entries;
}

/**
 * Find maximal runs of chapters that slid below their dots, extend each run
 * to the chapter it piled under, and collapse runs of ≥ CLUSTER_RUN members.
 * Returns null when nothing changed.
 */
function clusterCrowdedRuns(
  items: readonly PackItem[],
  entries: readonly VerticalTimelineEntry[],
): PackItem[] | null {
  const merged: PackItem[] = [];
  let changed = false;
  let index = 0;
  while (index < items.length) {
    const item = items[index]!;
    const entry = entries[index]!;
    if (item.kind !== 'chapter' || entry.displaced > 0) {
      merged.push(item);
      index += 1;
      continue;
    }
    // A non-displaced chapter: does a displaced run follow it directly?
    let end = index + 1;
    while (
      end < items.length &&
      items[end]!.kind === 'chapter' &&
      entries[end]!.displaced > 0
    ) {
      end += 1;
    }
    const run = items.slice(index, end);
    if (run.length >= VERTICAL_TIMELINE_CLUSTER_RUN) {
      const ids = run.flatMap((member) => member.ids);
      merged.push({
        kind: 'cluster',
        id: run[0]!.id,
        ids,
        y: run[0]!.y,
        lastY: run[run.length - 1]!.lastY,
      });
      changed = true;
    } else {
      merged.push(...run);
    }
    index = end;
  }
  return changed ? merged : null;
}

export function projectVerticalTimeline(
  items: readonly VerticalTimelineItem[],
  options: VerticalTimelineProjectionOptions = {},
): VerticalTimelineEntry[] {
  const minTop = options.minTop ?? 0;
  let packItems: PackItem[] = sortItems(items).map((item) => ({
    kind: item.kind,
    id: item.id,
    ids: [item.id],
    y: item.y,
    lastY: item.y,
  }));
  let entries = pack(packItems, minTop);
  // Clustering frees space that can un-displace later entries, which can in
  // turn dissolve or form runs; a couple of passes always settle.
  for (let pass = 0; pass < 4; pass += 1) {
    const merged = clusterCrowdedRuns(packItems, entries);
    if (!merged) break;
    packItems = merged;
    entries = pack(packItems, minTop);
  }
  return entries;
}

/** Total content height the projected entries need (for the scroll extent). */
export function verticalTimelineContentHeight(entries: readonly VerticalTimelineEntry[]): number {
  return entries.reduce((max, entry) => Math.max(max, entry.top + entry.height), 0);
}
