import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { flowGlassSelection, restGlassWave } from '../lib/glass-wave';

// A press counts toward the selection it makes for this long.
const PRESS_WINDOW_MS = 1500;

/**
 * Flows the selected glass from the previous item to the new one whenever
 * `activeKey` changes inside `containerRef` (see lib/glass-wave.ts). Runs
 * before paint so the new item never shows its own bleed ahead of the band.
 * While `enabled` is false (the items are not on screen) nothing moves.
 */
export function useGlassWave(containerRef: RefObject<HTMLElement | null>, activeKey: string | null, enabled: boolean) {
  const previous = useRef(activeKey);
  // The item last pressed, so a selection made by pressing it goes straight
  // from held-down to selected instead of waiting for the band.
  const pressed = useRef<{ key: string; at: number } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const item = event.target instanceof Element ? event.target.closest('.glass') : null;
      const key = item?.querySelector<HTMLElement>(':scope > .glass-wave[data-wave-key]')?.dataset.waveKey;
      pressed.current = key ? { key, at: performance.now() } : null;
    };
    container.addEventListener('pointerdown', onPointerDown, true);
    return () => container.removeEventListener('pointerdown', onPointerDown, true);
  }, [containerRef]);

  useLayoutEffect(() => {
    const from = previous.current;
    previous.current = activeKey;
    const container = containerRef.current;
    if (!container) return;
    if (!enabled) {
      restGlassWave(container);
      return;
    }
    const press = pressed.current;
    const byPress = Boolean(press && press.key === activeKey && performance.now() - press.at < PRESS_WINDOW_MS);
    if (from && activeKey && from !== activeKey) flowGlassSelection(container, from, activeKey, byPress);
  }, [activeKey, enabled, containerRef]);

  useEffect(() => {
    const container = containerRef.current;
    return () => {
      if (container) restGlassWave(container);
    };
  }, [containerRef]);
}
