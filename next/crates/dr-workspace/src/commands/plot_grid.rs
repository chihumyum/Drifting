//! Plot grids (情节规划): one table per chapter or idea under its page, rows
//! by columns, each cell a slip of plain text (newlines allowed). The 0.1
//! interface's rules (`domain/plot-grid.ts`, `plot-grid-repo.ts`,
//! `PlotGrid.tsx`, `usePlotGridDraft.ts`), which F3 follows where the 0.1
//! Agent tool (one Markdown table replacing the whole grid) differed:
//!
//! - A node without a grid shows an empty 3 × 3 one whose rows and columns
//!   already have their ids (dr-doc's `PlotRowId::default_for` /
//!   `PlotColId::default_for`), so the interface can address them before
//!   anything is stored. `plot_grid.create`, or any first edit, stores it
//!   with dr-doc's seed change (`BookTxn::create_plot_grid`): two devices
//!   storing the grid before they sync get one 3 × 3 grid, and a label
//!   typed on one is never overwritten by the other's late default. It is
//!   never deleted, only cleared; purging the node takes it along.
//! - Rows and columns are addressed by id. A new one goes first or right
//!   after another; labels are any text, empty shows the placeholder, never
//!   trimmed; moving goes first or right after another (not after itself).
//! - Removing a row or column removes its cells too, and the last row or
//!   column cannot go.
//! - A cell holds text as typed; empty text clears it.
//! - 清空 clears every label and every cell; rows, columns and size stay.
//! - Cell size: 120–440 × 56–380, refused outside (the interface clamps
//!   before it asks; `PLOT-GRID`).

use dr_doc::book::Collection;
use dr_model::book::{
    PLOT_CELL_H, PLOT_CELL_W, PLOT_DEFAULT_CELL, PLOT_DEFAULT_LINES, PlotGrid, PlotLine,
};
use dr_model::id::{NodeId, PlotColId, PlotRowId};
use dr_model::pos::PosKey;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::*;
use crate::cx::{EffectAction, Invocation};
use crate::naming::{Place, pos_for};
use crate::registry::Registry;

pub(crate) fn register(r: &mut Registry) {
    r.add::<PlotGridGet>()
        .add::<PlotGridCreate>()
        .add::<PlotGridSize>()
        .add::<PlotGridLineAdd>()
        .add::<PlotGridLineUpdate>()
        .add::<PlotGridLineRemove>()
        .add::<PlotGridCell>()
        .add::<PlotGridClear>();
}

/// The size of a new grid's cells, and its rows and columns.
pub const DEFAULT_CELL: (f64, f64) = PLOT_DEFAULT_CELL;
pub const DEFAULT_LINES: usize = PLOT_DEFAULT_LINES;

/// Rows or columns.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Axis {
    Row,
    Column,
}

#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema)]
pub struct LineInfo {
    pub id: String,
    pub label: String,
    pub pos: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema)]
pub struct CellInfo {
    pub row: String,
    pub column: String,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema)]
pub struct PlotGridInfo {
    pub node: String,
    /// Whether the grid is stored; when not, the rest is the empty 3 × 3
    /// grid to show, with the ids it will be stored with (any edit, or
    /// `plot_grid.create`, stores it).
    pub exists: bool,
    pub cell_w: f64,
    pub cell_h: f64,
    pub rows: Vec<LineInfo>,
    pub columns: Vec<LineInfo>,
    /// Non-empty cells only.
    pub cells: Vec<CellInfo>,
}

impl PlotGridInfo {
    fn of(node: &NodeId, g: Option<&PlotGrid>) -> Self {
        let Some(g) = g else {
            return PlotGridInfo {
                exists: false,
                ..PlotGridInfo::of(node, Some(&default_grid(node)))
            };
        };
        let line = |id: String, pos: &Option<PosKey>, label: &str| LineInfo {
            id,
            label: label.to_string(),
            pos: pos.as_ref().map(|p| p.to_string()),
        };
        PlotGridInfo {
            node: node.to_string(),
            exists: true,
            cell_w: g.cell_w.clamp(*PLOT_CELL_W.start(), *PLOT_CELL_W.end()),
            cell_h: g.cell_h.clamp(*PLOT_CELL_H.start(), *PLOT_CELL_H.end()),
            rows: g
                .rows
                .iter()
                .map(|r| line(r.id.to_string(), &r.pos, &r.label))
                .collect(),
            columns: g
                .cols
                .iter()
                .map(|c| line(c.id.to_string(), &c.pos, &c.label))
                .collect(),
            cells: g
                .cells
                .iter()
                .filter(|(_, t)| !t.is_empty())
                .map(|((r, c), t)| CellInfo {
                    row: r.to_string(),
                    column: c.to_string(),
                    text: t.clone(),
                })
                .collect(),
        }
    }
}

/// A live chapter or idea.
fn node_of(slot: &BookSlot, id: &str) -> Result<NodeId> {
    let n: NodeId = pid("node", id)?;
    match nodes(slot).get(&n) {
        Some(node) if !node.is_trashed() => Ok(n),
        _ => Err(WsError::not_found("chapter or idea", id)),
    }
}

/// The grid `node` shows before one is stored: what dr-doc's seed change
/// (`BookTxn::create_plot_grid`) writes.
fn default_grid(node: &NodeId) -> PlotGrid {
    fn lines<I>(id: impl Fn(usize) -> I) -> Vec<PlotLine<I>> {
        let mut pos = PosKey::first();
        (1..=DEFAULT_LINES)
            .map(|n| {
                if n > 1 {
                    pos = pos.after();
                }
                PlotLine {
                    id: id(n),
                    pos: Some(pos.clone()),
                    label: String::new(),
                }
            })
            .collect()
    }
    PlotGrid {
        chapter: node.clone(),
        cell_w: DEFAULT_CELL.0,
        cell_h: DEFAULT_CELL.1,
        rows: lines(|n| PlotRowId::default_for(node, n)),
        cols: lines(|n| PlotColId::default_for(node, n)),
        cells: Default::default(),
    }
}

/// `node`'s grid, or the default one it shows before it is stored (a write
/// stores it: [`dr_doc::book::BookTxn::create_plot_grid`] first).
fn grid_of(slot: &BookSlot, node: &NodeId) -> PlotGrid {
    slot.reader
        .view()
        .plot_grid(node)
        .unwrap_or_else(|| default_grid(node))
}

/// One axis's lines as (id, position), in order.
fn lines(g: &PlotGrid, axis: Axis) -> Vec<(String, Option<PosKey>, String)> {
    match axis {
        Axis::Row => g
            .rows
            .iter()
            .map(|l| (l.id.to_string(), l.pos.clone(), l.label.clone()))
            .collect(),
        Axis::Column => g
            .cols
            .iter()
            .map(|l| (l.id.to_string(), l.pos.clone(), l.label.clone()))
            .collect(),
    }
}

fn line_ids(g: &PlotGrid, axis: Axis, except: Option<&str>) -> Vec<(String, Option<PosKey>)> {
    lines(g, axis)
        .into_iter()
        .filter(|(id, _, _)| Some(id.as_str()) != except)
        .map(|(id, p, _)| (id, p))
        .collect()
}

/// `after` = none: first; `after` = an id: right after it.
fn place_after(after: &Option<String>) -> Place {
    match after {
        None => Place::First,
        Some(id) => Place::After(id.clone()),
    }
}

fn write_line(
    txn: &mut dr_doc::book::BookTxn<'_>,
    node: &NodeId,
    axis: Axis,
    id: &str,
    pos: &PosKey,
    label: &str,
) -> Result<()> {
    let w = txn.create_plot_grid(node)?;
    match axis {
        Axis::Row => w.row(&pid::<PlotRowId>("row", id)?, &pos.to_string(), label)?,
        Axis::Column => w.col(&pid::<PlotColId>("column", id)?, &pos.to_string(), label)?,
    };
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct GridIn {
    pub book: String,
    /// The chapter or idea.
    pub node: String,
}

op! {
    PlotGridGet = "plot_grid.get", Read, Shared,
    "Read a chapter's or idea's plot grid: rows, columns and the cells' text (an empty 3 × 3 grid when none is stored yet).",
    fn(cx, input: GridIn) -> PlotGridInfo {
        let slot = cx.book(&input.book)?;
        let node = node_of(&slot, &input.node)?;
        Ok(PlotGridInfo::of(&node, slot.reader.view().plot_grid(&node).as_ref()))
    }
}

op! {
    PlotGridCreate = "plot_grid.create", Write, Book,
    "Store a chapter's or idea's plot grid, three rows by three columns with empty labels, before its first edit; an existing grid is returned as it is.",
    fn(cx, input: GridIn) -> PlotGridInfo {
        let slot = cx.book(&input.book)?;
        let node = node_of(&slot, &input.node)?;
        if let Some(g) = slot.reader.view().plot_grid(&node) {
            cx.undo_nothing();
            return Ok(PlotGridInfo::of(&node, Some(&g)));
        }
        let n2 = node.clone();
        cx.write_book(&slot, move |txn| { txn.create_plot_grid(&n2)?; Ok(()) })?;
        cx.effect(EffectAction::Created, "plot_grid", node.as_str(), None);
        // The undo of the first edit leaves an empty grid, as 0.1 did.
        cx.undo_nothing();
        Ok(PlotGridInfo::of(&node, slot.reader.view().plot_grid(&node).as_ref()))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct GridSizeIn {
    pub book: String,
    pub node: String,
    pub cell_w: f64,
    pub cell_h: f64,
}

op! {
    PlotGridSize = "plot_grid.size", Write, Book,
    "Set the size of a plot grid's cells (120–440 wide, 56–380 high).",
    fn(cx, input: GridSizeIn) -> Done {
        let slot = cx.book(&input.book)?;
        let node = node_of(&slot, &input.node)?;
        let g = grid_of(&slot, &node);
        if !(input.cell_w.is_finite() && input.cell_h.is_finite()) {
            return Err(WsError::invalid("cell size must be finite"));
        }
        dr_model::check::plot_cell_size(input.cell_w, input.cell_h)?;
        let (n2, w, h) = (node.clone(), input.cell_w, input.cell_h);
        cx.write_book(&slot, move |txn| { txn.create_plot_grid(&n2)?.cell_w(w)?.cell_h(h)?; Ok(()) })?;
        cx.effect(EffectAction::Updated, "plot_grid", node.as_str(), None);
        cx.undo_with(Invocation::new("plot_grid.size", GridSizeIn {
            book: input.book.clone(), node: input.node.clone(), cell_w: g.cell_w, cell_h: g.cell_h,
        }));
        Ok(Done { id: input.node })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct LineAddIn {
    pub book: String,
    pub node: String,
    pub axis: Axis,
    /// Right after this row or column; omitted: first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
    #[serde(default)]
    pub label: String,
    /// An exact id and position key (undo uses them; `pos` wins over
    /// `after`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pos: Option<String>,
}

op! {
    PlotGridLineAdd = "plot_grid.line_add", Write, Book,
    "Insert a row or column into a plot grid, first or right after another, with a label (empty shows the placeholder).",
    fn(cx, input: LineAddIn) -> Done {
        let slot = cx.book(&input.book)?;
        let node = node_of(&slot, &input.node)?;
        let g = grid_of(&slot, &node);
        let id = match &input.id {
            Some(i) => {
                if lines(&g, input.axis).iter().any(|(x, _, _)| x == i) {
                    return Err(WsError::Conflict(format!("{i} exists")));
                }
                i.clone()
            }
            None => match input.axis {
                Axis::Row => PlotRowId::new_v7().to_string(),
                Axis::Column => PlotColId::new_v7().to_string(),
            },
        };
        let pos = match &input.pos {
            Some(p) => PosKey::parse(p).map_err(|e| WsError::invalid(e.to_string()))?,
            None => pos_for(&line_ids(&g, input.axis, None), &place_after(&input.after))?,
        };
        let (n2, axis, i2, l2) = (node.clone(), input.axis, id.clone(), input.label.clone());
        cx.write_book(&slot, move |txn| write_line(txn, &n2, axis, &i2, &pos, &l2))?;
        cx.effect(EffectAction::Created, "plot_grid", node.as_str(), None);
        cx.undo_with(Invocation::new("plot_grid.line_remove", LineIn {
            book: input.book.clone(), node: input.node.clone(), axis: input.axis, id: id.clone(),
        }));
        Ok(Done { id })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct LineUpdateIn {
    pub book: String,
    pub node: String,
    pub axis: Axis,
    pub id: String,
    /// A new label (any text; empty shows the placeholder).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Move it: right after this row or column, or first (`null`).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub after: Option<Option<String>>,
    /// An exact position key (undo uses it); wins over `after`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pos: Option<String>,
}

op! {
    PlotGridLineUpdate = "plot_grid.line_update", Write, Book,
    "Rename or move a plot grid's row or column (first, or right after another).",
    fn(cx, input: LineUpdateIn) -> Done {
        let slot = cx.book(&input.book)?;
        let node = node_of(&slot, &input.node)?;
        let g = grid_of(&slot, &node);
        let (_, old_pos, old_label) = lines(&g, input.axis).into_iter().find(|(i, _, _)| *i == input.id)
            .ok_or_else(|| WsError::not_found("row or column", &input.id))?;
        if input.after.as_ref().is_some_and(|a| a.as_deref() == Some(input.id.as_str())) {
            return Err(WsError::invalid("cannot move a row or column after itself"));
        }
        let pos = match (&input.pos, &input.after) {
            (Some(p), _) => Some(PosKey::parse(p).map_err(|e| WsError::invalid(e.to_string()))?),
            (None, Some(after)) => Some(pos_for(&line_ids(&g, input.axis, Some(&input.id)), &place_after(after))?),
            (None, None) => None,
        };
        let new_pos = pos.clone().or_else(|| old_pos.clone()).ok_or_else(|| WsError::invalid("the line has no position; give pos"))?;
        let label = input.label.clone().unwrap_or_else(|| old_label.clone());
        let (n2, axis, i2) = (node.clone(), input.axis, input.id.clone());
        cx.write_book(&slot, move |txn| write_line(txn, &n2, axis, &i2, &new_pos, &label))?;
        cx.effect(if pos.is_some() { EffectAction::Moved } else { EffectAction::Updated }, "plot_grid", node.as_str(), None);
        cx.undo_with(Invocation::new("plot_grid.line_update", LineUpdateIn {
            book: input.book.clone(), node: input.node.clone(), axis: input.axis, id: input.id.clone(),
            label: input.label.as_ref().map(|_| old_label.clone()),
            after: None,
            pos: pos.and(old_pos).map(|p| p.to_string()),
        }));
        Ok(Done { id: input.id })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct LineIn {
    pub book: String,
    pub node: String,
    pub axis: Axis,
    pub id: String,
}

op! {
    PlotGridLineRemove = "plot_grid.line_remove", Write, Book,
    "Remove a plot grid's row or column with its cells (the last row or column cannot go).",
    fn(cx, input: LineIn) -> Done {
        let slot = cx.book(&input.book)?;
        let node = node_of(&slot, &input.node)?;
        let g = grid_of(&slot, &node);
        let all = lines(&g, input.axis);
        let (_, pos, label) = all.iter().find(|(i, _, _)| *i == input.id).cloned()
            .ok_or_else(|| WsError::not_found("row or column", &input.id))?;
        if all.len() <= 1 {
            return Err(WsError::invalid(match input.axis {
                Axis::Row => "a plot grid keeps at least one row",
                Axis::Column => "a plot grid keeps at least one column",
            }));
        }
        // Its cells, as (row, column, text).
        let cells: Vec<(String, String, String)> = g.cells.iter()
            .filter(|((r, c), t)| !t.is_empty() && match input.axis {
                Axis::Row => r.as_str() == input.id,
                Axis::Column => c.as_str() == input.id,
            })
            .map(|((r, c), t)| (r.to_string(), c.to_string(), t.clone()))
            .collect();
        let others: Vec<String> = match input.axis {
            Axis::Row => g.cols.iter().map(|c| c.id.to_string()).collect(),
            Axis::Column => g.rows.iter().map(|r| r.id.to_string()).collect(),
        };
        let (n2, axis, i2) = (node.clone(), input.axis, input.id.clone());
        cx.write_book(&slot, move |txn| {
            let w = txn.create_plot_grid(&n2)?;
            for o in &others {
                let (r, c) = match axis { Axis::Row => (i2.as_str(), o.as_str()), Axis::Column => (o.as_str(), i2.as_str()) };
                w.cell(&pid("row", r)?, &pid("column", c)?, None)?;
            }
            match axis {
                Axis::Row => w.remove_row(&pid("row", &i2)?)?,
                Axis::Column => w.remove_col(&pid("column", &i2)?)?,
            };
            Ok(())
        })?;
        cx.effect(EffectAction::Purged, "plot_grid", node.as_str(), None);
        match pos {
            Some(p) => {
                cx.undo_with(Invocation::new("plot_grid.line_add", LineAddIn {
                    book: input.book.clone(), node: input.node.clone(), axis: input.axis, after: None,
                    label, id: Some(input.id.clone()), pos: Some(p.to_string()),
                }));
                for (row, column, text) in cells {
                    cx.undo_with(Invocation::new("plot_grid.cell", CellIn {
                        book: input.book.clone(), node: input.node.clone(), row, column, text,
                    }));
                }
            }
            None => cx.irreversible(),
        }
        Ok(Done { id: input.id })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct CellIn {
    pub book: String,
    pub node: String,
    pub row: String,
    pub column: String,
    /// The cell's text as typed (newlines allowed); empty clears it.
    pub text: String,
}

op! {
    PlotGridCell = "plot_grid.cell", Write, Book,
    "Write one cell of a plot grid (empty text clears it).",
    fn(cx, input: CellIn) -> Done {
        let slot = cx.book(&input.book)?;
        let node = node_of(&slot, &input.node)?;
        let g = grid_of(&slot, &node);
        let row: PlotRowId = pid("row", &input.row)?;
        let col: PlotColId = pid("column", &input.column)?;
        if !g.rows.iter().any(|r| r.id == row) { return Err(WsError::not_found("row", &input.row)); }
        if !g.cols.iter().any(|c| c.id == col) { return Err(WsError::not_found("column", &input.column)); }
        let old = g.cells.get(&(row.clone(), col.clone())).cloned().unwrap_or_default();
        if old == input.text {
            cx.undo_nothing();
            return Ok(Done { id: input.node });
        }
        let (n2, t2) = (node.clone(), input.text.clone());
        cx.write_book(&slot, move |txn| {
            txn.create_plot_grid(&n2)?.cell(&row, &col, (!t2.is_empty()).then_some(t2.as_str()))?;
            Ok(())
        })?;
        cx.effect(EffectAction::Updated, "plot_grid", node.as_str(), None);
        cx.undo_with(Invocation::new("plot_grid.cell", CellIn { text: old, ..input.clone() }));
        Ok(Done { id: input.node })
    }
}

op! {
    PlotGridClear = "plot_grid.clear", Write, Book,
    "清空: clear every label and every cell of a plot grid; its rows, columns and size stay.",
    fn(cx, input: GridIn) -> Done {
        let slot = cx.book(&input.book)?;
        let node = node_of(&slot, &input.node)?;
        // Nothing stored: nothing to clear.
        let Some(g) = slot.reader.view().plot_grid(&node) else {
            cx.undo_nothing();
            return Ok(Done { id: input.node });
        };
        let n2 = node.clone();
        let (_, before) = cx.write_book(&slot, move |txn| {
            let w = txn.create_plot_grid(&n2)?;
            for r in &g.rows { w.row(&r.id, &r.pos.as_ref().map(|p| p.to_string()).unwrap_or_default(), "")?; }
            for c in &g.cols { w.col(&c.id, &c.pos.as_ref().map(|p| p.to_string()).unwrap_or_default(), "")?; }
            for (r, c) in g.cells.keys() { w.cell(r, c, None)?; }
            Ok(())
        })?;
        cx.effect(EffectAction::Updated, "plot_grid", node.as_str(), None);
        cx.undo_with(super::history::restore_invocation(&input.book, &before,
            vec![(Collection::PlotGrids.root().to_string(), input.node.clone())]));
        Ok(Done { id: input.node })
    }
}
