import { useEffect, useState } from 'react';
import { useUiStore } from '../../store/ui-store';
import { useSlidingIndicator } from '../../hooks/useSlidingIndicator';

type RightPanelId = 'todo' | 'library' | 'stats' | 'companion' | 'shadow';

interface RightSidebarHeaderProps {
  kicker: string;
  title: string;
  /** Pulsates the library/TODO tab labels after a shadow → fragment conversion. */
  fragmentCountFlash?: boolean;
  /** Pulsates the Shadow tab when shadow mode first activates. */
  shadowJustAppeared?: boolean;
  /** Skip the kicker + title block under the tab strip — used by the
   *  TODO + Library tabs where the tab label itself already describes the
   *  surface and the project-wide list doesn't need a per-entity title. */
  hideTitleBlock?: boolean;
  /** Force a single group's tabs — used by the wide-screen split where each
   *  column owns one group. Omit for the normal single-column mode, which lays
   *  all five tabs flat (pass `flat`). */
  group?: 'content' | 'agent';
  /** Lay ALL five tabs flat in one row — the default single-column layout.
   *  Labels compact down as the tray narrows. */
  flat?: boolean;
}

export function RightSidebarHeader({
  kicker,
  title,
  fragmentCountFlash,
  shadowJustAppeared,
  hideTitleBlock,
  group,
  flat,
}: RightSidebarHeaderProps) {
  const storeGroup = useUiStore((state) => state.rightPanelGroup);
  const activeRightPanel = useUiStore((state) => state.activeRightPanel);
  const setActiveRightPanel = useUiStore((state) => state.setActiveRightPanel);
  const activeAgentPanel = useUiStore((state) => state.activeAgentPanel);
  const setActiveAgentPanel = useUiStore((state) => state.setActiveAgentPanel);
  // Render modes:
  //  - flat: show ALL five tabs in one row (the default single-column panel).
  //  - column: `group` pins one group's tabs (the wide-screen split layout).
  const renderGroup = group ?? storeGroup;
  const activeOf = (g: 'content' | 'agent') =>
    g === 'content' ? activeRightPanel : activeAgentPanel;
  // In flat mode the one active tab is (storeGroup, that group's active);
  // otherwise it's the rendered group's active tab.
  const isActive = (g: 'content' | 'agent', id: string) =>
    flat ? storeGroup === g && activeOf(g) === id : activeOf(renderGroup) === id;
  const onSelect = (g: 'content' | 'agent', id: string) => {
    if (g === 'content') setActiveRightPanel(id as 'todo' | 'library' | 'stats');
    else setActiveAgentPanel(id as 'companion' | 'shadow');
  };
  const indicatorKey = flat ? `${storeGroup}:${activeOf(storeGroup)}` : activeOf(renderGroup);
  const [trayRef, indicatorStyle] = useSlidingIndicator<HTMLDivElement>(
    indicatorKey,
    '.app-panel-tab.is-active',
    [flat, storeGroup, renderGroup],
  );
  // 两级折叠阈值（基于 tray 实际宽度，不是 sidebar 宽度）：
  // - shadowGlyphOnly：shadow 模式下，三等分让 "◐ SHADOW 0" 放不下时只剩 ◐
  // - compactLabels：宽度真的很挤时，备忘与材料→MM、Stats→SS
  // 默认 sidebar 280 → tray ≈ 266，此时 shadow 折叠 glyph，其他 tab 文本仍完整。
  const [trayWidth, setTrayWidth] = useState(Number.POSITIVE_INFINITY);
  useEffect(() => {
    const node = trayRef.current;
    if (!node) return;
    const update = () => setTrayWidth(node.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(node);
    return () => ro.disconnect();
  }, [trayRef]);
  // With 4 tabs (TODO + Library + Stats + Shadow) the tray gets squeezed
  // earlier than the old 3-tab layout, so compactLabels triggers at a
  // wider threshold than before.
  const compactLabels = trayWidth < 200;

  return (
    <>
      <style>{`
        @keyframes insp-tab-count-pulse {
          0%   { color: hsl(var(--ink-4)); transform: scale(1); }
          30%  { color: hsl(var(--accent)); transform: scale(1.4); }
          100% { color: hsl(var(--ink-4)); transform: scale(1); }
        }
        @keyframes insp-shadow-tab-pulse {
          0%, 100% { background: transparent; box-shadow: 0 0 0 0 hsl(var(--accent) / 0.18); }
          50%      { background: hsl(var(--accent) / 0.10); box-shadow: 0 0 0 4px hsl(var(--accent) / 0.10); }
        }
      `}</style>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 35,
          padding: '0 8px',
          gap: 4,
          borderBottom: '1px solid hsl(var(--rule))',
          flexShrink: 0,
        }}
      >
        <div
          ref={trayRef}
          className="rightbar-tab-tray"
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
          {(flat || renderGroup === 'content') && (
            <>
              <RightPanelTab
                id="todo"
                active={isActive('content', 'todo')}
                onClick={() => onSelect('content', 'todo')}
              >
                <span
                  style={
                    {
                      whiteSpace: 'nowrap',
                      animation: fragmentCountFlash ? 'insp-tab-count-pulse 700ms ease' : undefined,
                      display: 'inline-block',
                    } as React.CSSProperties
                  }
                >
                  {compactLabels ? 'TD' : 'TODO'}
                </span>
              </RightPanelTab>
              <RightPanelTab
                id="library"
                active={isActive('content', 'library')}
                onClick={() => onSelect('content', 'library')}
              >
                <span>{compactLabels ? 'LIB' : '素材库'}</span>
              </RightPanelTab>
              <RightPanelTab
                id="stats"
                active={isActive('content', 'stats')}
                onClick={() => onSelect('content', 'stats')}
              >
                <span>{compactLabels ? 'SS' : 'Stats'}</span>
              </RightPanelTab>
            </>
          )}
          {(flat || renderGroup === 'agent') && (
            <>
              <RightPanelTab
                id="companion"
                active={isActive('agent', 'companion')}
                onClick={() => onSelect('agent', 'companion')}
              >
                <span>{compactLabels ? 'AI' : 'Agent'}</span>
              </RightPanelTab>
              {/* Shadow tab always shown — shadow mode is a stub for now. */ (
                <RightPanelTab
                  id="shadow"
                  accent
                  active={isActive('agent', 'shadow')}
                  onClick={() => onSelect('agent', 'shadow')}
                  extraStyle={
                    shadowJustAppeared
                      ? { animation: 'insp-shadow-tab-pulse 1.4s ease-in-out 3' }
                      : undefined
                  }
                >
                  <span>{compactLabels ? 'SH' : 'Shadow'}</span>
                </RightPanelTab>
              )}
            </>
          )}
        </div>
      </div>

      {!hideTitleBlock && (
        <div
          style={{
            padding: '10px 14px 8px',
            borderBottom: '1px solid hsl(var(--rule))',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9.5,
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
              color: 'hsl(var(--ink-4))',
              marginBottom: 3,
            }}
          >
            {kicker}
          </div>
          <div
            style={{
              fontFamily: 'var(--font-serif)',
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
      )}
    </>
  );
}

function RightPanelTab({
  id: _id,
  active,
  accent,
  onClick,
  extraStyle,
  children,
}: {
  id: RightPanelId;
  active: boolean;
  accent?: boolean;
  onClick: () => void;
  extraStyle?: React.CSSProperties;
  children: React.ReactNode;
}) {
  const baseColor = accent ? 'hsl(var(--accent))' : 'hsl(var(--ink-4))';
  const activeColor = accent ? 'hsl(var(--accent))' : 'hsl(var(--ink-1))';
  // Always pill (both skins). Classic paints its own surface bg on active;
  // modern's CSS overrides that to transparent so the sliding indicator
  // shows through (see index.css `html[data-skin='modern'] .app-panel-tab
  // .is-active`).
  return (
    <div
      onClick={onClick}
      className={`app-panel-tab${active ? ' is-active' : ''}`}
      style={{
        position: 'relative',
        zIndex: 1,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        flex: 1,
        minWidth: 0,
        padding: '4px 8px',
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        textTransform: 'uppercase',
        letterSpacing: '0.12em',
        color: active ? activeColor : baseColor,
        background: active ? 'hsl(var(--surface))' : 'transparent',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        borderRadius: 3,
        boxShadow: active ? '0 1px 2px hsl(var(--ink-1) / 0.06)' : 'none',
        transition: 'background 0.15s, color 0.15s',
        ...extraStyle,
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.color = 'hsl(var(--ink-2))';
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.color = baseColor;
      }}
    >
      {children}
    </div>
  );
}
