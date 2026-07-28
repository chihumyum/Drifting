import loglevel from 'loglevel';
import { platform } from '../platform';

/**
 * Bearer session token store.
 *
 * The synchronous getter is retained because better-auth and Axios read the
 * token while constructing a request. Packaged and remote-connected builds
 * persist through Tauri secure storage. A loopback-only `tauri dev` session
 * uses an isolated localStorage key so macOS does not repeatedly authorize an
 * ad-hoc-signed debug binary after native rebuilds.
 */
const KEY = 'drifting.session_token';
const DEV_KEY = 'drifting.dev.session_token';
const log = loglevel.getLogger('SessionToken');

interface TokenPersistence {
  readonly kind: 'keychain' | 'local-dev';
  readonly label: string;
  get(): Promise<string | null>;
  set(token: string): Promise<boolean>;
  delete(): Promise<boolean>;
}

interface DevSessionStoragePolicy {
  dev: boolean;
  mode: string;
  apiBaseUrl: string;
  preference?: string;
}

let tokenInMemory: string | null = null;
let hydrated = false;
let pendingPersistence: Promise<void> = Promise.resolve();
let pendingPersistenceErrors: unknown[] = [];
let tokenRevision = 0;

function isLoopbackApiBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

    const hostname = url.hostname.toLowerCase();
    return (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname === '::1' ||
      hostname === '[::1]' ||
      hostname === '0.0.0.0' ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname)
    );
  } catch {
    return false;
  }
}

/**
 * Plaintext dev persistence is allowed only for a loopback API. This prevents
 * a production bearer token from being copied out of the OS credential store
 * merely because someone launched the renderer through Vite.
 */
export function shouldUseLocalDevSessionStorage({
  dev,
  mode,
  apiBaseUrl,
  preference,
}: DevSessionStoragePolicy): boolean {
  if (!dev || preference === 'keychain' || !isLoopbackApiBaseUrl(apiBaseUrl)) return false;
  return preference === 'local' || mode !== 'test';
}

function readLocalStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    throw new Error(`localStorage read failed for ${key}`);
  }
}

function writeLocalStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    throw new Error(`localStorage write failed for ${key}`);
  }
}

function deleteLocalStorage(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    throw new Error(`localStorage delete failed for ${key}`);
  }
}

const securePersistence: TokenPersistence = {
  kind: 'keychain',
  label: 'secure-storage',
  get: () => platform.keychain.get(KEY),
  set: (token) => platform.keychain.set(KEY, token),
  delete: () => platform.keychain.delete(KEY),
};

const localDevPersistence: TokenPersistence = {
  kind: 'local-dev',
  label: 'local-dev storage',
  get: async () => readLocalStorage(DEV_KEY),
  set: async (token) => {
    writeLocalStorage(DEV_KEY, token);
    return true;
  },
  delete: async () => {
    deleteLocalStorage(DEV_KEY);
    return true;
  },
};

const apiBaseUrl =
  import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_API_URL || 'http://localhost:3000';
const persistence = shouldUseLocalDevSessionStorage({
  dev: import.meta.env.DEV,
  mode: import.meta.env.MODE,
  apiBaseUrl,
  preference: import.meta.env.VITE_DEV_SESSION_STORAGE,
})
  ? localDevPersistence
  : securePersistence;

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
      log.error(`[SessionToken] ${persistence.label} ${label} failed:`, error);
    });
}

/** Hydrate the in-memory token before React or any API client starts. */
export async function hydrateSessionToken(): Promise<void> {
  if (hydrated) return;
  hydrated = true;

  try {
    tokenInMemory = await persistence.get();
  } catch (error) {
    log.warn(`[SessionToken] ${persistence.label} hydration failed:`, error);
  }

  // Development tokens are deliberately isolated from the production key and
  // never auto-migrated out of Keychain. A developer signs in once against the
  // local server; remote-connected dev sessions continue to use Keychain.
  if (persistence.kind === 'local-dev') return;

  if (tokenInMemory) {
    removeLegacyToken();
    return;
  }

  const legacyToken = readLegacyToken();
  if (!legacyToken) return;

  tokenInMemory = legacyToken;
  try {
    const persisted = await persistence.set(legacyToken);
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
  queuePersistence(() => persistence.set(token), 'write');
}

export function clearSessionToken(): void {
  const clearRevision = ++tokenRevision;
  removeLegacyToken();
  // Keep the in-memory token until the secure delete is confirmed. Logout
  // remains on the authenticated DB/UI when deletion fails, so retaining this
  // value makes the failure retryable instead of creating a half-logged-out
  // state. A later set must not be cleared by this older queued deletion.
  queuePersistence(
    () => persistence.delete(),
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
  queuePersistence(() => persistence.delete(), 'delete');
}

/** Included in the native close-flush handshake. */
export async function flushSessionTokenStorage(): Promise<void> {
  await pendingPersistence;
  if (pendingPersistenceErrors.length === 0) return;
  const failures = pendingPersistenceErrors;
  pendingPersistenceErrors = [];
  throw new AggregateError(failures, `${failures.length} session-token persistence step(s) failed`);
}
