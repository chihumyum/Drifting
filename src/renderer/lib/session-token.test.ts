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
    vi.resetModules();
    vi.resetAllMocks();
    vi.stubGlobal('localStorage', createMemoryStorage());
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
