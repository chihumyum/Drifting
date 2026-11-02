import { useTranslation } from 'react-i18next';
import { FullScreenStatus } from './FullScreenStatus';

export function RenderErrorFallback({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <FullScreenStatus
      title={t('appShell.unexpectedTitle')}
      detail={`${t('appShell.unexpectedDetail')} ${error.message}`}
      action={{ label: t('appShell.retry'), onClick: onRetry }}
    />
  );
}
