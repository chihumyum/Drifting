import {
  decodeCanonicalCbor,
  encodeCanonicalCbor,
  sha256Bytes,
  type CanonicalCborValue,
  type SyncMutationAction,
  type SyncMutationTargetV1,
  type SyncMutationV1,
} from '../protocol';

export interface SyncMutationFamilyByAction {
  'entity.create': 'entity';
  'field.set': 'entity';
  'tuple.set': 'entity';
  'set.add': 'set';
  'set.remove': 'set';
  'order.move': 'order';
  'order.rebalance': 'order';
  'entity.trash': 'entity';
  'entity.restore': 'entity';
  'entity.purge': 'entity';
  'sync-generation.purge': 'sync-generation';
  'yjs.update': 'yjs';
  'asset.bind': 'asset';
  'asset.unbind': 'asset';
}

export type SyncMutationDraftV1<
  Action extends SyncMutationAction = SyncMutationAction,
> = Action extends SyncMutationAction
  ? {
      action: Action;
      target: Omit<SyncMutationTargetV1, 'family'> & {
        family: SyncMutationFamilyByAction[Action];
      };
      payload: CanonicalCborValue;
    }
  : never;

export interface FinalizedSyncMutationV1 {
  readonly mutation: Readonly<SyncMutationV1>;
  readonly payloadCbor: Uint8Array;
}

export interface FinalizedSyncChangeBuilder {
  readonly mutations: readonly FinalizedSyncMutationV1[];
}

interface PendingSyncMutationV1 {
  readonly index: number;
  readonly action: SyncMutationAction;
  readonly target: Readonly<SyncMutationTargetV1>;
  readonly payloadCbor: Uint8Array;
}

export interface PendingSyncMutationViewV1 {
  readonly index: number;
  readonly action: SyncMutationAction;
  readonly target: Readonly<SyncMutationTargetV1>;
  readonly payload: CanonicalCborValue;
}

interface StoredFinalizedSyncMutationV1 extends PendingSyncMutationV1 {
  readonly payloadSha256: SyncMutationV1['payloadSha256'];
}

const EXPECTED_FAMILY: Readonly<SyncMutationFamilyByAction> = {
  'entity.create': 'entity',
  'field.set': 'entity',
  'tuple.set': 'entity',
  'set.add': 'set',
  'set.remove': 'set',
  'order.move': 'order',
  'order.rebalance': 'order',
  'entity.trash': 'entity',
  'entity.restore': 'entity',
  'entity.purge': 'entity',
  'sync-generation.purge': 'sync-generation',
  'yjs.update': 'yjs',
  'asset.bind': 'asset',
  'asset.unbind': 'asset',
};

function canonicalizePayload(payload: CanonicalCborValue): Uint8Array {
  const payloadCbor = encodeCanonicalCbor(payload);
  const decoded = decodeCanonicalCbor(payloadCbor);
  if (!decoded.ok) {
    throw new TypeError(`failed to canonicalize mutation payload: ${decoded.message}`);
  }
  return payloadCbor;
}

/**
 * Collects every semantic mutation produced by one authored SQLite transaction.
 * Payloads are copied through deterministic CBOR at append time, so later
 * caller-side object mutation cannot alter the journal record.
 */
export class SyncChangeBuilder {
  readonly #pending: PendingSyncMutationV1[] = [];
  #state: 'open' | 'normalizing' | 'finalizing' | 'finalized' = 'open';
  #finalized: Promise<readonly StoredFinalizedSyncMutationV1[]> | null = null;

  get size(): number {
    return this.#pending.length;
  }

  get isFinalized(): boolean {
    return this.#state === 'finalized';
  }

  add<Action extends SyncMutationAction>(draft: SyncMutationDraftV1<Action>): number {
    if (this.#state !== 'open') {
      throw new Error('sync change builder is finalized');
    }

    const expectedFamily = EXPECTED_FAMILY[draft.action];
    if (draft.target.family !== expectedFamily) {
      throw new TypeError(
        `${draft.action} requires target family ${expectedFamily}, received ${draft.target.family}`,
      );
    }

    const index = this.#pending.length;
    const payloadCbor = canonicalizePayload(draft.payload);
    this.#pending.push({
      index,
      action: draft.action,
      target: Object.freeze({ ...draft.target }),
      payloadCbor,
    });
    return index;
  }

  addMutation<Action extends SyncMutationAction>(
    draft: SyncMutationDraftV1<Action>,
  ): number {
    return this.add(draft);
  }

  /**
   * Resolve every placeholder target incarnation exactly once, immediately
   * before journal finalization. The callback receives immutable decoded
   * snapshots and must return one non-negative incarnation per mutation.
   * Payload bytes are never rewritten, so their deterministic hashes remain
   * independent from lifecycle lookup timing.
   */
  async normalizeTargetIncarnations(
    resolve: (
      mutations: readonly PendingSyncMutationViewV1[],
    ) => Promise<readonly number[]> | readonly number[],
  ): Promise<void> {
    if (this.#state !== 'open') {
      throw new Error('sync change builder is not open for incarnation normalization');
    }

    this.#state = 'normalizing';
    try {
      const mutations = Object.freeze(
        this.#pending.map((pending): PendingSyncMutationViewV1 => {
          const decoded = decodeCanonicalCbor(pending.payloadCbor);
          if (!decoded.ok) {
            throw new Error(
              `stored canonical mutation payload became invalid: ${decoded.message}`,
            );
          }
          return Object.freeze({
            index: pending.index,
            action: pending.action,
            target: Object.freeze({ ...pending.target }),
            payload: decoded.value,
          });
        }),
      );
      const incarnations = await resolve(mutations);
      if (incarnations.length !== this.#pending.length) {
        throw new Error('incarnation resolver returned the wrong mutation count');
      }
      for (const [index, incarnation] of incarnations.entries()) {
        if (!Number.isSafeInteger(incarnation) || incarnation < 0) {
          throw new TypeError(`mutation ${index} incarnation must be a non-negative safe integer`);
        }
      }
      for (let index = 0; index < this.#pending.length; index += 1) {
        const pending = this.#pending[index]!;
        this.#pending[index] = {
          ...pending,
          target: Object.freeze({
            ...pending.target,
            incarnation: incarnations[index]!,
          }),
        };
      }
    } finally {
      this.#state = 'open';
    }
  }

  finalize(): Promise<FinalizedSyncChangeBuilder> {
    if (this.#state === 'normalizing') {
      throw new Error('sync change builder is still normalizing incarnations');
    }
    if (!this.#finalized) {
      this.#state = 'finalizing';
      this.#finalized = (async () => {
        if (this.#pending.length === 0) {
          throw new Error('authored transaction must record at least one sync mutation');
        }
        return Object.freeze(
          await Promise.all(
            this.#pending.map(async (pending) =>
              Object.freeze({
                ...pending,
                payloadSha256: await sha256Bytes(pending.payloadCbor),
              }),
            ),
          ),
        );
      })().finally(() => {
        this.#state = 'finalized';
      });
    }

    // Materialize a fresh snapshot on every read. Even byte-string payloads,
    // which JavaScript cannot freeze element-by-element, therefore cannot be
    // mutated through one finalized result and alter a later journal write.
    return this.#finalized.then((stored) => {
      const mutations = stored.map((entry): FinalizedSyncMutationV1 => {
        const decoded = decodeCanonicalCbor(entry.payloadCbor);
        if (!decoded.ok) {
          throw new Error(`stored canonical mutation payload became invalid: ${decoded.message}`);
        }
        return Object.freeze({
          mutation: Object.freeze({
            index: entry.index,
            target: { ...entry.target },
            action: entry.action,
            payloadVersion: 1,
            payload: decoded.value,
            payloadSha256: entry.payloadSha256,
          }),
          payloadCbor: new Uint8Array(entry.payloadCbor),
        });
      });
      return Object.freeze({ mutations: Object.freeze(mutations) });
    });
  }
}
