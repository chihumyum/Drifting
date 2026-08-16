import { and, count, eq } from 'drizzle-orm';

import type { DbTransaction } from '../../lib/db';
import {
  SyncApplyReceiptTable,
  SyncChangeSetTable,
  SyncConflictTable,
  SyncEntityLifecycleTable,
  SyncFieldClockTable,
  SyncOrderRegisterTable,
  SyncSetTagTable,
  SyncGenerationPurgeTable,
} from '../../schema/drizzle';
import {
  completeRemoteApplyInTransaction,
  stageRemoteChangeSetInTransaction,
  type CompleteRemoteApplyInput,
  type RecordedSyncChangeSet,
} from '../journal/repository';
import type { SyncJournalClock, SyncWriterIdentitySource } from '../journal/writer-state';
import {
  compareSyncTotalOrder,
  compareUtf8Bytewise,
  decodeSyncChangeSetV1,
  encodeCanonicalCbor,
  type CanonicalCborValue,
  type SyncChangeSetV1,
  type SyncMutationAction,
  type SyncTotalOrderV1,
} from '../protocol';
import {
  createCanonicalReducerState,
  materializationEffects,
  reduceSyncChangeSet,
} from './reducer';
import type {
  CanonicalReducerState,
  ReducerConflict,
  ReducerEffect,
  ReducerProfile,
  SemanticConflictDraft,
} from './types';

/**
 * Frozen target vocabulary used by the current authored journal. Extending a
 * project-scoped domain kind requires changing this list and its manifest in
 * the same change; deriving it from incoming bytes would defeat fail-closed
 * classification.
 */
export const SQLITE_REDUCER_V1_TARGET_KINDS = new Set([
  'project',
  'node',
  'node-content',
  'storyline',
  'node-storyline-primary',
  'element',
  'element-category',
  'element-patch',
  'library-item',
  'entity-relation',
  'entity-relation-type',
  'comment',
  'comment-action',
  'agent-memory',
  'book-act',
  'drift-group',
  'timeline-marker',
  'membership',
  'alias',
  'kv-entry',
  'plot-grid-row',
  'plot-grid-column',
  'plot-grid-cell',
  'chapter',
  'prose-document',
  'project-asset',
  'sync-generation',
] as const);

const LOCAL_EXTERNAL_ACTIONS = new Set<SyncMutationAction>([
  'yjs.update',
  'asset.bind',
  'asset.unbind',
  'sync-generation.purge',
]);

export const DEFAULT_SQLITE_REDUCER_PROFILE: ReducerProfile = Object.freeze({
  knownTargetKinds: SQLITE_REDUCER_V1_TARGET_KINDS,
});

export const LOCAL_SQLITE_REDUCER_PROFILE: ReducerProfile = Object.freeze({
  knownTargetKinds: SQLITE_REDUCER_V1_TARGET_KINDS,
  externallyMaterializedActions: LOCAL_EXTERNAL_ACTIONS,
});

const reducerStateCache = new Map<string, CanonicalReducerState>();
const reducerValidatorIds = new WeakMap<NonNullable<ReducerProfile['validateProjection']>, number>();
let nextReducerValidatorId = 1;

function reducerCacheKey(identity: {
  projectId: string;
  projectSyncId: string;
  syncGenerationId: string;
}, profile: ReducerProfile): string {
  const validator = profile.validateProjection;
  let validatorId = 0;
  if (validator) {
    validatorId = reducerValidatorIds.get(validator) ?? nextReducerValidatorId++;
    reducerValidatorIds.set(validator, validatorId);
  }
  return JSON.stringify([
    identity.projectId,
    identity.projectSyncId,
    identity.syncGenerationId,
    [...profile.knownTargetKinds].sort(compareUtf8Bytewise),
    [...(profile.externallyMaterializedActions ?? [])].sort(compareUtf8Bytewise),
    validatorId,
  ]);
}

/** Checkpoint activation/database reset must invalidate the affected SyncGeneration. */
export function invalidateSqliteReducerStateCache(syncGenerationId?: string): void {
  if (syncGenerationId === undefined) {
    reducerStateCache.clear();
    return;
  }
  for (const [key, state] of reducerStateCache) {
    if (state.identity.syncGenerationId === syncGenerationId) reducerStateCache.delete(key);
  }
}

export interface SyncDomainMaterializationContext {
  readonly tx: DbTransaction;
  readonly origin: 'local' | 'remote';
  readonly changeSet: Readonly<SyncChangeSetV1>;
  /** Full deterministic projection; effects with materialize=false are evidence only. */
  readonly effects: readonly ReducerEffect[];
}

/**
 * The only seam allowed to mutate domain rows for a remote change-set.
 * Implementations must call the same typed domain use cases/validators as UI
 * writes; the SQLite materializer itself writes only sync_* metadata.
 */
export interface SyncDomainMaterializationKernel {
  readonly externallyMaterializedActions?: ReadonlySet<SyncMutationAction>;
  validate(
    context: SyncDomainMaterializationContext,
  ): Promise<readonly SemanticConflictDraft[]>;
  /** Rebuild local-only/query projections after an authored domain write. */
  materializeDerived?(context: SyncDomainMaterializationContext): Promise<void>;
  materialize(context: SyncDomainMaterializationContext): Promise<void>;
}

export interface SqliteReducerApplyResult {
  readonly status: 'applied' | 'duplicate';
  readonly changeSet: Readonly<SyncChangeSetV1>;
  readonly state: CanonicalReducerState | null;
  readonly effects: readonly ReducerEffect[];
  readonly conflicts: readonly ReducerConflict[];
  readonly journal: RecordedSyncChangeSet;
}

export class SyncReducerRejectedError extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
    message: string,
  ) {
    super(`sync reducer rejected ${code} at ${path}: ${message}`);
    this.name = 'SyncReducerRejectedError';
  }
}

export class LocalAuthoredSemanticConflictError extends Error {
  constructor(readonly conflicts: readonly ReducerConflict[]) {
    super('local authored transaction failed its post-write domain validation');
    this.name = 'LocalAuthoredSemanticConflictError';
  }
}

function changeSetOrder(changeSet: SyncChangeSetV1): SyncTotalOrderV1 {
  return {
    hlc: changeSet.hlc,
    writerId: changeSet.writerId,
    writerEpoch: changeSet.writerEpoch,
    deviceSeq: changeSet.deviceSeq,
    mutationIndex: 0,
  };
}

function compareChangeSets(left: SyncChangeSetV1, right: SyncChangeSetV1): number {
  return (
    compareSyncTotalOrder(changeSetOrder(left), changeSetOrder(right)) ||
    compareUtf8Bytewise(left.changeSetId, right.changeSetId)
  );
}

function profileFor(
  profile: ReducerProfile,
  kernel?: SyncDomainMaterializationKernel,
): ReducerProfile {
  const external = new Set(profile.externallyMaterializedActions ?? []);
  for (const action of kernel?.externallyMaterializedActions ?? []) external.add(action);
  return { ...profile, externallyMaterializedActions: external };
}

async function loadAppliedReducerState(
  tx: DbTransaction,
  identity: { projectId: string; projectSyncId: string; syncGenerationId: string },
  profile: ReducerProfile,
  excludeChangeSetId: string,
): Promise<CanonicalReducerState> {
  const cacheKey = reducerCacheKey(identity, profile);
  const [receiptCount] = await tx
    .select({ value: count() })
    .from(SyncApplyReceiptTable)
    .where(eq(SyncApplyReceiptTable.syncGenerationId, identity.syncGenerationId));
  const currentReceipt = await tx
    .select({ changeSetId: SyncApplyReceiptTable.changeSetId })
    .from(SyncApplyReceiptTable)
    .where(
      and(
        eq(SyncApplyReceiptTable.syncGenerationId, identity.syncGenerationId),
        eq(SyncApplyReceiptTable.changeSetId, excludeChangeSetId),
      ),
    )
    .limit(1);
  const expectedReceiptCount = Number(receiptCount?.value ?? 0) - currentReceipt.length;
  const cached = reducerStateCache.get(cacheKey);
  if (cached && cached.receipts.size === expectedReceiptCount) return cached;

  const rows = await tx
    .select({
      changeSetId: SyncChangeSetTable.changeSetId,
      encodedBytes: SyncChangeSetTable.encodedBytes,
    })
    .from(SyncChangeSetTable)
    .innerJoin(
      SyncApplyReceiptTable,
      and(
        eq(SyncApplyReceiptTable.changeSetId, SyncChangeSetTable.changeSetId),
        eq(SyncApplyReceiptTable.syncGenerationId, SyncChangeSetTable.syncGenerationId),
      ),
    )
    .where(eq(SyncChangeSetTable.syncGenerationId, identity.syncGenerationId));

  const changeSets: SyncChangeSetV1[] = [];
  for (const row of rows) {
    if (row.changeSetId === excludeChangeSetId) continue;
    const decoded = await decodeSyncChangeSetV1(row.encodedBytes as Uint8Array);
    if (!decoded.ok) {
      throw new SyncReducerRejectedError(
        'stored-change-set-invalid',
        `/sync_change_set/${row.changeSetId}`,
        decoded.reason,
      );
    }
    changeSets.push(decoded.value);
  }
  changeSets.sort(compareChangeSets);

  let state = createCanonicalReducerState(identity);
  for (const changeSet of changeSets) {
    const reduced = reduceSyncChangeSet(state, changeSet, profile);
    if (reduced.status === 'rejected') {
      throw new SyncReducerRejectedError(
        reduced.rejection.code,
        reduced.rejection.path,
        reduced.rejection.message,
      );
    }
    state = reduced.state;
  }
  reducerStateCache.set(cacheKey, state);
  return state;
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
    details: draft.details ?? {},
  };
}

interface OwnedReducerConflict {
  readonly owner: 'core' | 'domain';
  readonly conflict: ReducerConflict;
}

function mergeValidation(
  effects: readonly ReducerEffect[],
  baseConflicts: readonly ReducerConflict[],
  drafts: readonly SemanticConflictDraft[],
): {
  effects: readonly ReducerEffect[];
  conflicts: readonly ReducerConflict[];
  ownedConflicts: readonly OwnedReducerConflict[];
} {
  const blocked = new Set(drafts.flatMap((draft) => [...(draft.blockedEffectIds ?? [])]));
  const conflicts = new Map<string, OwnedReducerConflict>(baseConflicts.map((conflict) => [
    conflict.conflictId,
    { owner: 'core', conflict },
  ]));
  for (const draft of drafts) {
    const conflict = conflictFromDraft(draft);
    const current = conflicts.get(conflict.conflictId);
    if (
      !current ||
      compareUtf8Bytewise(JSON.stringify(conflict), JSON.stringify(current.conflict)) < 0
    ) {
      conflicts.set(conflict.conflictId, { owner: 'domain', conflict });
    }
  }
  const ownedConflicts = [...conflicts.values()].sort((left, right) =>
    compareUtf8Bytewise(left.conflict.conflictId, right.conflict.conflictId),
  );
  return {
    effects: effects.map((effect) =>
      blocked.has(effect.effectId) ? { ...effect, materialize: false } : effect,
    ),
    conflicts: ownedConflicts.map(({ conflict }) => conflict),
    ownedConflicts,
  };
}

function clockColumns(order: SyncTotalOrderV1, source: { changeSetId: string; mutationIndex: number }) {
  return {
    hlcWallMs: order.hlc.wallMs,
    hlcCounter: order.hlc.counter,
    writerId: order.writerId,
    writerEpoch: order.writerEpoch,
    deviceSeq: order.deviceSeq,
    changeSetId: source.changeSetId,
    mutationIndex: source.mutationIndex,
  };
}

async function persistReducerMetadata(
  tx: DbTransaction,
  input: {
    state: CanonicalReducerState;
    conflicts: readonly OwnedReducerConflict[];
    domainValidationRan: boolean;
    nowIso: string;
  },
): Promise<void> {
  const { state } = input;
  if (state.generationPurge) {
    const values = {
      syncGenerationId: state.identity.syncGenerationId,
      ...clockColumns(state.generationPurge.order, state.generationPurge.source),
    };
    await tx.insert(SyncGenerationPurgeTable).values(values).onConflictDoUpdate({
      target: SyncGenerationPurgeTable.syncGenerationId,
      set: clockColumns(state.generationPurge.order, state.generationPurge.source),
    });
  }
  for (const register of state.fields.values()) {
    const values = {
      syncGenerationId: state.identity.syncGenerationId,
      targetKind: register.target.kind,
      targetId: register.target.id,
      incarnation: register.target.incarnation,
      fieldKey: `field:${register.field}`,
      ...clockColumns(register.order, register.source),
    };
    await tx.insert(SyncFieldClockTable).values(values).onConflictDoUpdate({
      target: [
        SyncFieldClockTable.syncGenerationId,
        SyncFieldClockTable.targetKind,
        SyncFieldClockTable.targetId,
        SyncFieldClockTable.incarnation,
        SyncFieldClockTable.fieldKey,
      ],
      set: clockColumns(register.order, register.source),
    });
  }
  for (const register of state.tuples.values()) {
    const values = {
      syncGenerationId: state.identity.syncGenerationId,
      targetKind: register.target.kind,
      targetId: register.target.id,
      incarnation: register.target.incarnation,
      fieldKey: `tuple:${register.tuple}`,
      ...clockColumns(register.order, register.source),
    };
    await tx.insert(SyncFieldClockTable).values(values).onConflictDoUpdate({
      target: [
        SyncFieldClockTable.syncGenerationId,
        SyncFieldClockTable.targetKind,
        SyncFieldClockTable.targetId,
        SyncFieldClockTable.incarnation,
        SyncFieldClockTable.fieldKey,
      ],
      set: clockColumns(register.order, register.source),
    });
  }
  for (const set of state.sets.values()) {
    for (const member of set.members.values()) {
      for (const add of member.adds.values()) {
        const remove = member.removedAddTags.get(add.tag);
        const values = {
          syncGenerationId: state.identity.syncGenerationId,
          ownerKind: set.target.kind,
          ownerId: set.target.id,
          incarnation: set.target.incarnation,
          // `alias` is the reducer target vocabulary; `aliases` is the named
          // authored set on an element and therefore the persisted set key.
          setKey: set.target.kind === 'alias' ? 'aliases' : set.target.kind,
          valueKey: member.memberId,
          valueCbor: encodeCanonicalCbor(add.value),
          addTag: add.tag,
          addChangeSetId: add.source.changeSetId,
          addMutationIndex: add.source.mutationIndex,
          removedByChangeSetId: remove?.source.changeSetId,
          removedByMutationIndex: remove?.source.mutationIndex,
        };
        await tx.insert(SyncSetTagTable).values(values).onConflictDoUpdate({
          target: [
            SyncSetTagTable.syncGenerationId,
            SyncSetTagTable.ownerKind,
            SyncSetTagTable.ownerId,
            SyncSetTagTable.incarnation,
            SyncSetTagTable.setKey,
            SyncSetTagTable.valueKey,
            SyncSetTagTable.addTag,
          ],
          set: {
            valueCbor: values.valueCbor,
            removedByChangeSetId: values.removedByChangeSetId,
            removedByMutationIndex: values.removedByMutationIndex,
          },
        });
      }
    }
  }
  for (const register of state.orders.values()) {
    const values = {
      syncGenerationId: state.identity.syncGenerationId,
      listKind: register.target.kind,
      ownerId: register.scope,
      entityId: register.entityId,
      incarnation: register.target.incarnation,
      positionKey: register.value,
      ...clockColumns(register.order, register.source),
    };
    await tx.insert(SyncOrderRegisterTable).values(values).onConflictDoUpdate({
      target: [
        SyncOrderRegisterTable.syncGenerationId,
        SyncOrderRegisterTable.listKind,
        SyncOrderRegisterTable.entityId,
        SyncOrderRegisterTable.incarnation,
      ],
      set: {
        ownerId: values.ownerId,
        positionKey: values.positionKey,
        ...clockColumns(register.order, register.source),
      },
    });
  }
  // Lifecycle rows are the current projection; unresolved histories stay only
  // in the immutable journal + conflict table until their missing seed arrives.
  const lifecycleEffects = materializationEffects(state)
    .filter((effect): effect is Extract<ReducerEffect, { type: 'entity.lifecycle' }> =>
      effect.type === 'entity.lifecycle' && effect.status !== 'unresolved' && !!effect.order && !!effect.source,
    );
  for (const effect of lifecycleEffects) {
    const values = {
      syncGenerationId: state.identity.syncGenerationId,
      entityKind: effect.target.kind,
      entityId: effect.target.id,
      incarnation: effect.target.incarnation,
      state: effect.status as 'live' | 'trashed' | 'purged',
      ...clockColumns(effect.order!, effect.source!),
    };
    await tx.insert(SyncEntityLifecycleTable).values(values).onConflictDoUpdate({
      target: [
        SyncEntityLifecycleTable.syncGenerationId,
        SyncEntityLifecycleTable.entityKind,
        SyncEntityLifecycleTable.entityId,
      ],
      set: {
        incarnation: values.incarnation,
        state: values.state,
        ...clockColumns(effect.order!, effect.source!),
      },
    });
  }

  const activeStoredIds = new Set<string>();
  for (const owned of input.conflicts) {
    const { conflict } = owned;
    const conflictId = JSON.stringify([
      'reducer',
      owned.owner,
      state.identity.syncGenerationId,
      conflict.conflictId,
    ]);
    activeStoredIds.add(conflictId);
    const details: CanonicalCborValue = {
      code: conflict.code,
      scope: conflict.scope,
      message: conflict.message,
      details: conflict.details,
    };
    await tx.insert(SyncConflictTable).values({
      conflictId,
      syncGenerationId: state.identity.syncGenerationId,
      kind: conflict.code.startsWith('lifecycle.') ? 'invariant' : 'semantic',
      targetKind: conflict.target?.kind,
      targetId: conflict.target?.id,
      incarnation: conflict.target?.incarnation,
      detailsCbor: encodeCanonicalCbor(details),
      state: 'open',
      createdAt: input.nowIso,
    }).onConflictDoNothing();
  }

  const storedConflicts = await tx
    .select({ conflictId: SyncConflictTable.conflictId, state: SyncConflictTable.state })
    .from(SyncConflictTable)
    .where(eq(SyncConflictTable.syncGenerationId, state.identity.syncGenerationId));
  for (const stored of storedConflicts) {
    const coreOwned = stored.conflictId.startsWith('["reducer","core",');
    const domainOwned = stored.conflictId.startsWith('["reducer","domain",');
    if (
      stored.state !== 'open' ||
      (!coreOwned && !(domainOwned && input.domainValidationRan)) ||
      activeStoredIds.has(stored.conflictId)
    ) continue;
    await tx.update(SyncConflictTable).set({
      state: 'resolved',
      resolutionCbor: encodeCanonicalCbor({ reason: 'canonical-state-valid' }),
      resolvedAt: input.nowIso,
    }).where(
      and(
        eq(SyncConflictTable.conflictId, stored.conflictId),
        eq(SyncConflictTable.state, 'open'),
      ),
    );
  }
}

async function reduceAndPersist(
  tx: DbTransaction,
  input: {
    changeSet: SyncChangeSetV1;
    origin: 'local' | 'remote';
    clock: SyncJournalClock;
    profile: ReducerProfile;
    kernel?: SyncDomainMaterializationKernel;
  },
): Promise<{
  state: CanonicalReducerState;
  effects: readonly ReducerEffect[];
  conflicts: readonly ReducerConflict[];
}> {
  const profile = profileFor(input.profile, input.kernel);
  // Receipt-backed history has already passed its owning typed reducer. Core
  // replay may therefore retain those explicit external actions as no-ops,
  // while the incoming remote change still must be claimed by this kernel.
  const replayExternal = new Set(profile.externallyMaterializedActions ?? []);
  for (const action of LOCAL_EXTERNAL_ACTIONS) replayExternal.add(action);
  const replayProfile = { ...profile, externallyMaterializedActions: replayExternal };
  const prior = await loadAppliedReducerState(
    tx,
    {
      projectId: input.changeSet.projectId,
      projectSyncId: input.changeSet.projectSyncId,
      syncGenerationId: input.changeSet.syncGenerationId,
    },
    replayProfile,
    input.changeSet.changeSetId,
  );
  const reduced = reduceSyncChangeSet(prior, input.changeSet, profile);
  if (reduced.status === 'rejected') {
    throw new SyncReducerRejectedError(
      reduced.rejection.code,
      reduced.rejection.path,
      reduced.rejection.message,
    );
  }
  if (reduced.status === 'duplicate') {
    throw new Error('current change-set was unexpectedly present in reducer replay state');
  }

  const context: SyncDomainMaterializationContext = {
    tx,
    origin: input.origin,
    changeSet: input.changeSet,
    effects: reduced.effects,
  };
  const drafts = input.kernel ? await input.kernel.validate(context) : [];
  const validated = mergeValidation(reduced.effects, reduced.conflicts, drafts);
  const nextContext = { ...context, effects: validated.effects };

  if (input.origin === 'local') {
    const priorConflicts = new Set(prior.conflicts.keys());
    const newlyBlocked = validated.conflicts.filter((conflict) => !priorConflicts.has(conflict.conflictId));
    if (newlyBlocked.length > 0 || validated.effects.some((effect) =>
      !effect.materialize && 'source' in effect && effect.source?.changeSetId === input.changeSet.changeSetId,
    )) {
      throw new LocalAuthoredSemanticConflictError(newlyBlocked);
    }
    await input.kernel?.materializeDerived?.(nextContext);
  } else {
    if (!input.kernel) {
      throw new Error('remote reducer requires a typed domain materialization kernel');
    }
    await input.kernel.materialize(nextContext);
  }

  await persistReducerMetadata(tx, {
    state: reduced.state,
    conflicts: validated.ownedConflicts,
    domainValidationRan: input.kernel !== undefined,
    nowIso: input.clock.nowIso,
  });
  // This optimistic cache write is rollback-safe: the next transaction checks
  // its receipt count first and rebuilds if this outer transaction did not
  // commit. Top-level renderer transactions are serialized by the DB gateway.
  reducerStateCache.set(reducerCacheKey(reduced.state.identity, replayProfile), reduced.state);
  return { state: reduced.state, ...validated };
}

/** Observe domain rows already written by a local authored transaction. */
export async function observeLocalAuthoredReducerInTransaction(
  tx: DbTransaction,
  input: {
    changeSet: SyncChangeSetV1;
    clock: SyncJournalClock;
    profile?: ReducerProfile;
    validator?: SyncDomainMaterializationKernel;
  },
): Promise<Omit<SqliteReducerApplyResult, 'journal' | 'status'>> {
  const reduced = await reduceAndPersist(tx, {
    changeSet: input.changeSet,
    origin: 'local',
    clock: input.clock,
    profile: input.profile ?? LOCAL_SQLITE_REDUCER_PROFILE,
    kernel: input.validator,
  });
  return { changeSet: input.changeSet, ...reduced };
}

/** Stage → validate/reduce/materialize → advance HLC/receipt in one caller-owned tx. */
export async function applyVerifiedRemoteChangeSetInTransaction(
  tx: DbTransaction,
  input: {
    changeSet: SyncChangeSetV1;
    identity: SyncWriterIdentitySource;
    clock: SyncJournalClock;
    kernel: SyncDomainMaterializationKernel;
    profile?: ReducerProfile;
    sourceObjectId?: string;
  },
): Promise<SqliteReducerApplyResult> {
  const staged = await stageRemoteChangeSetInTransaction(tx, {
    changeSet: input.changeSet,
    clock: input.clock,
  });
  if (staged.alreadyApplied) {
    return {
      status: 'duplicate',
      changeSet: input.changeSet,
      state: null,
      effects: [],
      conflicts: [],
      journal: staged,
    };
  }

  const reduced = await reduceAndPersist(tx, {
    changeSet: input.changeSet,
    origin: 'remote',
    clock: input.clock,
    profile: input.profile ?? DEFAULT_SQLITE_REDUCER_PROFILE,
    kernel: input.kernel,
  });
  const completion: CompleteRemoteApplyInput = {
    changeSet: input.changeSet,
    identity: input.identity,
    clock: input.clock,
    sourceObjectId: input.sourceObjectId,
  };
  const journal = await completeRemoteApplyInTransaction(tx, { ...completion, staged });
  return {
    status: 'applied',
    changeSet: input.changeSet,
    ...reduced,
    journal,
  };
}
