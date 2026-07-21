import { describe, expect, it } from 'vitest';
import {
  isRearmableTrashEntitlementConflict,
  isTrashEntitlementRejection,
  trashEntitlementBlockedMessage,
  trashEntitlementConflictMessage,
} from './entity-sync-entitlement';

describe('trash entitlement sync policy', () => {
  it('classifies only 402 responses from paid trash operations as entitlement conflicts', () => {
    expect(isTrashEntitlementRejection('softDelete', 402)).toBe(true);
    expect(isTrashEntitlementRejection('restore', 402)).toBe(true);

    expect(isTrashEntitlementRejection('create', 402)).toBe(false);
    expect(isTrashEntitlementRejection('update', 402)).toBe(false);
    expect(isTrashEntitlementRejection('delete', 402)).toBe(false);
    expect(isTrashEntitlementRejection('softDelete', 401)).toBe(false);
    expect(isTrashEntitlementRejection('softDelete', 403)).toBe(false);
    expect(isTrashEntitlementRejection('restore', 500)).toBe(false);
    expect(isTrashEntitlementRejection('restore', undefined)).toBe(false);
  });

  it('re-arms root and causally blocked trash conflicts without touching create conflicts', () => {
    expect(
      isRearmableTrashEntitlementConflict({
        status: 'conflict',
        lastError: trashEntitlementConflictMessage('HTTP 402'),
      }),
    ).toBe(true);
    expect(
      isRearmableTrashEntitlementConflict({
        status: 'conflict',
        lastError: trashEntitlementBlockedMessage(42),
      }),
    ).toBe(true);
    expect(
      isRearmableTrashEntitlementConflict({
        status: 'conflict',
        lastError: 'CREATE_PAYLOAD_CONFLICT: HTTP 409',
      }),
    ).toBe(false);
    expect(
      isRearmableTrashEntitlementConflict({
        status: 'pending',
        lastError: trashEntitlementConflictMessage('HTTP 402'),
      }),
    ).toBe(false);
  });
});
