/**
 * Persistent storage for the Claude OAuth tokens, in the OS keychain.
 *
 * Reuses the same `@napi-rs/keyring` service ('Drifting') as BYOK keys, under
 * a dedicated account id. `getValidAccessToken()` transparently refreshes an
 * expired token and re-persists the rotated credentials.
 */
import { Entry } from '@napi-rs/keyring';
import { isTokenExpired, refreshClaudeToken, type ClaudeTokens } from './oauth';

const SERVICE = 'Drifting';
const ACCOUNT = 'claude-agent.oauth';

function entry(): Entry {
  return new Entry(SERVICE, ACCOUNT);
}

export function getStoredTokens(): ClaudeTokens | null {
  try {
    const raw = entry().getPassword();
    if (!raw) return null;
    return JSON.parse(raw) as ClaudeTokens;
  } catch {
    return null;
  }
}

export function setStoredTokens(tokens: ClaudeTokens): void {
  try {
    entry().setPassword(JSON.stringify(tokens));
  } catch (err) {
    console.error('[agent] failed to persist Claude tokens', err);
  }
}

export function clearStoredTokens(): void {
  try {
    entry().deletePassword();
  } catch {
    /* nothing stored */
  }
}

export function isAuthenticated(): boolean {
  return !!getStoredTokens()?.accessToken;
}

/**
 * Return a usable access token, refreshing (and re-persisting) if expired.
 * Returns null when the user is not connected or the refresh fails.
 */
export async function getValidAccessToken(): Promise<string | null> {
  const tokens = getStoredTokens();
  if (!tokens?.accessToken) return null;

  if (!isTokenExpired(tokens.expiresAt)) {
    return tokens.accessToken;
  }

  if (!tokens.refreshToken) {
    // Can't refresh — surface as "not authenticated" so the UI re-prompts.
    return null;
  }

  try {
    const refreshed = await refreshClaudeToken(tokens.refreshToken);
    setStoredTokens(refreshed);
    return refreshed.accessToken;
  } catch (err) {
    console.error('[agent] token refresh failed', err);
    return null;
  }
}
