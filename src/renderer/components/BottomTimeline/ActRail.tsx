import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  deriveActSegments,
  sortActs,
  type ActChapterRef,
  type BookAct,
} from '../../domain/book-act';
import '../../../styles/act-rail.css';

// ActRail — the 幕 strip that replaced FullBookLane in book mode.
//
// Unlike the old lane (packed chips, independent scroll), the rail lives in
// TRACK COORDINATE SPACE: callers pass their own orderToX so act bands align
// vertically with the chapter columns below, in both BottomTimeline (20px
// grid) and StoryGraphView (32px grid). Renders nothing when no acts exist —
// creation bootstraps from the host's context menu / head button.
//
// Interactions, all rail-local:
//   • drag the divider between two bands → move that act's startOrder
//     (snapped to integer grid orders, clamped strictly between neighbors)
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
  /** Candidate boundary orders (the host's integer snap grid). */
  snapOrders: number[];
  onRenameAct: (id: string, name: string) => void;
  onMoveBoundary: (id: string, startOrder: number) => void;
  /** Live boundary-drag x (track-relative px, = orderToX coords) while dragging
      a boundary/chip, null when it ends. Lets the host extend the drop
      indicator down through the storyline lanes so it reads as one continuous
      line from the rail to the bottom — same as a timeline marker's. */
  onBoundaryDragMove?: (x: number | null) => void;
  onDeleteAct: (id: string) => void;
  onSplitAt: (startOrder: number) => void;
  /** Create an act at the viewport center (the rail head cell's ＋ button). */
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
  snapOrders,
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
    }, 420);
    const cleanup = () => {
      if (timer) window.clearTimeout(timer);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      if (touchMenuCleanupRef.current === cleanup) touchMenuCleanupRef.current = null;
    };
    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) > 8) cleanup();
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

  // Right-click the bare rail (anywhere but an act chip) → 在此处新建幕 only,
  // mirroring the timeline-marker rail. An act chip's own onContextMenu stops
  // propagation, so this only fires on empty rail. Needs a chapter to anchor
  // the order grid, same gate as the head ＋.
  const openRailMenu = (clientX: number, clientY: number) => {
    if (snapOrders.length === 0) return;
    const rect = trackRef.current?.getBoundingClientRect();
    const px = rect ? clientX - rect.left : 0;
    menuReturnFocusRef.current = null;
    setMenu({
      kind: 'rail',
      x: clientX + 2,
      y: clientY - 2,
      orderAtCursor: Math.round(xToOrder(px)),
    });
  };

  const handleRailContextMenu = (e: React.MouseEvent) => {
    if (snapOrders.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    openRailMenu(e.clientX, e.clientY);
  };

  // Rail head cell — mirrors the narrative time-axis head ("TIME ＋"): the
  // 幕 label plus a ＋ that drops a new act at the viewport center. This is
  // the primary create entry (the old header 「+幕」button was retired).
  const railHead =
    railWidth > 0 ? (
      <div className="actrail__rail" style={{ width: railWidth }}>
        <span>{displayRailLabel}</span>
        {onAddAct && (
          <button
            type="button"
            className="actrail__rail-add"
            disabled={snapOrders.length === 0}
            title={
              snapOrders.length === 0
                ? t('bottomTimeline.act.needChapter')
                : t('bottomTimeline.act.newAct')
            }
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

  // No acts yet — the rail still shows (book mode always renders it now, so
  // the 幕 feature stays discoverable via the head ＋). The empty track is
  // plain (no dashed invitation); right-clicking it offers 在此处新建幕, the
  // same gesture as the populated rail.
  if (segments.length === 0) {
    return (
      <div
        className={`actrail actrail--empty${className ? ` ${className}` : ''}`}
        style={{ height }}
      >
        {railHead}
        <div
          ref={trackRef}
          className="actrail__track"
          style={{ minWidth: trackWidth }}
          title={t('bottomTimeline.act.emptyTrackTitle')}
          onContextMenu={handleRailContextMenu}
          onPointerDown={(event) =>
            beginTouchMenu(event, () => openRailMenu(event.clientX, event.clientY))
          }
        />
      </div>
    );
  }

  const bandEdges = (i: number): { left: number; right: number } => {
    const left = i === 0 ? 0 : orderToX(segments[i].act.startOrder ?? 0);
    const right =
      i + 1 < segments.length ? orderToX(segments[i + 1].act.startOrder ?? 0) : trackWidth;
    return { left, right: Math.max(right, left) };
  };

  // Move an act's boundary (= the act's position). Driven by both the boundary
  // divider AND the act chip itself (drag the chip to reposition the act). Only
  // valid for segIndex >= 1 with a real startOrder — the first act (opener) has
  // no boundary and can't be moved.
  const startBoundaryDrag = (e: React.PointerEvent, segIndex: number) => {
    if (e.button !== 0) return; // left button only; right-click → context menu
    const act = segments[segIndex].act;
    if (segIndex === 0 || act.startOrder == null) return;
    const prevBound = segments[segIndex - 1].act.startOrder ?? Number.NEGATIVE_INFINITY;
    const nextBound =
      segIndex + 1 < segments.length
        ? (segments[segIndex + 1].act.startOrder ?? Number.POSITIVE_INFINITY)
        : Number.POSITIVE_INFINITY;
    // A boundary may pass THROUGH chapters freely but never cross a sibling
    // boundary — that would reorder the acts under the user's cursor.
    const candidates = snapOrders.filter((o) => o > prevBound && o < nextBound);
    if (candidates.length === 0) return;
    // Don't preventDefault on pointerdown: the chip also needs its click /
    // double-click (rename) / context-menu to fire. The drag runs on window
    // listeners regardless, and a movement threshold below keeps a plain click
    // from registering as a drag (and from flashing the ghost line).
    e.stopPropagation();

    const startMouseX = e.clientX;
    const startPixel = orderToX(act.startOrder);
    let nearest = act.startOrder;
    let dragging = false;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startMouseX;
      if (!dragging && Math.abs(dx) < 4) return;
      dragging = true;
      const px = startPixel + dx;
      let best = candidates[0];
      let bestDist = Infinity;
      for (const c of candidates) {
        const d = Math.abs(orderToX(c) - px);
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }
      nearest = best;
      setDragGhostX(px);
      onBoundaryDragMove?.(px);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setDragGhostX(null);
      onBoundaryDragMove?.(null);
      if (dragging && nearest !== act.startOrder) onMoveBoundary(act.id, nearest);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
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
      orderAtCursor: Math.round(xToOrder(segmentLeft)),
    });
  };

  const moveBoundaryFromKeyboard = (segIndex: number, direction: -1 | 1) => {
    const act = segments[segIndex]?.act;
    if (!act || segIndex === 0 || act.startOrder == null) return;
    const currentOrder = act.startOrder;
    const prevBound = segments[segIndex - 1].act.startOrder ?? Number.NEGATIVE_INFINITY;
    const nextBound =
      segIndex + 1 < segments.length
        ? (segments[segIndex + 1].act.startOrder ?? Number.POSITIVE_INFINITY)
        : Number.POSITIVE_INFINITY;
    const candidates = snapOrders
      .filter((order) => order > prevBound && order < nextBound)
      .sort((a, b) => a - b);
    const currentIndex = candidates.indexOf(currentOrder);
    const baseIndex =
      currentIndex >= 0 ? currentIndex : candidates.findIndex((order) => order > currentOrder);
    const nextIndex =
      direction < 0
        ? Math.max(0, (baseIndex < 0 ? candidates.length : baseIndex) - 1)
        : Math.min(candidates.length - 1, Math.max(-1, baseIndex) + 1);
    const next = candidates[nextIndex];
    if (next !== undefined && next !== currentOrder) onMoveBoundary(act.id, next);
  };

  return (
    <div className={`actrail${className ? ` ${className}` : ''}`} style={{ height }}>
      {railHead}
      <div
        ref={trackRef}
        className="actrail__track"
        style={{ minWidth: trackWidth }}
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
          // Drag the chip to move the act's boundary (= its position) — same
          // gesture/clamping as the divider. The first act (opener, no
          // boundary) is fixed at the book head, so its chip isn't draggable.
          const draggable = i >= 1 && seg.act.startOrder != null;
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
                        orderAtCursor: Math.round(xToOrder(px)),
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
                      orderAtCursor: Math.round(xToOrder(px)),
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

        {/* Boundary handles — left edge of every non-opener band. */}
        {segments.map((seg, i) => {
          if (i === 0 || seg.act.startOrder == null) return null;
          return (
            <div
              key={`bd-${seg.act.id}`}
              className="actrail__divider"
              style={{ left: orderToX(seg.act.startOrder) }}
              onPointerDown={(e) => startBoundaryDrag(e, i)}
              title={t('bottomTimeline.act.dragBoundary')}
              role="slider"
              tabIndex={0}
              aria-label={t('bottomTimeline.act.dragBoundary')}
              aria-orientation="horizontal"
              aria-valuenow={seg.act.startOrder}
              aria-valuemin={
                segments[i - 1].act.startOrder ??
                (snapOrders.length > 0 ? Math.min(...snapOrders) : seg.act.startOrder)
              }
              aria-valuemax={
                segments[i + 1]?.act.startOrder ??
                (snapOrders.length > 0 ? Math.max(...snapOrders) : seg.act.startOrder)
              }
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
