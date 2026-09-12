import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { sameGraphEdgeGeometry, type GraphEdgeGeometry } from './graph-edge-geometry';
import { createGraphGeometryScheduler } from './graph-geometry-scheduler';

interface MeasuredGraphOptions {
  measure(): GraphEdgeGeometry[];
  /** Layout/filter changes may move or unmount endpoints without changing edges. */
  revision: unknown;
  animationWindowMs: number;
  layerRef: RefObject<SVGSVGElement | null>;
  panningRef: RefObject<boolean>;
  viewportRef: RefObject<HTMLElement | null>;
  panEndEvent?: string;
}

/** Own geometry and subscriptions inside the line layer, never the card tree. */
export function useMeasuredGraphEdges({ measure, revision, animationWindowMs, layerRef, panningRef,
  viewportRef, panEndEvent }: MeasuredGraphOptions) {
  const [geometry, setGeometry] = useState<GraphEdgeGeometry[]>([]);
  const committed = useRef(geometry);
  const active = useRef<symbol | null>(null);
  const published = useRef<{ value: GraphEdgeGeometry[]; generation: symbol } | null>(null);

  useLayoutEffect(() => {
    const generation = Symbol('graph-geometry');
    active.current = generation;
    // Keep the old lines hidden until a fresh measurement has reached the DOM.
    layerRef.current?.setAttribute('data-panning', '1');
    const scheduler = createGraphGeometryScheduler(() => {
      if (panningRef.current) return;
      const next = measure();
      const previous = published.current?.value ?? committed.current;
      if (sameGraphEdgeGeometry(previous, next)) {
        published.current = { value: previous, generation };
        if (committed.current === previous) layerRef.current?.removeAttribute('data-panning');
      } else {
        published.current = { value: next, generation };
        setGeometry(next);
      }
    }, animationWindowMs);
    window.addEventListener('scroll', scheduler.invalidate, true);
    window.addEventListener('resize', scheduler.invalidate);
    if (panEndEvent) window.addEventListener(panEndEvent, scheduler.invalidate);
    const observer = new ResizeObserver(scheduler.invalidate);
    if (viewportRef.current) observer.observe(viewportRef.current);
    return () => {
      active.current = null;
      scheduler.dispose(); observer.disconnect();
      window.removeEventListener('scroll', scheduler.invalidate, true);
      window.removeEventListener('resize', scheduler.invalidate);
      if (panEndEvent) window.removeEventListener(panEndEvent, scheduler.invalidate);
    };
  }, [measure, revision, animationWindowMs, layerRef, panningRef, viewportRef, panEndEvent]);

  useLayoutEffect(() => {
    committed.current = geometry;
    if (!panningRef.current && published.current?.generation === active.current && published.current?.value === geometry) {
      layerRef.current?.removeAttribute('data-panning');
    }
  }, [geometry, layerRef, panningRef]);
  return geometry;
}
