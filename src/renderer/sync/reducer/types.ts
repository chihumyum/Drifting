import type {
  CanonicalCborValue,
  SyncChangeSetV1,
  SyncMutationAction,
  SyncMutationTargetV1,
  SyncTotalOrderV1,
} from '../protocol';

export interface ReducerSyncGenerationIdentity {
  readonly projectId: string;
  readonly projectSyncId: string;
  readonly syncGenerationId: string;
}

export interface ReducerSource {
  readonly changeSetId: string;
  readonly mutationIndex: number;
}

export interface LwwValue<T> {
  readonly value: T;
  readonly order: SyncTotalOrderV1;
  readonly source: ReducerSource;
}

export interface FieldRegister extends LwwValue<CanonicalCborValue> {
  readonly target: Readonly<SyncMutationTargetV1>;
  readonly field: string;
}

export interface TupleRegister extends LwwValue<CanonicalCborValue> {
  readonly target: Readonly<SyncMutationTargetV1>;
  readonly tuple: string;
}

export interface OrSetAdd extends LwwValue<CanonicalCborValue> {
  readonly tag: string;
}

export interface OrSetMemberState {
  readonly memberId: string;
  readonly adds: ReadonlyMap<string, OrSetAdd>;
  /**
   * A remove is monotonic, but the source still matters to the durable SQLite
   * projection. Keeping the winning remover makes metadata converge even when
   * two devices observe the same removes in a different delivery order.
   */
  readonly removedAddTags: ReadonlyMap<string, LwwValue<true>>;
}

export interface OrSetState {
  readonly target: Readonly<SyncMutationTargetV1>;
  readonly members: ReadonlyMap<string, OrSetMemberState>;
}

export interface OrderRegister extends LwwValue<string> {
  readonly target: Readonly<SyncMutationTargetV1>;
  readonly scope: string;
  readonly entityId: string;
}

export interface AssetBindingRegister extends LwwValue<{
  readonly action: 'asset.bind' | 'asset.unbind';
  readonly payload: CanonicalCborValue;
}> {
  readonly target: Readonly<SyncMutationTargetV1>;
}

/**
 * SyncGeneration purge is a projectSync-local terminal register. Once present, every
 * non-purge mutation remains receipted evidence but can never materialize
 * domain state again.
 */
export interface SyncGenerationPurgeRegister extends LwwValue<CanonicalCborValue> {
  readonly target: Readonly<SyncMutationTargetV1>;
}

export interface LifecycleSeed extends LwwValue<Readonly<Record<string, CanonicalCborValue>>> {
  readonly action: 'entity.create' | 'entity.restore';
  readonly incarnation: number;
}

export interface LifecycleState {
  readonly kind: string;
  readonly entityId: string;
  readonly seeds: ReadonlyMap<number, LifecycleSeed>;
  readonly trashes: ReadonlyMap<number, LwwValue<true>>;
  readonly purge: LwwValue<true> | null;
}

export type ReducerConflictCode =
  | 'lifecycle.missing-create'
  | 'lifecycle.missing-trash'
  | 'lifecycle.orphan-trash'
  | 'semantic.invalid-output';

export interface ReducerConflict {
  readonly conflictId: string;
  readonly code: ReducerConflictCode | (string & {});
  readonly scope: string;
  readonly message: string;
  readonly target: {
    readonly kind: string;
    readonly id: string;
    readonly incarnation: number | null;
  } | null;
  readonly details: CanonicalCborValue;
}

export interface CanonicalReducerState {
  readonly identity: ReducerSyncGenerationIdentity;
  readonly receipts: ReadonlyMap<string, string>;
  readonly generationPurge: SyncGenerationPurgeRegister | null;
  readonly fields: ReadonlyMap<string, FieldRegister>;
  readonly tuples: ReadonlyMap<string, TupleRegister>;
  readonly sets: ReadonlyMap<string, OrSetState>;
  readonly orders: ReadonlyMap<string, OrderRegister>;
  readonly assetBindings: ReadonlyMap<string, AssetBindingRegister>;
  readonly lifecycles: ReadonlyMap<string, LifecycleState>;
  readonly conflicts: ReadonlyMap<string, ReducerConflict>;
}

export interface ReducerProfile {
  /**
   * The domain manifest owns this allowlist. Requiring it here makes an
   * unclassified target kind an atomic rejection instead of a partial apply.
   */
  readonly knownTargetKinds: ReadonlySet<string>;
  /**
   * Actions owned by a different typed reducer (currently Yjs/assets/generation)
   * may participate in the same atomic change-set. They are accepted only
   * when the composing domain kernel explicitly claims them; otherwise the
   * reference reducer fails closed.
   */
  readonly externallyMaterializedActions?: ReadonlySet<SyncMutationAction>;
  readonly validateProjection?: (
    projection: readonly ReducerEffect[],
  ) => readonly SemanticConflictDraft[];
}

export interface SemanticConflictDraft {
  readonly code: string;
  readonly scope: string;
  readonly message: string;
  readonly target?: {
    readonly kind: string;
    readonly id: string;
    readonly incarnation?: number | null;
  };
  readonly details?: CanonicalCborValue;
  /** Effects named here stay in reducer metadata but must not reach domain rows. */
  readonly blockedEffectIds?: readonly string[];
}

interface MaterializationEffectBase {
  readonly effectId: string;
  readonly materialize: boolean;
}

export type ReducerEffect =
  | (MaterializationEffectBase & {
      readonly type: 'field.set';
      readonly target: Readonly<SyncMutationTargetV1>;
      readonly field: string;
      readonly value: CanonicalCborValue;
      readonly order: SyncTotalOrderV1;
      readonly source: ReducerSource;
    })
  | (MaterializationEffectBase & {
      readonly type: 'tuple.set';
      readonly target: Readonly<SyncMutationTargetV1>;
      readonly tuple: string;
      readonly value: CanonicalCborValue;
      readonly order: SyncTotalOrderV1;
      readonly source: ReducerSource;
    })
  | (MaterializationEffectBase & {
      readonly type: 'set.member';
      readonly target: Readonly<SyncMutationTargetV1>;
      readonly memberId: string;
      readonly present: boolean;
      readonly visibleAddTags: readonly string[];
      readonly value: CanonicalCborValue | null;
      readonly order: SyncTotalOrderV1 | null;
      readonly source: ReducerSource | null;
    })
  | (MaterializationEffectBase & {
      readonly type: 'order.position';
      readonly target: Readonly<SyncMutationTargetV1>;
      readonly scope: string;
      readonly entityId: string;
      readonly positionKey: string;
      readonly order: SyncTotalOrderV1;
      readonly source: ReducerSource;
    })
  | (MaterializationEffectBase & {
      readonly type: 'entity.lifecycle';
      readonly target: {
        readonly family: 'entity';
        readonly kind: string;
        readonly id: string;
        readonly incarnation: number;
      };
      readonly status: 'live' | 'trashed' | 'purged' | 'unresolved';
      readonly seed: Readonly<Record<string, CanonicalCborValue>> | null;
      readonly order: SyncTotalOrderV1 | null;
      readonly source: ReducerSource | null;
    })
  | (MaterializationEffectBase & {
      readonly type: 'yjs.update';
      readonly target: Readonly<SyncMutationTargetV1>;
      readonly payload: CanonicalCborValue;
      readonly order: SyncTotalOrderV1;
      readonly source: ReducerSource;
    })
  | (MaterializationEffectBase & {
      readonly type: 'asset.bind' | 'asset.unbind';
      readonly target: Readonly<SyncMutationTargetV1>;
      readonly payload: CanonicalCborValue;
      readonly order: SyncTotalOrderV1;
      readonly source: ReducerSource;
    })
  | (MaterializationEffectBase & {
      readonly type: 'sync-generation.purge';
      readonly target: Readonly<SyncMutationTargetV1>;
      readonly payload: CanonicalCborValue;
      readonly order: SyncTotalOrderV1;
      readonly source: ReducerSource;
    });

export interface ReducerRejection {
  readonly code:
    | 'sync-generation-identity-mismatch'
    | 'changeset-id-collision'
    | 'invalid-mutation-index'
    | 'unknown-target-kind'
    | 'unsupported-action'
    | 'invalid-target-family'
    | 'invalid-payload';
  readonly path: string;
  readonly message: string;
}

export type ReducerIngestResult =
  | {
      readonly status: 'applied';
      readonly state: CanonicalReducerState;
      /** Full, deterministic and idempotent projection for a later SQLite materializer. */
      readonly effects: readonly ReducerEffect[];
      readonly conflicts: readonly ReducerConflict[];
    }
  | {
      readonly status: 'duplicate';
      readonly state: CanonicalReducerState;
      readonly effects: readonly [];
      readonly conflicts: readonly ReducerConflict[];
    }
  | {
      readonly status: 'rejected';
      readonly state: CanonicalReducerState;
      readonly effects: readonly [];
      readonly conflicts: readonly ReducerConflict[];
      readonly rejection: ReducerRejection;
    };

export interface ReducerSnapshot {
  readonly identity: ReducerSyncGenerationIdentity;
  readonly receipts: readonly { changeSetId: string; signature: string }[];
  readonly generationPurge: SyncGenerationPurgeRegister | null;
  readonly fields: readonly FieldRegister[];
  readonly tuples: readonly TupleRegister[];
  readonly sets: readonly {
    target: Readonly<SyncMutationTargetV1>;
    members: readonly {
      memberId: string;
      adds: readonly OrSetAdd[];
      removedAddTags: readonly (LwwValue<true> & { addTag: string })[];
    }[];
  }[];
  readonly orders: readonly OrderRegister[];
  readonly assetBindings: readonly AssetBindingRegister[];
  readonly lifecycles: readonly {
    kind: string;
    entityId: string;
    seeds: readonly LifecycleSeed[];
    trashes: readonly (LwwValue<true> & { incarnation: number })[];
    purge: LwwValue<true> | null;
  }[];
  readonly conflicts: readonly ReducerConflict[];
}

export type ProtocolValidatedChangeSet = Readonly<SyncChangeSetV1>;
