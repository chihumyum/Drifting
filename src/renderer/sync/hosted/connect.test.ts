import { beforeEach, expect, it, vi } from 'vitest';
import type { DbClient } from '../../lib/db';

const mocks = vi.hoisted(() => ({
  read: vi.fn(), cancel: vi.fn(), adopt: vi.fn(), flush: vi.fn(),
  restore: vi.fn(), quiesce: vi.fn(), resume: vi.fn(), session: vi.fn(),
}));
vi.mock('../app-authority-repository', () => ({ createSyncAppAuthorityRepository: () => ({ read: mocks.read, cancel: mocks.cancel }) }));
vi.mock('./adopt-drive', () => ({ adoptDriveReplicaForHosted: mocks.adopt }));
vi.mock('../../lib/persistence-lifecycle', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/persistence-lifecycle')>(),
  flushLocalApplicationPersistence: mocks.flush,
}));
vi.mock('../../lib/hosted-session-binding', () => ({ getHostedSessionBinding: mocks.session }));
vi.mock('../journal', async (importOriginal) => ({
  ...await importOriginal<typeof import('../journal')>(),
  getSyncInstallationIdentity: async () => ({ installationId: 'synthetic' }),
}));
vi.mock('../product-runtime-control', () => ({ productSyncRuntimeControl: { quiesceForProviderChange: mocks.quiesce } }));
vi.mock('../restore/cloud-restore', () => ({
  NativeRestoreObjectAccess: class {},
  restoreCloudSyncGenerations: mocks.restore,
  restoreDiscoveredCloudProjects: vi.fn(),
}));
import { connectHostedFromProduct } from './connect';

const db = {} as DbClient;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockReturnValue({ accountSubject: 'synthetic-hosted' });
  mocks.quiesce.mockResolvedValue(mocks.resume);
  mocks.restore.mockResolvedValue({ restored: [] });
});

it('cancels an unfinished Drive connect locally before connecting Hosted', async () => {
  mocks.read.mockResolvedValueOnce({ mode: 'local', transitionState: 'blocked', targetMode: 'google-drive', attemptId: 'old-connect' })
    .mockResolvedValueOnce({ mode: 'local', transitionState: 'stable' });
  await connectHostedFromProduct(new AbortController().signal, db);
  expect(mocks.cancel).toHaveBeenCalledWith(expect.objectContaining({ attemptId: 'old-connect' }));
  expect(mocks.adopt).not.toHaveBeenCalled();
  expect(mocks.restore).toHaveBeenCalledWith(expect.objectContaining({ db, account: { accountSubject: 'synthetic-hosted', credentialSecretRef: 'hosted.session' } }));
});

it('cancels an unfinished Drive disconnect, then quiesces before local replica adoption', async () => {
  mocks.read.mockResolvedValueOnce({ mode: 'google-drive', transitionState: 'blocked', targetMode: 'local', attemptId: 'old-disconnect' })
    .mockResolvedValueOnce({ mode: 'google-drive', transitionState: 'stable' })
    .mockResolvedValueOnce({ mode: 'local', transitionState: 'connecting', targetMode: 'hosted', attemptId: 'new-connect' });
  await connectHostedFromProduct(new AbortController().signal, db);
  expect(mocks.cancel).toHaveBeenCalledWith(expect.objectContaining({ attemptId: 'old-disconnect' }));
  expect(mocks.quiesce.mock.invocationCallOrder[0]).toBeLessThan(mocks.adopt.mock.invocationCallOrder[0]!);
  expect(mocks.adopt).toHaveBeenCalledOnce();
  expect(mocks.restore).toHaveBeenCalledWith(expect.objectContaining({ attemptId: 'new-connect' }));
});

it('leaves a retained transition alone if it cannot safely be cancelled', async () => {
  mocks.read.mockResolvedValue({ mode: 'local', transitionState: 'blocked', targetMode: 'google-drive', attemptId: 'activated' });
  mocks.cancel.mockRejectedValue(new Error('An activated provider transition cannot be cancelled'));
  await expect(connectHostedFromProduct(new AbortController().signal, db)).rejects.toThrow('cannot be cancelled');
  expect(mocks.adopt).not.toHaveBeenCalled();
  expect(mocks.restore).not.toHaveBeenCalled();
});

it('restores runtime control and stops before upload when local adoption fails', async () => {
  mocks.read.mockResolvedValue({ mode: 'google-drive', transitionState: 'stable' });
  mocks.adopt.mockRejectedValue(new Error('Local journal failed verification'));
  await expect(connectHostedFromProduct(new AbortController().signal, db)).rejects.toThrow('Local journal');
  expect(mocks.resume).toHaveBeenCalledOnce();
  expect(mocks.restore).not.toHaveBeenCalled();
});
