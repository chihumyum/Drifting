import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { SIDEBAR_PUSH_EASING, SIDEBAR_PUSH_MS } from '../../lib/sidebar-push';

export type BottomDockPane = 'timeline' | 'planner';

// Left to right, the order their toggles sit in the paper's corner.
const PANES: readonly BottomDockPane[] = ['timeline', 'planner'];

// Without motion (reduced, or no Web Animations) the newcomer simply replaces the other.
function canPush() {
  if (typeof window === 'undefined' || typeof Element === 'undefined') return false;
  return typeof Element.prototype.animate === 'function'
    && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The dock under the paper holds the Bottom Timeline or the plot planner,
 * never both. Swapping one for the other while the dock is open pushes the
 * content like heavy ice — the sidebar panels' push, 265ms, slow then fast —
 * the newcomer entering from its toggle's side, while the dock's height
 * follows on the same curve. Only the shown pane stays mounted.
 */
export function BottomDockSwap({ show, children }: {
  show: BottomDockPane;
  children: Record<BottomDockPane, ReactNode>;
}) {
  const [current, setCurrent] = useState(show);
  const [leaving, setLeaving] = useState<BottomDockPane | null>(null);
  if (show !== current) {
    setLeaving(canPush() ? current : null);
    setCurrent(show);
  }
  const frameRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    const strip = stripRef.current;
    const outgoing = strip?.querySelector<HTMLElement>(`[data-dock-pane="${leaving}"]`);
    const incoming = strip?.querySelector<HTMLElement>(`[data-dock-pane="${current}"]`);
    if (!leaving || !frame || !strip || !outgoing || !incoming) return undefined;
    const fromRight = PANES.indexOf(current) > PANES.indexOf(leaving);
    const options: KeyframeAnimationOptions = { duration: SIDEBAR_PUSH_MS, easing: SIDEBAR_PUSH_EASING, fill: 'forwards' };
    // Both panes sit side by side in PANES order on a strip twice as wide.
    const push = strip.animate(
      [{ transform: `translateX(${fromRight ? '0%' : '-50%'})` }, { transform: `translateX(${fromRight ? '-50%' : '0%'})` }],
      options,
    );
    const grow = frame.animate(
      [{ height: `${outgoing.offsetHeight}px` }, { height: `${incoming.offsetHeight}px` }],
      options,
    );
    let done = false;
    push.onfinish = () => {
      if (!done) setLeaving(null);
    };
    // The commit that drops the outgoing pane cancels the held end frames.
    return () => {
      done = true;
      push.cancel();
      grow.cancel();
    };
  }, [current, leaving]);

  const panes = leaving ? PANES.filter((pane) => pane === leaving || pane === current) : [current];
  return (
    <div ref={frameRef} className={`bottom-dock-swap${leaving ? ' is-swapping' : ''}`}>
      <div ref={stripRef} className="bottom-dock-swap__strip">
        {panes.map((pane) => (
          <div key={pane} className="bottom-dock-swap__pane" data-dock-pane={pane}>
            {children[pane]}
          </div>
        ))}
      </div>
    </div>
  );
}
