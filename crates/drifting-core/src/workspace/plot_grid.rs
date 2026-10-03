//! The in-chapter plot planner (情节规划格): a small grid of author-named
//! rows and columns with text cells, beside a chapter's or drift's prose and
//! never derived from it. Normalized `plot_grid_*` rows are the truth;
//! `node_content.plot_grid_json` is a sparse projection rebuilt after every
//! write. Each command applies a batch of named operations in one original.
use super::*;

#[cfg(test)]
mod tests;

const MIN_CELL_W: f64 = 120.0;
const MAX_CELL_W: f64 = 440.0;
const MIN_CELL_H: f64 = 56.0;
const MAX_CELL_H: f64 = 380.0;
const DEFAULT_CELL_W: f64 = 184.0;
const DEFAULT_CELL_H: f64 = 96.0;
const MAX_TEXT: usize = 10_000;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlotAxis {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlotCell {
    pub row_id: String,
    pub column_id: String,
    pub value: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlotGrid {
    pub node_id: String,
    pub cell_width: f64,
    pub cell_height: f64,
    pub rows: Vec<PlotAxis>,
    pub columns: Vec<PlotAxis>,
    /// Non-empty cells only.
    pub cells: Vec<PlotCell>,
}

/// One named change. Rows and columns are placed after an existing one, or
/// first with `None`.
#[derive(Clone, Debug)]
pub enum PlotGridOp {
    SetSize {
        width: f64,
        height: f64,
    },
    AddRow {
        id: String,
        label: String,
        after: Option<String>,
    },
    SetRowLabel {
        row_id: String,
        label: String,
    },
    MoveRow {
        row_id: String,
        after: Option<String>,
    },
    RemoveRow {
        row_id: String,
    },
    AddColumn {
        id: String,
        label: String,
        after: Option<String>,
    },
    SetColumnLabel {
        column_id: String,
        label: String,
    },
    MoveColumn {
        column_id: String,
        after: Option<String>,
    },
    RemoveColumn {
        column_id: String,
    },
    SetCell {
        row_id: String,
        column_id: String,
        value: String,
    },
}

pub fn plot_grid_document_id(node_id: &str) -> String {
    format!("plot-grid:{node_id}")
}

/// One coordinate has one identity on every device.
fn cell_id(document_id: &str, row_id: &str, column_id: &str) -> String {
    format!(
        "plot-cell:{}:{document_id}{}:{row_id}{column_id}",
        document_id.len(),
        row_id.len()
    )
}

#[derive(Clone, Copy, PartialEq)]
enum Axis {
    Row,
    Column,
}

impl Axis {
    fn table(self) -> &'static str {
        match self {
            Axis::Row => "plot_grid_row",
            Axis::Column => "plot_grid_column",
        }
    }
    fn kind(self) -> &'static str {
        match self {
            Axis::Row => "plot-grid-row",
            Axis::Column => "plot-grid-column",
        }
    }
    fn cell_column(self) -> &'static str {
        match self {
            Axis::Row => "row_id",
            Axis::Column => "column_id",
        }
    }
    fn missing(self) -> &'static str {
        match self {
            Axis::Row => "这一行不存在",
            Axis::Column => "这一列不存在",
        }
    }
}

fn text_ok(value: &str) -> Result<(), String> {
    if value.chars().count() > MAX_TEXT {
        return Err(format!("单元格和标题最多 {MAX_TEXT} 字"));
    }
    Ok(())
}

impl WorkspaceStore<'_> {
    /// The node's grid, or `None` before its first edit.
    pub fn plot_grid(&self, project_id: &str, node_id: &str) -> Result<Option<PlotGrid>, String> {
        self.plot_grid_in(None, project_id, node_id)
    }

    fn plot_grid_in(
        &self,
        tx: Option<u64>,
        project_id: &str,
        node_id: &str,
    ) -> Result<Option<PlotGrid>, String> {
        let document = plot_grid_document_id(node_id);
        let rows = self.query(
            tx,
            r#"
            SELECT d.cell_width,d.cell_height FROM plot_grid_document d
            JOIN book_node n ON n.id=d.node_id AND n.project_id=?
            WHERE d.id=?
        "#,
            vec![text(project_id), text(&document)],
        )?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let axis = |axis: Axis| -> Result<Vec<PlotAxis>, String> {
            self.query(tx, &format!("SELECT id,label FROM {} WHERE document_id=? ORDER BY CAST(position_key AS BLOB),id", axis.table()),
                vec![text(&document)])?
                .iter()
                .map(|row| Ok(PlotAxis { id: string(row, 0)?, label: string(row, 1)? }))
                .collect()
        };
        let cells = self
            .query(tx, "SELECT row_id,column_id,value FROM plot_grid_cell WHERE document_id=? AND value!='' ORDER BY row_id,column_id",
                vec![text(&document)])?
            .iter()
            .map(|row| Ok(PlotCell { row_id: string(row, 0)?, column_id: string(row, 1)?, value: string(row, 2)? }))
            .collect::<Result<Vec<_>, String>>()?;
        Ok(Some(PlotGrid {
            node_id: node_id.into(),
            cell_width: number(row, 0)?,
            cell_height: number(row, 1)?,
            rows: axis(Axis::Row)?,
            columns: axis(Axis::Column)?,
            cells,
        }))
    }

    /// Applies the operations in order in one original; the first refusal
    /// rolls everything back. An operation that changes nothing writes
    /// nothing.
    pub fn apply_plot_grid(
        &self,
        context: &AuthoredProseContext,
        node_id: &str,
        ops: &[PlotGridOp],
    ) -> Result<Option<PlotGrid>, String> {
        validate_context(context)?;
        if ops.is_empty() {
            return Err("Plot grid write requires at least one operation".into());
        }
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let live = self.query(Some(tx), r#"
                SELECT 1 FROM book_node n
                LEFT JOIN sync_entity_lifecycle l ON l.sync_generation_id=? AND l.entity_kind='node' AND l.entity_id=n.id
                WHERE n.id=? AND n.project_id=? AND n.kind IN ('chapter','drift') AND n.deleted_at IS NULL
                    AND (l.state IS NULL OR l.state='live')
            "#, vec![text(&context.sync_generation_id), text(node_id), text(&context.project_id)])?;
            if live.is_empty() {
                return Err("章节或构想不存在或已在回收站".into());
            }
            let document = plot_grid_document_id(node_id);
            let existed = !self.query(Some(tx), "SELECT 1 FROM plot_grid_document WHERE id=?", vec![text(&document)])?.is_empty();
            if !existed {
                self.execute(tx, "INSERT INTO plot_grid_document(id,node_id,cell_width,cell_height) VALUES (?,?,?,?)",
                    vec![text(&document), text(node_id), V::Real(DEFAULT_CELL_W), V::Real(DEFAULT_CELL_H)])?;
            }
            let mut mutations = Vec::new();
            for op in ops {
                self.plot_grid_op(tx, &document, node_id, op, &mut mutations)?;
            }
            if mutations.is_empty() {
                // A batch that changes nothing leaves no grid behind either.
                if !existed {
                    self.execute(tx, "DELETE FROM plot_grid_document WHERE id=?", vec![text(&document)])?;
                }
                return self.plot_grid_in(Some(tx), &context.project_id, node_id);
            }
            let grid = self.plot_grid_in(Some(tx), &context.project_id, node_id)?.ok_or("Plot grid document disappeared")?;
            self.project_plot_grid(tx, context, &grid)?;
            self.commit_changes(tx, context, &mutations, None)?;
            Ok(Some(grid))
        })
    }

    fn plot_grid_op(
        &self,
        tx: u64,
        document: &str,
        node_id: &str,
        op: &PlotGridOp,
        mutations: &mut Vec<journal::Mutation>,
    ) -> Result<(), String> {
        match op {
            PlotGridOp::SetSize { width, height } => {
                if !width.is_finite()
                    || !height.is_finite()
                    || !(MIN_CELL_W..=MAX_CELL_W).contains(width)
                    || !(MIN_CELL_H..=MAX_CELL_H).contains(height)
                {
                    return Err(format!("格子宽度须在 {MIN_CELL_W}–{MAX_CELL_W}、高度须在 {MIN_CELL_H}–{MAX_CELL_H} 之间"));
                }
                let current = self.query(
                    Some(tx),
                    "SELECT cell_width,cell_height FROM plot_grid_document WHERE id=?",
                    vec![text(document)],
                )?;
                if number(&current[0], 0)? == *width && number(&current[0], 1)? == *height {
                    return Ok(());
                }
                self.execute(
                    tx,
                    "UPDATE plot_grid_document SET cell_width=?,cell_height=? WHERE id=?",
                    vec![V::Real(*width), V::Real(*height), text(document)],
                )?;
                mutations.push(journal::Mutation::json(
                    "entity",
                    "node-content",
                    node_id,
                    "tuple.set",
                    json!({"tuple": "plot-grid-size", "value": {"cellH": height, "cellW": width}}),
                ));
            }
            PlotGridOp::AddRow { id, label, after } => self.add_axis(
                tx,
                document,
                Axis::Row,
                id,
                label,
                after.as_deref(),
                mutations,
            )?,
            PlotGridOp::AddColumn { id, label, after } => self.add_axis(
                tx,
                document,
                Axis::Column,
                id,
                label,
                after.as_deref(),
                mutations,
            )?,
            PlotGridOp::SetRowLabel { row_id, label } => {
                self.label_axis(tx, document, Axis::Row, row_id, label, mutations)?
            }
            PlotGridOp::SetColumnLabel { column_id, label } => {
                self.label_axis(tx, document, Axis::Column, column_id, label, mutations)?
            }
            PlotGridOp::MoveRow { row_id, after } => {
                self.move_axis(tx, document, Axis::Row, row_id, after.as_deref(), mutations)?
            }
            PlotGridOp::MoveColumn { column_id, after } => self.move_axis(
                tx,
                document,
                Axis::Column,
                column_id,
                after.as_deref(),
                mutations,
            )?,
            PlotGridOp::RemoveRow { row_id } => {
                self.remove_axis(tx, document, Axis::Row, row_id, mutations)?
            }
            PlotGridOp::RemoveColumn { column_id } => {
                self.remove_axis(tx, document, Axis::Column, column_id, mutations)?
            }
            PlotGridOp::SetCell {
                row_id,
                column_id,
                value,
            } => {
                text_ok(value)?;
                for (axis, id) in [(Axis::Row, row_id), (Axis::Column, column_id)] {
                    if self.axis_key(tx, document, axis, id)?.is_none() {
                        return Err(axis.missing().into());
                    }
                }
                let id = cell_id(document, row_id, column_id);
                let current = self.query(
                    Some(tx),
                    "SELECT value FROM plot_grid_cell WHERE id=?",
                    vec![text(&id)],
                )?;
                match current.first() {
                    Some(row) if string(row, 0)? == *value => {}
                    Some(_) => {
                        self.execute(
                            tx,
                            "UPDATE plot_grid_cell SET value=? WHERE id=?",
                            vec![text(value), text(&id)],
                        )?;
                        mutations.push(journal::Mutation::field(
                            "plot-grid-cell",
                            &id,
                            0,
                            "value",
                            json!(value),
                        ));
                    }
                    None if value.is_empty() => {}
                    None => {
                        self.execute(tx, "INSERT INTO plot_grid_cell(id,document_id,row_id,column_id,value) VALUES (?,?,?,?,?)",
                            vec![text(&id), text(document), text(row_id), text(column_id), text(value)])?;
                        mutations.push(journal::Mutation::create(
                            "plot-grid-cell",
                            &id,
                            json!({"columnId": column_id, "documentId": document, "rowId": row_id}),
                        ));
                        mutations.push(journal::Mutation::field(
                            "plot-grid-cell",
                            &id,
                            0,
                            "value",
                            json!(value),
                        ));
                    }
                }
            }
        }
        Ok(())
    }

    fn axis_key(
        &self,
        tx: u64,
        document: &str,
        axis: Axis,
        id: &str,
    ) -> Result<Option<String>, String> {
        Ok(self
            .query(
                Some(tx),
                &format!(
                    "SELECT position_key FROM {} WHERE id=? AND document_id=?",
                    axis.table()
                ),
                vec![text(id), text(document)],
            )?
            .first()
            .map(|row| string(row, 0))
            .transpose()?)
    }

    /// The key for a place right after `after` (first with `None`),
    /// ignoring `moving` itself.
    fn axis_slot(
        &self,
        tx: u64,
        document: &str,
        axis: Axis,
        after: Option<&str>,
        moving: Option<&str>,
    ) -> Result<String, String> {
        let keys: Vec<(String, String)> = self
            .query(Some(tx), &format!("SELECT id,position_key FROM {} WHERE document_id=? ORDER BY CAST(position_key AS BLOB),id", axis.table()),
                vec![text(document)])?
            .iter()
            .map(|row| Ok((string(row, 0)?, string(row, 1)?)))
            .collect::<Result<Vec<_>, String>>()?
            .into_iter()
            .filter(|(id, _)| Some(id.as_str()) != moving)
            .collect();
        let index = match after {
            None => 0,
            Some(after) => {
                keys.iter()
                    .position(|(id, _)| id == after)
                    .ok_or(axis.missing())?
                    + 1
            }
        };
        let left = index.checked_sub(1).map(|i| keys[i].1.as_str());
        let right = keys.get(index).map(|(_, key)| key.as_str());
        crate::fractional::key_between(left, right)
    }

    #[allow(clippy::too_many_arguments)]
    fn add_axis(
        &self,
        tx: u64,
        document: &str,
        axis: Axis,
        id: &str,
        label: &str,
        after: Option<&str>,
        mutations: &mut Vec<journal::Mutation>,
    ) -> Result<(), String> {
        if !opaque(id) {
            return Err("Invalid plot grid identity".into());
        }
        text_ok(label)?;
        if self.axis_key(tx, document, axis, id)?.is_some() {
            return Err("Plot grid identity already exists".into());
        }
        let key = self.axis_slot(tx, document, axis, after, None)?;
        self.execute(
            tx,
            &format!(
                "INSERT INTO {}(id,document_id,position_key,label) VALUES (?,?,?,?)",
                axis.table()
            ),
            vec![text(id), text(document), text(&key), text(label)],
        )?;
        mutations.push(journal::Mutation::create(
            axis.kind(),
            id,
            json!({"documentId": document}),
        ));
        mutations.push(journal::Mutation::field(
            axis.kind(),
            id,
            0,
            "label",
            json!(label),
        ));
        mutations.push(journal::Mutation::json(
            "order",
            axis.kind(),
            id,
            "order.move",
            json!({"scope": document, "positionKey": key}),
        ));
        Ok(())
    }

    fn label_axis(
        &self,
        tx: u64,
        document: &str,
        axis: Axis,
        id: &str,
        label: &str,
        mutations: &mut Vec<journal::Mutation>,
    ) -> Result<(), String> {
        text_ok(label)?;
        let rows = self.query(
            Some(tx),
            &format!(
                "SELECT label FROM {} WHERE id=? AND document_id=?",
                axis.table()
            ),
            vec![text(id), text(document)],
        )?;
        let current = rows.first().ok_or(axis.missing())?;
        if string(current, 0)? == label {
            return Ok(());
        }
        self.execute(
            tx,
            &format!("UPDATE {} SET label=? WHERE id=?", axis.table()),
            vec![text(label), text(id)],
        )?;
        mutations.push(journal::Mutation::field(
            axis.kind(),
            id,
            0,
            "label",
            json!(label),
        ));
        Ok(())
    }

    fn move_axis(
        &self,
        tx: u64,
        document: &str,
        axis: Axis,
        id: &str,
        after: Option<&str>,
        mutations: &mut Vec<journal::Mutation>,
    ) -> Result<(), String> {
        if after == Some(id) {
            return Err("不能移到自己后面".into());
        }
        self.axis_key(tx, document, axis, id)?
            .ok_or(axis.missing())?;
        // Unchanged when it already sits right after `after`.
        let order: Vec<String> = self
            .query(
                Some(tx),
                &format!(
                    "SELECT id FROM {} WHERE document_id=? ORDER BY CAST(position_key AS BLOB),id",
                    axis.table()
                ),
                vec![text(document)],
            )?
            .iter()
            .map(|row| string(row, 0))
            .collect::<Result<_, _>>()?;
        let at = order.iter().position(|each| each == id).expect("present");
        let previous = at.checked_sub(1).map(|i| order[i].as_str());
        if previous == after {
            return Ok(());
        }
        let key = self.axis_slot(tx, document, axis, after, Some(id))?;
        self.execute(
            tx,
            &format!("UPDATE {} SET position_key=? WHERE id=?", axis.table()),
            vec![text(&key), text(id)],
        )?;
        // An existing entry is re-keyed as a one-entry rebalance.
        mutations.push(journal::Mutation::json(
            "order",
            axis.kind(),
            id,
            "order.rebalance",
            json!({"scope": document, "entries": [{"entityId": id, "positionKey": key}]}),
        ));
        Ok(())
    }

    fn remove_axis(
        &self,
        tx: u64,
        document: &str,
        axis: Axis,
        id: &str,
        mutations: &mut Vec<journal::Mutation>,
    ) -> Result<(), String> {
        self.axis_key(tx, document, axis, id)?
            .ok_or(axis.missing())?;
        for row in self.query(
            Some(tx),
            &format!(
                "SELECT id FROM plot_grid_cell WHERE document_id=? AND {}=? ORDER BY id",
                axis.cell_column()
            ),
            vec![text(document), text(id)],
        )? {
            let cell = string(&row, 0)?;
            self.execute(
                tx,
                "DELETE FROM plot_grid_cell WHERE id=?",
                vec![text(&cell)],
            )?;
            mutations.push(journal::Mutation::json(
                "entity",
                "plot-grid-cell",
                &cell,
                "entity.purge",
                json!({}),
            ));
        }
        self.execute(
            tx,
            &format!("DELETE FROM {} WHERE id=?", axis.table()),
            vec![text(id)],
        )?;
        mutations.push(journal::Mutation::json(
            "entity",
            axis.kind(),
            id,
            "entity.purge",
            json!({}),
        ));
        Ok(())
    }

    /// `node_content.plot_grid_json`: the renderer's sparse projection.
    fn project_plot_grid(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        grid: &PlotGrid,
    ) -> Result<(), String> {
        let cells: serde_json::Map<String, Value> = grid
            .cells
            .iter()
            .map(|cell| {
                (
                    format!("{}:{}", cell.row_id, cell.column_id),
                    json!(cell.value),
                )
            })
            .collect();
        let projection = json!({
            "rows": grid.rows, "cols": grid.columns, "cells": cells,
            "cellW": grid.cell_width, "cellH": grid.cell_height,
        })
        .to_string();
        let updated = self.gateway.execute(
            "UPDATE node_content SET plot_grid_json=?,updated_at=? WHERE node_id=?".into(),
            vec![
                text(&projection),
                text(&context.now_iso),
                text(&grid.node_id),
            ],
            Some(tx),
            self.client.into(),
        )?;
        if updated.changes == 0 {
            self.execute(tx, "INSERT INTO node_content(node_id,content_json,outline_json,plot_grid_json,created_at,updated_at) VALUES (?,'{}','[]',?,?,?)",
                vec![text(&grid.node_id), text(&projection), text(&context.now_iso), text(&context.now_iso)])?;
        }
        Ok(())
    }
}
