import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

/**
 * Explicit mobile boundary while the product-level workspace design remains
 * intentionally deferred. It prevents a mobile target from falling through
 * to DesktopAppShell when a shelf item is opened.
 */
export function MobileWorkspaceDeferredView() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <main className="m-workspace-deferred">
      <header>
        <button
          type="button"
          onClick={() => navigate('/', { replace: true })}
          aria-label={t('projectPicker.backToShelf')}
        >
          <ArrowLeft size={20} aria-hidden="true" />
        </button>
        <strong>Drifting</strong>
      </header>
      <section>
        <span>{t('mobileWorkspace.deferred.label')}</span>
        <h1>{t('mobileWorkspace.deferred.title')}</h1>
        <p>{t('mobileWorkspace.deferred.body')}</p>
        <button type="button" onClick={() => navigate('/', { replace: true })}>
          {t('projectPicker.backToShelf')}
        </button>
      </section>
    </main>
  );
}
