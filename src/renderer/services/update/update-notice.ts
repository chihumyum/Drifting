import type { AppNotification } from '../../store/notification-store';

/** Id prefix of the "a new version is available" notice; installed notices use `app-updated:`. */
export const UPDATE_AVAILABLE_PREFIX = 'app-update:';

export function updateAvailableNotificationId(version: string): string {
  return `${UPDATE_AVAILABLE_PREFIX}${version}`;
}

/** The version an "available" notice is about, or null for any other notice. */
export function updateAvailableVersion(notification: AppNotification): string | null {
  return notification.source === 'app-update' && notification.id.startsWith(UPDATE_AVAILABLE_PREFIX)
    ? notification.id.slice(UPDATE_AVAILABLE_PREFIX.length)
    : null;
}

/** A found update the author has not opened yet: the bell keeps its mark. */
export function isUnreadUpdateAvailable(notification: AppNotification): boolean {
  return !notification.read && updateAvailableVersion(notification) !== null;
}
