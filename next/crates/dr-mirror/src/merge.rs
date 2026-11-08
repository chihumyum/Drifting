//! An edited file merged back into the prose (the 0.1 client's
//! `markdown-mirror/ingest.ts` and `reconcile-yjs.ts`, on Loro).
//!
//! The file is treated as a copy of the document that only speaks Markdown:
//! the ledger remembers the version the file was written from (its base).
//! The difference between the base and the file is replayed on a fork of
//! the document at the base, and what that edit produced (Loro updates) is
//! imported into the live document like another device's change. So an
//! edit made in the file and one made in Drifting at the same time are both
//! kept, each where it was made.
//!
//! - Only the characters that changed are edited (a character diff inside
//!   each paired paragraph); marks are set or cleared only where the file
//!   differs; heading, quote and rule follow the file, alignment and indent
//!   stay. Entity links are neither added nor removed by the edit itself:
//!   text typed inside a link stays in it.
//! - Names in the paragraphs the file changed are linked again (dr-text's
//!   matcher, as an Agent's writing is).
//! - An embed (table, material) is deleted only when its line is gone from
//!   the file; a line moved elsewhere never deletes it (the paragraphs
//!   around it may move instead), and a line for an embed the document does
//!   not have is ignored.
//! - Deleting the document's last paragraph clears it (Loro keeps the final
//!   newline).
//! - The fork writes with a peer derived from the document, the base and
//!   the file's bytes: reading the same file over the same base twice (a
//!   crash before the ledger was updated) makes the same change, which Loro
//!   takes once.

use std::collections::HashSet;

use dr_doc::prose::{Paragraph, ProseDoc, ProseTxn, StyleKey};
use dr_model::prose::{BlockAttrs, Heading, InlineStyle};
use dr_model::{DocId, Origin};
use dr_text::autolink::{LinkMatcher, LinkTarget};
use dr_workspace::autolink::{apply as apply_links, link_runs, plan as plan_links};
use loro::{ExportMode, Frontiers, LoroDoc};
use sha2::{Digest, Sha256};
use similar::{Algorithm, DiffOp, capture_diff_slices};

use crate::body::{FilePara, Kind, Marks, Para, line};
use crate::plan::{Step, plan};

/// Why a file is not merged.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// The base is not in the document's history (another library's file,
    /// or a ledger from elsewhere).
    UnknownBase,
    /// The file's body is empty and the document's is not.
    Emptied,
}

/// What merging produced.
#[derive(Debug)]
pub struct Merged {
    /// Loro updates for the live document; empty when the file says what
    /// the base said.
    pub update: Vec<u8>,
    /// The version the file now stands for: the base and the file's edits.
    pub frontiers: Frontiers,
    /// Characters of the base the edit removed, and the base's length.
    pub removed: usize,
    pub base_len: usize,
}

#[derive(Debug, thiserror::Error)]
pub enum MergeError {
    #[error("{0}")]
    Doc(#[from] dr_doc::DocError),
    #[error("{0}")]
    Loro(#[from] loro::LoroError),
    #[error("{0}")]
    Encode(#[from] loro::LoroEncodeError),
}

/// The peer a merge writes with.
pub fn merge_peer(doc: &DocId, base: &Frontiers, file_bytes: &[u8]) -> u64 {
    let mut h = Sha256::new();
    h.update(b"drifting-mirror\0");
    h.update(doc.to_string().as_bytes());
    h.update([0]);
    h.update(base.encode());
    h.update([0]);
    h.update(file_bytes);
    let d = h.finalize();
    // A device-shaped peer (top bit clear, never zero), which dr-doc edits
    // with; the hash keeps it apart from every device's.
    match u64::from_le_bytes(d[..8].try_into().expect("eight bytes")) & !(1 << 63) {
        0 => 2,
        p => p,
    }
}

/// Merge `file`'s paragraphs into `copy` (a full copy of the document,
/// which is not changed) over `base`.
pub fn merge(
    copy: &LoroDoc,
    doc: &DocId,
    base: &Frontiers,
    file: &[FilePara],
    peer: u64,
    names: Option<&LinkMatcher<LinkTarget>>,
) -> Result<Result<Merged, Refusal>, MergeError> {
    let Some(base_vv) = copy.frontiers_to_vv(base) else {
        return Ok(Err(Refusal::UnknownBase));
    };
    let fork = copy.fork_at(base)?;
    let snapshot = fork.export(ExportMode::Snapshot)?;
    let mut prose = ProseDoc::load(doc.clone(), peer, &[snapshot])?;
    let paragraphs: Vec<Paragraph> = prose.view().paragraphs().collect();
    let base_len = prose.view().len();
    let has_text = paragraphs.iter().any(|p| !Para::of(p).is_empty());
    if file.is_empty() && has_text {
        return Ok(Err(Refusal::Emptied));
    }
    let (r, _) = prose.edit(Origin::Mirror, |txn| edit(txn, &paragraphs, file, names));
    let removed = r?;
    let update = if prose.version() == base_vv {
        Vec::new()
    } else {
        prose.export_updates_since(&base_vv)?
    };
    Ok(Ok(Merged {
        update,
        frontiers: prose.frontiers(),
        removed,
        base_len,
    }))
}

/// What happens to one base paragraph, and the file paragraphs inserted
/// before it.
#[derive(Default)]
struct Slot {
    action: Option<Action>,
    before: Vec<usize>,
}

#[derive(Clone, Copy)]
enum Action {
    Change(usize),
    Delete,
}

fn edit(
    txn: &mut ProseTxn<'_>,
    paragraphs: &[Paragraph],
    file: &[FilePara],
    names: Option<&LinkMatcher<LinkTarget>>,
) -> dr_doc::Result<usize> {
    let paras: Vec<Para> = paragraphs.iter().map(Para::of).collect();
    let n = paras.len();
    // Empty paragraphs at either end are not in the file: they stay.
    let (lo, hi) = match (
        paras.iter().position(|p| !p.is_empty()),
        paras.iter().rposition(|p| !p.is_empty()),
    ) {
        (Some(a), Some(b)) => (a, b + 1),
        // An empty document: the file fills its first paragraph.
        _ => (0, n.min(1)),
    };
    let base: Vec<(String, Para)> = paras[lo..hi]
        .iter()
        .map(|p| {
            (
                if p.is_empty() { String::new() } else { line(p) },
                p.clone(),
            )
        })
        .collect();
    let theirs: Vec<(String, Para)> = file
        .iter()
        .map(|f| (f.key.clone(), f.para.clone()))
        .collect();
    let mut steps = plan(&base, &theirs);
    if base.len() == 1
        && base[0].1.is_empty()
        && !steps.iter().any(|s| matches!(s, Step::Keep { .. }))
    {
        // An empty document: the file's first paragraph fills it rather
        // than coming after it.
        if let Some(first) = steps.iter().find_map(|s| match s {
            Step::Insert { file } => Some(*file),
            _ => None,
        }) {
            steps.retain(|s| *s != Step::Delete { base: 0 } && *s != Step::Insert { file: first });
            steps.insert(
                0,
                Step::Change {
                    base: 0,
                    file: first,
                },
            );
        }
    }
    // Embeds named anywhere in the file are never deleted (a moved line).
    let named: HashSet<&str> = file
        .iter()
        .filter_map(|f| match &f.para.kind {
            Kind::Embed(id) => Some(id.as_str()),
            _ => None,
        })
        .collect();

    let mut slots: Vec<Slot> = (0..base.len()).map(|_| Slot::default()).collect();
    let mut tail: Vec<usize> = Vec::new();
    let mut pending: Vec<usize> = Vec::new();
    for s in &steps {
        match *s {
            Step::Insert { file: f } => pending.push(f),
            Step::Keep { base: b, .. } => slots[b].before.append(&mut pending),
            Step::Change { base: b, file: f } => {
                slots[b].before.append(&mut pending);
                slots[b].action = Some(Action::Change(f));
            }
            Step::Delete { base: b } => {
                slots[b].before.append(&mut pending);
                let keep =
                    matches!(&base[b].1.kind, Kind::Embed(id) if named.contains(id.as_str()));
                if !keep {
                    slots[b].action = Some(Action::Delete);
                }
            }
        }
    }
    tail.append(&mut pending);

    let mut removed = 0;
    // Paragraphs the file changed or added, by block id.
    let mut touched: HashSet<String> = HashSet::new();
    // Whether paragraphs were added after the document's last one.
    let appended = !tail.is_empty() && lo + base.len() == n;
    // From the end, so earlier positions stay valid.
    if !tail.is_empty() {
        match paragraphs.get(lo + base.len()) {
            Some(p) => insert_before(txn, p.range.start, &tail, file, &mut touched)?,
            None => {
                let last = &paragraphs[n - 1];
                append(txn, last.newline, &tail, file, &mut touched)?;
            }
        }
    }
    for (b, slot) in slots.iter().enumerate().rev() {
        let p = &paragraphs[lo + b];
        match slot.action {
            Some(Action::Change(f)) => {
                removed += change(txn, p, &base[b].1, &file[f].para)?;
                if let Some(id) = &p.stored_id {
                    touched.insert(id.to_string());
                }
            }
            Some(Action::Delete) => {
                removed += p.range.len();
                if lo + b + 1 < n || appended || !p.terminated {
                    if p.terminated {
                        txn.delete(p.range.start..p.newline + 1)?;
                    } else {
                        txn.delete(p.range.clone())?;
                    }
                } else {
                    // The last paragraph: Loro keeps the final newline.
                    txn.delete(p.range.clone())?;
                    txn.set_block_attrs(p.range.start, &BlockAttrs::default())?;
                }
            }
            None => {}
        }
        if !slot.before.is_empty() {
            insert_before(txn, p.range.start, &slot.before, file, &mut touched)?;
        }
    }
    if let Some(names) = names.filter(|n| !n.is_empty()) {
        relink(txn, names, &touched)?;
    }
    Ok(removed)
}

/// The attributes a file paragraph asks for, over `keep`'s.
fn attrs_of(p: &Para, keep: &BlockAttrs) -> BlockAttrs {
    let mut a = keep.clone();
    match &p.kind {
        Kind::Text { heading, quote } => {
            a.heading = heading.and_then(|h| Heading::from_level(h as i64));
            a.quote = *quote;
            a.rule = false;
        }
        Kind::Rule { quote } => {
            a.heading = None;
            a.quote = *quote;
            a.rule = true;
        }
        Kind::Embed(_) => {}
    }
    a
}

/// Edit paragraph `p` (read as `old`) into `new`; returns how many base
/// characters went.
fn change(txn: &mut ProseTxn<'_>, p: &Paragraph, old: &Para, new: &Para) -> dr_doc::Result<usize> {
    let start = p.range.start;
    let mut removed = 0;
    for op in capture_diff_slices(Algorithm::Myers, &old.chars, &new.chars)
        .iter()
        .rev()
    {
        match *op {
            DiffOp::Equal { .. } => {}
            DiffOp::Delete {
                old_index, old_len, ..
            } => {
                txn.delete(start + old_index..start + old_index + old_len)?;
                removed += old_len;
            }
            DiffOp::Insert {
                old_index,
                new_index,
                new_len,
            } => {
                let s: String = new.chars[new_index..new_index + new_len].iter().collect();
                txn.insert_text(start + old_index, &s)?;
            }
            DiffOp::Replace {
                old_index,
                old_len,
                new_index,
                new_len,
            } => {
                txn.delete(start + old_index..start + old_index + old_len)?;
                removed += old_len;
                let s: String = new.chars[new_index..new_index + new_len].iter().collect();
                txn.insert_text(start + old_index, &s)?;
            }
        }
    }
    let want = attrs_of(new, &p.attrs);
    if want != p.attrs {
        if want.quote == p.attrs.quote && want.rule == p.attrs.rule {
            // The narrowest write: a concurrent change of another attribute
            // is not overwritten.
            txn.set_heading(start, want.heading)?;
        } else {
            txn.set_block_attrs(start, &want)?;
        }
    }
    restyle(txn, start, new)?;
    Ok(removed)
}

/// Make the marks of the paragraph at `start` the file's, only where they
/// differ.
fn restyle(txn: &mut ProseTxn<'_>, start: usize, want: &Para) -> dr_doc::Result<()> {
    let now = Para::of(&txn.view().paragraph_at(start)?);
    if now.chars != want.chars {
        // Not expected (the text was just made equal); leave the marks.
        return Ok(());
    }
    type Get = fn(&Marks) -> bool;
    let flags: [(Get, StyleKey, InlineStyle); 4] = [
        (|m| m.bold, StyleKey::Bold, InlineStyle::Bold),
        (|m| m.italic, StyleKey::Italic, InlineStyle::Italic),
        (|m| m.underline, StyleKey::Underline, InlineStyle::Underline),
        (|m| m.strike, StyleKey::Strike, InlineStyle::Strike),
    ];
    for (get, key, style) in flags {
        for (range, on) in differing(&now.marks, &want.marks, |a, b| get(a) != get(b), get) {
            let at = start + range.start..start + range.end;
            if on {
                txn.set_style(at, &style)?;
            } else {
                txn.clear_style(at, key)?;
            }
        }
    }
    // Links: runs where the address differs.
    let mut k = 0;
    while k < want.marks.len() {
        if now.marks[k].link == want.marks[k].link {
            k += 1;
            continue;
        }
        let target = want.marks[k].link.clone();
        let from = k;
        while k < want.marks.len()
            && now.marks[k].link != want.marks[k].link
            && want.marks[k].link == target
        {
            k += 1;
        }
        let at = start + from..start + k;
        match &target {
            Some(href) => txn.set_style(at, &InlineStyle::Link(href.clone()))?,
            None => txn.clear_style(at, StyleKey::Link)?,
        }
    }
    Ok(())
}

/// Ranges where `differs(now, want)`, each with the wanted state.
fn differing(
    now: &[Marks],
    want: &[Marks],
    differs: impl Fn(&Marks, &Marks) -> bool,
    state: impl Fn(&Marks) -> bool,
) -> Vec<(std::ops::Range<usize>, bool)> {
    let mut out: Vec<(std::ops::Range<usize>, bool)> = Vec::new();
    for k in 0..want.len() {
        if !differs(&now[k], &want[k]) {
            continue;
        }
        let on = state(&want[k]);
        match out.last_mut() {
            Some((r, s)) if r.end == k && *s == on => r.end = k + 1,
            _ => out.push((k..k + 1, on)),
        }
    }
    out
}

/// Insert file paragraphs `which` in front of the paragraph starting at
/// `pos`, in order.
fn insert_before(
    txn: &mut ProseTxn<'_>,
    pos: usize,
    which: &[usize],
    file: &[FilePara],
    touched: &mut HashSet<String>,
) -> dr_doc::Result<()> {
    for &f in which.iter().rev() {
        let para = &file[f].para;
        if matches!(para.kind, Kind::Embed(_)) {
            continue;
        }
        txn.split(pos)?;
        fill(txn, pos, para, touched)?;
    }
    Ok(())
}

/// Append file paragraphs `which` after the last paragraph, whose newline
/// is at `nl`.
fn append(
    txn: &mut ProseTxn<'_>,
    nl: usize,
    which: &[usize],
    file: &[FilePara],
    touched: &mut HashSet<String>,
) -> dr_doc::Result<()> {
    let mut nl = nl;
    for &f in which {
        let para = &file[f].para;
        if matches!(para.kind, Kind::Embed(_)) {
            continue;
        }
        let at = txn.split(nl)?;
        fill(txn, at, para, touched)?;
        nl = at + para.chars.len();
    }
    Ok(())
}

/// Write `para` into the empty paragraph at `pos`.
fn fill(
    txn: &mut ProseTxn<'_>,
    pos: usize,
    para: &Para,
    touched: &mut HashSet<String>,
) -> dr_doc::Result<()> {
    let text: String = para.chars.iter().collect();
    txn.insert_text(pos, &text)?;
    txn.set_block_attrs(pos, &attrs_of(para, &BlockAttrs::default()))?;
    restyle(txn, pos, para)?;
    if let Some(id) = txn.view().paragraph_at(pos)?.stored_id {
        touched.insert(id.to_string());
    }
    Ok(())
}

/// Link names in the paragraphs the file changed or added (added ones have
/// fresh block ids, so every paragraph whose id the base did not have).
fn relink(
    txn: &mut ProseTxn<'_>,
    names: &LinkMatcher<LinkTarget>,
    changed: &HashSet<String>,
) -> dr_doc::Result<()> {
    let todo: Vec<(usize, Vec<dr_workspace::autolink::LinkEdit>)> = txn
        .view()
        .paragraphs()
        .filter(|p| {
            p.stored_id
                .as_ref()
                .is_some_and(|id| changed.contains(&id.to_string()))
        })
        .filter_map(|p| {
            let edits = plan_links(&p.text(), &link_runs(&p), names, 0..p.range.len());
            (!edits.is_empty()).then_some((p.range.start, edits))
        })
        .collect();
    for (start, edits) in todo.into_iter().rev() {
        apply_links(txn, start, &edits)?;
    }
    Ok(())
}
