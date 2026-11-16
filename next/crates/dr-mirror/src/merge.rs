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

use std::collections::{HashMap, HashSet};
use std::ops::Range;

use dr_doc::prose::{
    BorrowedProse, EmbedKind, EmbedView, FileEmbedLook, Paragraph, ProseDoc, ProseTxn, StyleKey,
};
use dr_model::id::{AssetId, BlockId, EmbedId};
use dr_model::kind::EntityKind;
use dr_model::prose::{BlockAttrs, EntityLink, Heading, InlineStyle};
use dr_model::{DocId, Origin};
use dr_text::autolink::{LinkMatcher, LinkTarget};
use dr_workspace::autolink::{apply as apply_links, link_runs, plan as plan_links};
use loro::{ExportMode, Frontiers, LoroDoc};
use sha2::{Digest, Sha256};
use similar::{Algorithm, DiffOp, capture_diff_slices};

use crate::body::{FileLinks, FilePara, Kind, Marks, Para, line_with};

mod table;
use crate::merge_plan::{Step, plan};

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
    pub conflicts: Vec<BlockId>,
    pub replayed: bool,
}

impl Merged {
    pub fn needs_snapshot(&self) -> bool {
        self.removed > 200 && self.removed > self.base_len / 2
    }
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
    merge_with(copy, doc, base, file, peer, names, &FileLinks::default())
}

pub fn merge_with(
    copy: &LoroDoc,
    doc: &DocId,
    base: &Frontiers,
    file: &[FilePara],
    peer: u64,
    names: Option<&LinkMatcher<LinkTarget>>,
    links: &FileLinks<'_>,
) -> Result<Result<Merged, Refusal>, MergeError> {
    let Some(base_vv) = copy.frontiers_to_vv(base) else {
        return Ok(Err(Refusal::UnknownBase));
    };
    let fork = copy.fork_at(base)?;
    let snapshot = fork.export(ExportMode::Snapshot)?;
    let mut prose = ProseDoc::load(doc.clone(), peer, &[snapshot])?;
    let paragraphs: Vec<Paragraph> = prose.view().paragraphs().collect();
    let base_len = paragraphs
        .iter()
        .map(|p| text_count(&Para::project(&prose.view(), p, links)))
        .sum();
    if file.is_empty() && paragraphs.iter().any(|p| !Para::of(p).is_empty()) {
        return Ok(Err(Refusal::Emptied));
    }
    let replayed = copy.oplog_vv().get(&peer).is_some();
    let current: HashMap<_, _> = if copy.oplog_frontiers() == *base || replayed {
        HashMap::new()
    } else {
        BorrowedProse::new(copy, doc)?
            .view()
            .paragraphs()
            .filter_map(|p| {
                p.id.map(|id| {
                    (
                        id,
                        p.runs
                            .iter()
                            .flat_map(|r| r.text.chars())
                            .collect::<Vec<_>>(),
                    )
                })
            })
            .collect()
    };
    let (r, _) = prose.edit(Origin::Mirror, |txn| {
        edit(txn, &paragraphs, file, names, links, peer, &current)
    });
    let (removed, conflicts) = r?;
    let update = if replayed || prose.version() == base_vv {
        Vec::new()
    } else {
        prose.export_updates_since(&base_vv)?
    };
    Ok(Ok(Merged {
        update,
        frontiers: prose.frontiers(),
        removed,
        base_len,
        conflicts,
        replayed,
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
    links: &FileLinks<'_>,
    peer: u64,
    current: &HashMap<BlockId, Vec<char>>,
) -> dr_doc::Result<(usize, Vec<BlockId>)> {
    let view = txn.view();
    let paras: Vec<Para> = paragraphs
        .iter()
        .map(|p| Para::project(&view, p, links))
        .collect();
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
                if p.is_empty() {
                    String::new()
                } else {
                    line_with(p, links)
                },
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
        if let Some(first) = steps
            .iter()
            .find_map(|s| match s {
                Step::Insert { file: at } => Some(*at),
                _ => None,
            })
            .filter(|first| !is_embed(&file[*first].para.kind))
        {
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

    let bad_table = file
        .iter()
        .any(|f| matches!(f.para.kind, Kind::BrokenTable(_)));
    let mut slots: Vec<Slot> = (0..base.len()).map(|_| Slot::default()).collect();
    let mut tail: Vec<usize> = Vec::new();
    let mut pending: Vec<usize> = Vec::new();
    for s in &steps {
        match *s {
            Step::Insert { file: f } => {
                if !matches!(file[f].para.kind, Kind::Embed(_) | Kind::BrokenTable(_)) {
                    pending.push(f);
                }
            }
            Step::Keep { base: b, .. } => slots[b].before.append(&mut pending),
            Step::Change { base: b, file: f } => {
                slots[b].before.append(&mut pending);
                slots[b].action = Some(Action::Change(f));
            }
            Step::Delete { base: b } => {
                slots[b].before.append(&mut pending);
                let keep = matches!(&base[b].1.kind, Kind::Embed(id) if named.contains(id.as_str()))
                    || (bad_table && matches!(&base[b].1.kind, Kind::Table(_)));
                if !keep {
                    slots[b].action = Some(Action::Delete);
                }
            }
        }
    }
    tail.append(&mut pending);

    let mut removed = 0;
    let mut conflicts = Vec::new();
    // Paragraphs the file changed or added, by block id.
    let mut touched: HashSet<String> = HashSet::new();
    // Whether paragraphs were added after the document's last one.
    let appended = !tail.is_empty() && lo + base.len() == n;
    // From the end, so earlier positions stay valid.
    if !tail.is_empty() {
        match paragraphs.get(lo + base.len()) {
            Some(p) => insert_before(txn, p.range.start, &tail, file, peer, &mut touched)?,
            None => {
                let last = &paragraphs[n - 1];
                append(txn, last.newline, &tail, file, peer, &mut touched)?;
            }
        }
    }
    for (b, slot) in slots.iter().enumerate().rev() {
        let p = &paragraphs[lo + b];
        match slot.action {
            Some(Action::Change(f)) => {
                let old = &base[b].1;
                let new = &file[f].para;
                if let Some(id) = &p.id
                    && let Some(now) = current.get(id)
                    && overlap(&old.chars, &new.chars, now)
                {
                    conflicts.push(id.clone());
                }
                removed += change(txn, p, old, new, peer, f)?;
                if let Some(id) = &p.stored_id
                    && old.chars != new.chars
                {
                    touched.insert(id.to_string());
                }
            }
            Some(Action::Delete) => {
                removed += text_count(&base[b].1);
                if let Some(id) = &p.id
                    && let Some(now) = current.get(id)
                    && overlap(&base[b].1.chars, &[], now)
                {
                    conflicts.push(id.clone());
                }
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
            insert_before(txn, p.range.start, &slot.before, file, peer, &mut touched)?;
        }
    }
    if let Some(names) = names.filter(|n| !n.is_empty()) {
        relink(txn, names, &touched)?;
    }
    conflicts.reverse();
    Ok((removed, conflicts))
}

pub(super) fn is_embed(kind: &Kind) -> bool {
    matches!(
        kind,
        Kind::Embed(_) | Kind::Table(_) | Kind::BrokenTable(_) | Kind::Asset { .. }
    )
}

fn text_count(p: &Para) -> usize {
    match &p.kind {
        Kind::Table(rows) => rows.iter().flatten().map(|p| p.chars.len()).sum(),
        _ => p.chars.len(),
    }
}

fn overlap(base: &[char], file: &[char], live: &[char]) -> bool {
    if base == file || base == live || file == live {
        return false;
    }
    let ranges = |other: &[char]| {
        capture_diff_slices(Algorithm::Myers, base, other)
            .into_iter()
            .filter(|op| op.tag() != similar::DiffTag::Equal)
            .map(|op| op.old_range())
            .collect::<Vec<_>>()
    };
    let outside = ranges(live);
    ranges(file)
        .iter()
        .any(|a| outside.iter().any(|b| a.start <= b.end && b.start <= a.end))
}

/// The attributes a file paragraph asks for, over `keep`'s.
fn attrs_of(p: &Para, keep: &BlockAttrs) -> BlockAttrs {
    let mut a = keep.clone();
    a.heading = None;
    a.quote = false;
    a.rule = false;
    a.list = None;
    a.list_level = 0;
    a.checked = false;
    a.code_block = None;
    a.callout = None;
    match &p.kind {
        Kind::Text { heading, quote } => {
            a.heading = heading.and_then(|h| Heading::from_level(h as i64));
            a.quote = *quote;
        }
        Kind::Rule { quote } => {
            a.quote = *quote;
            a.rule = true;
        }
        Kind::List {
            kind,
            level,
            checked,
        } => {
            a.list = Some(kind.clone());
            a.list_level = *level;
            a.checked = *checked;
        }
        Kind::Code(language) => a.code_block = Some(language.clone()),
        Kind::Callout(kind) => a.callout = Some(kind.clone()),
        _ => {}
    }
    a
}

/// Edit paragraph `p` (read as `old`) into `new`; returns how many base
/// characters went.
fn change(
    txn: &mut ProseTxn<'_>,
    p: &Paragraph,
    old: &Para,
    new: &Para,
    peer: u64,
    index: usize,
) -> dr_doc::Result<usize> {
    if let Some(id) = p.embed() {
        return match (&old.kind, &new.kind) {
            (Kind::Table(before), Kind::Table(after)) => {
                table::change(txn, id, before, after, peer, index)
            }
            (Kind::Asset { .. }, Kind::Asset { caption, .. }) => {
                if let Some(EmbedView::Asset { mut look, .. }) = txn.view().embed(id)
                    && look.caption != *caption
                {
                    look.caption.clone_from(caption);
                    txn.set_file_embed_look(id, &look)?;
                }
                Ok(0)
            }
            _ => Ok(0),
        };
    }
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
    // A text edit with unchanged Markdown syntax leaves all stored block
    // attributes alone, including combinations the format cannot represent.
    if old.kind != new.kind {
        let want = attrs_of(new, &p.attrs);
        let mut heading_only = p.attrs.clone();
        heading_only.heading = want.heading;
        let mut checked_only = p.attrs.clone();
        checked_only.checked = want.checked;
        if want == heading_only {
            txn.set_heading(start, want.heading)?;
        } else if want == checked_only {
            txn.set_checked(start, want.checked)?;
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
    for (at, mark) in marks_changed(&now.marks, &want.marks) {
        let at = start + at.start..start + at.end;
        match mark {
            Mark::Style(_, Some(style)) => txn.set_style(at, &style)?,
            Mark::Style(key, None) => txn.clear_style(at, key)?,
            Mark::File(from, to) => {
                if let Some(old) = from {
                    txn.unlink_entity(at.clone(), old.as_str())?;
                }
                if let Some(new) = to {
                    txn.link_entity(
                        at,
                        &EntityLink {
                            target: new.to_string(),
                            kind: EntityKind::Asset,
                            block: None,
                            end_block: None,
                        },
                    )?;
                }
            }
        }
    }
    Ok(())
}

enum Mark {
    Style(StyleKey, Option<InlineStyle>),
    File(Option<AssetId>, Option<AssetId>),
}

fn marks_changed(now: &[Marks], want: &[Marks]) -> Vec<(Range<usize>, Mark)> {
    type Get = fn(&Marks) -> bool;
    let flags: [(Get, StyleKey, InlineStyle); 6] = [
        (|m| m.bold, StyleKey::Bold, InlineStyle::Bold),
        (|m| m.italic, StyleKey::Italic, InlineStyle::Italic),
        (|m| m.underline, StyleKey::Underline, InlineStyle::Underline),
        (|m| m.strike, StyleKey::Strike, InlineStyle::Strike),
        (|m| m.code, StyleKey::Code, InlineStyle::Code),
        (
            |m| m.highlight,
            StyleKey::Highlight,
            InlineStyle::Highlight(String::new()),
        ),
    ];
    let mut edits = Vec::new();
    for (get, key, style) in flags {
        for (range, _, on) in differing(now, want, get) {
            edits.push((range, Mark::Style(key, on.then(|| style.clone()))));
        }
    }
    for (range, _, to) in differing(now, want, |m| m.link.clone()) {
        edits.push((
            range,
            Mark::Style(StyleKey::Link, to.map(InlineStyle::Link)),
        ));
    }
    for (range, from, to) in differing(now, want, |m| m.file.clone()) {
        edits.push((range, Mark::File(from, to)));
    }
    edits
}

fn differing<T: PartialEq>(
    now: &[Marks],
    want: &[Marks],
    state: impl Fn(&Marks) -> T,
) -> Vec<(Range<usize>, T, T)> {
    let mut out: Vec<(Range<usize>, T, T)> = Vec::new();
    for (k, (a, b)) in now.iter().zip(want).enumerate() {
        let (a, b) = (state(a), state(b));
        if a == b {
            continue;
        }
        match out.last_mut() {
            Some((r, from, to)) if r.end == k && *from == a && *to == b => r.end = k + 1,
            _ => out.push((k..k + 1, a, b)),
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
    peer: u64,
    touched: &mut HashSet<String>,
) -> dr_doc::Result<()> {
    for &f in which.iter().rev() {
        let para = &file[f].para;
        if !insert_embed(txn, pos, para, peer, f)? {
            txn.split(pos)?;
            fill(txn, pos, para, touched)?;
        }
    }
    Ok(())
}

fn append(
    txn: &mut ProseTxn<'_>,
    nl: usize,
    which: &[usize],
    file: &[FilePara],
    peer: u64,
    touched: &mut HashSet<String>,
) -> dr_doc::Result<()> {
    let Some((&last, earlier)) = which.split_last() else {
        return Ok(());
    };
    let pos = txn.split(nl)?;
    let para = &file[last].para;
    if !insert_embed(txn, pos, para, peer, last)? {
        fill(txn, pos, para, touched)?;
    }
    insert_before(txn, pos, earlier, file, peer, touched)
}

fn insert_embed(
    txn: &mut ProseTxn<'_>,
    pos: usize,
    para: &Para,
    peer: u64,
    index: usize,
) -> dr_doc::Result<bool> {
    let id = EmbedId::parse(&format!("mirror-{peer:x}-{index}")).expect("valid embed id");
    match &para.kind {
        Kind::Table(rows) => {
            txn.insert_embed(pos, &id, &EmbedKind::Table)?;
            table::change(txn, &id, &[], rows, peer, index)?;
        }
        Kind::Asset { asset, caption } => {
            txn.insert_embed(pos, &id, &EmbedKind::Asset(asset.clone()))?;
            if !caption.is_empty() {
                txn.set_file_embed_look(
                    &id,
                    &FileEmbedLook {
                        caption: caption.clone(),
                        ..Default::default()
                    },
                )?;
            }
        }
        _ => return Ok(false),
    }
    Ok(true)
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
