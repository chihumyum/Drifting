import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  signOut: vi.fn(),
  getSession: vi.fn(),
  clearSessionToken: vi.fn(),
  invalidateSessionToken: vi.fn(),
  flushSessionTokenStorage: vi.fn(),
  initDatabase: vi.fn(),
  resetDatabase: vi.fn(),
  flushLocal: vi.fn(),
  flushRemote: vi.fn(),
  quiesce: vi.fn(),
  quiesceAfterCredentialLoss: vi.fn(),
  stopPreferencesSync: vi.fn(),
}));

vi.mock('../lib/auth-client', () => ({
  authClient: { signOut: mocks.signOut, getSession: mocks.getSession },
}));
vi.mock('../lib/session-token', () => ({
  clearSessionToken: mocks.clearSessionToken,
  invalidateSessionToken: mocks.invalidateSessionToken,
  flushSessionTokenStorage: mocks.flushSessionTokenStorage,
}));
vi.mock('../lib/config', () => ({ isAuthRequired: () => true }));
vi.mock('../utils/appAccess', () => ({
  APP_CLOSED_MESSAGE: 'closed',
  isAppClosedForPublic: false,
}));
vi.mock('../lib/db', () => ({
  initDatabase: mocks.initDatabase,
  resetDatabase: mocks.resetDatabase,
}));
vi.mock('../lib/events', () => ({
  events: { emit: vi.fn() },
}));
vi.mock('../lib/persistence-lifecycle', () => ({
  flushLocalApplicationPersistence: mocks.flushLocal,
  flushRemoteApplicationPersistence: mocks.flushRemote,
  quiesceApplicationForDatabaseSwitch: mocks.quiesce,
  quiesceApplicationAfterCredentialLoss: mocks.quiesceAfterCredentialLoss,
}));
vi.mock('../services/preferences-sync.service', () => ({
  stopPreferencesSync: mocks.stopPreferencesSync,
}));

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe('auth store persistence', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    mocks.order.length = 0;
    mocks.flushLocal.mockImplementation(async () => {
      mocks.order.push('persistence:local');
    });
    mocks.flushRemote.mockImplementation(async () => {
      mocks.order.push('persistence:remote');
    });
    mocks.quiesce.mockImplementation(async (unmount: () => void) => {
      mocks.order.push('quiesce:start');
      unmount();
      mocks.order.push('quiesce:done');
    });
    mocks.stopPreferencesSync.mockImplementation(() => mocks.order.push('preferences:stop'));
    mocks.signOut.mockImplementation(async () => {
      mocks.order.push('signOut');
      return { data: { success: true }, error: null };
    });
    mocks.clearSessionToken.mockImplementation(() => mocks.order.push('token:clear'));
    mocks.invalidateSessionToken.mockImplementation(() => mocks.order.push('token:invalidate'));
    mocks.flushSessionTokenStorage.mockImplementation(async () => {
      mocks.order.push('token:flush');
    });
    mocks.resetDatabase.mockImplementation(async () => {
      mocks.order.push('database:reset');
    });
    mocks.initDatabase.mockImplementation(async () => {
      mocks.order.push('database:init');
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('removes the legacy persisted session and never writes a new one', async () => {
    const storage = createMemoryStorage();
    storage.setItem(
      'auth-storage',
      JSON.stringify({
        state: {
          isAuthenticated: true,
          session: { session: { token: 'plaintext-session-token' } },
        },
        version: 0,
      }),
    );
    const setItem = vi.spyOn(storage, 'setItem');
    vi.stubGlobal('localStorage', storage);

    const { useAuthStore } = await import('./auth');

    expect(storage.getItem('auth-storage')).toBeNull();
    useAuthStore.setState({
      isAuthenticated: true,
      session: { session: { token: 'new-session-token' } } as never,
    });
    expect(setItem).not.toHaveBeenCalled();
    expect(storage.getItem('auth-storage')).toBeNull();
  });

  it('quiesces mounted data and persists token deletion before switching databases on logout', async () => {
    vi.stubGlobal('localStorage', createMemoryStorage());
    const { useAuthStore } = await import('./auth');
    useAuthStore.setState({
      isAuthenticated: true,
      session: {} as never,
      user: {
        id: 'outgoing-user',
        email: 'writer@example.com',
        name: 'Writer',
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    await useAuthStore.getState().logout();

    expect(mocks.order).toEqual([
      'persistence:local',
      'persistence:remote',
      'signOut',
      'token:clear',
      'token:flush',
      'quiesce:start',
      'quiesce:done',
      'preferences:stop',
      'database:reset',
      'database:init',
    ]);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(mocks.initDatabase).toHaveBeenCalledWith('drifting-library.db');
  });

  it('keeps the authenticated DB/state intact after secure delete failure and can retry', async () => {
    vi.stubGlobal('localStorage', createMemoryStorage());
    mocks.flushSessionTokenStorage
      .mockImplementationOnce(async () => {
        mocks.order.push('token:flush');
        throw new Error('secure delete failed');
      })
      .mockImplementation(async () => {
        mocks.order.push('token:flush');
      });
    const { useAuthStore } = await import('./auth');
    const outgoingUser = {
      id: 'outgoing-user',
      email: 'writer@example.com',
      name: 'Writer',
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const outgoingSession = {} as never;
    useAuthStore.setState({
      isAuthenticated: true,
      session: outgoingSession,
      user: outgoingUser,
    });

    await expect(useAuthStore.getState().logout()).rejects.toThrow('secure delete failed');

    expect(mocks.quiesce).not.toHaveBeenCalled();
    expect(mocks.resetDatabase).not.toHaveBeenCalled();
    expect(mocks.initDatabase).not.toHaveBeenCalled();
    expect(mocks.stopPreferencesSync).not.toHaveBeenCalled();
    expect(useAuthStore.getState()).toMatchObject({
      isAuthenticated: true,
      session: outgoingSession,
      user: outgoingUser,
    });

    mocks.order.length = 0;
    await expect(useAuthStore.getState().logout()).resolves.toBeUndefined();

    expect(mocks.order).toEqual([
      'persistence:local',
      'persistence:remote',
      'signOut',
      'token:clear',
      'token:flush',
      'quiesce:start',
      'quiesce:done',
      'preferences:stop',
      'database:reset',
      'database:init',
    ]);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('keeps the credential and authenticated state when server revocation fails', async () => {
    vi.stubGlobal('localStorage', createMemoryStorage());
    mocks.signOut
      .mockImplementationOnce(async () => {
        mocks.order.push('signOut');
        return { data: null, error: { message: 'server unavailable' } };
      })
      .mockImplementation(async () => {
        mocks.order.push('signOut');
        return { data: { success: true }, error: null };
      });
    const { useAuthStore } = await import('./auth');
    const outgoingUser = {
      id: 'outgoing-user',
      email: 'writer@example.com',
      name: 'Writer',
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    useAuthStore.setState({
      isAuthenticated: true,
      session: {} as never,
      user: outgoingUser,
    });

    await expect(useAuthStore.getState().logout()).rejects.toThrow('server unavailable');

    expect(mocks.clearSessionToken).not.toHaveBeenCalled();
    expect(mocks.quiesce).not.toHaveBeenCalled();
    expect(mocks.resetDatabase).not.toHaveBeenCalled();
    expect(useAuthStore.getState()).toMatchObject({
      isAuthenticated: true,
      user: outgoingUser,
    });

    mocks.order.length = 0;
    await expect(useAuthStore.getState().logout()).resolves.toBeUndefined();
    expect(mocks.order).toContain('token:clear');
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('coalesces concurrent 401 expiry without remote calls and always leaves protected state', async () => {
    vi.stubGlobal('localStorage', createMemoryStorage());
    let releaseTeardown!: () => void;
    mocks.quiesceAfterCredentialLoss.mockImplementation(async (unmount: () => void) => {
      mocks.order.push('credential-quiesce:start');
      unmount();
      await new Promise<void>((resolve) => {
        releaseTeardown = resolve;
      });
      mocks.order.push('credential-quiesce:done');
    });

    const { useAuthStore } = await import('./auth');
    useAuthStore.setState({
      isAuthenticated: true,
      session: {} as never,
      user: {
        id: 'expired-user',
        email: 'writer@example.com',
        name: 'Writer',
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const first = useAuthStore.getState().expireSession();
    const second = useAuthStore.getState().expireSession();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(mocks.quiesceAfterCredentialLoss).toHaveBeenCalledOnce());
    expect(useAuthStore.getState().isAuthenticated).toBe(false);

    releaseTeardown();
    await Promise.all([first, second]);

    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.flushRemote).not.toHaveBeenCalled();
    expect(mocks.invalidateSessionToken).toHaveBeenCalledOnce();
    expect(mocks.order).toEqual([
      'token:invalidate',
      'credential-quiesce:start',
      'credential-quiesce:done',
      'preferences:stop',
      'database:reset',
      'database:init',
    ]);
    expect(useAuthStore.getState()).toMatchObject({
      isAuthenticated: false,
      session: null,
      user: null,
    });
  });

  it('durably removes an expired bootstrap token without resetting the anonymous database', async () => {
    vi.stubGlobal('localStorage', createMemoryStorage());
    const { useAuthStore } = await import('./auth');

    await useAuthStore.getState().expireSession();

    expect(mocks.order).toEqual(['token:invalidate', 'token:flush']);
    expect(mocks.quiesceAfterCredentialLoss).not.toHaveBeenCalled();
    expect(mocks.resetDatabase).not.toHaveBeenCalled();
    expect(mocks.initDatabase).not.toHaveBeenCalled();
  });

  it('coalesces concurrent session checks into one database bootstrap', async () => {
    vi.stubGlobal('localStorage', createMemoryStorage());
    let resolveSession!: (value: unknown) => void;
    mocks.getSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSession = resolve;
        }),
    );
    const { useAuthStore } = await import('./auth');

    const first = useAuthStore.getState().checkSession();
    const second = useAuthStore.getState().checkSession();

    expect(second).toBe(first);
    expect(mocks.getSession).toHaveBeenCalledOnce();
    resolveSession({
      data: {
        user: {
          id: 'bootstrap-user',
          email: 'writer@example.com',
          name: 'Writer',
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      error: null,
    });
    await Promise.all([first, second]);

    expect(mocks.flushLocal).toHaveBeenCalledOnce();
    expect(mocks.resetDatabase).toHaveBeenCalledOnce();
    expect(mocks.initDatabase).toHaveBeenCalledOnce();
    expect(mocks.initDatabase).toHaveBeenCalledWith('bootstrap-user');
    expect(useAuthStore.getState()).toMatchObject({
      isAuthenticated: true,
      user: { id: 'bootstrap-user' },
    });
  });
});
