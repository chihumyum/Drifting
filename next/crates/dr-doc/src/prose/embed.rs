//! Table and material embeds: a U+FFFC placeholder in the body plus an entry
//! in the `embeds` map (`loro-schema.md` "表格和素材嵌入").

use std::collections::BTreeMap;

use dr_model::id::{EmbedId, MaterialId};
use loro::{LoroMap, LoroText, LoroValue, ValueOrContainer};

use crate::error::Result;

/// What an embed is.
#[derive(Clone, Debug, PartialEq)]
pub enum EmbedKind {
    /// A table; rows and columns are added through [`TableWriter`].
    Table,
    /// A material shown inline.
    Material(MaterialId),
}

/// One table row or column.
#[derive(Clone, Debug, PartialEq)]
pub struct TableLine {
    pub id: String,
    pub order: f64,
}

/// An embed as read.
#[derive(Clone, Debug, PartialEq)]
pub enum EmbedView {
    Table {
        id: EmbedId,
        /// Sorted by order, ties by id.
        cols: Vec<TableLine>,
        rows: Vec<TableLine>,
        /// `(row, col) → cell text`; cells whose row or column is gone are
        /// left out.
        cells: BTreeMap<(String, String), String>,
    },
    Material {
        id: EmbedId,
        material: Option<MaterialId>,
    },
    /// A kind this version does not know.
    Other { id: EmbedId, kind: String },
}

fn sub_map(m: &LoroMap, key: &str) -> Option<LoroMap> {
    match m.get(key)? {
        ValueOrContainer::Container(loro::Container::Map(m)) => Some(m),
        _ => None,
    }
}

fn str_of(m: &LoroMap, key: &str) -> Option<String> {
    match m.get(key)? {
        ValueOrContainer::Value(LoroValue::String(s)) => Some(s.to_string()),
        _ => None,
    }
}

fn f64_of(m: &LoroMap, key: &str) -> Option<f64> {
    match m.get(key)? {
        ValueOrContainer::Value(LoroValue::Double(d)) => Some(d),
        ValueOrContainer::Value(LoroValue::I64(i)) => Some(i as f64),
        _ => None,
    }
}

fn lines(m: Option<LoroMap>) -> Vec<TableLine> {
    let mut out = Vec::new();
    if let Some(m) = m {
        m.for_each(|k, v| {
            let order = match &v {
                ValueOrContainer::Container(loro::Container::Map(e)) => f64_of(e, "order"),
                _ => None,
            };
            out.push(TableLine {
                id: k.to_string(),
                order: order.unwrap_or(f64::INFINITY),
            });
        });
    }
    out.sort_by(|a, b| a.order.total_cmp(&b.order).then_with(|| a.id.cmp(&b.id)));
    out
}

impl EmbedView {
    pub(crate) fn read(id: EmbedId, m: &LoroMap) -> Self {
        match str_of(m, "kind").as_deref() {
            Some("table") => {
                let cols = lines(sub_map(m, "cols"));
                let rows = lines(sub_map(m, "rows"));
                let col_ids: std::collections::HashSet<&str> =
                    cols.iter().map(|c| c.id.as_str()).collect();
                let mut cells = BTreeMap::new();
                if let Some(rm) = sub_map(m, "rows") {
                    for r in &rows {
                        let Some(row) = sub_map(&rm, &r.id) else {
                            continue;
                        };
                        let Some(cm) = sub_map(&row, "cells") else {
                            continue;
                        };
                        cm.for_each(|c, v| {
                            if col_ids.contains(c)
                                && let ValueOrContainer::Container(loro::Container::Text(t)) = v
                            {
                                cells.insert((r.id.clone(), c.to_string()), t.to_string());
                            }
                        });
                    }
                }
                EmbedView::Table {
                    id,
                    cols,
                    rows,
                    cells,
                }
            }
            Some("material") => EmbedView::Material {
                id,
                material: str_of(m, "material").and_then(|s| MaterialId::parse(&s).ok()),
            },
            other => EmbedView::Other {
                id,
                kind: other.unwrap_or_default().to_string(),
            },
        }
    }

    pub fn id(&self) -> &EmbedId {
        match self {
            EmbedView::Table { id, .. }
            | EmbedView::Material { id, .. }
            | EmbedView::Other { id, .. } => id,
        }
    }
}

/// Writes one table's structure and cells. Every container is mergeable, so
/// two devices creating the same row or cell merge into one.
pub struct TableWriter {
    pub(crate) entry: LoroMap,
}

impl TableWriter {
    fn line(&self, which: &str, id: &str, order: f64) -> Result<LoroMap> {
        let m = self
            .entry
            .ensure_mergeable_map(which)?
            .ensure_mergeable_map(id)?;
        m.insert("order", order)?;
        Ok(m)
    }

    pub fn add_col(&self, id: &str, order: f64) -> Result<()> {
        self.line("cols", id, order).map(|_| ())
    }

    pub fn add_row(&self, id: &str, order: f64) -> Result<()> {
        self.line("rows", id, order).map(|_| ())
    }

    pub fn remove_row(&self, id: &str) -> Result<()> {
        self.entry.ensure_mergeable_map("rows")?.delete(id)?;
        Ok(())
    }

    pub fn remove_col(&self, id: &str) -> Result<()> {
        self.entry.ensure_mergeable_map("cols")?.delete(id)?;
        Ok(())
    }

    /// The text of one cell (created on first use). Inline marks only; line
    /// breaks are U+2028.
    pub fn cell(&self, row: &str, col: &str) -> Result<LoroText> {
        Ok(self
            .entry
            .ensure_mergeable_map("rows")?
            .ensure_mergeable_map(row)?
            .ensure_mergeable_map("cells")?
            .ensure_mergeable_text(col)?)
    }

    /// Replace a cell's text.
    pub fn set_cell(&self, row: &str, col: &str, text: &str) -> Result<()> {
        let t = self.cell(row, col)?;
        t.update(text, Default::default())
            .map_err(|_| loro::LoroError::ArgErr("cell update timed out".into()))?;
        Ok(())
    }
}
