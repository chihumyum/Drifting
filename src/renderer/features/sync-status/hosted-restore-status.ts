import { useTranslation } from 'react-i18next';
import { useHostedConnectProgress } from '../../sync/hosted/connect-progress';
import { formatStorageBytes } from '../../sync/hosted/quota';

export interface HostedRestoreStatus {
  text: string;
  /** Downloaded share of the declared asset bytes; null outside the download. */
  ratio: number | null;
}

/** What a running Hosted connect is doing, for the shelf and Account settings. */
export function useHostedRestoreStatus(): HostedRestoreStatus | null {
  const { t } = useTranslation();
  const progress = useHostedConnectProgress((state) => state.progress);
  if (!progress) return null;
  if (progress.phase === 'downloading') {
    return {
      text: t('settings.hosted.restore.downloading', {
        done: formatStorageBytes(progress.bytesDone),
        total: formatStorageBytes(progress.bytesTotal),
      }),
      ratio: progress.bytesTotal > 0 ? progress.bytesDone / progress.bytesTotal : null,
    };
  }
  return { text: t(`settings.hosted.restore.${progress.phase}`), ratio: null };
}
