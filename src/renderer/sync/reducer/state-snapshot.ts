/**
 * Local persistence codec for a canonical reducer state. A snapshot is a
 * derived cache of receipt-backed history, never protocol data: it uses plain
 * CBOR without the canonical node limit, keeps every map key verbatim and
 * preserves object property order.
 */
import { decode, encode } from 'cborg';

import { createReducerReceipts } from './reducer';
import type {
  AssetBindingRegister,
  CanonicalReducerState,
  FieldRegister,
  LifecycleSeed,
  LifecycleState,
  LwwValue,
  OrderRegister,
  OrSetAdd,
  OrSetMemberState,
  OrSetState,
  ReducerConflict,
  ReducerSyncGenerationIdentity,
  SyncGenerationPurgeRegister,
  TupleRegister,
} from './types';

/**
 * Bump whenever reducer semantics, change-set signatures or the state shape
 * change. A snapshot is only valid for the reducer version that produced it.
 */
export const REDUCER_STATE_SNAPSHOT_FORMAT = 2;

type Entries<K, V> = readonly (readonly [K, V])[];

interface EncodedReducerState {
  readonly format: typeof REDUCER_STATE_SNAPSHOT_FORMAT;
  readonly identity: ReducerSyncGenerationIdentity;
  readonly coverage: Entries<string, number>;
  readonly receiptIds: readonly string[];
  readonly receiptSignatures: readonly string[];
  readonly generationPurge: SyncGenerationPurgeRegister | null;
  readonly fields: Entries<string, FieldRegister>;
  readonly tuples: Entries<string, TupleRegister>;
  readonly sets: Entries<string, {
    readonly target: OrSetState['target'];
    readonly members: Entries<string, {
      readonly memberId: string;
      readonly adds: Entries<string, OrSetAdd>;
      readonly removedAddTags: Entries<string, LwwValue<true>>;
    }>;
  }>;
  readonly orders: Entries<string, OrderRegister>;
  readonly assetBindings: Entries<string, AssetBindingRegister>;
  readonly lifecycles: Entries<string, {
    readonly kind: string;
    readonly entityId: string;
    readonly seeds: Entries<number, LifecycleSeed>;
    readonly trashes: Entries<number, LwwValue<true>>;
    readonly purge: LwwValue<true> | null;
  }>;
  readonly conflicts: Entries<string, ReducerConflict>;
}

export function encodeReducerState(state: CanonicalReducerState): Uint8Array {
  const receiptIds: string[] = [];
  const receiptSignatures: string[] = [];
  state.receipts.forEach((signature, changeSetId) => {
    receiptIds.push(changeSetId);
    receiptSignatures.push(signature);
  });
  const encoded: EncodedReducerState = {
    format: REDUCER_STATE_SNAPSHOT_FORMAT,
    identity: { ...state.identity },
    coverage: [...state.coverage],
    receiptIds,
    receiptSignatures,
    generationPurge: state.generationPurge,
    fields: [...state.fields],
    tuples: [...state.tuples],
    sets: [...state.sets].map(([key, set]) => [key, {
      target: set.target,
      members: [...set.members].map(([memberKey, member]) => [memberKey, {
        memberId: member.memberId,
        adds: [...member.adds],
        removedAddTags: [...member.removedAddTags],
      }] as const),
    }] as const),
    orders: [...state.orders],
    assetBindings: [...state.assetBindings],
    lifecycles: [...state.lifecycles].map(([key, lifecycle]) => [key, {
      kind: lifecycle.kind,
      entityId: lifecycle.entityId,
      seeds: [...lifecycle.seeds],
      trashes: [...lifecycle.trashes],
      purge: lifecycle.purge,
    }] as const),
    conflicts: [...state.conflicts],
  };
  // Keep property order verbatim: identifiers elsewhere are JSON strings of
  // these objects, and a sorted round trip would change them.
  return encode(encoded, { mapSorter: undefined });
}

function fail(reason: string): never {
  throw new Error(`reducer snapshot is invalid: ${reason}`);
}

function entries<K extends string | number, V>(value: unknown, keyType: 'string' | 'number', label: string): Map<K, V> {
  if (!Array.isArray(value)) fail(`${label} must be an entry list`);
  const map = new Map<K, V>();
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== keyType) {
      fail(`${label} contains a malformed entry`);
    }
    if (entry[1] === null || typeof entry[1] !== 'object') fail(`${label} contains a non-object value`);
    if (map.has(entry[0] as K)) fail(`${label} repeats key ${String(entry[0])}`);
    map.set(entry[0] as K, entry[1] as V);
  }
  return map;
}

/** Throws when the bytes do not decode to a complete state for `identity`. */
export function decodeReducerState(
  bytes: Uint8Array,
  identity: ReducerSyncGenerationIdentity,
): CanonicalReducerState {
  const value = decode(bytes) as Partial<EncodedReducerState> | null;
  if (!value || typeof value !== 'object') fail('not a map');
  if (value.format !== REDUCER_STATE_SNAPSHOT_FORMAT) fail(`unsupported format ${String(value.format)}`);
  if (
    value.identity?.projectId !== identity.projectId ||
    value.identity.projectSyncId !== identity.projectSyncId ||
    value.identity.syncGenerationId !== identity.syncGenerationId
  ) {
    fail('identity does not match the SyncGeneration');
  }
  const { receiptIds, receiptSignatures } = value;
  if (
    !Array.isArray(receiptIds) ||
    !Array.isArray(receiptSignatures) ||
    receiptIds.length !== receiptSignatures.length ||
    receiptIds.some((id) => typeof id !== 'string') ||
    receiptSignatures.some((signature) => typeof signature !== 'string')
  ) {
    fail('receipts are malformed');
  }
  if (
    !Array.isArray(value.coverage) ||
    value.coverage.some((entry) =>
      !Array.isArray(entry) || typeof entry[0] !== 'string' || !Number.isSafeInteger(entry[1]) || entry[1] < 1,
    )
  ) {
    fail('coverage is malformed');
  }
  const coverage = new Map<string, number>(value.coverage as (readonly [string, number])[]);
  if (coverage.size !== value.coverage.length) fail('coverage repeats a lane');
  const generationPurge = value.generationPurge ?? null;
  if (generationPurge !== null && typeof generationPurge !== 'object') fail('generation purge is malformed');

  const sets = new Map<string, OrSetState>();
  for (const [key, set] of entries<string, { target?: unknown; members?: unknown }>(value.sets, 'string', 'sets')) {
    if (!set.target || typeof set.target !== 'object') fail(`set ${key} has no target`);
    const members = new Map<string, OrSetMemberState>();
    for (const [memberKey, member] of entries<string, { memberId?: unknown; adds?: unknown; removedAddTags?: unknown }>(set.members, 'string', `set ${key} members`)) {
      if (typeof member.memberId !== 'string') fail(`set ${key} member ${memberKey} has no id`);
      members.set(memberKey, {
        memberId: member.memberId,
        adds: entries<string, OrSetAdd>(member.adds, 'string', `set ${key} adds`),
        removedAddTags: entries<string, LwwValue<true>>(member.removedAddTags, 'string', `set ${key} removes`),
      });
    }
    sets.set(key, { target: set.target as OrSetState['target'], members });
  }

  const lifecycles = new Map<string, LifecycleState>();
  for (const [key, lifecycle] of entries<string, { kind?: unknown; entityId?: unknown; seeds?: unknown; trashes?: unknown; purge?: unknown }>(value.lifecycles, 'string', 'lifecycles')) {
    if (typeof lifecycle.kind !== 'string' || typeof lifecycle.entityId !== 'string') {
      fail(`lifecycle ${key} has no identity`);
    }
    const purge = lifecycle.purge ?? null;
    if (purge !== null && typeof purge !== 'object') fail(`lifecycle ${key} purge is malformed`);
    lifecycles.set(key, {
      kind: lifecycle.kind,
      entityId: lifecycle.entityId,
      seeds: entries<number, LifecycleSeed>(lifecycle.seeds, 'number', `lifecycle ${key} seeds`),
      trashes: entries<number, LwwValue<true>>(lifecycle.trashes, 'number', `lifecycle ${key} trashes`),
      purge: purge as LwwValue<true> | null,
    });
  }

  return {
    identity: { ...identity },
    coverage,
    receipts: createReducerReceipts(
      receiptIds.map((changeSetId, index) => [changeSetId, receiptSignatures[index]] as const),
    ),
    generationPurge: generationPurge as SyncGenerationPurgeRegister | null,
    fields: entries<string, FieldRegister>(value.fields, 'string', 'fields'),
    tuples: entries<string, TupleRegister>(value.tuples, 'string', 'tuples'),
    sets,
    orders: entries<string, OrderRegister>(value.orders, 'string', 'orders'),
    assetBindings: entries<string, AssetBindingRegister>(value.assetBindings, 'string', 'asset bindings'),
    lifecycles,
    conflicts: entries<string, ReducerConflict>(value.conflicts, 'string', 'conflicts'),
  };
}
