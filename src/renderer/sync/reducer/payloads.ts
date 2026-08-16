import type { CanonicalCborValue, SyncMutationV1 } from '../protocol';

export interface FieldSetPayload {
  readonly field: string;
  readonly value: CanonicalCborValue;
}

export interface TupleSetPayload {
  readonly tuple: string;
  readonly value: CanonicalCborValue;
}

export interface SetAddPayload {
  readonly memberId: string;
  readonly value: CanonicalCborValue;
}

export interface SetRemovePayload {
  readonly memberId: string;
  readonly observedAddTags: readonly string[];
}

export interface OrderMovePayload {
  readonly scope: string;
  readonly positionKey: string;
}

export interface OrderRebalancePayload {
  readonly scope: string;
  readonly entries: readonly {
    readonly entityId: string;
    readonly positionKey: string;
  }[];
}

export interface LifecycleSeedPayload {
  readonly seed: Readonly<Record<string, CanonicalCborValue>>;
}

export type ParsedReducerMutation =
  | { readonly action: 'field.set'; readonly payload: FieldSetPayload }
  | { readonly action: 'tuple.set'; readonly payload: TupleSetPayload }
  | { readonly action: 'set.add'; readonly payload: SetAddPayload }
  | { readonly action: 'set.remove'; readonly payload: SetRemovePayload }
  | { readonly action: 'order.move'; readonly payload: OrderMovePayload }
  | { readonly action: 'order.rebalance'; readonly payload: OrderRebalancePayload }
  | { readonly action: 'entity.create'; readonly payload: LifecycleSeedPayload }
  | { readonly action: 'entity.trash'; readonly payload: Record<string, never> }
  | { readonly action: 'entity.restore'; readonly payload: LifecycleSeedPayload }
  | { readonly action: 'entity.purge'; readonly payload: Record<string, never> };

export interface PayloadIssue {
  readonly path: string;
  readonly message: string;
}

export type ParsePayloadResult =
  | { readonly ok: true; readonly parsed: ParsedReducerMutation }
  | { readonly ok: false; readonly issue: PayloadIssue };

function objectValue(value: CanonicalCborValue): Readonly<Record<string, CanonicalCborValue>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array)
    ? value as Readonly<Record<string, CanonicalCborValue>>
    : null;
}

function nonEmptyString(value: CanonicalCborValue | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

function hasOnlyKeys(
  value: Readonly<Record<string, CanonicalCborValue>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

function invalid(path: string, message: string): ParsePayloadResult {
  return { ok: false, issue: { path, message } };
}

function parseField(mutation: SyncMutationV1): ParsePayloadResult {
  const payload = objectValue(mutation.payload);
  if (!payload || !hasOnlyKeys(payload, ['field', 'value']) || !nonEmptyString(payload.field)) {
    return invalid('/payload', 'field.set requires exactly { field: non-empty string, value }');
  }
  return { ok: true, parsed: { action: 'field.set', payload: { field: payload.field, value: payload.value } } };
}

function parseTuple(mutation: SyncMutationV1): ParsePayloadResult {
  const payload = objectValue(mutation.payload);
  if (!payload || !hasOnlyKeys(payload, ['tuple', 'value']) || !nonEmptyString(payload.tuple)) {
    return invalid('/payload', 'tuple.set requires exactly { tuple: non-empty string, value }');
  }
  return { ok: true, parsed: { action: 'tuple.set', payload: { tuple: payload.tuple, value: payload.value } } };
}

function parseSetAdd(mutation: SyncMutationV1): ParsePayloadResult {
  const payload = objectValue(mutation.payload);
  if (!payload || !hasOnlyKeys(payload, ['memberId'], ['value']) || !nonEmptyString(payload.memberId)) {
    return invalid('/payload', 'set.add requires { memberId: non-empty string, value? }');
  }
  return {
    ok: true,
    parsed: {
      action: 'set.add',
      payload: { memberId: payload.memberId, value: payload.value ?? null },
    },
  };
}

function parseSetRemove(mutation: SyncMutationV1): ParsePayloadResult {
  const payload = objectValue(mutation.payload);
  if (!payload || !hasOnlyKeys(payload, ['memberId', 'observedAddTags']) || !nonEmptyString(payload.memberId)) {
    return invalid('/payload', 'set.remove requires exactly { memberId, observedAddTags }');
  }
  if (!Array.isArray(payload.observedAddTags) || !payload.observedAddTags.every(nonEmptyString)) {
    return invalid('/payload/observedAddTags', 'observedAddTags must be an array of non-empty strings');
  }
  const observedAddTags = [...new Set(payload.observedAddTags)];
  return {
    ok: true,
    parsed: { action: 'set.remove', payload: { memberId: payload.memberId, observedAddTags } },
  };
}

function parseOrderMove(mutation: SyncMutationV1): ParsePayloadResult {
  const payload = objectValue(mutation.payload);
  if (!payload || !hasOnlyKeys(payload, ['positionKey'], ['scope']) || !nonEmptyString(payload.positionKey)) {
    return invalid('/payload', 'order.move requires { positionKey: non-empty string, scope? }');
  }
  if (payload.scope !== undefined && typeof payload.scope !== 'string') {
    return invalid('/payload/scope', 'scope must be a string');
  }
  return {
    ok: true,
    parsed: {
      action: 'order.move',
      payload: { scope: payload.scope ?? '', positionKey: payload.positionKey },
    },
  };
}

function parseOrderRebalance(mutation: SyncMutationV1): ParsePayloadResult {
  const payload = objectValue(mutation.payload);
  if (!payload || !hasOnlyKeys(payload, ['entries'], ['scope']) || !Array.isArray(payload.entries)) {
    return invalid('/payload', 'order.rebalance requires { entries: [...], scope? }');
  }
  if (payload.scope !== undefined && typeof payload.scope !== 'string') {
    return invalid('/payload/scope', 'scope must be a string');
  }
  const entries: Array<{ entityId: string; positionKey: string }> = [];
  const ids = new Set<string>();
  for (let index = 0; index < payload.entries.length; index += 1) {
    const entry = objectValue(payload.entries[index]);
    if (!entry || !hasOnlyKeys(entry, ['entityId', 'positionKey']) || !nonEmptyString(entry.entityId) || !nonEmptyString(entry.positionKey)) {
      return invalid(`/payload/entries/${index}`, 'entry requires exactly { entityId, positionKey }');
    }
    if (ids.has(entry.entityId)) {
      return invalid(`/payload/entries/${index}/entityId`, 'rebalance entityId values must be unique');
    }
    ids.add(entry.entityId);
    entries.push({ entityId: entry.entityId, positionKey: entry.positionKey });
  }
  if (entries.length === 0) return invalid('/payload/entries', 'rebalance must contain at least one entry');
  return {
    ok: true,
    parsed: { action: 'order.rebalance', payload: { scope: payload.scope ?? '', entries } },
  };
}

function parseSeed(mutation: SyncMutationV1): ParsePayloadResult {
  const payload = objectValue(mutation.payload);
  const seed = payload && objectValue(payload.seed);
  if (!payload || !hasOnlyKeys(payload, ['seed']) || !seed) {
    return invalid('/payload', `${mutation.action} requires exactly { seed: object }`);
  }
  return {
    ok: true,
    parsed: {
      action: mutation.action as 'entity.create' | 'entity.restore',
      payload: { seed },
    },
  };
}

function parseEmptyLifecycle(mutation: SyncMutationV1): ParsePayloadResult {
  const payload = objectValue(mutation.payload);
  if (!payload || Object.keys(payload).length !== 0) {
    return invalid('/payload', `${mutation.action} requires an empty object payload`);
  }
  return {
    ok: true,
    parsed: {
      action: mutation.action as 'entity.trash' | 'entity.purge',
      payload: {},
    },
  };
}

export function parseReducerMutationPayload(mutation: SyncMutationV1): ParsePayloadResult {
  switch (mutation.action) {
    case 'field.set': return parseField(mutation);
    case 'tuple.set': return parseTuple(mutation);
    case 'set.add': return parseSetAdd(mutation);
    case 'set.remove': return parseSetRemove(mutation);
    case 'order.move': return parseOrderMove(mutation);
    case 'order.rebalance': return parseOrderRebalance(mutation);
    case 'entity.create':
    case 'entity.restore': return parseSeed(mutation);
    case 'entity.trash':
    case 'entity.purge': return parseEmptyLifecycle(mutation);
    default:
      return invalid('/action', `reducer core does not support action ${mutation.action}`);
  }
}
