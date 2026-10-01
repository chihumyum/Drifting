import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useUiStore } from '../../store/ui-store';
import type { LeftSidebarTab, SidebarPaneId } from '../../lib/sidebar-tabs';
import { SidebarSplitButton } from '../SidebarSplitButton';
import { useDataStore } from '../../store/data-store';
import { useAgentActivityStore } from '../../store/agent-activity-store';
import type { ActivityMark } from '../../store/agent-activity-store';
import { type GroupActivity } from './agentActivityBubble';
import { PanelTab as SharedPanelTab, PanelTabTray } from '../ui/PanelTabs';

type TabPanel = 'nodes' | 'elements' | 'drift';

/** Which left panel an agent-touched entity surfaces in. Storyline/category
 * group headers live in the same panel as their chapter/element children. */
function panelForMark(m: ActivityMark, nodeKind: Map<string, string>): TabPanel | null {
  switch (m.entityType) {
    case 'element':
    case 'category':
      return 'elements';
    case 'storyline':
      return 'nodes';
    case 'node':
      return nodeKind.get(m.id) === 'drift' ? 'drift' : 'nodes';
    default:
      return null;
  }
}

export function LeftSidebarHeader({ paneId, activeTab }: {
  paneId: SidebarPaneId;
  activeTab: LeftSidebarTab;
}) {
  const { t } = useTranslation();
  const toggleTab = useUiStore((s) => s.toggleLeftSidebarTab);

  // Aggregate unviewed activity into the persistent text labels. Busy labels
  // pulse; completed changes append their count until reviewed.
  const agentActive = useAgentActivityStore((s) => s.active);
  const agentTouched = useAgentActivityStore((s) => s.touched);
  const bookNodes = useDataStore((s) => s.bookNodes);
  const tabActivity = useMemo(() => {
    const nodeKind = new Map(bookNodes.map((n) => [n.id, n.kind]));
    const res: Record<TabPanel, GroupActivity> = {
      nodes: { busy: false, doneCount: 0 },
      elements: { busy: false, doneCount: 0 },
      drift: { busy: false, doneCount: 0 },
    };
    for (const m of Object.values(agentActive)) {
      const p = panelForMark(m, nodeKind);
      if (p) res[p].busy = true;
    }
    for (const m of Object.values(agentTouched)) {
      const p = panelForMark(m, nodeKind);
      if (p) res[p].doneCount += 1;
    }
    return res;
  }, [agentActive, agentTouched, bookNodes]);

  return (
    <div
      className="workspace-local-divider workspace-panel-tab-row"
      style={{
        display: 'flex',
        width: '100%',
        flexShrink: 0,
        alignItems: 'center',
        background: 'var(--workspace-ui-bg)',
        // Keep the header strip above the panel content rendered below it.
        position: 'relative',
        zIndex: 20,
      }}
    >
      <PanelTabTray className="leftbar-tab-tray">
        <PanelTab
          label={t('leftSidebar.tabs.chapters')}
          isActive={activeTab === 'nodes'}
          activity={tabActivity.nodes}
          onClick={() => toggleTab(paneId, 'nodes')}
        />
        <PanelTab
          label={t('leftSidebar.tabs.elements')}
          isActive={activeTab === 'elements'}
          activity={tabActivity.elements}
          onClick={() => toggleTab(paneId, 'elements')}
        />
        <PanelTab
          label={t('leftSidebar.tabs.drifts')}
          isActive={activeTab === 'drift'}
          activity={tabActivity.drift}
          onClick={() => toggleTab(paneId, 'drift')}
        />
      </PanelTabTray>
      <SidebarSplitButton side="left" />
    </div>
  );
}

function PanelTab({
  label,
  isActive,
  activity,
  onClick,
}: {
  label: string;
  isActive: boolean;
  activity?: GroupActivity;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const busy = activity?.busy ?? false;
  const doneCount = activity?.doneCount ?? 0;
  const statusTitle = busy
    ? t('agentActivity.working')
    : doneCount > 0
      ? t('agentActivity.unviewedChanges')
      : undefined;
  const expandedLabel =
    !busy && doneCount > 0 ? `${label} ${doneCount > 99 ? '99+' : doneCount}` : label;
  return (
    <SharedPanelTab
      onClick={onClick}
      title={statusTitle ?? label}
      aria-label={statusTitle ? `${label}: ${statusTitle}` : label}
      active={isActive}
      typography="label"
    >
      <span
        className={busy ? 'agent-glyph-busy' : undefined}
        style={{ color: busy ? 'hsl(var(--accent))' : undefined }}
      >
        {expandedLabel}
      </span>
    </SharedPanelTab>
  );
}
