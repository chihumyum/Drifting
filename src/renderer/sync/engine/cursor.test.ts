import { describe, expect, it } from 'vitest';

import { createProviderCursor, createProviderPageToken } from '../protocol';
import {
  beginInventory,
  commitDurableChangePage,
  commitDurableInventoryPage,
  createDurableCursorState,
  currentChangePageRequest,
  currentInventoryPageToken,
  resetCursorForFullInventory,
  type DurablePageReceipt,
} from './cursor';

const durable = (itemCount: number): DurablePageReceipt => ({
  itemCount,
  durableInbox: itemCount,
  dependencyPending: 0,
  quarantinedWithRawBytes: 0,
  removedRecorded: 0,
});

describe('durable provider cursor', () => {
  it('captures a start cursor before inventory and drains changes from that cursor', () => {
    const start = createProviderCursor('cursor:start');
    let state = beginInventory(createDurableCursorState('provider-epoch-a'), start);
    expect(currentInventoryPageToken(state)).toBeUndefined();
    const page2 = createProviderPageToken('inventory:page-2');
    state = commitDurableInventoryPage(state, {
      nextPageToken: page2,
      receipt: durable(2),
    });
    expect(currentInventoryPageToken(state)).toBe(page2);
    state = commitDurableInventoryPage(state, {
      requestedPageToken: page2,
      receipt: { ...durable(2), durableInbox: 1, dependencyPending: 1 },
    });
    expect(state.inventoryComplete).toBe(true);
    expect(currentChangePageRequest(state)).toEqual({ cursor: start });
  });

  it('persists pending pages without advancing the committed cursor', () => {
    const start = createProviderCursor('cursor:start');
    let state = commitDurableInventoryPage(
      beginInventory(createDurableCursorState('provider-epoch-a'), start),
      { receipt: durable(0) },
    );
    const request = currentChangePageRequest(state);
    const nextPageToken = createProviderPageToken('changes:page-2');
    state = commitDurableChangePage(state, {
      request,
      nextPageToken,
      receipt: durable(3),
    });
    expect(state.committedCursor).toBe(start);
    expect(currentChangePageRequest(state)).toEqual({ cursor: start, pageToken: nextPageToken });

    const finalCursor = createProviderCursor('cursor:final');
    state = commitDurableChangePage(state, {
      request: currentChangePageRequest(state),
      newCursor: finalCursor,
      receipt: durable(1),
    });
    expect(state.committedCursor).toBe(finalCursor);
    expect(state.pendingChanges).toBeNull();
  });

  it('refuses to advance when any page item lacks a durable disposition', () => {
    const start = createProviderCursor('cursor:start');
    const inventory = beginInventory(createDurableCursorState('provider-epoch-a'), start);
    expect(() =>
      commitDurableInventoryPage(inventory, {
        receipt: { ...durable(2), durableInbox: 1 },
      }),
    ).toThrow('1/2 page items are durable');
    expect(inventory.committedCursor).toBeNull();
  });

  it('requires quarantines to have complete raw bytes and rejects stale page receipts', () => {
    const start = createProviderCursor('cursor:start');
    let state = beginInventory(createDurableCursorState('provider-epoch-a'), start);
    state = commitDurableInventoryPage(state, {
      receipt: {
        itemCount: 1,
        durableInbox: 0,
        dependencyPending: 0,
        quarantinedWithRawBytes: 1,
        removedRecorded: 0,
      },
    });
    expect(() =>
      commitDurableChangePage(state, {
        request: { cursor: createProviderCursor('cursor:stale') },
        newCursor: createProviderCursor('cursor:new'),
        receipt: durable(0),
      }),
    ).toThrow('does not match');
  });

  it('drops only transport progress when a provider token expires', () => {
    const start = createProviderCursor('cursor:start');
    const pending = commitDurableInventoryPage(
      beginInventory(createDurableCursorState('provider-epoch-a'), start),
      {
        nextPageToken: createProviderPageToken('inventory:page-2'),
        receipt: durable(1),
      },
    );

    expect(resetCursorForFullInventory(pending)).toEqual(
      createDurableCursorState('provider-epoch-a'),
    );
  });
});
