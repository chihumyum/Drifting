import loglevel from 'loglevel';
import { platform } from '../platform';

/**
 * Bearer session token store.
 *
 * The synchronous getter is retained because better-auth and Axios read the
 * token while constructing a request. Persistence is delegated to Tauri's
 * secure-storage adapter; plaintext localStorage is read only once as a
 * migration source and removed after a successful secure write.
 */
const KEY = 'drifting.session_token';
const log = loglevel.getLogger('SessionToken');

let tokenInMemory: string | null = null;
let hydrated = false;
let pendingPersistence: Promise<void> = Promise.resolve();
let pendingPersistenceErrors: unknown[] = [];
let tokenRevision = 0;

function readLegacyToken(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function removeLegacyToken(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // A disabled localStorage implementation needs no cleanup.
  }
}

function queuePersistence(
  operation: () => Promise<boolean>,
  label: string,
  onSuccess?: () => void,
): void {
  pendingPersistence = pendingPersistence
    .catch(() => undefined)
    .then(async () => {
      const ok = await operation();
      if (!ok) throw new Error(`${label} returned false`);
      onSuccess?.();
    })
    .catch((error) => {
      pendingPersistenceErrors.push(error);
      log.error(`[SessionToken] Secure ${label} failed:`, error);
    });
}

/** Hydrate the in-memory token before React or any API client starts. */
export async function hydrateSessionToken(): Promise<void> {
  if (hydrated) return;
  hydrated = true;

  try {
    tokenInMemory = await platform.keychain.get(KEY);
  } catch (error) {
    log.warn('[SessionToken] Secure token hydration failed:', error);
  }

  if (tokenInMemory) {
    removeLegacyToken();
    return;
  }

  const legacyToken = readLegacyToken();
  if (!legacyToken) return;

  tokenInMemory = legacyToken;
  try {
    const persisted = await platform.keychain.set(KEY, legacyToken);
    if (persisted) removeLegacyToken();
    else log.error('[SessionToken] Secure migration returned false; legacy token retained.');
  } catch (error) {
    log.error('[SessionToken] Secure migration failed; legacy token retained:', error);
  }
}

export function getSessionToken(): string | null {
  return tokenInMemory;
}

export function setSessionToken(token: string): void {
  tokenRevision += 1;
  tokenInMemory = token;
  queuePersistence(() => platform.keychain.set(KEY, token), 'write');
}

export function clearSessionToken(): void {
  const clearRevision = ++tokenRevision;
  removeLegacyToken();
  // Keep the in-memory token until the secure delete is confirmed. Logout
  // remains on the authenticated DB/UI when deletion fails, so retaining this
  // value makes the failure retryable instead of creating a half-logged-out
  // state. A later set must not be cleared by this older queued deletion.
  queuePersistence(
    () => platform.keychain.delete(KEY),
    'delete',
    () => {
      if (tokenRevision === clearRevision) tokenInMemory = null;
    },
  );
}

/**
 * Revoke a token that the server has already rejected.
 *
 * Unlike an explicit user logout, a 401 must stop every subsequent request
 * from reusing the bearer immediately. Secure deletion remains queued and
 * observable through flushSessionTokenStorage, but a keychain failure cannot
 * make an already-invalid credential live again in memory.
 */
export function invalidateSessionToken(): void {
  tokenRevision += 1;
  tokenInMemory = null;
  removeLegacyToken();
  queuePersistence(() => platform.keychain.delete(KEY), 'delete');
}

/** Included in the native close-flush handshake. */
export async function flushSessionTokenStorage(): Promise<void> {
  await pendingPersistence;
  if (pendingPersistenceErrors.length === 0) return;
  const failures = pendingPersistenceErrors;
  pendingPersistenceErrors = [];
  throw new AggregateError(failures, `${failures.length} session-token persistence step(s) failed`);
}
