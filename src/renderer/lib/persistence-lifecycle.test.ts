import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  saveActiveEditor: vi.fn(),
  flushYjs: vi.fn(),
  flushEntityPersistence: vi.fn(),
  flushSnapshotHistory: vi.fn(),
  checkpoint: vi.fn(),
  flushSession: vi.fn(),
  forceEntitySync: vi.fn(),
  forceYjsSync: vi.fn(),
  flushPreferences: vi.fn(),
  waitForYjsTeardown: vi.fn(),
}));

vi.mock('./active-editor', () => ({ saveActiveEditor: mocks.saveActiveEditor }));
vi.mock('./db', () => ({ checkpointDatabase: mocks.checkpoint }));
vi.mock('./session-token', () => ({ flushSessionTokenStorage: mocks.flushSession }));
vi.mock('../services/entity-sync.service', () => ({
  flushPendingEntityPersistence: mocks.flushEntityPersistence,
  forceFlush: mocks.forceEntitySync,
}));
vi.mock('../services/yjs-sync.service', () => ({
  flushAllOpenYjsDocuments: mocks.flushYjs,
  forceSyncAllDocuments: mocks.forceYjsSync,
  waitForYjsDocumentTeardown: mocks.waitForYjsTeardown,
}));
vi.mock('../services/preferences-sync.service', () => ({
  flushPreferencesSync: mocks.flushPreferences,
}));
vi.mock('../services/snapshot-history.service', () => ({
  flushSnapshotHistoryPersistence: mocks.flushSnapshotHistory,
}));

import {
  flushApplicationPersistenceForLifecycle,
  quiesceApplicationAfterCredentialLoss,
  quiesceApplicationForDatabaseSwitch,
} from './persistence-lifecycle';

describe('application persistence lifecycle', () => {
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
    mocks.flushEntityPersistence.mockImplementation(async () => {
      mocks.order.push('entity-outbox');
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
    mocks.forceEntitySync.mockResolvedValue(undefined);
    mocks.forceYjsSync.mockResolvedValue(undefined);
    mocks.flushPreferences.mockResolvedValue(undefined);
    mocks.waitForYjsTeardown.mockResolvedValue(undefined);
  });

  it('attempts every ordered local durability step before starting best-effort network work', async () => {
    await expect(flushApplicationPersistenceForLifecycle()).rejects.toThrow(
      '1 local persistence step(s) failed',
    );

    expect(mocks.order).toEqual([
      'editor',
      'yjs',
      'snapshot-history',
      'entity-outbox',
      'checkpoint',
      'session',
    ]);
    expect(mocks.forceEntitySync).toHaveBeenCalledOnce();
    expect(mocks.forceYjsSync).toHaveBeenCalledOnce();
    expect(mocks.flushPreferences).toHaveBeenCalledOnce();
  });

  it('unmounts and waits for Yjs close snapshots before remote work and the final checkpoint', async () => {
    mocks.saveActiveEditor.mockImplementation(async () => {
      mocks.order.push('editor');
    });
    mocks.forceEntitySync.mockImplementation(async () => {
      mocks.order.push('remote:entity');
    });
    mocks.forceYjsSync.mockImplementation(async () => {
      mocks.order.push('remote:yjs');
    });
    mocks.flushPreferences.mockImplementation(async () => {
      mocks.order.push('remote:preferences');
    });
    mocks.waitForYjsTeardown.mockImplementation(async () => {
      mocks.order.push('teardown');
    });

    await quiesceApplicationForDatabaseSwitch(() => mocks.order.push('unmount'));

    expect(mocks.order).toEqual([
      'editor',
      'yjs',
      'snapshot-history',
      'entity-outbox',
      'checkpoint',
      'session',
      'remote:entity',
      'remote:yjs',
      'remote:preferences',
      'unmount',
      'teardown',
      'editor',
      'yjs',
      'snapshot-history',
      'entity-outbox',
      'checkpoint',
      'session',
    ]);
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
      'entity-outbox',
      'checkpoint',
      'session',
      'unmount',
      'teardown',
      'editor',
      'yjs',
      'snapshot-history',
      'entity-outbox',
      'checkpoint',
      'session',
    ]);
    expect(mocks.forceEntitySync).not.toHaveBeenCalled();
    expect(mocks.forceYjsSync).not.toHaveBeenCalled();
    expect(mocks.flushPreferences).not.toHaveBeenCalled();
  });
});
