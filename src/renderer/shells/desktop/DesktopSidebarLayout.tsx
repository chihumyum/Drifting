import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useUiStore, type SidebarType } from '../../store/ui-store';
import { LEFT_SIDEBAR_TABS, RIGHT_SIDEBAR_TABS, type SidebarPaneId } from '../../lib/sidebar-tabs';
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

// Splitting or merging a sidebar pushes the divider in from (or out to) the
// side of the pane that arrives or leaves; matches `.sidebar-pane--entering`
// and `.sidebar-pane-ghost` in desktop-shell.css.
const SPLIT_ANIM_MS = 420;
// Matches `sidebar-push-*` in desktop-shell.css.
const PUSH_MS = 370;
// The arriving panel's glass outline fades out whole after the push
// (`.flow-line::after`'s opacity transition); they stay mounted until then.
const OUTLINE_FADE_MS = 340;
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
  const panelStateKey = (paneId: SidebarPaneId, tab: SidebarPanelScope['tab']) =>
    projectId ? sidebarPanelKey({ projectId, side, paneId, tab }) : null;

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
    <div ref={rootRef} data-sidebar-layout={side} style={{
      display: 'flex', flexDirection: 'column', flex: 1, height: '100%', minHeight: 0,
      background: 'var(--workspace-ui-bg)',
    }}>
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
                  <SidebarPanelStateContext.Provider value={panelStateKey(panel.id, panel.tab)}>
                    {panel.header}
                  </SidebarPanelStateContext.Provider>
                  <SidebarPaneSlides
                    order={side === 'left' ? LEFT_SIDEBAR_TABS : RIGHT_SIDEBAR_TABS}
                    tab={panel.tab}
                    content={panel.content}
                    slideKey={(tab) => `${projectId}:${tab}`}
                    stateKey={(tab) => panelStateKey(panel.id, tab)}
                  />
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

/**
 * A pane's body. Switching its tab pushes the whole panel away like a heavy
 * block of ice: toward the right when the new tab lies to the left in the
 * tab row (and the reverse), the new panel arriving behind it from the other
 * side; slow to start, then fast (`.sidebar-pane__slide--out/--in`). The
 * outgoing panel stays mounted, as it was, until it has gone. While it
 * arrives, the new panel is outlined on all four sides (one of them the edge
 * it shares with the outgoing panel) by lines that bleed glass like the
 * sidebar's other edges, fading out whole once it rests.
 */
function SidebarPaneSlides({ order, tab, content, slideKey, stateKey }: {
  order: readonly string[];
  tab: SidebarPanelScope['tab'];
  content: ReactNode;
  slideKey: (tab: SidebarPanelScope['tab']) => string;
  stateKey: (tab: SidebarPanelScope['tab']) => string | null;
}) {
  const slidesRef = useRef<HTMLDivElement | null>(null);
  const incomingRef = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState({ tab, content });
  const [outgoing, setOutgoing] = useState<{ tab: SidebarPanelScope['tab']; content: ReactNode; dir: 1 | -1 } | null>(null);
  if (tab !== shown.tab) {
    setOutgoing({ tab: shown.tab, content: shown.content, dir: order.indexOf(tab) < order.indexOf(shown.tab) ? 1 : -1 });
    setShown({ tab, content });
  } else if (content !== shown.content) {
    setShown({ tab, content });
  }
  useEffect(() => {
    if (!outgoing) return undefined;
    const slidesEl = slidesRef.current;
    if (slidesEl) trackGlassFlow(slidesEl, () => incomingRef.current?.getBoundingClientRect().left ?? 0);
    const timer = window.setTimeout(() => setOutgoing(null), PUSH_MS + OUTLINE_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [outgoing]);
  const slides = outgoing && outgoing.tab !== tab
    ? [{ tab: outgoing.tab, content: outgoing.content, role: 'out' }, { tab, content, role: 'in' }]
    : [{ tab, content, role: 'still' }];
  return (
    <div ref={slidesRef} className="sidebar-pane__slides"
      style={outgoing ? { '--push-dir': outgoing.dir } as CSSProperties : undefined}>
      {slides.map((slide) => (
        <div key={slideKey(slide.tab)} ref={slide.role === 'in' ? incomingRef : undefined}
          className={`sidebar-pane__slide${slide.role === 'still' ? '' : ` sidebar-pane__slide--${slide.role}`}`}
          aria-hidden={slide.role === 'out' ? true : undefined}>
          <SidebarPanelStateContext.Provider value={stateKey(slide.tab)}>
            {slide.content}
          </SidebarPanelStateContext.Provider>
          {slide.role === 'in' && (
            <span className="sidebar-pane__outline" aria-hidden="true">
              <span className="flow-line flow-line--h sidebar-pane__outline-top" />
              <span className="flow-line flow-line--h sidebar-pane__outline-bottom" />
              <span className="flow-line flow-line--v sidebar-pane__outline-start" />
              <span className="flow-line flow-line--v sidebar-pane__outline-end" />
            </span>
          )}
        </div>
      ))}
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
