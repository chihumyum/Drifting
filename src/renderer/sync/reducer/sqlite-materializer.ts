import { and, eq } from 'drizzle-orm';

import type { DbTransaction } from '../../lib/db';
import {
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
  compareUtf8Bytewise,
  encodeCanonicalCbor,
  type CanonicalCborValue,
  type SyncChangeSetV1,
  type SyncMutationAction,
  type SyncTotalOrderV1,
} from '../protocol';
import { materializationEffects, reduceSyncChangeSet, reducerLifecycleKey } from './reducer';
import type {
  CanonicalReducerState,
  OrSetMemberState,
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

import type { ReducerStateProfileV2 } from './state-pages';
import {
  installSqliteReducerBaseInTransaction,
  loadSqliteReducerStateInTransaction,
  persistSqliteReducerSnapshotIfDue,
  rememberSqliteReducerState,
  SyncReducerRejectedError,
  type StoredReducerState,
} from './state-store';

export {
  deleteSqliteReducerSnapshotsInTransaction,
  getSqliteReducerLoadDiagnostics,
  invalidateSqliteReducerStateCache,
  setSqliteReducerSnapshotIntervalForTest,
  SyncReducerRejectedError,
  type SqliteReducerLoadDiagnostics,
} from './state-store';

export interface SyncDomainMaterializationContext {
  readonly tx: DbTransaction;
  readonly origin: 'local' | 'remote';
  readonly changeSet: Readonly<SyncChangeSetV1>;
  /** Full deterministic projection; effects with materialize=false are evidence only. */
  readonly effects: readonly ReducerEffect[];
  /**
   * Effects whose projection differs from the one last materialized for this
   * SyncGeneration. Null when that projection is unknown (after a rebuild);
   * domain rows must then be converged to the full projection.
   */
  readonly changedEffectIds?: ReadonlySet<string> | null;
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

export class LocalAuthoredSemanticConflictError extends Error {
  constructor(readonly conflicts: readonly ReducerConflict[]) {
    const summary = conflicts
      .map((conflict) => `${conflict.code}@${conflict.target?.kind ?? 'unknown'}:${conflict.target?.id ?? 'unknown'}`)
      .join(', ');
    super(
      summary.length > 0
        ? `local authored transaction failed its post-write domain validation: ${summary}`
        : 'local authored transaction failed its post-write domain validation',
    );
    this.name = 'LocalAuthoredSemanticConflictError';
  }
}

function profileFor(
  profile: ReducerProfile,
  kernel?: SyncDomainMaterializationKernel,
): ReducerProfile {
  const external = new Set(profile.externallyMaterializedActions ?? []);
  for (const action of kernel?.externallyMaterializedActions ?? []) external.add(action);
  return { ...profile, externallyMaterializedActions: external };
}

/**
 * The profile receipt-backed history is replayed under. That history has
 * already passed its owning typed reducer, so core replay retains explicit
 * external actions as no-ops; an incoming change must still be claimed by its
 * kernel. Checkpoints capture and restore state under this same profile.
 */
export function sqliteReplayReducerProfile(
  profile: ReducerProfile = LOCAL_SQLITE_REDUCER_PROFILE,
  kernel?: SyncDomainMaterializationKernel,
): ReducerProfile {
  const replay = profileFor(profile, kernel);
  const external = new Set(replay.externallyMaterializedActions ?? []);
  for (const action of LOCAL_EXTERNAL_ACTIONS) external.add(action);
  return { ...replay, externallyMaterializedActions: external };
}

/**
 * Effects whose deterministic projection differs from the one last
 * materialized. Effects are rebuilt from canonical state on every apply, so
 * structural equality is exact; a removed effect has nothing to materialize.
 */
function changedEffectIds(
  previous: readonly ReducerEffect[],
  next: readonly ReducerEffect[],
): ReadonlySet<string> {
  const before = new Map(previous.map((effect) => [effect.effectId, JSON.stringify(effect)]));
  const changed = new Set<string>();
  for (const effect of next) {
    if (before.get(effect.effectId) !== JSON.stringify(effect)) changed.add(effect.effectId);
  }
  return changed;
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

/**
 * Values of `next` that are not the identical object in `prior`. Registers and
 * nested containers are replaced on write, so identity marks every change.
 */
function changedValues<T>(next: ReadonlyMap<string, T>, prior: ReadonlyMap<string, T> | undefined): T[] {
  if (!prior) return [...next.values()];
  const changed: T[] = [];
  for (const [key, value] of next) if (prior.get(key) !== value) changed.push(value);
  return changed;
}

/**
 * Upserts reducer metadata. With `previous`, only registers and containers
 * the latest change-set replaced are written; every earlier row already holds
 * its value. Without it (a rebuilt state) every row is written, which also
 * repairs metadata that drifted from the journal.
 */
async function persistReducerMetadata(
  tx: DbTransaction,
  input: {
    state: CanonicalReducerState;
    previous: CanonicalReducerState | null;
    effects: readonly ReducerEffect[];
    conflicts: readonly OwnedReducerConflict[];
    domainValidationRan: boolean;
    nowIso: string;
  },
): Promise<void> {
  const { state, previous } = input;
  if (state.generationPurge && state.generationPurge !== previous?.generationPurge) {
    const values = {
      syncGenerationId: state.identity.syncGenerationId,
      ...clockColumns(state.generationPurge.order, state.generationPurge.source),
    };
    await tx.insert(SyncGenerationPurgeTable).values(values).onConflictDoUpdate({
      target: SyncGenerationPurgeTable.syncGenerationId,
      set: clockColumns(state.generationPurge.order, state.generationPurge.source),
    });
  }
  for (const register of changedValues(state.fields, previous?.fields)) {
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
  for (const register of changedValues(state.tuples, previous?.tuples)) {
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
  for (const [setKey, set] of state.sets) {
    const priorSet = previous?.sets.get(setKey);
    if (previous && priorSet === set) continue;
    const priorMembers = previous ? (priorSet?.members ?? new Map<string, OrSetMemberState>()) : undefined;
    for (const member of changedValues(set.members, priorMembers)) {
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
  for (const register of changedValues(state.orders, previous?.orders)) {
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
  const lifecycleEffects = input.effects
    .filter((effect): effect is Extract<ReducerEffect, { type: 'entity.lifecycle' }> =>
      effect.type === 'entity.lifecycle' && effect.status !== 'unresolved' && !!effect.order && !!effect.source,
    )
    .filter((effect) => {
      if (!previous) return true;
      const key = reducerLifecycleKey(effect.target.kind, effect.target.id);
      return previous.lifecycles.get(key) !== state.lifecycles.get(key);
    });
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
  const replayProfile = sqliteReplayReducerProfile(input.profile, input.kernel);
  const identity = {
    projectId: input.changeSet.projectId,
    projectSyncId: input.changeSet.projectSyncId,
    syncGenerationId: input.changeSet.syncGenerationId,
  };
  const loaded = await loadSqliteReducerStateInTransaction(
    tx,
    identity,
    replayProfile,
    input.changeSet.changeSetId,
  );
  const prior = loaded.state;
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
  const nextContext: SyncDomainMaterializationContext = {
    ...context,
    effects: validated.effects,
    changedEffectIds: loaded.effects ? changedEffectIds(loaded.effects, validated.effects) : null,
  };

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
    previous: loaded.rebuilt ? null : prior,
    effects: reduced.effects,
    conflicts: validated.ownedConflicts,
    domainValidationRan: input.kernel !== undefined,
    nowIso: input.clock.nowIso,
  });
  const stored: StoredReducerState = {
    state: reduced.state,
    receiptRows: loaded.receiptRows + 1,
    effects: validated.effects,
  };
  await persistSqliteReducerSnapshotIfDue(tx, identity, replayProfile, stored, input.clock.nowIso);
  // Top-level renderer transactions are serialized by the DB gateway.
  rememberSqliteReducerState(identity, replayProfile, stored, {
    state: loaded.state,
    receiptRows: loaded.receiptRows,
    effects: loaded.effects,
  });
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

/**
 * Installs a verified compacted state from a payload v2 checkpoint: every
 * reducer metadata row it implies, and the state itself as the SyncGeneration's
 * authoritative base. History it covers is not present locally.
 */
export async function installRestoredSqliteReducerStateInTransaction(
  tx: DbTransaction,
  input: {
    readonly state: CanonicalReducerState;
    readonly profile: ReducerStateProfileV2;
    readonly pages: readonly Uint8Array[];
    readonly sourceCheckpointId: string;
    readonly nowIso: string;
  },
): Promise<void> {
  await persistReducerMetadata(tx, {
    state: input.state,
    previous: null,
    effects: materializationEffects(input.state),
    conflicts: [...input.state.conflicts.values()].map((conflict) => ({ owner: 'core' as const, conflict })),
    domainValidationRan: false,
    nowIso: input.nowIso,
  });
  await installSqliteReducerBaseInTransaction(tx, {
    syncGenerationId: input.state.identity.syncGenerationId,
    profile: input.profile,
    pages: input.pages,
    sourceCheckpointId: input.sourceCheckpointId,
    nowIso: input.nowIso,
  });
}
