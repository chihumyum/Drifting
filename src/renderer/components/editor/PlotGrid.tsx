import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  cellKey,
  MAX_CELL_H,
  MAX_CELL_W,
  MIN_CELL_H,
  MIN_CELL_W,
  newAxisId,
  parsePlotGrid,
  type PlotAxis,
  type PlotGrid,
} from '../../domain/plot-grid';

/**
 * The "mini-Excel" grid surface for the in-chapter plot planner. Follows the
 * Claude-design prototype: a centered table whose row/col headers render as
 * borderless *labels* (not dark cells), and content cells render as the shared
 * contiguous hairline grid treatment. No color tagging.
 *
 * Editing model (from the prototype): cell text lives in a ref and is committed
 * imperatively on input, so typing never re-renders and the caret never jumps.
 * Structural edits (add/delete row-col, paste, resize) re-render; cell DOM
 * re-syncs from the ref on each render. `onChange` fires the full grid for the
 * dock to persist.
 *
 * Cell size (cellW × cellH) is uniform and dragged from the table's bottom-right
 * corner grip — this changes both the table's size and its proportions.
 */

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

interface PlotGridEditorProps {
  initialJson: string;
  onChange: (grid: PlotGrid) => void;
}

function HeaderLabel({
  value,
  placeholder,
  onCommit,
}: {
  value: string;
  placeholder: string;
  onCommit: (text: string) => void;
}) {
  return (
    <div
      className="pl-head__text"
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      data-ph={placeholder}
      ref={(el) => {
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

export function PlotGridEditor({ initialJson, onChange }: PlotGridEditorProps) {
  const { t } = useTranslation();
  const [initial] = useState<PlotGrid>(() => parsePlotGrid(initialJson));
  const [rows, setRows] = useState<PlotAxis[]>(initial.rows);
  const [cols, setCols] = useState<PlotAxis[]>(initial.cols);
  const [cellW, setCellW] = useState(initial.cellW);
  const [cellH, setCellH] = useState(initial.cellH);
  // Cell text is held imperatively so typing doesn't re-render (stable caret).
  const cellsRef = useRef<Record<string, string>>(initial.cells);

  const plannerRef = useRef<HTMLDivElement>(null);
  const tbodyRef = useRef<HTMLTableSectionElement>(null);
  const firstCellRef = useRef<HTMLTableCellElement>(null);

  const emit = (next: { rows?: PlotAxis[]; cols?: PlotAxis[]; cellW?: number; cellH?: number }) => {
    onChange({
      rows: next.rows ?? rows,
      cols: next.cols ?? cols,
      cells: cellsRef.current,
      cellW: next.cellW ?? cellW,
      cellH: next.cellH ?? cellH,
    });
  };

  const addCol = () => {
    const next = [...cols, { id: newAxisId('c'), label: '' }];
    setCols(next);
    emit({ cols: next });
  };
  const addRow = () => {
    const next = [...rows, { id: newAxisId('r'), label: '' }];
    setRows(next);
    emit({ rows: next });
  };
  const delCol = (id: string) => {
    if (cols.length <= 1) return;
    for (const r of rows) delete cellsRef.current[cellKey(r.id, id)];
    const next = cols.filter((c) => c.id !== id);
    setCols(next);
    emit({ cols: next });
  };
  const delRow = (id: string) => {
    if (rows.length <= 1) return;
    for (const c of cols) delete cellsRef.current[cellKey(id, c.id)];
    const next = rows.filter((r) => r.id !== id);
    setRows(next);
    emit({ rows: next });
  };
  const setColLabel = (id: string, label: string) => {
    const next = cols.map((c) => (c.id === id ? { ...c, label } : c));
    setCols(next);
    emit({ cols: next });
  };
  const setRowLabel = (id: string, label: string) => {
    const next = rows.map((r) => (r.id === id ? { ...r, label } : r));
    setRows(next);
    emit({ rows: next });
  };

  const setCell = (rowId: string, colId: string, text: string) => {
    const k = cellKey(rowId, colId);
    if (text.length === 0) delete cellsRef.current[k];
    else cellsRef.current[k] = text;
    emit({}); // no setState — caret stays put; persist the current snapshot
  };

  // Paste a tab/newline block (e.g. straight from Excel) starting at a cell,
  // growing rows/cols as needed.
  const pasteBlock = (rowId: string, colId: string, text: string) => {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const matrix = lines.map((l) => l.split('\t'));
    const widest = matrix.reduce((m, r) => Math.max(m, r.length), 0);

    const startR = Math.max(0, rows.findIndex((r) => r.id === rowId));
    const startC = Math.max(0, cols.findIndex((c) => c.id === colId));

    const nextRows = [...rows];
    while (nextRows.length < startR + matrix.length) nextRows.push({ id: newAxisId('r'), label: '' });
    const nextCols = [...cols];
    while (nextCols.length < startC + widest) nextCols.push({ id: newAxisId('c'), label: '' });

    matrix.forEach((line, dr) => {
      line.forEach((val, dc) => {
        const k = cellKey(nextRows[startR + dr].id, nextCols[startC + dc].id);
        if (val.length === 0) delete cellsRef.current[k];
        else cellsRef.current[k] = val;
      });
    });
    setRows(nextRows);
    setCols(nextCols);
    emit({ rows: nextRows, cols: nextCols });
  };

  const handlePaste = (rowId: string, colId: string, e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData('text/plain');
    e.preventDefault();
    if (text.includes('\t') || text.includes('\n')) {
      pasteBlock(rowId, colId, text);
    } else {
      document.execCommand('insertText', false, text);
    }
  };

  // Measure the DATA region (excludes header row/col) into --pl-data-* so the
  // add-row/col bars align to it and the corner grip sits on its bottom-right.
  const measureData = () => {
    const planner = plannerRef.current;
    const tbody = tbodyRef.current;
    const firstCell = firstCellRef.current;
    if (!planner || !tbody || !firstCell) return;
    const p = planner.getBoundingClientRect();
    const b = tbody.getBoundingClientRect();
    const f = firstCell.getBoundingClientRect();
    planner.style.setProperty('--pl-data-top', `${b.top - p.top}px`);
    planner.style.setProperty('--pl-data-h', `${b.height}px`);
    planner.style.setProperty('--pl-data-left', `${f.left - p.left}px`);
    planner.style.setProperty('--pl-data-w', `${b.right - f.left}px`);
  };

  // Drag the bottom-right grip to resize cells (size + proportions). The grip
  // sits at the table's right/bottom edge, which is (count × cell size) from the
  // origin, so the edge moves `count×` per unit cell size — divide the cursor
  // delta accordingly. Horizontal has an extra wrinkle: while the grid is
  // CENTERED, growing a cell pushes both edges out, so the right edge moves at
  // HALF rate (gain = nc/2); once the table overflows and left-aligns it moves
  // at full rate (gain = nc). We detect the regime each frame and accumulate
  // incrementally so a drag crossing the boundary stays exact. Size is applied
  // + re-measured SYNCHRONOUSLY here (no React round-trip, which would lag the
  // grip a frame behind a fast drag); state is committed on release.
  const onGripDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const planner = plannerRef.current;
    if (!planner) return;
    const nc = Math.max(1, cols.length);
    const nr = Math.max(1, rows.length);
    // Accumulate the UNCLAMPED size; clamp only for display. So when a cell is
    // pinned at min/max and the cursor overshoots past the grip, the raw value
    // runs past the limit and the cursor must return all the way back to the
    // grip's real position before the displayed size starts changing again.
    let rawW = cellW;
    let rawH = cellH;
    let lastW = cellW;
    let lastH = cellH;
    let prevX = e.clientX;
    let prevY = e.clientY;
    const move = (ev: MouseEvent) => {
      // Horizontal gain: nc/2 while centered (left margin present), else nc.
      let gainX = nc;
      const wrap = planner.parentElement;
      if (wrap) {
        const padL = parseFloat(getComputedStyle(wrap).paddingLeft) || 0;
        const leftMargin =
          planner.getBoundingClientRect().left - (wrap.getBoundingClientRect().left + padL);
        if (leftMargin > 0.5) gainX = nc / 2;
      }
      rawW += (ev.clientX - prevX) / gainX;
      rawH += (ev.clientY - prevY) / nr;
      prevX = ev.clientX;
      prevY = ev.clientY;
      lastW = clamp(rawW, MIN_CELL_W, MAX_CELL_W);
      lastH = clamp(rawH, MIN_CELL_H, MAX_CELL_H);
      planner.style.setProperty('--pl-cell-w', `${lastW}px`);
      planner.style.setProperty('--pl-cell-h', `${lastH}px`);
      measureData(); // synchronous reflow → grip follows the cursor with no lag
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setCellW(lastW);
      setCellH(lastH);
      emit({ cellW: lastW, cellH: lastH });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  // Keep --pl-data-* in sync on structural/size changes and content-driven
  // resizes (the drag path measures inline; this covers everything else).
  useLayoutEffect(() => {
    const planner = plannerRef.current;
    const tbody = tbodyRef.current;
    if (!planner || !tbody) return;
    measureData();
    const ro = new ResizeObserver(() => measureData());
    ro.observe(tbody);
    ro.observe(planner);
    return () => ro.disconnect();
  }, [rows.length, cols.length, cellW, cellH]);

  const plannerStyle = {
    '--pl-cell-w': `${cellW}px`,
    '--pl-cell-h': `${cellH}px`,
  } as React.CSSProperties;

  return (
    <div className="planner-wrap">
      <div className="planner" ref={plannerRef} style={plannerStyle}>
        <table className="pl-table">
          <thead>
            <tr>
              <th className="pl-corner" />
              {cols.map((c) => (
                <th className="pl-head pl-head--col" key={c.id}>
                  <HeaderLabel value={c.label} placeholder={t('plotGrid.columnPlaceholder')} onCommit={(v) => setColLabel(c.id, v)} />
                  {cols.length > 1 && (
                    <button
                      type="button"
                      className="pl-head__del"
                      title={t('plotGrid.deleteColumn')}
                      onClick={() => delCol(c.id)}
                    >
                      ×
                    </button>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody ref={tbodyRef}>
            {rows.map((r, ri) => (
              <tr key={r.id}>
                <th className="pl-head pl-head--row">
                  <HeaderLabel value={r.label} placeholder={t('plotGrid.rowPlaceholder')} onCommit={(v) => setRowLabel(r.id, v)} />
                  {rows.length > 1 && (
                    <button
                      type="button"
                      className="pl-head__del"
                      title={t('plotGrid.deleteRow')}
                      onClick={() => delRow(r.id)}
                    >
                      ×
                    </button>
                  )}
                </th>
                {cols.map((c, ci) => (
                  <td
                    className="pl-cell-td"
                    key={c.id}
                    ref={ri === 0 && ci === 0 ? firstCellRef : undefined}
                  >
                    <div
                      className="pl-cell"
                      contentEditable
                      suppressContentEditableWarning
                      role="textbox"
                      // Seed/re-sync from the cells ref in the commit phase (not
                      // during render): keeps structural re-renders in sync while
                      // typing stays uncontrolled so the caret never jumps.
                      ref={(el) => {
                        if (!el) return;
                        const v = cellsRef.current[cellKey(r.id, c.id)] || '';
                        if (el.textContent !== v) el.textContent = v;
                        el.setAttribute('data-empty', v ? '0' : '1');
                      }}
                      onInput={(e) => {
                        const txt = e.currentTarget.textContent || '';
                        e.currentTarget.setAttribute('data-empty', txt ? '0' : '1');
                        setCell(r.id, c.id, txt);
                      }}
                      onPaste={(e) => handlePaste(r.id, c.id, e)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        <button type="button" className="pl-add pl-add--col" title={t('plotGrid.addColumn')} onClick={addCol}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <line x1="8" y1="3" x2="8" y2="13" />
            <line x1="3" y1="8" x2="13" y2="8" />
          </svg>
        </button>
        <button type="button" className="pl-add pl-add--row" title={t('plotGrid.addRow')} onClick={addRow}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <line x1="8" y1="3" x2="8" y2="13" />
            <line x1="3" y1="8" x2="13" y2="8" />
          </svg>
        </button>

        <div
          className="pl-resize-grip"
          title={t('plotGrid.resize')}
          onMouseDown={onGripDown}
          aria-hidden="true"
        >
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
            <line x1="11" y1="4" x2="4" y2="11" />
            <line x1="11" y1="8" x2="8" y2="11" />
          </svg>
        </div>
      </div>
    </div>
  );
}
