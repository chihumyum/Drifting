import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { GraphEdgeGeometry } from './graph-edge-geometry';
import { createGraphGeometryScheduler } from './graph-geometry-scheduler';

interface MeasuredGraphOptions<T extends GraphEdgeGeometry> {
  measure(): T[];
  equals(a: readonly T[], b: readonly T[]): boolean;
  /** Layout/filter changes may move or unmount endpoints without changing edges. */
  revision: unknown;
  animationWindowMs: number;
  layerRef: RefObject<SVGSVGElement | null>;
  panningRef: RefObject<boolean>;
  viewportRef: RefObject<HTMLElement | null>;
  panEndEvent?: string;
}

/** Own geometry and subscriptions inside the line layer, never the card tree. */
export function useMeasuredGraphEdges<T extends GraphEdgeGeometry>({ measure, equals, revision, animationWindowMs, layerRef, panningRef,
  viewportRef, panEndEvent }: MeasuredGraphOptions<T>) {
  const [geometry, setGeometry] = useState<T[]>([]);
  const committed = useRef(geometry);
  const active = useRef<symbol | null>(null);
  const published = useRef<{ value: T[]; generation: symbol } | null>(null);

  useLayoutEffect(() => {
    const generation = Symbol('graph-geometry');
    active.current = generation;
    // Keep the old lines hidden until a fresh measurement has reached the DOM.
    layerRef.current?.setAttribute('data-panning', '1');
    let observedViewport: HTMLElement | null = null;
    const observer = new ResizeObserver(() => scheduler.invalidate());
    const scheduler = createGraphGeometryScheduler(() => {
      // A child layout effect can run before its parent DOM ref attaches.
      // Bind at the first frame, once all refs from the commit are available.
      if (observedViewport !== viewportRef.current) {
        if (observedViewport) observer.disconnect();
        observedViewport = viewportRef.current;
        if (observedViewport) observer.observe(observedViewport);
      }
      if (panningRef.current) return;
      const next = measure();
      const previous = published.current?.value ?? committed.current;
      if (equals(previous, next)) {
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
    return () => {
      active.current = null;
      scheduler.dispose(); observer.disconnect();
      window.removeEventListener('scroll', scheduler.invalidate, true);
      window.removeEventListener('resize', scheduler.invalidate);
      if (panEndEvent) window.removeEventListener(panEndEvent, scheduler.invalidate);
    };
  }, [measure, equals, revision, animationWindowMs, layerRef, panningRef, viewportRef, panEndEvent]);

  useLayoutEffect(() => {
    committed.current = geometry;
    if (!panningRef.current && published.current?.generation === active.current && published.current?.value === geometry) {
      layerRef.current?.removeAttribute('data-panning');
    }
  }, [geometry, layerRef, panningRef]);
  return geometry;
}
