import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useUiStore, type SidebarType } from '../../store/ui-store';
import type { SidebarPaneId } from '../../lib/sidebar-tabs';
import { SidebarPanelStateContext } from '../../hooks/useSidebarPanelState';
import { sidebarPanelKey } from '../../store/sidebar-panel-store';
import type { SidebarPanelScope } from '../../store/sidebar-panel-store';
import { SidebarPaneContext } from '../../lib/sidebar-pane-context';
import { useSidebarMetricsStore } from '../../store/sidebar-metrics-store';
import {
  clampSidebarSplitRatio, sidebarSplitRatioBounds, SIDEBAR_DIVIDER_WIDTH,
  sidebarSplitMinWidth, type DimensionBounds,
} from '../../lib/layout-geometry';

/** Each stable pane owns its tab strip and body, including duplicate tabs. */
export function DesktopSidebarLayout({
  side, panels, projectId,
}: {
  side: SidebarType;
  projectId?: string;
  panels: { id: SidebarPaneId; tab: SidebarPanelScope['tab']; header: ReactNode; content: ReactNode }[];
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const split = panels.length === 2;
  const preferredRatio = useUiStore((s) => side === 'left' ? s.leftPanelSplitRatio : s.rightPanelSplitRatio);
  const storedWidth = useUiStore((s) => s.sidebars[side].width);
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);
  const width = measuredWidth ?? storedWidth;
  const minimumWidth = useSidebarMetricsStore((state) => state.minimumWidths[side]);
  const ratio = clampSidebarSplitRatio(preferredRatio, minimumWidth, width);
  const ratioBounds = sidebarSplitRatioBounds(minimumWidth, width);
  const setRatio = useUiStore((s) => side === 'left' ? s.setLeftPanelSplitRatio : s.setRightPanelSplitRatio);
  const setSplitAvailable = useUiStore((s) => s.setSidebarSplitAvailable);
  const focusPane = useUiStore((s) => s.focusSidebarPane);
  const stopDragging = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const measure = () => {
      if (node.clientWidth > 0) {
        setMeasuredWidth(node.clientWidth);
        if (minimumWidth > 0) setSplitAvailable(side, node.clientWidth >= sidebarSplitMinWidth(minimumWidth));
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [side, minimumWidth, setSplitAvailable]);

  useEffect(() => () => stopDragging.current(), [split]);

  const onDividerMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    stopDragging.current();
    const onMove = (event: MouseEvent) => {
      event.preventDefault();
      const rect = bodyRef.current?.getBoundingClientRect();
      if (rect && rect.width > SIDEBAR_DIVIDER_WIDTH) {
        const next = (event.clientX - rect.left - SIDEBAR_DIVIDER_WIDTH / 2) / (rect.width - SIDEBAR_DIVIDER_WIDTH);
        setRatio(clampSidebarSplitRatio(next, minimumWidth, rect.width));
      }
    };
    const preventSelection = (event: Event) => event.preventDefault();
    const stop = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', stop);
      document.removeEventListener('selectstart', preventSelection, true);
      window.removeEventListener('blur', stop);
      stopDragging.current = () => {};
    };
    stopDragging.current = stop;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', stop);
    document.addEventListener('selectstart', preventSelection, true);
    window.addEventListener('blur', stop);
  };

  return (
    <div ref={rootRef} data-sidebar-layout={side} style={{
      display: 'flex', flexDirection: 'column', flex: 1, height: '100%', minHeight: 0,
      background: 'var(--workspace-ui-bg)',
    }}>
      <div ref={bodyRef} style={{ display: 'flex', flex: 1, minHeight: 0, minWidth: 0 }}>
        {panels.map((panel, index) => (
          <Fragment key={panel.id}>
            {index > 0 && <ColumnDivider
              ratio={ratio}
              bounds={ratioBounds}
              onChange={(next) => setRatio(clampSidebarSplitRatio(next, minimumWidth, width))}
              onMouseDown={onDividerMouseDown}
            />}
            <div data-sidebar-pane={panel.id} data-sidebar-panel={panel.tab}
              onPointerDownCapture={() => focusPane(side, panel.id)}
              onFocusCapture={() => focusPane(side, panel.id)}
              style={{
              flex: `${split ? (index === 0 ? ratio : 1 - ratio) : 1} 1 0`,
              minWidth: split ? minimumWidth : 0,
              minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden',
            }}>
              <SidebarPaneContext.Provider value={panel.id}>
                <SidebarPanelStateContext.Provider
                  key={`${projectId}:${panel.tab}`}
                  value={projectId ? sidebarPanelKey({ projectId, side, paneId: panel.id, tab: panel.tab }) : null}>
                  {panel.header}
                  {panel.content}
                </SidebarPanelStateContext.Provider>
              </SidebarPaneContext.Provider>
            </div>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function ColumnDivider({ ratio, bounds, onChange, onMouseDown }: {
  ratio: number;
  bounds: DimensionBounds;
  onChange: (ratio: number) => void;
  onMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
}) {
  return (
    <div onMouseDown={onMouseDown} role="separator" aria-orientation="vertical"
      tabIndex={0} aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={Math.round(bounds.min * 100)} aria-valuemax={Math.round(bounds.max * 100)}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        onChange(ratio + (event.key === 'ArrowLeft' ? -0.05 : 0.05));
      }}
      style={{
        width: 7, marginLeft: -3, marginRight: -3, flexShrink: 0,
        position: 'relative', zIndex: 1, cursor: 'col-resize',
        display: 'flex', justifyContent: 'center', background: 'transparent',
      }}>
      <div style={{ width: 0.5, height: '100%', background: 'var(--workspace-local-border)' }} />
    </div>
  );
}
