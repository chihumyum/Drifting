import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type TouchEvent as ReactTouchEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { MoreHorizontal } from 'lucide-react';
import type { PlotAxis, PlotGrid } from '../../domain/plot-grid';
import { AnchoredPopover } from '../ui/AnchoredPopover';
import {
  clampPlotGridCellSize,
  fitPlotGridCellSize,
  plotGridCellRatio,
  plotGridCellLineClamp,
  plotGridCellPosition,
  plotGridNeighbor,
  plotGridView,
  resolvePlotGridLayout,
  resolvePlotGridRowHeaderWidth,
  type PlotGridCellPosition,
  type PlotGridCellSize,
  type PlotGridDirection,
  type PlotGridPresentation,
  type PlotGridView,
  type PlotGridVisualAxis,
} from './plot-grid/plot-grid-layout';
import { usePlotGridDraft } from './plot-grid/usePlotGridDraft';
import '../../../styles/plot-planner.css';

/**
 * The shared Plot Grid surface: one contiguous hairline table that fills its
 * host. Desktop writes straight into the cells and edits headers inline; the
 * mobile paper tool hands cell and header presses to its own sheets through
 * `onCellPress` / `onHeaderPress` and drives structure through `apiRef`.
 * Every host action is expressed in SCREEN axes so a transposed view keeps
 * "row" meaning "the thing that runs across".
 */
export interface PlotGridCellRef {
  readonly rowId: string;
  readonly colId: string;
}

export interface PlotGridHeaderRef {
  readonly axis: PlotGridVisualAxis;
  readonly id: string;
}

export interface PlotGridEditorApi {
  addVisual(axis: PlotGridVisualAxis): PlotAxis;
  insertVisual(axis: PlotGridVisualAxis, id: string, side: 'before' | 'after'): PlotAxis | null;
  removeVisual(axis: PlotGridVisualAxis, id: string): boolean;
  moveVisual(axis: PlotGridVisualAxis, id: string, delta: -1 | 1): boolean;
  setLabel(axis: PlotGridVisualAxis, id: string, label: string): void;
  setCell(cell: PlotGridCellRef, text: string): void;
  cellText(cell: PlotGridCellRef): string;
  neighbor(cell: PlotGridCellRef, direction: PlotGridDirection): PlotGridCellRef | null;
  position(cell: PlotGridCellRef): PlotGridCellPosition | null;
  /** Visual row of a data cell: its id and the visual columns to hop across. */
  visualRowOf(cell: PlotGridCellRef): { rowId: string; cols: readonly PlotAxis[] };
  dataCell(visualRowId: string, visualColId: string): PlotGridCellRef;
  axisCount(axis: PlotGridVisualAxis): number;
  /** Filled cells along one visual axis (for the delete warning). */
  filledCells(axis: PlotGridVisualAxis, id: string): number;
  axisLabel(axis: PlotGridVisualAxis, id: string): string;
  axisIndex(axis: PlotGridVisualAxis, id: string): number;
  getGrid(): PlotGrid;
  /** Size the cells so the table fills the host exactly (a one-time action). */
  fit(): void;
  /** True when the current size already fills the host on both axes. */
  isFitted(): boolean;
  getCellSize(): PlotGridCellSize;
  setCellSize(size: PlotGridCellSize): void;
  /** Multiply both dimensions (pinch, zoom shortcuts); clamped per presentation. */
  scaleCellSize(factor: number): void;
}

interface PlotGridEditorProps {
  initialJson: string;
  onChange: (grid: PlotGrid) => void;
  presentation?: PlotGridPresentation;
  transposed?: boolean;
  onCellPress?: (cell: PlotGridCellRef) => void;
  onHeaderPress?: (header: PlotGridHeaderRef) => void;
  selectedCell?: PlotGridCellRef | null;
  selectedHeader?: PlotGridHeaderRef | null;
  apiRef?: RefObject<PlotGridEditorApi | null>;
  /** Hosts that render from the API (mobile sheets) receive it as state. */
  onApi?: (api: PlotGridEditorApi | null) => void;
  /**
   * Cell size ownership. Desktop persists it through the synced record
   * (`size.set`); the mobile tool passes its device-local size and stores
   * every change itself. Without a stored size the host may ask for one fit
   * on mount so the first look is tidy.
   */
  initialCellSize?: PlotGridCellSize | null;
  persistCellSize?: boolean;
  onCellSizeChange?: (size: PlotGridCellSize) => void;
  fitOnMount?: boolean;
  /**
   * The cell ratio (width / height) a hand-set size fixed; fit keeps it and
   * only scales. Hosts store it per grid on this device and report changes.
   */
  initialCellRatio?: number | null;
  onCellRatioChange?: (ratio: number) => void;
}

interface HeaderMenuState {
  axis: PlotGridVisualAxis;
  id: string;
}

let measureContext: CanvasRenderingContext2D | null | undefined;

/** Widest label in px at the header font; 0 outside a DOM (tests, SSR). */
function measureWidestLabel(labels: readonly string[], font: string): number {
  if (typeof document === 'undefined') return 0;
  if (measureContext === undefined) {
    measureContext = document.createElement('canvas').getContext('2d');
  }
  const context = measureContext;
  if (!context) return 0;
  context.font = font;
  let widest = 0;
  for (const label of labels) {
    // Only the longest line of a multi-line label decides the width.
    for (const line of label.split('\n')) {
      widest = Math.max(widest, context.measureText(line).width);
    }
  }
  return widest;
}

function DesktopHeaderLabel({
  value,
  placeholder,
  onCommit,
  focusToken,
}: {
  value: string;
  placeholder: string;
  onCommit: (text: string) => void;
  focusToken: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (focusToken > 0) ref.current?.focus();
  }, [focusToken]);
  return (
    <div
      className="pl-head__text"
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      data-ph={placeholder}
      ref={(el) => {
        ref.current = el;
        if (el && el.textContent !== value) el.textContent = value;
      }}
      onInput={(e) => onCommit(e.currentTarget.textContent || '')}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
    />
  );
}

export function PlotGridEditor({
  initialJson,
  onChange,
  presentation = 'desktop',
  transposed = false,
  onCellPress,
  onHeaderPress,
  selectedCell = null,
  selectedHeader = null,
  apiRef,
  onApi,
  initialCellSize = null,
  persistCellSize = presentation === 'desktop',
  onCellSizeChange,
  fitOnMount = false,
  initialCellRatio = null,
  onCellRatioChange,
}: PlotGridEditorProps) {
  const { t } = useTranslation();
  const draft = usePlotGridDraft(initialJson, onChange, {
    persistSize: persistCellSize,
    initialSize: initialCellSize,
  });
  const view: PlotGridView = useMemo(
    () => plotGridView(draft.grid, transposed),
    [draft.grid, transposed],
  );
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  // Live size while a grip drag or pinch is in flight; committed on release.
  const [liveSize, setLiveSize] = useState<PlotGridCellSize | null>(null);
  const [cellRatio, setCellRatio] = useState<number | null>(initialCellRatio);
  const fittedOnMountRef = useRef(false);
  const [menu, setMenu] = useState<HeaderMenuState | null>(null);
  const [focusToken, setFocusToken] = useState<{ axis: PlotGridVisualAxis; id: string; n: number } | null>(
    null,
  );
  const menuAnchorRef = useRef<HTMLElement | null>(null);
  const mobile = presentation === 'mobile';

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    const measure = () => {
      const rect = wrap.getBoundingClientRect();
      setSize((current) =>
        Math.abs(current.width - rect.width) < 0.5 && Math.abs(current.height - rect.height) < 0.5
          ? current
          : { width: rect.width, height: rect.height },
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  const cellSize = useMemo<PlotGridCellSize>(
    () => liveSize ?? { cellW: draft.grid.cellW, cellH: draft.grid.cellH },
    [draft.grid.cellH, draft.grid.cellW, liveSize],
  );
  // The row header hugs its labels (placeholders count) instead of reserving
  // a fixed column; past the maximum a label wraps rather than widening it.
  const rowHeaderW = useMemo(() => {
    const placeholder = t('plotGrid.rowPlaceholder');
    const labels = view.rows.map((row) => row.label || placeholder);
    const family =
      typeof getComputedStyle === 'function'
        ? getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim()
        : '';
    const font = `${mobile ? 12 : 12.5}px ${family || 'sans-serif'}`;
    return resolvePlotGridRowHeaderWidth(measureWidestLabel(labels, font), presentation);
  }, [mobile, presentation, t, view.rows]);
  const layout = useMemo(
    () =>
      resolvePlotGridLayout({
        width: size.width,
        height: size.height,
        rows: view.rows.length,
        cols: view.cols.length,
        presentation,
        cellSize,
        rowHeaderW,
        ratio: cellRatio,
      }),
    [cellRatio, cellSize, presentation, rowHeaderW, size.height, size.width, view.cols.length, view.rows.length],
  );

  // A size set by hand also fixes the cell ratio, which fit then keeps; a
  // fit itself never changes the ratio.
  const commitSize = useCallback(
    (next: PlotGridCellSize, options?: { byHand?: boolean }) => {
      const clamped = clampPlotGridCellSize(next, presentation);
      draft.setSize(clamped);
      onCellSizeChange?.(clamped);
      if (options?.byHand) {
        const ratio = plotGridCellRatio(clamped);
        setCellRatio(ratio);
        onCellRatioChange?.(ratio);
      }
    },
    [draft, onCellRatioChange, onCellSizeChange, presentation],
  );
  const fit = useCallback(() => {
    if (size.width <= 0 || size.height <= 0) return;
    commitSize(
      fitPlotGridCellSize({
        width: size.width,
        height: size.height,
        rows: view.rows.length,
        cols: view.cols.length,
        presentation,
        rowHeaderW,
        ratio: cellRatio,
      }),
    );
  }, [cellRatio, commitSize, presentation, rowHeaderW, size.height, size.width, view.cols.length, view.rows.length]);
  useEffect(() => {
    if (!fitOnMount || fittedOnMountRef.current || size.width <= 0 || size.height <= 0) return;
    fittedOnMountRef.current = true;
    fit();
  }, [fit, fitOnMount, size.height, size.width]);

  // Desktop corner grip: the table's bottom-right corner moves `count×` per
  // unit of cell size, so the pointer delta is divided by the axis counts.
  const onGripPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const pointerId = e.pointerId;
    const start = { x: e.clientX, y: e.clientY };
    const startSize = { cellW: draft.grid.cellW, cellH: draft.grid.cellH };
    const cols = Math.max(1, view.cols.length);
    const rows = Math.max(1, view.rows.length);
    let last = startSize;
    let frame = 0;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      last = clampPlotGridCellSize(
        {
          cellW: startSize.cellW + (ev.clientX - start.x) / cols,
          cellH: startSize.cellH + (ev.clientY - start.y) / rows,
        },
        presentation,
      );
      if (!frame) {
        frame = window.requestAnimationFrame(() => {
          frame = 0;
          setLiveSize(last);
        });
      }
    };
    const finish = (ev: PointerEvent, commit: boolean) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      if (frame) window.cancelAnimationFrame(frame);
      setLiveSize(null);
      if (commit) commitSize(last, { byHand: true });
    };
    const up = (ev: PointerEvent) => finish(ev, true);
    const cancel = (ev: PointerEvent) => finish(ev, false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  };

  // Mobile pinch, direction-aware so the aspect ratio is adjustable: two
  // fingers that start roughly side by side scale only the width, fingers
  // stacked vertically scale only the height, a diagonal pinch scales both.
  const pinchRef = useRef<{
    dx: number;
    dy: number;
    distance: number;
    axis: 'w' | 'h' | 'both';
    start: PlotGridCellSize;
    last: PlotGridCellSize;
  } | null>(null);
  const touchDelta = (touches: React.TouchList) =>
    touches.length < 2
      ? { dx: 0, dy: 0 }
      : {
          dx: Math.abs(touches[0]!.clientX - touches[1]!.clientX),
          dy: Math.abs(touches[0]!.clientY - touches[1]!.clientY),
        };
  const onPinchStart = (e: ReactTouchEvent<HTMLDivElement>) => {
    if (!mobile || e.touches.length < 2) return;
    const { dx, dy } = touchDelta(e.touches);
    const axis = dx >= dy * 2 ? 'w' : dy >= dx * 2 ? 'h' : 'both';
    const start = { cellW: draft.grid.cellW, cellH: draft.grid.cellH };
    pinchRef.current = { dx, dy, distance: Math.hypot(dx, dy), axis, start, last: start };
  };
  const onPinchMove = (e: ReactTouchEvent<HTMLDivElement>) => {
    const pinch = pinchRef.current;
    if (!pinch || e.touches.length < 2 || pinch.distance <= 0) return;
    if (e.cancelable) e.preventDefault();
    const { dx, dy } = touchDelta(e.touches);
    const ratioW = pinch.axis === 'h' ? 1 : pinch.axis === 'w' ? dx / Math.max(1, pinch.dx) : Math.hypot(dx, dy) / pinch.distance;
    const ratioH = pinch.axis === 'w' ? 1 : pinch.axis === 'h' ? dy / Math.max(1, pinch.dy) : Math.hypot(dx, dy) / pinch.distance;
    pinch.last = clampPlotGridCellSize(
      { cellW: pinch.start.cellW * ratioW, cellH: pinch.start.cellH * ratioH },
      presentation,
    );
    setLiveSize(pinch.last);
  };
  const onPinchEnd = (e: ReactTouchEvent<HTMLDivElement>) => {
    const pinch = pinchRef.current;
    if (!pinch || e.touches.length >= 2) return;
    pinchRef.current = null;
    setLiveSize(null);
    commitSize(pinch.last, { byHand: true });
  };

  // A row or column appended past the visible extent scrolls into view so
  // the new axis is never added off-screen (the table no longer squeezes).
  const [reveal, setReveal] = useState<{ axis: PlotGridVisualAxis; n: number } | null>(null);
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!reveal || !wrap) return;
    if (reveal.axis === 'col') wrap.scrollTo({ left: wrap.scrollWidth, behavior: 'smooth' });
    else wrap.scrollTo({ top: wrap.scrollHeight, behavior: 'smooth' });
  }, [reveal]);
  const revealEnd = useCallback((axis: PlotGridVisualAxis) => {
    setReveal((current) => ({ axis, n: (current?.n ?? 0) + 1 }));
  }, []);

  const api = useMemo<PlotGridEditorApi>(
    () => ({
      addVisual: (axis) => {
        const created = draft.add(view.dataAxis(axis));
        revealEnd(axis);
        return created;
      },
      insertVisual: (axis, id, side) => draft.insert(view.dataAxis(axis), id, side),
      removeVisual: (axis, id) => draft.remove(view.dataAxis(axis), id),
      moveVisual: (axis, id, delta) => draft.move(view.dataAxis(axis), id, delta),
      setLabel: (axis, id, label) => draft.setLabel(view.dataAxis(axis), id, label),
      setCell: (cell, text) => draft.setCell(cell.rowId, cell.colId, text, { rerender: true }),
      cellText: (cell) => draft.cellText(cell.rowId, cell.colId),
      neighbor: (cell, direction) => plotGridNeighbor(view, cell, direction),
      position: (cell) => plotGridCellPosition(view, cell),
      visualRowOf: (cell) => ({
        rowId: view.transposed ? cell.colId : cell.rowId,
        cols: view.cols,
      }),
      dataCell: (visualRowId, visualColId) => view.dataCell(visualRowId, visualColId),
      axisCount: (axis) => (axis === 'row' ? view.rows.length : view.cols.length),
      filledCells: (axis, id) => {
        const opposite = axis === 'row' ? view.cols : view.rows;
        return opposite.filter((other) =>
          axis === 'row' ? view.cellText(id, other.id).length > 0 : view.cellText(other.id, id).length > 0,
        ).length;
      },
      axisLabel: (axis, id) =>
        (axis === 'row' ? view.rows : view.cols).find((item) => item.id === id)?.label ?? '',
      axisIndex: (axis, id) =>
        (axis === 'row' ? view.rows : view.cols).findIndex((item) => item.id === id),
      getGrid: () => draft.grid,
      fit,
      isFitted: () => layout.fitted,
      getCellSize: () => ({ cellW: draft.grid.cellW, cellH: draft.grid.cellH }),
      setCellSize: (next) => commitSize(next, { byHand: true }),
      scaleCellSize: (factor) =>
        commitSize({ cellW: draft.grid.cellW * factor, cellH: draft.grid.cellH * factor }, { byHand: true }),
    }),
    [commitSize, draft, fit, layout.fitted, revealEnd, view],
  );
  useImperativeHandle(apiRef, () => api, [api]);
  useEffect(() => {
    onApi?.(api);
    return () => onApi?.(null);
  }, [api, onApi]);

  // Paste a tab / newline block (straight from Excel) starting at a cell,
  // growing the grid along the screen axes as needed.
  const pasteBlock = useCallback(
    (cell: PlotGridCellRef, text: string) => {
      const lines = text.replace(/\r\n?/g, '\n').split('\n');
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
      const matrix = lines.map((line) => line.split('\t'));
      const widest = matrix.reduce((max, line) => Math.max(max, line.length), 0);
      const visualRowId = view.transposed ? cell.colId : cell.rowId;
      const visualColId = view.transposed ? cell.rowId : cell.colId;
      const startRow = Math.max(0, view.rows.findIndex((row) => row.id === visualRowId));
      const startCol = Math.max(0, view.cols.findIndex((col) => col.id === visualColId));
      const grown = view.transposed
        ? draft.grow(startCol + widest, startRow + matrix.length)
        : draft.grow(startRow + matrix.length, startCol + widest);
      const nextRows = view.transposed ? grown.cols : grown.rows;
      const nextCols = view.transposed ? grown.rows : grown.cols;
      matrix.forEach((line, dr) => {
        line.forEach((value, dc) => {
          const target = view.dataCell(nextRows[startRow + dr]!.id, nextCols[startCol + dc]!.id);
          draft.setCell(target.rowId, target.colId, value, { rerender: true });
        });
      });
    },
    [draft, view],
  );

  const handlePaste = (cell: PlotGridCellRef, e: ReactClipboardEvent) => {
    const text = e.clipboardData.getData('text/plain');
    e.preventDefault();
    if (text.includes('\t') || text.includes('\n')) pasteBlock(cell, text);
    else document.execCommand('insertText', false, text);
  };

  const openMenu = (e: ReactMouseEvent<HTMLButtonElement>, header: HeaderMenuState) => {
    e.stopPropagation();
    menuAnchorRef.current = e.currentTarget;
    setMenu(header);
  };

  const menuItems = (header: HeaderMenuState) => {
    const isRow = header.axis === 'row';
    const count = api.axisCount(header.axis);
    const index = api.axisIndex(header.axis, header.id);
    const filled = api.filledCells(header.axis, header.id);
    const close = () => setMenu(null);
    return [
      {
        key: 'rename',
        label: t('plotGrid.rename'),
        onClick: () => {
          close();
          setFocusToken((current) => ({ axis: header.axis, id: header.id, n: (current?.n ?? 0) + 1 }));
        },
      },
      {
        key: 'move-back',
        label: t(isRow ? 'plotGrid.moveUp' : 'plotGrid.moveLeft'),
        disabled: index <= 0,
        onClick: () => api.moveVisual(header.axis, header.id, -1),
      },
      {
        key: 'move-forward',
        label: t(isRow ? 'plotGrid.moveDown' : 'plotGrid.moveRight'),
        disabled: index >= count - 1,
        onClick: () => api.moveVisual(header.axis, header.id, 1),
      },
      {
        key: 'insert-before',
        label: t(isRow ? 'plotGrid.insertRowAbove' : 'plotGrid.insertColumnLeft'),
        onClick: () => {
          close();
          api.insertVisual(header.axis, header.id, 'before');
        },
      },
      {
        key: 'insert-after',
        label: t(isRow ? 'plotGrid.insertRowBelow' : 'plotGrid.insertColumnRight'),
        onClick: () => {
          close();
          api.insertVisual(header.axis, header.id, 'after');
        },
      },
      {
        key: 'delete',
        label: t(isRow ? 'plotGrid.deleteRow' : 'plotGrid.deleteColumn'),
        hint: filled > 0 ? t('plotGrid.deleteClears', { count: filled }) : undefined,
        danger: true,
        disabled: count <= 1,
        onClick: () => {
          close();
          api.removeVisual(header.axis, header.id);
        },
      },
    ];
  };

  const wrapStyle = {
    '--pl-cell-w': `${layout.cellW}px`,
    '--pl-cell-h': `${layout.cellH}px`,
    '--pl-row-head-w': `${layout.rowHeaderW}px`,
    '--pl-col-head-h': `${layout.colHeaderH}px`,
    '--pl-clamp': String(plotGridCellLineClamp(layout.cellH)),
  } as CSSProperties;

  const renderHeader = (axis: PlotGridVisualAxis, item: PlotAxis) => {
    const isSelected = selectedHeader?.axis === axis && selectedHeader.id === item.id;
    const placeholder = t(axis === 'row' ? 'plotGrid.rowPlaceholder' : 'plotGrid.columnPlaceholder');
    if (mobile) {
      return (
        <button
          type="button"
          className={`pl-head__text pl-head__text--tap${isSelected ? ' is-selected' : ''}`}
          data-empty={item.label ? '0' : '1'}
          onClick={() => onHeaderPress?.({ axis, id: item.id })}
        >
          {item.label || placeholder}
        </button>
      );
    }
    return (
      <>
        <DesktopHeaderLabel
          value={item.label}
          placeholder={placeholder}
          onCommit={(text) => api.setLabel(axis, item.id, text)}
          focusToken={focusToken?.axis === axis && focusToken.id === item.id ? focusToken.n : 0}
        />
        <button
          type="button"
          className="pl-head__menu"
          title={t('plotGrid.headerMenu')}
          aria-label={t('plotGrid.headerMenu')}
          aria-haspopup="menu"
          aria-expanded={menu?.axis === axis && menu.id === item.id}
          onClick={(e) => openMenu(e, { axis, id: item.id })}
        >
          <MoreHorizontal size={14} aria-hidden="true" />
        </button>
      </>
    );
  };

  return (
    <div
      ref={wrapRef}
      className="planner-wrap"
      data-presentation={presentation}
      data-transposed={transposed ? 'true' : 'false'}
      data-scroll-x={layout.scrollX ? 'true' : 'false'}
      data-scroll-y={layout.scrollY ? 'true' : 'false'}
      data-fitted={layout.fitted ? 'true' : 'false'}
      style={wrapStyle}
      onTouchStart={mobile ? onPinchStart : undefined}
      onTouchMove={mobile ? onPinchMove : undefined}
      onTouchEnd={mobile ? onPinchEnd : undefined}
      onTouchCancel={mobile ? onPinchEnd : undefined}
    >
      {liveSize && (
        <span className="pl-size-badge" aria-live="polite">
          {liveSize.cellW} × {liveSize.cellH}
        </span>
      )}
      <div className="pl-table-box" style={{ width: layout.tableW }}>
      <table className="pl-table" style={{ width: layout.tableW }}>
        <colgroup>
          <col style={{ width: layout.rowHeaderW }} />
          {view.cols.map((col) => (
            <col key={col.id} style={{ width: layout.cellW }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className="pl-corner" />
            {view.cols.map((col) => (
              <th className="pl-head pl-head--col" key={col.id} scope="col">
                {renderHeader('col', col)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {view.rows.map((row) => (
            <tr key={row.id}>
              <th className="pl-head pl-head--row" scope="row">
                {renderHeader('row', row)}
              </th>
              {view.cols.map((col) => {
                const cell = view.dataCell(row.id, col.id);
                const text = draft.cellText(cell.rowId, cell.colId);
                const isSelected =
                  selectedCell?.rowId === cell.rowId && selectedCell.colId === cell.colId;
                if (mobile) {
                  return (
                    <td className="pl-cell-td" key={col.id}>
                      <button
                        type="button"
                        className="pl-cell pl-cell--tap"
                        data-empty={text ? '0' : '1'}
                        data-selected={isSelected ? 'true' : 'false'}
                        onClick={() => onCellPress?.(cell)}
                      >
                        {text}
                      </button>
                    </td>
                  );
                }
                return (
                  <td className="pl-cell-td" key={col.id}>
                    <div
                      className="pl-cell"
                      contentEditable
                      suppressContentEditableWarning
                      role="textbox"
                      data-selected={isSelected ? 'true' : 'false'}
                      // Seed / re-sync from the draft in the commit phase; typing
                      // stays uncontrolled so the caret never jumps.
                      ref={(el) => {
                        if (!el) return;
                        const value = draft.cellText(cell.rowId, cell.colId);
                        if (el.textContent !== value) el.textContent = value;
                        el.setAttribute('data-empty', value ? '0' : '1');
                      }}
                      onInput={(e) => {
                        const value = e.currentTarget.textContent || '';
                        e.currentTarget.setAttribute('data-empty', value ? '0' : '1');
                        draft.setCell(cell.rowId, cell.colId, value);
                      }}
                      onPaste={(e) => handlePaste(cell, e)}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {/* Desktop: the grip sits on the table's own corner; the phone resizes by pinch. */}
      {!mobile && (
        <button
          type="button"
          className="pl-resize-grip"
          title={t('plotGrid.resize')}
          aria-label={t('plotGrid.resize')}
          onPointerDown={onGripPointerDown}
        >
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
            <line x1="11" y1="4" x2="4" y2="11" />
            <line x1="11" y1="8" x2="8" y2="11" />
          </svg>
        </button>
      )}
      </div>

      {!mobile && menu && (
        <AnchoredPopover
          anchorRef={menuAnchorRef}
          open
          onClose={() => setMenu(null)}
          placement="bottom-start"
          className="menu-surface menu-surface--compact pl-head-menu"
          role="menu"
          ariaLabel={t('plotGrid.headerMenu')}
        >
          {menuItems(menu).map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className={`menu-surface__item${item.danger ? ' menu-surface__item--danger' : ''}`}
              disabled={item.disabled}
              onClick={item.onClick}
            >
              <span>{item.label}</span>
              {item.hint && <small className="pl-head-menu__hint">{item.hint}</small>}
            </button>
          ))}
        </AnchoredPopover>
      )}
    </div>
  );
}
