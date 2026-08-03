import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUiStore } from '../../store/ui-store';
import { useDataStore } from '../../store/data-store';
import { useAgentActivityStore } from '../../store/agent-activity-store';
import type { ActivityMark } from '../../store/agent-activity-store';
import { AgentCountBadge } from './AgentCountBadge';
import { type GroupActivity } from './agentActivityBubble';
import { PanelTab as SharedPanelTab, PanelTabTray } from '../ui/PanelTabs';

// 三个纯文字 tab 平分整条 header 宽度所需的最小值。宽度足够时只显示
// label；低于此值时只显示 glyph，绝不把两种表示并排。220px 也为较长的
// 英文 label 留出余量，避免 ResizeObserver 在临界宽度附近来回切换。
const FULL_TABS_MIN_WIDTH = 220;

type TabPanel = 'nodes' | 'elements' | 'drift';

/** Which left panel an agent-touched entity surfaces in. Only node/element are
 *  tracked (the entity types with a clickable cell — see agent-activity-store). */
function panelForMark(m: ActivityMark, nodeKind: Map<string, string>): TabPanel | null {
  switch (m.entityType) {
    case 'element':
      return 'elements';
    case 'node':
      return nodeKind.get(m.id) === 'drift' ? 'drift' : 'nodes';
    default:
      return null;
  }
}

export function LeftSidebarHeader() {
  const { t } = useTranslation();
  const activeLeftPanel = useUiStore((s) => s.activeLeftPanel);
  const setActiveLeftPanel = useUiStore((s) => s.setActiveLeftPanel);

  // Aggregate agent activity per tab — the top of the cell → group → tab
  // bubble (#17). A tab blinks its glyph while a panel cell is busy; only once
  // the run finishes and leaves unviewed changes is the glyph replaced by a
  // plain count of those cells, reverting to the glyph once the user has opened
  // them all (count → 0).
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

  const rootRef = useRef<HTMLDivElement | null>(null);
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => setCompact(el.clientWidth < FULL_TABS_MIN_WIDTH);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={rootRef}
      className="workspace-local-divider"
      style={{
        display: 'flex',
        height: 35,
        width: '100%',
        alignItems: 'center',
        padding: '0 8px',
        background: 'var(--workspace-ui-bg)',
        // Keep the header strip above the panel content rendered below it.
        position: 'relative',
        zIndex: 20,
      }}
    >
      <PanelTabTray className="leftbar-tab-tray">
        <PanelTab
          label={t('leftSidebar.tabs.chapters')}
          glyph="§"
          compact={compact}
          isActive={activeLeftPanel === 'nodes'}
          activity={tabActivity.nodes}
          onClick={() => setActiveLeftPanel('nodes')}
        />
        <PanelTab
          label={t('leftSidebar.tabs.elements')}
          glyph="◆"
          compact={compact}
          isActive={activeLeftPanel === 'elements'}
          activity={tabActivity.elements}
          onClick={() => setActiveLeftPanel('elements')}
        />
        <PanelTab
          label={t('leftSidebar.tabs.drifts')}
          glyph="✺"
          compact={compact}
          isActive={activeLeftPanel === 'drift'}
          activity={tabActivity.drift}
          onClick={() => setActiveLeftPanel('drift')}
        />
      </PanelTabTray>
    </div>
  );
}

function PanelTab({
  label,
  glyph,
  compact,
  isActive,
  activity,
  onClick,
}: {
  label: string;
  glyph?: string;
  compact: boolean;
  isActive: boolean;
  activity?: GroupActivity;
  onClick: () => void;
}) {
  return (
    <div style={{ display: 'flex', flex: 1, minWidth: 0 }}>
      <PanelTabButton
        label={label}
        glyph={glyph}
        compact={compact}
        isActive={isActive}
        activity={activity}
        onClick={onClick}
      />
    </div>
  );
}

function PanelTabButton({
  label,
  glyph,
  compact,
  isActive,
  activity,
  onClick,
}: {
  label: string;
  glyph?: string;
  compact: boolean;
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
      title={compact ? label : statusTitle}
      aria-label={statusTitle ? `${label}: ${statusTitle}` : label}
      active={isActive}
      compact={compact}
      typography="label"
      className="left-panel-tab"
    >
      {compact ? (
        !busy && doneCount > 0 ? (
          <AgentCountBadge count={doneCount} title={t('agentActivity.unviewedChanges')} />
        ) : (
          glyph && (
            <span
              aria-hidden
              className={busy ? 'agent-glyph-busy' : undefined}
              title={busy ? t('agentActivity.working') : undefined}
              style={{
                fontFamily: 'var(--font-sans)',
                fontStyle: 'italic',
                fontSize: 12.5,
                color: busy
                  ? 'hsl(var(--accent))'
                  : isActive
                    ? 'hsl(var(--ink-1))'
                    : 'hsl(var(--ink-4))',
                lineHeight: 1,
              }}
            >
              {glyph}
            </span>
          )
        )
      ) : (
        <span
          className={busy ? 'agent-glyph-busy' : undefined}
          style={{ color: busy ? 'hsl(var(--accent))' : undefined }}
        >
          {expandedLabel}
        </span>
      )}
    </SharedPanelTab>
  );
}
