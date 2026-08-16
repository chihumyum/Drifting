import {
  compareSyncTotalOrder,
  compareUtf8Bytewise,
  parseProjectAssetMutationV1,
  type CanonicalCborValue,
  type SyncChangeSetV1,
  type SyncMutationTargetFamily,
  type SyncMutationTargetV1,
  type SyncMutationV1,
  type SyncTotalOrderV1,
} from '../protocol';
import { parseDocId } from '../../lib/yjs-doc-id';
import {
  parseReducerMutationPayload,
  type ParsedReducerMutation,
} from './payloads';
import type {
  CanonicalReducerState,
  AssetBindingRegister,
  FieldRegister,
  LifecycleSeed,
  LifecycleState,
  LwwValue,
  OrderRegister,
  OrSetAdd,
  OrSetMemberState,
  OrSetState,
  ProtocolValidatedChangeSet,
  ReducerConflict,
  ReducerEffect,
  ReducerIngestResult,
  ReducerProfile,
  ReducerRejection,
  ReducerSnapshot,
  ReducerSource,
  ReducerSyncGenerationIdentity,
  SemanticConflictDraft,
  TupleRegister,
  SyncGenerationPurgeRegister,
} from './types';

const SUPPORTED_ACTIONS = new Set([
  'field.set',
  'tuple.set',
  'set.add',
  'set.remove',
  'order.move',
  'order.rebalance',
  'entity.create',
  'entity.trash',
  'entity.restore',
  'entity.purge',
]);

const ACTION_FAMILY: Readonly<Record<string, SyncMutationTargetFamily>> = {
  'field.set': 'entity',
  'tuple.set': 'entity',
  'set.add': 'set',
  'set.remove': 'set',
  'order.move': 'order',
  'order.rebalance': 'order',
  'entity.create': 'entity',
  'entity.trash': 'entity',
  'entity.restore': 'entity',
  'entity.purge': 'entity',
  'sync-generation.purge': 'sync-generation',
  'yjs.update': 'yjs',
  'asset.bind': 'asset',
  'asset.unbind': 'asset',
};

interface PreparedMutation {
  readonly mutation: SyncMutationV1;
  /** null means a composing typed reducer explicitly owns this action. */
  readonly parsed: ParsedReducerMutation | null;
  readonly order: SyncTotalOrderV1;
  readonly source: ReducerSource;
}

function externalEffect(
  state: CanonicalReducerState,
  prepared: PreparedMutation,
): ReducerEffect | null {
  if (prepared.parsed !== null) return null;
  const { mutation, order, source } = prepared;
  if (mutation.action !== 'yjs.update') return null;
  return {
    effectId: effectId('external', mutation.action, mutation.target.kind, mutation.target.id, mutation.index),
    type: mutation.action,
    materialize: canMaterializeTarget(state, mutation.target),
    target: cloneTarget(mutation.target),
    payload: cloneCbor(mutation.payload),
    order,
    source,
  } as ReducerEffect;
}

function cloneCbor(value: CanonicalCborValue): CanonicalCborValue {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (Array.isArray(value)) return value.map(cloneCbor);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneCbor(child)]));
  }
  return value;
}

function cloneRecord(
  value: Readonly<Record<string, CanonicalCborValue>>,
): Readonly<Record<string, CanonicalCborValue>> {
  return cloneCbor(value) as Readonly<Record<string, CanonicalCborValue>>;
}

function cloneTarget(target: Readonly<SyncMutationTargetV1>): Readonly<SyncMutationTargetV1> {
  return { ...target };
}

function utf8Sort(left: string, right: string): number {
  return compareUtf8Bytewise(left, right);
}

function targetKey(target: Pick<SyncMutationTargetV1, 'kind' | 'id' | 'incarnation'>): string {
  return JSON.stringify([target.kind, target.id, target.incarnation]);
}

function entityKey(target: Pick<SyncMutationTargetV1, 'kind' | 'id'>): string {
  return JSON.stringify([target.kind, target.id]);
}

function registerKey(target: SyncMutationTargetV1, name: string): string {
  return JSON.stringify([target.kind, target.id, target.incarnation, name]);
}

function orderKey(kind: string, incarnation: number, entityId: string): string {
  return JSON.stringify([kind, incarnation, entityId]);
}

function conflictScope(kind: string, id: string, incarnation?: number): string {
  return incarnation === undefined
    ? JSON.stringify([kind, id])
    : JSON.stringify([kind, id, incarnation]);
}

function effectId(type: string, ...parts: Array<string | number>): string {
  return JSON.stringify([type, ...parts]);
}

function reject(
  state: CanonicalReducerState,
  rejection: ReducerRejection,
): ReducerIngestResult {
  return {
    status: 'rejected',
    state,
    effects: [],
    conflicts: sortedConflicts(state.conflicts),
    rejection,
  };
}

function changeSetSignature(changeSet: SyncChangeSetV1): string {
  return JSON.stringify({
    protocol: changeSet.protocol,
    protocolVersion: changeSet.protocolVersion,
    payloadVersion: changeSet.payloadVersion,
    projectId: changeSet.projectId,
    projectSyncId: changeSet.projectSyncId,
    syncGenerationId: changeSet.syncGenerationId,
    writerId: changeSet.writerId,
    writerEpoch: changeSet.writerEpoch,
    deviceSeq: changeSet.deviceSeq,
    hlc: changeSet.hlc,
    mutations: changeSet.mutations.map((mutation) => ({
      index: mutation.index,
      target: {
        family: mutation.target.family,
        kind: mutation.target.kind,
        id: mutation.target.id,
        incarnation: mutation.target.incarnation,
      },
      action: mutation.action,
      payloadVersion: mutation.payloadVersion,
      payloadSha256: mutation.payloadSha256,
    })),
  });
}

function orderFor(changeSet: SyncChangeSetV1, mutation: SyncMutationV1): SyncTotalOrderV1 {
  return {
    hlc: { ...changeSet.hlc },
    writerId: changeSet.writerId,
    writerEpoch: changeSet.writerEpoch,
    deviceSeq: changeSet.deviceSeq,
    mutationIndex: mutation.index,
  };
}

function sourceFor(changeSet: SyncChangeSetV1, mutation: SyncMutationV1): ReducerSource {
  return { changeSetId: changeSet.changeSetId, mutationIndex: mutation.index };
}

function prepareChangeSet(
  state: CanonicalReducerState,
  changeSet: ProtocolValidatedChangeSet,
  profile: ReducerProfile,
): { ok: true; prepared: readonly PreparedMutation[]; signature: string } | {
  ok: false;
  result: ReducerIngestResult;
} {
  if (
    changeSet.projectId !== state.identity.projectId ||
    changeSet.projectSyncId !== state.identity.projectSyncId ||
    changeSet.syncGenerationId !== state.identity.syncGenerationId
  ) {
    return {
      ok: false,
      result: reject(state, {
        code: 'sync-generation-identity-mismatch',
        path: '$',
        message: 'change-set project, projectSync and generation must match the reducer identity',
      }),
    };
  }

  const signature = changeSetSignature(changeSet as SyncChangeSetV1);
  const existingSignature = state.receipts.get(changeSet.changeSetId);
  if (existingSignature !== undefined) {
    if (existingSignature === signature) {
      return {
        ok: false,
        result: {
          status: 'duplicate',
          state,
          effects: [],
          conflicts: sortedConflicts(state.conflicts),
        },
      };
    }
    return {
      ok: false,
      result: reject(state, {
        code: 'changeset-id-collision',
        path: '/changeSetId',
        message: 'a different change-set already uses this changeSetId',
      }),
    };
  }

  if (changeSet.mutations.length === 0) {
    return {
      ok: false,
      result: reject(state, {
        code: 'invalid-mutation-index',
        path: '/mutations',
        message: 'a change-set must contain at least one mutation',
      }),
    };
  }

  const prepared: PreparedMutation[] = [];
  for (let index = 0; index < changeSet.mutations.length; index += 1) {
    const mutation = changeSet.mutations[index];
    const path = `/mutations/${index}`;
    if (mutation.index !== index) {
      return {
        ok: false,
        result: reject(state, {
          code: 'invalid-mutation-index',
          path: `${path}/index`,
          message: `mutation index must be ${index}`,
        }),
      };
    }
    if (!profile.knownTargetKinds.has(mutation.target.kind)) {
      return {
        ok: false,
        result: reject(state, {
          code: 'unknown-target-kind',
          path: `${path}/target/kind`,
          message: `target kind ${mutation.target.kind} is not classified by the reducer profile`,
        }),
      };
    }
    const externallyMaterialized =
      profile.externallyMaterializedActions?.has(mutation.action) === true;
    if (!SUPPORTED_ACTIONS.has(mutation.action) && !externallyMaterialized) {
      return {
        ok: false,
        result: reject(state, {
          code: 'unsupported-action',
          path: `${path}/action`,
          message: `reducer core does not materialize ${mutation.action}`,
        }),
      };
    }
    const expectedFamily = ACTION_FAMILY[mutation.action];
    if (mutation.target.family !== expectedFamily) {
      return {
        ok: false,
        result: reject(state, {
          code: 'invalid-target-family',
          path: `${path}/target/family`,
          message: `${mutation.action} requires target family ${expectedFamily}`,
        }),
      };
    }
    if (mutation.action === 'entity.create' && mutation.target.incarnation !== 0) {
      return {
        ok: false,
        result: reject(state, {
          code: 'invalid-payload',
          path: `${path}/target/incarnation`,
          message: 'entity.create must create incarnation 0',
        }),
      };
    }
    if (mutation.action === 'entity.restore' && mutation.target.incarnation === 0) {
      return {
        ok: false,
        result: reject(state, {
          code: 'invalid-payload',
          path: `${path}/target/incarnation`,
          message: 'entity.restore must create an incarnation greater than 0',
        }),
      };
    }
    if (externallyMaterialized && !SUPPORTED_ACTIONS.has(mutation.action)) {
      prepared.push({
        mutation,
        parsed: null,
        order: orderFor(changeSet as SyncChangeSetV1, mutation),
        source: sourceFor(changeSet as SyncChangeSetV1, mutation),
      });
      continue;
    }
    const parsed = parseReducerMutationPayload(mutation);
    if (!parsed.ok) {
      return {
        ok: false,
        result: reject(state, {
          code: mutation.action.startsWith('asset.') || mutation.action === 'yjs.update'
            ? 'unsupported-action'
            : 'invalid-payload',
          path: `${path}${parsed.issue.path}`,
          message: parsed.issue.message,
        }),
      };
    }
    prepared.push({
      mutation,
      parsed: parsed.parsed,
      order: orderFor(changeSet as SyncChangeSetV1, mutation),
      source: sourceFor(changeSet as SyncChangeSetV1, mutation),
    });
  }

  return { ok: true, prepared, signature };
}

function cloneState(state: CanonicalReducerState): CanonicalReducerState {
  const sets = new Map<string, OrSetState>();
  for (const [key, set] of state.sets) {
    const members = new Map<string, OrSetMemberState>();
    for (const [memberKey, member] of set.members) {
      members.set(memberKey, {
        memberId: member.memberId,
        adds: new Map(member.adds),
        removedAddTags: new Map(member.removedAddTags),
      });
    }
    sets.set(key, { target: set.target, members });
  }

  const lifecycles = new Map<string, LifecycleState>();
  for (const [key, lifecycle] of state.lifecycles) {
    lifecycles.set(key, {
      kind: lifecycle.kind,
      entityId: lifecycle.entityId,
      seeds: new Map(lifecycle.seeds),
      trashes: new Map(lifecycle.trashes),
      purge: lifecycle.purge,
    });
  }

  return {
    identity: state.identity,
    receipts: new Map(state.receipts),
    generationPurge: state.generationPurge
      ? {
          ...state.generationPurge,
          target: cloneTarget(state.generationPurge.target),
          value: cloneCbor(state.generationPurge.value),
        }
      : null,
    fields: new Map(state.fields),
    tuples: new Map(state.tuples),
    sets,
    orders: new Map(state.orders),
    assetBindings: new Map(state.assetBindings),
    lifecycles,
    conflicts: new Map(state.conflicts),
  };
}

function wins<T>(incoming: LwwValue<T>, current: LwwValue<T> | undefined | null): boolean {
  return !current || compareSyncTotalOrder(incoming.order, current.order) > 0;
}

function lifecycleFor(
  state: CanonicalReducerState,
  target: Pick<SyncMutationTargetV1, 'kind' | 'id'>,
): LifecycleState {
  const key = entityKey(target);
  const existing = state.lifecycles.get(key);
  if (existing) return existing;
  const created: LifecycleState = {
    kind: target.kind,
    entityId: target.id,
    seeds: new Map(),
    trashes: new Map(),
    purge: null,
  };
  (state.lifecycles as Map<string, LifecycleState>).set(key, created);
  return created;
}

function setFor(state: CanonicalReducerState, target: SyncMutationTargetV1): OrSetState {
  const key = targetKey(target);
  const existing = state.sets.get(key);
  if (existing) return existing;
  const created: OrSetState = { target: cloneTarget(target), members: new Map() };
  (state.sets as Map<string, OrSetState>).set(key, created);
  return created;
}

function memberFor(set: OrSetState, memberId: string): OrSetMemberState {
  const existing = set.members.get(memberId);
  if (existing) return existing;
  const created: OrSetMemberState = {
    memberId,
    adds: new Map(),
    removedAddTags: new Map(),
  };
  (set.members as Map<string, OrSetMemberState>).set(memberId, created);
  return created;
}

export function mutationAddTag(changeSetId: string, mutationIndex: number): string {
  return `${changeSetId}#${mutationIndex}`;
}

function applyPreparedMutation(state: CanonicalReducerState, prepared: PreparedMutation): void {
  const { mutation, parsed, order, source } = prepared;
  if (!parsed) {
    if (mutation.action === 'sync-generation.purge') {
      const register: SyncGenerationPurgeRegister = {
        target: cloneTarget(mutation.target),
        value: cloneCbor(mutation.payload),
        order,
        source,
      };
      if (wins(register, state.generationPurge)) {
        (state as { generationPurge: SyncGenerationPurgeRegister | null }).generationPurge = register;
      }
      return;
    }
    if (mutation.action === 'asset.bind' || mutation.action === 'asset.unbind') {
      const key = targetKey(mutation.target);
      const register: AssetBindingRegister = {
        target: cloneTarget(mutation.target),
        value: {
          action: mutation.action,
          payload: cloneCbor(mutation.payload),
        },
        order,
        source,
      };
      if (wins(register, state.assetBindings.get(key))) {
        (state.assetBindings as Map<string, AssetBindingRegister>).set(key, register);
      }
    }
    return;
  }
  switch (parsed.action) {
    case 'field.set': {
      const key = registerKey(mutation.target, parsed.payload.field);
      const register: FieldRegister = {
        target: cloneTarget(mutation.target),
        field: parsed.payload.field,
        value: cloneCbor(parsed.payload.value),
        order,
        source,
      };
      if (wins(register, state.fields.get(key))) {
        (state.fields as Map<string, FieldRegister>).set(key, register);
      }
      return;
    }
    case 'tuple.set': {
      const key = registerKey(mutation.target, parsed.payload.tuple);
      const register: TupleRegister = {
        target: cloneTarget(mutation.target),
        tuple: parsed.payload.tuple,
        value: cloneCbor(parsed.payload.value),
        order,
        source,
      };
      if (wins(register, state.tuples.get(key))) {
        (state.tuples as Map<string, TupleRegister>).set(key, register);
      }
      return;
    }
    case 'set.add': {
      const member = memberFor(setFor(state, mutation.target), parsed.payload.memberId);
      const tag = mutationAddTag(source.changeSetId, source.mutationIndex);
      const add: OrSetAdd = {
        tag,
        value: cloneCbor(parsed.payload.value),
        order,
        source,
      };
      if (wins(add, member.adds.get(tag))) {
        (member.adds as Map<string, OrSetAdd>).set(tag, add);
      }
      return;
    }
    case 'set.remove': {
      const member = memberFor(setFor(state, mutation.target), parsed.payload.memberId);
      for (const tag of parsed.payload.observedAddTags) {
        const remove: LwwValue<true> = { value: true, order, source };
        if (wins(remove, member.removedAddTags.get(tag))) {
          (member.removedAddTags as Map<string, LwwValue<true>>).set(tag, remove);
        }
      }
      return;
    }
    case 'order.move': {
      const key = orderKey(
        mutation.target.kind,
        mutation.target.incarnation,
        mutation.target.id,
      );
      const register: OrderRegister = {
        target: cloneTarget(mutation.target),
        scope: parsed.payload.scope,
        entityId: mutation.target.id,
        value: parsed.payload.positionKey,
        order,
        source,
      };
      if (wins(register, state.orders.get(key))) {
        (state.orders as Map<string, OrderRegister>).set(key, register);
      }
      return;
    }
    case 'order.rebalance': {
      for (const entry of parsed.payload.entries) {
        const target = { ...mutation.target, id: entry.entityId };
        const key = orderKey(
          target.kind,
          target.incarnation,
          target.id,
        );
        const register: OrderRegister = {
          target,
          scope: parsed.payload.scope,
          entityId: target.id,
          value: entry.positionKey,
          order,
          source,
        };
        if (wins(register, state.orders.get(key))) {
          (state.orders as Map<string, OrderRegister>).set(key, register);
        }
      }
      return;
    }
    case 'entity.create':
    case 'entity.restore': {
      const lifecycle = lifecycleFor(state, mutation.target);
      const seed: LifecycleSeed = {
        action: parsed.action,
        incarnation: mutation.target.incarnation,
        value: cloneRecord(parsed.payload.seed),
        order,
        source,
      };
      const current = lifecycle.seeds.get(mutation.target.incarnation);
      if (wins(seed, current)) {
        (lifecycle.seeds as Map<number, LifecycleSeed>).set(mutation.target.incarnation, seed);
      }
      return;
    }
    case 'entity.trash': {
      const lifecycle = lifecycleFor(state, mutation.target);
      const trash: LwwValue<true> = { value: true, order, source };
      const current = lifecycle.trashes.get(mutation.target.incarnation);
      if (wins(trash, current)) {
        (lifecycle.trashes as Map<number, LwwValue<true>>).set(mutation.target.incarnation, trash);
      }
      return;
    }
    case 'entity.purge': {
      const lifecycle = lifecycleFor(state, mutation.target);
      const purge: LwwValue<true> = { value: true, order, source };
      if (wins(purge, lifecycle.purge)) {
        (lifecycle as { purge: LwwValue<true> | null }).purge = purge;
      }
      return;
    }
  }
}

interface ResolvedLifecycle {
  readonly status: 'live' | 'trashed' | 'purged' | 'unresolved';
  readonly incarnation: number;
  readonly seed: LifecycleSeed | null;
  readonly order: SyncTotalOrderV1 | null;
  readonly source: ReducerSource | null;
}

function resolvedLifecycle(lifecycle: LifecycleState): ResolvedLifecycle {
  if (lifecycle.purge) {
    const highestIncarnation = Math.max(0, ...lifecycle.seeds.keys());
    return {
      status: 'purged',
      incarnation: highestIncarnation,
      seed: null,
      order: lifecycle.purge.order,
      source: lifecycle.purge.source,
    };
  }

  let seed = lifecycle.seeds.get(0) ?? null;
  if (!seed) {
    return {
      status: 'unresolved',
      incarnation: Math.max(0, ...lifecycle.seeds.keys(), ...lifecycle.trashes.keys()),
      seed: null,
      order: null,
      source: null,
    };
  }

  let incarnation = 0;
  while (lifecycle.trashes.has(incarnation) && lifecycle.seeds.has(incarnation + 1)) {
    incarnation += 1;
    seed = lifecycle.seeds.get(incarnation) ?? null;
  }
  const trash = lifecycle.trashes.get(incarnation);
  return trash
    ? {
        status: 'trashed',
        incarnation,
        seed,
        order: trash.order,
        source: trash.source,
      }
    : {
        status: 'live',
        incarnation,
        seed,
        order: seed!.order,
        source: seed!.source,
      };
}

function canMaterializeTarget(
  state: CanonicalReducerState,
  target: Pick<SyncMutationTargetV1, 'kind' | 'id' | 'incarnation'>,
): boolean {
  const owner = lifecycleOwnerTarget(target);
  if (!owner) return true;
  const lifecycle = state.lifecycles.get(entityKey(owner));
  if (!lifecycle) return true;
  const resolved = resolvedLifecycle(lifecycle);
  return resolved.status === 'live' && resolved.incarnation === target.incarnation;
}

function lifecycleOwnerTarget(
  target: Pick<SyncMutationTargetV1, 'kind' | 'id' | 'incarnation'>,
): Pick<SyncMutationTargetV1, 'kind' | 'id'> | null {
  switch (target.kind) {
    case 'node-content':
    case 'node-storyline-primary':
    case 'chapter':
      return { kind: 'node', id: target.id };
    case 'alias':
      return { kind: 'element', id: target.id };
    case 'membership':
      return { kind: 'storyline', id: target.id };
    case 'prose-document': {
      const parsed = parseDocId(target.id);
      if (!parsed || !parsed.entityId) return null;
      if (parsed.kind === 'node-content') return { kind: 'node', id: parsed.entityId };
      if (parsed.kind === 'category') {
        return { kind: 'element-category', id: parsed.entityId };
      }
      return { kind: parsed.kind, id: parsed.entityId };
    }
    case 'sync-generation':
      return null;
    default:
      return { kind: target.kind, id: target.id };
  }
}

function canMaterializeSetMember(
  state: CanonicalReducerState,
  target: SyncMutationTargetV1,
  memberId: string,
): boolean {
  if (!canMaterializeTarget(state, target)) return false;
  if (target.kind !== 'membership') return true;
  const lifecycle = state.lifecycles.get(entityKey({ kind: 'node', id: memberId }));
  return !lifecycle || resolvedLifecycle(lifecycle).status === 'live';
}

function canMaterializeAssetBinding(
  state: CanonicalReducerState,
  register: AssetBindingRegister,
): boolean {
  const parsed = parseProjectAssetMutationV1({
    action: register.value.action,
    target: register.target,
    payload: register.value.payload,
  });
  // Keep malformed external payloads visible to the typed validation kernel;
  // it owns the deterministic semantic conflict for invalid asset metadata.
  if (!parsed.ok) return true;
  const owner = parsed.value.payload.owner;
  const lifecycleOwner = owner.kind === 'element-portrait'
    ? { kind: 'element', id: owner.id }
    : { kind: 'library-item', id: owner.id };
  const lifecycle = state.lifecycles.get(entityKey(lifecycleOwner));
  if (!lifecycle) return true;
  const resolved = resolvedLifecycle(lifecycle);
  return (
    resolved.status === 'live' &&
    resolved.incarnation === register.target.incarnation
  );
}

function visibleAdds(member: OrSetMemberState): readonly OrSetAdd[] {
  return [...member.adds.values()]
    .filter((add) => !member.removedAddTags.has(add.tag))
    .sort((left, right) => compareSyncTotalOrder(left.order, right.order) || utf8Sort(left.tag, right.tag));
}

function winningRemoval(member: OrSetMemberState): LwwValue<true> | null {
  let winner: LwwValue<true> | null = null;
  for (const remove of member.removedAddTags.values()) {
    if (wins(remove, winner)) winner = remove;
  }
  return winner;
}

function sortedMapValues<T>(map: ReadonlyMap<string, T>): readonly T[] {
  return [...map.entries()].sort(([left], [right]) => utf8Sort(left, right)).map(([, value]) => value);
}

export function materializationEffects(state: CanonicalReducerState): readonly ReducerEffect[] {
  const effects: ReducerEffect[] = [];
  if (state.generationPurge) {
    effects.push({
      effectId: effectId('sync-generation-purge', state.identity.syncGenerationId),
      type: 'sync-generation.purge',
      materialize: true,
      target: cloneTarget(state.generationPurge.target),
      payload: cloneCbor(state.generationPurge.value),
      order: state.generationPurge.order,
      source: state.generationPurge.source,
    });
  }
  for (const register of sortedMapValues(state.fields)) {
    effects.push({
      effectId: effectId('field', register.target.kind, register.target.id, register.target.incarnation, register.field),
      type: 'field.set',
      materialize: canMaterializeTarget(state, register.target),
      target: cloneTarget(register.target),
      field: register.field,
      value: cloneCbor(register.value),
      order: register.order,
      source: register.source,
    });
  }
  for (const register of sortedMapValues(state.tuples)) {
    effects.push({
      effectId: effectId('tuple', register.target.kind, register.target.id, register.target.incarnation, register.tuple),
      type: 'tuple.set',
      materialize: canMaterializeTarget(state, register.target),
      target: cloneTarget(register.target),
      tuple: register.tuple,
      value: cloneCbor(register.value),
      order: register.order,
      source: register.source,
    });
  }
  for (const set of sortedMapValues(state.sets)) {
    for (const member of sortedMapValues(set.members)) {
      const visible = visibleAdds(member);
      const winner = visible[visible.length - 1] ?? null;
      const removal = winningRemoval(member);
      effects.push({
        effectId: effectId('set', set.target.kind, set.target.id, set.target.incarnation, member.memberId),
        type: 'set.member',
        materialize: canMaterializeSetMember(state, set.target, member.memberId),
        target: cloneTarget(set.target),
        memberId: member.memberId,
        present: visible.length > 0,
        visibleAddTags: visible.map(({ tag }) => tag).sort(utf8Sort),
        value: winner ? cloneCbor(winner.value) : null,
        order: winner?.order ?? removal?.order ?? null,
        source: winner?.source ?? removal?.source ?? null,
      });
    }
  }
  for (const register of sortedMapValues(state.orders)) {
    effects.push({
      effectId: effectId('order', register.target.kind, register.target.incarnation, register.scope, register.entityId),
      type: 'order.position',
      materialize: canMaterializeTarget(state, register.target),
      target: cloneTarget(register.target),
      scope: register.scope,
      entityId: register.entityId,
      positionKey: register.value,
      order: register.order,
      source: register.source,
    });
  }
  for (const register of sortedMapValues(state.assetBindings)) {
    effects.push({
      effectId: effectId('asset-binding', register.target.kind, register.target.id, register.target.incarnation),
      type: register.value.action,
      materialize: canMaterializeAssetBinding(state, register),
      target: cloneTarget(register.target),
      payload: cloneCbor(register.value.payload),
      order: register.order,
      source: register.source,
    });
  }
  for (const lifecycle of sortedMapValues(state.lifecycles)) {
    const resolved = resolvedLifecycle(lifecycle);
    effects.push({
      effectId: effectId('lifecycle', lifecycle.kind, lifecycle.entityId),
      type: 'entity.lifecycle',
      materialize: resolved.status !== 'unresolved',
      target: {
        family: 'entity',
        kind: lifecycle.kind,
        id: lifecycle.entityId,
        incarnation: resolved.incarnation,
      },
      status: resolved.status,
      seed: resolved.seed ? cloneRecord(resolved.seed.value) : null,
      order: resolved.order,
      source: resolved.source,
    });
  }
  return effects.sort((left, right) => utf8Sort(left.effectId, right.effectId));
}

function conflictFromDraft(draft: SemanticConflictDraft): ReducerConflict {
  return {
    conflictId: JSON.stringify([draft.code, draft.scope]),
    code: draft.code,
    scope: draft.scope,
    message: draft.message,
    target: draft.target
      ? {
          kind: draft.target.kind,
          id: draft.target.id,
          incarnation: draft.target.incarnation ?? null,
        }
      : null,
    details: cloneCbor(draft.details ?? {}),
  };
}

function lifecycleConflictDrafts(state: CanonicalReducerState): readonly SemanticConflictDraft[] {
  if (state.generationPurge) return [];
  const drafts: SemanticConflictDraft[] = [];
  for (const lifecycle of state.lifecycles.values()) {
    if (lifecycle.purge) continue;
    const target = { kind: lifecycle.kind, id: lifecycle.entityId };
    if (!lifecycle.seeds.has(0) && (lifecycle.seeds.size > 0 || lifecycle.trashes.size > 0)) {
      drafts.push({
        code: 'lifecycle.missing-create',
        scope: conflictScope(lifecycle.kind, lifecycle.entityId),
        message: 'entity lifecycle has no incarnation 0 create seed',
        target,
        details: {},
      });
    }
    for (const [incarnation, seed] of lifecycle.seeds) {
      if (seed.action !== 'entity.restore') continue;
      if (!lifecycle.seeds.has(incarnation - 1) || !lifecycle.trashes.has(incarnation - 1)) {
        drafts.push({
          code: 'lifecycle.missing-trash',
          scope: conflictScope(lifecycle.kind, lifecycle.entityId, incarnation),
          message: 'restore does not have a complete trashed predecessor incarnation',
          target: { ...target, incarnation },
          details: { restoredIncarnation: incarnation },
        });
      }
    }
    for (const incarnation of lifecycle.trashes.keys()) {
      if (lifecycle.seeds.has(incarnation)) continue;
      drafts.push({
        code: 'lifecycle.orphan-trash',
        scope: conflictScope(lifecycle.kind, lifecycle.entityId, incarnation),
        message: 'trash references an incarnation with no seed',
        target: { ...target, incarnation },
        details: { trashedIncarnation: incarnation },
      });
    }
  }
  return drafts;
}

function deriveConflicts(
  state: CanonicalReducerState,
  profile: ReducerProfile,
  projection: readonly ReducerEffect[],
): {
  readonly conflicts: ReadonlyMap<string, ReducerConflict>;
  readonly blockedEffectIds: ReadonlySet<string>;
} {
  const drafts = [
    ...lifecycleConflictDrafts(state),
    ...(profile.validateProjection?.(projection) ?? []),
  ];
  const conflicts = new Map<string, ReducerConflict>();
  const blockedEffectIds = new Set<string>();
  for (const draft of drafts) {
    for (const blockedEffectId of draft.blockedEffectIds ?? []) {
      blockedEffectIds.add(blockedEffectId);
    }
    const conflict = conflictFromDraft(draft);
    const existing = conflicts.get(conflict.conflictId);
    if (!existing || utf8Sort(JSON.stringify(conflict), JSON.stringify(existing)) < 0) {
      conflicts.set(conflict.conflictId, conflict);
    }
  }
  return {
    conflicts: new Map([...conflicts.entries()].sort(([left], [right]) => utf8Sort(left, right))),
    blockedEffectIds,
  };
}

function sortedConflicts(conflicts: ReadonlyMap<string, ReducerConflict>): readonly ReducerConflict[] {
  return sortedMapValues(conflicts);
}

export function createCanonicalReducerState(
  identity: ReducerSyncGenerationIdentity,
): CanonicalReducerState {
  return {
    identity: { ...identity },
    receipts: new Map(),
    generationPurge: null,
    fields: new Map(),
    tuples: new Map(),
    sets: new Map(),
    orders: new Map(),
    assetBindings: new Map(),
    lifecycles: new Map(),
    conflicts: new Map(),
  };
}

/**
 * Applies one protocol-validated change-set atomically to the provider-neutral
 * reference reducer. Structural failures reject the whole set. Semantic
 * failures remain in the CRDT metadata and are returned as deterministic
 * conflicts; the reducer never emits repair mutations.
 */
export function reduceSyncChangeSet(
  state: CanonicalReducerState,
  changeSet: ProtocolValidatedChangeSet,
  profile: ReducerProfile,
): ReducerIngestResult {
  const preparation = prepareChangeSet(state, changeSet, profile);
  if (!preparation.ok) return preparation.result;

  const next = cloneState(state);
  for (const prepared of preparation.prepared) applyPreparedMutation(next, prepared);
  (next.receipts as Map<string, string>).set(changeSet.changeSetId, preparation.signature);
  const externalEffects = preparation.prepared
    .map((prepared) => externalEffect(next, prepared))
    .filter((effect): effect is ReducerEffect => effect !== null);
  let candidateEffects = [...materializationEffects(next), ...externalEffects]
    .sort((left, right) => utf8Sort(left.effectId, right.effectId));
  if (next.generationPurge) {
    candidateEffects = candidateEffects.map((effect): ReducerEffect => ({
      ...effect,
      materialize:
        effect.type === 'sync-generation.purge' &&
        effect.source.changeSetId === changeSet.changeSetId &&
        effect.source.mutationIndex === next.generationPurge?.source.mutationIndex,
    }));
  }
  const { conflicts, blockedEffectIds } = deriveConflicts(next, profile, candidateEffects);
  const effects = candidateEffects.map((effect): ReducerEffect =>
    blockedEffectIds.has(effect.effectId) ? { ...effect, materialize: false } : effect,
  );
  const completed: CanonicalReducerState = { ...next, conflicts };
  return {
    status: 'applied',
    state: completed,
    effects,
    conflicts: sortedConflicts(conflicts),
  };
}

function cloneRegister<T extends LwwValue<CanonicalCborValue>>(register: T): T {
  return { ...register, value: cloneCbor(register.value) };
}

export function canonicalReducerSnapshot(state: CanonicalReducerState): ReducerSnapshot {
  return {
    identity: { ...state.identity },
    receipts: [...state.receipts.entries()]
      .sort(([left], [right]) => utf8Sort(left, right))
      .map(([changeSetId, signature]) => ({ changeSetId, signature })),
    generationPurge: state.generationPurge
      ? {
          ...state.generationPurge,
          target: cloneTarget(state.generationPurge.target),
          value: cloneCbor(state.generationPurge.value),
        }
      : null,
    fields: sortedMapValues(state.fields).map((register) => ({
      ...cloneRegister(register),
      target: cloneTarget(register.target),
    })),
    tuples: sortedMapValues(state.tuples).map((register) => ({
      ...cloneRegister(register),
      target: cloneTarget(register.target),
    })),
    sets: sortedMapValues(state.sets).map((set) => ({
      target: cloneTarget(set.target),
      members: [...set.members.entries()]
        .sort(([left], [right]) => utf8Sort(left, right))
        .map(([, member]) => ({
          memberId: member.memberId,
          adds: [...member.adds.entries()]
            .sort(([left], [right]) => utf8Sort(left, right))
            .map(([, add]) => cloneRegister(add) as OrSetAdd),
          removedAddTags: [...member.removedAddTags.entries()]
            .sort(([left], [right]) => utf8Sort(left, right))
            .map(([addTag, remove]) => ({ addTag, ...remove })),
        })),
    })),
    orders: sortedMapValues(state.orders).map((register) => ({
      ...register,
      target: cloneTarget(register.target),
    })),
    assetBindings: sortedMapValues(state.assetBindings).map((register) => ({
      ...register,
      target: cloneTarget(register.target),
      value: {
        action: register.value.action,
        payload: cloneCbor(register.value.payload),
      },
    })),
    lifecycles: sortedMapValues(state.lifecycles).map((lifecycle) => ({
      kind: lifecycle.kind,
      entityId: lifecycle.entityId,
      seeds: [...lifecycle.seeds.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, seed]) => ({ ...seed, value: cloneRecord(seed.value) })),
      trashes: [...lifecycle.trashes.entries()]
        .sort(([left], [right]) => left - right)
        .map(([incarnation, trash]) => ({ ...trash, incarnation })),
      purge: lifecycle.purge ? { ...lifecycle.purge } : null,
    })),
    conflicts: sortedConflicts(state.conflicts).map((conflict) => ({
      ...conflict,
      target: conflict.target ? { ...conflict.target } : null,
      details: cloneCbor(conflict.details),
    })),
  };
}

export interface OrderedSelection {
  readonly entityId: string;
  readonly positionKey: string;
  readonly order: SyncTotalOrderV1;
}

/** Position keys are authoritative; equal keys use entity ID UTF-8 bytes. */
export function selectOrderedEntries(
  state: CanonicalReducerState,
  input: { readonly kind: string; readonly incarnation: number; readonly scope?: string },
): readonly OrderedSelection[] {
  if (state.generationPurge) return [];
  const scope = input.scope ?? '';
  return [...state.orders.values()]
    .filter(
      (register) =>
        register.target.kind === input.kind &&
        register.target.incarnation === input.incarnation &&
        register.scope === scope &&
        canMaterializeTarget(state, register.target),
    )
    .map((register) => ({
      entityId: register.entityId,
      positionKey: register.value,
      order: register.order,
    }))
    .sort(
      (left, right) =>
        utf8Sort(left.positionKey, right.positionKey) || utf8Sort(left.entityId, right.entityId),
    );
}
