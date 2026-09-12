import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { TimelineMarker } from '../../domain/timeline-marker';
import { MOBILE_PLANNING_CONTEXT_MENU_MS } from '../../features/graph/mobile-planning-gesture';
import { TimelinePinMenu } from '../graph/TimelinePinMenu';

export interface TimelinePinAnchor {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TimelinePinProps {
  marker: TimelineMarker;
  orderToPosition: (order: number) => number;
  positionToOrder: (position: number) => number;
  variant: 'bottom' | 'graph';
  xOffset?: number;
  pinHeight: number;
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
 * The two surfaces own their coordinate systems and CSS, while drag,
 * rename, drift binding, keyboard, and context-menu behavior stay singular.
 */
export function TimelinePin({
  marker,
  orderToPosition,
  positionToOrder,
  variant,
  xOffset = 0,
  pinHeight,
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
  const [isDragging, setIsDragging] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const dragCleanupRef = useRef<((updateState?: boolean) => void) | null>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const classPrefix = variant === 'graph' ? 'graph-pin' : 'btl-pin';
  const x = xOffset + orderToPosition(marker.narrativeOrder);

  useLayoutEffect(() => () => dragCleanupRef.current?.(false), []);

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
    (event: ReactPointerEvent) => {
      if (event.button !== 0 || editing) return;
      event.preventDefault();
      event.stopPropagation();
      dragCleanupRef.current?.();

      const startMouseX = event.clientX;
      const startPixel = orderToPosition(marker.narrativeOrder);
      const pointerId = event.pointerId;
      const menuPoint = { x: event.clientX + 2, y: event.clientY - 2 };
      let nextOrder = marker.narrativeOrder;
      let dragging = false;
      let ended = false;
      let longPressed = false;
      let longPressTimer: number | null =
        event.pointerType === 'touch'
          ? window.setTimeout(() => {
              longPressed = true;
              setMenu(menuPoint);
            }, MOBILE_PLANNING_CONTEXT_MENU_MS)
          : null;

      const clearLongPress = () => {
        if (longPressTimer === null) return;
        window.clearTimeout(longPressTimer);
        longPressTimer = null;
      };

      const onMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId || longPressed) return;
        const dx = moveEvent.clientX - startMouseX;
        if (!dragging && Math.abs(dx) < 4) return;
        clearLongPress();
        if (!dragging) setIsDragging(true);
        dragging = true;

        nextOrder = positionToOrder(startPixel + dx);
        onDragMove(orderToPosition(nextOrder));
      };

      const cleanup = (updateState = true) => {
        if (ended) return;
        ended = true;
        clearLongPress();
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('blur', onBlur);
        if (dragCleanupRef.current === cleanup) dragCleanupRef.current = null;
        if (dragging) {
          if (updateState) setIsDragging(false);
          onDragMove(null);
        }
      };
      const onUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;
        cleanup();
        if (longPressed) return;
        if (!dragging) {
          openBoundDrift();
          return;
        }
        if (nextOrder !== marker.narrativeOrder) {
          onChange({ narrativeOrder: nextOrder });
        }
      };
      const onCancel = (cancelEvent: PointerEvent) => {
        if (cancelEvent.pointerId !== pointerId) return;
        cleanup();
      };
      const onBlur = () => cleanup();

      dragCleanupRef.current = cleanup;
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      window.addEventListener('blur', onBlur);
    },
    [
      editing,
      marker.narrativeOrder,
      onChange,
      onDragMove,
      openBoundDrift,
      orderToPosition,
      positionToOrder,
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
  const displayLabel = isBound ? boundDriftTitle || t('common.untitled') : marker.label;

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
        onPointerDown={editing ? (event) => event.stopPropagation() : startDrag}
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
        onPointerDown={startDrag}
        title={t('bottomTimeline.marker.dragTitle')}
      />
      {menu && (
        <TimelinePinMenu
          x={menu.x}
          y={menu.y}
          isBound={isBound}
          onOpenDrift={() => openBoundDrift({ left: menu.x, top: menu.y, width: 0, height: 0 })}
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
