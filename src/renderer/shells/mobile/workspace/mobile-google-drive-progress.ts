import type { AppNotification } from '../../../store/notification-store';

export function latestRunningGoogleDriveNotification(
  items: readonly AppNotification[],
): AppNotification | null {
  let latest: AppNotification | null = null;
  for (const item of items) {
    if (item.source !== 'google-drive' || item.state !== 'running' || !item.progress) {
      continue;
    }
    if (!latest || item.updatedAt > latest.updatedAt) latest = item;
  }
  return latest;
}
