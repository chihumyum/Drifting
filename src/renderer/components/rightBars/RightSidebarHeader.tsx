import { useEffect, useState } from 'react';
import { useUiStore } from '../../store/ui-store';
import { useSlidingIndicator } from '../../hooks/useSlidingIndicator';

type RightPanelId = 'todo' | 'library' | 'stats' | 'shadow';

interface RightSidebarHeaderProps {
  shadowReviewCount: number;
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
}

export function RightSidebarHeader({
  shadowReviewCount,
  kicker,
  title,
  fragmentCountFlash,
  shadowJustAppeared,
  hideTitleBlock,
}: RightSidebarHeaderProps) {
  const activeRightPanel = useUiStore((state) => state.activeRightPanel);
  const setActiveRightPanel = useUiStore((state) => state.setActiveRightPanel);
  const shadowMode = useUiStore((state) => state.shadowMode);
  // Sliding pill — same pattern as the left sidebar. Classic hides the
  // indicator via CSS and each pill button paints its own static surface
  // bg on active.
  const [trayRef, indicatorStyle] = useSlidingIndicator<HTMLDivElement>(
    activeRightPanel,
    '.app-panel-tab.is-active',
    [shadowMode],
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
  const shadowGlyphOnly = shadowMode && trayWidth < 300;
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
          <RightPanelTab
            id="todo"
            active={activeRightPanel === 'todo'}
            onClick={() => setActiveRightPanel('todo')}
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
            active={activeRightPanel === 'library'}
            onClick={() => setActiveRightPanel('library')}
          >
            <span>{compactLabels ? 'LIB' : '素材库'}</span>
          </RightPanelTab>
          <RightPanelTab
            id="stats"
            active={activeRightPanel === 'stats'}
            onClick={() => setActiveRightPanel('stats')}
          >
            <span>{compactLabels ? 'SS' : 'Stats'}</span>
          </RightPanelTab>
          {shadowMode && (
            <RightPanelTab
              id="shadow"
              accent
              active={activeRightPanel === 'shadow'}
              onClick={() => setActiveRightPanel('shadow')}
              extraStyle={
                shadowJustAppeared
                  ? { animation: 'insp-shadow-tab-pulse 1.4s ease-in-out 3' }
                  : undefined
              }
            >
              <span
                style={{
                  fontFamily: 'var(--font-serif)',
                  fontStyle: 'italic',
                  fontSize: 13,
                }}
              >
                ◐
              </span>
              {!shadowGlyphOnly && <span>Shadow</span>}
              {!shadowGlyphOnly && (
                <span style={{ color: 'hsl(var(--ink-4))', fontSize: 9.5 }}>{shadowReviewCount}</span>
              )}
            </RightPanelTab>
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
