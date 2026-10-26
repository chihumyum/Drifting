import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createWorkspaceProjectionFixture } from '../../services/workspace-projection.test-support';
import { SyncAppAuthorityTable, SyncBlobStateTable } from '../../schema/drizzle';

const mocks = vi.hoisted(() => ({ hosted: true, request: vi.fn() }));
vi.mock('../../lib/config', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/config')>(),
  canUseHostedService: () => mocks.hosted,
}));
vi.mock('../../lib/hosted-session-binding', () => ({
  getHostedSessionBinding: () => ({ accountSubject: 'synthetic-account', token: 'synthetic-token' }),
}));
vi.mock('../providers/hosted/tauri-transport', () => ({
  TauriHostedObjectTransport: class { request = mocks.request; },
}));
import {
  assertHostedQuotaAllows,
  HostedQuotaExceededError,
  readHostedUsage,
  resetHostedUsageCacheForTests,
} from './quota';

const MB = 1024 * 1024;
const NOW = '2026-10-27T00:00:00.000Z';
let fixture: Awaited<ReturnType<typeof createWorkspaceProjectionFixture>> | undefined;

beforeEach(() => {
  mocks.hosted = true;
  mocks.request.mockReset();
  resetHostedUsageCacheForTests();
});
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

async function hostedLibrary() {
  fixture = await createWorkspaceProjectionFixture();
  const { db } = fixture;
  // The connect protocol and its transition guard are covered elsewhere; this
  // synthetic library is simply put into Hosted mode.
  await db.run(sql`DROP TRIGGER trg_sync_app_authority_transition_guard`);
  await db.update(SyncAppAuthorityTable).set({ mode: 'hosted', updatedAt: NOW }).where(eq(SyncAppAuthorityTable.id, 'app'));
  const blob = (blobId: string, sizeBytes: number, remoteState: string) => ({
    syncGenerationId: 'workspace-generation', blobId, logicalKeyId: `key-${blobId}`,
    contentSha256: blobId.padEnd(64, '0'), sizeBytes, mime: 'image/png', remoteState, updatedAt: NOW,
  });
  // Not yet uploaded bytes count against the quota; uploaded ones are in usedBytes already.
  await db.insert(SyncBlobStateTable).values([
    blob('a', 50 * MB, 'missing'),
    blob('b', 30 * MB, 'available'),
  ]);
  return db;
}

it('counts pending uploads and refuses an attachment that would exceed the quota', async () => {
  const db = await hostedLibrary();
  mocks.request.mockResolvedValue({ usedBytes: 400 * MB, quotaBytes: 500 * MB, hardLimitBytes: 1024 * MB });

  await expect(assertHostedQuotaAllows(40 * MB, db)).resolves.toBeUndefined();
  const refused = await assertHostedQuotaAllows(60 * MB, db).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(HostedQuotaExceededError);
  expect(refused).toMatchObject({ usedBytes: 450 * MB, quotaBytes: 500 * MB, requestedBytes: 60 * MB });
  expect(mocks.request).toHaveBeenCalledOnce(); // the reading is cached for the next import
});

it('never blocks local-only libraries or an offline first reading', async () => {
  const db = await hostedLibrary();
  mocks.hosted = false;
  await expect(assertHostedQuotaAllows(900 * MB, db)).resolves.toBeUndefined();
  expect(mocks.request).not.toHaveBeenCalled();

  mocks.hosted = true;
  mocks.request.mockRejectedValue(new Error('offline'));
  await expect(assertHostedQuotaAllows(900 * MB, db)).resolves.toBeUndefined();
});

it('falls back to the last reading when a refresh fails', async () => {
  mocks.request.mockResolvedValueOnce({ usedBytes: 10 * MB, quotaBytes: 500 * MB, hardLimitBytes: 1024 * MB });
  expect(await readHostedUsage({ maxAgeMs: 0 })).toMatchObject({ usedBytes: 10 * MB });
  mocks.request.mockRejectedValueOnce(new Error('offline'));
  expect(await readHostedUsage({ maxAgeMs: 0 })).toMatchObject({ usedBytes: 10 * MB });
  mocks.request.mockResolvedValueOnce({ usedBytes: 'many' });
  expect(await readHostedUsage({ maxAgeMs: 0 })).toMatchObject({ usedBytes: 10 * MB });
});
