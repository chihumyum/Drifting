import { hostedAccountFetch } from '../../lib/auth-client';
import { APP_CONFIG, canUseHostedService } from '../../lib/config';
import { events } from '../../lib/events';
import { getHostedSessionBinding } from '../../lib/hosted-session-binding';
import { platform } from '../../platform';
import { useAuthStore } from '../../store/auth';
import { productSyncAuthorityStore } from '../../sync/product-authority-store';
import { SyncGenerationProvisionSupervisor } from '../../sync/provision/supervisor';
import {
  applyPreference,
  PREFERENCE_KEYS,
  preferenceSnapshot,
  readPreference,
  subscribePreferenceStores,
} from './preference-fields';
import {
  emptyPreferenceLedger,
  recordPreferenceChanges,
  syncPreferences,
  type PreferenceLedger,
  type PreferenceSurface,
  type PreferenceTransport,
  type RemotePreferences,
} from './preference-sync-core';

/** A change is sent this long after the last edit, so a dragged slider sends once. */
export const PREFERENCE_PUSH_DELAY_MS = 1_000;
/** Changes made on another device arrive at the latest after this long. */
export const PREFERENCE_PULL_INTERVAL_MS = 5 * 60_000;
const LEDGER_KEY = 'preference-sync-v1';

export class PreferenceSyncError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = 'PreferenceSyncError';
  }
}

/** Account preferences v1 over the Hosted account session. */
export const hostedPreferenceTransport: PreferenceTransport = {
  read: (signal) => request('GET', undefined, signal),
  write: (entries, signal) => request('PUT', { entries }, signal),
};

async function request(method: 'GET' | 'PUT', body: unknown, signal: AbortSignal): Promise<RemotePreferences> {
  const binding = getHostedSessionBinding();
  if (!binding) throw new PreferenceSyncError('needs-reauth', 401);
  const response = await hostedAccountFetch(
    `${APP_CONFIG.API_BASE_URL.replace(/\/+$/, '')}/api/account/v1/preferences`,
    {
      method,
      credentials: 'omit',
      signal,
      headers: {
        Authorization: `Bearer ${binding.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  if (!response.ok) {
    const failure = (await response.json().catch(() => null)) as { code?: unknown } | null;
    throw new PreferenceSyncError(typeof failure?.code === 'string' ? failure.code : 'provider-unavailable', response.status);
  }
  const result = (await response.json()) as { preferences?: unknown };
  if (!result.preferences || typeof result.preferences !== 'object') throw new PreferenceSyncError('invalid-response', 0);
  return result.preferences as RemotePreferences;
}

function loadLedger(): PreferenceLedger {
  try {
    const parsed = JSON.parse(localStorage.getItem(LEDGER_KEY) ?? 'null') as PreferenceLedger | null;
    if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object')
      return { accountId: typeof parsed.accountId === 'string' ? parsed.accountId : null, entries: parsed.entries };
  } catch {
    // An unreadable ledger only costs one exchange where the account's values win.
  }
  return emptyPreferenceLedger();
}

function saveLedger(ledger: PreferenceLedger): void {
  try {
    localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger));
  } catch {
    // Storage full or blocked: the values still apply; only the change times are lost.
  }
}

/** A service without preferences v1 is asked again after this long. */
const UNSUPPORTED_RETRY_MS = 60 * 60_000;
/** Focus and resume ask again only after this long. */
const FOCUS_MIN_INTERVAL_MS = 30_000;
let unsupportedUntil = 0;

/** The account's preferences sync while its library is connected and not paused. */
function canSyncPreferences(): boolean {
  if (Date.now() < unsupportedUntil) return false;
  if (!canUseHostedService() || !getHostedSessionBinding()) return false;
  const authority = productSyncAuthorityStore.getSnapshot();
  return authority.mode === 'hosted' && authority.status !== 'cloud-paused' && authority.status !== 'transitioning';
}

/**
 * App-wide, in Hosted-configured builds: records when each synced setting
 * changes on this device (also while signed out, so a sign-in can tell which
 * side changed last) and exchanges them with the account.
 */
export function installPreferenceSyncRuntime(): () => void {
  let snapshot = preferenceSnapshot();
  let applying = false;
  let lastRunAt = 0;
  const surface: PreferenceSurface = {
    keys: PREFERENCE_KEYS,
    read: readPreference,
    apply(key, value) {
      applying = true;
      try {
        return applyPreference(key, value);
      } finally {
        applying = false;
        snapshot = preferenceSnapshot();
      }
    },
  };
  const supervisor = new SyncGenerationProvisionSupervisor({
    canUseProvider: canSyncPreferences,
    async runOnce(signal) {
      lastRunAt = Date.now();
      const binding = getHostedSessionBinding();
      if (!binding) return;
      try {
        const ledger = await syncPreferences({
          accountId: binding.accountSubject,
          surface,
          ledger: loadLedger(),
          transport: hostedPreferenceTransport,
          signal,
        });
        saveLedger(ledger);
      } catch (error) {
        // An older service has no preferences: settings simply stay on this device.
        if (error instanceof PreferenceSyncError && error.status === 404) {
          unsupportedUntil = Date.now() + UNSUPPORTED_RETRY_MS;
          return;
        }
        throw error;
      }
    },
    onError(error) {
      console.warn('[preferences] Sync will retry', error);
    },
  });
  const request = () => supervisor.requestRun();
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  const stopStores = subscribePreferenceStores(() => {
    if (applying) return;
    const current = preferenceSnapshot();
    const ledger = loadLedger();
    if (!recordPreferenceChanges(ledger, snapshot, current, new Date().toISOString()).length) return;
    snapshot = current;
    saveLedger(ledger);
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      pushTimer = null;
      request();
    }, PREFERENCE_PUSH_DELAY_MS);
  });
  const tick = () => {
    if (Date.now() - lastRunAt >= PREFERENCE_PULL_INTERVAL_MS - 1000) request();
  };
  const requestOnFocus = () => {
    if (Date.now() - lastRunAt >= FOCUS_MIN_INTERVAL_MS) request();
  };
  // Signing in (again) binds the session without changing the library's authority.
  const stopAuth = useAuthStore.subscribe((state, previous) => {
    if (state.hostedStatus === 'connected' && previous.hostedStatus !== 'connected') request();
  });
  // 'sync:authority-changed' fires before the snapshot is re-read, so follow the
  // snapshot itself: connecting or resuming lets the first exchange run at once.
  let syncable = canSyncPreferences();
  const stopAuthority = productSyncAuthorityStore.subscribe(() => {
    const next = canSyncPreferences();
    if (next && !syncable) request();
    syncable = next;
  });
  events.on('db:ready', request);
  events.on('sync:authority-changed', request);
  globalThis.addEventListener?.('focus', requestOnFocus);
  globalThis.addEventListener?.('online', request);
  const unsubscribeResume = platform.lifecycle.onReadyOrResume(requestOnFocus);
  const timer = globalThis.setInterval(tick, 60_000);
  request();
  return () => {
    if (pushTimer) clearTimeout(pushTimer);
    globalThis.clearInterval(timer);
    unsubscribeResume();
    globalThis.removeEventListener?.('focus', requestOnFocus);
    globalThis.removeEventListener?.('online', request);
    events.off('db:ready', request);
    events.off('sync:authority-changed', request);
    stopAuth();
    stopAuthority();
    stopStores();
    supervisor.stop();
  };
}
