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
import { trackGlassFlow } from '../../lib/glass-flow';
import { SidebarSplitButton } from '../../components/SidebarSplitButton';

// Splitting or merging a sidebar pushes the divider in from (or out to) the
// side of the pane that arrives or leaves; matches `.sidebar-pane--entering`
// and `.sidebar-pane-ghost` in desktop-shell.css.
const SPLIT_ANIM_MS = 420;
// Flex grow factors are scaled up so they never sum below 1 while a pane
// grows from or folds to zero: below 1 flexbox leaves the rest empty.
const GROW_SCALE = 100;

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

  // The arriving pane grows from nothing; a closed pane leaves a blank ghost
  // in its place that folds away, so the divider slides rather than jumps.
  const ids = panels.map((panel) => panel.id).join(' ');
  const [shownIds, setShownIds] = useState(ids);
  const [entering, setEntering] = useState<SidebarPaneId | null>(null);
  const [leaving, setLeaving] = useState<{ index: number; grow: number } | null>(null);
  if (ids !== shownIds) {
    const shown = shownIds.split(' ');
    if (panels.length === 2 && shown.length === 1) {
      setEntering(panels.find((panel) => !shown.includes(panel.id))?.id ?? null);
      setLeaving(null);
    } else if (panels.length === 1 && shown.length === 2) {
      const index = shown.findIndex((id) => id !== panels[0].id);
      setLeaving({ index, grow: index === 0 ? ratio : 1 - ratio });
      setEntering(null);
    }
    setShownIds(ids);
  }
  // While a closed half folds away the split button already waits, still, at
  // the end of the tab row it will finally sit in; the remaining half's tabs
  // move across as usual and its own copy of the button stays hidden until
  // it arrives underneath (`data-split-leaving`).
  const [splitButtonAt, setSplitButtonAt] = useState<{ top: number; left?: number; right?: number } | null>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const button = root?.querySelector<HTMLElement>('[data-sidebar-pane] .sidebar-split-button');
    const pane = button?.closest<HTMLElement>('[data-sidebar-pane]');
    if (!leaving || !root || !button || !pane) {
      setSplitButtonAt(null);
      return;
    }
    const rootBox = root.getBoundingClientRect();
    const box = button.getBoundingClientRect();
    const paneBox = pane.getBoundingClientRect();
    // The button keeps its distance from the row's end as the half grows.
    setSplitButtonAt(leaving.index === 0
      ? { top: box.top - rootBox.top, left: box.left - paneBox.left }
      : { top: box.top - rootBox.top, right: paneBox.right - box.right });
  }, [leaving]);

  useEffect(() => {
    if (!entering && !leaving) return undefined;
    const shell = rootRef.current?.closest<HTMLElement>('.sidebar-shell');
    const divider = rootRef.current?.querySelector<HTMLElement>('[role="separator"]');
    if (shell && divider) trackGlassFlow(shell, () => divider.getBoundingClientRect().left);
    const timer = window.setTimeout(() => {
      setEntering(null);
      setLeaving(null);
    }, SPLIT_ANIM_MS);
    return () => window.clearTimeout(timer);
  }, [entering, leaving]);

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
    <div ref={rootRef} data-sidebar-layout={side} data-split-leaving={leaving ? 'true' : undefined} style={{
      display: 'flex', flexDirection: 'column', flex: 1, height: '100%', minHeight: 0,
      background: 'var(--workspace-ui-bg)', position: 'relative',
    }}>
      {leaving && splitButtonAt && (
        <div className="sidebar-split-overlay" style={splitButtonAt}>
          <SidebarSplitButton side={side} edge={leaving.index === 0 ? 'start' : 'end'} />
        </div>
      )}
      <div ref={bodyRef} style={{ display: 'flex', flex: 1, minHeight: 0, minWidth: 0 }}>
        {panels.map((panel, index) => {
          const divider = (
            <ColumnDivider
              ratio={ratio}
              bounds={ratioBounds}
              onChange={(next) => setRatio(clampSidebarSplitRatio(next, minimumWidth, width))}
              onMouseDown={onDividerMouseDown}
            />
          );
          const grow = split ? (index === 0 ? ratio : 1 - ratio) : leaving ? 1 - leaving.grow : 1;
          return (
            <Fragment key={panel.id}>
              {leaving?.index === 0 && <SidebarPaneGhost grow={leaving.grow} />}
              {(index > 0 || leaving?.index === 0) && divider}
              <div data-sidebar-pane={panel.id} data-sidebar-panel={panel.tab}
                className={panel.id === entering ? 'sidebar-pane--entering' : undefined}
                onPointerDownCapture={() => focusPane(side, panel.id)}
                onFocusCapture={() => focusPane(side, panel.id)}
                style={{
                flex: `${grow * GROW_SCALE} 1 0`,
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
              {leaving?.index === 1 && divider}
              {leaving?.index === 1 && <SidebarPaneGhost grow={leaving.grow} />}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

/** Where a closed pane was: blank chrome folding away under the divider. */
function SidebarPaneGhost({ grow }: { grow: number }) {
  return (
    <div className="sidebar-pane-ghost" aria-hidden="true" style={{ flex: `${grow * GROW_SCALE} 1 0` }}>
      <div className="sidebar-pane-ghost__head" />
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
      <span className="flow-line flow-line--v sidebar-pane-divider__flow" aria-hidden="true" />
    </div>
  );
}
