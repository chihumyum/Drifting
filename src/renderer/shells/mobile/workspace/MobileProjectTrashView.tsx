import { useTranslation } from 'react-i18next';
import { TrashRailPanel } from '../../../features/settings/panels/TrashSettingsPanel';
import { BrushIcon } from '../../../components/ui/BrushIcon';
import { GhostIconButton } from '../../../components/ui/GhostIconButton';

const REGISTER_NOOP = () => undefined;

/**
 * The book's trash, laid over the desk like a settings section (the same head,
 * round glass back). It stays inside ProjectRuntimeProvider so the shared
 * trash panel resolves the open book's repositories.
 */
export function MobileProjectTrashView({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <section
      className="m-project-trash m-settings set-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t('settings.rail.trash')}
      data-debug-id="mobile-project-trash-view"
    >
      <header className="m-settings__head set-head">
        <div className="set-head__left">
          <GhostIconButton
            glass="round"
            className="set-head__back glass--rest"
            onClick={onClose}
            aria-label={t('navigation.back')}
            icon={<BrushIcon name="arrow-back" />}
          />
          <span className="set-head__title">{t('settings.rail.trash')}</span>
        </div>
      </header>
      <div className="m-settings__body set-body">
        <main className="m-settings__content m-project-trash__content set-main">
          <TrashRailPanel registerRef={REGISTER_NOOP} />
        </main>
      </div>
    </section>
  );
}
