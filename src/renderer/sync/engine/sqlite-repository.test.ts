import { describe, expect, it } from 'vitest';

import { createProviderCursor, createProviderPageToken } from '../protocol';
import { beginInventory, commitDurableInventoryPage, createDurableCursorState } from './cursor';
import { decodeCursorStorage, encodeCursorStorage } from './sqlite-repository';

const emptyPage = {
  itemCount: 0,
  durableInbox: 0,
  dependencyPending: 0,
  quarantinedWithRawBytes: 0,
  removedRecorded: 0,
} as const;

describe('SQLite SyncEngine state encoding', () => {
  it('durably represents a captured inventory cursor before the first page', () => {
    const state = beginInventory(
      createDurableCursorState('provider-epoch-a'),
      createProviderCursor('cursor:start'),
    );
    const row = encodeCursorStorage(state);
    expect(row).toMatchObject({
      committedCursor: 'cursor:start',
      pendingBaseCursor: null,
      pendingPageToken: null,
      inventoryComplete: false,
    });
    expect(decodeCursorStorage(row)).toEqual(state);
  });

  it('round-trips inventory and change page crash-resume states', () => {
    const start = createProviderCursor('cursor:start');
    const token = createProviderPageToken('page:2');
    const inventory = commitDurableInventoryPage(
      beginInventory(createDurableCursorState('provider-epoch-a'), start),
      { nextPageToken: token, receipt: emptyPage },
    );
    expect(decodeCursorStorage(encodeCursorStorage(inventory))).toEqual(inventory);

    const completed = commitDurableInventoryPage(inventory, {
      requestedPageToken: token,
      receipt: emptyPage,
    });
    expect(decodeCursorStorage(encodeCursorStorage(completed))).toEqual(completed);
  });
});
