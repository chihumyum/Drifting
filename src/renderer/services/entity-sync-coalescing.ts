export type CoalescingMutationType =
  | 'create'
  | 'update'
  | 'delete'
  | 'softDelete'
  | 'restore';

export interface CoalescingMutation {
  mutationType: CoalescingMutationType;
  payload?: Record<string, unknown>;
}

export type CoalescingDecision =
  | { kind: 'append' }
  | {
      kind: 'replace';
      mutationType: CoalescingMutationType;
      payload?: Record<string, unknown>;
    }
  | { kind: 'cancel' };

export interface CoalescingOptions {
  /**
   * Only safe for leaf entities. Parent CREATE rows must stay ordered ahead of
   * already-enqueued child mutations before their eventual DELETE.
   */
  cancelCreateDelete?: boolean;
  /**
   * A previous network attempt may have committed even when its response was
   * lost. Rewriting that row would change the idempotency payload and can turn
   * an equivalent CREATE retry into a real 409 conflict.
   */
  existingMayHaveReachedServer?: boolean;
}

export function isCreatePayloadConflict(
  mutationType: CoalescingMutationType,
  httpStatus: number | undefined,
): boolean {
  return mutationType === 'create' && httpStatus === 409;
}

/**
 * A schema validation response cannot recover by immediately replaying the
 * same immutable durable payload. Quarantine it so unrelated entities can
 * continue syncing instead of hot-looping behind the poisoned head row.
 */
export function isTerminalPayloadValidationFailure(
  httpStatus: number | undefined,
): boolean {
  return httpStatus === 422;
}

/**
 * Reduce only adjacent pending operations for one logical entity. In-flight
 * rows are deliberately excluded by the caller: once an operation may have
 * reached the server, preserving ordering is safer than trying to rewrite it.
 */
export function coalescePendingMutation(
  existing: CoalescingMutation | undefined,
  incoming: CoalescingMutation,
  options: CoalescingOptions = {},
): CoalescingDecision {
  if (!existing) return { kind: 'append' };
  if (options.existingMayHaveReachedServer) return { kind: 'append' };

  if (incoming.mutationType === 'update') {
    if (existing.mutationType === 'create' || existing.mutationType === 'update') {
      return {
        kind: 'replace',
        mutationType: existing.mutationType,
        payload: { ...(existing.payload ?? {}), ...(incoming.payload ?? {}) },
      };
    }
    return { kind: 'append' };
  }

  if (incoming.mutationType === 'create' && existing.mutationType === 'create') {
    return {
      kind: 'replace',
      mutationType: 'create',
      payload: { ...(existing.payload ?? {}), ...(incoming.payload ?? {}) },
    };
  }

  if (incoming.mutationType === 'delete') {
    // A locally-created row that never left the pending queue never existed on
    // the server. Dropping both operations is the only idempotent end state.
    if (existing.mutationType === 'create') {
      return options.cancelCreateDelete === false ? { kind: 'append' } : { kind: 'cancel' };
    }
    if (existing.mutationType === 'delete') {
      return { kind: 'replace', mutationType: 'delete' };
    }
    return { kind: 'append' };
  }

  if (
    (existing.mutationType === 'softDelete' && incoming.mutationType === 'restore') ||
    (existing.mutationType === 'restore' && incoming.mutationType === 'softDelete')
  ) {
    return { kind: 'cancel' };
  }

  if (existing.mutationType === incoming.mutationType) {
    return {
      kind: 'replace',
      mutationType: incoming.mutationType,
      payload: incoming.payload,
    };
  }

  return { kind: 'append' };
}
