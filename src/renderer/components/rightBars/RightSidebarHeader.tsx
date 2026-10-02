import { useTranslation } from 'react-i18next';
import { useUiStore } from '../../store/ui-store';
import type { RightSidebarTab, SidebarPaneId } from '../../lib/sidebar-tabs';
import { SidebarSplitButton } from '../SidebarSplitButton';
import { RIGHT_SIDEBAR_TABS } from '../../lib/sidebar-tabs';
import { PanelTab, PanelTabTray } from '../ui/PanelTabs';
import { LabelMono } from '../ui/LabelMono';
import { useSidebarTabMinimumWidth } from '../../hooks/useSidebarTabMinimumWidth';

export function RightSidebarHeader({ paneId, activeTab }: {
  paneId: SidebarPaneId;
  activeTab: RightSidebarTab;
}) {
  const { t } = useTranslation();
  const toggleTab = useUiStore((s) => s.toggleRightSidebarTab);
  const tabTrayRef = useSidebarTabMinimumWidth('right');

  return (
    <div
      className="workspace-local-divider workspace-panel-tab-row"
      style={{
        display: 'flex', alignItems: 'center',
        background: 'var(--workspace-ui-bg)', flexShrink: 0,
      }}
    >
      <PanelTabTray ref={tabTrayRef} className="rightbar-tab-tray">
        {RIGHT_SIDEBAR_TABS.map((tab) => {
          const label = tab === 'companion' ? 'Agent' : t(`rightSidebar.tabs.${tab}`);
          return (
            <PanelTab key={tab} active={activeTab === tab}
              onClick={() => toggleTab(paneId, tab)} typography="label" aria-label={label} title={label}>
              <span data-panel-tab-label>{label}</span>
            </PanelTab>
          );
        })}
      </PanelTabTray>
      <SidebarSplitButton side="right" />
    </div>
  );
}

export function RightSidebarTitle({ kicker, title }: { kicker: string; title: string }) {
  return (
    <div
      className="workspace-panel-title-block"
      style={{
        background: 'var(--workspace-ui-bg)',
        flexShrink: 0,
      }}
    >
      <LabelMono tone="ink-4" style={{ display: 'block', marginBottom: 3 }}>
        {kicker}
      </LabelMono>
      <div
        style={{
          fontFamily: 'var(--font-sans)',
          fontSize: 16,
          fontWeight: 500,
          color: 'hsl(var(--ink-1))',
          lineHeight: 1.25,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {title || '—'}
      </div>
    </div>
  );
}
