import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  PlotGridCellRef,
  PlotGridEditorApi,
  PlotGridHeaderRef,
} from '../../../components/editor/PlotGrid';
import type { PlotGridDirection } from '../../../components/editor/plot-grid/plot-grid-layout';
import { MobileToolSheet } from './MobileToolSheet';

/**
 * The cell editing face: half the screen above the keyboard, the dimmed table
 * still visible behind it. Header = "row × column" labels; the strip hops
 * along the visual row; four arrows walk to neighbouring cells without
 * returning to the table.
 */
export function MobilePlotCellSheet({
  api,
  cell,
  onCellChange,
  onClose,
}: {
  api: PlotGridEditorApi;
  cell: PlotGridCellRef;
  onCellChange: (cell: PlotGridCellRef) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(() => api.cellText(cell));
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const position = api.position(cell);
  const visualRow = api.visualRowOf(cell);
  const rowLabel = api.axisLabel('row', visualRow.rowId) || t('plotGrid.rowPlaceholder');
  const visualColId =
    visualRow.cols.find((col) => {
      const data = api.dataCell(visualRow.rowId, col.id);
      return data.rowId === cell.rowId && data.colId === cell.colId;
    })?.id ?? '';
  const colLabel = api.axisLabel('col', visualColId) || t('plotGrid.columnPlaceholder');

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the field re-seeds when the host hops to another cell
    setText(api.cellText(cell));
    const field = textareaRef.current;
    if (!field) return;
    field.focus({ preventScroll: true });
    const end = field.value.length;
    field.setSelectionRange(end, end);
  }, [api, cell]);

  const move = (direction: PlotGridDirection) => {
    const next = api.neighbor(cell, direction);
    if (next) onCellChange(next);
  };
  const arrows: Array<[PlotGridDirection, string, string]> = [
    ['left', 'm-plot-nav__l', t('plotGrid.moveLeft')],
    ['right', 'm-plot-nav__r', t('plotGrid.moveRight')],
    ['up', 'm-plot-nav__u', t('plotGrid.moveUp')],
    ['down', 'm-plot-nav__d', t('plotGrid.moveDown')],
  ];

  return (
    <MobileToolSheet
      ariaLabel={t('plotGrid.cellEditor')}
      onClose={onClose}
      keyboardAware
      tall
      className="m-plot-cell"
      debugId="mobile-plot-cell-sheet"
    >
      <header className="m-plot-cell__head">
        <span className="m-plot-cell__label m-plot-cell__label--ink">{rowLabel}</span>
        <span className="m-plot-cell__times" aria-hidden="true">
          ×
        </span>
        <span className="m-plot-cell__label">{colLabel}</span>
        <button type="button" className="m-plot-cell__done" onClick={onClose}>
          {t('plotGrid.done')}
        </button>
      </header>
      <div className="m-plot-cell__strip" role="tablist" aria-label={t('plotGrid.thisRow')}>
        <span className="m-plot-cell__strip-kick">{t('plotGrid.thisRow')}</span>
        {visualRow.cols.map((col) => {
          const target = api.dataCell(visualRow.rowId, col.id);
          const active = target.rowId === cell.rowId && target.colId === cell.colId;
          return (
            <button
              key={col.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`m-plot-cell__strip-item${active ? ' is-active' : ''}`}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => onCellChange(target)}
            >
              {col.label || t('plotGrid.columnPlaceholder')}
            </button>
          );
        })}
      </div>
      <textarea
        ref={textareaRef}
        className="m-plot-cell__field"
        value={text}
        rows={4}
        placeholder={t('plotGrid.emptyCell')}
        onChange={(event) => {
          setText(event.target.value);
          api.setCell(cell, event.target.value);
        }}
        onPaste={(event) => {
          const pasted = event.clipboardData.getData('text/plain');
          if (!pasted.includes('\t') && !pasted.includes('\n')) return;
          // Excel-style blocks expand across neighbouring cells on the host
          // table; the field keeps the first fragment. Same rule as desktop.
          event.preventDefault();
          const lines = pasted.replace(/\r\n?/g, '\n').split('\n');
          if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
          let anchor: PlotGridCellRef | null = cell;
          lines.forEach((line, lineIndex) => {
            let target: PlotGridCellRef | null = anchor;
            line.split('\t').forEach((value, valueIndex) => {
              if (!target) return;
              if (lineIndex === 0 && valueIndex === 0) {
                setText(value);
                api.setCell(cell, value);
              } else {
                api.setCell(target, value);
              }
              target = api.neighbor(target, 'right');
            });
            anchor = anchor ? api.neighbor(anchor, 'down') : null;
          });
        }}
      />
      <footer className="m-plot-cell__nav">
        <div className="m-plot-nav">
          {arrows.map(([direction, className, label]) => (
            <button
              key={direction}
              type="button"
              className={`m-plot-nav__btn ${className}`}
              aria-label={label}
              disabled={!api.neighbor(cell, direction)}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => move(direction)}
            >
              <ArrowLeft size={16} aria-hidden="true" />
            </button>
          ))}
        </div>
        {position && (
          <span className="m-plot-cell__pos">
            {t('plotGrid.cellPosition', {
              row: position.rowIndex,
              rows: position.rowCount,
              col: position.colIndex,
              cols: position.colCount,
            })}
          </span>
        )}
      </footer>
    </MobileToolSheet>
  );
}

/** Header menu: rename, move one slot, insert either side, delete. */
export function MobilePlotHeaderSheet({
  api,
  header,
  onClose,
}: {
  api: PlotGridEditorApi;
  header: PlotGridHeaderRef;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const isRow = header.axis === 'row';
  const label = api.axisLabel(header.axis, header.id);
  const index = api.axisIndex(header.axis, header.id);
  const count = api.axisCount(header.axis);
  const filled = api.filledCells(header.axis, header.id);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(label);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) inputRef.current?.focus();
  }, [renaming]);

  const commitRename = () => {
    api.setLabel(header.axis, header.id, draft.trim());
    setRenaming(false);
  };

  return (
    <MobileToolSheet
      ariaLabel={t('plotGrid.headerMenu')}
      onClose={onClose}
      keyboardAware={renaming}
      className="m-plot-header"
      debugId="mobile-plot-header-sheet"
    >
      <div className="m-sheet__kick">
        {t(isRow ? 'plotGrid.rowHeader' : 'plotGrid.columnHeader')} ·{' '}
        {t('plotGrid.headerPosition', { index: index + 1, count })}
      </div>
      {renaming ? (
        <div className="m-sheet__rename">
          <input
            ref={inputRef}
            value={draft}
            placeholder={t(isRow ? 'plotGrid.rowPlaceholder' : 'plotGrid.columnPlaceholder')}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitRename();
              }
            }}
          />
        </div>
      ) : (
        <div className="m-sheet__title">
          {label || t(isRow ? 'plotGrid.rowPlaceholder' : 'plotGrid.columnPlaceholder')}
        </div>
      )}
      <div className="m-sheet__rows">
        <button type="button" className="m-sheet__row" onClick={() => setRenaming(true)}>
          {t('plotGrid.rename')}
          <span className="m-sheet__row-value">
            {label}
            <ChevronRight size={14} aria-hidden="true" />
          </span>
        </button>
        <div className="m-sheet__row m-sheet__row--static">
          {t('plotGrid.move')}
          <span className="m-sheet__pair">
            <button
              type="button"
              aria-label={t(isRow ? 'plotGrid.moveUp' : 'plotGrid.moveLeft')}
              disabled={index <= 0}
              className={isRow ? 'is-up' : ''}
              onClick={() => api.moveVisual(header.axis, header.id, -1)}
            >
              <ArrowLeft size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label={t(isRow ? 'plotGrid.moveDown' : 'plotGrid.moveRight')}
              disabled={index >= count - 1}
              className={isRow ? 'is-down' : 'is-right'}
              onClick={() => api.moveVisual(header.axis, header.id, 1)}
            >
              <ArrowLeft size={16} aria-hidden="true" />
            </button>
          </span>
        </div>
        <button
          type="button"
          className="m-sheet__row"
          onClick={() => {
            api.insertVisual(header.axis, header.id, 'before');
            onClose();
          }}
        >
          {t(isRow ? 'plotGrid.insertRowAbove' : 'plotGrid.insertColumnLeft')}
        </button>
        <button
          type="button"
          className="m-sheet__row"
          onClick={() => {
            api.insertVisual(header.axis, header.id, 'after');
            onClose();
          }}
        >
          {t(isRow ? 'plotGrid.insertRowBelow' : 'plotGrid.insertColumnRight')}
        </button>
        <button
          type="button"
          className="m-sheet__row m-sheet__row--danger"
          disabled={count <= 1}
          onClick={() => {
            if (api.removeVisual(header.axis, header.id)) onClose();
          }}
        >
          {t(isRow ? 'plotGrid.deleteRow' : 'plotGrid.deleteColumn')}
          <span className="m-sheet__row-sub">
            {count <= 1
              ? t('plotGrid.lastAxis')
              : filled > 0
                ? t('plotGrid.deleteClears', { count: filled })
                : ''}
          </span>
        </button>
      </div>
    </MobileToolSheet>
  );
}
