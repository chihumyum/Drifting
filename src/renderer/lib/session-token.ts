import loglevel from 'loglevel';
import { platform } from '../platform';
import { runtimeViteEnv } from './vite-runtime-env';

/**
 * Bearer session token store.
 *
 * The synchronous getter is retained because better-auth and Axios read the
 * token while constructing a request. Packaged and remote-connected builds
 * persist through Tauri secure storage. A loopback-only `tauri dev` session
 * uses an isolated localStorage key so macOS does not repeatedly authorize an
 * ad-hoc-signed debug binary after native rebuilds.
 */
const LEGACY_KEY = 'drifting.session_token';
const LEGACY_DEV_KEY = 'drifting.dev.session_token';
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
let hydration: Promise<void> | null = null;
let pendingPersistence: Promise<void> = Promise.resolve();
let pendingPersistenceErrors: unknown[] = [];
let tokenRevision = 0;

export function getSessionTokenRevision(): number {
  return tokenRevision;
}

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
  get: async () => platform.keychain.get(await hostedSessionStorageKey(apiBaseUrl)),
  set: async (token) => platform.keychain.set(await hostedSessionStorageKey(apiBaseUrl), token),
  delete: async () => platform.keychain.delete(await hostedSessionStorageKey(apiBaseUrl)),
};

const localDevPersistence: TokenPersistence = {
  kind: 'local-dev',
  label: 'local-dev storage',
  get: async () => readLocalStorage(`dev.${await hostedSessionStorageKey(apiBaseUrl)}`),
  set: async (token) => {
    writeLocalStorage(`dev.${await hostedSessionStorageKey(apiBaseUrl)}`, token);
    return true;
  },
  delete: async () => {
    deleteLocalStorage(`dev.${await hostedSessionStorageKey(apiBaseUrl)}`);
    return true;
  },
};

const apiBaseUrl =
  (runtimeViteEnv.VITE_API_BASE_URL as string | undefined) ||
  (runtimeViteEnv.VITE_API_URL as string | undefined) ||
  'http://localhost:3000';
const persistence = shouldUseLocalDevSessionStorage({
  dev: runtimeViteEnv.DEV === true,
  mode: String(runtimeViteEnv.MODE ?? ''),
  apiBaseUrl,
  preference: runtimeViteEnv.VITE_DEV_SESSION_STORAGE as string | undefined,
})
  ? localDevPersistence
  : securePersistence;

/** Sessions belong to a service origin; a local test service never receives another host's token. */
export async function hostedSessionStorageKey(apiBaseUrl: string): Promise<string> {
  const origin = new URL(apiBaseUrl).origin;
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(origin)));
  return `drifting.hosted.v1.${Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

function removeLegacyToken(): void {
  try {
    localStorage.removeItem(LEGACY_KEY);
    localStorage.removeItem(LEGACY_DEV_KEY);
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

/** Hydration is single-flight and cannot overwrite a newer login or invalidation. */
export function hydrateSessionToken(): Promise<void> {
  if (hydration) return hydration;
  const revision = tokenRevision;
  hydration = (async () => {
    try {
      const token = await persistence.get();
      if (revision === tokenRevision) tokenInMemory = token;
    } catch (error) {
      log.warn(`[SessionToken] ${persistence.label} hydration failed:`, error);
    }
    removeLegacyToken();
  })();
  return hydration;
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
  // Keep the in-memory token until the secure delete is confirmed. A failed secure delete
  // remains retryable; cloud authority is separately disabled by the auth store. A later set must not be cleared by this older queued deletion.
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
