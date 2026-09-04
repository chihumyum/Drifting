/**
 * ChatGPT subscription facade — thin renderer-side wrapper over the native
 * Codex OAuth commands. Experimental and unsupported: the OAuth tokens live
 * only in native secure storage, so this module never sees a secret; it
 * drives the device-code sign-in and reads non-secret status.
 */

import { platform } from '../platform';
import type { CodexLoginProjection, CodexSubscriptionStatus } from '../platform';

export type { CodexLoginProjection, CodexSubscriptionStatus };

export const codexSubscription = {
  status(): Promise<CodexSubscriptionStatus> {
    return platform.codexSubscription.status();
  },
  /** Starts a sign-in and opens the OpenAI device page for the one-time code. */
  async startLogin(): Promise<CodexLoginProjection> {
    const login = await platform.codexSubscription.startLogin();
    void platform.material.openExternal(login.verificationUrl);
    return login;
  },
  openVerification(login: CodexLoginProjection): void {
    void platform.material.openExternal(login.verificationUrl);
  },
  cancelLogin(): Promise<boolean> {
    return platform.codexSubscription.cancelLogin();
  },
  logout(): Promise<boolean> {
    return platform.codexSubscription.logout();
  },
};

/** A sign-in attempt still waiting on the browser or the token exchange. */
export function isCodexLoginActive(status: CodexSubscriptionStatus | null): boolean {
  const phase = status?.login?.phase;
  return phase === 'awaiting_authorization' || phase === 'exchanging';
}
