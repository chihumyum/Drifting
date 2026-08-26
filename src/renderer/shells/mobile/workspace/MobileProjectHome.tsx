import { useState } from 'react';
import { ArrowLeft, Layers3, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ProjectDashboard } from '../../../views/ProjectDashboard';
import { MobileProjectFlow } from './MobileProjectFlow';
import { MobileTabBar, type MobileTabBarTab } from './MobileTabBar';
import type { MobileSuperViewId } from './mobile-workspace-controller';

interface MobileProjectHomeProps {
  paperCount: number;
  onBackToShelf(): void;
  onOpenOverview(): void;
  onOpenProjectView(view: MobileSuperViewId): void;
  onOpenStructure(tab: MobileTabBarTab): void;
}

/** Project home. A single fixed header row carries all the chrome — paper
 * overview and 设定 in the right corner — and the persistent bottom tab bar
 * opens the structure overlays; the content flow between them is nothing but
 * the author's material. The 设定 entry swaps in the full dashboard for
 * structure editing and project settings without losing any capabilities. */
export function MobileProjectHome({
  paperCount,
  onBackToShelf,
  onOpenOverview,
  onOpenProjectView,
  onOpenStructure,
}: MobileProjectHomeProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<'flow' | 'manage'>('flow');
  return (
    <main className="m-project-home" data-debug-id="mobile-project-home" data-view={view}>
      <header className="m-project-home__header">
        <div className="m-project-home__header-side">
          <button
            type="button"
            onClick={view === 'manage' ? () => setView('flow') : onBackToShelf}
            aria-label={
              view === 'manage'
                ? t('navigation.back')
                : t('projectPicker.backToShelf')
            }
          >
            <ArrowLeft size={20} aria-hidden="true" />
          </button>
        </div>
        {view === 'manage' ? (
          <strong>{t('mobileWorkspace.flow.manage', { defaultValue: '设定' })}</strong>
        ) : (
          <span aria-hidden="true" />
        )}
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
          {view === 'flow' && (
            <button
              type="button"
              onClick={() => setView('manage')}
              aria-label={t('mobileWorkspace.flow.manage', { defaultValue: '设定' })}
            >
              <Settings size={18} strokeWidth={1.7} aria-hidden="true" />
            </button>
          )}
        </div>
      </header>
      {view === 'flow' ? (
        <>
          <MobileProjectFlow onOpenManage={() => setView('manage')} />
          <MobileTabBar onOpen={onOpenStructure} />
        </>
      ) : (
        <div className="m-project-home__dashboard">
          <ProjectDashboard onOpenProjectView={onOpenProjectView} />
        </div>
      )}
    </main>
  );
}
