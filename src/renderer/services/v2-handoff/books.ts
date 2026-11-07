// Per-book preferences that live only in WebView storage, read out of each
// store's own persisted format into the stamp's `books` section
// (docs/v2-handoff.md). The raw values still travel in `settings.entries`;
// an importer that finds no `books` (a stamp from before this section) falls
// back to them. WebView storage is app-wide and account libraries share it,
// so only books in this library's `project` table are written.

import { parseRelateRecord, relateStorageKey } from '../../features/graph/element-relate-layout';
import {
  migrateWritingStatsState,
  WRITING_STATS_STORAGE_VERSION,
  type WritingStatsState,
} from '../../store/writing-stats-store';

export interface V2HandoffBook {
  /** The book's word target; 0 means the author turned it off. */
  wordTarget?: number;
  /** Words per day; 0 means the author turned it off. */
  dailyWordTarget?: number;
  /** Line color by relation type id. */
  relationTypeColors?: Record<string, string>;
  /** Elements the author dragged in the 关系 layout, by element id, world px. */
  elementPins?: Record<string, [number, number]>;
}

/** `name` of the persisted writing-stats store (store/writing-stats-store.ts). */
export const WRITING_STATS_STORAGE_KEY = 'writing-stats-storage';
/** Key prefix and payload version of hooks/useEdgeKindMeta.ts. */
const EDGE_KIND_META_PREFIX = 'drifting:edge-kind-meta:';
const EDGE_KIND_META_VERSION = 2;

type WritingPlans = WritingStatsState['plans'];

const isTarget = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isPoint = (value: unknown): value is [number, number] =>
  Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number' && Number.isFinite(n));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The writing plans exactly as the store hydrates them: a stored payload of
 * another version runs the store's own migration, and a payload that cannot
 * be read or migrated hydrates no plans. `history` is a rebuildable cache and
 * is not copied.
 */
export function parseWritingPlans(raw: string | null): WritingPlans {
  if (!raw) return {};
  try {
    const stored = JSON.parse(raw) as { state?: unknown; version?: unknown } | null;
    if (!isRecord(stored) || !isRecord(stored.state)) return {};
    const state = typeof stored.version === 'number' && stored.version !== WRITING_STATS_STORAGE_VERSION
      ? migrateWritingStatsState(stored.state as unknown as WritingStatsState, stored.version)
      : stored.state;
    return isRecord(state) && isRecord(state.plans) ? (state.plans as WritingPlans) : {};
  } catch {
    return {};
  }
}

/**
 * Relation-type colors as `useEdgeKindMeta` reads them (the hook keeps its
 * parser private): only a version-2 payload counts, anything else is no
 * colors.
 */
export function parseRelationTypeColors(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as { v?: unknown; byRelationTypeId?: unknown } | null;
    if (!isRecord(parsed) || parsed.v !== EDGE_KIND_META_VERSION || !isRecord(parsed.byRelationTypeId)) return {};
    const colors: Record<string, string> = {};
    for (const [relationTypeId, entry] of Object.entries(parsed.byRelationTypeId)) {
      const color = isRecord(entry) ? entry.color : undefined;
      if (typeof color === 'string' && color) colors[relationTypeId] = color;
    }
    return colors;
  } catch {
    return {};
  }
}

/** The pins of the 关系 layout; computed positions and the layout mode are not the author's. */
export function parseElementPins(raw: string | null): Record<string, [number, number]> {
  const pins: Record<string, [number, number]> = {};
  for (const [elementId, point] of parseRelateRecord(raw).pins) pins[elementId] = [point.x, point.y];
  return pins;
}

const sorted = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));

/** One book's section with every empty part left out, or null when nothing is left. */
export function normalizeV2HandoffBook(value: unknown): V2HandoffBook | null {
  if (!isRecord(value)) return null;
  const book: V2HandoffBook = {};
  if (isTarget(value.wordTarget)) book.wordTarget = value.wordTarget;
  if (isTarget(value.dailyWordTarget)) book.dailyWordTarget = value.dailyWordTarget;
  if (isRecord(value.relationTypeColors)) {
    const colors = Object.entries(value.relationTypeColors)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '');
    if (colors.length) book.relationTypeColors = sorted(Object.fromEntries(colors));
  }
  if (isRecord(value.elementPins)) {
    const pins = Object.entries(value.elementPins)
      .filter((entry): entry is [string, [number, number]] => isPoint(entry[1]))
      .map(([id, [x, y]]): [string, [number, number]] => [id, [x, y]]);
    if (pins.length) book.elementPins = sorted(Object.fromEntries(pins));
  }
  return Object.keys(book).length ? book : null;
}

/** The books of `projectIds` that have something to say, by project id. */
export function normalizeV2HandoffBooks(
  value: unknown,
  projectIds: readonly string[],
): Record<string, V2HandoffBook> {
  const books: Record<string, V2HandoffBook> = {};
  if (!isRecord(value)) return books;
  for (const projectId of [...new Set(projectIds)].sort()) {
    const book = normalizeV2HandoffBook(value[projectId]);
    if (book) books[projectId] = book;
  }
  return books;
}

/**
 * Each book's writing plan, relation-type colors and element pins, read from
 * `storage`, or null when storage is unavailable.
 */
export function captureV2HandoffBooks(
  projectIds: readonly string[],
  storage: Storage | null | undefined = globalThis.localStorage,
): Record<string, V2HandoffBook> | null {
  if (!storage) return null;
  try {
    const plans = parseWritingPlans(storage.getItem(WRITING_STATS_STORAGE_KEY));
    const raw: Record<string, unknown> = {};
    for (const projectId of projectIds) {
      const plan = Object.prototype.hasOwnProperty.call(plans, projectId) ? plans[projectId] : undefined;
      raw[projectId] = {
        wordTarget: plan?.projectWordTarget,
        dailyWordTarget: plan?.dailyWordGoal,
        relationTypeColors: parseRelationTypeColors(storage.getItem(`${EDGE_KIND_META_PREFIX}${projectId}`)),
        elementPins: parseElementPins(storage.getItem(relateStorageKey(projectId))),
      };
    }
    return normalizeV2HandoffBooks(raw, projectIds);
  } catch {
    return null;
  }
}
