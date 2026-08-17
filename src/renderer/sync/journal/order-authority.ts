import {
  generateKeyBetween,
  generateNKeysBetween,
} from 'fractional-indexing';

import { compareUtf8Bytewise } from '../protocol';
import type { SyncChangeBuilder } from './change-builder';

export const AUTHORED_ORDER_LIST_KINDS = [
  'storyline',
  'drift-group',
  'element-patch',
  'library-item',
] as const;

export type AuthoredOrderListKind = (typeof AUTHORED_ORDER_LIST_KINDS)[number];

export interface AuthoredOrderEntry {
  readonly entityId: string;
  readonly positionKey: string;
}

export interface AuthoredOrderRebalanceEntry {
  readonly entityId: string;
  readonly positionKey: string;
}

export type AuthoredOrderMutationPlan =
  | { readonly kind: 'moves'; readonly entries: readonly AuthoredOrderRebalanceEntry[] }
  | { readonly kind: 'rebalance'; readonly entries: readonly AuthoredOrderRebalanceEntry[] };

/**
 * Sync v1 uses Rocicorp fractional-indexing keys as its only discrete-order
 * authority. Keys are ASCII and therefore compare identically under UTF-8
 * byte order and JavaScript's ordinary lexical order. Numeric SQLite columns
 * are projections and must never be encoded back into a wire key.
 */
export function assertFractionalPositionKey(positionKey: string): string {
  if (!/^[0-9A-Za-z]+$/u.test(positionKey)) {
    throw new TypeError('position key must be a non-empty ASCII fractional-indexing key');
  }
  try {
    // The package parser runs before it allocates the successor. This rejects
    // strings that merely look ASCII (invalid heads, truncated integer parts,
    // and forbidden trailing-zero fractional parts).
    generateKeyBetween(positionKey, null);
  } catch (error) {
    throw new TypeError(
      `invalid fractional-indexing position key: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return positionKey;
}

export function compareAuthoredOrderEntries(
  left: AuthoredOrderEntry,
  right: AuthoredOrderEntry,
): number {
  return (
    compareUtf8Bytewise(left.positionKey, right.positionKey) ||
    compareUtf8Bytewise(left.entityId, right.entityId)
  );
}

/** Convert a local numeric UI placement request into relative entity intent. */
export function entityIdsByNumericPlacement(
  entries: readonly { readonly entityId: string; readonly projection: number }[],
): readonly string[] {
  for (const entry of entries) {
    if (!Number.isFinite(entry.projection)) {
      throw new TypeError(`order projection for ${entry.entityId} must be finite`);
    }
  }
  return [...entries]
    .sort(
      (left, right) =>
        left.projection - right.projection ||
        compareUtf8Bytewise(left.entityId, right.entityId),
    )
    .map(({ entityId }) => entityId);
}

export function fractionalPositionKeyBetween(
  left: string | null,
  right: string | null,
): string {
  if (left !== null) assertFractionalPositionKey(left);
  if (right !== null) assertFractionalPositionKey(right);
  if (left !== null && right !== null && compareUtf8Bytewise(left, right) >= 0) {
    throw new Error('fractional position bounds are not strictly ordered; rebalance is required');
  }
  return assertFractionalPositionKey(generateKeyBetween(left, right));
}

export function fractionalPositionKeysBetween(
  left: string | null,
  right: string | null,
  count: number,
): readonly string[] {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError('fractional position count must be a non-negative safe integer');
  }
  if (left !== null) assertFractionalPositionKey(left);
  if (right !== null) assertFractionalPositionKey(right);
  if (left !== null && right !== null && compareUtf8Bytewise(left, right) >= 0) {
    throw new Error('fractional position bounds are not strictly ordered; rebalance is required');
  }
  return generateNKeysBetween(left, right, count).map(assertFractionalPositionKey);
}

/**
 * Allocate one key from the nearest surviving authority neighbours in the
 * requested entity order. The desired order describes user intent only; the
 * current authority supplies both wire bounds.
 */
export function fractionalPositionKeyForEntity(
  current: readonly AuthoredOrderEntry[],
  desiredEntityIds: readonly string[],
  entityId: string,
): string {
  const desiredIndex = desiredEntityIds.indexOf(entityId);
  if (desiredIndex < 0) throw new Error(`ordered entity ${entityId} is absent from desired order`);
  if (new Set(desiredEntityIds).size !== desiredEntityIds.length) {
    throw new Error('desired order contains duplicate entity IDs');
  }
  const currentById = new Map(
    current
      .filter((entry) => entry.entityId !== entityId)
      .map((entry) => [entry.entityId, assertFractionalPositionKey(entry.positionKey)] as const),
  );
  let left: string | null = null;
  let right: string | null = null;
  for (let index = desiredIndex - 1; index >= 0; index -= 1) {
    const candidate = currentById.get(desiredEntityIds[index]!);
    if (candidate !== undefined) {
      left = candidate;
      break;
    }
  }
  for (let index = desiredIndex + 1; index < desiredEntityIds.length; index += 1) {
    const candidate = currentById.get(desiredEntityIds[index]!);
    if (candidate !== undefined) {
      right = candidate;
      break;
    }
  }
  return fractionalPositionKeyBetween(left, right);
}

/** Build one explicit, atomic rebalance for a complete ordered scope. */
export function authoredOrderRebalanceEntries(
  orderedEntityIds: readonly string[],
  bounds: { readonly left?: string | null; readonly right?: string | null } = {},
): readonly AuthoredOrderRebalanceEntry[] {
  if (orderedEntityIds.length === 0) return [];
  if (new Set(orderedEntityIds).size !== orderedEntityIds.length) {
    throw new Error('rebalance contains duplicate entity IDs');
  }
  const keys = fractionalPositionKeysBetween(
    bounds.left ?? null,
    bounds.right ?? null,
    orderedEntityIds.length,
  );
  return orderedEntityIds.map((entityId, index) => ({
    entityId,
    positionKey: keys[index]!,
  }));
}

/**
 * Plan a projection replacement without ever manufacturing keys from array
 * indexes. Pure insertions receive keys inside their surviving neighbour gap;
 * a true reorder becomes one explicit atomic order.rebalance mutation.
 */
export function planAuthoredOrderMutation(
  currentInput: readonly AuthoredOrderEntry[],
  desiredEntityIds: readonly string[],
): AuthoredOrderMutationPlan {
  if (new Set(desiredEntityIds).size !== desiredEntityIds.length) {
    throw new Error('desired order contains duplicate entity IDs');
  }
  const desired = new Set(desiredEntityIds);
  const current = currentInput
    .map((entry) => ({
      ...entry,
      positionKey: assertFractionalPositionKey(entry.positionKey),
    }))
    .filter((entry) => desired.has(entry.entityId))
    .sort(compareAuthoredOrderEntries);
  const currentById = new Map(current.map((entry) => [entry.entityId, entry.positionKey] as const));
  const desiredSurvivors = desiredEntityIds.filter((id) => currentById.has(id));
  if (desiredSurvivors.some((id, index) => id !== current[index]?.entityId)) {
    return { kind: 'rebalance', entries: authoredOrderRebalanceEntries(desiredEntityIds) };
  }

  const entries: AuthoredOrderRebalanceEntry[] = [];
  let cursor = 0;
  while (cursor < desiredEntityIds.length) {
    if (currentById.has(desiredEntityIds[cursor]!)) {
      cursor += 1;
      continue;
    }
    const start = cursor;
    while (cursor < desiredEntityIds.length && !currentById.has(desiredEntityIds[cursor]!)) {
      cursor += 1;
    }
    const leftId = start > 0 ? desiredEntityIds[start - 1]! : null;
    const rightId = cursor < desiredEntityIds.length ? desiredEntityIds[cursor]! : null;
    const left = leftId === null ? null : currentById.get(leftId) ?? null;
    const right = rightId === null ? null : currentById.get(rightId) ?? null;
    if (
      left !== null &&
      right !== null &&
      compareUtf8Bytewise(left, right) >= 0
    ) {
      return { kind: 'rebalance', entries: authoredOrderRebalanceEntries(desiredEntityIds) };
    }
    const keys = fractionalPositionKeysBetween(
      left,
      right,
      cursor - start,
    );
    for (let index = start; index < cursor; index += 1) {
      entries.push({
        entityId: desiredEntityIds[index]!,
        positionKey: keys[index - start]!,
      });
    }
  }
  return { kind: 'moves', entries };
}

export function driftGroupOrderScope(projectId: string, parentGroupId: string | null): string {
  if (!projectId) throw new TypeError('projectId is required for drift-group order');
  return JSON.stringify([projectId, parentGroupId]);
}

export interface AppendAuthoredOrderMoveInput {
  readonly listKind: AuthoredOrderListKind | 'kv-entry' | 'plot-grid-row' | 'plot-grid-column';
  readonly scope: string;
  readonly entityId: string;
  readonly positionKey: string;
  readonly incarnation?: number;
}

/** Append one named order mutation; numeric projections never use field.set. */
export function appendAuthoredOrderMove(
  changes: SyncChangeBuilder,
  input: AppendAuthoredOrderMoveInput,
): void {
  if (!input.scope) throw new TypeError('order scope is required');
  if (!input.entityId) throw new TypeError('ordered entity id is required');
  assertFractionalPositionKey(input.positionKey);
  changes.add({
    action: 'order.move',
    target: {
      family: 'order',
      kind: input.listKind,
      id: input.entityId,
      incarnation: input.incarnation ?? 0,
    },
    payload: { scope: input.scope, positionKey: input.positionKey },
  });
}

export function appendAuthoredOrderRebalance(
  changes: SyncChangeBuilder,
  input: {
    readonly listKind: AppendAuthoredOrderMoveInput['listKind'];
    readonly scope: string;
    readonly entries: readonly AuthoredOrderRebalanceEntry[];
    readonly incarnation?: number;
  },
): void {
  if (!input.scope) throw new TypeError('order scope is required');
  if (input.entries.length === 0) throw new TypeError('rebalance requires at least one entry');
  const ids = new Set<string>();
  for (const entry of input.entries) {
    if (!entry.entityId || ids.has(entry.entityId)) {
      throw new TypeError('rebalance entity IDs must be non-empty and unique');
    }
    ids.add(entry.entityId);
    assertFractionalPositionKey(entry.positionKey);
  }
  // One change-set may contain several rebalance mutations. Keeping each
  // mutation incarnation-homogeneous lets the authored transaction's normal
  // lifecycle resolver assign n+1 independently for restored entities, while
  // the enclosing change-set remains the indivisible apply/segment unit.
  for (const entry of input.entries) {
    changes.add({
      action: 'order.rebalance',
      target: {
        family: 'order',
        kind: input.listKind,
        id: entry.entityId,
        incarnation: input.incarnation ?? 0,
      },
      payload: {
        scope: input.scope,
        entries: [{ entityId: entry.entityId, positionKey: entry.positionKey }],
      },
    });
  }
}
