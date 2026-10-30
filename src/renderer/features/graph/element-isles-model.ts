// 要素全景 on the desktop is a set of category islands
// (docs/design-system/components.md, 要素全景). Elements sit on their
// category's island; lines between them come from the prose — two elements
// mentioned in the same paragraph of a chapter — and from the relations the
// author draws. Seen from far the islands are a star map of sand marks, from
// the middle distance each mark has its name, close up each is a card.

export type IslesLod = 'far' | 'mid' | 'near';

/** The zoom each distance in the header's 远 / 中 / 近 switch takes you to. */
export const ISLES_LOD_ZOOM: Readonly<Record<IslesLod, number>> = { far: 0.5, mid: 0.9, near: 1.5 };

export function islesLod(zoom: number): IslesLod {
  return zoom < 0.65 ? 'far' : zoom < 1.25 ? 'mid' : 'near';
}

/** Two elements mentioned together, and in how many paragraphs. */
export interface IslePair {
  key: string;
  a: string;
  b: string;
  count: number;
}

export function isleKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** The pairs drawn at `threshold` paragraphs or more, between elements still on the canvas. */
export function islePairs(
  pairs: ReadonlyMap<string, number>,
  threshold: number,
  present: ReadonlySet<string>,
): IslePair[] {
  const out: IslePair[] = [];
  for (const [key, count] of pairs) {
    if (count < threshold) continue;
    const split = key.indexOf('|');
    const a = key.slice(0, split);
    const b = key.slice(split + 1);
    if (a === b || !present.has(a) || !present.has(b)) continue;
    out.push({ key, a, b, count });
  }
  return out;
}

/** An element's neighbours: what it shares a drawn line with, itself included. */
export function isleNeighbours(
  id: string,
  pairs: readonly IslePair[],
  relations: readonly { a: string; b: string }[],
): Set<string> {
  const set = new Set([id]);
  for (const pair of pairs) {
    if (pair.a === id) set.add(pair.b);
    else if (pair.b === id) set.add(pair.a);
  }
  for (const relation of relations) {
    if (relation.a === id) set.add(relation.b);
    else if (relation.b === id) set.add(relation.a);
  }
  return set;
}

/** Who an element is mentioned with most often, most first. */
export function isleCompanions(
  id: string,
  pairs: ReadonlyMap<string, number>,
  limit: number,
): { id: string; count: number }[] {
  const out: { id: string; count: number }[] = [];
  for (const [key, count] of pairs) {
    const split = key.indexOf('|');
    const a = key.slice(0, split);
    const b = key.slice(split + 1);
    if (a === id) out.push({ id: b, count });
    else if (b === id) out.push({ id: a, count });
  }
  out.sort((x, y) => y.count - x.count || x.id.localeCompare(y.id));
  return out.slice(0, limit);
}

/**
 * How large an element's sand mark is from far away, 0 to 1: by its
 * mentions against the most-mentioned element, on a square-root scale so a
 * few protagonists don't shrink everyone else to dust.
 */
export function isleMarkWeight(mentions: number, most: number): number {
  if (mentions <= 0 || most <= 0) return 0;
  return Math.min(1, Math.sqrt(mentions / most));
}

/** One chapter on an element's appearance strip, in book order. */
export interface IsleTick {
  chapterId: string;
  /** 1-based position in book order (§01, §02…). */
  number: number;
  title: string;
  count: number;
  color: string | null;
}

export function isleTicks(
  chapters: readonly { id: string; title: string; color: string | null }[],
  byChapter: ReadonlyMap<string, number> | undefined,
): IsleTick[] {
  return chapters.map((chapter, index) => ({
    chapterId: chapter.id,
    number: index + 1,
    title: chapter.title,
    count: byChapter?.get(chapter.id) ?? 0,
    color: chapter.color,
  }));
}

export interface IsleAppearance {
  appeared: number;
  total: number;
  /** §number of the first and last chapters it appears in; null when it never does. */
  first: number | null;
  last: number | null;
  /** The most chapters in a row it is absent for, between its first and last. */
  longestGap: number;
}

export function isleAppearance(ticks: readonly IsleTick[]): IsleAppearance {
  const seen = ticks.filter((tick) => tick.count > 0).map((tick) => tick.number);
  let longestGap = 0;
  for (let i = 1; i < seen.length; i += 1) longestGap = Math.max(longestGap, seen[i] - seen[i - 1] - 1);
  return {
    appeared: seen.length,
    total: ticks.length,
    first: seen.length ? seen[0] : null,
    last: seen.length ? seen[seen.length - 1] : null,
    longestGap,
  };
}

/** `§07`: a chapter by its place in the book. */
export function isleSection(number: number): string {
  return `§${String(number).padStart(2, '0')}`;
}
