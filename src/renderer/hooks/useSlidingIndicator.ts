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
export function useSlidingIndicator<T extends HTMLElement = HTMLDivElement>(
  activeKey: unknown,
  activeSelector: string = '.is-active',
  extraDeps: unknown[] = [],
): readonly [
  React.RefObject<T | null>,
  { transform: string; width: number; opacity: number },
] {
  const containerRef = useRef<T | null>(null);
  const [ind, setInd] = useState({ left: 0, width: 0, visible: false });

  useEffect(() => {
    if (!containerRef.current) return;
    const raf = requestAnimationFrame(() => {
      const container = containerRef.current;
      if (!container) return;
      const el = container.querySelector<HTMLElement>(activeSelector);
      if (!el) {
        setInd((p) => ({ ...p, visible: false }));
        return;
      }
      setInd({ left: el.offsetLeft, width: el.offsetWidth, visible: true });
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
  };
  return [containerRef, style] as const;
}
