//! The grid as the planner shows it, and its geometry (the 0.1 client's
//! `plot-grid-layout.ts`, desktop presentation).
//!
//! - Cells have a size of their own (F3's `cell_w` × `cell_h`). Adding rows
//!   or columns never squeezes them: the table grows and the overflowing
//!   axis scrolls. 「适应」 is an action that sizes the cells so the table
//!   fills the panel, stores that size, and leaves it fixed again.
//! - A size set by hand (the corner grip) also fixes the cells' shape
//!   (width over height) for this session; a later fit keeps it and only
//!   scales: close to the shape that fills both axes, the table is
//!   contained; far from it, only the short axis is filled and the long one
//!   scrolls.
//! - The row header hugs its widest label (placeholders count), between 52
//!   and 220 px; a longer label wraps.
//! - Edits change this model at once (the planner draws them) and go to F3
//!   in order; F3's events read the grid again.

use std::collections::BTreeMap;

use dr_model::book::{PLOT_CELL_H, PLOT_CELL_W};
use dr_workspace::commands::plot_grid::{Axis, DEFAULT_CELL, DEFAULT_LINES, PlotGridInfo};

/// The column header's height.
pub const COL_HEADER_H: f32 = 30.0;
/// The row header's width: default, least and most.
pub const ROW_HEADER_W: f32 = 72.0;
pub const MIN_ROW_HEADER_W: f32 = 52.0;
pub const MAX_ROW_HEADER_W: f32 = 220.0;
/// Around a row label: 14 px in from the edge, 8 px short of the columns,
/// the label's own 4 px each side.
pub const ROW_HEADER_PAD: f32 = 30.0;
/// How far a hand-set shape may sit from the one that fills both axes
/// before a fit stops containing the table and fills the short axis only.
pub const FIT_RATIO_TOLERANCE: f32 = 1.5;

/// Where an unstored grid's lines start: `~r0`, `~c0`, … until
/// `plot_grid.create` gives them their ids.
pub const UNSTORED: char = '~';

/// One row or column.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Line {
    pub id: String,
    pub label: String,
}

/// A grid's cells' size, px.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CellSize {
    pub w: f32,
    pub h: f32,
}

/// The grid: rows down, columns across, the cells' text by (row, column).
#[derive(Clone, Debug, PartialEq)]
pub struct Grid {
    /// Stored in the book (else the empty 3 × 3 one, lines `~r0` … `~c2`).
    pub exists: bool,
    pub size: CellSize,
    pub rows: Vec<Line>,
    pub cols: Vec<Line>,
    pub cells: BTreeMap<(String, String), String>,
}

impl Grid {
    /// The empty 3 × 3 grid a chapter shows before its first edit.
    pub fn unstored() -> Grid {
        let lines = |c: char| {
            (0..DEFAULT_LINES)
                .map(|i| Line {
                    id: format!("{UNSTORED}{c}{i}"),
                    label: String::new(),
                })
                .collect()
        };
        Grid {
            exists: false,
            size: CellSize {
                w: DEFAULT_CELL.0 as f32,
                h: DEFAULT_CELL.1 as f32,
            },
            rows: lines('r'),
            cols: lines('c'),
            cells: BTreeMap::new(),
        }
    }

    /// From F3's `plot_grid.get`.
    pub fn from_info(info: &PlotGridInfo) -> Grid {
        if !info.exists {
            return Grid::unstored();
        }
        let lines = |l: &[dr_workspace::commands::plot_grid::LineInfo]| {
            l.iter()
                .map(|l| Line {
                    id: l.id.clone(),
                    label: l.label.clone(),
                })
                .collect()
        };
        Grid {
            exists: true,
            size: CellSize {
                w: info.cell_w as f32,
                h: info.cell_h as f32,
            },
            rows: lines(&info.rows),
            cols: lines(&info.columns),
            cells: info
                .cells
                .iter()
                .map(|c| ((c.row.clone(), c.column.clone()), c.text.clone()))
                .collect(),
        }
    }

    pub fn lines(&self, axis: Axis) -> &[Line] {
        match axis {
            Axis::Row => &self.rows,
            Axis::Column => &self.cols,
        }
    }

    fn lines_mut(&mut self, axis: Axis) -> &mut Vec<Line> {
        match axis {
            Axis::Row => &mut self.rows,
            Axis::Column => &mut self.cols,
        }
    }

    pub fn index(&self, axis: Axis, id: &str) -> Option<usize> {
        self.lines(axis).iter().position(|l| l.id == id)
    }

    pub fn label(&self, axis: Axis, id: &str) -> &str {
        self.lines(axis)
            .iter()
            .find(|l| l.id == id)
            .map_or("", |l| l.label.as_str())
    }

    pub fn cell(&self, row: &str, col: &str) -> &str {
        self.cells
            .get(&(row.to_owned(), col.to_owned()))
            .map_or("", String::as_str)
    }

    /// The cells along a row or column that hold text (「会清空 N 格」).
    pub fn filled(&self, axis: Axis, id: &str) -> usize {
        self.cells
            .iter()
            .filter(|((r, c), t)| {
                !t.is_empty()
                    && match axis {
                        Axis::Row => r == id,
                        Axis::Column => c == id,
                    }
            })
            .count()
    }

    /// The line `index` places before `id` would sit after: `None` puts it
    /// first. (`after` for F3's `line_add` / `line_update`.)
    pub fn after_for(&self, axis: Axis, index: usize) -> Option<String> {
        index
            .checked_sub(1)
            .and_then(|i| self.lines(axis).get(i))
            .map(|l| l.id.clone())
    }

    pub fn set_cell(&mut self, row: &str, col: &str, text: &str) {
        let key = (row.to_owned(), col.to_owned());
        if text.is_empty() {
            self.cells.remove(&key);
        } else {
            self.cells.insert(key, text.to_owned());
        }
    }

    pub fn set_label(&mut self, axis: Axis, id: &str, label: &str) {
        if let Some(l) = self.lines_mut(axis).iter_mut().find(|l| l.id == id) {
            l.label = label.to_owned();
        }
    }

    /// Puts a new line at `index` (clamped).
    pub fn insert(&mut self, axis: Axis, index: usize, line: Line) {
        let lines = self.lines_mut(axis);
        let index = index.min(lines.len());
        lines.insert(index, line);
    }

    /// Moves `id` to `index` (clamped); false when it is not there.
    pub fn move_to(&mut self, axis: Axis, id: &str, index: usize) -> bool {
        let lines = self.lines_mut(axis);
        let Some(from) = lines.iter().position(|l| l.id == id) else {
            return false;
        };
        let line = lines.remove(from);
        let index = index.min(lines.len());
        lines.insert(index, line);
        true
    }

    /// Removes `id` and its cells; the last row or column stays.
    pub fn remove(&mut self, axis: Axis, id: &str) -> bool {
        if self.lines(axis).len() <= 1 || self.index(axis, id).is_none() {
            return false;
        }
        self.lines_mut(axis).retain(|l| l.id != id);
        self.cells.retain(|(r, c), _| match axis {
            Axis::Row => r != id,
            Axis::Column => c != id,
        });
        true
    }

    /// 清空: every label and every cell; rows, columns and size stay.
    pub fn clear(&mut self) {
        for l in self.rows.iter_mut().chain(self.cols.iter_mut()) {
            l.label.clear();
        }
        self.cells.clear();
    }

    /// The ids `plot_grid.create` gave an unstored grid's lines, by
    /// position: `~r0` → the first row's, and so on.
    pub fn stored_ids(&self, stored: &Grid) -> BTreeMap<String, String> {
        let mut map = BTreeMap::new();
        for (mine, theirs) in [(&self.rows, &stored.rows), (&self.cols, &stored.cols)] {
            for (a, b) in mine.iter().zip(theirs.iter()) {
                if a.id.starts_with(UNSTORED) {
                    map.insert(a.id.clone(), b.id.clone());
                }
            }
        }
        map
    }

    /// Renames lines by `map` (after `plot_grid.create`), cells too.
    pub fn rename(&mut self, map: &BTreeMap<String, String>) {
        let id = |s: &String| map.get(s).cloned().unwrap_or_else(|| s.clone());
        for l in self.rows.iter_mut().chain(self.cols.iter_mut()) {
            l.id = id(&l.id);
        }
        self.cells = std::mem::take(&mut self.cells)
            .into_iter()
            .map(|((r, c), t)| ((id(&r), id(&c)), t))
            .collect();
    }
}

/// A size within F3's bounds, whole pixels.
pub fn clamp_size(size: CellSize) -> CellSize {
    let clamp = |v: f32, r: &std::ops::RangeInclusive<f64>| {
        let (lo, hi) = (*r.start() as f32, *r.end() as f32);
        if v.is_finite() {
            v.round().clamp(lo, hi)
        } else {
            lo
        }
    };
    CellSize {
        w: clamp(size.w, &PLOT_CELL_W),
        h: clamp(size.h, &PLOT_CELL_H),
    }
}

/// The row header's width for the widest label, px.
pub fn row_header_width(widest_label: f32) -> f32 {
    let measured = if widest_label.is_finite() {
        widest_label
    } else {
        0.0
    };
    (measured + ROW_HEADER_PAD)
        .ceil()
        .clamp(MIN_ROW_HEADER_W, MAX_ROW_HEADER_W)
}

/// The cell size at which a `rows` × `cols` table fills `width` × `height`
/// (the panel's body, the row header and the column header included),
/// within F3's bounds; with a hand-set `ratio`, the cells only scale.
pub fn fit(
    width: f32,
    height: f32,
    rows: usize,
    cols: usize,
    row_header_w: f32,
    ratio: Option<f32>,
) -> CellSize {
    let rows = rows.max(1) as f32;
    let cols = cols.max(1) as f32;
    let avail_w = (width - row_header_w).max(0.0);
    let avail_h = (height - COL_HEADER_H).max(0.0);
    if let Some(ratio) = ratio.filter(|r| r.is_finite() && *r > 0.0) {
        // Two candidate heights: the one that fills the width at this
        // ratio, the one that fills the height.
        let by_width = avail_w / (cols * ratio);
        let by_height = avail_h / rows;
        let short = by_width.min(by_height);
        let long = by_width.max(by_height);
        let balanced = short > 0.0 && long / short <= FIT_RATIO_TOLERANCE;
        let mut h = if balanced { short } else { long };
        let (min_w, max_w) = (*PLOT_CELL_W.start() as f32, *PLOT_CELL_W.end() as f32);
        let (min_h, max_h) = (*PLOT_CELL_H.start() as f32, *PLOT_CELL_H.end() as f32);
        let lo = min_h.max(min_w / ratio);
        let hi = max_h.min(max_w / ratio);
        if lo <= hi {
            h = h.clamp(lo, hi);
        }
        let h = h.floor();
        return clamp_size(CellSize {
            w: (h * ratio).floor(),
            h,
        });
    }
    clamp_size(CellSize {
        w: (avail_w / cols).floor(),
        h: (avail_h / rows).floor(),
    })
}

/// While the corner grip is dragged: the table's corner moves `count` times
/// per pixel of cell, so the pointer's travel is shared out.
pub fn dragged(start: CellSize, dx: f32, dy: f32, rows: usize, cols: usize) -> CellSize {
    clamp_size(CellSize {
        w: start.w + dx / cols.max(1) as f32,
        h: start.h + dy / rows.max(1) as f32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid() -> Grid {
        let mut g = Grid::unstored();
        g.exists = true;
        g.rows = ["a", "b", "c"]
            .iter()
            .map(|id| Line {
                id: (*id).into(),
                label: id.to_uppercase(),
            })
            .collect();
        g.cols = ["x", "y"]
            .iter()
            .map(|id| Line {
                id: (*id).into(),
                label: String::new(),
            })
            .collect();
        g.set_cell("a", "x", "one");
        g.set_cell("b", "x", "two");
        g.set_cell("b", "y", "three");
        g
    }

    #[test]
    fn an_unstored_grid_is_three_by_three_at_the_default_size() {
        let g = Grid::unstored();
        assert!(!g.exists);
        assert_eq!((g.rows.len(), g.cols.len()), (3, 3));
        assert_eq!(g.size, CellSize { w: 184.0, h: 96.0 });
        assert!(g.rows.iter().all(|l| l.id.starts_with(UNSTORED)));
    }

    #[test]
    fn lines_move_insert_and_go_with_their_cells() {
        let mut g = grid();
        assert_eq!(g.filled(Axis::Row, "b"), 2);
        assert_eq!(g.filled(Axis::Column, "x"), 2);
        assert_eq!(g.after_for(Axis::Row, 0), None);
        assert_eq!(g.after_for(Axis::Row, 2).as_deref(), Some("b"));
        assert!(g.move_to(Axis::Row, "c", 0));
        assert_eq!(
            g.rows.iter().map(|l| l.id.as_str()).collect::<Vec<_>>(),
            ["c", "a", "b"]
        );
        g.insert(
            Axis::Column,
            1,
            Line {
                id: "z".into(),
                label: String::new(),
            },
        );
        assert_eq!(g.index(Axis::Column, "z"), Some(1));
        assert!(g.remove(Axis::Row, "b"));
        assert_eq!(g.cell("b", "y"), "");
        assert_eq!(g.cells.len(), 1);
        assert!(g.remove(Axis::Column, "x"));
        assert!(g.remove(Axis::Column, "z"));
        // The last column stays.
        assert!(!g.remove(Axis::Column, "y"));
        g.clear();
        assert!(g.cells.is_empty());
        assert!(g.rows.iter().all(|l| l.label.is_empty()));
        assert_eq!(g.rows.len(), 2);
    }

    #[test]
    fn an_unstored_grid_takes_the_stored_ids_by_position() {
        let mut mine = Grid::unstored();
        mine.set_cell("~r1", "~c2", "typed before it was stored");
        let stored = grid();
        let map = mine.stored_ids(&stored);
        assert_eq!(map.get("~r0").map(String::as_str), Some("a"));
        assert_eq!(map.get("~c1").map(String::as_str), Some("y"));
        // A third column the stored grid has not: unmapped.
        assert!(!map.contains_key("~c2"));
        mine.rename(&map);
        assert_eq!(mine.rows[1].id, "b");
        assert_eq!(mine.cell("b", "~c2"), "typed before it was stored");
    }

    #[test]
    fn sizes_stay_within_the_books_bounds() {
        assert_eq!(
            clamp_size(CellSize { w: 50.0, h: 1e9 }),
            CellSize { w: 120.0, h: 380.0 }
        );
        assert_eq!(
            clamp_size(CellSize {
                w: f32::NAN,
                h: 99.6
            }),
            CellSize { w: 120.0, h: 100.0 }
        );
        assert_eq!(row_header_width(0.0), MIN_ROW_HEADER_W);
        assert_eq!(row_header_width(40.2), 71.0);
        assert_eq!(row_header_width(900.0), MAX_ROW_HEADER_W);
        // Three rows, two columns: the corner travels 3× and 2×.
        assert_eq!(
            dragged(CellSize { w: 184.0, h: 96.0 }, 40.0, 30.0, 3, 2),
            CellSize { w: 204.0, h: 106.0 }
        );
    }

    #[test]
    fn fit_fills_the_panel_and_keeps_a_hand_set_shape() {
        // 72 + 3 × 200 = 672 wide, 30 + 2 × 100 = 230 high.
        assert_eq!(
            fit(672.0, 230.0, 2, 3, 72.0, None),
            CellSize { w: 200.0, h: 100.0 }
        );
        // Crowded: the least size, and the table scrolls.
        assert_eq!(
            fit(300.0, 100.0, 9, 9, 72.0, None),
            CellSize { w: 120.0, h: 56.0 }
        );
        // A shape of 2:1 close to the panel's: contained.
        assert_eq!(
            fit(672.0, 230.0, 2, 3, 72.0, Some(2.0)),
            CellSize { w: 200.0, h: 100.0 }
        );
        // A tall shape far from it: the cells grow until the width is
        // filled (as far as the bounds allow) and the height scrolls.
        let tall = fit(672.0, 230.0, 2, 3, 72.0, Some(0.5));
        assert_eq!(tall, CellSize { w: 190.0, h: 380.0 });
    }
}
