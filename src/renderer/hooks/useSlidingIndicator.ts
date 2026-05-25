import { useEffect, useRef, useState } from 'react';

// Reusable sliding-pill active-tab indicator hook (from design v3 topBars.jsx).
//
// Mount a child `<div className="tab-indicator" style={indicatorStyle}/>`
// inside the returned container ref. Mark the active tab with the selector
// you pass (default `.is-active`). The indicator measures the active tab's
// offsetLeft/offsetWidth and applies a transform — CSS handles the slide
// transition. Re-measures on activeKey change and on container resize.
//
// `activeKey` should change whenever the active tab changes (e.g., the tab
// id or panel id). Pass extra deps (tab list mutations etc) via `extraDeps`
// if reorder / close affects positions.
//
// Snap vs. slide: when the *active key* changes, the user clicked a
// different tab and the pill should slide between the two (signals "the
// active selection moved"). When `extraDeps` change but the key stays the
// same — e.g. the active tab was reordered to a new index — sliding
// instead reads as "the active highlight is sweeping across other tabs,"
// and those in-between tabs briefly look selected. In that case the hook
// snaps the pill to the new position with `transition: 'none'` for a single
// render, then restores the default transition.
export function useSlidingIndicator<T extends HTMLElement = HTMLDivElement>(
  activeKey: unknown,
  activeSelector: string = '.is-active',
  extraDeps: unknown[] = [],
): readonly [
  React.RefObject<T | null>,
  {
    transform: string;
    width: number;
    opacity: number;
    transition?: string;
  },
] {
  const containerRef = useRef<T | null>(null);
  const [ind, setInd] = useState({ left: 0, width: 0, visible: false });
  const [snap, setSnap] = useState(false);
  const prevActiveKey = useRef(activeKey);

  useEffect(() => {
    if (!containerRef.current) return;
    // Same key + new extraDeps → reorder / layout shift, not a switch.
    // Snap so the pill teleports to the new active-tab position rather
    // than dragging across the tabs in between.
    const isReorder = activeKey === prevActiveKey.current;
    prevActiveKey.current = activeKey;
    const raf = requestAnimationFrame(() => {
      const container = containerRef.current;
      if (!container) return;
      const el = container.querySelector<HTMLElement>(activeSelector);
      if (!el) {
        setInd((p) => ({ ...p, visible: false }));
        return;
      }
      if (isReorder) {
        setSnap(true);
        setInd({ left: el.offsetLeft, width: el.offsetWidth, visible: true });
        // Restore the default transition on the next frame — the snap
        // render has now committed, so any subsequent position change
        // (e.g. a click-driven switch) animates normally again.
        requestAnimationFrame(() => setSnap(false));
      } else {
        setInd({ left: el.offsetLeft, width: el.offsetWidth, visible: true });
      }
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, activeSelector, ...extraDeps]);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => {
      const container = containerRef.current;
      if (!container) return;
      const el = container.querySelector<HTMLElement>(activeSelector);
      if (el) setInd({ left: el.offsetLeft, width: el.offsetWidth, visible: true });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [activeSelector]);

  const style = {
    transform: `translateX(${ind.left}px)`,
    width: ind.width,
    opacity: ind.visible ? 1 : 0,
    ...(snap ? { transition: 'none' as const } : {}),
  };
  return [containerRef, style] as const;
}
