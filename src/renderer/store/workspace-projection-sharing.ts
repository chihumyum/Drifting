import { indexById } from '../lib/immutable-id-index';
import type { WorkspaceDataProjection } from './data-store';

/** Compare acyclic SQLite domain values. Body JSON stays an opaque string. */
function equalCapturedValue(previous: unknown, next: unknown): boolean {
  if (Object.is(previous, next)) return true;
  if (previous === null || next === null || typeof previous !== 'object' || typeof next !== 'object') return false;
  if (Array.isArray(previous) || Array.isArray(next)) {
    if (!Array.isArray(previous) || !Array.isArray(next) || previous.length !== next.length) return false;
    for (let index = 0; index < previous.length; index++) {
      if (Object.prototype.hasOwnProperty.call(previous, index) !== Object.prototype.hasOwnProperty.call(next, index)
        || !equalCapturedValue(previous[index], next[index])) return false;
    }
    return true;
  }
  const prototype = Object.getPrototypeOf(previous);
  // Unknown domain extensions remain the newly captured value, never silently
  // treated as an empty plain object (e.g. Date, Map, a class instance).
  if ((prototype !== Object.prototype && prototype !== null) || Object.getPrototypeOf(next) !== prototype) return false;
  const previousKeys = Object.keys(previous); const nextKeys = Object.keys(next);
  if (previousKeys.length !== nextKeys.length) return false;
  const a = previous as Record<string, unknown>; const b = next as Record<string, unknown>;
  return previousKeys.every((key, index) => key === nextKeys[index] && equalCapturedValue(a[key], b[key]));
}

/** Reuse rows by ID even when inserted/reordered, while preserving incoming order. */
function shareRows<T extends { id: string }>(previous: T[], next: T[]): T[] {
  if (previous === next) return previous;
  let sameArray = previous.length === next.length;
  const rows = next.map((row, index) => {
    const before = previous[index]?.id === row.id ? previous[index] : indexById(previous).get(row.id);
    const shared = before && equalCapturedValue(before, row) ? before : row;
    if (shared !== previous[index]) sameArray = false;
    return shared;
  });
  return sameArray ? previous : rows;
}

/** Key iteration order is observable when deriving fallback storyline membership. */
export function shareWorkspaceKeyedValues<T>(previous: Record<string, T>, next: Record<string, T>): Record<string, T> {
  if (previous === next) return previous;
  const previousKeys = Object.keys(previous); const nextKeys = Object.keys(next);
  let same = previousKeys.length === nextKeys.length;
  const entries = nextKeys.map((key, index) => {
    const shared = Object.prototype.hasOwnProperty.call(previous, key) && equalCapturedValue(previous[key], next[key]) ? previous[key] : next[key];
    if (key !== previousKeys[index] || shared !== previous[key]) same = false;
    return [key, shared] as const;
  });
  return same ? previous : Object.fromEntries(entries);
}

function shareTrashedIds(previous: Set<string>, next: Set<string>): Set<string> {
  if (previous === next) return previous;
  if (previous.size !== next.size) return next;
  const before = previous.values();
  for (const id of next) if (before.next().value !== id) return next;
  return previous;
}

/**
 * Called only after the project/epoch guard accepts a complete capture.
 * No cached author state, JSON parsing, SQLite reads or asynchronous work.
 * Comparing all captured fields also covers derived updates with unchanged timestamps.
 */
export function shareWorkspaceProjection(previous: WorkspaceDataProjection, next: WorkspaceDataProjection): WorkspaceDataProjection {
  return {
    storylines: shareRows(previous.storylines, next.storylines),
    storylineNodeMapping: shareWorkspaceKeyedValues(previous.storylineNodeMapping, next.storylineNodeMapping),
    primaryStorylineByNode: shareWorkspaceKeyedValues(previous.primaryStorylineByNode, next.primaryStorylineByNode),
    bookNodes: shareRows(previous.bookNodes, next.bookNodes),
    bookElementCategories: shareRows(previous.bookElementCategories, next.bookElementCategories),
    bookElements: shareRows(previous.bookElements, next.bookElements),
    projectAssets: shareRows(previous.projectAssets, next.projectAssets),
    trashedEntityIds: shareTrashedIds(previous.trashedEntityIds, next.trashedEntityIds),
    libraryItems: shareRows(previous.libraryItems, next.libraryItems),
    comments: shareRows(previous.comments, next.comments),
    commentActions: shareRows(previous.commentActions, next.commentActions),
    entityRelations: shareRows(previous.entityRelations, next.entityRelations),
    entityRelationTypes: shareRows(previous.entityRelationTypes, next.entityRelationTypes),
    blockSections: shareRows(previous.blockSections, next.blockSections),
    bookActs: shareRows(previous.bookActs, next.bookActs),
    driftGroups: shareRows(previous.driftGroups, next.driftGroups),
    timelineMarkers: shareRows(previous.timelineMarkers, next.timelineMarkers),
  };
}
