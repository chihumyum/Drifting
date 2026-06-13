import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
//     (menu portals to body — fixed positioning escapes the modern-skin
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
  onDeleteAct: (id: string) => void;
  onSplitAt: (startOrder: number) => void;
  /** Create an act at the viewport center (the rail head cell's ＋ button). */
  onAddAct?: () => void;
  railLabel?: string;
  /** Extra root class — StoryGraphView passes its sticky-top modifier. */
  className?: string;
}

interface BandMenuState {
  actId: string;
  x: number;
  y: number;
  /** Order value under the cursor at menu-open — target for 在此处开始新幕. */
  orderAtCursor: number;
}

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
  onDeleteAct,
  onSplitAt,
  onAddAct,
  railLabel = '幕',
  className,
}: ActRailProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<BandMenuState | null>(null);
  const [dragGhostX, setDragGhostX] = useState<number | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  const segments = useMemo(() => deriveActSegments(acts, chapters), [acts, chapters]);
  const sorted = useMemo(() => sortActs(acts), [acts]);

  useEffect(() => {
    if (editingId) editInputRef.current?.select();
  }, [editingId]);

  // Outside-click / Esc dismissal for the band menu.
  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('.actrail__menu')) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
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

  // Rail head cell — mirrors the narrative time-axis head ("TIME ＋"): the
  // 幕 label plus a ＋ that drops a new act at the viewport center. This is
  // the primary create entry (the old header 「+幕」button was retired).
  const railHead =
    railWidth > 0 ? (
      <div className="actrail__rail" style={{ width: railWidth }}>
        <span>{railLabel}</span>
        {onAddAct && (
          <button
            type="button"
            className="actrail__rail-add"
            disabled={snapOrders.length === 0}
            title={snapOrders.length === 0 ? '需要至少一个章节才能分幕' : '新建幕'}
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
  // the 幕 feature is discoverable). The empty track invites a first split:
  // double-click at a position, or right-click for the same; the head ＋ is
  // the primary entry.
  if (segments.length === 0) {
    return (
      <div className={`actrail actrail--empty${className ? ` ${className}` : ''}`} style={{ height }}>
        {railHead}
        <div
          className="actrail__track actrail__track--empty"
          style={{ minWidth: trackWidth }}
          title="双击或右键此处开始分幕"
          onDoubleClick={(e) => {
            const rect = trackRef.current?.getBoundingClientRect();
            const px = rect ? e.clientX - rect.left : 0;
            onSplitAt(Math.round(xToOrder(px)));
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            const rect = trackRef.current?.getBoundingClientRect();
            const px = rect ? e.clientX - rect.left : 0;
            onSplitAt(Math.round(xToOrder(px)));
          }}
          ref={trackRef}
        >
          <span className="actrail__empty-hint">未分幕 · 双击此处或点 ＋ 划分</span>
        </div>
      </div>
    );
  }

  const bandEdges = (i: number): { left: number; right: number } => {
    const left = i === 0 ? 0 : orderToX(segments[i].act.startOrder ?? 0);
    const right =
      i + 1 < segments.length
        ? orderToX(segments[i + 1].act.startOrder ?? 0)
        : trackWidth;
    return { left, right: Math.max(right, left) };
  };

  const startBoundaryDrag = (e: React.PointerEvent, segIndex: number) => {
    // segIndex >= 1 — the opener has no draggable left edge.
    if (e.button !== 0) return; // left button only; right-click is free for future menus
    e.preventDefault();
    e.stopPropagation();
    const act = segments[segIndex].act;
    if (act.startOrder == null) return;
    const prevBound = segments[segIndex - 1].act.startOrder ?? Number.NEGATIVE_INFINITY;
    const nextBound =
      segIndex + 1 < segments.length
        ? (segments[segIndex + 1].act.startOrder ?? Number.POSITIVE_INFINITY)
        : Number.POSITIVE_INFINITY;
    // A boundary may pass THROUGH chapters freely but never cross a sibling
    // boundary — that would reorder the acts under the user's cursor.
    const candidates = snapOrders.filter((o) => o > prevBound && o < nextBound);
    if (candidates.length === 0) return;

    const startMouseX = e.clientX;
    const startPixel = orderToX(act.startOrder);
    let nearest = act.startOrder;
    setDragGhostX(startPixel);
    const onMove = (ev: PointerEvent) => {
      const px = startPixel + (ev.clientX - startMouseX);
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
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setDragGhostX(null);
      if (nearest !== act.startOrder) onMoveBoundary(act.id, nearest);
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

  return (
    <div className={`actrail${className ? ` ${className}` : ''}`} style={{ height }}>
      {railHead}
      <div ref={trackRef} className="actrail__track" style={{ minWidth: trackWidth }}>
        {segments.map((seg, i) => {
          const { left, right } = bandEdges(i);
          const isEditing = editingId === seg.act.id;
          const tint = seg.act.color;
          return (
            <div
              key={seg.act.id}
              className={`actrail__band${i % 2 === 1 ? ' is-alt' : ''}${tint ? ' has-color' : ''}`}
              style={
                {
                  left,
                  width: Math.max(right - left, 2),
                  ...(tint ? { ['--act-color' as string]: tint } : {}),
                } as React.CSSProperties
              }
              onDoubleClick={(e) => {
                e.stopPropagation();
                setEditingId(seg.act.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const rect = trackRef.current?.getBoundingClientRect();
                const px = rect ? e.clientX - rect.left : 0;
                setMenu({
                  actId: seg.act.id,
                  x: e.clientX + 2,
                  y: e.clientY - 2,
                  orderAtCursor: Math.round(xToOrder(px)),
                });
              }}
              title={`${seg.act.name} · ${seg.chapters.length} 章${seg.act.summary ? `\n${seg.act.summary}` : ''}`}
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
                      (e.currentTarget as HTMLInputElement).value = seg.act.name;
                      (e.currentTarget as HTMLInputElement).blur();
                    }
                  }}
                />
              ) : (
                <span className="actrail__label">
                  <span className="actrail__name">{seg.act.name}</span>
                  <span className="actrail__count">{seg.chapters.length}章</span>
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
              title="拖动调整幕边界"
            />
          );
        })}

        {dragGhostX !== null && (
          <div className="actrail__ghost" style={{ left: dragGhostX }} />
        )}
      </div>

      {menu &&
        createPortal(
          <div
            className="actrail__menu"
            style={{ position: 'fixed', left: menu.x, top: menu.y }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <button
              type="button"
              onClick={() => {
                setMenu(null);
                setEditingId(menu.actId);
              }}
            >
              重命名
            </button>
            <button
              type="button"
              onClick={() => {
                setMenu(null);
                onSplitAt(menu.orderAtCursor);
              }}
            >
              在此处开始新幕
            </button>
            <button
              type="button"
              className="is-danger"
              onClick={() => {
                setMenu(null);
                onDeleteAct(menu.actId);
              }}
            >
              {actIndexOf(menu.actId) === 0 ? '删除此幕（并入下一幕）' : '删除此幕（并入前一幕）'}
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
