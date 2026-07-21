import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabasePlatformApi } from '../platform/database';

function fakeDatabase(open: DatabasePlatformApi['open']): DatabasePlatformApi {
  return {
    open,
    async execute() {
      return { changes: 0, lastInsertRowid: 0 };
    },
    async query() {
      return { columns: [], rows: [] };
    },
    async begin() {
      return { id: '1' };
    },
    async commit() {},
    async rollback() {},
    async checkpoint() {
      return { busy: 0, logFrames: 0, checkpointedFrames: 0 };
    },
    async close() {},
  };
}

async function loadDatabaseModule(databasePlatform: DatabasePlatformApi) {
  vi.resetModules();
  vi.doMock('../platform/database', async () => {
    const actual =
      await vi.importActual<typeof import('../platform/database')>('../platform/database');
    return { ...actual, databasePlatform };
  });
  return import('./db');
}

afterEach(() => {
  vi.doUnmock('../platform/database');
  vi.resetModules();
});

describe('renderer database session initialization', () => {
  it('requests stale recovery only for the module first open', async () => {
    const open = vi.fn<DatabasePlatformApi['open']>(async () => ({
      path: '/tmp/drifting.db',
      journalMode: 'wal',
      migrationsApplied: 0,
    }));
    const database = await loadDatabaseModule(fakeDatabase(open));

    await database.initDatabase('first-user');
    await database.initDatabase('first-user');
    await database.resetDatabase();
    await database.initDatabase('second-user');

    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenNthCalledWith(1, 'first-user_drifting.db', {
      recoverStaleTransaction: true,
    });
    expect(open).toHaveBeenNthCalledWith(2, 'second-user_drifting.db', {
      recoverStaleTransaction: false,
    });

    await database.resetDatabase();
  });

  it('does not re-arm recovery when the first open attempt fails', async () => {
    const open = vi
      .fn<DatabasePlatformApi['open']>()
      .mockRejectedValueOnce(new Error('native open failed'))
      .mockResolvedValue({
        path: '/tmp/drifting.db',
        journalMode: 'wal',
        migrationsApplied: 0,
      });
    const database = await loadDatabaseModule(fakeDatabase(open));

    await expect(database.initDatabase('user')).rejects.toThrow('native open failed');
    await database.initDatabase('user');

    expect(open).toHaveBeenNthCalledWith(1, 'user_drifting.db', {
      recoverStaleTransaction: true,
    });
    expect(open).toHaveBeenNthCalledWith(2, 'user_drifting.db', {
      recoverStaleTransaction: false,
    });

    await database.resetDatabase();
  });
});
