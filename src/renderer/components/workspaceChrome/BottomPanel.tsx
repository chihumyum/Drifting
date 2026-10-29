import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { trackGlassFlow } from '../../lib/glass-flow';
import { clampDimension, parsePersistedDimension, verticalDockBounds } from '../../lib/layout-geometry';
import { planSidebarPush, SIDEBAR_PUSH_EASING, SIDEBAR_PUSH_MS } from '../../lib/sidebar-push';
import {
  BOTTOM_PANEL_DEFAULT_HEIGHT,
  BottomPanelContext,
  type BottomPanelApi,
  type BottomPanelPane,
} from './bottom-panel-context';

// Top to bottom: the timeline stacks above the planner, so going to the
// planner pushes everything up and coming back pushes it down.
const PANES: readonly BottomPanelPane[] = ['timeline', 'planner'];

// One height for whichever pane shows. It keeps the timeline's old key, so the
// height the author dragged the timeline to carries over to both.
const HEIGHT_STORAGE_KEY = 'timeline-total-height';
const MIN_HEIGHT = 180;
// Keep at least this much of the paper above the panel.
const MIN_PAPER_HEIGHT = 240;
// The arriving pane's outline fades out whole after it lands, as in the sidebars.
const OUTLINE_FADE_MS = 340;

function readStoredHeight(): number {
  const stored = typeof localStorage === 'undefined'
    ? null
    : parsePersistedDimension(localStorage.getItem(HEIGHT_STORAGE_KEY));
  const viewport = typeof window === 'undefined' ? 700 : window.innerHeight;
  return clampDimension(stored ?? BOTTOM_PANEL_DEFAULT_HEIGHT, verticalDockBounds(viewport, MIN_HEIGHT, MIN_PAPER_HEIGHT));
}

function storeHeight(height: number) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(HEIGHT_STORAGE_KEY, height.toString());
}

// Without motion (reduced, or no Web Animations) the newcomer simply replaces the other.
function canPush() {
  if (typeof window === 'undefined' || typeof Element === 'undefined') return false;
  return typeof Element.prototype.animate === 'function'
    && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The Bottom Panel under the paper: one shell holding the Bottom Timeline or
 * the focused chapter's plot planner, never both. The shell keeps still — its
 * top border, the handle that drags its height, the height itself, shared by
 * both and remembered. Only what is inside moves: each pane is a whole, its
 * header included, and swapping them pushes it like heavy ice (the sidebar
 * panels' push, 265ms, slow then fast) up past the border, the planner rising
 * from below; coming back pushes it down. While it arrives the new pane is
 * outlined by lines that bleed glass, and every line inside the panel (the
 * timeline's lanes) bleeds with it, fading out whole once it rests. A swap
 * made mid-push carries on from where both panes are. Only the shown pane
 * stays mounted.
 */
export function BottomPanel({ show, children }: {
  show: BottomPanelPane;
  children: Record<BottomPanelPane, ReactNode>;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const paneRefs = useRef(new Map<BottomPanelPane, HTMLDivElement>());
  const placedRef = useRef(new Set<BottomPanelPane>());
  const minHeights = useRef(new Map<BottomPanelPane, number>());

  const [shown, setShown] = useState(show);
  // Panes pushed away but still on the strip, as they were when left.
  const [behind, setBehind] = useState<BottomPanelPane[]>([]);
  const [push, setPush] = useState<{ id: number; dir: 1 | -1 } | null>(null);
  if (show !== shown) {
    if (canPush()) {
      setBehind([...behind.filter((pane) => pane !== show), shown]);
      // 1 enters from above (pushing down), -1 from below (pushing up).
      setPush({ id: (push?.id ?? 0) + 1, dir: PANES.indexOf(show) < PANES.indexOf(shown) ? 1 : -1 });
    }
    setShown(show);
  }

  const [storedHeight, setStoredHeight] = useState(readStoredHeight);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const [resizing, setResizing] = useState<{ grab: number; bottom: number } | null>(null);
  const height = dragHeight ?? storedHeight;

  const bounds = useCallback(() => {
    const column = frameRef.current?.closest('.app-mid');
    const available = column ? column.getBoundingClientRect().height : window.innerHeight;
    return verticalDockBounds(available, MIN_HEIGHT, MIN_PAPER_HEIGHT);
  }, []);
  const setHeight = useCallback((next: number) => {
    const clamped = clampDimension(next, bounds());
    setStoredHeight(clamped);
    storeHeight(clamped);
  }, [bounds]);

  // A remembered height is only a preference: re-clamp it whenever the desk
  // column changes size (window resize, another display).
  useEffect(() => {
    const normalize = () => {
      const next = clampDimension(storedHeight, bounds());
      if (next !== storedHeight) setHeight(next);
    };
    const frame = window.requestAnimationFrame(normalize);
    const column = frameRef.current?.closest('.app-mid');
    const observer = column && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(normalize) : null;
    if (column && observer) observer.observe(column);
    window.addEventListener('resize', normalize);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', normalize);
    };
  }, [bounds, setHeight, storedHeight]);

  // Resized by its top edge: the grabbed point stays under the pointer and
  // the bottom stays put, so the paper above keeps MIN_PAPER_HEIGHT.
  useEffect(() => {
    if (!resizing) return undefined;
    let last: number | null = null;
    const onMove = (event: MouseEvent) => {
      const limits = bounds();
      const min = Math.min(limits.max, Math.max(limits.min, minHeights.current.get(shown) ?? 0));
      last = clampDimension(resizing.bottom - event.clientY + resizing.grab, { min, max: limits.max });
      setDragHeight(last);
    };
    const onUp = () => {
      setResizing(null);
      setDragHeight(null);
      if (last !== null) setHeight(last);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [bounds, resizing, setHeight, shown]);

  const startResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = frameRef.current?.getBoundingClientRect();
    setResizing({ grab: rect ? event.clientY - rect.top : 0, bottom: rect ? rect.bottom : window.innerHeight });
  };

  const setMinHeight = useCallback((pane: BottomPanelPane, min: number) => {
    minHeights.current.set(pane, min);
  }, []);
  const minSetters = useMemo(() => ({
    timeline: (min: number) => setMinHeight('timeline', min),
    planner: (min: number) => setMinHeight('planner', min),
  }), [setMinHeight]);
  const apis = useMemo<Record<BottomPanelPane, BottomPanelApi>>(() => {
    const api = (pane: BottomPanelPane) => ({ height, setHeight, setMinHeight: minSetters[pane] });
    return { timeline: api('timeline'), planner: api('planner') };
  }, [height, minSetters, setHeight]);

  useLayoutEffect(() => {
    const strip = stripRef.current;
    const panes = paneRefs.current;
    if (!strip) return;
    if (!push) {
      for (const element of panes.values()) for (const animation of element.getAnimations()) animation.cancel();
      return;
    }
    // Read where every pane placed before this swap is right now, a running
    // push included, then move the strip on from there.
    const top = strip.getBoundingClientRect().top;
    const now = [...panes].filter(([pane]) => placedRef.current.has(pane))
      .map(([pane, element]) => ({ key: pane, x: element.getBoundingClientRect().top - top }));
    const moves = planSidebarPush(now, shown, strip.clientHeight, push.dir);
    for (const element of panes.values()) for (const animation of element.getAnimations()) animation.cancel();
    for (const move of moves) {
      panes.get(move.key as BottomPanelPane)?.animate(
        [{ transform: `translateY(${move.from}px)` }, { transform: `translateY(${move.to}px)` }],
        { duration: SIDEBAR_PUSH_MS, easing: SIDEBAR_PUSH_EASING, fill: 'forwards' },
      );
    }
    const kept = new Set(moves.map((move) => move.key));
    setBehind((panesBehind) => panesBehind.filter((pane) => kept.has(pane)));
    trackGlassFlow(strip, () => panes.get(shown)?.getBoundingClientRect().top ?? 0);
  }, [push]); // eslint-disable-line react-hooks/exhaustive-deps -- runs once per swap
  // After the push effect: the panes this commit placed, for the next swap.
  useLayoutEffect(() => {
    placedRef.current = new Set(paneRefs.current.keys());
  });
  useEffect(() => {
    if (!push) return undefined;
    const timer = window.setTimeout(() => {
      // Hand the lines back to the drawer, whose slides bleed them too.
      stripRef.current?.style.removeProperty('--flow');
      stripRef.current?.style.removeProperty('--flowa');
      setBehind([]);
      setPush(null);
    }, SIDEBAR_PUSH_MS + OUTLINE_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [push]);

  const slides = [
    ...behind.map((pane) => ({ pane, role: 'out' })),
    { pane: shown, role: push ? 'in' : 'still' },
  ].sort((a, b) => PANES.indexOf(a.pane) - PANES.indexOf(b.pane));
  return (
    <div ref={frameRef} className={`bottom-panel${push ? ' is-pushing' : ''}`} style={{ height }}>
      <div className="bottom-panel__resize" onMouseDown={startResize} />
      <div ref={stripRef} className="bottom-panel__panes">
        {slides.map(({ pane, role }) => (
          <div
            key={pane}
            ref={(element) => {
              if (element) paneRefs.current.set(pane, element);
              else paneRefs.current.delete(pane);
            }}
            className={`bottom-panel__pane${role === 'still' ? '' : ` bottom-panel__pane--${role}`}`}
            data-bottom-pane={pane}
            aria-hidden={role === 'out' ? true : undefined}
          >
            <BottomPanelContext.Provider value={apis[pane]}>{children[pane]}</BottomPanelContext.Provider>
            {role === 'in' && (
              <span className="bottom-panel__outline" aria-hidden="true">
                <span className="flow-line flow-line--h bottom-panel__outline-top" />
                <span className="flow-line flow-line--h bottom-panel__outline-bottom" />
                <span className="flow-line flow-line--v bottom-panel__outline-start" />
                <span className="flow-line flow-line--v bottom-panel__outline-end" />
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The header row every pane of the Bottom Panel opens with: what the pane
 * shows at its start, its actions at its end, on the desk colour. The
 * timeline and the plot planner both use it, so the row is styled once
 * (`.bottom-panel-head`); it moves with its pane.
 */
export function BottomPanelHeader({ start, end, className = '', onClick }: {
  start: ReactNode;
  end?: ReactNode;
  className?: string;
  onClick?: (event: ReactMouseEvent<HTMLDivElement>) => void;
}) {
  return (
    <div className={`bottom-panel-head${className ? ` ${className}` : ''}`} onClick={onClick}>
      <div className="bottom-panel-head__start">{start}</div>
      {end != null && <div className="bottom-panel-head__end">{end}</div>}
    </div>
  );
}
