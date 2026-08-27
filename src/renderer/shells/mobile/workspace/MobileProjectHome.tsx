import { ArrowLeft, Layers3, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { MobileProjectFlow } from './MobileProjectFlow';
import { MobileTabBar, type MobileTabBarTab } from './MobileTabBar';

interface MobileProjectHomeProps {
  paperCount: number;
  onBackToShelf(): void;
  onOpenOverview(): void;
  onOpenSettings(): void;
  onOpenStructure(tab: MobileTabBarTab): void;
}

/** Project home. A single fixed header row carries all the chrome — paper
 * overview and 设定 in the right corner — and the persistent bottom tab bar
 * opens the structure overlays; the content flow between them is nothing but
 * the author's material. The 设定 entry leaves the project surface for the
 * standalone mobile Settings route. */
export function MobileProjectHome({
  paperCount,
  onBackToShelf,
  onOpenOverview,
  onOpenSettings,
  onOpenStructure,
}: MobileProjectHomeProps) {
  const { t } = useTranslation();
  return (
    <main className="m-project-home" data-debug-id="mobile-project-home">
      <header className="m-project-home__header">
        <div className="m-project-home__header-side">
          <button
            type="button"
            onClick={onBackToShelf}
            aria-label={t('projectPicker.backToShelf')}
          >
            <ArrowLeft size={20} aria-hidden="true" />
          </button>
        </div>
        <span aria-hidden="true" />
        <div className="m-project-home__header-side m-project-home__header-side--end">
          <button
            type="button"
            className="m-project-home__papers"
            onClick={onOpenOverview}
            aria-label={t('mobileWorkspace.openPapers')}
          >
            <Layers3 size={19} aria-hidden="true" />
            {paperCount > 0 && <span>{paperCount}</span>}
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label={t('mobileWorkspace.flow.manage', { defaultValue: '设定' })}
          >
            <Settings size={18} strokeWidth={1.7} aria-hidden="true" />
          </button>
        </div>
      </header>
      <MobileProjectFlow onOpenChapters={() => onOpenStructure('chapters')} />
      <MobileTabBar onOpen={onOpenStructure} />
    </main>
  );
}
