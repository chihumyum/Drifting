import { useTranslation } from 'react-i18next';
import { LoadingStatus } from '../../components/ui/LoadingStatus';
import { SettingsButton, SettingsNote } from './SettingsPrimitives';

/** Local to settings content: the shell's navigation and close remain mounted. */
export function SettingsLoadStatus({ failed, retry }: { failed: boolean; retry: () => void }) {
  const { t } = useTranslation();
  return (
    <section className="set-panel set-panel--status">
      {failed ? (
        <>
          <SettingsNote icon="status-stopped" tone="error" role="alert">{t('settings.loadFailed')}</SettingsNote>
          <SettingsButton onClick={retry}>{t('appShell.retry')}</SettingsButton>
        </>
      ) : (
        <LoadingStatus label={t('settings.loading')} />
      )}
    </section>
  );
}
