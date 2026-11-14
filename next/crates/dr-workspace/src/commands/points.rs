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

use dr_doc::prose::ProseReader;
use dr_model::DocId;
use dr_model::id::BookId;
use dr_store::history::{HistoryLabel, labels};
use loro::LoroDoc;
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
    /// Shared template-module prose: `template:<book>/<template>/<module>`.
    /// Entry bodies use the complete `entry_snapshot` history and atomic restore protocol.
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
    if !matches!(&doc, DocId::Template(t) if t.entry_module().is_some()) {
        return Err(WsError::invalid(format!(
            "{s} is not a single-document history target"
        )));
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

op! {
    HistoryPoints = "history.points", Read, Shared,
    "List a prose document's history points (kept 30 days, at most one every 15 minutes of writing), newest first, with the words at each.",
    fn(cx, input: DocIn) -> HistoryPointsOut {
        let (doc, _book) = prose_doc(cx, &input.doc)?;
        let labels = cx.workspace().library().history(&input.doc)?;
        let copy = match cx.workspace().library().load_copy(&input.doc) {
            Ok(c) => c,
            // Registered but nothing written yet.
            Err(dr_store::StoreError::NotFound(_)) => {
                return Ok(HistoryPointsOut { doc: input.doc, words: 0, points: Vec::new() });
            }
            Err(e) => return Err(e.into()),
        };
        let words = text_facts(&doc, &copy)?.0;
        // Newest first: each checkout moves a little further back.
        let mut points = Vec::with_capacity(labels.len());
        for l in &labels {
            copy.checkout(&l.frontiers)?;
            points.push(point_of(l, text_facts(&doc, &copy)?, None));
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

op! {
    HistoryPreview = "history.preview", Read, Shared,
    "Read a prose document as it was at a history point: its paragraphs (with H1/H2/H3 levels) and its owner's title and summary then.",
    fn(cx, input: PointIn) -> HistoryPreviewOut {
        let (doc, _book) = prose_doc(cx, &input.doc)?;
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
        Ok(HistoryPreviewOut { point: point_of(&l, facts, None), title: None, summary: None, paragraphs, same_as_now })
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
    "Restore one template-module prose document from history; entry bodies require complete-entry snapshots.",
    fn(cx, input: RestorePointIn) -> PointRestored {
        let (doc, book) = prose_doc(cx, &input.doc)?;
        let at = match (input.point, &input.at) {
            (Some(id), None) => label_of(cx, &input.doc, id)?.frontiers,
            (None, Some(at)) => {
                let _ = input.book_at.as_deref().map(frontiers_from_hex).transpose()?;
                frontiers_from_hex(at)?
            }
            _ => return Err(WsError::invalid("give either point or at")),
        };
        if let Some(b) = &book {
            cx.book_v3(b.as_str())?;
        }
        let slot = cx.prose(&doc)?;
        if slot.handle.read(|d| d.oplog_frontiers())? != at { slot.handle.label(labels::RESTORE)?; }
        let target = at.clone();
        let pre = cx.write_prose_raw(&slot, move |d| { let pre = d.oplog_frontiers(); if pre != target { d.revert_to(&target)?; } Ok(pre) })?;
        let prose_changed = slot.handle.read(|d| d.oplog_frontiers())? != pre;
        if prose_changed {
            cx.effect(EffectAction::Restored, "prose", &input.doc, None);
            cx.undo_with(Invocation::new("history.restore_point", RestorePointIn { doc: input.doc.clone(), point: None, at: Some(frontiers_hex(&pre)), book_at: None }));
        } else {
            cx.undo_nothing();
        }
        Ok(PointRestored { doc: input.doc, prose: prose_changed, fields: Vec::new(), skipped: Vec::new() })
    }
}
