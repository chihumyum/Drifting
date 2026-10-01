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
  updateUser: vi.fn(),
  changePassword: vi.fn(),
  accountFetch: vi.fn(),
  flushToken: vi.fn(),
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
    updateUser: mocks.updateUser,
    changePassword: mocks.changePassword,
  },
  hostedAccountFetch: mocks.accountFetch,
}));
vi.mock('../lib/session-token', () => ({
  getSessionToken: () => mocks.token,
  getSessionTokenRevision: () => mocks.revision,
  setSessionToken: (value: string) => {
    mocks.token = value;
    mocks.revision++;
  },
  clearSessionToken: () => {
    mocks.token = null;
    mocks.revision++;
  },
  invalidateSessionToken: () => {
    mocks.token = null;
    mocks.revision++;
  },
  flushSessionTokenStorage: mocks.flushToken,
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
  mocks.revision = 0;
  clearHostedSessionBinding();
  mocks.getSession.mockResolvedValue({ data: session, error: null });
  mocks.signOut.mockResolvedValue({ error: null });
  mocks.signIn.mockResolvedValue({ error: null });
  mocks.flushToken.mockResolvedValue(undefined);
  mocks.updateUser.mockResolvedValue({ data: { status: true }, error: null });
  mocks.accountFetch.mockImplementation(
    async () =>
      new Response('{}', {
        headers: { 'set-auth-token': 'rotated-token' },
      }),
  );
  mocks.changePassword.mockImplementation(async (_body, options) => {
    await options.customFetchImpl('http://localhost:3000/api/auth/change-password');
    return { data: { token: 'raw-rotated-token', user: session.user }, error: null };
  });
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

describe('Hosted account edits', () => {
  it('saves trimmed names and avatar removal to all display state without changing the library', async () => {
    await useAuthStore.getState().adoptSession();
    const local = useAuthStore.getState().user;
    await useAuthStore.getState().updateHostedProfile({ name: '  新昵称  ', image: null });
    expect(mocks.updateUser).toHaveBeenCalledWith(
      { name: '新昵称', image: null },
      expect.any(Object),
    );
    expect(useAuthStore.getState().hostedUser).toMatchObject({
      id: 'account-a',
      name: '新昵称',
      image: null,
    });
    expect(useAuthStore.getState().session?.user.name).toBe('新昵称');
    expect(mocks.writeProfile).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: '新昵称' }),
    );
    expect(useAuthStore.getState().user).toBe(local);
    expect(getHostedSessionBinding()?.accountSubject).toBe('account-a');
  });
  it('keeps the saved profile on a rejected edit and blocks invalid requests before sending', async () => {
    await useAuthStore.getState().adoptSession();
    await expect(useAuthStore.getState().updateHostedProfile({ name: ' ' })).rejects.toThrow(
      'INVALID_PROFILE_NAME',
    );
    expect(mocks.updateUser).not.toHaveBeenCalled();
    mocks.updateUser.mockResolvedValueOnce({ error: { status: 500, code: 'INTERNAL_ERROR' } });
    await expect(useAuthStore.getState().updateHostedProfile({ name: '新昵称' })).rejects.toThrow(
      'INTERNAL_ERROR',
    );
    expect(useAuthStore.getState().hostedUser?.name).toBe('Synthetic');
  });
  it('discards profile responses that arrive after sign-out', async () => {
    await useAuthStore.getState().adoptSession();
    let finish!: (value: unknown) => void;
    mocks.updateUser.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = useAuthStore.getState().updateHostedProfile({ name: 'Late' });
    await vi.waitFor(() => expect(mocks.updateUser).toHaveBeenCalled());
    await useAuthStore.getState().logout();
    finish({ data: { status: true }, error: null });
    await expect(pending).rejects.toThrow('SESSION_CHANGED');
    expect(useAuthStore.getState().hostedUser).toBeNull();
  });
  it('drains older profile refreshes and prevents refreshes and duplicate edits during saving', async () => {
    await useAuthStore.getState().adoptSession();
    let finishRefresh!: (value: unknown) => void;
    mocks.getSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRefresh = resolve;
        }),
    );
    const refresh = useAuthStore.getState().refreshHostedSession();
    const saving = useAuthStore.getState().updateHostedProfile({ name: 'Newer' });
    const nextRefresh = useAuthStore.getState().refreshHostedSession();
    await expect(
      useAuthStore.getState().updateHostedProfile({ name: 'Duplicate' }),
    ).rejects.toThrow('ACCOUNT_UPDATE_IN_PROGRESS');
    expect(mocks.updateUser).not.toHaveBeenCalled();
    finishRefresh({ data: session, error: null });
    await Promise.all([refresh, saving, nextRefresh]);
    expect(useAuthStore.getState().hostedUser?.name).toBe('Newer');
    expect(mocks.getSession).toHaveBeenCalledTimes(2);
  });
  it('validates confirmation and leaves authentication intact when the old password is wrong', async () => {
    await useAuthStore.getState().adoptSession();
    await expect(
      useAuthStore.getState().changeHostedPassword('old-pass', 'new-password', 'different'),
    ).rejects.toThrow('PASSWORD_MISMATCH');
    expect(mocks.changePassword).not.toHaveBeenCalled();
    mocks.changePassword.mockResolvedValueOnce({
      error: { status: 400, code: 'INVALID_PASSWORD' },
    });
    await expect(
      useAuthStore.getState().changeHostedPassword('wrong-pass', 'new-password', 'new-password'),
    ).rejects.toThrow('INVALID_PASSWORD');
    expect(mocks.token).toBe('synthetic-token');
    expect(useAuthStore.getState().hostedStatus).toBe('connected');
  });
  it('persists and revalidates the rotated bearer before rebinding sync after a password change', async () => {
    await useAuthStore.getState().adoptSession();
    await useAuthStore.getState().changeHostedPassword('old-pass', 'new-password', 'new-password');
    expect(mocks.changePassword).toHaveBeenCalledWith(
      {
        currentPassword: 'old-pass',
        newPassword: 'new-password',
        revokeOtherSessions: true,
      },
      expect.any(Object),
    );
    expect(mocks.token).toBe('rotated-token');
    expect(mocks.flushToken).toHaveBeenCalledTimes(2);
    expect(getHostedSessionBinding()).toEqual({
      accountSubject: 'account-a',
      token: 'rotated-token',
    });
    expect(useAuthStore.getState().hostedStatus).toBe('connected');
  });
  it('does not restore a revoked token when storing the new session fails', async () => {
    await useAuthStore.getState().adoptSession();
    mocks.flushToken.mockRejectedValueOnce(new Error('secure storage unavailable'));
    await expect(
      useAuthStore.getState().changeHostedPassword('old-pass', 'new-password', 'new-password'),
    ).rejects.toThrow('PASSWORD_CHANGED_SIGN_IN_REQUIRED');
    expect(mocks.token).toBeNull();
    expect(getHostedSessionBinding()).toBeNull();
    expect(useAuthStore.getState().hostedStatus).toBe('needs-reauth');
  });
  it('does not adopt a delayed password response after sign-out', async () => {
    await useAuthStore.getState().adoptSession();
    let finish!: (value: Response) => void;
    mocks.accountFetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = useAuthStore
      .getState()
      .changeHostedPassword('old-pass', 'new-password', 'new-password');
    await vi.waitFor(() => expect(mocks.accountFetch).toHaveBeenCalled());
    await useAuthStore.getState().logout();
    finish(new Response('{}', { headers: { 'set-auth-token': 'late-token' } }));
    await expect(pending).rejects.toThrow('SESSION_CHANGED');
    expect(mocks.token).toBeNull();
    expect(getHostedSessionBinding()).toBeNull();
  });
  it('expires rejected credentials without losing the expected profile or local identity', async () => {
    await useAuthStore.getState().adoptSession();
    mocks.updateUser.mockResolvedValueOnce({ error: { status: 401, code: 'UNAUTHORIZED' } });
    await expect(useAuthStore.getState().updateHostedProfile({ name: 'New' })).rejects.toThrow(
      'UNAUTHORIZED',
    );
    expect(useAuthStore.getState()).toMatchObject({
      user: { id: LOCAL_USER_ID },
      hostedUser: { name: 'Synthetic' },
      hostedStatus: 'needs-reauth',
    });
  });
});

describe('In-flight sync during a password change', () => {
  it('waits for rotation and ignores the expired request token', async () => {
    await useAuthStore.getState().adoptSession();
    let finish!: (value: Response) => void;
    mocks.accountFetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const changing = useAuthStore
      .getState()
      .changeHostedPassword('old-pass', 'new-password', 'new-password');
    await vi.waitFor(() => expect(mocks.accountFetch).toHaveBeenCalled());
    const expired = useAuthStore.getState().expireSession('synthetic-token');
    finish(new Response('{}', { headers: { 'set-auth-token': 'rotated-token' } }));
    await Promise.all([changing, expired]);
    expect(mocks.token).toBe('rotated-token');
    expect(useAuthStore.getState().hostedStatus).toBe('connected');
  });
});
