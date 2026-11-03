import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OAuthCallback } from '../../platform/types';

const native = vi.hoisted(() => ({
  deliver: null as ((data: OAuthCallback) => void) | null,
  opened: [] as string[],
  openFails: false,
  cleared: 0,
}));

vi.mock('../../platform', () => ({
  platform: {
    auth: {
      async openOAuthBrowser(provider: string) {
        if (native.openFails) throw new Error('no browser');
        native.opened.push(provider);
      },
      onOAuthCallback(callback: (data: OAuthCallback) => void) {
        native.deliver = callback;
        return () => {
          native.deliver = null;
        };
      },
    },
  },
}));
vi.mock('../../platform/native-oauth-state', () => ({
  NATIVE_OAUTH_STATE_TTL_MS: 10 * 60 * 1000,
  clearPendingNativeOAuth: () => {
    native.cleared += 1;
  },
}));

import {
  cancelNativeOAuth,
  installNativeOAuth,
  nativeOAuthErrorKey,
  registerNativeOAuthFlow,
  resetNativeOAuthForTests,
  startNativeOAuth,
  takeNativeOAuthOutcome,
  useNativeOAuthStore,
} from './native-oauth';

describe('native social sign-in coordination', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetNativeOAuthForTests();
    Object.assign(native, { deliver: null, opened: [], openFails: false, cleared: 0 });
  });
  afterEach(() => vi.useRealTimers());

  it('waits for the browser and hands the token to the mounted flow', async () => {
    const openSignIn = vi.fn();
    const stop = installNativeOAuth(openSignIn);
    const unregister = registerNativeOAuthFlow();
    await startNativeOAuth('google');
    expect(native.opened).toEqual(['google']);
    expect(useNativeOAuthStore.getState().waiting).toBe('google');

    native.deliver?.({ token: 'session-token', error: null });
    expect(useNativeOAuthStore.getState().waiting).toBeNull();
    expect(openSignIn).not.toHaveBeenCalled();
    expect(takeNativeOAuthOutcome()).toEqual({ token: 'session-token' });
    expect(takeNativeOAuthOutcome()).toBeNull();
    unregister();
    stop();
  });

  it('opens sign-in for a callback that arrives with no flow mounted (cold start, closed dialog)', () => {
    const openSignIn = vi.fn();
    installNativeOAuth(openSignIn);
    native.deliver?.({ token: 'cold-start-token', error: null });
    expect(openSignIn).toHaveBeenCalledOnce();
    // The dialog's flow takes the waiting outcome when it mounts.
    const unregister = registerNativeOAuthFlow();
    expect(takeNativeOAuthOutcome()).toEqual({ token: 'cold-start-token' });
    unregister();
    unregister();
    native.deliver?.({ token: null, error: 'access_denied' });
    expect(openSignIn).toHaveBeenCalledTimes(2);
    expect(takeNativeOAuthOutcome()).toEqual({ error: 'access_denied' });
  });

  it('cancels the wait and abandons the pending state', async () => {
    const unregister = registerNativeOAuthFlow();
    await startNativeOAuth('google');
    cancelNativeOAuth();
    expect(useNativeOAuthStore.getState().waiting).toBeNull();
    expect(native.cleared).toBe(1);
    // The expiry timer is gone too.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
    expect(takeNativeOAuthOutcome()).toBeNull();
    unregister();
  });

  it('times out with the pending state, telling an open flow and staying quiet otherwise', async () => {
    const unregister = registerNativeOAuthFlow();
    await startNativeOAuth('google');
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(useNativeOAuthStore.getState().waiting).toBeNull();
    expect(native.cleared).toBe(1);
    expect(takeNativeOAuthOutcome()).toEqual({ error: 'expired' });
    unregister();

    await startNativeOAuth('google');
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(takeNativeOAuthOutcome()).toBeNull();
  });

  it('stops waiting when the browser cannot open', async () => {
    native.openFails = true;
    await expect(startNativeOAuth('google')).rejects.toThrow('no browser');
    expect(useNativeOAuthStore.getState().waiting).toBeNull();
  });

  it('names cancel, timeout and unverified accounts; everything else is a plain failure', () => {
    expect(nativeOAuthErrorKey('access_denied')).toBe('auth.errors.oauthCancelled');
    expect(nativeOAuthErrorKey('expired')).toBe('auth.errors.oauthExpired');
    expect(nativeOAuthErrorKey('state_mismatch')).toBe('auth.errors.oauthExpired');
    expect(nativeOAuthErrorKey('account_not_linked')).toBe('auth.errors.oauthAccountNotLinked');
    expect(nativeOAuthErrorKey('exchange_failed')).toBe('auth.errors.oauthFailed');
  });
});
