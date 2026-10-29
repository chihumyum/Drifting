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
import { useHoverPreview } from '../../features/entities/hover/entity-hover-card-model';
import {
  HoverCardHeading,
  HoverCardShell,
  type HoverAction,
  type HoverActionGroup,
} from '../ui/HoverCard';
import { KindMark } from '../ui/KindMark';

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
  /** Desktop Bottom Timeline: the label is a resting glass chip, still selected
      glass while it is renamed; a bound drift shows its own sand eddy. */
  glass?: boolean;
}

function anchorOf(element: HTMLElement): TimelinePinAnchor {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

/**
 * Shared narrative-time marker used by both BottomTimeline and StoryGraph.
 * The two surfaces own their coordinate systems and CSS, while drag,
 * rename, drift binding, keyboard, and hover-card behavior stay singular.
 * What a right-click menu used to offer is along the bottom of the label's
 * hover card; right-click itself shows the native menu.
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
  glass = false,
}: TimelinePinProps) {
  const { t } = useTranslation();
  const isBound = Boolean(marker.driftNodeId);
  const [editing, setEditing] = useState(editOnMount && !isBound);
  const [isDragging, setIsDragging] = useState(false);
  const {
    preview: pinCard,
    onEnter: pinCardEnter,
    onLeave: pinCardLeave,
    dismiss: dismissPinCard,
    open: openPinCard,
    card: pinCardPointer,
  } = useHoverPreview<string>();
  const dragCleanupRef = useRef<((updateState?: boolean) => void) | null>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const classPrefix = variant === 'graph' ? 'graph-pin' : 'btl-pin';
  const x = xOffset + orderToPosition(marker.narrativeOrder);

  useLayoutEffect(() => () => dragCleanupRef.current?.(false), []);

  const openBoundDrift = useCallback(() => {
    if (!isBound || !onOpenDrift) return;
    onOpenDrift(labelRef.current ? anchorOf(labelRef.current) : undefined);
  }, [isBound, onOpenDrift]);

  const startDrag = useCallback(
    (event: ReactPointerEvent) => {
      if (event.button !== 0 || editing) return;
      event.preventDefault();
      event.stopPropagation();
      dragCleanupRef.current?.();
      dismissPinCard();

      const startMouseX = event.clientX;
      const startPixel = orderToPosition(marker.narrativeOrder);
      const pointerId = event.pointerId;
      let nextOrder = marker.narrativeOrder;
      let dragging = false;
      let ended = false;
      let longPressed = false;
      // Touch has no hover: holding the pin opens its card.
      let longPressTimer: number | null =
        event.pointerType === 'touch'
          ? window.setTimeout(() => {
              longPressed = true;
              if (labelRef.current) openPinCard(marker.id, labelRef.current);
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
      dismissPinCard,
      editing,
      marker.id,
      marker.narrativeOrder,
      onChange,
      onDragMove,
      openBoundDrift,
      openPinCard,
      orderToPosition,
      positionToOrder,
    ],
  );

  // A card opened by a touch hold has no pointer leaving to close it, so a
  // press anywhere else does.
  useEffect(() => {
    if (!pinCard) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('.timeline-pin__card')) return;
      dismissPinCard();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [pinCard, dismissPinCard]);

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

  // What the pin's right-click menu used to offer, along its card's bottom.
  const pinCardActions = (label: HTMLElement): HoverActionGroup[] => {
    const actions: HoverAction[] = [];
    if (isBound) {
      if (onOpenDrift) {
        actions.push({
          key: 'open-drift',
          label: t('bottomTimeline.pinMenu.openDrift'),
          onSelect: () => onOpenDrift(anchorOf(label)),
        });
      }
      actions.push({
        key: 'unbind',
        label: t('bottomTimeline.pinMenu.unbind'),
        onSelect: handleUnbind,
      });
    } else {
      if (onRequestBind) {
        actions.push({
          key: 'bind',
          label: t('bottomTimeline.pinMenu.bindDrift'),
          onSelect: onRequestBind,
        });
      }
      actions.push({
        key: 'rename',
        label: t('bottomTimeline.pinMenu.rename'),
        onSelect: () => setEditing(true),
      });
    }
    return [
      { key: 'marker', actions },
      {
        key: 'delete',
        actions: [
          {
            key: 'delete',
            label: t('bottomTimeline.pinMenu.deleteMarker'),
            danger: true,
            onSelect: onDelete,
          },
        ],
      },
    ];
  };

  return (
    <div
      className={className}
      style={{ left: x, height: pinHeight }}
      // A double-click anywhere on the pin is not one on the empty axis the
      // host listens to for new markers.
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <div
        ref={labelRef}
        className={`${classPrefix}__label${glass ? ` glass glass--rest glass--small${editing ? ' is-on' : ''}` : ''}`}
        contentEditable={editing}
        suppressContentEditableWarning
        onMouseEnter={(event) => {
          // No card while renaming, or while a button is held (a drag).
          if (editing || event.buttons !== 0) return;
          pinCardEnter(marker.id, event.currentTarget);
        }}
        onMouseLeave={pinCardLeave}
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
        // At rest the hover card carries the hint; a native tooltip would
        // stack on it.
        title={editing ? t('bottomTimeline.marker.editingTitle') : undefined}
      >
        {glass && isBound && <KindMark kind="drift" color="hsl(var(--accent))" />}
        {displayLabel}
      </div>
      <div
        className={`${classPrefix}__line`}
        onPointerDown={startDrag}
        title={t('bottomTimeline.marker.dragTitle')}
      />
      {pinCard && !editing && (
        <HoverCardShell
          anchor={pinCard.anchor}
          placement="top-center"
          className="timeline-pin__card"
          label={displayLabel}
          pointer={pinCardPointer}
          actions={pinCardActions(pinCard.anchor)}
          onDismiss={dismissPinCard}
        >
          <HoverCardHeading
            title={displayLabel}
            detail={
              isBound
                ? t('bottomTimeline.marker.boundTitle')
                : t('bottomTimeline.marker.renameTitle')
            }
          />
        </HoverCardShell>
      )}
    </div>
  );
}
