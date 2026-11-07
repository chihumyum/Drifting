//! Making a prose document equal to a plan, through dr-doc's typed writes
//! only. The first version of an imported body is written into the genesis
//! document; each later version (snapshot history, then the current body) is
//! written as the smallest change the paragraph diff finds, so the history
//! stays small and every version can be checked out.

use std::collections::BTreeSet;

use dr_doc::Result;
use dr_doc::prose::{EmbedKind, EmbedView, ProseTxn, StyleKey};
use dr_model::prose::{EntityLink, InlineStyle};

use super::plan::Para;
use super::read::read_paras;

/// What one [`sync`] did, for the measurements.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SyncStats {
    pub inserted: usize,
    pub deleted: usize,
    pub rewritten: usize,
}

/// Make the document equal to `target` (which must end with a text
/// paragraph, as every plan does).
pub fn sync(txn: &mut ProseTxn<'_>, target: &[Para]) -> Result<SyncStats> {
    let current = read_paras(&txn.view());
    let mut stats = SyncStats::default();
    let (m, n) = (current.len(), target.len());
    debug_assert!(m >= 1 && n >= 1);
    let mut s = 0;
    while s < m && s < n && current[m - 1 - s] == target[n - 1 - s] {
        s += 1;
    }
    let mut k = 0;
    let limit = m.min(n) - s - usize::from(s == 0);
    while k < limit && current[k] == target[k] {
        k += 1;
    }
    let mut pos: usize = current[..k].iter().map(|p| p.len() + 1).sum();
    // The last paragraph holds the body's final newline and is rewritten in
    // place when it differs; everything else in the middle is matched up.
    let old_end = m - s.max(1);
    let new_end = n - s.max(1);
    let old_mid = &current[k..old_end];
    let new_mid = &target[k..new_end];
    if old_mid.len() == new_mid.len() {
        for (c, t) in old_mid.iter().zip(new_mid) {
            if c == t {
                pos += c.len() + 1;
            } else if c.embed.is_none() && t.embed.is_none() {
                rewrite(txn, pos, c, t)?;
                stats.rewritten += 1;
                pos += t.len() + 1;
            } else {
                insert(txn, pos, t)?;
                pos += t.len() + 1;
                txn.delete(pos..pos + c.len() + 1)?;
                stats.inserted += 1;
                stats.deleted += 1;
            }
        }
    } else {
        for t in new_mid {
            insert(txn, pos, t)?;
            pos += t.len() + 1;
            stats.inserted += 1;
        }
        let gone: usize = old_mid.iter().map(|p| p.len() + 1).sum();
        if gone > 0 {
            txn.delete(pos..pos + gone)?;
            stats.deleted += old_mid.len();
        }
    }
    if s == 0 {
        rewrite(txn, pos, &current[m - 1], &target[n - 1])?;
        stats.rewritten += 1;
    }
    Ok(stats)
}

/// Insert `p` as a new paragraph before the one starting at `pos`.
fn insert(txn: &mut ProseTxn<'_>, pos: usize, p: &Para) -> Result<()> {
    if let Some(embed) = &p.embed {
        insert_embed(txn, pos, embed)?;
        txn.set_block_id(pos, p.id.as_ref())?;
        return Ok(());
    }
    txn.split(pos)?;
    let text = p.text();
    txn.insert_text(pos, &text)?;
    txn.set_block_attrs(pos, &p.attrs)?;
    txn.set_block_id(pos, p.id.as_ref())?;
    apply_marks(txn, pos, p)?;
    Ok(())
}

fn insert_embed(txn: &mut ProseTxn<'_>, pos: usize, embed: &EmbedView) -> Result<()> {
    match embed {
        EmbedView::Material { id, material } => {
            let m = material.clone().expect("plans only embed known materials");
            txn.insert_embed(pos, id, &EmbedKind::Material(m))?;
        }
        EmbedView::Table {
            id,
            cols,
            rows,
            cells,
        } => {
            let stale = txn.view().embed(id);
            let table = txn.insert_embed(pos, id, &EmbedKind::Table)?;
            if let Some(EmbedView::Table {
                cols: old_cols,
                rows: old_rows,
                ..
            }) = stale
            {
                for r in old_rows
                    .iter()
                    .filter(|r| !rows.iter().any(|x| x.id == r.id))
                {
                    table.remove_row(&r.id)?;
                }
                for c in old_cols
                    .iter()
                    .filter(|c| !cols.iter().any(|x| x.id == c.id))
                {
                    table.remove_col(&c.id)?;
                }
            }
            for c in cols {
                if let Some(p) = &c.pos {
                    table.add_col(&c.id, p)?;
                }
            }
            for r in rows {
                if let Some(p) = &r.pos {
                    table.add_row(&r.id, p)?;
                }
            }
            for ((r, c), text) in cells {
                table.set_cell(r, c, text)?;
            }
        }
        EmbedView::Other { .. } => {
            return Err(dr_doc::DocError::NotInProfile(
                "an embed of an unknown kind",
            ));
        }
    }
    Ok(())
}

/// Rewrite the text paragraph `c` starting at `pos` into `t`: the smallest
/// text change, then attributes, id and marks.
fn rewrite(txn: &mut ProseTxn<'_>, pos: usize, c: &Para, t: &Para) -> Result<()> {
    let ct: Vec<char> = c.text().chars().collect();
    let tt: Vec<char> = t.text().chars().collect();
    let mut a = 0;
    while a < ct.len() && a < tt.len() && ct[a] == tt[a] {
        a += 1;
    }
    let mut b = 0;
    while b < ct.len() - a && b < tt.len() - a && ct[ct.len() - 1 - b] == tt[tt.len() - 1 - b] {
        b += 1;
    }
    if ct.len() - b > a {
        txn.delete(pos + a..pos + ct.len() - b)?;
    }
    if tt.len() - b > a {
        let piece: String = tt[a..tt.len() - b].iter().collect();
        txn.insert_text(pos + a, &piece)?;
    }
    if c.attrs != t.attrs {
        txn.set_block_attrs(pos, &t.attrs)?;
    }
    if c.id != t.id {
        txn.set_block_id(pos, t.id.as_ref())?;
    }
    let now = txn.view().paragraph_at(pos)?;
    if now.runs != t.runs {
        let range = pos..pos + tt.len();
        if !range.is_empty() {
            for key in [
                StyleKey::Bold,
                StyleKey::Italic,
                StyleKey::Underline,
                StyleKey::Strike,
                StyleKey::Link,
            ] {
                txn.clear_style(range.clone(), key)?;
            }
            if txn.view().profile() == dr_model::ProseProfile::Note {
                txn.clear_style(range.clone(), StyleKey::Highlight)?;
                txn.clear_style(range.clone(), StyleKey::Code)?;
            }
            let targets: BTreeSet<String> = now
                .runs
                .iter()
                .flat_map(|r| r.marks.entities.iter().map(|l| l.target.clone()))
                .collect();
            for target in targets {
                txn.unlink_entity(range.clone(), &target)?;
            }
        }
        apply_marks(txn, pos, t)?;
    }
    Ok(())
}

/// Ranges (absolute) over which `want(run)` gives the same `Some` value.
fn ranges<T: PartialEq + Clone>(
    p: &Para,
    start: usize,
    want: impl Fn(&dr_doc::prose::Run) -> Option<T>,
) -> Vec<(std::ops::Range<usize>, T)> {
    let mut out: Vec<(std::ops::Range<usize>, T)> = Vec::new();
    let mut at = start;
    for run in &p.runs {
        let len = run.text.chars().count();
        if let Some(v) = want(run) {
            match out.last_mut() {
                Some((r, last)) if r.end == at && *last == v => r.end = at + len,
                _ => out.push((at..at + len, v)),
            }
        }
        at += len;
    }
    out
}

fn apply_marks(txn: &mut ProseTxn<'_>, start: usize, p: &Para) -> Result<()> {
    let style = |txn: &mut ProseTxn<'_>, list: Vec<(std::ops::Range<usize>, InlineStyle)>| {
        for (r, s) in list {
            txn.set_style(r, &s)?;
        }
        Ok::<_, dr_doc::DocError>(())
    };
    style(
        txn,
        ranges(p, start, |r| r.marks.bold.then_some(InlineStyle::Bold)),
    )?;
    style(
        txn,
        ranges(p, start, |r| r.marks.italic.then_some(InlineStyle::Italic)),
    )?;
    style(
        txn,
        ranges(p, start, |r| {
            r.marks.underline.then_some(InlineStyle::Underline)
        }),
    )?;
    style(
        txn,
        ranges(p, start, |r| r.marks.strike.then_some(InlineStyle::Strike)),
    )?;
    style(
        txn,
        ranges(p, start, |r| r.marks.link.clone().map(InlineStyle::Link)),
    )?;
    style(
        txn,
        ranges(p, start, |r| {
            r.marks.highlight.clone().map(InlineStyle::Highlight)
        }),
    )?;
    style(
        txn,
        ranges(p, start, |r| r.marks.code.then_some(InlineStyle::Code)),
    )?;
    let targets: BTreeSet<&str> = p
        .runs
        .iter()
        .flat_map(|r| r.marks.entities.iter().map(|l| l.target.as_str()))
        .collect();
    for target in targets {
        let links: Vec<(std::ops::Range<usize>, EntityLink)> = ranges(p, start, |r| {
            r.marks
                .entities
                .iter()
                .find(|l| l.target == target)
                .cloned()
        });
        for (r, link) in links {
            txn.link_entity(r, &link)?;
        }
    }
    Ok(())
}
