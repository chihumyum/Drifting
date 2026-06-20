/**
 * Bearer session token store.
 *
 * The packaged desktop renderer talks to the API cross-site, and better-auth
 * rejects cookie-bearing requests that lack a usable Origin (Electron's
 * custom-scheme / file:// POSTs don't send one) with MISSING_OR_NULL_ORIGIN.
 * So instead of cookies we use token auth: capture the token from better-auth's
 * `set-auth-token` response header and send it as `Authorization: Bearer` on
 * every API call. better-auth's origin/CSRF check is, by design, skipped for
 * requests that carry no cookie.
 */
const KEY = 'drifting.session_token';

export function getSessionToken(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setSessionToken(token: string): void {
  try {
    localStorage.setItem(KEY, token);
  } catch {
    /* localStorage unavailable — ignore */
  }
}

export function clearSessionToken(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* localStorage unavailable — ignore */
  }
}
