import { useCallback, useEffect, useRef, useState } from 'react';
import { clampLibraryItemPreviewScale } from './library-item-media';

export interface MediaViewport {
  scale: number;
  panX: number;
  panY: number;
}

const IDENTITY_VIEWPORT: MediaViewport = { scale: 1, panX: 0, panY: 0 };

function zoomViewportAt(
  prev: MediaViewport,
  scale: number,
  anchorFromCenterX: number,
  anchorFromCenterY: number,
): MediaViewport {
  if (scale === prev.scale) return prev;
  // At or below fit size the media is smaller than the surface: keep the
  // scale but re-centre, there is nothing to pan to.
  if (scale <= 1) return { scale, panX: 0, panY: 0 };
  const ratio = scale / prev.scale;
  return {
    scale,
    panX: ratio * prev.panX + (1 - ratio) * anchorFromCenterX,
    panY: ratio * prev.panY + (1 - ratio) * anchorFromCenterY,
  };
}

/**
 * Trackpad/mouse zoom and pan for one surface. ⌘/Ctrl+wheel (and pinch, which
 * WebKit reports as ctrl+wheel) zooms around the pointer; plain wheel pans
 * once zoomed in; dragging pans. `suppressNextClick` tells click handlers a
 * drag just ended.
 */
export function useZoomPanSurface(surface: HTMLElement | null, enabled: boolean) {
  const [viewport, setViewport] = useState<MediaViewport>(IDENTITY_VIEWPORT);
  const [dragging, setDragging] = useState(false);
  const viewportRef = useRef(viewport);
  const frameRef = useRef<number | null>(null);
  const queuedRef = useRef<MediaViewport | null>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; panX: number; panY: number } | null>(null);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);

  const applyQueued = useCallback(() => {
    frameRef.current = null;
    const queued = queuedRef.current;
    queuedRef.current = null;
    if (queued) setViewport(queued);
  }, []);

  const queueUpdate = useCallback(
    (update: (current: MediaViewport) => MediaViewport) => {
      // The ref is the authoritative in-progress gesture state. React may batch
      // several trackpad wheel events before rendering, so deriving the next
      // delta from rendered state makes zoom and pan appear to jump backwards.
      const next = update(viewportRef.current);
      if (next === viewportRef.current) return;
      viewportRef.current = next;
      queuedRef.current = next;
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(applyQueued);
    },
    [applyQueued],
  );

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      queuedRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!surface || !enabled) return;
    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        const zoomFactor = Math.exp(-event.deltaY * 0.002);
        const rect = surface.getBoundingClientRect();
        const anchorX = event.clientX - rect.left - rect.width / 2;
        const anchorY = event.clientY - rect.top - rect.height / 2;
        queueUpdate((prev) =>
          zoomViewportAt(prev, clampLibraryItemPreviewScale(prev.scale * zoomFactor), anchorX, anchorY),
        );
        return;
      }
      if (viewportRef.current.scale <= 1) return;
      event.preventDefault();
      event.stopPropagation();
      queueUpdate((prev) => ({ ...prev, panX: prev.panX - event.deltaX, panY: prev.panY - event.deltaY }));
    };
    surface.addEventListener('wheel', handleWheel, { passive: false });
    return () => surface.removeEventListener('wheel', handleWheel);
  }, [enabled, queueUpdate, surface]);

  const reset = useCallback(() => {
    viewportRef.current = IDENTITY_VIEWPORT;
    queuedRef.current = null;
    setViewport(IDENTITY_VIEWPORT);
  }, []);

  // Discrete (button) zoom applies at once; only gesture streams are batched
  // per frame, and frames do not run while the window is occluded.
  const zoomBy = useCallback((factor: number) => {
    const current = viewportRef.current;
    const next = zoomViewportAt(current, clampLibraryItemPreviewScale(current.scale * factor), 0, 0);
    if (next === current) return;
    viewportRef.current = next;
    queuedRef.current = null;
    setViewport(next);
  }, []);

  const pointerHandlers = {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      if (!enabled || event.button !== 0) return;
      pointerStartRef.current = { x: event.clientX, y: event.clientY };
      suppressClickRef.current = false;
      const current = viewportRef.current;
      if (current.scale <= 1) return;
      event.preventDefault();
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        panX: current.panX,
        panY: current.panY,
      };
      setDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
      const start = pointerStartRef.current;
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 3) {
        suppressClickRef.current = true;
      }
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      queueUpdate((current) => ({
        ...current,
        panX: drag.panX + event.clientX - drag.startX,
        panY: drag.panY + event.clientY - drag.startY,
      }));
    },
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => endPointer(event),
    onPointerCancel: (event: React.PointerEvent<HTMLElement>) => endPointer(event),
  };

  function endPointer(event: React.PointerEvent<HTMLElement>) {
    pointerStartRef.current = null;
    const drag = dragRef.current;
    if (drag?.pointerId === event.pointerId) {
      dragRef.current = null;
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      applyQueued();
      setDragging(false);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  const consumeClickSuppression = useCallback(() => {
    const suppressed = suppressClickRef.current;
    suppressClickRef.current = false;
    return suppressed;
  }, []);

  return { viewport, dragging, pointerHandlers, reset, zoomBy, consumeClickSuppression };
}
