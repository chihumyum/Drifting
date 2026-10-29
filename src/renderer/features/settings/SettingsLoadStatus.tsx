import { useTranslation } from 'react-i18next';
import { LoadingStatus } from '../../components/ui/LoadingStatus';
import { SettingsButton, SettingsNote } from './SettingsPrimitives';
import { settingsOnDesktop } from './settings-on-desktop';

/** Local to settings content: the shell's navigation and close remain mounted. */
export function SettingsLoadStatus({ failed, retry }: { failed: boolean; retry: () => void }) {
  const { t } = useTranslation();
  if (settingsOnDesktop()) {
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
  return (
    <section className="set-panel" role={failed ? 'alert' : 'status'} aria-live="polite">
      {!failed && <span className="app-fullscreen-status__spinner" style={{ margin: '0 0 12px' }} aria-hidden="true" />}
      <p className="set-panel__sub">{t(failed ? 'settings.loadFailed' : 'settings.loading')}</p>
      {failed && <button type="button" className="set-btn" onClick={retry}>{t('appShell.retry')}</button>}
    </section>
  );
}
