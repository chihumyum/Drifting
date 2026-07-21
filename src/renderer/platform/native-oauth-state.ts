const STORAGE_KEY = 'drifting.native_oauth_state';
const STATE_BYTES = 32;
const STATE_HEX_LENGTH = STATE_BYTES * 2;
export const NATIVE_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

interface PendingNativeOAuthState {
  value: string;
  expiresAt: number;
}

function stateStorage(): Storage {
  try {
    return localStorage;
  } catch {
    throw new Error('Native OAuth requires local state storage');
  }
}

function isStateValue(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function readPendingState(storage: Storage): PendingNativeOAuthState | null {
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<PendingNativeOAuthState>;
    if (!isStateValue(parsed.value) || typeof parsed.expiresAt !== 'number') {
      storage.removeItem(STORAGE_KEY);
      return null;
    }
    return { value: parsed.value, expiresAt: parsed.expiresAt };
  } catch {
    try {
      storage.removeItem(STORAGE_KEY);
    } catch {
      // A corrupt, non-removable entry will continue to fail closed.
    }
    return null;
  }
}

function constantTimeStateEqual(expected: string, candidate: string): boolean {
  let mismatch = expected.length ^ candidate.length;
  for (let index = 0; index < STATE_HEX_LENGTH; index += 1) {
    const expectedCode = index < expected.length ? expected.charCodeAt(index) : 0;
    const candidateCode = index < candidate.length ? candidate.charCodeAt(index) : 0;
    mismatch |= expectedCode ^ candidateCode;
  }
  return mismatch === 0;
}

/** Create and persist one 256-bit native OAuth correlation state for ten minutes. */
export function createPendingNativeOAuthState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(STATE_BYTES));
  const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const storage = stateStorage();
  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({ value, expiresAt: Date.now() + NATIVE_OAUTH_STATE_TTL_MS }),
  );
  return value;
}

/**
 * Constant-time match against the pending value. A successful state is removed
 * synchronously before the callback is exposed, making it single-use.
 */
export function consumePendingNativeOAuthState(candidate: string | null): boolean {
  const storage = (() => {
    try {
      return stateStorage();
    } catch {
      return null;
    }
  })();
  if (!storage) return false;

  const pending = readPendingState(storage);
  if (!pending) return false;
  if (pending.expiresAt <= Date.now()) {
    try {
      storage.removeItem(STORAGE_KEY);
    } catch {
      // Expired state remains unusable even if cleanup is unavailable.
    }
    return false;
  }

  const supplied = candidate ?? '';
  const matches = constantTimeStateEqual(pending.value, supplied) && isStateValue(supplied);
  if (!matches) return false;

  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // If single-use cleanup cannot be guaranteed, do not release credentials.
    return false;
  }
  return true;
}
