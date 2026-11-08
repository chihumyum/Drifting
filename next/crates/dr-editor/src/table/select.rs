//! Whole cells selected (格子选区): a rectangle of cells the author dragged
//! across, shift-clicked or shift-arrowed into, as the 0.1 client's
//! `prosemirror-tables` cell selection.
//!
//! - **Making one**: drag from one cell into another (back into the first
//!   cell, it is a text selection in that cell again); shift-click another
//!   cell; ⇧ ← → ↑ ↓ with the selection's end at the cell's edge in that
//!   direction; ⌘A in a cell whose text is all selected (or empty) takes
//!   every cell.
//! - **With one**: ⇧ arrows move its far corner a cell at a time; a plain
//!   arrow or Esc ends it, the caret in the cell it reached (or started
//!   from, for Esc).
//!   - ⌘C copies the cells as a table ([`super::clip`]), ⌘X also empties
//!     them.
//!   - Backspace and Delete empty them, as one step.
//!   - ⌘V fills them from the top-left: a copied table or tab-separated
//!     text cell by cell, repeated over the selection when it is smaller
//!     (one value fills every cell); larger, it grows the table as a paste
//!     into a cell does.
//!   - ⌘B ⌘I ⌘U, strikethrough and the highlight put the mark over all of
//!     every cell's text, or take it off when every cell has it already.
//!   - The bar's rows and columns act on the selection's: 删除行 deletes all
//!     of its rows, 加一行 adds one below its last.
//!   - Typing replaces them (as 0.1): the cells are emptied and what was
//!     typed stays alone in the cell the selection started from, one
//!     step with the typing. The input method works as anywhere: the text
//!     goes in at the hidden caret first and the rest goes after.
//!   - Enter and Esc end it, the caret where it was; a click elsewhere or
//!     the caret moving otherwise ends it too.
//! - **The look**: each selected cell washed with the selection colour; no
//!   caret anywhere in the table.
//!
//! The focus stays in the cell the selection started from (its editor has
//! the input method), its caret parked at the press (or the selection's
//! start), so the keys above reach the table's own handlers first, as the
//! other keys of a table do.

use std::ops::Range;

use gpui::{App, Bounds, ClipboardItem, Context, Pixels, Point, Window};
use gpui_prose::input::selection::Selection;
use loro::LoroValue;

use super::{CellKey, Dir, TableView, clip};

/// A rectangle of whole cells: the cell it started from and the one it
/// reaches, by id (so rows and columns added elsewhere keep it).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct CellRange {
    pub(crate) anchor: CellKey,
    pub(crate) head: CellKey,
}

/// The focused cell's caret while cells are selected, and how long its
/// text was then: moved by anything but typing, the cells are no longer
/// selected; typed at, the typing replaces them.
#[derive(Clone, Debug)]
pub(crate) struct Parked {
    pub(crate) key: CellKey,
    pub(crate) sel: Selection,
    pub(crate) len: usize,
}

/// What a selection of cells is extended or moved by.
fn step(dir: Dir, (r, c): (usize, usize), (rows, cols): (usize, usize)) -> (usize, usize) {
    match dir {
        Dir::Left => (r, c.saturating_sub(1)),
        Dir::Right => (r, (c + 1).min(cols.saturating_sub(1))),
        Dir::Up => (r.saturating_sub(1), c),
        Dir::Down => ((r + 1).min(rows.saturating_sub(1)), c),
    }
}

/// The `rows` × `cols` part of `grid`.
fn rect<T: Clone>(grid: &[Vec<T>], rows: &Range<usize>, cols: &Range<usize>) -> Vec<Vec<T>> {
    grid.get(rows.clone())
        .unwrap_or_default()
        .iter()
        .map(|row| row.get(cols.clone()).map(<[T]>::to_vec).unwrap_or_default())
        .collect()
}

/// `grid` repeated over a `rows` × `cols` rectangle when it is smaller
/// (the 0.1 client's `clipCells`); a larger grid stays as it is.
pub(crate) fn tile<T: Clone + Default>(grid: &[Vec<T>], rows: usize, cols: usize) -> Vec<Vec<T>> {
    let gh = grid.len().max(1);
    let gw = grid.iter().map(Vec::len).max().unwrap_or(0).max(1);
    let (h, w) = (rows.max(gh), cols.max(gw));
    (0..h)
        .map(|r| {
            (0..w)
                .map(|c| {
                    grid.get(r % gh)
                        .and_then(|row| row.get(c % gw))
                        .cloned()
                        .unwrap_or_default()
                })
                .collect()
        })
        .collect()
}

impl TableView {
    /// The selected cells: their rows and columns (by index).
    pub fn selected_cells(&self) -> Option<(Range<usize>, Range<usize>)> {
        let sel = self.cell_sel.as_ref()?;
        let (ar, ac) = self.index_of(&sel.anchor)?;
        let (hr, hc) = self.index_of(&sel.head)?;
        Some((ar.min(hr)..ar.max(hr) + 1, ac.min(hc)..ac.max(hc) + 1))
    }

    /// Where cell (`row`, `col`) was drawn in the last frame.
    pub fn cell_bounds(&self, row: usize, col: usize) -> Option<Bounds<Pixels>> {
        let key = self.key_at(row, col)?;
        self.cells.get(&key)?.bounds.get()
    }

    pub(crate) fn is_cell_selected(&self, key: &CellKey) -> bool {
        let (Some((rows, cols)), Some((r, c))) = (self.selected_cells(), self.index_of(key)) else {
            return false;
        };
        rows.contains(&r) && cols.contains(&c)
    }

    /// The cell under `point` (window coordinates).
    pub(crate) fn cell_at(&self, point: Point<Pixels>) -> Option<CellKey> {
        self.cells
            .iter()
            .find(|(_, v)| v.bounds.get().is_some_and(|b| b.contains(&point)))
            .map(|(k, _)| k.clone())
    }

    /// Selects the cells from (`anchor`) to (`head`), by index; the caret
    /// stays (hidden) in the cell the author is in, else in `anchor`.
    pub fn select_cells(
        &mut self,
        anchor: (usize, usize),
        head: (usize, usize),
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.sync(window, cx);
        let (Some(a), Some(h)) = (self.key_at(anchor.0, anchor.1), self.key_at(head.0, head.1))
        else {
            return;
        };
        if self.focused(window, cx).is_none() {
            self.focus_cell(anchor.0, anchor.1, false, window, cx);
        }
        self.set_cell_selection(a, h, window, cx);
    }

    /// Starts or moves the selection of cells; the focused cell's text
    /// selection collapses to its start (no wash inside a washed cell; a
    /// drag back into the cell selects from the press again).
    pub(crate) fn set_cell_selection(
        &mut self,
        anchor: CellKey,
        head: CellKey,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = CellRange { anchor, head };
        if self.cell_sel.as_ref() == Some(&range) {
            return;
        }
        if self.cell_sel.is_none()
            && let Some(key) = self.focused(window, cx)
        {
            let editor = self.cells[&key].editor.clone();
            let (sel, len) = editor.update(cx, |e, cx| {
                let at = e.selection().anchor;
                e.select(0, at..at, window, cx);
                (e.selection(), e.book().chapters[0].doc.max_cursor())
            });
            self.parked = Some(Parked { key, sel, len });
        }
        self.cell_sel = Some(range);
        cx.notify();
    }

    /// Ends the selection of cells (the caret stays where it is).
    pub(crate) fn end_cell_selection(&mut self, cx: &mut Context<Self>) {
        if self.cell_sel.take().is_some() {
            self.parked = None;
            cx.notify();
        }
    }

    /// A cell editor's selection changed: unless it is the parked caret
    /// (or the input method composing there), the author moved on and the
    /// cells are no longer selected.
    pub(crate) fn cell_selection_moved(&mut self, key: &CellKey, cx: &mut Context<Self>) {
        if self.cell_sel.is_none() {
            return;
        }
        let still = self.parked.as_ref().is_some_and(|p| {
            &p.key == key
                && self.cells.get(key).is_some_and(|v| {
                    let e = v.editor.read(cx);
                    e.selection() == p.sel || e.composition().is_some()
                })
        });
        if !still {
            self.end_cell_selection(cx);
        }
    }

    /// The parked cell was typed in with cells selected (the text went in
    /// at its caret): the selected cells are emptied but for what was
    /// typed, in the typing's step. Returns whether it was.
    pub(crate) fn typed_over(&mut self, key: &CellKey, cx: &mut Context<Self>) -> bool {
        let Some(p) = self.parked.clone().filter(|p| &p.key == key) else {
            return false;
        };
        if self.cell_sel.is_none() {
            return false;
        }
        let len = self
            .cells
            .get(key)
            .map_or(0, |v| v.editor.read(cx).book().chapters[0].doc.max_cursor());
        let at = p.sel.head.min(p.len);
        let typed = len.saturating_sub(p.len);
        let others: Vec<CellKey> = self
            .selected_keys()
            .into_iter()
            .flatten()
            .filter(|k| k != key)
            .collect();
        self.cell_sel = None;
        self.parked = None;
        let (row, col) = key.clone();
        self.write_step(cx, false, move |w| {
            for (r, c) in &others {
                w.set_cell(r, c, "")?;
            }
            let t = w.cell(&row, &col)?;
            if at + typed < len {
                t.delete(at + typed, len - at - typed)?;
            }
            if at > 0 {
                t.delete(0, at)?;
            }
            Ok(())
        });
        true
    }

    /// Enter with cells selected: as Esc. Returns whether the key was
    /// taken.
    pub(crate) fn newline(&mut self, cx: &mut Context<Self>) -> bool {
        self.escape(cx)
    }

    /// A press in cell `key`: a shift-click selects the cells from the one
    /// the author is in; any other press ends a selection of cells and may
    /// start a drag. Returns whether the press was taken (the cell's editor
    /// is not to see it).
    pub(crate) fn press(
        &mut self,
        key: &CellKey,
        shift: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if shift {
            let from = self
                .cell_sel
                .as_ref()
                .map(|s| s.anchor.clone())
                .or_else(|| self.focused(window, cx));
            if let Some(from) = from.filter(|f| f != key) {
                self.drag_from = Some(from.clone());
                self.set_cell_selection(from, key.clone(), window, cx);
                return true;
            }
        }
        self.end_cell_selection(cx);
        self.drag_from = Some(key.clone());
        false
    }

    /// The pointer moved with the button down: into another cell than the
    /// drag's, the cells between are selected; back in the drag's own, its
    /// editor selects text again.
    pub(crate) fn drag_over(
        &mut self,
        point: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(from) = self.drag_from.clone() else {
            return;
        };
        let Some(under) = self.cell_at(point) else {
            return;
        };
        if under == from {
            if self.cell_sel.as_ref().is_some_and(|s| s.anchor == from) {
                self.end_cell_selection(cx);
            }
        } else {
            self.set_cell_selection(from, under, window, cx);
        }
    }

    pub(crate) fn release(&mut self) {
        self.drag_from = None;
    }

    /// Whether the focused cell's selection end sits at its edge in `dir`.
    fn at_edge(&self, key: &CellKey, dir: Dir, cx: &App) -> bool {
        let Some(view) = self.cells.get(key) else {
            return false;
        };
        let e = view.editor.read(cx);
        let head = e.selection().head;
        let max = e.book().chapters[0].doc.max_cursor();
        let one_row = |r: Range<usize>| {
            r.is_empty()
                || e.range_bounds(0, r)
                    .is_none_or(|b| b.size.height < Pixels::from(14.5 * 1.6 * 1.5))
        };
        match dir {
            Dir::Left => head == 0,
            Dir::Right => head >= max,
            Dir::Up => one_row(0..head),
            Dir::Down => one_row(head..max),
        }
    }

    /// ⇧ ← → ↑ ↓: with cells selected, the far corner moves; from a cell
    /// whose selection ends at its edge, the cells from it to its
    /// neighbour are selected. Returns whether the key was taken.
    pub(crate) fn extend(&mut self, dir: Dir, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let size = (self.rows.len(), self.cols.len());
        if let Some(sel) = self.cell_sel.clone() {
            let Some(at) = self.index_of(&sel.head) else {
                return false;
            };
            let to = step(dir, at, size);
            if let Some(head) = self.key_at(to.0, to.1) {
                self.set_cell_selection(sel.anchor, head, window, cx);
            }
            return true;
        }
        let Some(key) = self.focused(window, cx) else {
            return false;
        };
        if !self.at_edge(&key, dir, cx) {
            return false;
        }
        let Some(at) = self.index_of(&key) else {
            return false;
        };
        let to = step(dir, at, size);
        if to == at {
            return false;
        }
        if let Some(head) = self.key_at(to.0, to.1) {
            self.set_cell_selection(key, head, window, cx);
        }
        true
    }

    /// A plain arrow with cells selected: the caret goes to the cell the
    /// selection reached, at its end (→ ↓) or start (← ↑). Returns whether
    /// the key was taken.
    pub(crate) fn collapse(
        &mut self,
        dir: Dir,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(sel) = self.cell_sel.clone() else {
            return false;
        };
        self.end_cell_selection(cx);
        if let Some((r, c)) = self.index_of(&sel.head) {
            self.focus_cell(r, c, matches!(dir, Dir::Right | Dir::Down), window, cx);
        }
        true
    }

    /// Esc with cells selected: back to the caret in the cell it started
    /// from. Returns whether the key was taken.
    pub(crate) fn escape(&mut self, cx: &mut Context<Self>) -> bool {
        if self.cell_sel.is_none() {
            return false;
        }
        self.end_cell_selection(cx);
        true
    }

    /// ⌘A: with cells selected, or in a cell whose text is all selected
    /// (or empty), every cell. Returns whether the key was taken.
    pub(crate) fn select_all(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let whole = self.cell_sel.is_some()
            || self.focused(window, cx).is_some_and(|key| {
                let e = self.cells[&key].editor.read(cx);
                let range = e.selection().range();
                range == (0..e.book().chapters[0].doc.max_cursor())
            });
        if !whole || self.rows.is_empty() || self.cols.is_empty() {
            return false;
        }
        let last = (self.rows.len() - 1, self.cols.len() - 1);
        let (Some(first), Some(last)) = (self.key_at(0, 0), self.key_at(last.0, last.1)) else {
            return false;
        };
        self.set_cell_selection(first, last, window, cx);
        true
    }

    /// The selected cells' keys, row by row.
    fn selected_keys(&self) -> Vec<Vec<CellKey>> {
        let Some((rows, cols)) = self.selected_cells() else {
            return Vec::new();
        };
        rows.filter_map(|r| {
            cols.clone()
                .map(|c| self.key_at(r, c))
                .collect::<Option<Vec<_>>>()
        })
        .collect()
    }

    /// ⌘C / ⌘X with cells selected: the cells as a table, with their
    /// marks. Returns whether the key was taken.
    pub(crate) fn copy_cells(&mut self, cut: bool, cx: &mut Context<Self>) -> bool {
        let Some((rows, cols)) = self.selected_cells() else {
            return false;
        };
        let embed = self.embed.to_string();
        let (cells, marks) = self
            .host
            .handle
            .read(move |doc| super::read_grid(doc, &embed))
            .unwrap_or_default();
        let texts = rect(&cells, &rows, &cols);
        let marks = rect(&marks, &rows, &cols);
        cx.write_to_clipboard(clip::table_item(&texts, &marks));
        if cut {
            self.clear_cells(cx);
        }
        true
    }

    /// Backspace / Delete (and ⌘X) with cells selected: they are emptied,
    /// as one step. Returns whether the key was taken.
    pub(crate) fn clear_cells(&mut self, cx: &mut Context<Self>) -> bool {
        if self.cell_sel.is_none() {
            return false;
        }
        let keys: Vec<CellKey> = self.selected_keys().into_iter().flatten().collect();
        self.write(cx, move |w| {
            for (r, c) in &keys {
                w.set_cell(r, c, "")?;
            }
            Ok(())
        });
        true
    }

    /// ⌘V with cells selected: the clipboard fills them from the top-left
    /// ([`tile`]); the selection then covers what was pasted. Returns
    /// whether the key was taken.
    pub(crate) fn paste_cells(
        &mut self,
        item: &ClipboardItem,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some((rows, cols)) = self.selected_cells() else {
            return false;
        };
        let grid = clip::table_from_clipboard(item)
            .or_else(|| item.text().and_then(|t| clip::parse_grid(&t)))
            .or_else(|| {
                item.text()
                    .map(|t| vec![vec![t.trim_end_matches('\n').to_owned()]])
            });
        let Some(grid) = grid.filter(|g| !g.is_empty()) else {
            return true;
        };
        let marks = tile(&clip::marks_from_clipboard(item), rows.len(), cols.len());
        let tiled = tile(&grid, rows.len(), cols.len());
        let (h, w) = (tiled.len(), tiled.first().map_or(0, Vec::len));
        self.paste_marked(rows.start, cols.start, tiled, marks, window, cx);
        if let (Some(a), Some(b)) = (
            self.key_at(rows.start, cols.start),
            self.key_at(rows.start + h - 1, cols.start + w - 1),
        ) {
            self.cell_sel = Some(CellRange { anchor: a, head: b });
        }
        true
    }

    /// A mark over all of every selected cell's text, or off them all when
    /// every cell with text has it all over already; one step. Returns
    /// whether the key was taken.
    pub(crate) fn format_cells(
        &mut self,
        key: &'static str,
        value: LoroValue,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.cell_sel.is_none() {
            return false;
        }
        let keys: Vec<CellKey> = self.selected_keys().into_iter().flatten().collect();
        let lens: Vec<(CellKey, usize, bool)> = keys
            .into_iter()
            .filter_map(|k| {
                let doc = &self.cells.get(&k)?.editor.read(cx).book().chapters[0].doc;
                let len = doc.max_cursor();
                (len > 0).then(|| (k, len, doc.range_has_mark(0..len, key)))
            })
            .collect();
        if lens.is_empty() {
            return true;
        }
        let off = lens.iter().all(|(_, _, has)| *has);
        self.write(cx, move |w| {
            for ((r, c), len, _) in &lens {
                let t = w.cell(r, c)?;
                if off {
                    t.unmark(0..*len, key)?;
                } else {
                    t.mark(0..*len, key, value.clone())?;
                }
            }
            Ok(())
        });
        true
    }

    /// The rows and columns the bar's buttons act on: the selected cells',
    /// else the focused cell's.
    pub(crate) fn bar_span(&self, row: usize, col: usize) -> (Range<usize>, Range<usize>) {
        self.selected_cells()
            .unwrap_or((row..row + 1, col..col + 1))
    }

    /// No caret in the table while cells are selected.
    pub(crate) fn hides_caret(&self) -> bool {
        self.cell_sel.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn g(rows: &[&[&str]]) -> Vec<Vec<String>> {
        rows.iter()
            .map(|r| r.iter().map(|c| c.to_string()).collect())
            .collect()
    }

    #[test]
    fn a_smaller_grid_repeats_over_the_selection() {
        assert_eq!(tile(&g(&[&["甲"]]), 2, 3), g(&[&["甲"; 3], &["甲"; 3]]));
        assert_eq!(
            tile(&g(&[&["甲", "乙"]]), 2, 4),
            g(&[&["甲", "乙", "甲", "乙"], &["甲", "乙", "甲", "乙"]])
        );
        // Larger than the selection: as it is.
        assert_eq!(
            tile(&g(&[&["a", "b"], &["c", "d"]]), 1, 1),
            g(&[&["a", "b"], &["c", "d"]])
        );
        // Ragged rows: the gaps stay empty.
        assert_eq!(
            tile(&g(&[&["a", "b"], &["c"]]), 2, 2),
            g(&[&["a", "b"], &["c", ""]])
        );
    }
}
