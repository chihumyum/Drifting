const STORAGE_KEY = 'drifting.native_oauth_state';
const RANDOM_BYTES = 32;
const STATE_HEX_LENGTH = RANDOM_BYTES * 2;
const STATE_PATTERN = /^[0-9a-f]{64}$/;
const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
export const NATIVE_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
export const NATIVE_OAUTH_REDIRECT_URI = 'drifting://auth/callback';

interface PendingNativeOAuth {
  nativeState: string;
  codeVerifier: string;
  redirectUri: string;
  expiresAt: number;
}

export interface NativeOAuthInitiation extends PendingNativeOAuth {
  codeChallenge: string;
}

export interface NativeOAuthExchangeSecret {
  codeVerifier: string;
  redirectUri: string;
}

function stateStorage(): Storage {
  try {
    return localStorage;
  } catch {
    throw new Error('Native OAuth requires local state storage');
  }
}

function isRedirectUri(value: unknown): value is string {
  return value === NATIVE_OAUTH_REDIRECT_URI;
}

function readPendingState(storage: Storage): PendingNativeOAuth | null {
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<PendingNativeOAuth>;
    if (
      typeof parsed.nativeState !== 'string' ||
      !STATE_PATTERN.test(parsed.nativeState) ||
      typeof parsed.codeVerifier !== 'string' ||
      !VERIFIER_PATTERN.test(parsed.codeVerifier) ||
      !isRedirectUri(parsed.redirectUri) ||
      typeof parsed.expiresAt !== 'number'
    ) {
      storage.removeItem(STORAGE_KEY);
      return null;
    }
    return {
      nativeState: parsed.nativeState,
      codeVerifier: parsed.codeVerifier,
      redirectUri: parsed.redirectUri,
      expiresAt: parsed.expiresAt,
    };
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

function randomHex(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_BYTES));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function createPkceCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return bytesToBase64Url(new Uint8Array(digest));
}

/** Create and persist one state/verifier pair before opening the system browser. */
export async function createPendingNativeOAuth(): Promise<NativeOAuthInitiation> {
  const nativeState = randomHex();
  // Hex is part of PKCE's unreserved character set and provides 256 bits of entropy.
  const codeVerifier = randomHex();
  const codeChallenge = await createPkceCodeChallenge(codeVerifier);
  const redirectUri = NATIVE_OAUTH_REDIRECT_URI;
  const expiresAt = Date.now() + NATIVE_OAUTH_STATE_TTL_MS;
  const storage = stateStorage();
  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({ nativeState, codeVerifier, redirectUri, expiresAt }),
  );
  return { nativeState, codeVerifier, codeChallenge, redirectUri, expiresAt };
}

/**
 * Constant-time state match followed by synchronous single-use cleanup. The
 * verifier is released only to the adapter that performs the HTTPS exchange.
 */
export function consumePendingNativeOAuth(
  candidate: string | null,
): NativeOAuthExchangeSecret | null {
  const storage = (() => {
    try {
      return stateStorage();
    } catch {
      return null;
    }
  })();
  if (!storage) return null;

  const pending = readPendingState(storage);
  if (!pending) return null;
  if (pending.expiresAt <= Date.now()) {
    try {
      storage.removeItem(STORAGE_KEY);
    } catch {
      // Expired state remains unusable even if cleanup is unavailable.
    }
    return null;
  }

  const supplied = candidate ?? '';
  const matches =
    constantTimeStateEqual(pending.nativeState, supplied) && STATE_PATTERN.test(supplied);
  if (!matches) return null;

  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // If single-use cleanup cannot be guaranteed, do not release the verifier.
    return null;
  }
  return { codeVerifier: pending.codeVerifier, redirectUri: pending.redirectUri };
}
