import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import { paintStrip, sandMaskURL } from '../../lib/sand-heat';

const STRIP_HEIGHT = 20;

/**
 * A book's last days on its card (docs/writing-days.md): one upright sand
 * stroke per day written, as tall as its share of the busiest of them, and a
 * few loose grains for each day without words. In ink, like the progress
 * stroke under it.
 */
export function SandStrip({ daily, seed, label }: { daily: readonly number[]; seed: number; label: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const measure = () => setWidth(Math.round(element.clientWidth));
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const key = daily.join(',');
  const mask = useMemo(() => {
    if (width <= 0) return null;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    return sandMaskURL(paintStrip(daily, width, STRIP_HEIGHT, dpr, seed));
  }, [key, width, seed]); // eslint-disable-line react-hooks/exhaustive-deps -- `key` stands for the days' values
  return (
    <div ref={ref} className="pp-strip" role="img" aria-label={label}>
      {mask && <i className="sand pp-strip__sand" style={{ '--sand-mask': `url(${mask})` } as CSSProperties} />}
    </div>
  );
}
