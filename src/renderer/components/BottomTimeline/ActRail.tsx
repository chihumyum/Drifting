import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
import '../../../styles/act-rail.css';

// ActRail — the 幕 strip that replaced FullBookLane in book mode.
//
// Unlike the old lane (packed chips, independent scroll), the rail lives in
// TRACK COORDINATE SPACE: callers pass their own orderToX so act bands align
// vertically with the chapter columns below, in both BottomTimeline (20px
// grid) and StoryGraphView (32px grid). The empty track stays interactive so
// the host's context menu / head button can create the first boundary.
//
// Interactions, all rail-local:
//   • drag the divider between two bands → move that act's startOrder
//     (continuous coordinate, clamped strictly between neighbors)
//   • double-click a band → inline rename
//   • right-click a band → 重命名 / 在此处开始新幕 / 删除（并入相邻幕）
//     (menu portals to body — fixed positioning escapes the shell
//     backdrop-filter containing block)
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
}

// Two context menus on the rail, mirroring the timeline-marker rail:
//   • 'act'  — right-click an act CHIP → manage that act (rename / split /
//              drift / delete). Carries the act id.
//   • 'rail' — right-click the bare rail (anywhere but a chip) → 在此处新建幕
//              only. The chip stops propagation, so this fires on empty rail.
// Both carry the cursor order so 新建幕 lands where the user clicked.
type ActMenuState =
  | { kind: 'act'; actId: string; x: number; y: number; orderAtCursor: number }
  | { kind: 'rail'; x: number; y: number; orderAtCursor: number };

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
}: ActRailProps) {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<ActMenuState | null>(null);
  const [dragGhostX, setDragGhostX] = useState<number | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuReturnFocusRef = useRef<HTMLElement | null>(null);
  const touchMenuCleanupRef = useRef<(() => void) | null>(null);
  const boundaryDragCleanupRef = useRef<((updateState?: boolean) => void) | null>(null);
  const suppressTouchClickRef = useRef(false);

  const segments = useMemo(() => deriveActSegments(acts, chapters), [acts, chapters]);
  const sorted = useMemo(() => sortActs(acts), [acts]);
  const displayRailLabel = railLabel ?? t('bottomTimeline.act.railLabel');

  useEffect(() => {
    if (editingId) editInputRef.current?.select();
  }, [editingId]);

  useEffect(() => {
    if (!menu) return undefined;
    const menuElement = menuRef.current;
    const returnFocus = menuReturnFocusRef.current;
    const frame = window.requestAnimationFrame(() => {
      menuElement?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (
        returnFocus &&
        document.activeElement instanceof Node &&
        menuElement?.contains(document.activeElement)
      ) {
        returnFocus.focus({ preventScroll: true });
      }
      menuReturnFocusRef.current = null;
    };
  }, [menu]);

  useEffect(() => () => touchMenuCleanupRef.current?.(), []);
  useLayoutEffect(() => () => boundaryDragCleanupRef.current?.(false), []);

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

  // Outside-click / Esc dismissal for the band menu.
  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('.actrail__menu')) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setMenu(null);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [menu]);

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

  // Right-click the bare rail (anywhere but an act chip) → 在此处新建幕 only,
  // mirroring the timeline-marker rail. An act chip's own onContextMenu stops
  // propagation, so this only fires on empty rail. The host axis remains
  // usable even when there are no chapters.
  const openRailMenu = (clientX: number, clientY: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    const px = rect ? clientX - rect.left : 0;
    menuReturnFocusRef.current = null;
    setMenu({
      kind: 'rail',
      x: clientX + 2,
      y: clientY - 2,
      orderAtCursor: orderAtTrackX(px),
    });
  };

  const handleRailContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openRailMenu(e.clientX, e.clientY);
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
            +
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
    if (e.button !== 0) return; // left button only; right-click → context menu
    const act = segments[segIndex].act;
    const range = movableBoundaryRange(segIndex);
    if (!range) return;
    // A boundary may pass THROUGH chapters freely but never cross a sibling
    // boundary — that would reorder the acts under the user's cursor.
    // Don't preventDefault on pointerdown: the chip also needs its click /
    // double-click (rename) / context-menu to fire. The drag runs on window
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

  const openActMenuFromKeyboard = (element: HTMLElement, actId: string, segmentLeft: number) => {
    const rect = element.getBoundingClientRect();
    menuReturnFocusRef.current = element;
    setMenu({
      kind: 'act',
      actId,
      x: rect.left + Math.min(rect.width, 24),
      y: rect.bottom + 4,
      orderAtCursor: orderAtTrackX(segmentLeft),
    });
  };

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
        className ? ` ${className}` : ''
      }`}
      style={{ height }}
    >
      {railHead}
      <div
        ref={trackRef}
        className="actrail__track"
        style={{ minWidth: trackWidth }}
        title={segments.length === 0 ? t('bottomTimeline.act.emptyTrackTitle') : undefined}
        onContextMenu={handleRailContextMenu}
        onPointerDown={(event) =>
          beginTouchMenu(event, () => openRailMenu(event.clientX, event.clientY))
        }
      >
        {segments.map((seg, i) => {
          const { left, right } = bandEdges(i);
          const isEditing = editingId === seg.act.id;
          const tint = seg.act.color;
          // Tooltip lives on the chip now (the band is inert), so it reads only
          // when hovering the act chip — not anywhere across the segment.
          const chipTitle = `${seg.act.name} · ${t('bottomTimeline.act.chapterCount', { count: seg.chapters.length })}${
            seg.act.driftNodeId
              ? `\n⚓ ${driftTitleById?.(seg.act.driftNodeId) ?? t('bottomTimeline.act.actNote')}`
              : ''
          }`;
          // Every act chip owns a movable boundary. A head-anchored first act
          // starts at the left edge and becomes numeric on its first drag.
          const draggable = movableBoundaryRange(i) !== null;
          return (
            // The band is now an inert positioning/clip wrapper (pointer-events
            // off in CSS) — it no longer captures right-click / double-click
            // across the whole segment. All act interaction lives on the chip
            // below, so the bare rail between chips reads as empty (→ 新建幕),
            // exactly like the timeline-marker rail.
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
              ) : (
                <span
                  className={`actrail__label${draggable ? ' is-draggable' : ''}`}
                  title={chipTitle}
                  role="button"
                  tabIndex={0}
                  aria-label={chipTitle}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    const clientX = event.clientX;
                    const clientY = event.clientY;
                    beginTouchMenu(event, () => {
                      const rect = trackRef.current?.getBoundingClientRect();
                      const px = rect ? clientX - rect.left : 0;
                      menuReturnFocusRef.current = null;
                      setMenu({
                        kind: 'act',
                        actId: seg.act.id,
                        x: clientX + 2,
                        y: clientY - 2,
                        orderAtCursor: orderAtTrackX(px),
                      });
                    });
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
                  onContextMenu={(e) => {
                    // Manage THIS act — the full menu. Stops propagation so the
                    // rail's 新建幕 menu doesn't also open.
                    e.preventDefault();
                    e.stopPropagation();
                    const rect = trackRef.current?.getBoundingClientRect();
                    const px = rect ? e.clientX - rect.left : 0;
                    menuReturnFocusRef.current = null;
                    setMenu({
                      kind: 'act',
                      actId: seg.act.id,
                      x: e.clientX + 2,
                      y: e.clientY - 2,
                      orderAtCursor: orderAtTrackX(px),
                    });
                  }}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setEditingId(seg.act.id);
                    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                      e.preventDefault();
                      openActMenuFromKeyboard(e.currentTarget, seg.act.id, left);
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
                        // a drag from the ⚓ moves the act instead).
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
                      ⚓
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

        {dragGhostX !== null && <div className="actrail__ghost" style={{ left: dragGhostX }} />}
      </div>

      {menu &&
        createPortal(
          (() => {
            // Bare-rail menu: a single create action, mirroring the marker rail.
            if (menu.kind === 'rail') {
              return (
                <div
                  ref={menuRef}
                  className="menu-surface menu-surface--compact actrail__menu"
                  style={{
                    position: 'fixed',
                    left: Math.min(menu.x, Math.max(8, window.innerWidth - 176)),
                    top: Math.min(menu.y, Math.max(8, window.innerHeight - 52)),
                  }}
                  role="menu"
                  onContextMenu={(e) => e.preventDefault()}
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="menu-surface__item"
                    onClick={() => {
                      setMenu(null);
                      onSplitAt(menu.orderAtCursor);
                    }}
                  >
                    {t('bottomTimeline.act.createHere')}
                  </button>
                </div>
              );
            }
            const menuAct = acts.find((a) => a.id === menu.actId) ?? null;
            const isBound = Boolean(menuAct?.driftNodeId);
            return (
              <div
                ref={menuRef}
                className="menu-surface menu-surface--compact actrail__menu"
                style={{
                  position: 'fixed',
                  left: Math.min(menu.x, Math.max(8, window.innerWidth - 176)),
                  top: Math.min(menu.y, Math.max(8, window.innerHeight - 220)),
                }}
                role="menu"
                onContextMenu={(e) => e.preventDefault()}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="menu-surface__item"
                  onClick={() => {
                    setMenu(null);
                    setEditingId(menu.actId);
                  }}
                >
                  {t('bottomTimeline.pinMenu.rename')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="menu-surface__item"
                  onClick={() => {
                    setMenu(null);
                    onSplitAt(menu.orderAtCursor);
                  }}
                >
                  {t('bottomTimeline.act.startHere')}
                </button>
                {/* Drift binding — bound acts open / unbind; unbound acts open
                    the standalone bind picker (DriftBindModal). */}
                {isBound ? (
                  <>
                    {onOpenDrift && (
                      <button
                        type="button"
                        role="menuitem"
                        className="menu-surface__item"
                        onClick={() => {
                          setMenu(null);
                          if (menuAct?.driftNodeId)
                            onOpenDrift(menuAct.driftNodeId, {
                              left: menu.x,
                              top: menu.y,
                              width: 0,
                              height: 0,
                            });
                        }}
                      >
                        {t('bottomTimeline.act.openActNote')}
                      </button>
                    )}
                    {onUnbindDrift && (
                      <button
                        type="button"
                        role="menuitem"
                        className="menu-surface__item"
                        onClick={() => {
                          setMenu(null);
                          onUnbindDrift(menu.actId);
                        }}
                      >
                        {t('bottomTimeline.act.unbindDrift')}
                      </button>
                    )}
                  </>
                ) : (
                  onRequestBind && (
                    <button
                      type="button"
                      role="menuitem"
                      className="menu-surface__item"
                      onClick={() => {
                        setMenu(null);
                        onRequestBind(menu.actId);
                      }}
                    >
                      {t('bottomTimeline.pinMenu.bindDrift')}
                    </button>
                  )
                )}
                <button
                  type="button"
                  role="menuitem"
                  className="menu-surface__item menu-surface__item--danger"
                  onClick={() => {
                    setMenu(null);
                    onDeleteAct(menu.actId);
                  }}
                >
                  {actIndexOf(menu.actId) === 0
                    ? t('bottomTimeline.act.deleteMergeNext')
                    : t('bottomTimeline.act.deleteMergePrev')}
                </button>
              </div>
            );
          })(),
          document.body,
        )}
    </div>
  );
}
