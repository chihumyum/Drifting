import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUiStore } from '../../store/ui-store';
import { PanelTab, PanelTabTray } from '../ui/PanelTabs';
import { LabelMono } from '../ui/LabelMono';

type RightPanelId = 'todo' | 'library' | 'stats' | 'companion';

interface RightSidebarHeaderProps {
  kicker: string;
  title: string;
  /** Pulsates the library/TODO tab labels after a background conversion. */
  fragmentCountFlash?: boolean;
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
  hideTitleBlock,
  group,
  flat,
}: RightSidebarHeaderProps) {
  const { t } = useTranslation();
  const storeGroup = useUiStore((state) => state.rightPanelGroup);
  const activeRightPanel = useUiStore((state) => state.activeRightPanel);
  const setActiveRightPanel = useUiStore((state) => state.setActiveRightPanel);
  const setRightPanelGroup = useUiStore((state) => state.setRightPanelGroup);
  // Render modes:
  //  - flat: show ALL five tabs in one row (the default single-column panel).
  //  - column: `group` pins one group's tabs (the wide-screen split layout).
  const renderGroup = group ?? storeGroup;
  const activeOf = (g: 'content' | 'agent') =>
    g === 'content' ? activeRightPanel : 'companion';
  // In flat mode the one active tab is (storeGroup, that group's active);
  // otherwise it's the rendered group's active tab.
  const isActive = (g: 'content' | 'agent', id: string) =>
    flat ? storeGroup === g && activeOf(g) === id : activeOf(renderGroup) === id;
  const onSelect = (g: 'content' | 'agent', id: string) => {
    if (g === 'content') setActiveRightPanel(id as 'todo' | 'library' | 'stats');
    else setRightPanelGroup('agent');
  };
  const trayRef = useRef<HTMLDivElement | null>(null);
  // Compact labels are based on the tray's actual width, not sidebar width.
  const [trayWidth, setTrayWidth] = useState(Number.POSITIVE_INFINITY);
  useEffect(() => {
    const node = trayRef.current;
    if (!node) return;
    const update = () => setTrayWidth(node.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);
  const compactLabels = trayWidth < 200;

  return (
    <>
      <div
        className="workspace-local-divider workspace-panel-tab-row"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          background: 'var(--workspace-ui-bg)',
          flexShrink: 0,
        }}
      >
        <PanelTabTray ref={trayRef} className="rightbar-tab-tray">
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
                <span>{compactLabels ? 'LIB' : t('rightSidebar.tabs.library')}</span>
              </RightPanelTab>
              <RightPanelTab
                id="stats"
                active={isActive('content', 'stats')}
                onClick={() => onSelect('content', 'stats')}
              >
                <span>{compactLabels ? 'SS' : t('rightSidebar.tabs.stats')}</span>
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
            </>
          )}
        </PanelTabTray>
      </div>

      {!hideTitleBlock && (
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
      )}
    </>
  );
}

function RightPanelTab({
  id: _id,
  active,
  onClick,
  children,
}: {
  id: RightPanelId;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <PanelTab onClick={onClick} active={active} typography="caps">
      {children}
    </PanelTab>
  );
}
