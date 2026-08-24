import { ArrowLeft, Layers3 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ProjectDashboard } from '../../../views/ProjectDashboard';
import type { MobilePaper } from './mobile-workspace-session';
import type { MobileSuperViewId } from './mobile-workspace-controller';

interface MobileProjectHomeProps {
  activePaper: MobilePaper | null;
  paperCount: number;
  onBackToShelf(): void;
  onContinuePaper(): void;
  onOpenOverview(): void;
  onOpenProjectView(view: MobileSuperViewId): void;
}

export function MobileProjectHome({
  activePaper,
  paperCount,
  onBackToShelf,
  onContinuePaper,
  onOpenOverview,
  onOpenProjectView,
}: MobileProjectHomeProps) {
  const { t } = useTranslation();
  return (
    <main className="m-project-home" data-debug-id="mobile-project-home">
      <header className="m-project-home__header">
        <button type="button" onClick={onBackToShelf} aria-label={t('projectPicker.backToShelf')}>
          <ArrowLeft size={20} aria-hidden="true" />
        </button>
        <strong>{t('bottomStatusBar.projectHome')}</strong>
        <button type="button" onClick={onOpenOverview} aria-label={t('mobileWorkspace.openPapers')}>
          <Layers3 size={19} aria-hidden="true" />
          {paperCount > 0 && <span>{paperCount}</span>}
        </button>
      </header>
      {activePaper && (
        <button type="button" className="m-project-home__continue" onClick={onContinuePaper}>
          {t('dashboard.continue.resume')}
        </button>
      )}
      <div className="m-project-home__dashboard">
        <ProjectDashboard onOpenProjectView={onOpenProjectView} />
      </div>
    </main>
  );
}
