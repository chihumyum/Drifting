import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { requestConfirmation } from '../../store/confirmation-store';
import {
  clonePlotGrid,
  diffPlotGrid,
  readPlotGridProjection,
  type PlotGrid,
  type PlotGridMutation,
} from '../../domain/plot-grid';
import { PlotGridEditor, type PlotGridEditorApi } from './PlotGrid';
import { clearPlotPlannerGhost, leavePlotPlannerGhost } from './plot-grid/plot-planner-slot';
import {
  readLocalPlotGridCellRatio,
  writeLocalPlotGridCellRatio,
} from './plot-grid/plot-grid-cell-ratio-store';
import '../../../styles/plot-planner.css';
import { BrushIcon } from '../ui/BrushIcon';
import { KindMark } from '../ui/KindMark';
import { BottomPanelHeader } from '../workspaceChrome/BottomPanel';

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

/**
 * The plot planner in the Bottom Panel under the paper, which it shares with
 * the Bottom Timeline: the chapter's own little timeline, its rows as named
 * lanes and its columns as beats (PlotGrid). It fills the panel, whose height
 * and top-edge handle are the timeline's too; its header is the panel's
 * shared header row.
 */
export function PlotPlannerDock({ nodeId, title, color, drift = false, initialJson, onPersist }: PlotPlannerDockProps) {
  const { t } = useTranslation();
  const [isClearPending, setIsClearPending] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const gridApiRef = useRef<PlotGridEditorApi | null>(null);
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

  // Take the place of the planner that left, and leave one in turn: the cleanup
  // runs before this element is removed.
  useLayoutEffect(() => {
    const root = rootRef.current;
    clearPlotPlannerGhost();
    return () => leavePlotPlannerGhost(root);
  }, []);

  return (
    <div ref={rootRef} className="plot-planner">
      <BottomPanelHeader
        start={
          <span className="plot-planner__title">
            {drift ? <KindMark kind="drift" /> : <KindMark kind="chapter" seed={nodeId} color={color} />}
            <span className="plot-planner__chapter">{title || t('common.untitled')}</span>
            <span className="plot-planner__label">{t('plotGrid.title')}</span>
          </span>
        }
        end={
          <>
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
          </>
        }
      />
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
