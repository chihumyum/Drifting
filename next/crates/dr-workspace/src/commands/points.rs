//! Snapshot history (M09, 快照历史): a prose document's history points, a
//! preview of one, and restoring it.
//!
//! - The points are dr-store's history labels, written by storage alone:
//!   one every 15 minutes while someone writes (`periodic`), one when the
//!   document closes after real writing (`close`), one before each Agent
//!   turn's first write (`agent:<session>/<turn>`), one at a restore
//!   (`restore`), and those M10 replays from 0.1. Storage thins them (the
//!   last hour all, the last day one an hour, then one a day) and drops
//!   them after 30 days.
//! - `history.points` lists them newest first, each with its words then.
//! - `history.preview` reads the prose at a point (paragraph by paragraph,
//!   with heading levels) and the owner's title and summary then.
//! - `history.restore_point` restores a point per entity
//!   (simplifications.md 第一节第 4 条): the prose goes back to the point
//!   (Loro `revert_to`, a new change: history stays), and the owner's
//!   metadata fields (dr-doc's `metadata_fields`: a chapter's title,
//!   summary and status, an element's name, aliases, summary, group and
//!   fields, …) go back to what they were at the point's book version, as a
//!   new commit; the rest of the book is untouched. The version before the
//!   restore is labelled `restore` first, so the history itself can always
//!   go back to it; the journal can undo it too.
//!
//! Everything reads detached copies loaded from SQLite (dr-store's
//! `load_copy`), never the open document: a checkout there would expand its
//! history for good (P0-C).

use dr_doc::book::{BookReader, Collection, metadata_fields};
use dr_doc::prose::ProseReader;
use dr_model::DocId;
use dr_model::id::BookId;
use dr_store::history::{HistoryLabel, labels};
use loro::{Frontiers, LoroDoc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::*;
use crate::cx::{EffectAction, Invocation};
use crate::naming::{frontiers_from_hex, frontiers_hex};
use crate::registry::Registry;

pub(crate) fn register(r: &mut Registry) {
    r.add::<HistoryPoints>()
        .add::<HistoryPreview>()
        .add::<HistoryRestorePoint>();
}

/// A prose document.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct DocIn {
    /// `node:<id>`, `element:<id>`, `storyline:<id>`, `category:<id>` or
    /// `material:<id>`.
    pub doc: String,
}

/// One history point of a prose document.
#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema)]
pub struct HistoryPoint {
    /// Pass it to `history.preview` and `history.restore_point`.
    pub id: i64,
    /// When (ms since the epoch).
    pub ts: i64,
    /// Why it was taken: `auto` (every 15 minutes of writing), `close`
    /// (the document closed), `restore` (just before a restore), `agent`
    /// (before an Agent turn wrote), `import` (from the 0.1 library), or
    /// `other`.
    pub kind: String,
    /// The label as stored (`periodic`, `agent:<session>/<turn>`, …).
    pub label: String,
    /// Words in the prose then.
    pub words: u64,
    /// The owner's title (or name) then, when known.
    pub title: Option<String>,
    /// The prose's first characters then, whitespace collapsed (at most
    /// [`EXCERPT_CHARS`]), as the 0.1 history list showed them.
    pub excerpt: String,
    /// Exempt from thinning and the 30 days.
    pub kept: bool,
}

/// Characters of a point's excerpt.
pub const EXCERPT_CHARS: usize = 120;

/// The first [`EXCERPT_CHARS`] characters of `text`, whitespace collapsed.
pub fn excerpt(text: &str) -> String {
    let mut out = String::new();
    let mut n = 0;
    for word in text.split_whitespace() {
        for c in (!out.is_empty())
            .then_some(' ')
            .into_iter()
            .chain(word.chars())
        {
            if n == EXCERPT_CHARS {
                return out;
            }
            out.push(c);
            n += 1;
        }
    }
    out
}

/// What a label means for the history list.
pub fn point_kind(label: &str) -> &'static str {
    match label {
        labels::PERIODIC => "auto",
        labels::CLOSE => "close",
        labels::RESTORE => "restore",
        l if l.starts_with("agent:") => "agent",
        l if l.starts_with("import") => "import",
        _ => "other",
    }
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct HistoryPointsOut {
    pub doc: String,
    /// Words in the prose now.
    pub words: u64,
    /// Newest first.
    pub points: Vec<HistoryPoint>,
}

/// A prose document named by a command: parsed, and stored.
fn prose_doc(cx: &Cx<'_>, s: &str) -> Result<(DocId, Option<BookId>)> {
    let doc = DocId::parse(s).map_err(|e| WsError::invalid(format!("{s:?}: {e}")))?;
    if doc.profile().is_none() {
        return Err(WsError::invalid(format!("{s} is not a prose document")));
    }
    let info = cx
        .workspace()
        .library()
        .doc_info(s)?
        .ok_or_else(|| WsError::not_found("document", s))?;
    let book = match info.book_id {
        Some(b) => Some(pid::<BookId>("book", &b)?),
        None => None,
    };
    Ok((doc, book))
}

/// The words and excerpt of the prose in `copy` as it is checked out now.
fn text_facts(doc: &DocId, copy: &LoroDoc) -> Result<(u64, String)> {
    let text = plain(doc, copy)?;
    Ok((dr_text::count_words(&text) as u64, excerpt(&text)))
}

fn label_of(cx: &Cx<'_>, doc: &str, id: i64) -> Result<HistoryLabel> {
    cx.workspace()
        .library()
        .history(doc)?
        .into_iter()
        .find(|l| l.id == id)
        .ok_or_else(|| WsError::not_found("history point", id.to_string()))
}

fn point_of(
    l: &HistoryLabel,
    (words, excerpt): (u64, String),
    title: Option<String>,
) -> HistoryPoint {
    HistoryPoint {
        id: l.id,
        ts: l.ts,
        kind: point_kind(&l.label).to_string(),
        label: l.label.clone(),
        words,
        title,
        excerpt,
        kept: l.keep,
    }
}

/// The owner's title at each of `labels`' book versions, from one copy of
/// the book document (checked out once per distinct version).
fn titles_then(
    cx: &Cx<'_>,
    doc: &DocId,
    book: Option<&BookId>,
    labels: &[HistoryLabel],
) -> Result<Vec<Option<String>>> {
    let (Some(book), Some(owner)) = (book, owner_of(doc)) else {
        return Ok(vec![None; labels.len()]);
    };
    if labels.iter().all(|l| l.book_frontiers.is_none()) {
        return Ok(vec![None; labels.len()]);
    }
    let copy = cx
        .workspace()
        .library()
        .load_copy(&DocId::Book(book.clone()).to_string())?;
    let mut last: Option<(Frontiers, Option<String>)> = None;
    let mut out = Vec::with_capacity(labels.len());
    for l in labels {
        let Some(at) = &l.book_frontiers else {
            out.push(None);
            continue;
        };
        if let Some((f, t)) = &last
            && f == at
        {
            out.push(t.clone());
            continue;
        }
        copy.checkout(at)?;
        let t = title_summary(&BookReader::from_loro(book.clone(), &copy)?, &owner).0;
        last = Some((at.clone(), t.clone()));
        out.push(t);
    }
    Ok(out)
}

op! {
    HistoryPoints = "history.points", Read, Shared,
    "List a prose document's history points (kept 30 days, at most one every 15 minutes of writing), newest first, with the words at each.",
    fn(cx, input: DocIn) -> HistoryPointsOut {
        let (doc, book) = prose_doc(cx, &input.doc)?;
        let labels = cx.workspace().library().history(&input.doc)?;
        let copy = match cx.workspace().library().load_copy(&input.doc) {
            Ok(c) => c,
            // Registered but nothing written yet (a chapter nobody typed in,
            // or one whose prose has not arrived from another device).
            Err(dr_store::StoreError::NotFound(_)) => {
                return Ok(HistoryPointsOut { doc: input.doc, words: 0, points: Vec::new() });
            }
            Err(e) => return Err(e.into()),
        };
        let words = text_facts(&doc, &copy)?.0;
        let titles = titles_then(cx, &doc, book.as_ref(), &labels)?;
        // Newest first: each checkout moves a little further back.
        let mut points = Vec::with_capacity(labels.len());
        for (l, title) in labels.iter().zip(titles) {
            copy.checkout(&l.frontiers)?;
            points.push(point_of(l, text_facts(&doc, &copy)?, title));
        }
        Ok(HistoryPointsOut { doc: input.doc, words, points })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct PointIn {
    pub doc: String,
    /// A point's id from `history.points`.
    pub point: i64,
}

/// One paragraph of a preview.
#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema)]
pub struct PreviewParagraph {
    /// 1, 2 or 3 for H1/H2/H3; `None` for body text.
    pub heading: Option<u8>,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct HistoryPreviewOut {
    pub point: HistoryPoint,
    /// The owner's title (or name) then; `None` when it is not known (no
    /// book version with the point, or the owner did not exist yet).
    pub title: Option<String>,
    pub summary: Option<String>,
    pub paragraphs: Vec<PreviewParagraph>,
    /// Whether the prose then is the prose now (restoring changes no text).
    pub same_as_now: bool,
}

/// The entity whose prose `doc` is, as a book collection and id.
fn owner_of(doc: &DocId) -> Option<(Collection, String)> {
    Some(match doc {
        DocId::Node(id) => (Collection::Nodes, id.to_string()),
        DocId::Element(id) => (Collection::Elements, id.to_string()),
        DocId::Storyline(id) => (Collection::Storylines, id.to_string()),
        DocId::Category(id) => (Collection::Categories, id.to_string()),
        DocId::Material(id) => (Collection::Materials, id.to_string()),
        _ => return None,
    })
}

/// The entity kind effects name for an owner's collection.
fn kind_of(c: Collection) -> &'static str {
    match c {
        Collection::Nodes => "node",
        Collection::Elements => "element",
        Collection::Storylines => "storyline",
        Collection::Categories => "category",
        Collection::Materials => "material",
        other => other.root(),
    }
}

/// The owner's title and summary in a book copy.
fn title_summary(
    book: &BookReader,
    owner: &(Collection, String),
) -> (Option<String>, Option<String>) {
    let Some(snap) = book.view().entity_snapshot(owner.0, &owner.1) else {
        return (None, None);
    };
    let text = |k: &str| match snap.field(k) {
        Some(loro::LoroValue::String(s)) => Some(s.to_string()),
        _ => None,
    };
    let title = text("title").or_else(|| text("name"));
    let summary = text("summary").or_else(|| text("description"));
    (title, summary)
}

op! {
    HistoryPreview = "history.preview", Read, Shared,
    "Read a prose document as it was at a history point: its paragraphs (with H1/H2/H3 levels) and its owner's title and summary then.",
    fn(cx, input: PointIn) -> HistoryPreviewOut {
        let (doc, book) = prose_doc(cx, &input.doc)?;
        let l = label_of(cx, &input.doc, input.point)?;
        let lib = cx.workspace().library();
        let copy = lib.load_copy(&input.doc)?;
        let same_as_now = {
            let current = plain(&doc, &copy)?;
            copy.checkout(&l.frontiers)?;
            plain(&doc, &copy)? == current
        };
        let reader = ProseReader::from_loro(doc.clone(), &copy)?;
        let view = reader.view();
        let paragraphs: Vec<PreviewParagraph> = view.paragraphs().map(|p| PreviewParagraph {
            heading: p.attrs.heading.map(|h| h.level() as u8),
            text: dr_text::block_text(&view, &p),
        }).collect();
        let text = dr_text::plain_text(&view);
        let facts = (dr_text::count_words(&text) as u64, excerpt(&text));
        let (title, summary) = match (&book, &l.book_frontiers, owner_of(&doc)) {
            (Some(b), Some(at), Some(owner)) => {
                let book_copy = lib.load_copy_at(&DocId::Book(b.clone()).to_string(), at)?;
                title_summary(&BookReader::from_loro(b.clone(), &book_copy)?, &owner)
            }
            _ => (None, None),
        };
        Ok(HistoryPreviewOut { point: point_of(&l, facts, title.clone()), title, summary, paragraphs, same_as_now })
    }
}

fn plain(doc: &DocId, copy: &LoroDoc) -> Result<String> {
    let reader = ProseReader::from_loro(doc.clone(), copy)?;
    Ok(dr_text::plain_text(&reader.view()))
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct RestorePointIn {
    pub doc: String,
    /// A point's id from `history.points`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub point: Option<i64>,
    /// Or an exact prose version (hex Loro frontiers; the undo uses it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    /// With `at`: the book document's version to take the owner's fields
    /// from (hex); omitted: the fields stay.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub book_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct PointRestored {
    pub doc: String,
    /// Whether the prose changed (it was not already the point's).
    pub prose: bool,
    /// The owner's fields written back (empty when they already matched or
    /// the point has no book version).
    pub fields: Vec<String>,
    /// Fields left as they are: an element's `name` and `aliases` when
    /// another element has taken one of them since.
    pub skipped: Vec<String>,
}

op! {
    HistoryRestorePoint = "history.restore_point", Write, Book,
    "Restore a prose document to a history point, per entity: the prose goes back (a new change; history stays) and its owner's title, summary and other metadata fields go back to that time; the rest of the book is untouched.",
    fn(cx, input: RestorePointIn) -> PointRestored {
        let (doc, book) = prose_doc(cx, &input.doc)?;
        let (at, book_at): (Frontiers, Option<Frontiers>) = match (input.point, &input.at) {
            (Some(id), None) => {
                let l = label_of(cx, &input.doc, id)?;
                (l.frontiers, l.book_frontiers)
            }
            (None, Some(at)) => (
                frontiers_from_hex(at)?,
                input.book_at.as_deref().map(frontiers_from_hex).transpose()?,
            ),
            _ => return Err(WsError::invalid("give either point or at")),
        };
        let book_slot = match &book { Some(b) => Some(cx.book(b.as_str())?), None => None };
        let slot = cx.prose(&doc)?;
        // The owner's fields then, read before anything is written.
        let owner = owner_of(&doc);
        // The book as it was at the point (kept for the name checks below),
        // and an element's names then, to check they are still free.
        let old_book = match (&book_slot, &book_at) {
            (Some(bs), Some(at)) => {
                let copy = cx.workspace().library().load_copy_at(&DocId::Book(bs.book.clone()).to_string(), at)?;
                Some(BookReader::from_loro(bs.book.clone(), &copy)?)
            }
            _ => None,
        };
        let (fields_then, names_then) = match (&old_book, &owner) {
            (Some(old), Some((c, id))) => {
                let names = (*c == Collection::Elements).then(|| old.view().elements().into_iter()
                    .find(|e| e.id.as_str() == id)
                    .map(|e| std::iter::once(e.name).chain(e.aliases).collect::<Vec<String>>()))
                    .flatten();
                (old.view().entity_snapshot(*c, id), names)
            }
            _ => (None, None),
        };
        // Label the version before, unless it is the point itself.
        if slot.handle.read(|d| d.oplog_frontiers())? != at {
            slot.handle.label(labels::RESTORE)?;
        }
        let target = at.clone();
        let pre = cx.write_prose_raw(&slot, move |d| {
            let pre = d.oplog_frontiers();
            if pre != target {
                d.revert_to(&target)?;
            }
            Ok(pre)
        })?;
        let prose_changed = slot.handle.read(|d| d.oplog_frontiers())? != pre;
        let mut fields = Vec::new();
        let mut skipped = Vec::new();
        let mut book_pre = None;
        if let (Some(bs), Some(snap), Some((c, id))) = (&book_slot, fields_then, &owner) {
            let now = bs.reader.view().entity_snapshot(*c, id);
            // As the 0.1 restore: an element whose old name or aliases another
            // element has taken since keeps its current ones.
            let names_free = match (&names_then, dr_model::id::ElementId::parse(id)) {
                (Some(names), Ok(eid)) => {
                    super::element::check_names(bs, Some(&eid), names.iter().map(String::as_str)).is_ok()
                }
                _ => true,
            };
            if !names_free {
                skipped = vec!["name".to_string(), "aliases".to_string()];
            }
            let keys: Vec<&'static str> = metadata_fields(*c)
                .iter()
                .copied()
                .filter(|k| names_free || !matches!(*k, "name" | "aliases"))
                .filter(|k| now.as_ref().map(|n| n.field(k)) != Some(snap.field(k)))
                .collect();
            if !keys.is_empty() {
                let keys: Vec<String> = keys.iter().map(|k| k.to_string()).collect();
                // A title or name another one has taken since gets a suffix,
                // as every restore does (`history.restore_entities`).
                let fixes = match &old_book {
                    Some(old) => {
                        let cur = bs.reader.view();
                        let ids: Vec<_> = super::history::identity(&old.view(), &cur, *c, id, &keys).into_iter().collect();
                        super::history::name_fixes(&cur, &ids)
                    }
                    None => Vec::new(),
                };
                for f in &fixes {
                    if let super::history::Plan::Rename(_, id, name) = f {
                        cx.effect(EffectAction::Renamed, kind_of(*c), id.as_str(), Some(name));
                    }
                }
                let mut plans = vec![super::history::Plan::Fields(*c, id.clone(), snap, keys.clone())];
                plans.extend(fixes);
                let (_, before) = cx.write_book(bs, move |txn| super::history::apply(txn, plans))?;
                book_pre = Some(before);
                cx.effect(EffectAction::Updated, kind_of(*c), id.as_str(), None);
                fields = keys;
            }
        }
        if prose_changed {
            cx.effect(EffectAction::Restored, "prose", input.doc.as_str(), None);
        }
        if !prose_changed && fields.is_empty() {
            cx.undo_nothing();
        } else {
            cx.undo_with(Invocation::new("history.restore_point", RestorePointIn {
                doc: input.doc.clone(),
                point: None,
                at: Some(frontiers_hex(&pre)),
                book_at: book_pre.as_ref().map(frontiers_hex),
            }));
        }
        Ok(PointRestored { doc: input.doc, prose: prose_changed, fields, skipped })
    }
}
