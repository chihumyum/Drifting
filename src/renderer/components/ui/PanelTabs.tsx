import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { trackGlassFlow } from '../../lib/glass-flow';
import { PUSH_EASING, PUSH_MS } from '../../lib/motion';

interface PanelTabTrayProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

function reducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/**
 * A pane's row of panel tabs. The tabs stay plain words; one square glass
 * block lies under the chosen tab's whole share of the row and, when another
 * tab is chosen, slides there on the pane's own push (same duration and
 * easing), landing with the panel. Its glass runs with the distance it moves
 * (`--flow`, lib/glass-flow.ts) and stands still once it lands.
 */
export const PanelTabTray = forwardRef<HTMLDivElement, PanelTabTrayProps>(function PanelTabTray(
  { className = '', children, ...props },
  ref,
) {
  const trayRef = useRef<HTMLDivElement | null>(null);
  const blockRef = useRef<HTMLElement | null>(null);
  const placed = useRef<{ x: number; width: number } | null>(null);
  const setRefs = useCallback((element: HTMLDivElement | null) => {
    trayRef.current = element;
    if (typeof ref === 'function') ref(element);
    else if (ref) ref.current = element;
  }, [ref]);

  const place = useCallback((move: boolean) => {
    const tray = trayRef.current;
    const block = blockRef.current;
    if (!tray || !block) return;
    // The left sidebar wraps each tab button with its activity badge; the
    // wrapper is the tab's slot in the row.
    const chosen = tray.querySelector<HTMLElement>(':scope > .app-panel-tab.is-active');
    const next = chosen ? { x: chosen.offsetLeft, width: chosen.offsetWidth } : null;
    const previous = placed.current;
    if (previous?.x === next?.x && previous?.width === next?.width) return;
    placed.current = next;
    if (!next) {
      block.style.width = '0px';
      return;
    }
    const slide = move && previous !== null && !reducedMotion();
    block.style.transition = slide
      ? `transform ${PUSH_MS}ms ${PUSH_EASING}, width ${PUSH_MS}ms ${PUSH_EASING}`
      : 'none';
    block.style.transform = `translateX(${next.x}px)`;
    block.style.width = `${next.width}px`;
    if (slide) trackGlassFlow(tray, () => block.getBoundingClientRect().left);
  }, []);

  // A new choice slides in the same commit the pane's push starts. Only a
  // different chosen tab or a different row is measured here: reading
  // offsets on every render forced a synchronous layout inside unrelated
  // commits, such as switching the editor tab while the sidebar is open.
  const seated = useRef<{ chosen: Element | null; tabs: number } | null>(null);
  const resizes = useRef<ResizeObserver | null>(null);
  useLayoutEffect(() => {
    const tray = trayRef.current;
    if (!tray) return;
    const chosen = tray.querySelector(':scope > .app-panel-tab.is-active');
    const tabs = tray.childElementCount;
    if (seated.current?.chosen === chosen && seated.current.tabs === tabs) return;
    seated.current = { chosen, tabs };
    for (const tab of tray.querySelectorAll(':scope > .app-panel-tab')) resizes.current?.observe(tab);
    place(true);
  });

  // A row that only changes size (resize, fonts, labels) re-seats the block still.
  useEffect(() => {
    const tray = trayRef.current;
    if (!tray) return undefined;
    // The block's glass runs with its own travel, not with the sidebar's.
    if (!tray.style.getPropertyValue('--flow')) tray.style.setProperty('--flow', '0');
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => place(false));
    observer.observe(tray);
    for (const tab of tray.querySelectorAll(':scope > .app-panel-tab')) observer.observe(tab);
    resizes.current = observer;
    return () => {
      observer.disconnect();
      resizes.current = null;
    };
  }, [place]);

  return (
    <div ref={setRefs} className={`panel-tab-tray ${className}`.trim()} {...props}>
      <i ref={blockRef} aria-hidden="true" className="panel-tab-tray__block glass is-on" />
      {children}
    </div>
  );
});

/**
 * The four edges of a pane's tab header. Over any of its tabs, chosen or
 * not, they bleed glass that drifts slowly: the whole header region is the
 * rail its tabs sit in (desktop-shell.css).
 */
export function PanelTabRowEdges() {
  return (
    <span className="panel-tab-row__edges" aria-hidden="true">
      <span className="panel-tab-row__edge panel-tab-row__edge--top" />
      <span className="panel-tab-row__edge panel-tab-row__edge--bottom" />
      <span className="panel-tab-row__edge panel-tab-row__edge--start" />
      <span className="panel-tab-row__edge panel-tab-row__edge--end" />
    </span>
  );
}

interface PanelTabProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active: boolean;
  typography?: 'label' | 'caps';
}

/**
 * Shared sidebar panel tab. Both sidebars use a real button with identical
 * geometry; labels and activity content remain caller slots.
 */
export function PanelTab({
  active,
  typography = 'caps',
  className = '',
  children,
  ...props
}: PanelTabProps) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={[
        'app-panel-tab',
        `app-panel-tab--${typography}`,
        active ? 'is-active' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...props}
    >
      {children}
    </button>
  );
}
