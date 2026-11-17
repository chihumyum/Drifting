use std::collections::{HashMap, HashSet};

use dr_doc::{
    prose::{EmbedView, ProseTxn, ProseView, StyleKey, TableLine, TableWriter},
    schema::inline,
};
use dr_model::{id::EmbedId, kind::EntityKind, pos::PosKey, prose::InlineStyle};
use loro::{LoroText, LoroValue};
use similar::{Algorithm, DiffOp, capture_diff_slices};

use super::{Mark, Para, marks_changed, overlap};
use crate::merge_plan::{Step, plan};

/// What the App changed in a table since the base, read from the live
/// document.
struct Live {
    /// Rows and columns with a cell the App changed, including newly added
    /// lines whose words an external deletion of the other axis could hide.
    edited_rows: HashSet<String>,
    edited_cols: HashSet<String>,
    /// Base rows and columns the App removed.
    gone_rows: HashSet<String>,
    gone_cols: HashSet<String>,
    /// `(row, col)` → the cell's characters now.
    cells: HashMap<(String, String), Vec<char>>,
}

impl Live {
    /// `base` is the table as the fork has it, before this edit.
    fn read(base: ProseView<'_>, live: ProseView<'_>, id: &EmbedId) -> Option<Self> {
        let Some(EmbedView::Table { cols, rows, .. }) = base.embed(id) else {
            return None;
        };
        let Some(EmbedView::Table {
            cols: live_cols,
            rows: live_rows,
            ..
        }) = live.embed(id)
        else {
            return None;
        };
        let ids = |lines: &[TableLine]| lines.iter().map(|l| l.id.clone()).collect::<HashSet<_>>();
        let (now_rows, now_cols) = (ids(&live_rows), ids(&live_cols));
        let mut all_cols: Vec<_> = ids(&cols).union(&now_cols).cloned().collect();
        all_cols.sort();
        let mut all_rows: Vec<_> = ids(&rows).union(&now_rows).cloned().collect();
        all_rows.sort();
        let mut out = Self {
            edited_rows: HashSet::new(),
            edited_cols: HashSet::new(),
            gone_rows: ids(&rows).difference(&now_rows).cloned().collect(),
            gone_cols: ids(&cols).difference(&now_cols).cloned().collect(),
            cells: HashMap::new(),
        };
        for row in &all_rows {
            for col in &all_cols {
                let then = base.table_cell(id, row, col).unwrap_or_default();
                let now = live.table_cell(id, row, col).unwrap_or_default();
                if then != now {
                    out.edited_rows.insert(row.clone());
                    out.edited_cols.insert(col.clone());
                }
                let chars = now.iter().flat_map(|r| r.text.chars()).collect();
                out.cells.insert((row.clone(), col.clone()), chars);
            }
        }
        Some(out)
    }
}

/// Whether the App changed table `id` since the base: a cell, a row or a
/// column.
pub(super) fn edited(base: ProseView<'_>, live: ProseView<'_>, id: &EmbedId) -> bool {
    match (base.embed(id), live.embed(id)) {
        (Some(then @ EmbedView::Table { .. }), Some(now)) => {
            then != now
                || Live::read(base, live, id).is_some_and(|live| !live.edited_rows.is_empty())
        }
        _ => false,
    }
}

/// Edit table `id` from `before` into `after`. A row or column the file
/// drops or replaces stays when the App changed one of its cells, and a
/// row or column the App removed comes back as a new one when the file
/// changed it: neither side's text goes without a trace. Returns the base
/// characters removed and whether both sides changed the same line or
/// cell.
pub(super) fn change(
    txn: &mut ProseTxn<'_>,
    id: &EmbedId,
    before: &[Vec<Para>],
    after: &[Vec<Para>],
    peer: u64,
    index: usize,
    live: Option<ProseView<'_>>,
) -> dr_doc::Result<(usize, bool)> {
    let Some(EmbedView::Table { cols, rows, .. }) = txn.view().embed(id) else {
        return Ok((0, false));
    };
    let live = live.and_then(|live| Live::read(txn.view(), live, id));
    let mut row_pairs = axis_pairs(before, after);
    let (base_cols, file_cols) = (columns(before), columns(after));
    let mut col_pairs = axis_pairs(&base_cols, &file_cols);
    let mut conflict = false;
    let mut kept_rows = vec![false; rows.len()];
    let mut kept_cols = vec![false; cols.len()];
    if let Some(live) = &live {
        conflict |= revive(&mut row_pairs, &rows, before, after, &live.gone_rows);
        conflict |= revive(
            &mut col_pairs,
            &cols,
            &base_cols,
            &file_cols,
            &live.gone_cols,
        );
        conflict |= keep(&mut kept_rows, &row_pairs, &rows, &live.edited_rows);
        conflict |= keep(&mut kept_cols, &col_pairs, &cols, &live.edited_cols);
    }
    let table = txn.table(id)?;
    let prefix = format!("mf-{peer:x}-{index}");
    let out_rows = apply_axis(&table, &rows, &row_pairs, &kept_rows, &prefix, true)?;
    let out_cols = apply_axis(&table, &cols, &col_pairs, &kept_cols, &prefix, false)?;
    let mut removed = 0;
    for (r, row) in before.iter().enumerate() {
        for (c, cell) in row.iter().enumerate() {
            let row_gone = !row_pairs.contains(&Some(r)) && !kept_rows[r];
            let col_gone = !col_pairs.contains(&Some(c)) && !kept_cols[c];
            if row_gone || col_gone {
                removed += cell.chars.len();
            }
        }
    }
    for (r, row) in after.iter().enumerate() {
        for (c, want) in row.iter().enumerate() {
            let base = row_pairs[r].zip(col_pairs[c]).map(|(r, c)| &before[r][c]);
            if base.is_some_and(|base| base == want) || (base.is_none() && want.chars.is_empty()) {
                continue;
            }
            let (row, col) = (&out_rows[r], &out_cols[c]);
            if let (Some(base), Some(live)) = (base, &live)
                && let Some(now) = live.cells.get(&(row.clone(), col.clone()))
                && overlap(&base.chars, &want.chars, now)
            {
                conflict = true;
            }
            let text = table.cell(row, col)?;
            let empty = Para::empty();
            removed += change_text(&text, base.unwrap_or(&empty), want)?;
            let runs = txn.view().table_cell(id, row, col).unwrap_or_default();
            let now = Para::from_prose_runs(&runs, empty.kind);
            for (range, mark) in marks_changed(&now.marks, &want.marks) {
                match mark {
                    Mark::Style(key, style) => {
                        let key = match key {
                            StyleKey::Bold => inline::BOLD,
                            StyleKey::Italic => inline::ITALIC,
                            StyleKey::Underline => inline::UNDERLINE,
                            StyleKey::Strike => inline::STRIKE,
                            StyleKey::Code => inline::CODE,
                            StyleKey::Highlight => inline::HIGHLIGHT,
                            StyleKey::Link => inline::LINK,
                        };
                        match style {
                            Some(InlineStyle::Link(value) | InlineStyle::Highlight(value)) => {
                                text.mark(range, key, value.as_str())?
                            }
                            Some(_) => text.mark(range, key, true)?,
                            None => text.unmark(range, key)?,
                        }
                    }
                    Mark::File(from, to) => {
                        if let Some(from) = from {
                            let key = inline::entity_key(from.as_str());
                            text.unmark(range.clone(), &key)?;
                        }
                        if let Some(to) = to {
                            let key = inline::entity_key(to.as_str());
                            let target = LoroValue::Map(
                                vec![("kind".to_owned(), EntityKind::Asset.as_str().into())].into(),
                            );
                            text.mark(range, &key, target)?;
                        }
                    }
                }
            }
        }
    }
    Ok((removed, conflict))
}

/// File lines paired with a base line the App removed, and changed by the
/// file, are added as new lines instead of being written into the removed
/// one, where nobody would see them.
fn revive(
    pairs: &mut [Option<usize>],
    lines: &[TableLine],
    before: &[Vec<Para>],
    after: &[Vec<Para>],
    gone: &HashSet<String>,
) -> bool {
    let mut revived = false;
    for (file, pair) in pairs.iter_mut().enumerate() {
        if let Some(base) = *pair
            && gone.contains(&lines[base].id)
            && before[base] != after[file]
        {
            *pair = None;
            revived = true;
        }
    }
    revived
}

/// Base lines the file drops or replaces stay when the App changed them.
fn keep(
    kept: &mut [bool],
    pairs: &[Option<usize>],
    lines: &[TableLine],
    edited: &HashSet<String>,
) -> bool {
    let mut any = false;
    for (base, line) in lines.iter().enumerate() {
        if !pairs.contains(&Some(base)) && edited.contains(&line.id) {
            kept[base] = true;
            any = true;
        }
    }
    any
}

fn change_text(text: &LoroText, before: &Para, after: &Para) -> dr_doc::Result<usize> {
    let mut removed = 0;
    for op in capture_diff_slices(Algorithm::Myers, &before.chars, &after.chars)
        .into_iter()
        .rev()
    {
        if matches!(op, DiffOp::Equal { .. }) {
            continue;
        }
        let old = op.old_range();
        let inserted: String = after.chars[op.new_range()].iter().collect();
        if !old.is_empty() {
            text.delete(old.start, old.len())?;
            removed += old.len();
        }
        if !inserted.is_empty() {
            text.insert(old.start, &inserted)?;
        }
    }
    Ok(removed)
}

fn columns(rows: &[Vec<Para>]) -> Vec<Vec<Para>> {
    let count = rows.first().map_or(0, Vec::len);
    (0..count)
        .map(|c| rows.iter().map(|row| row[c].clone()).collect())
        .collect()
}

/// Align by exact and similar cell strings. Equal dimensions alone do not
/// make a completely replaced line the old line: a concurrent App edit must
/// retain that old line alongside the file's replacement.
fn axis_pairs(before: &[Vec<Para>], after: &[Vec<Para>]) -> Vec<Option<usize>> {
    let signatures = |lines: &[Vec<Para>]| {
        lines
            .iter()
            .map(|cells| {
                let value = cells.iter().map(Para::text).collect::<Vec<_>>().join("\0");
                let p = Para::plain(&value);
                (value, p)
            })
            .collect::<Vec<_>>()
    };
    let changes = plan(&signatures(before), &signatures(after));
    let mut pairs = vec![None; after.len()];
    for step in changes {
        if let Step::Keep { base, file } | Step::Change { base, file } = step {
            pairs[file] = Some(base);
        }
    }
    pairs
}

fn apply_axis(
    table: &TableWriter,
    before: &[TableLine],
    pairs: &[Option<usize>],
    kept: &[bool],
    prefix: &str,
    rows: bool,
) -> dr_doc::Result<Vec<String>> {
    for (i, line) in before.iter().enumerate() {
        if !pairs.contains(&Some(i)) && !kept[i] {
            if rows {
                table.remove_row(&line.id)?;
            } else {
                table.remove_col(&line.id)?;
            }
        }
    }
    let mut out = Vec::with_capacity(pairs.len());
    let mut predecessor = None;
    for (i, pair) in pairs.iter().enumerate() {
        if let Some(i) = pair {
            let line = &before[*i];
            predecessor = line.pos.clone().or(predecessor);
            out.push(line.id.clone());
            continue;
        }
        let next = pairs[i + 1..]
            .iter()
            .flatten()
            .next()
            .and_then(|&i| before[i].pos.as_ref());
        let key = PosKey::between(predecessor.as_ref(), next)
            .map_err(|error| loro::LoroError::ArgErr(format!("table position: {error}").into()))?;
        predecessor = Some(key.clone());
        let axis = if rows { 'r' } else { 'c' };
        let id = format!("{prefix}-{axis}{i}");
        if rows {
            table.add_row(&id, &key)?;
        } else {
            table.add_col(&id, &key)?;
        }
        out.push(id);
    }
    Ok(out)
}
