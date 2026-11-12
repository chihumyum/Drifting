import { canUseHostedService } from '../../lib/config';
import { events } from '../../lib/events';
import { getHostedSessionBinding } from '../../lib/hosted-session-binding';
import { i18next } from '../../lib/i18n';
import { platform } from '../../platform';
import { useAuthStore } from '../../store/auth';
import { useNotificationStore } from '../../store/notification-store';
import { SyncGenerationProvisionSupervisor } from '../../sync/provision/supervisor';
import { hostedNoticeTransport, NoticeError, NOTICE_REFRESH_DEFAULT_SECONDS } from './notice-api';
import { NoticeFeed, noticeCenterSurface } from './notice-feed';

/** In the background a notice may take this many times longer to arrive. */
const BACKGROUND_FACTOR = 5;
const BACKGROUND_MAX_MS = 60 * 60_000;
/** How often the runtime looks whether a read is due, and whether the author signed out. */
const TICK_MS = 15_000;
/** Focus and resume ask again only after this long. */
const FOCUS_MIN_INTERVAL_MS = 15_000;
/** A service without notices v1 is asked again after this long. */
const UNSUPPORTED_RETRY_MS = 60 * 60_000;
/** A refused session is tried again after this long, or at the next sign-in. */
const REFUSED_RETRY_MS = 5 * 60_000;
const DISMISSED_KEY = 'account-notices-dismissed-v1';

const foreground = () =>
  typeof document === 'undefined' || (document.visibilityState === 'visible' && document.hasFocus());

function readDismissed(): Record<string, string[]> {
  try {
    const parsed = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? 'null') as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, string[]>;
  } catch {
    // Unreadable: a removed notice comes back once, already read.
  }
  return {};
}

export function loadDismissedNotices(account: string): string[] {
  const ids = readDismissed()[account];
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

export function saveDismissedNotices(account: string, noticeIds: string[]): void {
  try {
    const all = readDismissed();
    if (noticeIds.length) all[account] = noticeIds;
    else delete all[account];
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(all));
  } catch {
    // Storage full or blocked: the notice stays away until the app restarts.
  }
}

/**
 * App-wide, in Hosted-configured builds: while an account is signed in, reads
 * its notices from the service and shows them in the notification center.
 */
export function installNoticeRuntime(): () => void {
  let lastRunAt = 0;
  let refreshMs = NOTICE_REFRESH_DEFAULT_SECONDS * 1000;
  let unsupportedUntil = 0;
  let refusedUntil = 0;
  const feed = new NoticeFeed({
    transport: hostedNoticeTransport,
    surface: noticeCenterSurface,
    language: () => i18next.language,
    now: () => Date.now(),
    loadDismissed: loadDismissedNotices,
    saveDismissed: saveDismissedNotices,
    onError: (error) => console.warn('[notices] Read mark will retry', error),
  });
  const supervisor = new SyncGenerationProvisionSupervisor({
    canUseProvider: () =>
      Date.now() >= Math.max(unsupportedUntil, refusedUntil) && canUseHostedService() && getHostedSessionBinding() !== null,
    async runOnce(signal) {
      lastRunAt = Date.now();
      const binding = getHostedSessionBinding();
      if (!binding) return;
      try {
        refreshMs = (await feed.refresh(binding.accountSubject, signal)) * 1000;
      } catch (error) {
        if (error instanceof NoticeError && error.status === 404) {
          // An older service has no notices: there is nothing to show.
          unsupportedUntil = Date.now() + UNSUPPORTED_RETRY_MS;
          return;
        }
        // An expired session is the sync status' to report; notices wait for the next sign-in.
        if (error instanceof NoticeError && error.status === 401) {
          refusedUntil = Date.now() + REFUSED_RETRY_MS;
          return;
        }
        throw error;
      }
    },
    onError(error) {
      console.warn('[notices] Read will retry', error);
    },
  });
  const request = () => {
    if (!getHostedSessionBinding()) feed.reset();
    supervisor.requestRun();
  };
  const tick = () => {
    if (!getHostedSessionBinding()) {
      feed.reset();
      return;
    }
    const interval = foreground() ? refreshMs : Math.min(refreshMs * BACKGROUND_FACTOR, BACKGROUND_MAX_MS);
    if (Date.now() - lastRunAt >= interval - 1000) supervisor.requestRun();
  };
  const requestOnFocus = () => {
    if (Date.now() - lastRunAt >= FOCUS_MIN_INTERVAL_MS) request();
  };
  // Opening the center reads its rows; removing a row dismisses the notice.
  const stopRows = useNotificationStore.subscribe((state, previous) => {
    if (state.items !== previous.items) feed.rowsChanged();
  });
  // Signing in, out, or as someone else changes whose notices these are.
  const stopAuth = useAuthStore.subscribe((state, previous) => {
    if (state.hostedStatus === previous.hostedStatus && state.hostedUser?.id === previous.hostedUser?.id) return;
    refusedUntil = 0;
    request();
  });
  events.on('sync:authority-changed', request);
  globalThis.addEventListener?.('focus', requestOnFocus);
  globalThis.addEventListener?.('online', request);
  const unsubscribeResume = platform.lifecycle.onReadyOrResume(requestOnFocus);
  const timer = globalThis.setInterval(tick, TICK_MS);
  request();
  return () => {
    globalThis.clearInterval(timer);
    unsubscribeResume();
    globalThis.removeEventListener?.('focus', requestOnFocus);
    globalThis.removeEventListener?.('online', request);
    events.off('sync:authority-changed', request);
    stopAuth();
    stopRows();
    supervisor.stop();
  };
}
