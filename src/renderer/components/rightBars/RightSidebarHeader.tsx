import { useTranslation } from 'react-i18next';
import { useUiStore } from '../../store/ui-store';
import type { RightSidebarTab, SidebarPaneId } from '../../lib/sidebar-tabs';
import { SidebarSplitButton } from '../SidebarSplitButton';
import { RIGHT_SIDEBAR_TABS } from '../../lib/sidebar-tabs';
import { PanelTab, PanelTabTray } from '../ui/PanelTabs';
import { LabelMono } from '../ui/LabelMono';
import { useSidebarTabMinimumWidth } from '../../hooks/useSidebarTabMinimumWidth';
import { SidebarHeaderChrome, SidebarToggleSlot } from '../workspaceChrome/WindowControlButtons';
import { getPlatformRuntime } from '../../platform/runtime';

export function RightSidebarHeader({ paneId, activeTab, windowChrome = false }: {
  paneId: SidebarPaneId;
  activeTab: RightSidebarTab;
  /** The last pane also carries the sidebar toggle in the top-right corner. */
  windowChrome?: boolean;
}) {
  const { t } = useTranslation();
  const runtime = getPlatformRuntime();
  const toggleTab = useUiStore((s) => s.toggleRightSidebarTab);
  const tabTrayRef = useSidebarTabMinimumWidth('right');

  return (
    <div
      className="workspace-local-divider workspace-panel-tab-row workspace-panel-tab-row--window"
      data-tauri-drag-region={runtime.desktopWindowControls ? 'deep' : undefined}
      style={{
        display: 'flex', alignItems: 'center',
        background: 'var(--workspace-ui-bg)', flexShrink: 0,
        position: 'relative',
      }}
    >
      <SidebarSplitButton side="right" edge="start" />
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
      <SidebarSplitButton side="right" edge="end" />
      {windowChrome && <SidebarHeaderChrome side="right"><SidebarToggleSlot /></SidebarHeaderChrome>}
      <span className="flow-line flow-line--h workspace-panel-tab-row__flow" aria-hidden="true" />
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
