import { useTranslation } from 'react-i18next';
import { TrashPanel } from '../../../components/TrashPanel';
import { SettingsPanelHeader, type SettingsRegisterRef } from '../SettingsPrimitives';

export function TrashRailPanel({ registerRef }: { registerRef: SettingsRegisterRef }) {
  const { t } = useTranslation();
  return (
    <section className="set-panel" ref={registerRef} id="trash">
      <SettingsPanelHeader
        kicker={t('settings.trash.kicker')}
        title={t('settings.trash.title')}
        sub={t('settings.trash.sub')}
      />
      <TrashPanel />
    </section>
  );
}
