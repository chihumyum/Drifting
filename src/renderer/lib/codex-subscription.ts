/**
 * ChatGPT subscription facade — thin renderer-side wrapper over the native
 * Codex OAuth commands. Experimental and unsupported: the OAuth tokens live
 * only in native secure storage, so this module never sees a secret; it
 * drives the device-code sign-in and reads non-secret status.
 */

import { platform } from '../platform';
import type { CodexLoginProjection, CodexSubscriptionStatus } from '../platform';
import { codexModelCatalog } from './agent/codex-model-catalog';

export type { CodexLoginProjection, CodexSubscriptionStatus };

let lastIdentity: string | undefined;

export const codexSubscription = {
  async status(): Promise<CodexSubscriptionStatus> {
    const status = await platform.codexSubscription.status();
    const identity = JSON.stringify([status.signedIn, status.account?.accountId, status.account?.email,
      status.login?.phase === 'authenticated' ? status.login.attemptId : null]);
    if (identity !== lastIdentity) {
      lastIdentity = identity;
      codexModelCatalog.invalidate();
    }
    return status;
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
  async logout(): Promise<boolean> {
    const result = await platform.codexSubscription.logout();
    codexModelCatalog.invalidate();
    return result;
  },
};

/** A sign-in attempt still waiting on the browser or the token exchange. */
export function isCodexLoginActive(status: CodexSubscriptionStatus | null): boolean {
  const phase = status?.login?.phase;
  return phase === 'awaiting_authorization' || phase === 'exchanging';
}
