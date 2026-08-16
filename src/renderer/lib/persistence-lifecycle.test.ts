import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  saveActiveEditor: vi.fn(),
  flushYjs: vi.fn(),
  flushAtomicTransactions: vi.fn(),
  flushAssets: vi.fn(),
  flushSnapshotHistory: vi.fn(),
  checkpoint: vi.fn(),
  flushSession: vi.fn(),
  syncEngineCycle: vi.fn(),
  waitForYjsTeardown: vi.fn(),
}));

vi.mock('./active-editor', () => ({ saveActiveEditor: mocks.saveActiveEditor }));
vi.mock('./db', () => ({ checkpointDatabase: mocks.checkpoint }));
vi.mock('./session-token', () => ({ flushSessionTokenStorage: mocks.flushSession }));
vi.mock('../services/atomic-sync-transaction-tracker', () => ({
  flushPendingAtomicSyncTransactions: mocks.flushAtomicTransactions,
}));
vi.mock('../services/asset-store.service', () => ({
  flushPendingAssetPersistence: mocks.flushAssets,
}));
vi.mock('../services/yjs-local-durability.service', () => ({
  flushAllOpenYjsDocuments: mocks.flushYjs,
  waitForYjsDocumentTeardown: mocks.waitForYjsTeardown,
}));
vi.mock('../services/snapshot-history.service', () => ({
  flushSnapshotHistoryPersistence: mocks.flushSnapshotHistory,
}));

import {
  flushApplicationPersistenceForLifecycle,
  flushRemoteApplicationPersistence,
  installSyncEngineLifecycleHook,
  quiesceApplicationAfterCredentialLoss,
  quiesceApplicationForDatabaseSwitch,
} from './persistence-lifecycle';

describe('application persistence lifecycle', () => {
  let uninstallSyncEngineHook: (() => void) | null = null;

  beforeEach(() => {
    mocks.order.length = 0;
    vi.resetAllMocks();
    mocks.saveActiveEditor.mockImplementation(async () => {
      mocks.order.push('editor');
      throw new Error('editor save failed');
    });
    mocks.flushYjs.mockImplementation(async () => {
      mocks.order.push('yjs');
    });
    mocks.flushAtomicTransactions.mockImplementation(async () => {
      mocks.order.push('atomic-transactions');
    });
    mocks.flushAssets.mockImplementation(async () => {
      mocks.order.push('assets');
    });
    mocks.flushSnapshotHistory.mockImplementation(async () => {
      mocks.order.push('snapshot-history');
    });
    mocks.checkpoint.mockImplementation(async () => {
      mocks.order.push('checkpoint');
    });
    mocks.flushSession.mockImplementation(async () => {
      mocks.order.push('session');
    });
    mocks.syncEngineCycle.mockResolvedValue(undefined);
    mocks.waitForYjsTeardown.mockResolvedValue(undefined);
  });

  afterEach(() => {
    uninstallSyncEngineHook?.();
    uninstallSyncEngineHook = null;
  });

  it('keeps the remote lane inert until SyncEngine installs its hook', async () => {
    await expect(flushRemoteApplicationPersistence()).resolves.toBeUndefined();
    expect(mocks.syncEngineCycle).not.toHaveBeenCalled();
  });

  it('attempts every ordered local durability step before requesting a SyncEngine cycle', async () => {
    uninstallSyncEngineHook = installSyncEngineLifecycleHook(mocks.syncEngineCycle);

    await expect(flushApplicationPersistenceForLifecycle('suspended')).rejects.toThrow(
      '1 local persistence step(s) failed',
    );

    expect(mocks.order).toEqual([
      'editor',
      'yjs',
      'snapshot-history',
      'assets',
      'atomic-transactions',
      'assets',
      'checkpoint',
      'session',
    ]);
    await vi.waitFor(() => expect(mocks.syncEngineCycle).toHaveBeenCalledOnce());
    expect(mocks.syncEngineCycle).toHaveBeenCalledWith('suspended');
  });

  it('unmounts and waits for Yjs close snapshots after the SyncEngine hook and before the final checkpoint', async () => {
    mocks.saveActiveEditor.mockImplementation(async () => {
      mocks.order.push('editor');
    });
    mocks.syncEngineCycle.mockImplementation(async () => {
      mocks.order.push('remote:sync-engine');
    });
    mocks.waitForYjsTeardown.mockImplementation(async () => {
      mocks.order.push('teardown');
    });
    uninstallSyncEngineHook = installSyncEngineLifecycleHook(mocks.syncEngineCycle);

    await quiesceApplicationForDatabaseSwitch(() => mocks.order.push('unmount'));

    expect(mocks.order).toEqual([
      'editor',
      'yjs',
      'snapshot-history',
      'assets',
      'atomic-transactions',
      'assets',
      'checkpoint',
      'session',
      'remote:sync-engine',
      'unmount',
      'teardown',
      'editor',
      'yjs',
      'snapshot-history',
      'assets',
      'atomic-transactions',
      'assets',
      'checkpoint',
      'session',
    ]);
    expect(mocks.syncEngineCycle).toHaveBeenCalledWith('database-switch');
  });

  it('tears down after credential loss even when the first local flush fails', async () => {
    mocks.saveActiveEditor
      .mockImplementationOnce(async () => {
        mocks.order.push('editor');
        throw new Error('editor save failed');
      })
      .mockImplementation(async () => {
        mocks.order.push('editor');
      });
    mocks.waitForYjsTeardown.mockImplementation(async () => {
      mocks.order.push('teardown');
    });

    await expect(
      quiesceApplicationAfterCredentialLoss(() => mocks.order.push('unmount')),
    ).rejects.toThrow('1 credential-loss persistence step(s) failed');

    expect(mocks.order).toEqual([
      'editor',
      'yjs',
      'snapshot-history',
      'assets',
      'atomic-transactions',
      'assets',
      'checkpoint',
      'session',
      'unmount',
      'teardown',
      'editor',
      'yjs',
      'snapshot-history',
      'assets',
      'atomic-transactions',
      'assets',
      'checkpoint',
      'session',
    ]);
    expect(mocks.syncEngineCycle).not.toHaveBeenCalled();
  });
});
