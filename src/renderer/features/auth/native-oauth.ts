import { useEffect, useLayoutEffect, useRef } from 'react';
import { create } from 'zustand';
import { platform } from '../../platform';
import {
  NATIVE_OAUTH_STATE_TTL_MS,
  clearPendingNativeOAuth,
} from '../../platform/native-oauth-state';

/** What came back from the browser: a session token, or why there is none. */
export type NativeOAuthOutcome = { token: string } | { error: string };

interface NativeOAuthState {
  /** The provider whose browser sign-in the app is waiting for. */
  waiting: string | null;
  /** A returned sign-in no flow has taken yet. */
  outcome: NativeOAuthOutcome | null;
}

/**
 * Social sign-in outlives the screen that started it: the author may close
 * the dialog while the browser is open, or the browser may launch the app
 * cold. One listener, installed for the whole app, receives every callback;
 * a mounted sign-in flow takes the outcome, and with none mounted the
 * sign-in dialog opens to take it.
 */
export const useNativeOAuthStore = create<NativeOAuthState>()(() => ({
  waiting: null,
  outcome: null,
}));

let mountedFlows = 0;
let expiry: ReturnType<typeof setTimeout> | null = null;

function stopExpiry() {
  if (expiry) clearTimeout(expiry);
  expiry = null;
}

/** Opens the provider in the system browser and waits for its callback. */
export async function startNativeOAuth(provider: string): Promise<void> {
  stopExpiry();
  useNativeOAuthStore.setState({ waiting: provider, outcome: null });
  try {
    await platform.auth.openOAuthBrowser(provider);
  } catch (error) {
    useNativeOAuthStore.setState({ waiting: null });
    throw error;
  }
  // The pending state expires with it; an open flow says so, a closed one stays quiet.
  expiry = setTimeout(() => {
    expiry = null;
    clearPendingNativeOAuth();
    useNativeOAuthStore.setState({
      waiting: null,
      outcome: mountedFlows > 0 ? { error: 'expired' } : null,
    });
  }, NATIVE_OAUTH_STATE_TTL_MS);
}

/** Stops waiting; a callback that still arrives is ignored. */
export function cancelNativeOAuth(): void {
  stopExpiry();
  clearPendingNativeOAuth();
  useNativeOAuthStore.setState({ waiting: null });
}

/** Installed once for the app; `openSignIn` shows a flow when none is mounted. */
export function installNativeOAuth(openSignIn: () => void): () => void {
  return platform.auth.onOAuthCallback(({ token, error }) => {
    stopExpiry();
    useNativeOAuthStore.setState({
      waiting: null,
      outcome: token ? { token } : { error: error ?? 'oauth_failed' },
    });
    if (mountedFlows === 0) openSignIn();
  });
}

/** Counts a mounted sign-in flow; while one is mounted, returns do not open another. */
export function registerNativeOAuthFlow(): () => void {
  mountedFlows += 1;
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    mountedFlows -= 1;
  };
}

/** Takes the returned sign-in, so exactly one flow handles it. */
export function takeNativeOAuthOutcome(): NativeOAuthOutcome | null {
  const { outcome } = useNativeOAuthStore.getState();
  if (outcome) useNativeOAuthStore.setState({ outcome: null });
  return outcome;
}

/** A mounted sign-in flow; it receives each returned sign-in exactly once. */
export function useNativeOAuthOutcome(onOutcome: (outcome: NativeOAuthOutcome) => void): void {
  const handler = useRef(onOutcome);
  useLayoutEffect(() => {
    handler.current = onOutcome;
  }, [onOutcome]);
  useEffect(() => registerNativeOAuthFlow(), []);
  const outcome = useNativeOAuthStore((state) => state.outcome);
  useEffect(() => {
    if (!outcome) return;
    const taken = takeNativeOAuthOutcome();
    if (taken) handler.current(taken);
  }, [outcome]);
}

/** Maps a callback error to the sentence the flow shows. */
export function nativeOAuthErrorKey(error: string): string {
  if (error === 'access_denied') return 'auth.errors.oauthCancelled';
  if (error === 'expired' || error === 'state_mismatch') return 'auth.errors.oauthExpired';
  if (error === 'account_not_linked') return 'auth.errors.oauthAccountNotLinked';
  return 'auth.errors.oauthFailed';
}

/** Test seam. */
export function resetNativeOAuthForTests(): void {
  stopExpiry();
  mountedFlows = 0;
  useNativeOAuthStore.setState({ waiting: null, outcome: null });
}
