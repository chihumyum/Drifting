//! Automatic entity links (人物自动链接): in text other writers put in, and
//! in the text already written when the book gains a name.
//!
//! **The rule** is dr-text's matcher (`dr_text::autolink`) with the editor's
//! choices (`dr-editor`'s `entity_links.rs`), and [`plan`] is the one place
//! it is written down, for the editor too: every live element's name and
//! aliases and every live chapter's and idea's title, matched verbatim,
//! leftmost-longest, never a document's own entity.
//!
//! - A name already linked to its target all the way is left alone; one
//!   linked part of the way is linked whole (a split link heals).
//! - A shorter link of someone else lying inside the name gives way to the
//!   longer name.
//! - Someone else's link reaching outside the name, or covering exactly the
//!   name, is left alone with the name: the second is an old name another
//!   entity has taken since, and the text still means the one it links to.
//!
//! **Text other writers put in.** A command links only names lying wholly
//! inside the text it wrote ([`link_written`]), in the same commit, so
//! undoing the command takes the links with the text. The editor links
//! whole paragraphs the author typed in because they are the author's; a
//! command's writer (an Agent, an import) has no business linking the
//! author's text around it (f4e-editor.md 「自动链接只链作者打的字」). A name
//! split across the written text and the text around it stays unlinked.
//! Whose writes get links: an Agent's, the Markdown mirror's and an
//! import's ([`links_for`]). Not the author's own commands (the author's
//! text is linked by the editor as they type), and not sync (the other
//! device linked its text already).
//!
//! **Text already written** (0.1's `retroactive-entity-links` and
//! `element-name-backfill`): when a command gives the book a new name (an
//! element created, renamed or given an alias; a chapter or idea created
//! or retitled), the text of every live chapter, idea, element, storyline
//! and category that holds the name gains its links, the new name's only,
//! by the same rule (`backfill`). Material notes are left alone, as in
//! 0.1. Each document is one commit with the command's origin (the author's
//! is `user:command`, outside every editor's undo, so an editor open on the
//! document keeps its own steps), and the command's journal entry undoes
//! them: `prose.unlink` on the links it wrote, `prose.link` on the shorter
//! links of others it removed, both by anchor, so the author's typing since
//! moves nothing. Which documents: the ones dr-store's paragraph index
//! finds the name in, and every document open here (its newest text may not
//! be indexed yet).
//!
//! The author's setting `editor.auto_entity_links` (on by default) governs
//! all of it: the shell passes it on with [`crate::Workspace::set_auto_links`].

use std::collections::HashSet;
use std::ops::Range;
use std::sync::Arc;

use dr_doc::prose::{Paragraph, ProseTxn};
use dr_model::DocId;
use dr_model::kind::EntityKind;
use dr_model::prose::EntityLink;
use dr_text::autolink::{LinkMatcher, LinkName, LinkTarget};

use crate::Actor;
use crate::workspace::BookSlot;

/// Whether text `actor` writes gets automatic links.
pub fn links_for(actor: &Actor) -> bool {
    matches!(actor, Actor::Agent { .. } | Actor::Mirror | Actor::Import)
}

pub fn matcher(book: &dr_doc::v3::BookViewV3<'_>, doc: &DocId) -> LinkMatcher<LinkTarget> {
    let own = match doc {
        DocId::Body(body) => body.entry().as_str(),
        _ => doc.entity_id(),
    };
    LinkMatcher::new(
        book_link_names_v3(book)
            .into_iter()
            .filter(|n| n.target.id != own),
    )
}
fn book_link_names_v3(v: &dr_doc::v3::BookViewV3<'_>) -> Vec<LinkName<LinkTarget>> {
    let ordered = v.entries();
    let entries: std::collections::BTreeMap<_, _> =
        ordered.iter().map(|e| (e.id.clone(), e.clone())).collect();
    let templates = v.templates_map();
    let names = dr_model::v3::AutolinkNames::of(&entries, &templates);
    let mut out = Vec::new();
    for e in ordered {
        if e.name_conflict.is_some() || !names.is_linked(&e.id) {
            continue;
        }
        let target = LinkTarget::new(EntityKind::Entry, e.id.as_str());
        for name in std::iter::once(e.title.clone()).chain(e.aliases(&templates)) {
            if !name.trim().is_empty() {
                out.push(LinkName::new(name, target.clone()));
            }
        }
    }
    out
}

pub type CachedLinkNames = Arc<Vec<LinkName<LinkTarget>>>;
pub type CachedLinkMatcher = Arc<LinkMatcher<LinkTarget>>;
pub(crate) type SlotLinkCache = (loro::Frontiers, CachedLinkNames, CachedLinkMatcher);

pub(crate) fn book_cache(slot: &BookSlot) -> SlotLinkCache {
    let now = slot.handle.doc().oplog_frontiers();
    let epoch = {
        let guard = crate::holder::lock(&slot.link_names);
        if let Some((cached_at, names, matcher)) = &guard.1
            && *cached_at == now
        {
            return (cached_at.clone(), names.clone(), matcher.clone());
        }
        guard.0
    };
    let book = slot.book.clone();
    let computed = slot
        .handle
        .read(move |d| {
            let frontiers = d.oplog_frontiers();
            let names = dr_doc::v3::BorrowedBookV3::new(d, &book)
                .map(|b| book_link_names_v3(&b.view()))
                .unwrap_or_default();
            let matcher = Arc::new(LinkMatcher::new(names.iter().cloned()));
            (frontiers, Arc::new(names), matcher)
        })
        .ok();
    if let Some((frontiers, names, matcher)) = computed {
        let mut guard = crate::holder::lock(&slot.link_names);
        if guard.0 == epoch {
            guard.1 = Some((frontiers.clone(), names.clone(), matcher.clone()));
        }
        (frontiers, names, matcher)
    } else {
        let names = book_link_names_v3(&slot.reader_v3.view());
        let matcher = Arc::new(LinkMatcher::new(names.iter().cloned()));
        (now, Arc::new(names), matcher)
    }
}

/// Every name of `slot`'s book (dr-text's `book_link_names`), read once
/// until an element or a node changes.
pub(crate) fn book_names(slot: &BookSlot) -> Arc<Vec<LinkName<LinkTarget>>> {
    book_cache(slot).1
}

/// [`matcher`] excluding `self_id`, reusing the book's compiled automaton
/// whenever `self_id` is not itself an auto-linked entry.
pub(crate) fn book_matcher_for_owner(
    slot: &BookSlot,
    self_id: &str,
) -> Arc<LinkMatcher<LinkTarget>> {
    let (_, names, full) = book_cache(slot);
    if self_id.is_empty() || !names.iter().any(|n| n.target.id == self_id) {
        return full;
    }
    Arc::new(LinkMatcher::new(
        names.iter().filter(|n| n.target.id != self_id).cloned(),
    ))
}

/// [`matcher`] for `doc` in `slot`'s book, from the book's cache.
pub(crate) fn book_matcher(slot: &BookSlot, doc: &DocId) -> Arc<LinkMatcher<LinkTarget>> {
    let self_id = match doc {
        DocId::Body(b) => b.entry().as_str(),
        _ => doc.entity_id(),
    };
    book_matcher_for_owner(slot, self_id)
}

/// A run of one entity link on a paragraph (adjacent spans of one target
/// joined), in characters of the paragraph.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkRun {
    pub range: Range<usize>,
    /// The target id.
    pub target: String,
}

/// One change to a paragraph's links, in characters of the paragraph.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LinkEdit {
    Link {
        range: Range<usize>,
        target: LinkTarget,
    },
    Unlink {
        range: Range<usize>,
        /// The target id.
        target: String,
    },
}

/// The link runs of dr-doc paragraph `p`, in characters of the paragraph,
/// sorted by position.
pub fn link_runs(p: &Paragraph) -> Vec<LinkRun> {
    let mut runs: Vec<LinkRun> = Vec::new();
    let mut at = 0;
    for r in &p.runs {
        let span = at..at + r.text.chars().count();
        for l in &r.marks.entities {
            match runs
                .iter_mut()
                .rev()
                .find(|o| o.target == l.target && o.range.end == span.start)
            {
                Some(o) => o.range.end = span.end,
                None => runs.push(LinkRun {
                    range: span.clone(),
                    target: l.target.clone(),
                }),
            }
        }
        at = span.end;
    }
    runs.sort_by_key(|r| (r.range.start, r.range.end));
    runs
}

/// The links one paragraph gains (the rule in the module documentation),
/// computing only: `text` is the paragraph's text, `runs` its links
/// ([`link_runs`]), and only names lying wholly inside `within` count
/// (characters of the paragraph; `0..len` for all of it). Each link comes
/// right after the shorter links of others it replaces.
pub fn plan(
    text: &str,
    runs: &[LinkRun],
    names: &LinkMatcher<LinkTarget>,
    within: Range<usize>,
) -> Vec<LinkEdit> {
    let mut edits = Vec::new();
    for m in names.find(text) {
        let r = m.range.clone();
        if r.start < within.start || r.end > within.end {
            continue;
        }
        let target = names.target(&m);
        let over: Vec<&LinkRun> = runs
            .iter()
            .filter(|o| o.range.start < r.end && r.start < o.range.end)
            .collect();
        // Linked to its target all the way already.
        let covered = |i: usize| {
            over.iter()
                .any(|o| o.target == target.id && o.range.contains(&i))
        };
        if r.clone().all(covered) {
            continue;
        }
        // Someone else's link reaching outside the name, or covering
        // exactly the name: leave both alone.
        if over.iter().any(|o| {
            o.target != target.id
                && (o.range.start < r.start || o.range.end > r.end || o.range == r)
        }) {
            continue;
        }
        for o in over.iter().filter(|o| o.target != target.id) {
            edits.push(LinkEdit::Unlink {
                range: o.range.clone(),
                target: o.target.clone(),
            });
        }
        edits.push(LinkEdit::Link {
            range: r,
            target: target.clone(),
        });
    }
    edits
}

/// Keeps the edits of [`plan`] that link one of `added` (`(name, target
/// id)`; the name as `text` spells it), each with the shorter links it
/// replaces: a new name's links only, the others the book already had are
/// the editor's business.
pub fn keep_added(
    text: &str,
    edits: Vec<LinkEdit>,
    added: &HashSet<(String, String)>,
) -> Vec<LinkEdit> {
    let mut out = Vec::new();
    let mut pending = Vec::new();
    for edit in edits {
        match &edit {
            LinkEdit::Unlink { .. } => pending.push(edit),
            LinkEdit::Link { range, target } => {
                let name: String = text.chars().skip(range.start).take(range.len()).collect();
                if added.contains(&(name, target.id.clone())) {
                    out.append(&mut pending);
                    out.push(edit);
                } else {
                    pending.clear();
                }
            }
        }
    }
    out
}

/// Write `edits` of the paragraph starting at `start`. Returns how many
/// links were written.
pub fn apply(txn: &mut ProseTxn<'_>, start: usize, edits: &[LinkEdit]) -> dr_doc::Result<usize> {
    let mut linked = 0;
    for e in edits {
        match e {
            LinkEdit::Unlink { range, target } => {
                txn.unlink_entity(start + range.start..start + range.end, target)?
            }
            LinkEdit::Link { range, target } => {
                txn.link_entity(
                    start + range.start..start + range.end,
                    &EntityLink {
                        target: target.id.clone(),
                        kind: target.kind.clone(),
                        block: None,
                        end_block: None,
                    },
                )?;
                linked += 1;
            }
        }
    }
    Ok(linked)
}

/// Link every name lying wholly inside `written` (character positions in
/// `txn`'s document, the text the caller has just written in this
/// transaction). Returns how many links were written. Nothing outside
/// `written` changes, except a shorter link of someone else lying wholly
/// inside a name that is linked now.
pub fn link_written(
    txn: &mut ProseTxn<'_>,
    names: &LinkMatcher<LinkTarget>,
    written: Range<usize>,
) -> dr_doc::Result<usize> {
    link_written_with_v3(txn, names, written, false)
}

/// v3 written text: preserve explicit module/range/material/opaque links.
/// Bare entry-name links retain the normal healing/longest-name rule.
/// Call this inside the same guarded prose write as the inserted text.
pub fn link_written_v3(
    txn: &mut ProseTxn<'_>,
    names: &LinkMatcher<LinkTarget>,
    written: Range<usize>,
) -> dr_doc::Result<usize> {
    link_written_with_v3(txn, names, written, true)
}

fn link_written_with_v3(
    txn: &mut ProseTxn<'_>,
    names: &LinkMatcher<LinkTarget>,
    written: Range<usize>,
    v3: bool,
) -> dr_doc::Result<usize> {
    if names.is_empty() || written.is_empty() {
        return Ok(0);
    }
    let mut todo: Vec<(usize, Vec<LinkEdit>)> = Vec::new();
    for p in txn.view().paragraphs() {
        if p.range.end <= written.start || written.end <= p.range.start {
            continue;
        }
        let within = written.start.max(p.range.start) - p.range.start
            ..written.end.min(p.range.end) - p.range.start;
        let edits = plan(&p.text(), &link_runs(&p), names, within);
        let edits = if v3 {
            let raw = txn.view().copy_entity_links_v3(p.range.clone())?;
            let protected: Vec<_> = raw
                .marks()
                .iter()
                .filter_map(|(range, _, value)| {
                    let bare = matches!(value, loro::LoroValue::Map(m)
                    if m.len() == 1 && m.get("kind") == Some(&loro::LoroValue::from("entry")));
                    (!bare).then_some(range)
                })
                .collect();
            let mut kept = Vec::new();
            let mut pending = Vec::new();
            for edit in edits {
                let LinkEdit::Link { range, .. } = &edit else {
                    pending.push(edit);
                    continue;
                };
                if protected
                    .iter()
                    .any(|r| r.start < range.end && range.start < r.end)
                {
                    pending.clear();
                } else {
                    kept.append(&mut pending);
                    kept.push(edit);
                }
            }
            kept
        } else {
            edits
        };
        if !edits.is_empty() {
            todo.push((p.range.start, edits));
        }
    }
    let mut linked = 0;
    for (start, edits) in todo {
        linked += apply(txn, start, &edits)?;
    }
    Ok(linked)
}

/// The compiled names of `book` for [`plan_book_text`], for a writer
/// without an open book (an import): build it once for a book's revision and
/// plan every text of that revision with it. Open books use [`book_cache`].
pub fn book_text_matcher(book: &dr_doc::v3::BookViewV3<'_>) -> LinkMatcher<LinkTarget> {
    LinkMatcher::new(book_link_names_v3(book))
}

/// One link of a text being planned, and whether automatic links leave it
/// alone.
struct Planned {
    link: dr_model::v3::EntryTextLink,
    pinned: bool,
}

/// Where each character of `old` is in `new`, for the characters the edit
/// left as they were. A text so long and so changed that the diff runs out
/// of time counts as rewritten where the diff stopped looking.
fn unchanged(old: &str, new: &str) -> Vec<Option<usize>> {
    let old: Vec<char> = old.chars().collect();
    let new: Vec<char> = new.chars().collect();
    let mut at = vec![None; old.len()];
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(100);
    for op in
        similar::capture_diff_slices_deadline(similar::Algorithm::Myers, &old, &new, Some(deadline))
    {
        if let similar::DiffOp::Equal {
            old_index,
            new_index,
            len,
        } = op
        {
            for (k, slot) in at[old_index..old_index + len].iter_mut().enumerate() {
                *slot = Some(new_index + k);
            }
        }
    }
    at
}

/// `range` of the old text in the new one, when every character of it is
/// unchanged and nothing was written between them.
fn carried(at: &[Option<usize>], range: Range<usize>) -> Option<Range<usize>> {
    let start = (*at.get(range.start)?)?;
    for (k, i) in range.clone().enumerate() {
        if *at.get(i)? != Some(start + k) {
            return None;
        }
    }
    Some(start..start + range.len())
}

/// Plan the links of a comment's or a relation description's text without
/// writing the book (`kernel-v5.md` §19 「描述和批注里的链接」).
///
/// - `stored` is the text the draft replaces, as stored (`comment_body_raw`,
///   `relation_type_raw`). Its writer read it with live links under their
///   entries' titles and the links to entries in Recently Deleted as plain
///   text. A link on a span the edit leaves unchanged (characters diffed
///   against what the writer read) is carried over when its entry is in
///   Recently Deleted: the writer could not see it, and it comes back with
///   the entry. A plain-string draft (a writer that sends no links: the
///   review panel's composer, an Agent) carries every link of an unchanged
///   span. A draft with links states the visible ones itself, so a visible
///   link it leaves out comes off.
/// - The links the draft adds (picked with @: not the stored link of the
///   same span) and those carried to entries in Recently Deleted stay as they
///   are. The rest are automatic and follow the prose rule (module
///   documentation): a shorter one lying inside a longer name gives way to
///   it.
/// - `names` is the book's compiled matcher ([`book_cache`],
///   [`book_text_matcher`]), `None` when the text gets no automatic links. A
///   comment never links the entry it is on (`owner`), as a prose document
///   never links itself.
pub fn plan_book_text(
    book: &dr_doc::v3::BookViewV3<'_>,
    owner: Option<&dr_model::id::EntryId>,
    names: Option<&LinkMatcher<LinkTarget>>,
    stored: Option<&dr_model::v3::LinkedText>,
    draft: &crate::dto::LinkedTextIn,
) -> crate::Result<dr_model::v3::LinkedText> {
    use dr_model::id::EntryId;
    use dr_model::v3::{EntryTextLink, LinkedText};

    let plain = matches!(draft, crate::dto::LinkedTextIn::Plain(_));
    let draft = LinkedText::from(draft.clone());
    draft.validate()?;
    let not_owner = |entry: &EntryId| Some(entry) != owner;
    for link in &draft.links {
        if book.entry_raw(&link.entry).is_none() {
            return Err(crate::WsError::not_found("entry", link.entry.as_str()));
        }
    }
    let mut planned: Vec<Planned> = Vec::new();
    let mut hidden_links = Vec::new();
    let mut echoed = Vec::new();
    if let Some(stored) = stored.filter(|s| !s.links.is_empty()) {
        let mut hidden = std::collections::BTreeSet::new();
        // What the writer read, with the hidden links still in it: an empty
        // title keeps the stored spelling.
        let read = stored.with_titles(|id| {
            let entry = book.entry_raw(id)?;
            if entry.deleted_at.is_some() {
                hidden.insert(id.clone());
                return Some(String::new());
            }
            Some(entry.title)
        });
        let at = unchanged(&read.text, &draft.text);
        for link in read.links.iter().filter(|l| not_owner(&l.entry)) {
            let Some(range) = carried(&at, link.range()) else {
                continue;
            };
            let link = EntryTextLink {
                start: range.start,
                end: range.end,
                entry: link.entry.clone(),
            };
            if hidden.contains(&link.entry) {
                hidden_links.push(link);
            } else if plain {
                planned.push(Planned {
                    link,
                    pinned: false,
                });
            } else {
                echoed.push(link);
            }
        }
    }
    for link in draft.links.iter().filter(|l| not_owner(&l.entry)) {
        planned.push(Planned {
            pinned: !echoed.contains(link),
            link: link.clone(),
        });
    }
    for link in hidden_links {
        if !planned
            .iter()
            .any(|p| p.link.start < link.end && link.start < p.link.end)
        {
            planned.push(Planned { link, pinned: true });
        }
    }
    planned.sort_by_key(|p| p.link.start);
    if let Some(full) = names.filter(|_| !draft.text.is_empty()) {
        // The book's matcher, without the owner's names only when the text
        // holds one: leftmost-longest matching finds the same names either
        // way when none of the owner's is among them.
        let own;
        let names = match owner {
            Some(owner)
                if full
                    .find(&draft.text)
                    .iter()
                    .any(|m| full.target(m).id == owner.as_str()) =>
            {
                own = LinkMatcher::new(
                    full.names()
                        .iter()
                        .filter(|n| n.target.id != owner.as_str())
                        .cloned(),
                );
                &own
            }
            _ => full,
        };
        let runs: Vec<LinkRun> = planned
            .iter()
            .map(|p| LinkRun {
                range: p.link.range(),
                target: p.link.entry.to_string(),
            })
            .collect();
        let pinned: Vec<Range<usize>> = planned
            .iter()
            .filter(|p| p.pinned)
            .map(|p| p.link.range())
            .collect();
        let mut pending = Vec::new();
        for edit in plan(&draft.text, &runs, names, 0..draft.text.chars().count()) {
            match edit {
                LinkEdit::Unlink { range, target } => pending.push((range, target)),
                LinkEdit::Link { range, target } => {
                    let gone = std::mem::take(&mut pending);
                    let Ok(entry) = EntryId::parse(&target.id) else {
                        continue;
                    };
                    if pinned
                        .iter()
                        .any(|p| p.start < range.end && range.start < p.end)
                    {
                        continue;
                    }
                    planned.retain(|p| {
                        !gone
                            .iter()
                            .any(|(r, t)| *r == p.link.range() && *t == p.link.entry.as_str())
                    });
                    // A split link of the same entry heals into one.
                    let mut whole = range;
                    planned.retain(|p| {
                        let over = p.link.start < whole.end && whole.start < p.link.end;
                        if over && p.link.entry == entry {
                            whole = whole.start.min(p.link.start)..whole.end.max(p.link.end);
                        }
                        !over
                    });
                    planned.push(Planned {
                        link: EntryTextLink {
                            start: whole.start,
                            end: whole.end,
                            entry,
                        },
                        pinned: false,
                    });
                }
            }
        }
        planned.sort_by_key(|p| p.link.start);
    }
    let result = LinkedText {
        text: draft.text,
        links: planned.into_iter().map(|p| p.link).collect(),
    };
    result.validate()?;
    Ok(result)
}

impl crate::Workspace {
    /// The author's automatic-link setting applied to a draft of linked text
    /// that replaces nothing (a new comment or description), with the book's
    /// cached matcher. The draft's links are the author's own picks.
    pub fn plan_entry_text_links(
        &self,
        book: &dr_model::id::BookId,
        owner: Option<&dr_model::id::EntryId>,
        draft: &dr_model::v3::LinkedText,
    ) -> crate::Result<dr_model::v3::LinkedText> {
        let slot = self.book_slot(book)?;
        let names = self.auto_links().then(|| book_cache(&slot).2);
        plan_book_text(
            &slot.reader_v3.view(),
            owner,
            names.as_deref(),
            None,
            &crate::dto::LinkedTextIn::Linked(draft.clone()),
        )
    }
}
