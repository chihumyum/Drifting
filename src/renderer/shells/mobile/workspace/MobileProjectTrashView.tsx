import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { TrashRailPanel } from '../../../features/settings/panels/TrashSettingsPanel';

const REGISTER_NOOP = () => undefined;

/** Project-scoped Trash surface. It stays inside ProjectRuntimeProvider so the
 * shared TrashPanel can resolve the active project's SQLite repositories. */
export function MobileProjectTrashView({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <section
      className="m-project-trash"
      role="dialog"
      aria-modal="true"
      aria-label={t('settings.rail.trash')}
    >
      <header>
        <button type="button" onClick={onClose} aria-label={t('navigation.back')}>
          <ArrowLeft size={20} aria-hidden="true" />
        </button>
        <div>
          <span>LOCAL DATA</span>
          <strong>{t('settings.rail.trash')}</strong>
        </div>
        <span aria-hidden="true" />
      </header>
      <main className="m-project-trash__content set-main">
        <TrashRailPanel registerRef={REGISTER_NOOP} />
      </main>
    </section>
  );
}
