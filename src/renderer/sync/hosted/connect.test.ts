import { beforeEach, expect, it, vi } from 'vitest';
import type { DbClient } from '../../lib/db';

const mocks = vi.hoisted(() => ({
  read: vi.fn(), flush: vi.fn(), restore: vi.fn(), discover: vi.fn(), quiesce: vi.fn(), session: vi.fn(),
}));
vi.mock('../app-authority-repository', () => ({ createSyncAppAuthorityRepository: () => ({ read: mocks.read }) }));
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
  restoreDiscoveredCloudProjects: mocks.discover,
}));
import { connectHostedFromProduct } from './connect';

const db = {} as DbClient;
const account = { accountSubject: 'synthetic-hosted', credentialSecretRef: 'hosted.session' };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockReturnValue({ accountSubject: 'synthetic-hosted' });
  mocks.restore.mockResolvedValue({ restored: [] });
  mocks.discover.mockResolvedValue([]);
});

it('connects a stable local library to Hosted as a fresh attempt after flushing local writes', async () => {
  mocks.read.mockResolvedValue({ mode: 'local', transitionState: 'stable', targetMode: null, attemptId: null });
  await connectHostedFromProduct(new AbortController().signal, db);
  expect(mocks.flush.mock.invocationCallOrder[0]).toBeLessThan(mocks.restore.mock.invocationCallOrder[0]!);
  expect(mocks.restore).toHaveBeenCalledOnce();
  const [input] = mocks.restore.mock.calls[0]!;
  expect(input).toMatchObject({ db, account });
  expect(input).not.toHaveProperty('attemptId');
  expect(mocks.quiesce).not.toHaveBeenCalled();
});

it('resumes an unfinished Hosted connect with its own attempt', async () => {
  mocks.read.mockResolvedValue({ mode: 'local', transitionState: 'blocked', targetMode: 'hosted', attemptId: 'old-connect' });
  await connectHostedFromProduct(new AbortController().signal, db);
  expect(mocks.restore).toHaveBeenCalledWith(expect.objectContaining({ db, account, attemptId: 'old-connect' }));
});

it('only discovers new projects when the library is already on Hosted', async () => {
  mocks.read.mockResolvedValue({ mode: 'hosted', transitionState: 'stable', targetMode: null, attemptId: null });
  await expect(connectHostedFromProduct(new AbortController().signal, db)).resolves.toEqual({ restored: [] });
  expect(mocks.discover).toHaveBeenCalledWith(expect.objectContaining({ db, account }));
  expect(mocks.restore).not.toHaveBeenCalled();
});

it('leaves an unfinished Hosted disconnect for the author to finish or cancel', async () => {
  mocks.read.mockResolvedValue({ mode: 'hosted', transitionState: 'blocked', targetMode: 'local', attemptId: 'old-disconnect' });
  await expect(connectHostedFromProduct(new AbortController().signal, db)).rejects.toThrow(
    'Finish or cancel the current provider transition first.',
  );
  expect(mocks.restore).not.toHaveBeenCalled();
  expect(mocks.discover).not.toHaveBeenCalled();
});

it('asks for sign-in before touching local state when there is no Hosted session', async () => {
  mocks.session.mockReturnValue(null);
  await expect(connectHostedFromProduct(new AbortController().signal, db)).rejects.toThrow('needs-reauth');
  expect(mocks.flush).not.toHaveBeenCalled();
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.restore).not.toHaveBeenCalled();
});
