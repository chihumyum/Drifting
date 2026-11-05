import { i18next } from '../../lib/i18n';
import { getPlatformRuntime } from '../../platform/runtime';
import { useNotificationStore } from '../../store/notification-store';
import { updateAvailableNotificationId, updateAvailableVersion } from './update-notice';
import {
  foundUpdateSeen,
  markFoundUpdateSeen,
  takeUnannouncedInstalledUpdate,
  UpdateService,
} from './update-service';

/**
 * Puts updates in the notification center: once for the version this launch
 * installed, and once per new version a check finds. Both open Settings › Updates.
 * A found version stays unread, and marks the bell, until the author opens the
 * center; a relaunch before that brings it back unread.
 */
export function installUpdateNotifications(): () => void {
  const { ingest } = useNotificationStore.getState();
  const current = getPlatformRuntime().appInfo?.version;
  const installed = current ? takeUnannouncedInstalledUpdate(current) : null;
  if (installed) {
    ingest({
      id: `app-updated:${installed.version}`,
      source: 'app-update',
      state: 'completed',
      outcome: 'ok',
      title: i18next.t('notifications.appUpdate.installed', { version: installed.version }),
      settingsSection: 'updates',
      at: Date.now(),
    });
  }
  let announced: string | null = null;
  const stopAnnouncing = UpdateService.subscribe((state) => {
    const version = state.update?.version;
    if (state.phase !== 'available' || !version || version === announced) return;
    announced = version;
    ingest({
      id: updateAvailableNotificationId(version),
      source: 'app-update',
      state: 'completed',
      outcome: 'ok',
      title: i18next.t('notifications.appUpdate.available', { version }),
      settingsSection: 'updates',
      at: Date.now(),
      read: foundUpdateSeen(version),
    });
  });
  const seen = new Set<string>();
  const stopWatchingSeen = useNotificationStore.subscribe(({ items }) => {
    for (const item of items) {
      const version = item.read ? updateAvailableVersion(item) : null;
      if (!version || seen.has(version)) continue;
      seen.add(version);
      markFoundUpdateSeen(version);
    }
  });
  return () => {
    stopAnnouncing();
    stopWatchingSeen();
  };
}
