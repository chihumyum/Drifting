import { useCallback, useEffect, useRef, useState } from 'react';
import type { TimelineMarker } from '../../domain/timeline-marker';
import { TimelinePinMenu } from './TimelinePinMenu';

// Mirrors BottomTimeline's TimelinePin one-to-one (head dot + editable
// label) but is sized for the story graph view's axis row. Drag the head to
// reposition; double-click the label to rename. The vertical line that
// spans the full canvas is rendered separately by the parent so it can
// sit at a different z-index than this head/label widget.
//
// A pin bound to a drift node (marker.driftNodeId) renders the DRIFT's title
// instead of its own label, double-click OPENS the drift's editor (no inline
// rename — the caption is the drift's name), and the context menu offers
// 解绑/打开 instead of 绑定/重命名.

export interface GraphTimelinePinProps {
  marker: TimelineMarker;
  // Integer narrativeOrders the drag snaps to (one per chapter slot).
  snapValues: number[];
  // narrativeOrder → track-relative pixel X (already includes the
  // CANVAS_PADDING_X; the parent layers the pin inside
  // .graph-axis-track-cell so we use track-relative coords directly).
  orderToX: (order: number) => number;
  pinHeight: number;
  isDragging: boolean;
  editOnMount?: boolean;
  onChange: (
    patch: Partial<Pick<TimelineMarker, 'narrativeOrder' | 'label' | 'driftNodeId'>>,
  ) => void;
  onDelete: () => void;
  // null when drag ends; otherwise the cursor's pixel X (canvas-content
  // coords) so the parent can render a vertical drop indicator.
  onDragMove: (nextPixelX: number | null) => void;
  // ---- Drift binding (see domain/timeline-marker.ts) ----
  /** Live title of the bound drift; null when unbound (or drift unresolved). */
  boundDriftTitle?: string | null;
  /** Open the standalone drift-bind picker (DriftBindModal) for this marker. */
  onRequestBind?: () => void;
  /** Open the bound drift. `anchor` (the clicked element's viewport rect) lets
      the host anchor the same two-step preview popover the drift panel uses,
      instead of hard-jumping to the editor. */
  onOpenDrift?: (anchor?: {
    left: number;
    top: number;
    width: number;
    height: number;
  }) => void;
}

export function GraphTimelinePin({
  marker,
  snapValues,
  orderToX,
  pinHeight,
  isDragging,
  editOnMount = false,
  onChange,
  onDelete,
  onDragMove,
  boundDriftTitle = null,
  onRequestBind,
  onOpenDrift,
}: GraphTimelinePinProps) {
  const isBound = Boolean(marker.driftNodeId);
  const [editing, setEditing] = useState(editOnMount && !isBound);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const x = orderToX(marker.narrativeOrder);

  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      // Left button only. A right-click must fall through to onContextMenu —
      // if startDrag runs it flips the pin into is-dragging (opacity:0,
      // pointer-events:none) synchronously, so the contextmenu event then
      // resolves to whatever sits BEHIND the pin and the menu never opens.
      if (e.button !== 0) return;
      if (editing) return;
      if (snapValues.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const startMouseX = e.clientX;
      const startPixel = orderToX(marker.narrativeOrder);
      let nearest = marker.narrativeOrder;
      // Threshold before entering drag state — calling onDragMove on mousedown
      // flipped the pin to is-dragging (opacity:0, pointer-events:none) before
      // any movement, swallowing plain clicks / double-clicks (rename / open).
      let dragging = false;
      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startMouseX;
        if (!dragging && Math.abs(dx) < 4) return;
        dragging = true;
        const newPixel = startPixel + dx;
        // Smooth drop indicator: report the raw pixel position so the
        // line follows the mouse continuously. Snap is computed locally
        // and only applied on mouseup — same UX as BottomTimeline pins.
        let best = snapValues[0];
        let bestDist = Infinity;
        for (const s of snapValues) {
          const d = Math.abs(orderToX(s) - newPixel);
          if (d < bestDist) {
            bestDist = d;
            best = s;
          }
        }
        nearest = best;
        onDragMove(newPixel);
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        if (!dragging) return; // a click, not a drag — leave it for dblclick
        onDragMove(null);
        if (nearest !== marker.narrativeOrder) onChange({ narrativeOrder: nearest });
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [editing, snapValues, marker.narrativeOrder, orderToX, onChange, onDragMove],
  );

  useEffect(() => {
    if (editing && labelRef.current) {
      labelRef.current.focus();
      const r = document.createRange();
      r.selectNodeContents(labelRef.current);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
    }
  }, [editing]);

  // Unbind keeps the pin captioned: an own label wins, else the drift title.
  const handleUnbind = useCallback(() => {
    onChange({
      driftNodeId: null,
      label: marker.label.trim() ? marker.label : (boundDriftTitle ?? '标记'),
    });
  }, [onChange, marker.label, boundDriftTitle]);

  const className = [
    'graph-pin',
    isDragging ? 'is-dragging' : '',
    editing ? 'is-editing' : '',
    isBound ? 'is-bound' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const displayLabel = isBound ? (boundDriftTitle || '未命名') : marker.label;

  return (
    <div
      className={className}
      style={{ left: x, height: pinHeight }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu({ x: e.clientX + 2, y: e.clientY - 2 });
      }}
    >
      <div
        ref={labelRef}
        className="graph-pin__label"
        contentEditable={editing}
        suppressContentEditableWarning
        onMouseDown={editing ? (e) => e.stopPropagation() : startDrag}
        onDoubleClick={(e) => {
          e.stopPropagation();
          if (isBound) {
            const r = e.currentTarget.getBoundingClientRect();
            onOpenDrift?.({
              left: r.left,
              top: r.top,
              width: r.width,
              height: r.height,
            });
            return;
          }
          if (!editing) setEditing(true);
        }}
        onBlur={(e) => {
          if (isBound) return;
          const text = (e.currentTarget.textContent ?? '').trim();
          setEditing(false);
          if (!text) onDelete();
          else if (text !== marker.label) onChange({ label: text });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.currentTarget as HTMLDivElement).blur();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            (e.currentTarget as HTMLDivElement).textContent = marker.label;
            (e.currentTarget as HTMLDivElement).blur();
          }
        }}
        title={
          isBound
            ? '已绑定漂浮节点 · 双击打开'
            : editing
              ? '回车保存，留空删除'
              : '双击编辑名称'
        }
      >
        {displayLabel}
      </div>
      <div className="graph-pin__head" onMouseDown={startDrag} title="拖动调整位置" />
      {menu && (
        <TimelinePinMenu
          x={menu.x}
          y={menu.y}
          isBound={isBound}
          onOpenDrift={() =>
            onOpenDrift?.({ left: menu.x, top: menu.y, width: 0, height: 0 })
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
