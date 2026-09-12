import { useTranslation } from 'react-i18next';

/** Local to settings content: the shell's navigation and close remain mounted. */
export function SettingsLoadStatus({ failed, retry }: { failed: boolean; retry: () => void }) {
  const { t } = useTranslation();
  return (
    <section className="set-panel" role={failed ? 'alert' : 'status'} aria-live="polite">
      <p className="set-panel__sub">{t(failed ? 'settings.loadFailed' : 'settings.loading')}</p>
      {failed && <button type="button" className="set-btn" onClick={retry}>{t('appShell.retry')}</button>}
    </section>
  );
}
