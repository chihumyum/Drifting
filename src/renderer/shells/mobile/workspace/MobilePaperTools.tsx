import { useCallback, useEffect, useRef, useState, type Dispatch } from 'react';
import { useTranslation } from 'react-i18next';
import { Maximize2, Plus, X } from 'lucide-react';
import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';
import {
  PlotGridEditor,
  type PlotGridCellRef,
  type PlotGridEditorApi,
  type PlotGridHeaderRef,
} from '../../../components/editor/PlotGrid';
import {
  readLocalPlotGridCellRatio,
  writeLocalPlotGridCellRatio,
} from '../../../components/editor/plot-grid/plot-grid-cell-ratio-store';
import type { PlotGridCellSize } from '../../../components/editor/plot-grid/plot-grid-layout';
import {
  clonePlotGrid,
  diffPlotGrid,
  readPlotGridProjection,
  type PlotGrid,
  type PlotGridMutation,
} from '../../../domain/plot-grid';
import { useBookContent } from '../../../usecase/useBookContent';
import { useAuthStore } from '../../../store/auth';
import { useMobilePaperPresentation } from './MobilePaperContent';
import { usePaperGlyph } from './mobile-paper-glyph';
import { MobilePlotCellSheet, MobilePlotHeaderSheet } from './MobilePlotSheets';
import type { MobileWorkspaceAction, MobileWorkspaceUiState } from './mobile-workspace-controller';

/** Popover transient ids that let Back close a Plot sheet before the tool. */
export const MOBILE_PLOT_CELL_TRANSIENT_ID = 'tool:plot-cell';
export const MOBILE_PLOT_HEADER_TRANSIENT_ID = 'tool:plot-header';
const TRANSPOSED_STORAGE_KEY = 'plot-grid-transposed';
const CELL_SIZE_STORAGE_PREFIX = 'plot-grid-cell-size:';

function readTransposed(): boolean {
  try {
    return localStorage.getItem(TRANSPOSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** The phone's cell size is a device-local preference per grid, never synced. */
function readLocalCellSize(nodeId: string): PlotGridCellSize | null {
  try {
    const raw = localStorage.getItem(CELL_SIZE_STORAGE_PREFIX + nodeId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PlotGridCellSize>;
    return typeof parsed.cellW === 'number' && typeof parsed.cellH === 'number'
      ? { cellW: parsed.cellW, cellH: parsed.cellH }
      : null;
  } catch {
    return null;
  }
}

function writeLocalCellSize(nodeId: string, size: PlotGridCellSize): void {
  try {
    localStorage.setItem(CELL_SIZE_STORAGE_PREFIX + nodeId, JSON.stringify(size));
  } catch {
    // Preference only.
  }
}

function MobileNormalizedPlotGridEditor({
  nodeId,
  initialJson,
  onPersist,
  transposed,
  selectedCell,
  selectedHeader,
  onCellPress,
  onHeaderPress,
  onApi,
  initialCellSize,
}: {
  nodeId: string;
  initialJson: string;
  onPersist: (nodeId: string, mutations: readonly PlotGridMutation[]) => Promise<unknown>;
  transposed: boolean;
  selectedCell: PlotGridCellRef | null;
  selectedHeader: PlotGridHeaderRef | null;
  onCellPress: (cell: PlotGridCellRef) => void;
  onHeaderPress: (header: PlotGridHeaderRef) => void;
  onApi: (api: PlotGridEditorApi | null) => void;
  initialCellSize: PlotGridCellSize | null;
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const committedGridRef = useRef<PlotGrid | null>(readPlotGridProjection(initialJson));
  const latestGridRef = useRef<PlotGrid | null>(null);
  const persistChainRef = useRef<Promise<void>>(Promise.resolve());
  const onPersistRef = useRef(onPersist);
  useEffect(() => {
    onPersistRef.current = onPersist;
  }, [onPersist]);

  const flush = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
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
        console.error('[PlotGrid] normalized mobile persistence failed:', error);
      });
  }, [nodeId]);

  useEffect(() => flush, [flush]);

  return (
    <PlotGridEditor
      initialJson={initialJson}
      presentation="mobile"
      transposed={transposed}
      selectedCell={selectedCell}
      selectedHeader={selectedHeader}
      onCellPress={onCellPress}
      onHeaderPress={onHeaderPress}
      onApi={onApi}
      persistCellSize={false}
      initialCellSize={initialCellSize}
      fitOnMount={initialCellSize === null}
      onCellSizeChange={(size) => writeLocalCellSize(nodeId, size)}
      initialCellRatio={readLocalPlotGridCellRatio(nodeId)}
      onCellRatioChange={(ratio) => writeLocalPlotGridCellRatio(nodeId, ratio)}
      onChange={(grid) => {
        latestGridRef.current = clonePlotGrid(grid);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(flush, 400);
      }}
    />
  );
}

/**
 * The Plot paper tool: one table filling the floating surface, a header with
 * the row / column orientation switch and the quick add buttons, and two
 * sheets (cell editor, header menu) that the workspace controller can close
 * with Back through popover transients.
 */
export function MobilePaperTools({
  projectId,
  target,
  workspaceUi,
  onWorkspaceUiAction,
  onClose,
}: {
  projectId: string;
  target: WorkspaceTarget;
  workspaceUi: MobileWorkspaceUiState;
  onWorkspaceUiAction: Dispatch<MobileWorkspaceAction>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const presentation = useMobilePaperPresentation(target);
  const glyph = usePaperGlyph(target);
  const userId = useAuthStore((state) => state.user?.id) ?? '';
  const { getContentByNodeId, updatePlotGridByNodeId } = useBookContent({ userId, projectId });
  const nodeId = target.entityType === 'node' ? target.id : null;
  const [initialJson, setInitialJson] = useState<string | null>(null);
  const [transposed, setTransposed] = useState(readTransposed);
  const [cell, setCell] = useState<PlotGridCellRef | null>(null);
  const [header, setHeader] = useState<PlotGridHeaderRef | null>(null);
  const [api, setApi] = useState<PlotGridEditorApi | null>(null);
  const transientId =
    workspaceUi.transient.kind === 'popover' ? workspaceUi.transient.id : null;

  useEffect(() => {
    let active = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reseed per node
    setInitialJson(null);
    if (!nodeId) return () => undefined;
    void getContentByNodeId(nodeId).then(
      (content) => {
        if (active) setInitialJson(content?.plotGridJson ?? '{}');
      },
      () => {
        if (active) setInitialJson('{}');
      },
    );
    return () => {
      active = false;
    };
  }, [getContentByNodeId, nodeId]);

  useEffect(() => {
    try {
      localStorage.setItem(TRANSPOSED_STORAGE_KEY, transposed ? '1' : '0');
    } catch {
      // Preference only.
    }
  }, [transposed]);

  // Back resolves the popover transient first; the sheets follow it.
  const cellDismissed = Boolean(cell) && transientId !== MOBILE_PLOT_CELL_TRANSIENT_ID;
  const headerDismissed = Boolean(header) && transientId !== MOBILE_PLOT_HEADER_TRANSIENT_ID;
  useEffect(() => {
    if (!cellDismissed && !headerDismissed) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- controller-owned dismissal
    setCell((current) => (cellDismissed ? null : current));
    setHeader((current) => (headerDismissed ? null : current));
  }, [cellDismissed, headerDismissed]);

  const openCell = (next: PlotGridCellRef) => {
    setHeader(null);
    setCell(next);
    if (transientId !== MOBILE_PLOT_CELL_TRANSIENT_ID) {
      onWorkspaceUiAction({
        type: 'set-transient',
        transient: { kind: 'popover', id: MOBILE_PLOT_CELL_TRANSIENT_ID },
      });
    }
  };
  const openHeader = (next: PlotGridHeaderRef) => {
    setCell(null);
    setHeader(next);
    if (transientId !== MOBILE_PLOT_HEADER_TRANSIENT_ID) {
      onWorkspaceUiAction({
        type: 'set-transient',
        transient: { kind: 'popover', id: MOBILE_PLOT_HEADER_TRANSIENT_ID },
      });
    }
  };
  const closeSheets = () => {
    setCell(null);
    setHeader(null);
    if (
      transientId === MOBILE_PLOT_CELL_TRANSIENT_ID ||
      transientId === MOBILE_PLOT_HEADER_TRANSIENT_ID
    ) {
      onWorkspaceUiAction({ type: 'set-transient', transient: { kind: 'none' } });
    }
  };

  return (
    <section
      className="m-tools-face m-paper-tool-surface m-plot"
      role="dialog"
      aria-modal="true"
      data-debug-id="mobile-paper-tools"
      data-transposed={transposed ? 'true' : 'false'}
      aria-label={t('mobileWorkspace.paperAgent.plot')}
    >
      <header className="m-tools-face__header m-plot__header">
        <span className="m-tools-face__identity m-plot__identity">
          <span aria-hidden="true">{glyph}</span> {presentation.title} ·{' '}
          {t('mobileWorkspace.paperAgent.plot')}
        </span>
        <div
          className="m-plot__orientation"
          role="group"
          aria-label={t('plotGrid.orientationLabel')}
        >
          <button
            type="button"
            aria-pressed={!transposed}
            onClick={() => setTransposed(false)}
          >
            {t('plotGrid.orientationRow')}
          </button>
          <button type="button" aria-pressed={transposed} onClick={() => setTransposed(true)}>
            {t('plotGrid.orientationColumn')}
          </button>
        </div>
        <button
          type="button"
          className="m-plot__add"
          title={t('plotGrid.addRow')}
          disabled={!api}
          onClick={() => api?.addVisual('row')}
        >
          <Plus size={14} aria-hidden="true" />
          {t('plotGrid.addRowShort')}
        </button>
        <button
          type="button"
          className="m-plot__add"
          title={t('plotGrid.addColumn')}
          disabled={!api}
          onClick={() => api?.addVisual('col')}
        >
          <Plus size={14} aria-hidden="true" />
          {t('plotGrid.addColumnShort')}
        </button>
        <button
          type="button"
          className="m-plot__fit"
          title={t('plotGrid.fitTitle')}
          aria-label={t('plotGrid.fitTitle')}
          disabled={!api}
          onClick={() => api?.fit()}
        >
          <Maximize2 size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="m-tools-face__close"
          onClick={onClose}
          aria-label={t('findPanel.closeTitle')}
        >
          <X size={17} aria-hidden="true" />
        </button>
      </header>
      <div className="m-plot__body" data-sheet={cell ? 'cell' : header ? 'header' : 'none'}>
        {!nodeId ? (
          <div className="m-tool-empty">
            {t('mobileWorkspace.plotNeedsNode', {
              defaultValue: '打开章节或灵感纸张后编辑情节网格。',
            })}
          </div>
        ) : initialJson === null ? (
          <div className="m-tool-empty">{t('common.loading', { defaultValue: '加载中…' })}</div>
        ) : (
          <MobileNormalizedPlotGridEditor
            key={nodeId}
            nodeId={nodeId}
            initialJson={initialJson}
            onPersist={updatePlotGridByNodeId}
            transposed={transposed}
            selectedCell={cell}
            selectedHeader={header}
            onCellPress={openCell}
            onHeaderPress={openHeader}
            onApi={setApi}
            initialCellSize={readLocalCellSize(nodeId)}
          />
        )}
      </div>
      {cell && api && (
        <MobilePlotCellSheet
          api={api}
          cell={cell}
          onCellChange={setCell}
          onClose={closeSheets}
        />
      )}
      {header && api && (
        <MobilePlotHeaderSheet api={api} header={header} onClose={closeSheets} />
      )}
    </section>
  );
}
