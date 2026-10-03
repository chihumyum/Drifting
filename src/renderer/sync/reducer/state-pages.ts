/**
 * Versioned canonical form of a compacted reducer state: the reducer section
 * of a v2 checkpoint and the authoritative base a restore installs. The state
 * is split into canonical CBOR pages so a project-sized state never exceeds
 * the canonical node limit.
 */
import {
  compareUtf8Bytewise,
  decodeCanonicalCbor,
  encodeCanonicalCbor,
  paginateCanonicalEntries,
  type CanonicalCborValue,
  type Hlc,
} from '../protocol';
import type {
  AssetBindingRegister,
  FieldRegister,
  LifecycleSeed,
  LwwValue,
  OrderRegister,
  ReducerConflict,
  ReducerCoverageEntry,
  ReducerProfile,
  ReducerSnapshot,
  ReducerSyncGenerationIdentity,
  SyncGenerationPurgeRegister,
  TupleRegister,
} from './types';

export const REDUCER_STATE_PAGE_FORMAT = 'drifting.sync.reducer-state' as const;
export const REDUCER_STATE_PAGES_PAYLOAD_VERSION = 2 as const;

/** Pages appear in this order; an empty part has no page, the header exactly one. */
export const REDUCER_STATE_PAGE_PARTS = [
  'header',
  'coverage',
  'receipts',
  'fields',
  'tuples',
  'set-members',
  'orders',
  'asset-bindings',
  'lifecycles',
  'conflicts',
  'change-sets',
  'mutations',
  'apply-receipts',
  'frontier',
] as const;

type ReducerStatePagePart = (typeof REDUCER_STATE_PAGE_PARTS)[number];
type Row = Readonly<Record<string, CanonicalCborValue>>;

export interface ReducerStateProfileV2 {
  readonly knownTargetKinds: readonly string[];
  readonly externallyMaterializedActions: readonly string[];
}

export interface ReducerStateHeaderV2 {
  readonly identity: ReducerSyncGenerationIdentity;
  readonly profile: ReducerStateProfileV2;
  /** Latest HLC among every change-set the state covers, explicit or compacted. */
  readonly maxChangeSetHlc: Hlc;
}

/** Journal rows a checkpoint carries so register sources keep their foreign keys. */
export interface ReducerStateJournalV2 {
  readonly changeSets: readonly Row[];
  readonly mutations: readonly Row[];
  readonly applyReceipts: readonly Row[];
  readonly frontier: readonly Row[];
}

export interface ReducerStatePagesV2 {
  readonly header: ReducerStateHeaderV2;
  readonly snapshot: ReducerSnapshot;
  readonly journal: ReducerStateJournalV2;
}

export const EMPTY_REDUCER_STATE_JOURNAL: ReducerStateJournalV2 = Object.freeze({
  changeSets: [],
  mutations: [],
  applyReceipts: [],
  frontier: [],
});

/** Data-only profile description; a projection validator cannot be persisted. */
export function describeReducerProfile(profile: ReducerProfile): ReducerStateProfileV2 {
  if (profile.validateProjection) {
    throw new Error('a reducer profile with a projection validator cannot be persisted');
  }
  return {
    knownTargetKinds: [...profile.knownTargetKinds].sort(compareUtf8Bytewise),
    externallyMaterializedActions: [...(profile.externallyMaterializedActions ?? [])].sort(compareUtf8Bytewise),
  };
}

function page(part: ReducerStatePagePart, entries: readonly CanonicalCborValue[]): Uint8Array {
  return encodeCanonicalCbor({
    format: REDUCER_STATE_PAGE_FORMAT,
    payloadVersion: REDUCER_STATE_PAGES_PAYLOAD_VERSION,
    part,
    entries: entries as CanonicalCborValue[],
  });
}

// Envelope nodes: the page map, its four values and the entries array.
const PAGE_OVERHEAD = 6;

export function encodeReducerStatePagesV2(value: ReducerStatePagesV2): Uint8Array[] {
  const { snapshot, journal } = value;
  const header = {
    identity: { ...value.header.identity },
    profile: {
      knownTargetKinds: [...value.header.profile.knownTargetKinds],
      externallyMaterializedActions: [...value.header.profile.externallyMaterializedActions],
    },
    maxChangeSetHlc: { ...value.header.maxChangeSetHlc },
    generationPurge: snapshot.generationPurge,
  } as unknown as CanonicalCborValue;
  const parts: Record<Exclude<ReducerStatePagePart, 'header'>, readonly unknown[]> = {
    coverage: snapshot.coverage,
    receipts: snapshot.receipts,
    fields: snapshot.fields,
    tuples: snapshot.tuples,
    'set-members': snapshot.sets.flatMap((set) =>
      set.members.map((member) => ({ target: set.target, ...member })),
    ),
    orders: snapshot.orders,
    'asset-bindings': snapshot.assetBindings,
    lifecycles: snapshot.lifecycles,
    conflicts: snapshot.conflicts,
    'change-sets': journal.changeSets,
    mutations: journal.mutations,
    'apply-receipts': journal.applyReceipts,
    frontier: journal.frontier,
  };
  const pages = [page('header', [header])];
  for (const part of REDUCER_STATE_PAGE_PARTS) {
    if (part === 'header') continue;
    for (const entries of paginateCanonicalEntries(parts[part] as CanonicalCborValue[], PAGE_OVERHEAD)) {
      pages.push(page(part, entries));
    }
  }
  return pages;
}

function fail(reason: string): never {
  throw new Error(`reducer state pages are invalid: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array);
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isIndex = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function isHlc(value: unknown): value is Hlc {
  return isRecord(value) && isIndex(value.wallMs) && isIndex(value.counter);
}

function isTarget(value: unknown): boolean {
  return isRecord(value) && isString(value.family) && isString(value.kind) && isString(value.id) && isIndex(value.incarnation);
}

/** A record carrying an LWW value with its total order and source. */
function isLww(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !('value' in value)) return false;
  const { order, source } = value;
  return (
    isRecord(order) &&
    isHlc(order.hlc) &&
    isString(order.writerId) &&
    isString(order.writerEpoch) &&
    isIndex(order.deviceSeq) &&
    isIndex(order.mutationIndex) &&
    isRecord(source) &&
    isString(source.changeSetId) &&
    isIndex(source.mutationIndex)
  );
}

const ENTRY_GUARDS: Record<Exclude<ReducerStatePagePart, 'header'>, (entry: Record<string, unknown>) => boolean> = {
  coverage: (entry) => isString(entry.writerId) && isString(entry.writerEpoch) && isIndex(entry.deviceSeq) && entry.deviceSeq > 0,
  receipts: (entry) => isString(entry.changeSetId) && isString(entry.signature),
  fields: (entry) => isLww(entry) && isTarget(entry.target) && isString(entry.field),
  tuples: (entry) => isLww(entry) && isTarget(entry.target) && isString(entry.tuple),
  'set-members': (entry) =>
    isTarget(entry.target) &&
    isString(entry.memberId) &&
    Array.isArray(entry.adds) &&
    entry.adds.every((add) => isLww(add) && isString(add.tag)) &&
    Array.isArray(entry.removedAddTags) &&
    entry.removedAddTags.every((remove) =>
      isLww(remove) && isString(remove.addTag) && remove.value === true,
    ),
  orders: (entry) => isLww(entry) && isString(entry.value) && isTarget(entry.target) && isString(entry.scope) && isString(entry.entityId),
  'asset-bindings': (entry) =>
    isLww(entry) && isTarget(entry.target) && isRecord(entry.value) &&
    (entry.value.action === 'asset.bind' || entry.value.action === 'asset.unbind') && 'payload' in entry.value,
  lifecycles: (entry) =>
    isString(entry.kind) &&
    isString(entry.entityId) &&
    Array.isArray(entry.seeds) &&
    entry.seeds.every((seed) =>
      isLww(seed) && isIndex(seed.incarnation) && isRecord(seed.value) &&
      (seed.action === 'entity.create' || seed.action === 'entity.restore'),
    ) &&
    Array.isArray(entry.trashes) &&
    entry.trashes.every((trash) => isLww(trash) && isIndex(trash.incarnation) && trash.value === true) &&
    (entry.purge === null || (isLww(entry.purge) && entry.purge.value === true)),
  conflicts: (entry) =>
    isString(entry.conflictId) &&
    isString(entry.code) &&
    isString(entry.scope) &&
    isString(entry.message) &&
    'details' in entry &&
    (entry.target === null ||
      (isRecord(entry.target) && isString(entry.target.kind) && isString(entry.target.id) &&
        (entry.target.incarnation === null || isIndex(entry.target.incarnation)))),
  'change-sets': isRecord,
  mutations: isRecord,
  'apply-receipts': isRecord,
  frontier: isRecord,
};

function decodeHeader(entries: readonly unknown[]): { header: ReducerStateHeaderV2; generationPurge: SyncGenerationPurgeRegister | null } {
  const [value] = entries;
  if (entries.length !== 1 || !isRecord(value)) fail('header page must hold exactly one header');
  const { identity, profile, maxChangeSetHlc, generationPurge } = value;
  if (
    !isRecord(identity) ||
    !isString(identity.projectId) ||
    !isString(identity.projectSyncId) ||
    !isString(identity.syncGenerationId) ||
    !isRecord(profile) ||
    !Array.isArray(profile.knownTargetKinds) ||
    !profile.knownTargetKinds.every(isString) ||
    !Array.isArray(profile.externallyMaterializedActions) ||
    !profile.externallyMaterializedActions.every(isString) ||
    !isHlc(maxChangeSetHlc) ||
    !(generationPurge === null || (isLww(generationPurge) && isTarget(generationPurge.target)))
  ) {
    fail('header is malformed');
  }
  return {
    header: {
      identity: {
        projectId: identity.projectId,
        projectSyncId: identity.projectSyncId,
        syncGenerationId: identity.syncGenerationId,
      },
      profile: {
        knownTargetKinds: profile.knownTargetKinds as string[],
        externallyMaterializedActions: profile.externallyMaterializedActions as string[],
      },
      maxChangeSetHlc,
    },
    generationPurge: generationPurge as SyncGenerationPurgeRegister | null,
  };
}

export function decodeReducerStatePagesV2(pages: readonly Uint8Array[]): ReducerStatePagesV2 {
  const entriesByPart = new Map<ReducerStatePagePart, unknown[]>();
  let lastPartIndex = -1;
  for (const [index, bytes] of pages.entries()) {
    const decoded = decodeCanonicalCbor(bytes);
    if (!decoded.ok || !isRecord(decoded.value)) fail(`page ${index} is not canonical CBOR`);
    const { format, payloadVersion, part, entries } = decoded.value;
    if (format !== REDUCER_STATE_PAGE_FORMAT || payloadVersion !== REDUCER_STATE_PAGES_PAYLOAD_VERSION) {
      fail(`page ${index} has an unsupported format`);
    }
    const partIndex = REDUCER_STATE_PAGE_PARTS.indexOf(part as ReducerStatePagePart);
    if (partIndex < 0 || partIndex < lastPartIndex) fail(`page ${index} part ${String(part)} is out of order`);
    if (partIndex === 0 && lastPartIndex === 0) fail('the header repeats');
    if (!Array.isArray(entries) || entries.length === 0) fail(`page ${index} has no entries`);
    lastPartIndex = partIndex;
    const name = part as ReducerStatePagePart;
    if (name !== 'header' && !entries.every((entry) => isRecord(entry) && ENTRY_GUARDS[name](entry))) {
      fail(`page ${index} has a malformed ${name} entry`);
    }
    const bucket = entriesByPart.get(name) ?? [];
    bucket.push(...entries);
    entriesByPart.set(name, bucket);
  }
  if (!entriesByPart.has('header')) fail('the header page is missing');
  const { header, generationPurge } = decodeHeader(entriesByPart.get('header')!);
  const part = <T,>(name: ReducerStatePagePart) => (entriesByPart.get(name) ?? []) as T[];

  const setsByTarget = new Map<string, { target: FieldRegister['target']; members: ReducerSnapshot['sets'][number]['members'][number][] }>();
  for (const { target, ...member } of part<{ target: FieldRegister['target'] } & ReducerSnapshot['sets'][number]['members'][number]>('set-members')) {
    const key = JSON.stringify([target.kind, target.id, target.incarnation]);
    const set = setsByTarget.get(key) ?? { target, members: [] };
    set.members.push(member);
    setsByTarget.set(key, set);
  }
  return {
    header,
    snapshot: {
      identity: header.identity,
      coverage: part<ReducerCoverageEntry>('coverage'),
      receipts: part<{ changeSetId: string; signature: string }>('receipts'),
      generationPurge,
      fields: part<FieldRegister>('fields'),
      tuples: part<TupleRegister>('tuples'),
      sets: [...setsByTarget.values()],
      orders: part<OrderRegister>('orders'),
      assetBindings: part<AssetBindingRegister>('asset-bindings'),
      lifecycles: part<{
        kind: string;
        entityId: string;
        seeds: LifecycleSeed[];
        trashes: (LwwValue<true> & { incarnation: number })[];
        purge: LwwValue<true> | null;
      }>('lifecycles'),
      conflicts: part<ReducerConflict>('conflicts'),
    },
    journal: {
      changeSets: part<Row>('change-sets'),
      mutations: part<Row>('mutations'),
      applyReceipts: part<Row>('apply-receipts'),
      frontier: part<Row>('frontier'),
    },
  };
}
