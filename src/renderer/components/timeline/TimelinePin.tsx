import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { TimelineMarker } from '../../domain/timeline-marker';
import { TimelinePinMenu } from '../graph/TimelinePinMenu';

export interface TimelinePinAnchor {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TimelinePinProps {
  marker: TimelineMarker;
  snapValues: number[];
  orderToPosition: (order: number) => number;
  variant: 'bottom' | 'graph';
  xOffset?: number;
  pinHeight: number;
  isDragging: boolean;
  editOnMount?: boolean;
  onChange: (
    patch: Partial<Pick<TimelineMarker, 'narrativeOrder' | 'label' | 'driftNodeId'>>,
  ) => void;
  onDelete: () => void;
  onDragMove: (nextPixelX: number | null) => void;
  boundDriftTitle?: string | null;
  onRequestBind?: () => void;
  onOpenDrift?: (anchor?: TimelinePinAnchor) => void;
}

/**
 * Shared narrative-time marker used by both BottomTimeline and StoryGraph.
 * The two surfaces own their coordinate systems and CSS, while drag, snap,
 * rename, drift binding, keyboard, and context-menu behavior stay singular.
 */
export function TimelinePin({
  marker,
  snapValues,
  orderToPosition,
  variant,
  xOffset = 0,
  pinHeight,
  isDragging,
  editOnMount = false,
  onChange,
  onDelete,
  onDragMove,
  boundDriftTitle = null,
  onRequestBind,
  onOpenDrift,
}: TimelinePinProps) {
  const { t } = useTranslation();
  const isBound = Boolean(marker.driftNodeId);
  const [editing, setEditing] = useState(editOnMount && !isBound);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const classPrefix = variant === 'graph' ? 'graph-pin' : 'btl-pin';
  const x = xOffset + orderToPosition(marker.narrativeOrder);

  const openBoundDrift = useCallback(
    (fallback?: TimelinePinAnchor) => {
      if (!isBound || !onOpenDrift) return;
      const rect = labelRef.current?.getBoundingClientRect();
      onOpenDrift(
        rect
          ? {
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height,
            }
          : fallback,
      );
    },
    [isBound, onOpenDrift],
  );

  const startDrag = useCallback(
    (event: ReactMouseEvent) => {
      if (event.button !== 0 || editing || snapValues.length === 0) return;
      event.preventDefault();
      event.stopPropagation();

      const startMouseX = event.clientX;
      const startPixel = orderToPosition(marker.narrativeOrder);
      let nearest = marker.narrativeOrder;
      let dragging = false;

      const onMove = (moveEvent: MouseEvent) => {
        const dx = moveEvent.clientX - startMouseX;
        if (!dragging && Math.abs(dx) < 4) return;
        dragging = true;

        const newPixel = startPixel + dx;
        let best = snapValues[0];
        let bestDistance = Number.POSITIVE_INFINITY;
        for (const snapValue of snapValues) {
          const distance = Math.abs(orderToPosition(snapValue) - newPixel);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = snapValue;
          }
        }
        nearest = best;
        onDragMove(newPixel);
      };

      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        if (!dragging) {
          openBoundDrift();
          return;
        }
        onDragMove(null);
        if (nearest !== marker.narrativeOrder) {
          onChange({ narrativeOrder: nearest });
        }
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [
      editing,
      marker.narrativeOrder,
      onChange,
      onDragMove,
      openBoundDrift,
      orderToPosition,
      snapValues,
    ],
  );

  useEffect(() => {
    if (!editing || !labelRef.current) return;
    labelRef.current.focus();
    const range = document.createRange();
    range.selectNodeContents(labelRef.current);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, [editing]);

  const handleUnbind = useCallback(() => {
    onChange({
      driftNodeId: null,
      label: marker.label.trim()
        ? marker.label
        : (boundDriftTitle ?? t('bottomTimeline.marker.defaultLabel')),
    });
  }, [boundDriftTitle, marker.label, onChange, t]);

  const className = [
    classPrefix,
    isDragging ? 'is-dragging' : '',
    editing ? 'is-editing' : '',
    isBound ? 'is-bound' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const displayLabel = isBound ? (boundDriftTitle || t('common.untitled')) : marker.label;

  return (
    <div
      className={className}
      style={{ left: x, height: pinHeight }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setMenu({ x: event.clientX + 2, y: event.clientY - 2 });
      }}
    >
      <div
        ref={labelRef}
        className={`${classPrefix}__label`}
        contentEditable={editing}
        suppressContentEditableWarning
        onMouseDown={editing ? (event) => event.stopPropagation() : startDrag}
        onDoubleClick={(event) => {
          event.stopPropagation();
          if (!isBound && !editing) setEditing(true);
        }}
        onBlur={(event) => {
          if (isBound) return;
          const text = (event.currentTarget.textContent ?? '').trim();
          setEditing(false);
          if (!text) onDelete();
          else if (text !== marker.label) onChange({ label: text });
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.currentTarget.textContent = marker.label;
            event.currentTarget.blur();
          }
        }}
        title={
          isBound
            ? t('bottomTimeline.marker.boundTitle')
            : editing
              ? t('bottomTimeline.marker.editingTitle')
              : t('bottomTimeline.marker.renameTitle')
        }
      >
        {displayLabel}
      </div>
      <div
        className={`${classPrefix}__line`}
        onMouseDown={startDrag}
        title={t('bottomTimeline.marker.dragTitle')}
      />
      {menu && (
        <TimelinePinMenu
          x={menu.x}
          y={menu.y}
          isBound={isBound}
          onOpenDrift={() =>
            openBoundDrift({ left: menu.x, top: menu.y, width: 0, height: 0 })
          }
          onUnbind={handleUnbind}
          onRequestBind={() => onRequestBind?.()}
          onRename={() => setEditing(true)}
          onDelete={onDelete}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
