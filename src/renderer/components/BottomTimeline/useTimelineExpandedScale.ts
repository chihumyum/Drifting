import { useEffect, useRef, useState } from 'react';

export const EXPANDED_ZOOM_CONFIG = {
  MIN_SCALE: 0.5,
  MAX_SCALE: 3,
  WHEEL_SENSITIVITY: 0.002,
  STORAGE_KEY: 'timeline-expanded-scale',
};

export type TimelineScaleAxis = 'x' | 'y';

interface UseTimelineExpandedScaleParams {
  isExpanded: boolean;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  /**
   * Which scroll axis the pinch anchors. The desktop track scrolls
   * horizontally; the mobile vertical axis scrolls the same coordinate space
   * downwards. Defaults to 'x'.
   */
  axis?: TimelineScaleAxis;
  /** Separate persisted scale per presentation (1.0 means different pixel densities). */
  storageKey?: string;
}

/** Keep the content under the pinch midpoint stationary while the scale changes. */
export function timelinePinchAnchoredScrollOffset(input: {
  anchorContent: number;
  nextScale: number;
  midpointClient: number;
  containerStart: number;
  maxScroll: number;
}) {
  const localMidpoint = input.midpointClient - input.containerStart;
  const desired = input.anchorContent * input.nextScale - localMidpoint;
  return Math.min(Math.max(0, input.maxScroll), Math.max(0, desired));
}

export function timelinePinchAnchoredScrollLeft(input: {
  anchorContentX: number;
  nextScale: number;
  midpointClientX: number;
  containerLeft: number;
  maxScrollLeft: number;
}) {
  return timelinePinchAnchoredScrollOffset({
    anchorContent: input.anchorContentX,
    nextScale: input.nextScale,
    midpointClient: input.midpointClientX,
    containerStart: input.containerLeft,
    maxScroll: input.maxScrollLeft,
  });
}

function clampExpandedScaleValue(scale: number) {
  return Math.min(EXPANDED_ZOOM_CONFIG.MAX_SCALE, Math.max(EXPANDED_ZOOM_CONFIG.MIN_SCALE, scale));
}

function getInitialExpandedScale(storageKey: string) {
  const savedScale = localStorage.getItem(storageKey);
  if (!savedScale) return 1;
  const parsed = Number.parseFloat(savedScale);
  if (!Number.isFinite(parsed)) return 1;
  return clampExpandedScaleValue(parsed);
}

export function useTimelineExpandedScale({
  isExpanded,
  scrollContainerRef,
  axis = 'x',
  storageKey = EXPANDED_ZOOM_CONFIG.STORAGE_KEY,
}: UseTimelineExpandedScaleParams) {
  const [expandedScale, setExpandedScale] = useState(() => getInitialExpandedScale(storageKey));
  const pinchStateRef = useRef<{
    startDistance: number;
    startScale: number;
    anchorContent: number;
  } | null>(null);
  const pinchScrollFrameRef = useRef(0);

  useEffect(
    () => () => {
      if (pinchScrollFrameRef.current) cancelAnimationFrame(pinchScrollFrameRef.current);
    },
    [],
  );

  useEffect(() => {
    localStorage.setItem(storageKey, expandedScale.toString());
  }, [expandedScale, storageKey]);

  // Use a non-passive native wheel listener so preventDefault works for trackpad pinch zoom.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleWheel = (event: WheelEvent) => {
      // 收起态固定自动缩放，不允许手动缩放
      if (!isExpanded) return;
      // Trackpad pinch 通常会带 ctrlKey；同时兼容 meta+wheel
      if (!event.ctrlKey && !event.metaKey) return;

      event.preventDefault();
      const zoomFactor = Math.exp(-event.deltaY * EXPANDED_ZOOM_CONFIG.WHEEL_SENSITIVITY);
      setExpandedScale((prev) => clampExpandedScaleValue(prev * zoomFactor));
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      container.removeEventListener('wheel', handleWheel);
    };
  }, [isExpanded, scrollContainerRef]);

  const getTouchDistance = (touches: React.TouchList): number => {
    if (touches.length < 2) return 0;
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  };

  const getTouchMidpoint = (touches: React.TouchList): number =>
    touches.length < 2
      ? 0
      : axis === 'x'
        ? (touches[0].clientX + touches[1].clientX) / 2
        : (touches[0].clientY + touches[1].clientY) / 2;

  const containerStart = (container: HTMLElement) => {
    const rect = container.getBoundingClientRect();
    return axis === 'x' ? rect.left : rect.top;
  };
  const scrollOffset = (container: HTMLElement) =>
    axis === 'x' ? container.scrollLeft : container.scrollTop;
  const maxScroll = (container: HTMLElement) =>
    axis === 'x'
      ? container.scrollWidth - container.clientWidth
      : container.scrollHeight - container.clientHeight;

  const handleTimelineTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!isExpanded || e.touches.length < 2) return;
    const startDistance = getTouchDistance(e.touches);
    const container = scrollContainerRef.current;
    if (startDistance <= 0 || !container) return;
    const localMidpoint = getTouchMidpoint(e.touches) - containerStart(container);
    pinchStateRef.current = {
      startDistance,
      startScale: expandedScale,
      anchorContent: (scrollOffset(container) + localMidpoint) / expandedScale,
    };
  };

  const handleTimelineTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!isExpanded || e.touches.length < 2 || !pinchStateRef.current) return;

    const currentDistance = getTouchDistance(e.touches);
    if (currentDistance <= 0 || pinchStateRef.current.startDistance <= 0) return;

    if (e.cancelable) {
      e.preventDefault();
    }

    const ratio = currentDistance / pinchStateRef.current.startDistance;
    const nextScale = pinchStateRef.current.startScale * ratio;
    const clampedScale = clampExpandedScaleValue(nextScale);
    const midpointClient = getTouchMidpoint(e.touches);
    setExpandedScale(clampedScale);
    if (pinchScrollFrameRef.current) cancelAnimationFrame(pinchScrollFrameRef.current);
    pinchScrollFrameRef.current = requestAnimationFrame(() => {
      pinchScrollFrameRef.current = 0;
      const container = scrollContainerRef.current;
      const pinch = pinchStateRef.current;
      if (!container || !pinch) return;
      const next = timelinePinchAnchoredScrollOffset({
        anchorContent: pinch.anchorContent,
        nextScale: clampedScale,
        midpointClient,
        containerStart: containerStart(container),
        maxScroll: maxScroll(container),
      });
      if (axis === 'x') container.scrollLeft = next;
      else container.scrollTop = next;
    });
  };

  const handleTimelineTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length < 2) {
      pinchStateRef.current = null;
      if (pinchScrollFrameRef.current) cancelAnimationFrame(pinchScrollFrameRef.current);
      pinchScrollFrameRef.current = 0;
    }
  };

  return {
    expandedScale,
    setExpandedScale: (next: number) => setExpandedScale(clampExpandedScaleValue(next)),
    touchHandlers: {
      onTouchStart: handleTimelineTouchStart,
      onTouchMove: handleTimelineTouchMove,
      onTouchEnd: handleTimelineTouchEnd,
      onTouchCancel: handleTimelineTouchEnd,
    },
  };
}
