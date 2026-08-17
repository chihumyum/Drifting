// Act (幕) — a contiguous segment of the GLOBAL reading axis (bookOrder).
//
// Acts are boundary-based, not membership-based: each act stores only where
// it starts on the bookOrder axis (`startOrder`), and a chapter belongs to
// the act with the greatest startOrder <= its bookOrder. Decoupling acts
// from chapter identity is deliberate — dragging a chapter across a boundary
// re-acts it automatically, deleting chapters needs zero bookkeeping, and an
// act can exist EMPTY (planned but unwritten), which a chapter-anchored
// model can't express.
//
// `startOrder` is REAL, not integer: chapter bookOrders are continuous
// authored coordinates, so boundaries must preserve fractional positions.
//
// `startOrder = null` is an optional book-head anchor, not a required opener.
// A head-anchored act may be dragged to a finite coordinate. When every act
// has a finite boundary, chapters before the first boundary belong to no act.
//
// The ONE operation that invalidates raw order boundaries is 打散 (spread),
// which rewrites every chapter's bookOrder. It is also deterministically
// repairable: spread knows the old→new mapping, so each boundary remaps to
// the midpoint of the two chapters that straddled it — see
// remapActBoundariesForSpread.
export interface BookAct {
  id: string;
  projectId: string;
  name: string;
  color: string | null;
  /** Boundary on the bookOrder axis; null = optional book-head anchor. */
  startOrder: number | null;
  /**
   * Optional bound drift node serving as this act's free-form notes / 大纲
   * (mirrors a marker binding a drift — see domain/timeline-marker.ts).
   * "Is bound" is always derived from this column; deleting/converting the
   * drift unbinds via useBookAct.unbindActsForDrift (FKs aren't enforced).
   * A bound drift is hidden from the floating drift panel.
   */
  driftNodeId: string | null;
  createdAt: string;
  updatedAt: string;
}

const utf8Encoder = new TextEncoder();

function compareIdsUtf8Bytewise(left: string, right: string): number {
  const leftBytes = utf8Encoder.encode(left);
  const rightBytes = utf8Encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

/** Drift ids currently bound to an act (its notes). Union with the marker-
 *  bound set for drift-panel filtering + the bind picker's exclusions. */
export function actBoundDriftIds(acts: BookAct[]): Set<string> {
  const ids = new Set<string>();
  for (const a of acts) if (a.driftNodeId) ids.add(a.driftNodeId);
  return ids;
}

/** Sorted for rendering/derivation: an optional head anchor first, then ascending. */
export function sortActs(acts: BookAct[]): BookAct[] {
  return acts.slice().sort((a, b) => {
    const av = a.startOrder ?? Number.NEGATIVE_INFINITY;
    const bv = b.startOrder ?? Number.NEGATIVE_INFINITY;
    const diff = av - bv;
    return diff !== 0 ? diff : compareIdsUtf8Bytewise(a.id, b.id);
  });
}

// Minimal chapter shape the derivation needs — callers pass their own
// view-model node types (TimelineNode, PositionedNode, …) without friction.
export interface ActChapterRef {
  id: string;
  bookOrder: number | null;
}

export interface ActSegment<T extends ActChapterRef = ActChapterRef> {
  act: BookAct;
  /** Effective numeric start (an optional head anchor resolves to -Infinity). */
  startOrder: number;
  /** Exclusive end = next act's startOrder; null/+Infinity for the last act. */
  endOrder: number | null;
  /** Member chapters sorted by bookOrder. Empty acts are legal. */
  chapters: T[];
}

/**
 * Partition chapters into act segments. Membership: bookOrder >= startOrder
 * and < next act's startOrder. Chapters before the first finite boundary are
 * unassigned unless a head-anchored (`startOrder = null`) act exists. Nodes
 * without a bookOrder (drift) are skipped. Returns [] when no acts exist.
 */
export function deriveActSegments<T extends ActChapterRef>(
  acts: BookAct[],
  chapters: T[],
): ActSegment<T>[] {
  if (acts.length === 0) return [];
  const sorted = sortActs(acts);
  const sortedChapters = chapters
    .filter((c) => c.bookOrder != null)
    .sort((a, b) => (a.bookOrder! - b.bookOrder!) || compareIdsUtf8Bytewise(a.id, b.id));

  const segments: ActSegment<T>[] = sorted.map((act, i) => ({
    act,
    startOrder: act.startOrder ?? Number.NEGATIVE_INFINITY,
    endOrder: i + 1 < sorted.length ? (sorted[i + 1].startOrder ?? 0) : null,
    chapters: [],
  }));

  // Start outside every segment. Advancing into segment 0 only when its
  // effective boundary is reached preserves the explicit no-act interval
  // before a finite first boundary.
  let si = -1;
  for (const chapter of sortedChapters) {
    while (
      si + 1 < segments.length &&
      chapter.bookOrder! >= (segments[si + 1].act.startOrder ?? Number.NEGATIVE_INFINITY)
    ) {
      si += 1;
    }
    if (si >= 0) segments[si]!.chapters.push(chapter);
  }
  return segments;
}

/** Which act covers a given bookOrder position; null when no acts exist. */
export function actForOrder(acts: BookAct[], order: number): BookAct | null {
  if (acts.length === 0) return null;
  const sorted = sortActs(acts);
  let match: BookAct | null = null;
  for (const act of sorted) {
    if ((act.startOrder ?? Number.NEGATIVE_INFINITY) <= order) match = act;
    else break;
  }
  return match;
}

export interface ActBoundaryPatch {
  id: string;
  startOrder: number;
}

/**
 * Deterministic boundary repair for 打散 (spread). Spread rewrites every
 * placed chapter's bookOrder; a raw-order boundary would silently land
 * between different chapters. Both spread call sites know the full old→new
 * mapping, so each non-null boundary remaps to the midpoint of the new
 * orders of the two chapters that straddled it before the spread. Boundaries
 * hanging before/after all chapters keep their relative position via a
 * half-stride offset. Returns patches only for boundaries that move.
 */
export function remapActBoundariesForSpread(
  acts: BookAct[],
  oldOrderById: Map<string, number>,
  newOrderById: Map<string, number>,
  stride: number,
): ActBoundaryPatch[] {
  const moved = Array.from(oldOrderById.entries())
    .filter(([id]) => newOrderById.has(id))
    .map(([id, oldOrder]) => ({ id, oldOrder, newOrder: newOrderById.get(id)! }))
    .sort((a, b) => a.oldOrder - b.oldOrder);
  if (moved.length === 0) return [];

  const patches: ActBoundaryPatch[] = [];
  for (const act of acts) {
    if (act.startOrder == null) continue;
    const before = [...moved].reverse().find((m) => m.oldOrder < act.startOrder!);
    const after = moved.find((m) => m.oldOrder >= act.startOrder!);
    let next: number;
    if (before && after) next = (before.newOrder + after.newOrder) / 2;
    else if (after) next = after.newOrder - stride / 2;
    else if (before) next = before.newOrder + stride / 2;
    else continue;
    if (next !== act.startOrder) patches.push({ id: act.id, startOrder: next });
  }
  return patches;
}

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** 1 → 第一幕, 12 → 第十二幕, 21 → 第二十一幕. Falls back to arabic past 99. */
export function defaultActName(n: number): string {
  if (n < 1 || n > 99) return `第${n}幕`;
  if (n < 10) return `第${CN_DIGITS[n]}幕`;
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  const tensPart = tens === 1 ? '十' : `${CN_DIGITS[tens]}十`;
  return `第${tensPart}${ones === 0 ? '' : CN_DIGITS[ones]}幕`;
}
