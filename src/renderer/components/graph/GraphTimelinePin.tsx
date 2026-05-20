import { useCallback, useEffect, useRef, useState } from 'react';
import type { TimelineMarker } from '../../domain/timeline-marker';

// Mirrors BottomTimeline's TimelinePin one-to-one (head dot + editable
// label) but is sized for the graph view's axis row. Drag the head to
// reposition; double-click the label to rename. The vertical line that
// spans the full canvas is rendered separately by the parent so it can
// sit at a different z-index than this head/label widget.

export interface GraphTimelinePinProps {
  marker: TimelineMarker;
  // Integer narrativeOrders the drag snaps to (one per chapter slot).
  snapValues: number[];
  // narrativeOrder → canvas-content pixel X (already includes the
  // canvas padding; the parent layers the pin inside .graph-tracks so
  // we use canvas-content coords directly).
  orderToX: (order: number) => number;
  pinHeight: number;
  isDragging: boolean;
  editOnMount?: boolean;
  onChange: (patch: Partial<Pick<TimelineMarker, 'narrativeOrder' | 'label'>>) => void;
  onDelete: () => void;
  // null when drag ends; otherwise the cursor's pixel X (canvas-content
  // coords) so the parent can render a vertical drop indicator.
  onDragMove: (nextPixelX: number | null) => void;
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
}: GraphTimelinePinProps) {
  const [editing, setEditing] = useState(editOnMount);
  const labelRef = useRef<HTMLDivElement>(null);
  const x = orderToX(marker.narrativeOrder);

  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      if (editing) return;
      if (snapValues.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const startMouseX = e.clientX;
      const startPixel = orderToX(marker.narrativeOrder);
      let nearest = marker.narrativeOrder;
      onDragMove(startPixel);
      const onMove = (ev: MouseEvent) => {
        const newPixel = startPixel + (ev.clientX - startMouseX);
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

  const className = [
    'graph-pin',
    isDragging ? 'is-dragging' : '',
    editing ? 'is-editing' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className} style={{ left: x, height: pinHeight }}>
      <div
        ref={labelRef}
        className="graph-pin__label"
        contentEditable={editing}
        suppressContentEditableWarning
        onMouseDown={editing ? (e) => e.stopPropagation() : startDrag}
        onDoubleClick={(e) => {
          if (!editing) {
            e.stopPropagation();
            setEditing(true);
          }
        }}
        onBlur={(e) => {
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
        title={editing ? '回车保存，留空删除' : '双击编辑名称'}
      >
        {marker.label}
      </div>
      <div className="graph-pin__head" onMouseDown={startDrag} title="拖动调整位置" />
    </div>
  );
}
