import { useSuperViewPreloadIntent } from '../../features/graph/deferred-graph-modules';
import { Home } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { isProjectHomePathname } from '../../features/workspace/navigation/workspace-route';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { focusedLeafOf, tabKey, useUiStore } from '../../store/ui-store';
import { GhostIconButton } from '../ui/GhostIconButton';
import { IconoirPageFlip } from '../ui/icons/IconoirPageFlip';

type SuperViewId = 'element' | 'graph' | 'memo-material';

/**
 * Project Home and All Chapters stay first-class header destinations. The
 * Super trigger enters the last-used overview immediately; switching between
 * the three overview modes happens inside their shared desktop header.
 */
export function WorkspaceNavigationButtons() {
  const { t } = useTranslation();
  const location = useLocation();
  const { projectId, navigateToHome, navigateToAllChapters } = useProjectNavigation();
  const projectTabs = useUiStore((state) => state.tabsByProject[projectId]);
  const activeSuperView = useUiStore((state) => state.activeSuperView);
  const lastActiveSuperView = useUiStore((state) => state.lastActiveSuperView);
  const preloadSuperView = useSuperViewPreloadIntent(lastActiveSuperView ?? 'element');
  const setActiveSuperView = useUiStore((state) => state.setActiveSuperView);

  const activeTab = projectTabs?.openTabs.find((tab) => tabKey(tab) === projectTabs.activeTabKey);
  const activeLeaf = activeTab ? focusedLeafOf(activeTab) : null;
  const baseViewVisible = activeSuperView === 'none';
  const projectHomeActive =
    baseViewVisible && isProjectHomePathname(projectId, location.pathname);
  const allChaptersActive = baseViewVisible && activeLeaf?.entityType === 'all-chapters';
  const superDestinationActive = activeSuperView !== 'none';

  const dismissSuperView = () => {
    if (activeSuperView !== 'none') setActiveSuperView('none');
  };
  const openLastSuperView = () =>
    setActiveSuperView(lastActiveSuperView ?? ('element' satisfies SuperViewId));

  return (
    <div className="app-topbar__workspace-nav" aria-label={t('bottomStatusBar.workspaceViews')}>
      <GhostIconButton
        className="workspace-header-action"
        aria-pressed={projectHomeActive}
        onClick={() => {
          dismissSuperView();
          navigateToHome();
        }}
        title={t('bottomStatusBar.projectHome')}
        aria-label={t('bottomStatusBar.projectHome')}
        icon={<Home size={16} strokeWidth={1.6} />}
      />
      <GhostIconButton
        type="button"
        className="workspace-all-chapters-trigger workspace-header-action"
        data-active={allChaptersActive ? 'true' : undefined}
        aria-pressed={allChaptersActive}
        title={t('bottomStatusBar.allChapters')}
        aria-label={t('bottomStatusBar.allChapters')}
        onClick={() => {
          dismissSuperView();
          navigateToAllChapters();
        }}
        icon={<IconoirPageFlip width={16} height={16} strokeWidth={1.5} aria-hidden="true" />}
      />
      <button
        type="button"
        className="workspace-super-trigger"
        {...preloadSuperView}
        data-active={superDestinationActive ? 'true' : undefined}
        aria-label="Super views"
        onClick={openLastSuperView}
      >
        <span>SUPER</span>
      </button>
    </div>
  );
}
