import { useState } from 'react';
import { ArrowLeft, Layers3 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ProjectDashboard } from '../../../views/ProjectDashboard';
import { MobileProjectFlow } from './MobileProjectFlow';
import type { MobileSuperViewId } from './mobile-workspace-controller';

interface MobileProjectHomeProps {
  paperCount: number;
  onBackToShelf(): void;
  onOpenOverview(): void;
  onOpenProjectView(view: MobileSuperViewId): void;
}

/** Project home. The default surface is the content flow (the author's
 * chapters, drifts, elements and storylines as one downward stream); the
 * quiet 设定 entry swaps in the full dashboard for structure editing and
 * project settings without losing any of its capabilities. */
export function MobileProjectHome({
  paperCount,
  onBackToShelf,
  onOpenOverview,
  onOpenProjectView,
}: MobileProjectHomeProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<'flow' | 'manage'>('flow');
  return (
    <main className="m-project-home" data-debug-id="mobile-project-home" data-view={view}>
      <header className="m-project-home__header">
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
        {view === 'manage' ? (
          <strong>{t('mobileWorkspace.flow.manage', { defaultValue: '设定' })}</strong>
        ) : (
          <span aria-hidden="true" />
        )}
        <button type="button" onClick={onOpenOverview} aria-label={t('mobileWorkspace.openPapers')}>
          <Layers3 size={19} aria-hidden="true" />
          {paperCount > 0 && <span>{paperCount}</span>}
        </button>
      </header>
      {view === 'flow' ? (
        <MobileProjectFlow
          onOpenProjectView={onOpenProjectView}
          onOpenManage={() => setView('manage')}
        />
      ) : (
        <div className="m-project-home__dashboard">
          <ProjectDashboard onOpenProjectView={onOpenProjectView} />
        </div>
      )}
    </main>
  );
}
