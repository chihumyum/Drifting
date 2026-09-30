import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  token: 'synthetic-token' as string | null,
  revision: 0,
  mode: 'local',
  account: 'account-a',
  getSession: vi.fn(),
  signOut: vi.fn(),
  signIn: vi.fn(),
  initDatabase: vi.fn(),
  flushLocal: vi.fn(),
  emit: vi.fn(),
  writeProfile: vi.fn(),
  resume: vi.fn(),
}));
vi.mock('../lib/config', () => ({
  APP_CONFIG: { LOCAL_ONLY_MODE: false },
  canUseHostedService: () => true,
}));
vi.mock('../lib/auth-client', () => ({
  authClient: {
    getSession: mocks.getSession,
    signOut: mocks.signOut,
    signIn: { email: mocks.signIn },
  },
}));
vi.mock('../lib/session-token', () => ({
  getSessionToken: () => mocks.token,
  getSessionTokenRevision: () => mocks.revision,
  setSessionToken: (value: string) => {
    mocks.token = value;
  },
  clearSessionToken: () => {
    mocks.token = null;
  },
  invalidateSessionToken: () => {
    mocks.token = null;
  },
  flushSessionTokenStorage: async () => {},
  hydrateSessionToken: async () => {},
}));
vi.mock('../lib/hosted-profile', () => ({
  readHostedProfile: () => null,
  writeHostedProfile: mocks.writeProfile,
}));
vi.mock('../lib/db', () => ({
  initDatabase: mocks.initDatabase,
  getDb: () => ({
    select: () => ({
      from: async () => [{ providerKind: 'hosted', accountSubjectId: mocks.account }],
    }),
  }),
}));
vi.mock('../sync/app-authority-repository', () => ({
  createSyncAppAuthorityRepository: () => ({
    read: async () => ({ mode: mocks.mode, transitionState: 'stable' }),
    listActiveRuntimeBindings: async () => [{ binding: { accountRef: mocks.account } }],
  }),
}));
vi.mock('../lib/events', () => ({ events: { emit: mocks.emit } }));
vi.mock('../lib/persistence-lifecycle', () => ({
  flushLocalApplicationPersistence: mocks.flushLocal,
}));
vi.mock('../sync/hosted/session-recovery', () => ({ resumeHostedAuthentication: mocks.resume }));
import { useAuthStore, LOCAL_USER_ID } from './auth';
import { getHostedSessionBinding, clearHostedSessionBinding } from '../lib/hosted-session-binding';
const session = {
  user: {
    id: 'account-a',
    email: 'synthetic@example.test',
    name: 'Synthetic',
    emailVerified: true,
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.mode = 'local';
  mocks.account = 'account-a';
  mocks.token = 'synthetic-token';
  clearHostedSessionBinding();
  mocks.getSession.mockResolvedValue({ data: session, error: null });
  mocks.signOut.mockResolvedValue({ error: null });
  mocks.signIn.mockResolvedValue({ error: null });
  useAuthStore.setState({ hostedUser: null, session: null, hostedStatus: 'signed-out' });
});
describe('Hosted sessions preserve the local writing library', () => {
  it('adopts a verified account without replacing local identity or database', async () => {
    const local = useAuthStore.getState().user;
    await useAuthStore.getState().adoptSession();
    expect(useAuthStore.getState().user).toBe(local);
    expect(local.id).toBe(LOCAL_USER_ID);
    expect(useAuthStore.getState().hostedUser?.id).toBe('account-a');
    expect(getHostedSessionBinding()?.accountSubject).toBe('account-a');
    expect(mocks.initDatabase).not.toHaveBeenCalled();
  });
  it('expires authentication without closing the library or forgetting the expected account', async () => {
    await useAuthStore.getState().adoptSession();
    await useAuthStore.getState().expireSession();
    expect(useAuthStore.getState()).toMatchObject({
      isAuthenticated: true,
      user: { id: LOCAL_USER_ID },
      hostedStatus: 'needs-reauth',
      hostedUser: { id: 'account-a' },
    });
    expect(mocks.token).toBeNull();
    expect(getHostedSessionBinding()).toBeNull();
  });
  it('rejects another account before binding or exporting local data', async () => {
    mocks.mode = 'hosted';
    mocks.account = 'account-b';
    await expect(useAuthStore.getState().adoptSession()).rejects.toThrow('HOSTED_ACCOUNT_MISMATCH');
    expect(getHostedSessionBinding()).toBeNull();
    expect(mocks.resume).not.toHaveBeenCalled();
  });
  it('retains the session if remote sign-out fails, and clears it after a successful retry', async () => {
    await useAuthStore.getState().adoptSession();
    mocks.signOut.mockResolvedValueOnce({ error: { message: 'offline' } });
    await expect(useAuthStore.getState().logout()).rejects.toThrow('offline');
    expect(mocks.token).toBe('synthetic-token');
    await useAuthStore.getState().logout();
    expect(mocks.token).toBeNull();
    expect(mocks.flushLocal).toHaveBeenCalledTimes(2);
    expect(useAuthStore.getState().user.id).toBe(LOCAL_USER_ID);
    expect(mocks.initDatabase).not.toHaveBeenCalled();
  });
  it('opens the library without waiting for a stalled account request', async () => {
    let finish!: (value: unknown) => void;
    mocks.getSession.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await useAuthStore.getState().checkSession();
    expect(mocks.initDatabase).toHaveBeenCalledWith(LOCAL_USER_ID);
    expect(mocks.emit).toHaveBeenCalledWith('db:ready');
    finish({ data: session, error: null });
    await useAuthStore.getState().refreshHostedSession();
  });
  it('does not authorize a changed token until its account is verified', async () => {
    await useAuthStore.getState().adoptSession();
    mocks.token = 'other-unverified-token';
    expect(getHostedSessionBinding()).toBeNull();
  });
  it('does not rebind a session whose request finished after sign-out', async () => {
    await useAuthStore.getState().adoptSession();
    let finish!: (value: unknown) => void;
    mocks.getSession.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = useAuthStore.getState().refreshHostedSession();
    await useAuthStore.getState().logout();
    finish({ data: session, error: null });
    await pending;
    expect(getHostedSessionBinding()).toBeNull();
    expect(useAuthStore.getState().hostedStatus).toBe('signed-out');
  });
  it('does not authorize a token replaced while validating the account', async () => {
    let finish!: (value: unknown) => void;
    mocks.getSession.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = useAuthStore.getState().adoptSession();
    mocks.token = 'replacement-token';
    mocks.revision++;
    finish({ data: session, error: null });
    await expect(pending).rejects.toThrow('SESSION_CHANGED');
    expect(getHostedSessionBinding()).toBeNull();
  });
});
