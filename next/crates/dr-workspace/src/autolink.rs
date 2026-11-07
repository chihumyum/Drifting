//! Automatic entity links (人物自动链接) in text other writers put in: an
//! Agent's `prose.replace` or new chapter with text, and, through the public
//! functions here, the 0.1 import and the Markdown mirror.
//!
//! The rule is dr-text's (`dr_text::autolink`), the one the editor applies
//! half a second after the author stops typing (`dr-editor`'s
//! `entity_links.rs`): every live element's name and aliases and every live
//! chapter's and idea's title, matched verbatim, leftmost-longest, never a
//! document's own entity; a name already linked to its target is left
//! alone; a shorter name inside it linked to someone else gives way; a link
//! of someone else that reaches outside the name is never crossed.
//!
//! One difference, on purpose: a command links only names lying **wholly
//! inside the text it wrote**. The editor links whole paragraphs the author
//! typed in because they are the author's; a command's writer (an Agent, an
//! import) has no business linking the author's text around it (f4e-editor.md
//! 「自动链接只链作者打的字」). It also makes the links leave with the text: the
//! links are written in the same commit as the text, and undoing the command
//! (its inverse deletes that text, or history reverts the commit) takes them
//! away, with nothing left on the author's words. A name split across the
//! written text and the text around it stays unlinked.
//!
//! Whose writes get links: an Agent's, the Markdown mirror's and an
//! import's ([`links_for`]). Not the author's own commands (the author's
//! text is linked by the editor as they type, and an author's command is
//! theirs to link), and not sync (the other device linked its text already).
//!
//! The author's setting `editor.auto_entity_links` (on by default) governs
//! all of it: the shell passes it on with [`crate::Workspace::set_auto_links`].

use std::ops::Range;

use dr_doc::book::BookView;
use dr_doc::prose::ProseTxn;
use dr_model::DocId;
use dr_model::prose::EntityLink;
use dr_text::autolink::{LinkMatcher, LinkTarget, book_link_names};

use crate::Actor;

/// Whether text `actor` writes gets automatic links.
pub fn links_for(actor: &Actor) -> bool {
    matches!(actor, Actor::Agent { .. } | Actor::Mirror | Actor::Import)
}

/// The names text in `doc` links to, from `book` as it is now: the
/// matcher dr-text builds, never linking `doc`'s own entity.
pub fn matcher(book: &BookView<'_>, doc: &DocId) -> LinkMatcher<LinkTarget> {
    LinkMatcher::new(book_link_names(book, &[doc.entity_id()]))
}

/// One change to the links of a paragraph.
#[derive(Clone, Debug, PartialEq)]
enum Edit {
    Unlink(Range<usize>, String),
    Link(Range<usize>, LinkTarget),
}

/// Link every name lying wholly inside `written` (character positions in
/// `txn`'s document, the text the caller has just written in this
/// transaction). Returns how many links were written. Nothing outside
/// `written` changes, except a shorter link of someone else lying wholly
/// inside a name that is linked now (the editor's rule).
pub fn link_written(
    txn: &mut ProseTxn<'_>,
    names: &LinkMatcher<LinkTarget>,
    written: Range<usize>,
) -> dr_doc::Result<usize> {
    if names.is_empty() || written.is_empty() {
        return Ok(0);
    }
    let mut edits = Vec::new();
    {
        let view = txn.view();
        for p in view.paragraphs() {
            if p.range.end <= written.start || written.end <= p.range.start {
                continue;
            }
            // The paragraph's links as maximal runs of one target (adjacent
            // spans joined), in document positions, as the editor reads them.
            let mut runs: Vec<(Range<usize>, String)> = Vec::new();
            let mut at = p.range.start;
            for r in &p.runs {
                let span = at..at + r.text.chars().count();
                for l in &r.marks.entities {
                    match runs
                        .iter_mut()
                        .rev()
                        .find(|(o, t)| *t == l.target && o.end == span.start)
                    {
                        Some((o, _)) => o.end = span.end,
                        None => runs.push((span.clone(), l.target.clone())),
                    }
                }
                at = span.end;
            }
            let text: String = p.runs.iter().map(|r| r.text.as_str()).collect();
            for m in names.find(&text) {
                let r = p.range.start + m.range.start..p.range.start + m.range.end;
                if r.start < written.start || r.end > written.end {
                    continue;
                }
                let target = names.target(&m);
                let over: Vec<&(Range<usize>, String)> = runs
                    .iter()
                    .filter(|(o, _)| o.start < r.end && r.start < o.end)
                    .collect();
                // Linked to its target all the way already.
                let covered =
                    |i: usize| over.iter().any(|(o, t)| *t == target.id && o.contains(&i));
                if r.clone().all(covered) {
                    continue;
                }
                // Someone else's link reaching outside the name: leave both.
                if over
                    .iter()
                    .any(|(o, t)| *t != target.id && (o.start < r.start || o.end > r.end))
                {
                    continue;
                }
                for (o, t) in over.iter().filter(|(_, t)| *t != target.id) {
                    edits.push(Edit::Unlink(o.clone(), t.clone()));
                }
                edits.push(Edit::Link(r, target.clone()));
            }
        }
    }
    let mut linked = 0;
    for e in edits {
        match e {
            Edit::Unlink(r, target) => txn.unlink_entity(r, &target)?,
            Edit::Link(r, target) => {
                txn.link_entity(
                    r,
                    &EntityLink {
                        target: target.id,
                        kind: target.kind,
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
