import { Plus, X } from 'lucide-react';
import { cellKey, type PlotGrid } from '../../domain/plot-grid';

/**
 * The "mini-Excel" grid surface for the in-chapter plot planner. Controlled:
 * the dock owns the PlotGrid state and persists it; this component is a pure
 * renderer of edits. Rows/cols carry author-defined header labels (we impose
 * no meaning). Supports expand/delete and pasting a block straight from Excel
 * (TSV) into a cell.
 */

interface PlotGridEditorProps {
  grid: PlotGrid;
  onChange: (next: PlotGrid) => void;
}

function withCell(grid: PlotGrid, r: number, c: number, text: string): PlotGrid {
  const cells = { ...grid.cells };
  const k = cellKey(r, c);
  if (text.length === 0) delete cells[k];
  else cells[k] = text;
  return { ...grid, cells };
}

function withHeader(grid: PlotGrid, kind: 'row' | 'col', i: number, text: string): PlotGrid {
  const len = kind === 'row' ? grid.rows : grid.cols;
  const existing = kind === 'row' ? grid.rowHeaders : grid.colHeaders;
  const arr = existing ? [...existing] : [];
  while (arr.length < len) arr.push('');
  arr[i] = text;
  return kind === 'row' ? { ...grid, rowHeaders: arr } : { ...grid, colHeaders: arr };
}

function deleteRow(grid: PlotGrid, row: number): PlotGrid {
  if (grid.rows <= 1) return grid;
  const cells: Record<string, string> = {};
  for (const [k, v] of Object.entries(grid.cells)) {
    const [r, c] = k.split(',').map(Number);
    if (r === row) continue;
    cells[cellKey(r > row ? r - 1 : r, c)] = v;
  }
  const rowHeaders = grid.rowHeaders?.filter((_, i) => i !== row);
  return { ...grid, rows: grid.rows - 1, cells, rowHeaders };
}

function deleteCol(grid: PlotGrid, col: number): PlotGrid {
  if (grid.cols <= 1) return grid;
  const cells: Record<string, string> = {};
  for (const [k, v] of Object.entries(grid.cells)) {
    const [r, c] = k.split(',').map(Number);
    if (c === col) continue;
    cells[cellKey(r, c > col ? c - 1 : c)] = v;
  }
  const colHeaders = grid.colHeaders?.filter((_, i) => i !== col);
  return { ...grid, cols: grid.cols - 1, cells, colHeaders };
}

function pasteBlock(grid: PlotGrid, startR: number, startC: number, text: string): PlotGrid {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  // Excel copies trail a single empty line — drop it so we don't add a blank row.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const matrix = lines.map((line) => line.split('\t'));
  const widest = matrix.reduce((m, row) => Math.max(m, row.length), 0);
  const cells = { ...grid.cells };
  matrix.forEach((row, dr) => {
    row.forEach((val, dc) => {
      const k = cellKey(startR + dr, startC + dc);
      if (val.length === 0) delete cells[k];
      else cells[k] = val;
    });
  });
  return {
    ...grid,
    rows: Math.max(grid.rows, startR + matrix.length),
    cols: Math.max(grid.cols, startC + widest),
    cells,
  };
}

export function PlotGridEditor({ grid, onChange }: PlotGridEditorProps) {
  const rows = Array.from({ length: grid.rows }, (_, i) => i);
  const cols = Array.from({ length: grid.cols }, (_, i) => i);

  const handlePaste = (r: number, c: number, e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData('text/plain');
    // Only intercept a multi-cell paste; a plain single value uses the native
    // textarea paste so the cursor/undo behave normally.
    if (text.includes('\t') || text.includes('\n')) {
      e.preventDefault();
      onChange(pasteBlock(grid, r, c, text));
    }
  };

  return (
    <div className="plot-grid">
      <table className="plot-grid__table">
        <thead>
          <tr>
            <th className="plot-grid__corner" />
            {cols.map((c) => (
              <th key={c} className="plot-grid__colhead">
                <textarea
                  className="plot-grid__head-input"
                  rows={1}
                  placeholder={`列 ${c + 1}`}
                  value={grid.colHeaders?.[c] ?? ''}
                  onChange={(e) => onChange(withHeader(grid, 'col', c, e.target.value))}
                />
                {grid.cols > 1 && (
                  <button
                    type="button"
                    className="plot-grid__del"
                    title="删除此列"
                    onClick={() => onChange(deleteCol(grid, c))}
                  >
                    <X size={11} />
                  </button>
                )}
              </th>
            ))}
            <th className="plot-grid__addcell">
              <button
                type="button"
                className="plot-grid__add"
                title="添加列"
                onClick={() => onChange({ ...grid, cols: grid.cols + 1 })}
              >
                <Plus size={13} />
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r}>
              <th className="plot-grid__rowhead">
                <textarea
                  className="plot-grid__head-input"
                  rows={1}
                  placeholder={`行 ${r + 1}`}
                  value={grid.rowHeaders?.[r] ?? ''}
                  onChange={(e) => onChange(withHeader(grid, 'row', r, e.target.value))}
                />
                {grid.rows > 1 && (
                  <button
                    type="button"
                    className="plot-grid__del"
                    title="删除此行"
                    onClick={() => onChange(deleteRow(grid, r))}
                  >
                    <X size={11} />
                  </button>
                )}
              </th>
              {cols.map((c) => (
                <td key={c} className="plot-grid__cell">
                  <textarea
                    className="plot-grid__cell-input"
                    value={grid.cells[cellKey(r, c)] ?? ''}
                    onChange={(e) => onChange(withCell(grid, r, c, e.target.value))}
                    onPaste={(e) => handlePaste(r, c, e)}
                  />
                </td>
              ))}
              <td className="plot-grid__spacer" />
            </tr>
          ))}
          <tr>
            <th className="plot-grid__addcell">
              <button
                type="button"
                className="plot-grid__add"
                title="添加行"
                onClick={() => onChange({ ...grid, rows: grid.rows + 1 })}
              >
                <Plus size={13} />
              </button>
            </th>
            <td colSpan={grid.cols + 1} />
          </tr>
        </tbody>
      </table>
    </div>
  );
}
