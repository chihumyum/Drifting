export interface OutlineEntry {
  id: string;
  level: 1 | 2 | 3;
  /**
   * Structural role in the five-level outline:
   * act / chapter / scene(h1) / beat(h2) / note(h3).
   */
  kind?: 'act' | 'chapter' | 'section' | 'heading';
  text: string;
  num?: string;
  children?: OutlineEntry[];
}

export interface FlatOutlineEntry {
  id: string;
  item: OutlineEntry;
  order: number;
  depth: number;
  rootId: string;
  ancestorIds: string[];
}

export interface OutlineRailEntryLabel {
  type: 'entry';
  key: string;
  entry: FlatOutlineEntry;
  preferredFraction: number;
}

export interface OutlineRailOmissionLabel {
  type: 'omission';
  key: string;
  side: 'before' | 'after';
  entries: FlatOutlineEntry[];
  preferredFraction: number;
}

export type OutlineRailLabel = OutlineRailEntryLabel | OutlineRailOmissionLabel;

export interface OutlineRailPlan {
  mode: 'all' | 'active-branch' | 'windowed';
  labels: OutlineRailLabel[];
  capacity: number;
  activeRootId: string | null;
}

export interface LaidOutOutlineRailLabel {
  label: OutlineRailLabel;
  y: number;
}

export interface OutlineVisibleLabelRange {
  firstY: number;
  /** Position of the first rendered label after the selected interval. */
  nextY: number | null;
  count: number;
}

export const OUTLINE_RAIL_LABEL_PITCH = 17;
const OUTLINE_RAIL_VERTICAL_INSET = 9;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Fold a flat h1/h2/h3 list into the scene/beat/note hierarchy. */
export function nestHeadings(
  headings: { id: string; level: 1 | 2 | 3; text: string }[],
): OutlineEntry[] {
  const roots: OutlineEntry[] = [];
  const stack: OutlineEntry[] = [];
  for (const heading of headings) {
    const entry: OutlineEntry = {
      id: heading.id,
      level: heading.level,
      kind: 'heading',
      text: heading.text,
    };
    while (stack.length && stack[stack.length - 1].level >= heading.level) stack.pop();
    if (stack.length === 0) roots.push(entry);
    else (stack[stack.length - 1].children ??= []).push(entry);
    stack.push(entry);
  }
  return roots;
}

/** Pre-order flattening preserves the same order as anchors in the manuscript. */
export function flattenOutlineEntries(items: OutlineEntry[]): FlatOutlineEntry[] {
  const flat: FlatOutlineEntry[] = [];
  const visit = (
    item: OutlineEntry,
    depth: number,
    rootId: string,
    ancestorIds: string[],
  ) => {
    flat.push({
      id: item.id,
      item,
      order: flat.length,
      depth,
      rootId,
      ancestorIds,
    });
    for (const child of item.children ?? []) {
      visit(child, depth + 1, rootId, [...ancestorIds, item.id]);
    }
  };

  for (const item of items) visit(item, 0, item.id, []);
  return flat;
}

export function outlineActivePathIds(
  flat: FlatOutlineEntry[],
  activeId: string | null | undefined,
): Set<string> {
  const path = new Set<string>();
  if (!activeId) return path;
  const active = flat.find((entry) => entry.id === activeId);
  if (!active) return path;
  active.ancestorIds.forEach((id) => path.add(id));
  path.add(active.id);
  return path;
}

function entryFraction(
  entry: FlatOutlineEntry,
  total: number,
  fractions: Readonly<Record<string, number>>,
): number {
  const measured = fractions[entry.id];
  if (Number.isFinite(measured)) return clamp01(measured);
  if (total <= 1) return 0;
  return entry.order / (total - 1);
}

function entryLabels(
  entries: FlatOutlineEntry[],
  total: number,
  fractions: Readonly<Record<string, number>>,
): OutlineRailEntryLabel[] {
  return entries.map((entry) => ({
    type: 'entry',
    key: entry.id,
    entry,
    preferredFraction: entryFraction(entry, total, fractions),
  }));
}

function centeredWindow(total: number, activeIndex: number, size: number) {
  const boundedSize = Math.min(total, Math.max(1, size));
  let start = Math.max(0, activeIndex - Math.floor(boundedSize / 2));
  const end = Math.min(total, start + boundedSize);
  start = Math.max(0, end - boundedSize);
  return { start, end };
}

/**
 * Progressive density policy:
 * 1. show every outline row while it fits;
 * 2. keep every root row but only the active root's descendants;
 * 3. keep a document-order window around the active row and replace the two
 *    distant ranges with hoverable omission markers.
 */
export function planOutlineRail(
  flat: FlatOutlineEntry[],
  activeId: string | null | undefined,
  railHeight: number,
  fractions: Readonly<Record<string, number>> = {},
): OutlineRailPlan {
  const capacity =
    railHeight > 0
      ? Math.max(
          5,
          Math.floor(
            Math.max(0, railHeight - OUTLINE_RAIL_VERTICAL_INSET * 2) /
              OUTLINE_RAIL_LABEL_PITCH,
          ),
        )
      : Number.POSITIVE_INFINITY;
  const active = flat.find((entry) => entry.id === activeId) ?? flat[0] ?? null;
  const activeRootId = active?.rootId ?? null;

  if (flat.length <= capacity) {
    return {
      mode: 'all',
      labels: entryLabels(flat, flat.length, fractions),
      capacity,
      activeRootId,
    };
  }

  const activeBranch = flat.filter(
    (entry) => entry.depth === 0 || (activeRootId != null && entry.rootId === activeRootId),
  );
  if (activeBranch.length <= capacity) {
    return {
      mode: 'active-branch',
      labels: entryLabels(activeBranch, flat.length, fractions),
      capacity,
      activeRootId,
    };
  }

  const activeBranchIndex = Math.max(
    0,
    activeBranch.findIndex((entry) => entry.id === active?.id),
  );
  // Reserve two slots first. If the final window touches one edge, reclaim the
  // unused omission slot so ordinary first/last chapters get one more label.
  let window = centeredWindow(
    activeBranch.length,
    activeBranchIndex,
    Math.max(1, capacity - 2),
  );
  const omissionCount =
    Number(window.start > 0) + Number(window.end < activeBranch.length);
  window = centeredWindow(
    activeBranch.length,
    activeBranchIndex,
    Math.max(1, capacity - omissionCount),
  );

  const before = activeBranch.slice(0, window.start);
  const visible = activeBranch.slice(window.start, window.end);
  const after = activeBranch.slice(window.end);
  const labels: OutlineRailLabel[] = [];

  if (before.length > 0) {
    const boundary = before[before.length - 1];
    labels.push({
      type: 'omission',
      key: `omission:before:${boundary.id}`,
      side: 'before',
      entries: before,
      preferredFraction: entryFraction(boundary, flat.length, fractions),
    });
  }
  labels.push(...entryLabels(visible, flat.length, fractions));
  if (after.length > 0) {
    const boundary = after[0];
    labels.push({
      type: 'omission',
      key: `omission:after:${boundary.id}`,
      side: 'after',
      entries: after,
      preferredFraction: entryFraction(boundary, flat.length, fractions),
    });
  }

  return { mode: 'windowed', labels, capacity, activeRootId };
}

/**
 * Keep labels attached to their measured document positions whenever possible;
 * only spread neighbours when their glyph boxes would collide.
 */
export function layoutOutlineRailLabels(
  labels: OutlineRailLabel[],
  railHeight: number,
  minGap = OUTLINE_RAIL_LABEL_PITCH,
): LaidOutOutlineRailLabel[] {
  if (labels.length === 0 || railHeight <= 0) return [];
  const minY = OUTLINE_RAIL_VERTICAL_INSET;
  const maxY = Math.max(minY, railHeight - OUTLINE_RAIL_VERTICAL_INSET);
  const y = labels.map((label) => minY + clamp01(label.preferredFraction) * (maxY - minY));

  y[0] = Math.max(minY, y[0]);
  for (let index = 1; index < y.length; index += 1) {
    y[index] = Math.max(y[index], y[index - 1] + minGap);
  }

  if (y[y.length - 1] > maxY) {
    y[y.length - 1] = maxY;
    for (let index = y.length - 2; index >= 0; index -= 1) {
      y[index] = Math.min(y[index], y[index + 1] - minGap);
    }
  }

  if (y[0] < minY) {
    y[0] = minY;
    for (let index = 1; index < y.length; index += 1) {
      y[index] = Math.max(y[index], y[index - 1] + minGap);
    }
  }

  return labels.map((label, index) => ({ label, y: y[index] }));
}

/**
 * Stepwise semantic range for the outer rail layer. A selected TOC item owns
 * the rail interval up to (but not including) the next rendered label, rather
 * than only the few pixels around its own centre.
 */
export function outlineVisibleLabelRange(
  laidOut: LaidOutOutlineRailLabel[],
  ids: ReadonlySet<string>,
): OutlineVisibleLabelRange | null {
  const selectedIndexes = laidOut.flatMap((item, index) =>
    item.label.type === 'entry' && ids.has(item.label.entry.id) ? [index] : [],
  );
  if (selectedIndexes.length === 0) return null;
  const firstIndex = selectedIndexes[0];
  const lastIndex = selectedIndexes[selectedIndexes.length - 1];
  return {
    firstY: laidOut[firstIndex].y,
    nextY: laidOut[lastIndex + 1]?.y ?? null,
    count: selectedIndexes.length,
  };
}

/** Sequential section ranges intersecting the current editor viewport. */
export function visibleOutlineIds(
  flat: FlatOutlineEntry[],
  offsets: Readonly<Record<string, number>>,
  viewportTop: number,
  viewportBottom: number,
  contentHeight: number,
): Set<string> {
  const measured = flat
    .map((entry) => ({ entry, top: offsets[entry.id] }))
    .filter((item): item is { entry: FlatOutlineEntry; top: number } => Number.isFinite(item.top))
    .sort((a, b) => a.top - b.top || a.entry.order - b.entry.order);
  const visible = new Set<string>();

  measured.forEach((item, index) => {
    const nextTop = measured[index + 1]?.top ?? contentHeight;
    if (nextTop > viewportTop && item.top < viewportBottom) {
      visible.add(item.entry.id);
      item.entry.ancestorIds.forEach((id) => visible.add(id));
    }
  });
  return visible;
}
