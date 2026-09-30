import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ identity: vi.fn(), keychain: vi.fn() }));
vi.mock('../../platform', () => ({
  platform: {
    app: { getInstallationIdentity: mocks.identity },
    keychain: { get: mocks.keychain, set: mocks.keychain },
  },
}));
import { getSyncInstallationIdentity, resetSyncInstallationIdentityForTests } from './installation-identity';

beforeEach(() => {
  vi.clearAllMocks();
  resetSyncInstallationIdentityForTests();
});

it('keeps local writing independent of an unavailable Keychain', async () => {
  mocks.keychain.mockImplementation(() => new Promise(() => {}));
  mocks.identity.mockResolvedValue(`install-${'a'.repeat(64)}`);
  const [a, b] = await Promise.all([getSyncInstallationIdentity(), getSyncInstallationIdentity()]);
  expect(a).toBe(b);
  expect(mocks.identity).toHaveBeenCalledTimes(1);
  expect(mocks.keychain).not.toHaveBeenCalled();
  expect(a.createWriterIdentity()).not.toEqual(a.createWriterIdentity());
});

it('does not silently replace an invalid native marker and allows a repaired read', async () => {
  mocks.identity.mockResolvedValueOnce('broken').mockResolvedValue(`install-${'b'.repeat(64)}`);
  await expect(getSyncInstallationIdentity()).rejects.toThrow('invalid native');
  await expect(getSyncInstallationIdentity()).resolves.toMatchObject({ installationId: `install-${'b'.repeat(64)}` });
  expect(mocks.keychain).not.toHaveBeenCalled();
});
