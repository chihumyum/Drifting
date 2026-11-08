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

use std::collections::{BTreeSet, HashSet};
use std::ops::Range;
use std::sync::Arc;

use dr_doc::anchor::Anchor;
use dr_doc::book::BookView;
use dr_doc::prose::{BorrowedProse, Paragraph, ProseTxn};
use dr_model::DocId;
use dr_model::kind::EntityKind;
use dr_model::prose::EntityLink;
use dr_text::autolink::{LinkMatcher, LinkName, LinkTarget, book_link_names};

use crate::Actor;
use crate::commands::prose::{LinkIn, LinksIn};
use crate::cx::{Cx, EffectAction, Invocation};
use crate::dto::AnchorBytes;
use crate::error::Result;
use crate::workspace::BookSlot;

/// Whether text `actor` writes gets automatic links.
pub fn links_for(actor: &Actor) -> bool {
    matches!(actor, Actor::Agent { .. } | Actor::Mirror | Actor::Import)
}

/// The names text in `doc` links to, from `book` as it is now: the
/// matcher dr-text builds, never linking `doc`'s own entity. Built from
/// scratch (about 50 ms on the heavy seed's 700 names);
/// [`crate::Workspace::link_matcher`] keeps one per book until a name
/// changes.
pub fn matcher(book: &BookView<'_>, doc: &DocId) -> LinkMatcher<LinkTarget> {
    LinkMatcher::new(book_link_names(book, &[doc.entity_id()]))
}

/// Every name of `slot`'s book (dr-text's `book_link_names`), read once
/// until an element or a node changes.
pub(crate) fn book_names(slot: &BookSlot) -> Arc<Vec<LinkName<LinkTarget>>> {
    slot.cache
        .get(crate::cache::Key::LinkNames, &slot.reader.view(), |v| {
            book_link_names(v, &[])
        })
}

/// [`matcher`] for `doc` in `slot`'s book, from the book's cache.
pub(crate) fn book_matcher(slot: &BookSlot, doc: &DocId) -> Arc<LinkMatcher<LinkTarget>> {
    slot.cache.matcher(doc.entity_id(), &book_names(slot))
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

/// What a backfill wrote in one document: the links (target, ranges) it
/// added and the links of others it removed.
#[derive(Default)]
struct Written {
    linked: Vec<(LinkTarget, Vec<Range<usize>>)>,
    unlinked: Vec<(LinkTarget, Vec<Range<usize>>)>,
}

fn push_range(list: &mut Vec<(LinkTarget, Vec<Range<usize>>)>, t: LinkTarget, r: Range<usize>) {
    match list.iter_mut().find(|(x, _)| *x == t) {
        Some((_, v)) => v.push(r),
        None => list.push((t, vec![r])),
    }
}

/// Whether a command by this actor fills in links for a new name.
fn backfills(cx: &Cx<'_>) -> bool {
    cx.workspace().auto_links() && matches!(cx.actor(), Actor::User | Actor::Agent { .. })
}

/// [`backfill`] for element `id`, now named `name` with `aliases`, that
/// gained the names `added` (it is new, renamed or given aliases).
pub(crate) fn backfill_element(
    cx: &Cx<'_>,
    slot: &BookSlot,
    id: &dr_model::id::ElementId,
    name: &str,
    aliases: &[String],
    added: &[String],
) -> Result<usize> {
    backfill_element_leaving(cx, slot, id, name, aliases, added, None)
}

/// [`backfill_element`] when entity `leaving` goes in the same command (an
/// idea turned into this element): its names no longer count.
pub(crate) fn backfill_element_leaving(
    cx: &Cx<'_>,
    slot: &BookSlot,
    id: &dr_model::id::ElementId,
    name: &str,
    aliases: &[String],
    added: &[String],
    leaving: Option<&str>,
) -> Result<usize> {
    if !backfills(cx) || added.is_empty() {
        return Ok(0);
    }
    let target = LinkTarget::new(EntityKind::Element, id.as_str());
    let mut names: Vec<LinkName<LinkTarget>> = book_names(slot)
        .iter()
        .filter(|n| n.target != target && Some(n.target.id.as_str()) != leaving)
        .cloned()
        .collect();
    // Its names among the elements', before the titles (the order dr-text
    // gives them once the book write lands).
    let at = names
        .iter()
        .position(|n| n.target.kind != EntityKind::Element)
        .unwrap_or(names.len());
    let own = std::iter::once(name.to_string())
        .chain(aliases.iter().cloned())
        .map(|n| LinkName::new(n, target.clone()));
    names.splice(at..at, own);
    backfill(cx, slot, &target, &names, added)
}

/// [`backfill`] for chapter or idea `id`, new or retitled `title`.
pub(crate) fn backfill_title(
    cx: &Cx<'_>,
    slot: &BookSlot,
    id: &dr_model::id::NodeId,
    title: &str,
) -> Result<usize> {
    if !backfills(cx) {
        return Ok(0);
    }
    let target = LinkTarget::new(EntityKind::Node, id.as_str());
    let mut names: Vec<LinkName<LinkTarget>> = book_names(slot)
        .iter()
        .filter(|n| n.target != target)
        .cloned()
        .collect();
    names.push(LinkName::new(title, target.clone()));
    backfill(cx, slot, &target, &names, &[title.to_string()])
}

/// Link `added` (names `target` gained in this command) in the text
/// already written in `slot`'s book; `names` is every name of the book as
/// it will be once the command's book write lands. Step 2 of the write
/// order: call it before the book write. Declares each document's undo.
/// Returns how many links were written.
fn backfill(
    cx: &Cx<'_>,
    slot: &BookSlot,
    target: &LinkTarget,
    names: &[LinkName<LinkTarget>],
    added: &[String],
) -> Result<usize> {
    let added: Vec<String> = added
        .iter()
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .collect();
    if added.is_empty() {
        return Ok(0);
    }
    let pairs: HashSet<(String, String)> = added
        .iter()
        .map(|n| (n.clone(), target.id.clone()))
        .collect();
    // The documents that may hold a new name.
    let ws = cx.workspace();
    let book = slot.book.as_str();
    let mut docs: BTreeSet<String> = BTreeSet::new();
    for n in &added {
        for h in ws.library().search(Some(book), n, usize::MAX >> 1)? {
            docs.insert(h.doc_id);
        }
    }
    docs.extend(ws.open_prose(&slot.book).into_iter().map(|d| d.to_string()));
    // Only live pages of these kinds, never the target's own (from the
    // book's cached reads: a key read of Loro per document added up).
    let all_nodes = crate::commands::nodes(slot);
    let live_elements: HashSet<String> = crate::commands::elements(slot)
        .iter()
        .filter(|e| e.deleted_at.is_none())
        .map(|e| e.id.to_string())
        .collect();
    let (lines, cats) = (
        crate::commands::storylines(slot),
        crate::commands::categories(slot),
    );
    let live = |d: &DocId| -> bool {
        match d {
            DocId::Node(id) => all_nodes.get(id).is_some_and(|n| !n.is_trashed()),
            DocId::Element(id) => live_elements.contains(id.as_str()),
            DocId::Storyline(id) => lines.iter().any(|s| &s.id == id && s.deleted_at.is_none()),
            DocId::Category(id) => cats.iter().any(|c| &c.id == id && c.deleted_at.is_none()),
            _ => false,
        }
    };
    let docs: Vec<DocId> = docs
        .iter()
        .filter_map(|d| DocId::parse(d).ok())
        .filter(|d| d.entity_id() != target.id && live(d))
        .collect();
    // One matcher for the command; a document whose own entity's names
    // occur in it gets one without them (a page never links to itself).
    let shared = Arc::new(LinkMatcher::new(names.iter().cloned()));
    let writer = cx.prose_writer()?;
    // A few documents at a time: opening a long chapter is a load from
    // SQLite, most of a document's time.
    let done = crate::holder::par_map(&docs, |doc| {
        backfill_doc(ws, &writer, doc, names, &shared, &added, &pairs)
    })?;
    let mut total = 0;
    let (mut unlink, mut relink) = (Vec::new(), Vec::new());
    for (doc, done) in docs.iter().zip(done) {
        let Some((n, linked, unlinked)) = done.filter(|d| d.0 > 0) else {
            continue;
        };
        total += n;
        let doc = doc.to_string();
        cx.effect(EffectAction::Updated, "prose", doc.clone(), None);
        let entry = |(t, anchors): (LinkTarget, Vec<AnchorBytes>)| LinkIn {
            doc: doc.clone(),
            target: (&t).into(),
            anchors,
        };
        unlink.extend(linked.into_iter().map(entry));
        relink.extend(unlinked.into_iter().map(entry));
    }
    // The undo: one command for every document.
    if !unlink.is_empty() {
        cx.undo_with(Invocation::new("prose.unlink", LinksIn { links: unlink }));
    }
    if !relink.is_empty() {
        cx.undo_with(Invocation::new("prose.link", LinksIn { links: relink }));
    }
    Ok(total)
}

/// Links added to (or taken off) a document, with anchors for the undo.
type Anchored = Vec<(LinkTarget, Vec<AnchorBytes>)>;

/// [`backfill`] in one document: `None` when it has nothing to link (no
/// write then); otherwise how many links were written and their anchors.
fn backfill_doc(
    ws: &crate::Workspace,
    writer: &crate::cx::ProseWriter,
    doc: &DocId,
    names: &[LinkName<LinkTarget>],
    shared: &Arc<LinkMatcher<LinkTarget>>,
    added: &[String],
    pairs: &HashSet<(String, String)>,
) -> Result<Option<(usize, Anchored, Anchored)>> {
    let ps = ws.prose_slot_passing(doc)?;
    let view = ps.reader.view();
    let has_new = |t: &str| added.iter().any(|n| t.contains(n.as_str()));
    if !view.paragraphs().any(|p| has_new(&p.text())) {
        return Ok(None);
    }
    let own = doc.entity_id();
    let text = view.plain_text();
    let matcher = if names
        .iter()
        .any(|n| n.target.id == own && text.contains(n.name.as_str()))
    {
        Arc::new(LinkMatcher::new(
            names.iter().filter(|n| n.target.id != own).cloned(),
        ))
    } else {
        shared.clone()
    };
    // Plan on what is there now: no write when nothing would change. The
    // write plans again on the state it applies to.
    let needed = view.paragraphs().any(|p| {
        let t = p.text();
        has_new(&t)
            && !keep_added(&t, plan(&t, &link_runs(&p), &matcher, 0..p.len()), pairs).is_empty()
    });
    if !needed {
        return Ok(None);
    }
    let (d2, pairs, added) = (doc.clone(), pairs.clone(), added.to_vec());
    let (n, linked, unlinked) = writer.write(&ps, move |d| {
        let b = BorrowedProse::new(d, &d2)?;
        let mut txn = b.txn();
        let mut todo: Vec<(usize, Vec<LinkEdit>)> = Vec::new();
        let mut w = Written::default();
        for p in txn.view().paragraphs() {
            let text = p.text();
            if !added.iter().any(|n| text.contains(n.as_str())) {
                continue;
            }
            let edits = keep_added(
                &text,
                plan(&text, &link_runs(&p), &matcher, 0..p.len()),
                &pairs,
            );
            for e in &edits {
                let at = p.range.start;
                match e {
                    LinkEdit::Link { range, target } => push_range(
                        &mut w.linked,
                        target.clone(),
                        at + range.start..at + range.end,
                    ),
                    LinkEdit::Unlink { range, target } => {
                        // The kind, from the link being taken off.
                        let kind = p
                            .runs
                            .iter()
                            .flat_map(|r| r.marks.entities.iter())
                            .find(|l| l.target == *target)
                            .map(|l| l.kind.clone())
                            .unwrap_or(EntityKind::Element);
                        push_range(
                            &mut w.unlinked,
                            LinkTarget::new(kind, target.clone()),
                            at + range.start..at + range.end,
                        )
                    }
                }
            }
            if !edits.is_empty() {
                todo.push((p.range.start, edits));
            }
        }
        let mut n = 0;
        for (start, edits) in &todo {
            n += apply(&mut txn, *start, edits)?;
        }
        // Anchors on what was written, for the undo.
        let body = d.get_text(dr_doc::schema::prose::BODY);
        let anchor = |r: &Range<usize>| {
            Anchor::new(&body, r.clone()).map(|a| AnchorBytes::from(&a.encode()))
        };
        let anchors = |l: &[(LinkTarget, Vec<Range<usize>>)]| -> Anchored {
            l.iter()
                .map(|(t, rs)| (t.clone(), rs.iter().filter_map(anchor).collect()))
                .collect()
        };
        Ok((n, anchors(&w.linked), anchors(&w.unlinked)))
    })?;
    Ok(Some((n, linked, unlinked)))
}
