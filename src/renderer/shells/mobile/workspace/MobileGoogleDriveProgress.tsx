import { Cloud } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useNotificationStore } from '../../../store/notification-store';
import { latestRunningGoogleDriveNotification } from './mobile-google-drive-progress';

/**
 * Mobile owns a compact, non-interactive projection of the shared transfer
 * notification. It floats below the safe-area chrome across every project
 * surface without competing with the keyboard-aware unified bar.
 */
export function MobileGoogleDriveProgress() {
  const { t } = useTranslation();
  const notification = useNotificationStore((state) =>
    latestRunningGoogleDriveNotification(state.items),
  );
  if (!notification?.progress) return null;

  const value = notification.progress.value;
  const percent = value === null ? null : Math.round(value * 100);

  return (
    <aside
      className="m-drive-progress"
      data-determinate={percent === null ? 'false' : 'true'}
      data-debug-id="mobile-google-drive-progress"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="m-drive-progress__summary">
        <Cloud size={16} strokeWidth={1.8} aria-hidden="true" />
        <span className="m-drive-progress__copy">
          <strong>{notification.title}</strong>
          {notification.detail && <small>{notification.detail}</small>}
        </span>
        {percent !== null && <span className="m-drive-progress__percent">{percent}%</span>}
      </div>
      <span
        className="m-drive-progress__track"
        role="progressbar"
        aria-label={t('notifications.googleDrive.progressLabel')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
      >
        <span
          className="m-drive-progress__fill"
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </span>
    </aside>
  );
}
