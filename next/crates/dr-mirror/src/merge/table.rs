use dr_doc::{
    prose::{EmbedView, ProseTxn, StyleKey, TableLine, TableWriter},
    schema::inline,
};
use dr_model::{id::EmbedId, kind::EntityKind, pos::PosKey, prose::InlineStyle};
use loro::{LoroText, LoroValue};
use similar::{Algorithm, DiffOp, capture_diff_slices};

use super::{Mark, Para, marks_changed};
use crate::merge_plan::{Step, plan};

pub(super) fn change(
    txn: &mut ProseTxn<'_>,
    id: &EmbedId,
    before: &[Vec<Para>],
    after: &[Vec<Para>],
    peer: u64,
    index: usize,
) -> dr_doc::Result<usize> {
    let Some(EmbedView::Table { cols, rows, .. }) = txn.view().embed(id) else {
        return Ok(0);
    };
    let row_pairs = axis_pairs(before, after);
    let col_pairs = axis_pairs(&columns(before), &columns(after));
    let table = txn.table(id)?;
    let prefix = format!("mf-{peer:x}-{index}");
    let out_rows = apply_axis(&table, &rows, &row_pairs, &prefix, true)?;
    let out_cols = apply_axis(&table, &cols, &col_pairs, &prefix, false)?;
    let mut removed = 0;
    for (r, row) in before.iter().enumerate() {
        for (c, cell) in row.iter().enumerate() {
            if !row_pairs.contains(&Some(r)) || !col_pairs.contains(&Some(c)) {
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
    Ok(removed)
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

/// Align the two sides by exact and similar cell strings. When every
/// surviving line kept its index, replacements keep that line's identity.
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
    if before.len() == after.len()
        && pairs
            .iter()
            .enumerate()
            .all(|(i, p)| p.is_none_or(|b| b == i))
    {
        return (0..after.len()).map(Some).collect();
    }
    pairs
}

fn apply_axis(
    table: &TableWriter,
    before: &[TableLine],
    pairs: &[Option<usize>],
    prefix: &str,
    rows: bool,
) -> dr_doc::Result<Vec<String>> {
    for (i, line) in before.iter().enumerate() {
        if !pairs.contains(&Some(i)) {
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
        let key = PosKey::between(predecessor.as_ref(), next)?;
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
