import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  token: 'synthetic-token' as string | null,
  revision: 0,
  profile: null as { id: string } | null,
  switching: true,
  runningSubject: 'account-a' as string | null,
  getSession: vi.fn(),
  signOut: vi.fn(),
  writeProfile: vi.fn(),
  resume: vi.fn(),
  openAccount: vi.fn(),
  openLocal: vi.fn(),
  emit: vi.fn(),
}));
vi.mock('../lib/config', () => ({ APP_CONFIG: { LOCAL_ONLY_MODE: false }, canUseHostedService: () => true }));
vi.mock('../lib/auth-client', () => ({
  authClient: { getSession: mocks.getSession, signOut: mocks.signOut, signIn: { email: vi.fn() } },
  hostedAccountFetch: vi.fn(),
}));
vi.mock('../lib/session-token', () => ({
  getSessionToken: () => mocks.token,
  getSessionTokenRevision: () => mocks.revision,
  setSessionToken: (value: string) => { mocks.token = value; mocks.revision++; },
  clearSessionToken: () => { mocks.token = null; mocks.revision++; },
  invalidateSessionToken: () => { mocks.token = null; mocks.revision++; },
  flushSessionTokenStorage: async () => undefined,
  hydrateSessionToken: async () => {},
}));
vi.mock('../lib/hosted-profile', () => ({
  readHostedProfile: () => mocks.profile,
  writeHostedProfile: (profile: { id: string } | null) => { mocks.profile = profile; mocks.writeProfile(profile); },
}));
vi.mock('../lib/db', () => ({
  initDatabase: vi.fn(),
  getDb: () => ({ select: () => ({ from: async () => [] }) }),
}));
vi.mock('../sync/app-authority-repository', () => ({
  createSyncAppAuthorityRepository: () => ({
    read: async () => ({ mode: 'local', transitionState: 'stable' }),
    listActiveRuntimeBindings: async () => [],
  }),
}));
vi.mock('../lib/events', () => ({ events: { emit: mocks.emit } }));
vi.mock('../lib/persistence-lifecycle', () => ({ flushLocalApplicationPersistence: async () => undefined }));
vi.mock('../sync/hosted/session-recovery', () => ({ resumeHostedAuthentication: mocks.resume }));
vi.mock('../services/built-in-sample/first-run', () => ({ startBuiltInSampleProject: async () => undefined }));
vi.mock('../services/account-library', () => ({
  librarySwitchingAvailable: () => mocks.switching,
  runsOnAccountLibrary: (subject: string) => mocks.runningSubject === subject,
  openLibraryForAccount: mocks.openAccount,
  openLocalLibrary: mocks.openLocal,
  needsFirstAccountConnect: async () => false,
  settleRunningLibrary: async () => undefined,
}));

import { useAuthStore, LOCAL_USER_ID } from './auth';
import { alphaGuideStorageKey } from '../lib/alpha-guide-key';
import { clearHostedSessionBinding, getHostedSessionBinding } from '../lib/hosted-session-binding';

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => storage.clear(),
});

const user = (id: string) => ({ id, email: `${id}@example.test`, name: id, emailVerified: true });
const never = () => new Promise<never>(() => undefined);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.token = 'synthetic-token';
  mocks.revision = 0;
  mocks.profile = null;
  mocks.switching = true;
  mocks.runningSubject = 'account-a';
  clearHostedSessionBinding();
  mocks.signOut.mockResolvedValue({ error: null });
  mocks.openAccount.mockImplementation(never);
  mocks.openLocal.mockResolvedValue(undefined);
  useAuthStore.setState({ hostedUser: null, session: null, hostedStatus: 'signed-out' });
});

async function pending(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([promise.then(() => false, () => false), new Promise<boolean>((done) => setTimeout(() => done(true), 20))]);
}

describe('account-isolated libraries in the session flows', () => {
  it('relaunches onto the signing-in account library before adopting the session', async () => {
    mocks.getSession.mockResolvedValue({ data: { user: user('account-b') }, error: null });
    expect(await pending(useAuthStore.getState().adoptSession())).toBe(true);
    expect(mocks.openAccount).toHaveBeenCalledWith('account-b');
    // The relaunched process adopts the session from what was persisted here.
    expect(mocks.profile).toEqual(user('account-b'));
    expect(localStorage.getItem(alphaGuideStorageKey(LOCAL_USER_ID))).toBe('seen');
    // Nothing is bound or resumed against the library being left.
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(getHostedSessionBinding()).toBeNull();
    expect(useAuthStore.getState().hostedStatus).toBe('signed-out');
  });

  it('adopts in place on the account library it already runs on', async () => {
    mocks.getSession.mockResolvedValue({ data: { user: user('account-a') }, error: null });
    await useAuthStore.getState().adoptSession();
    expect(mocks.openAccount).not.toHaveBeenCalled();
    expect(getHostedSessionBinding()?.accountSubject).toBe('account-a');
  });

  it('restores the previous profile when the relaunch cannot start', async () => {
    mocks.profile = user('account-a');
    mocks.getSession.mockResolvedValue({ data: { user: user('account-b') }, error: null });
    mocks.openAccount.mockRejectedValue(new Error('library registry write failed'));
    await expect(useAuthStore.getState().adoptSession()).rejects.toThrow('library registry write failed');
    expect(mocks.profile).toEqual(user('account-a'));
  });

  it('keeps one library where switching is unavailable', async () => {
    mocks.switching = false;
    mocks.getSession.mockResolvedValue({ data: { user: user('account-b') }, error: null });
    await useAuthStore.getState().adoptSession();
    expect(mocks.openAccount).not.toHaveBeenCalled();
    expect(getHostedSessionBinding()?.accountSubject).toBe('account-b');
  });

  it('returns to the local library on an explicit sign-out, never on an expired session', async () => {
    mocks.getSession.mockResolvedValue({ data: { user: user('account-a') }, error: null });
    await useAuthStore.getState().adoptSession();
    await useAuthStore.getState().expireSession();
    expect(mocks.openLocal).not.toHaveBeenCalled();
    await useAuthStore.getState().logout();
    expect(mocks.openLocal).toHaveBeenCalledTimes(1);
    expect(mocks.profile).toBeNull();
  });
});
