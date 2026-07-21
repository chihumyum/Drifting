import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  syncEnabled: false,
  listDocIds: vi.fn(async () => [] as string[]),
}));

vi.mock('../lib/config', () => ({ isSyncEnabled: () => mocks.syncEnabled }));
vi.mock('../lib/db', () => ({ getDb: vi.fn() }));
vi.mock('../lib/axios-config', () => ({ apiClient: {} }));
vi.mock('../lib/device-id', () => ({ getDeviceId: () => 'test-device' }));
vi.mock('../lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('./snapshot-history.service', () => ({ maybeCaptureSnapshotHistory: vi.fn() }));
vi.mock('../sqlite-repo/yjs-repo', () => ({
  createYjsRepository: () => ({ listDocIds: mocks.listDocIds }),
}));

import {
  forceSyncAllDocuments,
  registerSyncDocument,
  waitForYjsDocumentTeardown,
} from './yjs-sync.service';

const unregisters: Array<() => void> = [];

describe('app-wide Yjs lifecycle flush', () => {
  beforeEach(() => {
    mocks.syncEnabled = false;
    mocks.listDocIds.mockClear();
  });

  afterEach(async () => {
    for (const unregister of unregisters.splice(0)) unregister();
    await waitForYjsDocumentTeardown();
  });

  it('persists an open document even when server sync is disabled', async () => {
    const flushLocal = vi.fn(async () => undefined);
    const syncNow = vi.fn(async () => undefined);
    unregisters.push(registerSyncDocument('node-content:local', flushLocal, syncNow));

    await forceSyncAllDocuments();

    expect(flushLocal).toHaveBeenCalledOnce();
    expect(syncNow).not.toHaveBeenCalled();
    expect(mocks.listDocIds).not.toHaveBeenCalled();
  });

  it('finishes every local queue before starting any remote sync', async () => {
    mocks.syncEnabled = true;
    const order: string[] = [];
    let releaseLocal!: () => void;
    const localBarrier = new Promise<void>((resolve) => {
      releaseLocal = resolve;
    });
    const flushLocal = vi.fn(async () => {
      order.push('local:start');
      await localBarrier;
      order.push('local:done');
    });
    const syncNow = vi.fn(async () => {
      order.push('remote');
    });
    unregisters.push(registerSyncDocument('node-content:synced', flushLocal, syncNow));

    const flushing = forceSyncAllDocuments();
    await vi.waitFor(() => expect(flushLocal).toHaveBeenCalledOnce());
    expect(syncNow).not.toHaveBeenCalled();
    releaseLocal();
    await flushing;

    expect(order).toEqual(['local:start', 'local:done', 'remote']);
  });

  it('keeps teardown pending through the deferred final local flush', async () => {
    let releaseClose!: () => void;
    const closeBarrier = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const unregister = registerSyncDocument(
      'node-content:closing',
      () => closeBarrier,
      async () => undefined,
    );
    unregister();

    let settled = false;
    const teardown = waitForYjsDocumentTeardown().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseClose();
    await teardown;
    expect(settled).toBe(true);
  });

  it('waits for every registration when the same doc is mounted twice', async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstBarrier = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondBarrier = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const unregisterFirst = registerSyncDocument(
      'node-content:split',
      () => firstBarrier,
      async () => undefined,
    );
    const unregisterSecond = registerSyncDocument(
      'node-content:split',
      () => secondBarrier,
      async () => undefined,
    );
    unregisterFirst();
    unregisterSecond();

    let settled = false;
    const teardown = waitForYjsDocumentTeardown().then(() => {
      settled = true;
    });
    releaseSecond();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseFirst();
    await teardown;
    expect(settled).toBe(true);
  });

  it('rejects database-switch teardown when a final local write fails', async () => {
    const unregister = registerSyncDocument(
      'node-content:failed-close',
      async () => {
        throw new Error('snapshot write failed');
      },
      async () => undefined,
    );
    unregister();

    await expect(waitForYjsDocumentTeardown()).rejects.toThrow(
      '1 Yjs document(s) failed final teardown',
    );
  });
});
