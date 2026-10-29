import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { flowGlassSelection, restGlassWave } from '../lib/glass-wave';
import { PRESS_WINDOW_MS } from '../lib/motion';

/** The element matching `group` that holds both items' wave layers, if they share one. */
export function sharedWaveGroup(container: HTMLElement, from: string, to: string, group: string) {
  const groupOf = (key: string) => [...container.querySelectorAll<HTMLElement>('.glass-wave[data-wave-key]')]
    .find((layer) => layer.dataset.waveKey === key)?.closest<HTMLElement>(group) ?? null;
  const target = groupOf(to);
  return target && target === groupOf(from) ? target : null;
}

/**
 * Flows the selected glass from the previous item to the new one whenever
 * `activeKey` changes inside `containerRef` (see lib/glass-wave.ts). Runs
 * before paint so the new item never shows its own bleed ahead of the band.
 * While `enabled` is false (the items are not on screen) nothing moves.
 * With `group`, the items sit in several rows (the bottom timeline's lanes):
 * the band only flows along a row, and a selection that changes rows lets
 * the old item fade where it is while the new one lights in place.
 */
export function useGlassWave(
  containerRef: RefObject<HTMLElement | null>,
  activeKey: string | null,
  enabled: boolean,
  group?: string,
) {
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
    if (!from || !activeKey || from === activeKey) return;
    const row = group ? sharedWaveGroup(container, from, activeKey, group) : container;
    if (!row) return;
    const press = pressed.current;
    const byPress = Boolean(press && press.key === activeKey && performance.now() - press.at < PRESS_WINDOW_MS);
    flowGlassSelection(row, from, activeKey, byPress);
  }, [activeKey, enabled, containerRef, group]);

  useEffect(() => {
    const container = containerRef.current;
    return () => {
      if (container) restGlassWave(container);
    };
  }, [containerRef]);
}
