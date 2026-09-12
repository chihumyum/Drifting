import { useCallback, useLayoutEffect, type RefObject } from 'react';
import { superElementBandTop, type GraphPoint } from './super-element-edge-model';
import { createGraphGeometryScheduler } from './graph-geometry-scheduler';

interface SuperElementTransformRefs {
  worldRef: RefObject<HTMLDivElement | null>;
  bandRef: RefObject<HTMLDivElement | null>;
  viewportRef: RefObject<HTMLDivElement | null>;
  panRef: RefObject<GraphPoint>;
  zoomRef: RefObject<number>;
  bandStickyRef: RefObject<boolean>;
  bandHeightCellsRef: RefObject<number>;
  bandTopWorldYRef: RefObject<number>;
  bandWorldLeftRef: RefObject<number>;
  cellHeight: number;
}

/** Keep gesture transforms imperative; container resize never sets React state. */
export function useSuperElementTransform({ worldRef, bandRef, viewportRef, panRef, zoomRef,
  bandStickyRef, bandHeightCellsRef, bandTopWorldYRef, bandWorldLeftRef, cellHeight,
}: SuperElementTransformRefs) {
  const applyTransform = useCallback(() => {
    const world = worldRef.current;
    if (!world) return;
    const { x, y } = panRef.current; const zoom = zoomRef.current;
    // Finish dimension reads before writing either transform.
    const band = bandRef.current;
    const viewport = viewportRef.current;
    const bandTop = bandStickyRef.current && band && viewport ? superElementBandTop(y + zoom * bandTopWorldYRef.current,
      bandHeightCellsRef.current * cellHeight * zoom, viewport.clientHeight, true) : null;
    world.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    if (band && bandTop !== null) {
      band.style.transform = `translate(${x + zoom * bandWorldLeftRef.current}px, ${bandTop}px) scale(${zoom})`;
    }
  }, [worldRef, bandRef, viewportRef, panRef, zoomRef, bandStickyRef, bandHeightCellsRef,
    bandTopWorldYRef, bandWorldLeftRef, cellHeight]);

  useLayoutEffect(() => {
    const scheduler = createGraphGeometryScheduler(applyTransform, 0);
    const observer = new ResizeObserver(scheduler.invalidate);
    if (viewportRef.current) observer.observe(viewportRef.current);
    return () => { observer.disconnect(); scheduler.dispose(); };
  }, [applyTransform, viewportRef]);
  return applyTransform;
}
