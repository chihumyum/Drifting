import { useLayoutEffect, useRef, type ReactNode } from 'react';

/** Keep complete lines inside the rail's actual height, including UI text sizing. */
export function StorylineRailLabel({
  mark,
  name,
  count,
  wrap,
  rowHeight,
}: {
  mark?: ReactNode;
  name: string;
  count: string;
  wrap: boolean;
  rowHeight: number;
}) {
  const mainRef = useRef<HTMLDivElement>(null);

  // Panel resizing already rerenders the timeline: measure before paint even
  // when WebKit pauses ResizeObserver delivery for a background window.
  useLayoutEffect(() => {
    const main = mainRef.current;
    const rail = main?.closest<HTMLElement>('.btl-rail');
    const label = main?.querySelector<HTMLElement>('.btl-rail__text');
    if (!wrap || !main || !rail || !label) return;

    const update = () => {
      const style = getComputedStyle(rail);
      const available = rail.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      const lineHeight = parseFloat(getComputedStyle(label).lineHeight);
      if (lineHeight > 0) {
        main.style.setProperty('--btl-rail-lines', String(Math.max(1, Math.floor(available / lineHeight))));
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(rail);
    // Font preferences and chapter-count width can also change the label's layout.
    observer.observe(label);
    return () => observer.disconnect();
  }, [wrap, rowHeight]);

  return (
    <div ref={mainRef} className="btl-rail__main">
      <div className="btl-rail__name">
        {mark}
        <span className="btl-rail__text">{name}</span>
      </div>
      <div className="btl-rail__count">{count}</div>
    </div>
  );
}
