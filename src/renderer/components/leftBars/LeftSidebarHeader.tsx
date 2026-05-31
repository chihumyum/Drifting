import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useUiStore } from '../../store/ui-store';
import { useDataStore } from '../../store/data-store';
import { useAgentActivityStore } from '../../store/agent-activity-store';
import type { ActivityMark } from '../../store/agent-activity-store';
import { useAuthStore } from '../../store/auth';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { useSlidingIndicator } from '../../hooks/useSlidingIndicator';
import { useStoryline } from '../../usecase/useStoryline';

// 三个带标签的 tab 平分整条 header 宽度所需的最小值。低于此值切到 glyph-only。
// 实测：每个 tab 需要 glyph(13) + gap(6) + label(~28) + padding(20) ≈ 67px，
// 三个就是 ~200。加点余量到 220，避免在边界宽度上 CJK 字符按字断行（哪怕加了
// white-space:nowrap 也只是阻止换行，宽度不够时字会被裁），统一走 glyph-only。
const FULL_TABS_MIN_WIDTH = 220;

type TabBadge = 'active' | 'touched' | null;

/** Which left panel an agent-touched entity surfaces in. */
function panelForMark(m: ActivityMark, nodeKind: Map<string, string>): 'nodes' | 'elements' | 'drift' | null {
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

// Hover-out grace period for the chapter tab dropdown — gives the user a
// moment to slide from the tab onto the menu without it vanishing.
const DROPDOWN_HOVER_LEAVE_DELAY_MS = 120;

export function LeftSidebarHeader() {
  const activeLeftPanel = useUiStore((s) => s.activeLeftPanel);
  const setActiveLeftPanel = useUiStore((s) => s.setActiveLeftPanel);

  // Aggregate agent-activity badge per tab, so work in a panel the user isn't
  // looking at still registers. Suppressed on the active panel (its cells show
  // the indicators directly).
  const agentActive = useAgentActivityStore((s) => s.active);
  const agentTouched = useAgentActivityStore((s) => s.touched);
  const bookNodes = useDataStore((s) => s.bookNodes);
  const badges = useMemo(() => {
    const nodeKind = new Map(bookNodes.map((n) => [n.id, n.kind]));
    const res: Record<'nodes' | 'elements' | 'drift', TabBadge> = {
      nodes: null,
      elements: null,
      drift: null,
    };
    for (const m of Object.values(agentActive)) {
      const p = panelForMark(m, nodeKind);
      if (p) res[p] = 'active';
    }
    for (const m of Object.values(agentTouched)) {
      const p = panelForMark(m, nodeKind);
      if (p && res[p] !== 'active') res[p] = res[p] ?? 'touched';
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
        // Allow the chapter-tab hover dropdown to escape this header
        // strip. Combined with the explicit z-index, this keeps the menu
        // visible above the panel content rendered below the header.
        overflow: 'visible',
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
        <ChapterPanelTab
          compact={compact}
          isActive={activeLeftPanel === 'nodes'}
          badge={activeLeftPanel === 'nodes' ? null : badges.nodes}
          onClick={() => setActiveLeftPanel('nodes')}
        />
        <PanelTab
          label="元素"
          glyph="◆"
          compact={compact}
          isActive={activeLeftPanel === 'elements'}
          badge={activeLeftPanel === 'elements' ? null : badges.elements}
          onClick={() => setActiveLeftPanel('elements')}
        />
        <PanelTab
          label="浮缀"
          glyph="✺"
          compact={compact}
          isActive={activeLeftPanel === 'drift'}
          badge={activeLeftPanel === 'drift' ? null : badges.drift}
          onClick={() => setActiveLeftPanel('drift')}
        />
      </div>
    </div>
  );
}

/**
 * Chapter tab — same surface as PanelTab, plus a hover dropdown that exposes
 * view-mode switching:
 *   • 全书总览          → set `chapterPanelViewMode` to 'global'
 *   • 按 storyline 分类 → set `chapterPanelViewMode` to 'storyline'
 *
 * When the project has zero storylines the second option is replaced by
 * "新建 storyline" — clicking creates a fresh storyline (auto-migrating any
 * existing chapters into it via useStoryline.createStoryline's first-storyline
 * hook) and switches the view mode in the same gesture.
 *
 * The dropdown only opens while the tab is the active panel — switching to
 * another panel hides it. View-mode persistence is already handled by the
 * store; this menu is purely a controller.
 */
function ChapterPanelTab({
  compact,
  isActive,
  badge,
  onClick,
}: {
  compact: boolean;
  isActive: boolean;
  badge?: TabBadge;
  onClick: () => void;
}) {
  const viewMode = useUiStore((s) => s.chapterPanelViewMode);
  const setViewMode = useUiStore((s) => s.setChapterPanelViewMode);
  const storylines = useDataStore((s) => s.storylines);
  const userId = useAuthStore((s) => s.user?.id);
  const { projectId, openEntity } = useProjectNavigation();
  const { createStoryline } = useStoryline({
    projectId: projectId ?? '',
    userId: userId ?? '',
  });

  const hasStorylines = storylines.length > 0;
  const [menuOpen, setMenuOpen] = useState(false);
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearLeaveTimer = useCallback(() => {
    if (leaveTimerRef.current) {
      clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
  }, []);

  const handleEnter = useCallback(() => {
    clearLeaveTimer();
    setMenuOpen(true);
  }, [clearLeaveTimer]);

  const handleLeave = useCallback(() => {
    clearLeaveTimer();
    leaveTimerRef.current = setTimeout(() => {
      setMenuOpen(false);
    }, DROPDOWN_HOVER_LEAVE_DELAY_MS);
  }, [clearLeaveTimer]);

  const handlePickGlobal = useCallback(() => {
    setViewMode('global');
    setMenuOpen(false);
  }, [setViewMode]);

  const handlePickStoryline = useCallback(() => {
    setViewMode('storyline');
    setMenuOpen(false);
  }, [setViewMode]);

  const handleCreateFirstStoryline = useCallback(async () => {
    if (!projectId) return;
    setMenuOpen(false);
    try {
      const created = await createStoryline({ projectId, name: 'New Storyline' });
      // Switch to storyline-grouping mode so the user immediately sees the
      // new lane (and the just-migrated existing chapters within it).
      setViewMode('storyline');
      openEntity({ entityType: 'storyline', id: created.id }, { preview: false });
    } catch {
      /* swallow — surfaced via toast/log layer elsewhere when wired up */
    }
  }, [projectId, createStoryline, openEntity, setViewMode]);

  return (
    <div
      style={{ position: 'relative', display: 'flex', flex: 1, minWidth: 0 }}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <PanelTabButton
        label="章节"
        glyph="§"
        compact={compact}
        isActive={isActive}
        badge={badge}
        onClick={onClick}
      />

      {menuOpen && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            minWidth: 168,
            background: 'hsl(var(--surface))',
            border: '1px solid hsl(var(--rule))',
            borderRadius: 4,
            boxShadow: '0 6px 18px hsl(var(--ink-1) / 0.10)',
            padding: 4,
            zIndex: 50,
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: '0.06em',
          }}
        >
          <MenuRow
            label="全书总览"
            checked={viewMode === 'global' || !hasStorylines}
            onClick={handlePickGlobal}
          />
          {hasStorylines ? (
            <MenuRow
              label="按 storyline 分类"
              checked={viewMode === 'storyline'}
              onClick={handlePickStoryline}
            />
          ) : (
            <MenuRow
              label="新建 storyline"
              hint="把现有章节归入一条新建的故事线"
              onClick={() => void handleCreateFirstStoryline()}
            />
          )}
        </div>
      )}
    </div>
  );
}

function MenuRow({
  label,
  hint,
  checked,
  onClick,
}: {
  label: string;
  hint?: string;
  checked?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={{
        all: 'unset',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        width: '100%',
        padding: '6px 8px',
        borderRadius: 3,
        cursor: 'pointer',
        color: 'hsl(var(--ink-1))',
        transition: 'background 0.1s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'hsl(var(--paper-deep))';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          aria-hidden
          style={{
            width: 10,
            color: 'hsl(var(--accent))',
            fontFamily: 'var(--font-serif)',
            fontStyle: 'italic',
            fontSize: 12,
          }}
        >
          {checked ? '✓' : ''}
        </span>
        <span>{label}</span>
      </span>
      {hint && (
        <span
          style={{
            paddingLeft: 16,
            fontFamily: 'var(--font-serif)',
            fontStyle: 'italic',
            fontSize: 10.5,
            letterSpacing: 0,
            color: 'hsl(var(--ink-3))',
          }}
        >
          {hint}
        </span>
      )}
    </button>
  );
}

function PanelTab({
  label,
  glyph,
  compact,
  isActive,
  badge,
  onClick,
}: {
  label: string;
  glyph?: string;
  compact: boolean;
  isActive: boolean;
  badge?: TabBadge;
  onClick: () => void;
}) {
  return (
    <div style={{ display: 'flex', flex: 1, minWidth: 0 }}>
      <PanelTabButton
        label={label}
        glyph={glyph}
        compact={compact}
        isActive={isActive}
        badge={badge}
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
  badge,
  onClick,
}: {
  label: string;
  glyph?: string;
  compact: boolean;
  isActive: boolean;
  badge?: TabBadge;
  onClick: () => void;
}) {
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
        borderRadius: 3,
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
      {glyph && (
        <span
          aria-hidden
          style={{
            fontFamily: 'var(--font-serif)',
            fontStyle: 'italic',
            fontSize: 12.5,
            color: isActive ? 'hsl(var(--accent))' : 'hsl(var(--ink-4))',
            lineHeight: 1,
          }}
        >
          {glyph}
        </span>
      )}
      {!compact && <span>{label}</span>}
      {badge && <span aria-hidden className={`agent-tab-badge agent-tab-badge--${badge}`} />}
    </button>
  );
}
