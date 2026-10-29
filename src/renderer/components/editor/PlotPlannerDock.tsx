import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUiStore } from '../../store/ui-store';
import { requestConfirmation } from '../../store/confirmation-store';
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
import { BrushIcon } from '../ui/BrushIcon';
import { KindMark } from '../ui/KindMark';

const DEFAULT_HEIGHT = 280;
const MIN_DOCK_HEIGHT = 140;
// Keep at least this much prose visible above the dock when resizing.
const MIN_PROSE_HEIGHT = 180;
// Match the prose editor's persist cadence (useEntityEditor PERSIST_DEBOUNCE_MS).
const PERSIST_DEBOUNCE_MS = 400;

interface PlotPlannerDockProps {
  // Mount keyed by nodeId so each chapter/drift gets a fresh instance seeded
  // from its own grid; the binding to nodeId is therefore stable for an
  // instance's whole lifetime (used to route the persist to the right row).
  nodeId: string;
  /** Which chapter (or drift) this is: the dock under the paper follows the focused one. */
  title: string;
  /** The chapter's storyline colour, for its mark. */
  color?: string;
  drift?: boolean;
  initialJson: string;
  onPersist: (nodeId: string, mutations: readonly PlotGridMutation[]) => Promise<unknown>;
}

/** The desk column the dock sits in; its height bounds the dock's. */
function deskColumnOf(dock: HTMLElement | null): HTMLElement | null {
  return dock?.closest<HTMLElement>('.app-mid') ?? null;
}

/**
 * The plot planner in the dock under the paper, which it shares with the
 * Bottom Timeline: the chapter's own little timeline, its rows as named
 * lanes and its columns as beats (PlotGrid). Resized by its top edge, like
 * the timeline.
 */
export function PlotPlannerDock({ nodeId, title, color, drift = false, initialJson, onPersist }: PlotPlannerDockProps) {
  const { t } = useTranslation();
  const storedHeight = useUiStore((s) => s.plotPlannerHeight);
  const setStoredHeight = useUiStore((s) => s.setPlotPlannerHeight);

  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [isClearPending, setIsClearPending] = useState(false);

  const dockRef = useRef<HTMLDivElement>(null);
  const gridApiRef = useRef<PlotGridEditorApi | null>(null);
  const grabOffsetRef = useRef(0);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const committedGridRef = useRef<PlotGrid | null>(readPlotGridProjection(initialJson));
  const latestGridRef = useRef<PlotGrid | null>(null);
  const persistChainRef = useRef<Promise<void>>(Promise.resolve());
  const onPersistRef = useRef(onPersist);
  const clearConfirmationRef = useRef<AbortController | null>(null);
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
  useEffect(() => () => clearConfirmationRef.current?.abort(), []);

  const handleClear = async () => {
    if (clearConfirmationRef.current) return;
    const controller = new AbortController();
    clearConfirmationRef.current = controller;
    setIsClearPending(true);
    try {
      const confirmed = await requestConfirmation(t('plotGrid.clearConfirm'), {
        title: t('plotGrid.clearTitle'),
        confirmLabel: t('plotGrid.clear'),
        destructive: true,
        signal: controller.signal,
      });
      if (!confirmed || controller.signal.aborted) return;
      gridApiRef.current?.clearContents();
      flush();
    } finally {
      clearConfirmationRef.current = null;
      if (!controller.signal.aborted) setIsClearPending(false);
    }
  };

  const boundsForCurrentShell = useCallback(() => {
    const column = deskColumnOf(dockRef.current);
    const availableHeight = column ? column.getBoundingClientRect().height : window.innerHeight;
    return verticalDockBounds(availableHeight, MIN_DOCK_HEIGHT, MIN_PROSE_HEIGHT);
  }, []);

  // Persisted dock heights are only preferences, never layout authority.
  // Re-clamp them after hydration and whenever the desk column changes size
  // (window resize, split changes, etc.).
  useEffect(() => {
    const normalize = () => {
      if (storedHeight === null) return;
      const next = clampDimension(storedHeight, boundsForCurrentShell());
      if (next !== storedHeight) setStoredHeight(next);
    };
    const frame = window.requestAnimationFrame(normalize);
    const shell = deskColumnOf(dockRef.current);
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

  // Resize via the TOP edge, like the Bottom Timeline: dragging up grows the
  // dock. maxH is measured live against the desk column so the prose above
  // keeps MIN_PROSE_HEIGHT.
  useEffect(() => {
    if (!isResizing) return;
    let last: number | null = null;
    const onMove = (e: MouseEvent) => {
      const dock = dockRef.current;
      if (!dock) return;
      const dockBottom = dock.getBoundingClientRect().bottom;
      const next = clampDimension(
        dockBottom - (e.clientY - grabOffsetRef.current),
        boundsForCurrentShell(),
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
  }, [boundsForCurrentShell, isResizing, setStoredHeight]);

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
      style={{ height }}
    >
      <div
        className="plot-planner__resize"
        onMouseDown={(e) => {
          e.preventDefault();
          const rect = dockRef.current?.getBoundingClientRect();
          grabOffsetRef.current = rect ? e.clientY - rect.top : 0;
          setIsResizing(true);
        }}
      />
      <div className="plot-planner__header">
        <span className="plot-planner__title">
          {drift ? <KindMark kind="drift" /> : <KindMark kind="chapter" seed={nodeId} color={color} />}
          <span className="plot-planner__chapter">{title || t('common.untitled')}</span>
          <span className="plot-planner__label">{t('plotGrid.title')}</span>
        </span>
        <button
          type="button"
          className="plot-planner__add"
          title={t('plotGrid.addRow')}
          onClick={() => gridApiRef.current?.addVisual('row')}
        >
          <BrushIcon name="plus" size={13} />
          {t('plotGrid.addRowShort')}
        </button>
        <button
          type="button"
          className="plot-planner__add"
          title={t('plotGrid.addColumn')}
          onClick={() => gridApiRef.current?.addVisual('col')}
        >
          <BrushIcon name="plus" size={13} />
          {t('plotGrid.addColumnShort')}
        </button>
        <button
          type="button"
          className="plot-planner__add plot-planner__fit"
          title={t('plotGrid.fitTitle')}
          onClick={() => gridApiRef.current?.fit()}
        >
          <BrushIcon name="fullscreen" size={13} />
          {t('plotGrid.fit')}
        </button>
        <button
          type="button"
          className="plot-planner__add plot-planner__clear"
          title={t('plotGrid.clearTitle')}
          disabled={isClearPending}
          onClick={() => void handleClear()}
        >
          <BrushIcon name="eraser" size={13} />
          {t('plotGrid.clear')}
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
    </div>
  );
}
