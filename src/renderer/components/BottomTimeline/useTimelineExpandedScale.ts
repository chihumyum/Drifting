import { useEffect, useRef, useState } from 'react';

export const EXPANDED_ZOOM_CONFIG = {
  MIN_SCALE: 0.5,
  MAX_SCALE: 3,
  WHEEL_SENSITIVITY: 0.002,
  STORAGE_KEY: 'timeline-expanded-scale',
};

interface UseTimelineExpandedScaleParams {
  isExpanded: boolean;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
}

function clampExpandedScaleValue(scale: number) {
  return Math.min(EXPANDED_ZOOM_CONFIG.MAX_SCALE, Math.max(EXPANDED_ZOOM_CONFIG.MIN_SCALE, scale));
}

function getInitialExpandedScale() {
  const savedScale = localStorage.getItem(EXPANDED_ZOOM_CONFIG.STORAGE_KEY);
  if (!savedScale) return 1;
  const parsed = Number.parseFloat(savedScale);
  if (!Number.isFinite(parsed)) return 1;
  return clampExpandedScaleValue(parsed);
}

export function useTimelineExpandedScale({
  isExpanded,
  scrollContainerRef,
}: UseTimelineExpandedScaleParams) {
  const [expandedScale, setExpandedScale] = useState(getInitialExpandedScale);
  const pinchStateRef = useRef<{ startDistance: number; startScale: number } | null>(null);

  useEffect(() => {
    localStorage.setItem(EXPANDED_ZOOM_CONFIG.STORAGE_KEY, expandedScale.toString());
  }, [expandedScale]);

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

  const handleTimelineTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!isExpanded || e.touches.length < 2) return;
    const startDistance = getTouchDistance(e.touches);
    if (startDistance <= 0) return;
    pinchStateRef.current = { startDistance, startScale: expandedScale };
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
    setExpandedScale(clampExpandedScaleValue(nextScale));
  };

  const handleTimelineTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length < 2) {
      pinchStateRef.current = null;
    }
  };

  return {
    expandedScale,
    touchHandlers: {
      onTouchStart: handleTimelineTouchStart,
      onTouchMove: handleTimelineTouchMove,
      onTouchEnd: handleTimelineTouchEnd,
      onTouchCancel: handleTimelineTouchEnd,
    },
  };
}
