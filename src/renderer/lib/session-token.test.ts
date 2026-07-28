import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../platform', () => ({
  platform: { keychain: { get: mocks.get, set: mocks.set, delete: mocks.delete } },
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
    setItem: (key, value) => values.set(key, value),
  };
}

describe('session token durability', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.resetAllMocks();
    vi.stubEnv('VITE_DEV_SESSION_STORAGE', 'keychain');
    vi.stubGlobal('localStorage', createMemoryStorage());
  });

  it('uses local dev persistence only for loopback APIs', async () => {
    const { shouldUseLocalDevSessionStorage } = await import('./session-token');

    expect(
      shouldUseLocalDevSessionStorage({
        dev: true,
        mode: 'development',
        apiBaseUrl: 'http://localhost:3000',
      }),
    ).toBe(true);
    expect(
      shouldUseLocalDevSessionStorage({
        dev: true,
        mode: 'test',
        apiBaseUrl: 'http://localhost:3000',
      }),
    ).toBe(false);
    expect(
      shouldUseLocalDevSessionStorage({
        dev: true,
        mode: 'development',
        apiBaseUrl: 'http://127.example.com:3000',
      }),
    ).toBe(false);
    expect(
      shouldUseLocalDevSessionStorage({
        dev: true,
        mode: 'development',
        apiBaseUrl: 'https://api.drifting.cc',
        preference: 'local',
      }),
    ).toBe(false);
    expect(
      shouldUseLocalDevSessionStorage({
        dev: false,
        mode: 'production',
        apiBaseUrl: 'http://localhost:3000',
        preference: 'local',
      }),
    ).toBe(false);
    expect(
      shouldUseLocalDevSessionStorage({
        dev: true,
        mode: 'development',
        apiBaseUrl: 'http://localhost:3000',
        preference: 'keychain',
      }),
    ).toBe(false);
  });

  it('keeps loopback dev tokens out of the keychain', async () => {
    vi.stubEnv('VITE_DEV_SESSION_STORAGE', 'local');
    vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:3000');
    vi.resetModules();
    localStorage.setItem('drifting.dev.session_token', 'existing-dev-token');

    const {
      clearSessionToken,
      flushSessionTokenStorage,
      getSessionToken,
      hydrateSessionToken,
      setSessionToken,
    } = await import('./session-token');

    await hydrateSessionToken();
    expect(getSessionToken()).toBe('existing-dev-token');
    expect(mocks.get).not.toHaveBeenCalled();

    setSessionToken('next-dev-token');
    await flushSessionTokenStorage();
    expect(localStorage.getItem('drifting.dev.session_token')).toBe('next-dev-token');
    expect(mocks.set).not.toHaveBeenCalled();

    clearSessionToken();
    await flushSessionTokenStorage();
    expect(getSessionToken()).toBeNull();
    expect(localStorage.getItem('drifting.dev.session_token')).toBeNull();
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it('hydrates packaged and remote-connected sessions from secure storage', async () => {
    mocks.get.mockResolvedValue('secure-token');
    const { getSessionToken, hydrateSessionToken } = await import('./session-token');

    await hydrateSessionToken();

    expect(getSessionToken()).toBe('secure-token');
    expect(mocks.get).toHaveBeenCalledOnce();
    expect(mocks.get).toHaveBeenCalledWith('drifting.session_token');
    expect(localStorage.getItem('drifting.dev.session_token')).toBeNull();
  });

  it('surfaces a secure-storage write failure and allows a later retry', async () => {
    mocks.set.mockRejectedValueOnce(new Error('keychain unavailable')).mockResolvedValueOnce(true);
    const { flushSessionTokenStorage, getSessionToken, setSessionToken } =
      await import('./session-token');

    setSessionToken('session-token');
    await expect(flushSessionTokenStorage()).rejects.toThrow(
      '1 session-token persistence step(s) failed',
    );
    expect(getSessionToken()).toBe('session-token');

    setSessionToken('session-token');
    await expect(flushSessionTokenStorage()).resolves.toBeUndefined();
    expect(mocks.set).toHaveBeenCalledTimes(2);
    expect(getSessionToken()).toBe('session-token');
  });

  it('keeps a failed delete retryable and only clears memory after secure success', async () => {
    mocks.set.mockResolvedValue(true);
    mocks.delete
      .mockRejectedValueOnce(new Error('keychain unavailable'))
      .mockResolvedValueOnce(true);
    const { clearSessionToken, flushSessionTokenStorage, getSessionToken, setSessionToken } =
      await import('./session-token');

    setSessionToken('session-token');
    await flushSessionTokenStorage();

    clearSessionToken();
    await expect(flushSessionTokenStorage()).rejects.toThrow(
      '1 session-token persistence step(s) failed',
    );
    expect(getSessionToken()).toBe('session-token');

    clearSessionToken();
    await expect(flushSessionTokenStorage()).resolves.toBeUndefined();
    expect(mocks.delete).toHaveBeenCalledTimes(2);
    expect(getSessionToken()).toBeNull();
  });

  it('invalidates a rejected bearer in memory even when secure deletion fails', async () => {
    mocks.set.mockResolvedValue(true);
    mocks.delete.mockRejectedValueOnce(new Error('keychain unavailable'));
    const {
      flushSessionTokenStorage,
      getSessionToken,
      invalidateSessionToken,
      setSessionToken,
    } = await import('./session-token');

    setSessionToken('rejected-token');
    await flushSessionTokenStorage();

    invalidateSessionToken();
    expect(getSessionToken()).toBeNull();
    await expect(flushSessionTokenStorage()).rejects.toThrow(
      '1 session-token persistence step(s) failed',
    );
    expect(getSessionToken()).toBeNull();
  });
});
