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
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';
import { MoreHorizontal } from 'lucide-react';
import type { PlotAxis, PlotGrid } from '../../domain/plot-grid';
import { AnchoredPopover } from '../ui/AnchoredPopover';
import {
  plotGridCellLineClamp,
  plotGridCellPosition,
  plotGridNeighbor,
  plotGridView,
  resolvePlotGridLayout,
  type PlotGridCellPosition,
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
}

interface HeaderMenuState {
  axis: PlotGridVisualAxis;
  id: string;
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
}: PlotGridEditorProps) {
  const { t } = useTranslation();
  const draft = usePlotGridDraft(initialJson, onChange);
  const view: PlotGridView = useMemo(
    () => plotGridView(draft.grid, transposed),
    [draft.grid, transposed],
  );
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
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

  const layout = useMemo(
    () =>
      resolvePlotGridLayout({
        width: size.width,
        height: size.height,
        rows: view.rows.length,
        cols: view.cols.length,
        presentation,
      }),
    [presentation, size.height, size.width, view.cols.length, view.rows.length],
  );

  const api = useMemo<PlotGridEditorApi>(
    () => ({
      addVisual: (axis) => draft.add(view.dataAxis(axis)),
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
    }),
    [draft, view],
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
      style={wrapStyle}
    >
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
