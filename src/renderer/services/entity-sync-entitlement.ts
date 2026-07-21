export type TrashMutationType = 'create' | 'update' | 'delete' | 'softDelete' | 'restore';

export const TRASH_ENTITLEMENT_CONFLICT_PREFIX = 'TRASH_ENTITLEMENT_REQUIRED:';
export const TRASH_ENTITLEMENT_BLOCKED_PREFIX = 'BLOCKED_BY_TRASH_ENTITLEMENT:';

export interface TrashEntitlementConflictRow {
  status: string;
  lastError: string | null;
}

/** A 402 is terminal only for operations implemented by the paid trash API. */
export function isTrashEntitlementRejection(
  mutationType: TrashMutationType,
  httpStatus: number | undefined,
): boolean {
  return httpStatus === 402 && (mutationType === 'softDelete' || mutationType === 'restore');
}

export function trashEntitlementConflictMessage(error: string): string {
  return `${TRASH_ENTITLEMENT_CONFLICT_PREFIX} ${error}`;
}

export function trashEntitlementBlockedMessage(rootMutationId: number): string {
  return `${TRASH_ENTITLEMENT_BLOCKED_PREFIX} mutation ${rootMutationId}`;
}

/**
 * Match only conflicts created by the paid trash gate. CREATE payload
 * conflicts share the same database status but must never be re-armed here.
 */
export function isRearmableTrashEntitlementConflict(row: TrashEntitlementConflictRow): boolean {
  if (row.status !== 'conflict' || !row.lastError) return false;
  return (
    row.lastError.startsWith(TRASH_ENTITLEMENT_CONFLICT_PREFIX) ||
    row.lastError.startsWith(TRASH_ENTITLEMENT_BLOCKED_PREFIX)
  );
}
