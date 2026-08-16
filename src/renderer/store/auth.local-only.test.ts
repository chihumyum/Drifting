import { beforeEach, describe, expect, it, vi } from 'vitest';

const authCalls = vi.hoisted(() => ({
  signIn: vi.fn(),
  signUp: vi.fn(),
  getSession: vi.fn(),
  initDatabase: vi.fn(),
  emit: vi.fn(),
}));

vi.mock('../lib/config', () => ({
  canUseHostedService: () => false,
  isAuthRequired: () => false,
}));

vi.mock('../lib/auth-client', () => ({
  authClient: {
    signIn: { email: authCalls.signIn },
    signUp: { email: authCalls.signUp },
    getSession: authCalls.getSession,
  },
}));

vi.mock('../lib/session-token', () => ({
  clearSessionToken: vi.fn(),
  flushSessionTokenStorage: vi.fn(),
  invalidateSessionToken: vi.fn(),
}));

vi.mock('../lib/db', () => ({
  initDatabase: authCalls.initDatabase,
  resetDatabase: vi.fn(),
}));

vi.mock('../lib/events', () => ({ events: { emit: authCalls.emit } }));

import { useAuthStore } from './auth';

describe('local-only account boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects account actions before the Better Auth client can dispatch', async () => {
    await expect(useAuthStore.getState().login('author@example.com', 'secret')).rejects.toThrow(
      'HOSTED_SERVICE_DISABLED',
    );
    await expect(
      useAuthStore.getState().register('author@example.com', 'secret', 'Author'),
    ).rejects.toThrow('HOSTED_SERVICE_DISABLED');
    await expect(useAuthStore.getState().adoptSession()).rejects.toThrow(
      'HOSTED_SERVICE_DISABLED',
    );

    expect(authCalls.signIn).not.toHaveBeenCalled();
    expect(authCalls.signUp).not.toHaveBeenCalled();
    expect(authCalls.getSession).not.toHaveBeenCalled();
  });

  it('opens the local SQLite replica before a cold protected route becomes ready', async () => {
    const firstCheck = useAuthStore.getState().checkSession();
    const strictModeDuplicate = useAuthStore.getState().checkSession();

    expect(strictModeDuplicate).toBe(firstCheck);
    await firstCheck;

    expect(authCalls.initDatabase).toHaveBeenCalledTimes(1);
    expect(authCalls.initDatabase).toHaveBeenCalledWith('drifting-library.db');
    expect(authCalls.emit).toHaveBeenCalledWith('db:ready');
    expect(authCalls.getSession).not.toHaveBeenCalled();
  });
});
