import { useRef, useState } from 'react';
import { Check, Home } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { focusedLeafOf, tabKey, usePromoteCurrentTab, useUiStore } from '../../store/ui-store';
import { AnchoredPopover } from '../ui/AnchoredPopover';
import { GhostIconButton } from '../ui/GhostIconButton';

type SuperViewId = 'element' | 'graph' | 'memo-material';

const SUPER_VIEWS: Array<{ id: SuperViewId; label: string }> = [
  { id: 'element', label: 'Elements' },
  { id: 'graph', label: 'Storylines' },
  { id: 'memo-material', label: 'Library' },
];

/**
 * Project Home and All Chapters stay first-class header destinations. The
 * three visual overview modes remain consolidated behind one text trigger,
 * without reviving the old custom pictograms that occupied the header.
 */
export function WorkspaceNavigationButtons() {
  const { t } = useTranslation();
  const { projectId, navigateToHome, navigateToAllChapters } = useProjectNavigation();
  const promoteCurrentTab = usePromoteCurrentTab(projectId);
  const superTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [superMenuOpen, setSuperMenuOpen] = useState(false);
  const projectTabs = useUiStore((state) => state.tabsByProject[projectId]);
  const activeSuperView = useUiStore((state) => state.activeSuperView);
  const setActiveSuperView = useUiStore((state) => state.setActiveSuperView);

  const activeTab = projectTabs?.openTabs.find((tab) => tabKey(tab) === projectTabs.activeTabKey);
  const activeLeaf = activeTab ? focusedLeafOf(activeTab) : null;
  const baseViewVisible = activeSuperView === 'none';
  const allChaptersActive = baseViewVisible && activeLeaf?.entityType === 'all-chapters';
  const superDestinationActive = activeSuperView !== 'none';

  const dismissSuperView = () => {
    if (activeSuperView !== 'none') setActiveSuperView('none');
  };
  const openSuperView = (id: SuperViewId) => {
    setActiveSuperView(id);
    setSuperMenuOpen(false);
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
      <button
        type="button"
        className="workspace-all-chapters-trigger"
        data-active={allChaptersActive ? 'true' : undefined}
        aria-pressed={allChaptersActive}
        title={t('bottomStatusBar.allChapters')}
        onClick={() => {
          dismissSuperView();
          navigateToAllChapters();
        }}
      >
        {t('bottomStatusBar.allChapters')}
      </button>
      <button
        ref={superTriggerRef}
        type="button"
        className="workspace-super-trigger"
        data-active={superDestinationActive ? 'true' : undefined}
        aria-label="Super views"
        aria-haspopup="menu"
        aria-expanded={superMenuOpen}
        onClick={() => setSuperMenuOpen((open) => !open)}
      >
        <span>SUPER</span>
      </button>

      <AnchoredPopover
        anchorRef={superTriggerRef}
        open={superMenuOpen}
        onClose={() => setSuperMenuOpen(false)}
        placement="bottom-start"
        role="menu"
        ariaLabel="Super views"
        className="workspace-super-menu"
        maxHeight={220}
      >
        <div className="workspace-super-menu__group">
          {SUPER_VIEWS.map((view) => (
            <SuperMenuItem
              key={view.id}
              label={view.label}
              active={activeSuperView === view.id}
              onSelect={() => openSuperView(view.id)}
            />
          ))}
        </div>
      </AnchoredPopover>
    </div>
  );
}

function SuperMenuItem({
  label,
  active,
  onSelect,
}: {
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      className="workspace-super-menu__item"
      onClick={onSelect}
    >
      <span>{label}</span>
      {active && <Check size={13} strokeWidth={1.7} aria-hidden="true" />}
    </button>
  );
}
