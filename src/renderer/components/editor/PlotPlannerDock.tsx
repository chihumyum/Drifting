import { useCallback, useEffect, useRef, useState } from 'react';
import { useUiStore } from '../../store/ui-store';
import { serializePlotGrid, type PlotGrid } from '../../domain/plot-grid';
import { PlotGridEditor } from './PlotGrid';
import '../../../styles/plot-planner.css';

const DEFAULT_HEIGHT = 280;
const MIN_DOCK_HEIGHT = 140;
// Keep at least this much prose visible below the dock when resizing.
const MIN_PROSE_HEIGHT = 180;
// Match the prose editor's persist cadence (useEntityEditor PERSIST_DEBOUNCE_MS).
const PERSIST_DEBOUNCE_MS = 400;

interface PlotPlannerDockProps {
  // Mount keyed by nodeId so each chapter/drift gets a fresh instance seeded
  // from its own grid; the binding to nodeId is therefore stable for an
  // instance's whole lifetime (used to route the persist to the right row).
  nodeId: string;
  initialJson: string;
  onPersist: (nodeId: string, serialized: string) => void;
}

export function PlotPlannerDock({ nodeId, initialJson, onPersist }: PlotPlannerDockProps) {
  const storedHeight = useUiStore((s) => s.plotPlannerHeight);
  const setStoredHeight = useUiStore((s) => s.setPlotPlannerHeight);

  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const [isResizing, setIsResizing] = useState(false);

  const dockRef = useRef<HTMLDivElement>(null);
  const grabOffsetRef = useRef(0);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<string | null>(null);
  const onPersistRef = useRef(onPersist);
  useEffect(() => {
    onPersistRef.current = onPersist;
  }, [onPersist]);

  // Flush the trailing-debounced write immediately. Called on unmount (the
  // dock unmounts when the planner is toggled off or the node switches) so a
  // pending edit is never dropped.
  const flush = useCallback(() => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    if (pendingRef.current !== null) {
      onPersistRef.current(nodeId, pendingRef.current);
      pendingRef.current = null;
    }
  }, [nodeId]);

  useEffect(() => flush, [flush]);

  const handleChange = useCallback(
    (grid: PlotGrid) => {
      pendingRef.current = serializePlotGrid(grid);
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
      persistTimerRef.current = setTimeout(() => {
        persistTimerRef.current = null;
        if (pendingRef.current !== null) {
          onPersistRef.current(nodeId, pendingRef.current);
          pendingRef.current = null;
        }
      }, PERSIST_DEBOUNCE_MS);
    },
    [nodeId],
  );

  // Resize via the BOTTOM border — mirror of BottomTimeline's top-edge drag,
  // inverted (dragging down grows the dock). maxH is measured live against
  // .editor-shell so the bottom timeline being open (which shrinks the shell)
  // is automatically accounted for and the prose keeps MIN_PROSE_HEIGHT.
  useEffect(() => {
    if (!isResizing) return;
    let last: number | null = null;
    const onMove = (e: MouseEvent) => {
      const dock = dockRef.current;
      if (!dock) return;
      const dockTop = dock.getBoundingClientRect().top;
      const shell = dock.closest('.editor-shell');
      const shellBottom = shell ? shell.getBoundingClientRect().bottom : window.innerHeight;
      const maxH = Math.max(MIN_DOCK_HEIGHT, shellBottom - dockTop - MIN_PROSE_HEIGHT);
      const next = Math.min(
        maxH,
        Math.max(MIN_DOCK_HEIGHT, e.clientY - grabOffsetRef.current - dockTop),
      );
      last = next;
      setDragHeight(next);
    };
    const onUp = () => {
      setIsResizing(false);
      if (last !== null) {
        setStoredHeight(last);
        setDragHeight(null);
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [isResizing, setStoredHeight]);

  const height = dragHeight ?? storedHeight ?? DEFAULT_HEIGHT;

  return (
    <div className="plot-planner" ref={dockRef} style={{ height }}>
      <div className="plot-planner__body">
        <PlotGridEditor initialJson={initialJson} onChange={handleChange} />
      </div>
      <div
        className="plot-planner__resize"
        onMouseDown={(e) => {
          e.preventDefault();
          const rect = dockRef.current?.getBoundingClientRect();
          grabOffsetRef.current = rect ? e.clientY - rect.bottom : 0;
          setIsResizing(true);
        }}
      />
    </div>
  );
}
