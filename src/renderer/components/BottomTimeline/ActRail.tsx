import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  deriveActSegments,
  sortActs,
  type ActChapterRef,
  type BookAct,
} from '../../domain/book-act';
import {
  MOBILE_PLANNING_CONTEXT_MENU_MS,
  MOBILE_PLANNING_MOVE_TOLERANCE_PX,
} from '../../features/graph/mobile-planning-gesture';
import { useHoverPreview } from '../../features/entities/hover/entity-hover-card-model';
import {
  HoverCardHeading,
  HoverCardShell,
  type HoverAction,
  type HoverActionGroup,
} from '../ui/HoverCard';
import { BrushIcon } from '../ui/BrushIcon';
import { KindMark } from '../ui/KindMark';
import '../../../styles/act-rail.css';

// ActRail — the 幕 strip that replaced FullBookLane in book mode.
//
// Unlike the old lane (packed chips, independent scroll), the rail lives in
// TRACK COORDINATE SPACE: callers pass their own orderToX so act bands align
// vertically with the chapter columns below, in both BottomTimeline (20px
// grid) and StoryGraphView (32px grid). The empty track stays interactive so
// a double-click or the head button can create the first boundary.
//
// Interactions, all rail-local:
//   • drag the divider between two bands → move that act's startOrder
//     (continuous coordinate, clamped strictly between neighbors)
//   • double-click a chip → inline rename
//   • rest on a chip → its hover card: 重命名 / 在此处开始新幕 / 幕笔记 /
//     删除（并入相邻幕）. Shift+F10 or the menu key opens it from the
//     keyboard, a touch hold from a finger.
//   • double-click the bare rail → 新建幕 at that spot
// There are no right-click menus: right-click shows the native one.
interface ActRailProps {
  acts: BookAct[];
  chapters: ActChapterRef[];
  /** Sticky label cell width; 0 hides the label cell. */
  railWidth: number;
  /** Track pixel width (the host's timelineWidth / canvas width). */
  trackWidth: number;
  height: number;
  orderToX: (order: number) => number;
  /** Visible continuous coordinate range owned by the host axis. */
  minOrder: number;
  maxOrder: number;
  onRenameAct: (id: string, name: string) => void;
  onMoveBoundary: (id: string, startOrder: number) => void;
  /** Live boundary-drag x (track-relative px, = orderToX coords) while dragging
      a boundary/chip, null when it ends. Lets the host extend the drop
      indicator down through the storyline lanes so it reads as one continuous
      line from the rail to the bottom — same as a timeline marker's. */
  onBoundaryDragMove?: (x: number | null) => void;
  onDeleteAct: (id: string) => void;
  onSplitAt: (startOrder: number) => void;
  /** Create an act at the host-chosen coordinate (the rail head cell's ＋ button). */
  onAddAct?: () => void;
  // ---- Drift binding (an act may bind a drift as its 大纲/notes) ----
  /** Resolve a bound drift's live title (for the ⚓ tooltip). */
  driftTitleById?: (id: string) => string | null;
  /** Open the standalone drift-bind picker (DriftBindModal) for an act. */
  onRequestBind?: (actId: string) => void;
  onUnbindDrift?: (actId: string) => void;
  /** Open a bound drift. `anchor` (the clicked element's viewport rect) lets
      the host anchor a preview popover instead of jumping to the editor — the
      graph view uses it for the same two-step card as the drift panel; the
      bottom timeline ignores it and opens the editor directly. */
  onOpenDrift?: (
    driftNodeId: string,
    anchor?: { left: number; top: number; width: number; height: number },
  ) => void;
  railLabel?: string;
  /** Extra root class — StoryGraphView passes its sticky-top modifier. */
  className?: string;
  /** Desktop Bottom Timeline: chips, boundaries and the drop line are glass
      (act-rail.css `.actrail--glass`). Off, the rail keeps its paper chips. */
  glass?: boolean;
}

// What an act chip's hover card acts on: the act, and the spot on the axis
// the pointer came in at, where 在此处开始新幕 splits.
interface ActCardTarget {
  actId: string;
  orderAtCursor: number;
}

export function ActRail({
  acts,
  chapters,
  railWidth,
  trackWidth,
  height,
  orderToX,
  minOrder,
  maxOrder,
  onRenameAct,
  onMoveBoundary,
  onBoundaryDragMove,
  onDeleteAct,
  onSplitAt,
  onAddAct,
  driftTitleById,
  onRequestBind,
  onUnbindDrift,
  onOpenDrift,
  railLabel,
  className,
  glass = false,
}: ActRailProps) {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dragGhostX, setDragGhostX] = useState<number | null>(null);
  const {
    preview: actCard,
    onEnter: actCardEnter,
    onLeave: actCardLeave,
    dismiss: dismissActCard,
    open: openActCard,
    card: actCardPointer,
  } = useHoverPreview<ActCardTarget>();
  const trackRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  // The chip whose card was opened from the keyboard; focus returns to it.
  const cardReturnFocusRef = useRef<HTMLElement | null>(null);
  const touchMenuCleanupRef = useRef<(() => void) | null>(null);
  const boundaryDragCleanupRef = useRef<((updateState?: boolean) => void) | null>(null);
  const suppressTouchClickRef = useRef(false);

  const segments = useMemo(() => deriveActSegments(acts, chapters), [acts, chapters]);
  const sorted = useMemo(() => sortActs(acts), [acts]);
  const displayRailLabel = railLabel ?? t('bottomTimeline.act.railLabel');

  useEffect(() => {
    if (editingId) editInputRef.current?.select();
  }, [editingId]);

  // A card opened without hover (keyboard, touch hold) has no pointer leaving
  // to close it, so a press anywhere else does. From the keyboard it also
  // takes focus to its first action and hands focus back to the chip after.
  useEffect(() => {
    if (!actCard) return undefined;
    const chip = cardReturnFocusRef.current;
    cardReturnFocusRef.current = null;
    const frame = chip
      ? window.requestAnimationFrame(() => {
          document
            .querySelector<HTMLButtonElement>('.actrail__card .hover-card__action:not(:disabled)')
            ?.focus();
        })
      : 0;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('.actrail__card')) return;
      dismissActCard();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', onPointerDown, true);
      // The focused action unmounted with the card; a rename's input keeps focus.
      if (chip?.isConnected && document.activeElement === document.body) {
        chip.focus({ preventScroll: true });
      }
    };
  }, [actCard, dismissActCard]);

  useEffect(() => () => touchMenuCleanupRef.current?.(), []);
  useLayoutEffect(() => () => boundaryDragCleanupRef.current?.(false), []);

  // Touch has no hover: holding a chip opens its card.
  const beginTouchMenu = (event: React.PointerEvent, open: () => void) => {
    if (event.pointerType !== 'touch') return;
    touchMenuCleanupRef.current?.();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let timer = window.setTimeout(() => {
      timer = 0;
      suppressTouchClickRef.current = true;
      open();
    }, MOBILE_PLANNING_CONTEXT_MENU_MS);
    const cleanup = () => {
      if (timer) window.clearTimeout(timer);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      if (touchMenuCleanupRef.current === cleanup) touchMenuCleanupRef.current = null;
    };
    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      if (
        Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) >
        MOBILE_PLANNING_MOVE_TOLERANCE_PX
      ) {
        cleanup();
      }
    };
    const onEnd = (endEvent: PointerEvent) => {
      if (endEvent.pointerId === pointerId) cleanup();
    };
    touchMenuCleanupRef.current = cleanup;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
  };

  // Invert orderToX for cursor positions. The mapping is affine
  // (px = (order - minOrder) * unit), so two probes recover it exactly.
  const xToOrder = (px: number): number => {
    const x0 = orderToX(0);
    const x1 = orderToX(1);
    const unit = x1 - x0;
    if (unit === 0) return 0;
    return (px - x0) / unit;
  };

  const axisMinOrder = Math.min(minOrder, maxOrder);
  const axisMaxOrder = Math.max(minOrder, maxOrder);
  const orderUnitPx = Math.abs(orderToX(1) - orderToX(0));
  const onePixelOrder = orderUnitPx > 0 ? 1 / orderUnitPx : 1;
  const boundaryEpsilon = Math.max(Number.EPSILON, onePixelOrder / 1000);
  const orderAtTrackX = (px: number): number =>
    Math.min(axisMaxOrder, Math.max(axisMinOrder, xToOrder(px)));
  const orderAtClientX = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    return orderAtTrackX(rect ? clientX - rect.left : 0);
  };
  const movableBoundaryRange = (segIndex: number): { min: number; max: number } | null => {
    if (segIndex < 0 || segIndex >= segments.length) return null;
    const previous = segIndex > 0 ? segments[segIndex - 1].act.startOrder : null;
    const next = segments[segIndex + 1]?.act.startOrder;
    const min =
      segIndex === 0
        ? axisMinOrder
        : Math.max(axisMinOrder, (previous ?? axisMinOrder) + boundaryEpsilon);
    const max = Math.min(axisMaxOrder, (next ?? axisMaxOrder) - boundaryEpsilon);
    return min <= max ? { min, max } : null;
  };

  // Rail head cell — mirrors the narrative time-axis head ("TIME ＋"): the
  // 幕 label plus a ＋ that creates a new act at the host-chosen coordinate. This is
  // the primary create entry (the old header 「+幕」button was retired).
  const railHead =
    railWidth > 0 ? (
      <div className="actrail__rail" style={{ width: railWidth }}>
        <span>{displayRailLabel}</span>
        {onAddAct && (
          <button
            type="button"
            className="actrail__rail-add"
            title={t('bottomTimeline.act.newAct')}
            onClick={(e) => {
              e.stopPropagation();
              onAddAct();
            }}
          >
            <BrushIcon name="plus" size={10} inline />
          </button>
        )}
      </div>
    ) : null;

  const bandEdges = (i: number): { left: number; right: number } => {
    const left = orderToX(segments[i].act.startOrder ?? axisMinOrder);
    const right =
      i + 1 < segments.length
        ? orderToX(segments[i + 1].act.startOrder ?? axisMinOrder)
        : trackWidth;
    return { left, right: Math.max(right, left) };
  };

  // Move an act's boundary (= the act's position). A legacy/book-head anchored
  // null boundary starts at axisMinOrder; the first real movement converts it
  // to an ordinary finite coordinate.
  const startBoundaryDrag = (e: React.PointerEvent, segIndex: number) => {
    if (e.button !== 0) return; // left button only
    const act = segments[segIndex].act;
    const range = movableBoundaryRange(segIndex);
    if (!range) return;
    // A boundary may pass THROUGH chapters freely but never cross a sibling
    // boundary — that would reorder the acts under the user's cursor.
    // Don't preventDefault on pointerdown: the chip also needs its click /
    // double-click (rename) to fire. The drag runs on window
    // listeners regardless, and a movement threshold below keeps a plain click
    // from registering as a drag (and from flashing the ghost line).
    e.stopPropagation();

    boundaryDragCleanupRef.current?.();
    const startMouseX = e.clientX;
    const currentOrder = act.startOrder ?? axisMinOrder;
    const startPixel = orderToX(currentOrder);
    const pointerId = e.pointerId;
    let nextOrder = currentOrder;
    let dragging = false;
    let ended = false;
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const dx = ev.clientX - startMouseX;
      if (!dragging && Math.abs(dx) < 4) return;
      dragging = true;
      nextOrder = Math.min(range.max, Math.max(range.min, xToOrder(startPixel + dx)));
      const nextX = orderToX(nextOrder);
      setDragGhostX(nextX);
      onBoundaryDragMove?.(nextX);
    };
    const cleanup = (updateState = true) => {
      if (ended) return;
      ended = true;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onBlur);
      if (boundaryDragCleanupRef.current === cleanup) boundaryDragCleanupRef.current = null;
      if (updateState) setDragGhostX(null);
      onBoundaryDragMove?.(null);
    };
    const onUp = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      cleanup();
      if (dragging && nextOrder !== act.startOrder) onMoveBoundary(act.id, nextOrder);
    };
    const onCancel = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      cleanup();
    };
    const onBlur = () => cleanup();
    boundaryDragCleanupRef.current = cleanup;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onBlur);
  };

  const commitRename = (id: string, raw: string, fallback: string) => {
    setEditingId(null);
    const name = raw.trim();
    if (name && name !== fallback) onRenameAct(id, name);
  };

  const actIndexOf = (id: string) => sorted.findIndex((a) => a.id === id);

  // What the act chip's right-click menu used to offer, along its card's bottom.
  const actCardActions = (
    act: BookAct,
    orderAtCursor: number,
    chip: HTMLElement,
  ): HoverActionGroup[] => {
    const driftNodeId = act.driftNodeId;
    // Drift binding — a bound act opens or unbinds its note; an unbound one
    // opens the standalone bind picker (DriftBindModal).
    const driftActions: HoverAction[] = [];
    if (driftNodeId) {
      if (onOpenDrift) {
        driftActions.push({
          key: 'open-drift',
          label: t('bottomTimeline.act.openActNote'),
          onSelect: () => {
            const r = chip.getBoundingClientRect();
            onOpenDrift(driftNodeId, {
              left: r.left,
              top: r.top,
              width: r.width,
              height: r.height,
            });
          },
        });
      }
      if (onUnbindDrift) {
        driftActions.push({
          key: 'unbind',
          label: t('bottomTimeline.act.unbindDrift'),
          onSelect: () => onUnbindDrift(act.id),
        });
      }
    } else if (onRequestBind) {
      driftActions.push({
        key: 'bind',
        label: t('bottomTimeline.pinMenu.bindDrift'),
        onSelect: () => onRequestBind(act.id),
      });
    }
    return [
      {
        key: 'act',
        actions: [
          {
            key: 'rename',
            label: t('bottomTimeline.pinMenu.rename'),
            onSelect: () => setEditingId(act.id),
          },
          {
            key: 'split',
            label: t('bottomTimeline.act.startHere'),
            onSelect: () => onSplitAt(orderAtCursor),
          },
        ],
      },
      { key: 'drift', actions: driftActions },
      {
        key: 'delete',
        actions: [
          {
            key: 'delete',
            label:
              actIndexOf(act.id) === 0
                ? t('bottomTimeline.act.deleteMergeNext')
                : t('bottomTimeline.act.deleteMergePrev'),
            danger: true,
            onSelect: () => onDeleteAct(act.id),
          },
        ],
      },
    ];
  };
  const cardAct = actCard ? (acts.find((a) => a.id === actCard.data.actId) ?? null) : null;

  const moveBoundaryFromKeyboard = (segIndex: number, direction: -1 | 1) => {
    const act = segments[segIndex]?.act;
    if (!act) return;
    const currentOrder = act.startOrder ?? axisMinOrder;
    const range = movableBoundaryRange(segIndex);
    if (!range) return;
    const next = Math.min(range.max, Math.max(range.min, currentOrder + direction * onePixelOrder));
    if (next !== currentOrder) onMoveBoundary(act.id, next);
  };

  return (
    <div
      className={`actrail${segments.length === 0 ? ' actrail--empty' : ''}${
        glass ? ' actrail--glass' : ''
      }${className ? ` ${className}` : ''}`}
      style={{ height }}
    >
      {railHead}
      <div
        ref={trackRef}
        className="actrail__track"
        style={{ minWidth: trackWidth }}
        title={segments.length === 0 ? t('bottomTimeline.act.emptyTrackTitle') : undefined}
        onDoubleClick={(event) => {
          // Bare rail only: chips rename on their own double-click, and the
          // inert bands around them let the pointer through to the track.
          if (event.target !== event.currentTarget) return;
          onSplitAt(orderAtClientX(event.clientX));
        }}
      >
        {segments.map((seg, i) => {
          const { left, right } = bandEdges(i);
          const isEditing = editingId === seg.act.id;
          const tint = seg.act.color;
          // The chip's accessible name; the pointer gets its hover card.
          const chipTitle = `${seg.act.name} · ${t('bottomTimeline.act.chapterCount', { count: seg.chapters.length })}${
            seg.act.driftNodeId
              ? `\n${driftTitleById?.(seg.act.driftNodeId) ?? t('bottomTimeline.act.actNote')}`
              : ''
          }`;
          // Every act chip owns a movable boundary. A head-anchored first act
          // starts at the left edge and becomes numeric on its first drag.
          const draggable = movableBoundaryRange(i) !== null;
          return (
            // The band is an inert positioning/clip wrapper (pointer-events
            // off in CSS) — it doesn't capture double-clicks across the whole
            // segment. All act interaction lives on the chip below, so the
            // bare rail between chips reads as empty (double-click → 新建幕),
            // like the timeline-marker axis.
            <div
              key={seg.act.id}
              className={`actrail__band${tint ? ' has-color' : ''}`}
              style={
                {
                  left,
                  width: Math.max(right - left, 2),
                  ...(tint ? { ['--act-color' as string]: tint } : {}),
                } as React.CSSProperties
              }
            >
              {isEditing ? (
                // A glass input carries its rim on a wrapper: an <input> has
                // no ::before of its own. Focused, it is the still selected glass.
                <span className={glass ? 'actrail__edit-field glass glass--field' : 'actrail__edit-field'}>
                  <input
                    ref={editInputRef}
                    className="actrail__edit"
                    defaultValue={seg.act.name}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => commitRename(seg.act.id, e.currentTarget.value, seg.act.name)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
                      else if (e.key === 'Escape') {
                        e.preventDefault();
                        e.stopPropagation();
                        (e.currentTarget as HTMLInputElement).value = seg.act.name;
                        (e.currentTarget as HTMLInputElement).blur();
                      }
                    }}
                  />
                </span>
              ) : (
                <span
                  className={`actrail__label${draggable ? ' is-draggable' : ''}${
                    glass ? ' glass glass--rest' : ''
                  }`}
                  role="button"
                  tabIndex={0}
                  aria-label={chipTitle}
                  onMouseEnter={(event) => {
                    // A held button means a boundary or chapter is being carried.
                    if (event.buttons !== 0) return;
                    actCardEnter(
                      { actId: seg.act.id, orderAtCursor: orderAtClientX(event.clientX) },
                      event.currentTarget,
                    );
                  }}
                  onMouseLeave={actCardLeave}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    dismissActCard();
                    const chip = event.currentTarget;
                    const orderAtCursor = orderAtClientX(event.clientX);
                    beginTouchMenu(event, () =>
                      openActCard({ actId: seg.act.id, orderAtCursor }, chip),
                    );
                    if (draggable) startBoundaryDrag(event, i);
                  }}
                  onClick={(event) => {
                    if (!suppressTouchClickRef.current) return;
                    suppressTouchClickRef.current = false;
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onDoubleClick={(e) => {
                    // Rename triggers on the CHIP only (the band is inert).
                    e.stopPropagation();
                    setEditingId(seg.act.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setEditingId(seg.act.id);
                    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                      e.preventDefault();
                      cardReturnFocusRef.current = e.currentTarget;
                      openActCard(
                        { actId: seg.act.id, orderAtCursor: orderAtTrackX(left) },
                        e.currentTarget,
                      );
                    }
                  }}
                >
                  {seg.act.driftNodeId && onOpenDrift && (
                    <button
                      type="button"
                      className="actrail__anchor"
                      title={t('bottomTimeline.act.openActNoteTitle')}
                      onClick={(e) => {
                        // Drag still arms via the chip's onPointerDown (the
                        // 4px threshold keeps this a plain click → open drift;
                        // a drag from the drift mark moves the act instead).
                        e.stopPropagation();
                        if (suppressTouchClickRef.current) {
                          suppressTouchClickRef.current = false;
                          e.preventDefault();
                          return;
                        }
                        const r = e.currentTarget.getBoundingClientRect();
                        onOpenDrift(seg.act.driftNodeId!, {
                          left: r.left,
                          top: r.top,
                          width: r.width,
                          height: r.height,
                        });
                      }}
                    >
                      <KindMark kind="drift" color="hsl(var(--accent))" />
                    </button>
                  )}
                  <span className="actrail__name">{seg.act.name}</span>
                  <span className="actrail__count">
                    {t('bottomTimeline.act.chapterCount', { count: seg.chapters.length })}
                  </span>
                </span>
              )}
            </div>
          );
        })}

        {/* Boundary handles — left edge of every act, including the first. */}
        {segments.map((seg, i) => {
          const boundaryOrder = seg.act.startOrder ?? axisMinOrder;
          const range = movableBoundaryRange(i);
          if (!range) return null;
          return (
            <div
              key={`bd-${seg.act.id}`}
              className="actrail__divider"
              style={{ left: orderToX(boundaryOrder) }}
              onPointerDown={(e) => startBoundaryDrag(e, i)}
              title={t('bottomTimeline.act.dragBoundary')}
              role="slider"
              tabIndex={0}
              aria-label={t('bottomTimeline.act.dragBoundary')}
              aria-orientation="horizontal"
              aria-valuenow={boundaryOrder}
              aria-valuemin={range.min}
              aria-valuemax={range.max}
              onKeyDown={(e) => {
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                e.preventDefault();
                moveBoundaryFromKeyboard(i, e.key === 'ArrowLeft' ? -1 : 1);
              }}
            />
          );
        })}

        {/* --flow: the glass drop line's texture runs with the distance moved. */}
        {dragGhostX !== null && (
          <div
            className="actrail__ghost"
            style={{ left: dragGhostX, ['--flow' as string]: dragGhostX } as React.CSSProperties}
          />
        )}
      </div>

      {actCard && cardAct && (
        <HoverCardShell
          anchor={actCard.anchor}
          placement="top-center"
          className="actrail__card"
          label={cardAct.name}
          pointer={actCardPointer}
          actions={actCardActions(cardAct, actCard.data.orderAtCursor, actCard.anchor)}
          onDismiss={dismissActCard}
        >
          <HoverCardHeading
            title={cardAct.name}
            detail={
              cardAct.driftNodeId
                ? <><KindMark kind="drift" color="hsl(var(--accent))" /> {driftTitleById?.(cardAct.driftNodeId) ?? t('bottomTimeline.act.actNote')}</>
                : undefined
            }
          />
        </HoverCardShell>
      )}
    </div>
  );
}
