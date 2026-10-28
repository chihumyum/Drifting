import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { flowGlassSelection, restGlassWave } from '../lib/glass-wave';

/**
 * Flows the selected glass from the previous item to the new one whenever
 * `activeKey` changes inside `containerRef` (see lib/glass-wave.ts). Runs
 * before paint so the new item never shows its own bleed ahead of the band.
 * While `enabled` is false (the items are not on screen) nothing moves.
 */
export function useGlassWave(containerRef: RefObject<HTMLElement | null>, activeKey: string | null, enabled: boolean) {
  const previous = useRef(activeKey);

  useLayoutEffect(() => {
    const from = previous.current;
    previous.current = activeKey;
    const container = containerRef.current;
    if (!container) return;
    if (!enabled) {
      restGlassWave(container);
      return;
    }
    if (from && activeKey && from !== activeKey) flowGlassSelection(container, from, activeKey);
  }, [activeKey, enabled, containerRef]);

  useEffect(() => {
    const container = containerRef.current;
    return () => {
      if (container) restGlassWave(container);
    };
  }, [containerRef]);
}
