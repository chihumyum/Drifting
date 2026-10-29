import { useTranslation } from 'react-i18next';
import { useUiStore } from '../../store/ui-store';
import type { RightSidebarTab, SidebarPaneId } from '../../lib/sidebar-tabs';
import { SidebarSplitButton } from '../SidebarSplitButton';
import { RIGHT_SIDEBAR_TABS } from '../../lib/sidebar-tabs';
import { PanelTab, PanelTabRowEdges, PanelTabTray } from '../ui/PanelTabs';
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
      <PanelTabRowEdges />
    </div>
  );
}

// Stats has no controls, but its header is still the one-row panel header:
// the subject on the left (named like an Agent conversation), what the numbers
// cover on the right in the muted index voice.
export function RightSidebarTitle({ kicker, title }: { kicker: string; title: string }) {
  return (
    <div
      className="workspace-panel-header-row"
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 8,
        background: 'var(--workspace-ui-bg)',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          flex: '1 1 auto',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: 'var(--ui-font-secondary, 10px)',
          fontWeight: 500,
          color: 'hsl(var(--ink-2))',
        }}
      >
        {title || '—'}
      </span>
      <span
        style={{
          flex: '0 1 auto',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: 'var(--ui-font-caption, 9.5px)',
          color: 'var(--ui-text-muted, hsl(var(--ink-3)))',
        }}
      >
        {kicker}
      </span>
    </div>
  );
}
