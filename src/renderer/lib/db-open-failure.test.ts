import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../platform/database', async (importOriginal) => ({
  ...await importOriginal<typeof import('../platform/database')>(),
  databasePlatform: { open: mocks.open },
}));

import { DatabaseOpenFailure } from '../platform/database';
import { getDatabaseOpenFailure } from '../platform/database-recovery-store';
import { initDatabase } from './db';

beforeEach(() => {
  mocks.open.mockReset();
});

it('hands every failed open to the failure screen, with or without an upgrade to restore', async () => {
  const plain = new DatabaseOpenFailure({
    code: 'failed-to-enable-wal-mode',
    message: 'Drifting could not open the local library database.',
    detail: 'failed to enable WAL mode: database is locked',
    recoverySessionId: null,
    sourceVersion: null,
    targetVersion: '0.1.0-alpha.12',
    safetyBackup: null,
  });
  mocks.open.mockRejectedValueOnce(plain);
  await expect(initDatabase('local')).rejects.toBe(plain);
  expect(getDatabaseOpenFailure()).toBe(plain);

  // A later open that works takes the screen down again.
  mocks.open.mockResolvedValueOnce({ path: 'local_drifting.db', journalMode: 'wal', migrationsApplied: 0 });
  await initDatabase('local');
  expect(getDatabaseOpenFailure()).toBeNull();
});
