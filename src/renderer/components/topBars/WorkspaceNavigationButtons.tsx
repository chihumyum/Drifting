import { Home } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { focusedLeafOf, tabKey, usePromoteCurrentTab, useUiStore } from '../../store/ui-store';
import {
  AllChaptersIcon,
  AllRefsIcon,
  IcebergIcon,
  StoryGraphViewIcon,
} from '../BottomStatusBarIcons';
import { GhostIconButton } from '../ui/GhostIconButton';

type SuperViewId = 'element' | 'graph' | 'memo-material';

/**
 * The five project-wide destinations that previously lived in the footer.
 * They now sit beside the left-sidebar toggle at the same 26px toolbar scale.
 */
export function WorkspaceNavigationButtons() {
  const { t } = useTranslation();
  const { projectId, navigateToHome, navigateToAllChapters } = useProjectNavigation();
  const promoteCurrentTab = usePromoteCurrentTab(projectId);
  const projectTabs = useUiStore((state) => state.tabsByProject[projectId]);
  const activeSuperView = useUiStore((state) => state.activeSuperView);
  const setActiveSuperView = useUiStore((state) => state.setActiveSuperView);

  const activeTab = projectTabs?.openTabs.find((tab) => tabKey(tab) === projectTabs.activeTabKey);
  const activeLeaf = activeTab ? focusedLeafOf(activeTab) : null;
  const baseViewVisible = activeSuperView === 'none';

  const dismissSuperView = () => {
    if (activeSuperView !== 'none') setActiveSuperView('none');
  };
  const toggleSuperView = (id: SuperViewId) => {
    setActiveSuperView(activeSuperView === id ? 'none' : id);
  };

  return (
    <div className="app-topbar__workspace-nav" aria-label={t('bottomStatusBar.workspaceViews')}>
      <GhostIconButton
        className="workspace-header-action"
        aria-pressed={baseViewVisible && activeLeaf?.entityType === 'dashboard'}
        onClick={() => {
          dismissSuperView();
          navigateToHome();
        }}
        onDoubleClick={() => promoteCurrentTab()}
        title={t('bottomStatusBar.projectHome')}
        aria-label={t('bottomStatusBar.projectHome')}
        icon={<Home size={16} strokeWidth={1.6} />}
      />
      <GhostIconButton
        className="workspace-header-action"
        aria-pressed={baseViewVisible && activeLeaf?.entityType === 'all-chapters'}
        onClick={() => {
          dismissSuperView();
          navigateToAllChapters();
        }}
        onDoubleClick={() => promoteCurrentTab()}
        title={t('bottomStatusBar.allChapters')}
        aria-label={t('bottomStatusBar.allChapters')}
        icon={<AllChaptersIcon size={17} />}
      />
      <GhostIconButton
        className="workspace-header-action"
        aria-pressed={activeSuperView === 'element'}
        onClick={() => toggleSuperView('element')}
        title={t('bottomStatusBar.elements')}
        aria-label={t('bottomStatusBar.elements')}
        icon={<IcebergIcon size={17} />}
      />
      <GhostIconButton
        className="workspace-header-action"
        aria-pressed={activeSuperView === 'graph'}
        onClick={() => toggleSuperView('graph')}
        title={t('bottomStatusBar.storyGraph')}
        aria-label={t('bottomStatusBar.storyGraph')}
        icon={<StoryGraphViewIcon size={17} />}
      />
      <GhostIconButton
        className="workspace-header-action"
        aria-pressed={activeSuperView === 'memo-material'}
        onClick={() => toggleSuperView('memo-material')}
        title={t('bottomStatusBar.todoLibrary')}
        aria-label={t('bottomStatusBar.todoLibrary')}
        icon={<AllRefsIcon size={17} />}
      />
    </div>
  );
}
