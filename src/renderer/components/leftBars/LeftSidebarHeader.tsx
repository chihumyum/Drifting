import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUiStore } from '../../store/ui-store';
import { useDataStore } from '../../store/data-store';
import { useAgentActivityStore } from '../../store/agent-activity-store';
import type { ActivityMark } from '../../store/agent-activity-store';
import { useSlidingIndicator } from '../../hooks/useSlidingIndicator';
import { AgentCountBadge } from './AgentCountBadge';
import { type GroupActivity } from './agentActivityBubble';

// 三个带标签的 tab 平分整条 header 宽度所需的最小值。低于此值切到 glyph-only。
// 实测：每个 tab 需要 glyph(13) + gap(6) + label(~28) + padding(20) ≈ 67px，
// 三个就是 ~200。加点余量到 220，避免在边界宽度上 CJK 字符按字断行（哪怕加了
// white-space:nowrap 也只是阻止换行，宽度不够时字会被裁），统一走 glyph-only。
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
  // Sliding pill that animates between the three panel buttons in modern.
  // Classic keeps the indicator hidden via CSS — each button paints its
  // own static surface bg on active instead.
  const [trayRef, indicatorStyle] = useSlidingIndicator<HTMLDivElement>(
    activeLeftPanel,
    '.app-panel-tab.is-active',
  );

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
      style={{
        display: 'flex',
        height: 35,
        width: '100%',
        borderBottom: '1px solid hsl(var(--rule))',
        alignItems: 'center',
        padding: '0 8px',
        // Keep the header strip above the panel content rendered below it.
        position: 'relative',
        zIndex: 20,
      }}
    >
      <div
        ref={trayRef}
        className="leftbar-tab-tray"
        style={{
          display: 'flex',
          flex: 1,
          minWidth: 0,
          gap: 0,
          background: 'hsl(var(--paper-deep))',
          borderRadius: 4,
          padding: 2,
          position: 'relative',
        }}
      >
        <div className="tab-indicator" style={indicatorStyle} />
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
      </div>
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
  // Always pill (both skins). Classic: button paints its own surface bg on
  // active — static, no animation. Modern: sliding indicator (sibling of
  // these buttons) carries the active visual; modern CSS overrides the
  // active button's bg/shadow to transparent so the indicator shows
  // through. See index.css `.tab-indicator` + `html[data-skin='modern']
  // .app-panel-tab.is-active`.
  return (
    <button
      onClick={onClick}
      title={compact ? label : undefined}
      className={`app-panel-tab${isActive ? ' is-active' : ''}`}
      style={{
        position: 'relative',
        zIndex: 1,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: compact ? 0 : 6,
        flex: 1,
        minWidth: 0,
        // Fix compact-vs-non-compact height drift: the glyph carries
        // lineHeight:1 while the label inherits ~1.4, so a glyph-only button
        // is ~3px shorter than a glyph+label button. Pin a min-height so
        // the pill wrapper doesn't visibly shrink when the sidebar gets
        // narrow enough to trigger compact mode.
        minHeight: 24,
        background: isActive ? 'hsl(var(--surface))' : 'transparent',
        color: isActive ? 'hsl(var(--ink-1))' : 'hsl(var(--ink-3))',
        padding: compact ? '4px 8px' : '4px 10px',
        fontSize: 11.5,
        cursor: 'pointer',
        fontFamily: 'var(--font-mono)',
        letterSpacing: '0.08em',
        fontWeight: 500,
        border: 'none',
        // Concentric with the tray frame: tray radius 4 − 2px padding = 2.
        borderRadius: 2,
        boxShadow: isActive ? '0 1px 2px hsl(var(--ink-1) / 0.06)' : 'none',
        transition: 'background 0.15s, color 0.15s',
        textAlign: 'center',
        whiteSpace: 'nowrap',
      }}
      onMouseEnter={(e) => {
        if (!isActive) e.currentTarget.style.color = 'hsl(var(--ink-1))';
      }}
      onMouseLeave={(e) => {
        if (!isActive) e.currentTarget.style.color = 'hsl(var(--ink-3))';
      }}
    >
      {/* Glyph slot — while a run is working over this panel the glyph blinks in
          accent; only once it finishes and leaves unviewed changes is the glyph
          replaced by their plain count (cell → group → tab bubble, #17). */}
      {!busy && doneCount > 0 ? (
        <AgentCountBadge count={doneCount} title={t('agentActivity.unviewedChanges')} />
      ) : (
        glyph && (
          <span
            aria-hidden
            className={busy ? 'agent-glyph-busy' : undefined}
            title={busy ? t('agentActivity.working') : undefined}
            style={{
              fontFamily: 'var(--font-serif)',
              fontStyle: 'italic',
              fontSize: 12.5,
              color: busy || isActive ? 'hsl(var(--accent))' : 'hsl(var(--ink-4))',
              lineHeight: 1,
            }}
          >
            {glyph}
          </span>
        )
      )}
      {!compact && <span>{label}</span>}
    </button>
  );
}
