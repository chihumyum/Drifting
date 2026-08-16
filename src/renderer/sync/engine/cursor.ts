import type { ProviderCursor, ProviderPageToken } from '../protocol';

export interface DurablePageReceipt {
  readonly itemCount: number;
  readonly durableInbox: number;
  readonly dependencyPending: number;
  readonly quarantinedWithRawBytes: number;
  readonly removedRecorded: number;
}

interface InventoryCursorProgress {
  readonly startCursor: ProviderCursor;
  readonly pageToken: ProviderPageToken | null;
}

interface ChangeCursorProgress {
  readonly baseCursor: ProviderCursor;
  readonly pageToken: ProviderPageToken;
}

export interface DurableCursorState {
  readonly providerEpoch: string;
  readonly committedCursor: ProviderCursor | null;
  readonly inventoryComplete: boolean;
  readonly inventory: InventoryCursorProgress | null;
  readonly pendingChanges: ChangeCursorProgress | null;
}

function assertCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function assertDurablePage(receipt: DurablePageReceipt): void {
  for (const field of [
    'itemCount',
    'durableInbox',
    'dependencyPending',
    'quarantinedWithRawBytes',
    'removedRecorded',
  ] as const) {
    assertCount(receipt[field], field);
  }
  const durableCount =
    receipt.durableInbox +
    receipt.dependencyPending +
    receipt.quarantinedWithRawBytes +
    receipt.removedRecorded;
  if (durableCount !== receipt.itemCount) {
    throw new Error(
      `provider cursor cannot advance: ${durableCount}/${receipt.itemCount} page items are durable`,
    );
  }
}

export function createDurableCursorState(providerEpoch: string): DurableCursorState {
  if (!providerEpoch) throw new TypeError('providerEpoch must not be empty');
  return Object.freeze({
    providerEpoch,
    committedCursor: null,
    inventoryComplete: false,
    inventory: null,
    pendingChanges: null,
  });
}

/**
 * Invalid provider cursors/page tokens discard only transport progress. Remote
 * objects and applied domain receipts remain durable and are re-confirmed by a
 * new capture-before-inventory pass.
 */
export function resetCursorForFullInventory(
  state: DurableCursorState,
): DurableCursorState {
  return createDurableCursorState(state.providerEpoch);
}

/** Persists the discovery start cursor before the first inventory request. */
export function beginInventory(
  state: DurableCursorState,
  startCursor: ProviderCursor,
): DurableCursorState {
  if (state.inventoryComplete || state.committedCursor || state.pendingChanges) {
    throw new Error('inventory discovery can only begin from an empty cursor state');
  }
  if (state.inventory) {
    if (state.inventory.startCursor !== startCursor) {
      throw new Error('inventory discovery already captured a different start cursor');
    }
    return state;
  }
  return Object.freeze({
    ...state,
    inventory: Object.freeze({ startCursor, pageToken: null }),
  });
}

export function currentInventoryPageToken(
  state: DurableCursorState,
): ProviderPageToken | undefined {
  if (!state.inventory) throw new Error('inventory discovery has not started');
  return state.inventory.pageToken ?? undefined;
}

export function commitDurableInventoryPage(
  state: DurableCursorState,
  input: {
    requestedPageToken?: ProviderPageToken;
    nextPageToken?: ProviderPageToken;
    receipt: DurablePageReceipt;
  },
): DurableCursorState {
  const inventory = state.inventory;
  if (!inventory) throw new Error('no inventory page is in progress');
  if ((inventory.pageToken ?? undefined) !== input.requestedPageToken) {
    throw new Error('inventory page receipt does not match the durable pending page token');
  }
  assertDurablePage(input.receipt);
  if (input.nextPageToken) {
    if (input.nextPageToken === inventory.pageToken) {
      throw new Error('inventory provider repeated the same page token');
    }
    return Object.freeze({
      ...state,
      inventory: Object.freeze({ ...inventory, pageToken: input.nextPageToken }),
    });
  }
  return Object.freeze({
    ...state,
    committedCursor: inventory.startCursor,
    inventoryComplete: true,
    inventory: null,
  });
}

export interface ChangePageRequest {
  readonly cursor: ProviderCursor;
  readonly pageToken?: ProviderPageToken;
}

export function currentChangePageRequest(state: DurableCursorState): ChangePageRequest {
  if (!state.inventoryComplete || !state.committedCursor || state.inventory) {
    throw new Error('incremental changes require a completed inventory');
  }
  return state.pendingChanges
    ? { cursor: state.pendingChanges.baseCursor, pageToken: state.pendingChanges.pageToken }
    : { cursor: state.committedCursor };
}

/**
 * Commits a change page only after every item has a durable local disposition.
 * Intermediate pages retain the base cursor; only the final page atomically
 * replaces the committed provider cursor.
 */
export function commitDurableChangePage(
  state: DurableCursorState,
  input: {
    request: ChangePageRequest;
    nextPageToken?: ProviderPageToken;
    newCursor?: ProviderCursor;
    receipt: DurablePageReceipt;
  },
): DurableCursorState {
  const expected = currentChangePageRequest(state);
  if (expected.cursor !== input.request.cursor || expected.pageToken !== input.request.pageToken) {
    throw new Error('change page receipt does not match the durable cursor request');
  }
  if (input.nextPageToken && input.newCursor) {
    throw new Error('a change page cannot be both intermediate and final');
  }
  assertDurablePage(input.receipt);
  if (input.nextPageToken) {
    if (input.nextPageToken === expected.pageToken) {
      throw new Error('changes provider repeated the same page token');
    }
    return Object.freeze({
      ...state,
      pendingChanges: Object.freeze({
        baseCursor: expected.cursor,
        pageToken: input.nextPageToken,
      }),
    });
  }
  if (!input.newCursor) throw new Error('a final change page must provide newCursor');
  return Object.freeze({
    ...state,
    committedCursor: input.newCursor,
    pendingChanges: null,
  });
}
