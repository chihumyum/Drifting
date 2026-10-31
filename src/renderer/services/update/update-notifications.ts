import { i18next } from '../../lib/i18n';
import { getPlatformRuntime } from '../../platform/runtime';
import { useNotificationStore } from '../../store/notification-store';
import { takeUnannouncedInstalledUpdate, UpdateService } from './update-service';

/**
 * Puts updates in the notification center: once for the version this launch
 * installed, and once per new version a check finds. Both open Settings › Updates.
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
  return UpdateService.subscribe((state) => {
    const version = state.update?.version;
    if (state.phase !== 'available' || !version || version === announced) return;
    announced = version;
    ingest({
      id: `app-update:${version}`,
      source: 'app-update',
      state: 'completed',
      outcome: 'ok',
      title: i18next.t('notifications.appUpdate.available', { version }),
      settingsSection: 'updates',
      at: Date.now(),
    });
  });
}
