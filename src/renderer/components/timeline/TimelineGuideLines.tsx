import { useSyncExternalStore } from 'react';
import type { TimelineMarker } from '../../domain/timeline-marker';
import type { TimelineDragPreview } from '../../features/graph/timeline-drag-preview';

interface GuideProps {
  preview: TimelineDragPreview;
  className: string;
  xOffset?: number;
  height?: number;
  ariaHidden?: boolean;
}

/** Geometry updates stay below the chapter/card tree. Coordinates belong to the host. */
export function TimelineMarkerLines({ preview, markers, orderToPosition, className,
  xOffset = 0, height, onlyDragging = false, ariaHidden,
}: GuideProps & { markers: readonly TimelineMarker[]; orderToPosition: (order: number) => number; onlyDragging?: boolean }) {
  const { markerXs } = useSyncExternalStore(preview.subscribe, preview.getSnapshot, preview.getSnapshot);
  return markers.map((marker) => {
    const dragX = markerXs[marker.id];
    if (onlyDragging && dragX === undefined) return null;
    return <div key={marker.id} className={`${className}${dragX !== undefined ? ' is-dragging' : ''}`}
      style={{ left: xOffset + (dragX ?? orderToPosition(marker.narrativeOrder)), height }} aria-hidden={ariaHidden} />;
  });
}

export function TimelineActDragLine({ preview, className, xOffset = 0, height, ariaHidden }: GuideProps) {
  const { actX } = useSyncExternalStore(preview.subscribe, preview.getSnapshot, preview.getSnapshot);
  return actX === null ? null : <div className={`${className} is-dragging`}
    style={{ left: xOffset + actX, height }} aria-hidden={ariaHidden} />;
}
