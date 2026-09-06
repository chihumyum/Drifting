import { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize2, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useUiStore } from '../../store/ui-store';
import {
  clonePlotGrid,
  diffPlotGrid,
  readPlotGridProjection,
  type PlotGrid,
  type PlotGridMutation,
} from '../../domain/plot-grid';
import { clampDimension, verticalDockBounds } from '../../lib/layout-geometry';
import { PlotGridEditor, type PlotGridEditorApi } from './PlotGrid';
import {
  readLocalPlotGridCellRatio,
  writeLocalPlotGridCellRatio,
} from './plot-grid/plot-grid-cell-ratio-store';
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
  onPersist: (nodeId: string, mutations: readonly PlotGridMutation[]) => Promise<unknown>;
}

export function PlotPlannerDock({ nodeId, initialJson, onPersist }: PlotPlannerDockProps) {
  const { t } = useTranslation();
  const storedHeight = useUiStore((s) => s.plotPlannerHeight);
  const setStoredHeight = useUiStore((s) => s.setPlotPlannerHeight);

  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const [isResizing, setIsResizing] = useState(false);

  const dockRef = useRef<HTMLDivElement>(null);
  const gridApiRef = useRef<PlotGridEditorApi | null>(null);
  const grabOffsetRef = useRef(0);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const committedGridRef = useRef<PlotGrid | null>(readPlotGridProjection(initialJson));
  const latestGridRef = useRef<PlotGrid | null>(null);
  const persistChainRef = useRef<Promise<void>>(Promise.resolve());
  const onPersistRef = useRef(onPersist);
  useEffect(() => {
    onPersistRef.current = onPersist;
  }, [onPersist]);

  // Queue one semantic snapshot transition. Each task diffs against the last
  // successfully committed normalized authority, so a failed write cannot
  // advance the local baseline and make a later retry silently omit fields.
  const flush = useCallback(() => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    if (!latestGridRef.current) return;
    const target = clonePlotGrid(latestGridRef.current);
    latestGridRef.current = null;
    persistChainRef.current = persistChainRef.current
      .then(async () => {
        const mutations = diffPlotGrid(committedGridRef.current, target);
        if (mutations.length > 0) await onPersistRef.current(nodeId, mutations);
        committedGridRef.current = target;
      })
      .catch((error) => {
        console.error('[PlotGrid] normalized persistence failed:', error);
      });
  }, [nodeId]);

  useEffect(() => flush, [flush]);

  const boundsForCurrentShell = useCallback(() => {
    const dock = dockRef.current;
    const shell = dockRef.current?.closest('.editor-shell');
    const availableHeight =
      dock && shell
        ? shell.getBoundingClientRect().bottom - dock.getBoundingClientRect().top
        : window.innerHeight;
    return verticalDockBounds(availableHeight, MIN_DOCK_HEIGHT, MIN_PROSE_HEIGHT);
  }, []);

  // Persisted dock heights are only preferences, never layout authority.
  // Re-clamp them after hydration and whenever the editor shell changes size
  // (window resize, bottom timeline toggle, split changes, etc.).
  useEffect(() => {
    const normalize = () => {
      if (storedHeight === null) return;
      const next = clampDimension(storedHeight, boundsForCurrentShell());
      if (next !== storedHeight) setStoredHeight(next);
    };
    const frame = window.requestAnimationFrame(normalize);
    const shell = dockRef.current?.closest('.editor-shell');
    const observer =
      shell && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(normalize) : null;
    if (shell && observer) observer.observe(shell);
    window.addEventListener('resize', normalize);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', normalize);
    };
  }, [boundsForCurrentShell, setStoredHeight, storedHeight]);

  const handleChange = useCallback(
    (grid: PlotGrid) => {
      latestGridRef.current = clonePlotGrid(grid);
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
      persistTimerRef.current = setTimeout(() => {
        persistTimerRef.current = null;
        flush();
      }, PERSIST_DEBOUNCE_MS);
    },
    [flush],
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
      const availableHeight = shell
        ? shell.getBoundingClientRect().bottom - dockTop
        : window.innerHeight - dockTop;
      const next = clampDimension(
        e.clientY - grabOffsetRef.current - dockTop,
        verticalDockBounds(availableHeight, MIN_DOCK_HEIGHT, MIN_PROSE_HEIGHT),
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

  const fallbackContainerHeight =
    typeof window === 'undefined' ? 700 : Math.max(0, window.innerHeight - 100);
  const height = clampDimension(
    dragHeight ?? storedHeight ?? DEFAULT_HEIGHT,
    verticalDockBounds(fallbackContainerHeight, MIN_DOCK_HEIGHT, MIN_PROSE_HEIGHT),
  );

  return (
    <div
      className="plot-planner"
      ref={dockRef}
      style={{ height, maxHeight: `calc(100% - ${MIN_PROSE_HEIGHT}px)` }}
    >
      <div className="plot-planner__header">
        <span className="plot-planner__title">{t('plotGrid.title')}</span>
        <button
          type="button"
          className="plot-planner__add"
          title={t('plotGrid.addRow')}
          onClick={() => gridApiRef.current?.addVisual('row')}
        >
          <Plus aria-hidden="true" />
          {t('plotGrid.addRowShort')}
        </button>
        <button
          type="button"
          className="plot-planner__add"
          title={t('plotGrid.addColumn')}
          onClick={() => gridApiRef.current?.addVisual('col')}
        >
          <Plus aria-hidden="true" />
          {t('plotGrid.addColumnShort')}
        </button>
        <button
          type="button"
          className="plot-planner__add plot-planner__fit"
          title={t('plotGrid.fitTitle')}
          onClick={() => gridApiRef.current?.fit()}
        >
          <Maximize2 aria-hidden="true" />
          {t('plotGrid.fit')}
        </button>
      </div>
      <div className="plot-planner__body">
        <PlotGridEditor
          initialJson={initialJson}
          onChange={handleChange}
          presentation="desktop"
          apiRef={gridApiRef}
          initialCellRatio={readLocalPlotGridCellRatio(nodeId)}
          onCellRatioChange={(ratio) => writeLocalPlotGridCellRatio(nodeId, ratio)}
        />
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
