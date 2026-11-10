//! The minimal prose interface: read paragraphs, replace an exact passage,
//! restore a version, put entity links on or off anchored ranges (the undo
//! of automatic links, `crate::autolink`). Editing proper is the editor's
//! (F4); the Agent's projection of prose into editable text is M29.

use dr_model::DocId;
use dr_model::kind::ListKind;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::*;
use crate::cx::{EffectAction, Invocation};
use crate::naming::{frontiers_from_hex, frontiers_hex};
use crate::registry::Registry;

pub(crate) fn register(r: &mut Registry) {
    r.add::<ProseRead>()
        .add::<ProseReplace>()
        .add::<ProseRestore>()
        .add::<ProseLink>()
        .add::<ProseUnlink>()
        .add::<ProseShapeOp>();
}

fn doc_id(s: &str) -> Result<DocId> {
    let d = DocId::parse(s).map_err(|e| WsError::invalid(format!("{s:?}: {e}")))?;
    if d.profile().is_none() {
        return Err(WsError::invalid(format!("{s} is not a prose document")));
    }
    Ok(d)
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ProseReadIn {
    /// Canonical prose: `body:<entry>/<module>`, `material:<id>` or
    /// `template:<book>/<template>/<module>`.
    pub doc: String,
    /// First paragraph (0-based).
    #[serde(default)]
    pub from: usize,
    /// At most this many paragraphs (default 200).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct ParagraphInfo {
    pub index: usize,
    pub block_id: Option<String>,
    /// 0 for body text, 1–3 for H1–H3.
    pub heading: u8,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct ProseText {
    pub paragraphs: Vec<ParagraphInfo>,
    pub total: usize,
    /// The document's version (hex frontiers).
    pub version: String,
}

op! {
    ProseRead = "prose.read", Read, Shared,
    "Read paragraphs of a prose document (text, block id, heading level).",
    fn(cx, input: ProseReadIn) -> ProseText {
        let doc = doc_id(&input.doc)?;
        let slot = cx.prose(&doc)?;
        slot.handle.read(move |state| -> Result<ProseText> {
            let body = dr_doc::prose::BorrowedProse::new(state, &doc)?;
            let view = body.view();
            let limit = input.limit.unwrap_or(200);
            let mut total = 0;
            let mut paragraphs = Vec::new();
            for (i, p) in view.paragraphs().enumerate() {
                total += 1;
                if i >= input.from && paragraphs.len() < limit {
                    paragraphs.push(ParagraphInfo {
                        index: i,
                        block_id: p.id.as_ref().map(|b| b.to_string()),
                        heading: p.attrs.heading.map(|h| h.level() as u8).unwrap_or(0),
                        text: p.text(),
                    });
                }
            }
            Ok(ProseText { paragraphs, total, version: frontiers_hex(&state.oplog_frontiers()) })
        })?
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ProseReplaceIn {
    pub doc: String,
    /// The exact current text to replace (within one paragraph).
    pub find: String,
    /// The new text (no paragraph breaks).
    pub replace: String,
    /// Look only in this paragraph.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct Replaced {
    /// Character offset of the replacement in the document.
    pub at: usize,
    pub block_id: Option<String>,
    /// Entity links written on names inside the new text (automatic links
    /// for an Agent's, the mirror's or an import's text, when the author has
    /// them on).
    pub linked: usize,
}

op! {
    ProseReplace = "prose.replace", Write, Book,
    "Replace one exact passage of prose with new text (it must occur exactly once, in one paragraph).",
    fn(cx, input: ProseReplaceIn) -> Replaced {
        let doc = doc_id(&input.doc)?;
        if input.find.is_empty() {
            return Err(WsError::invalid("find is empty"));
        }
        for s in [&input.find, &input.replace] {
            if s.contains('\n') || s.contains('\u{FFFC}') {
                return Err(WsError::invalid("find and replace stay inside one paragraph"));
            }
        }
        let book = match cx.workspace().library().doc_info(&input.doc)? {
            Some(dr_store::DocInfo { book_id: Some(b), .. }) => Some(cx.book(&b)?),
            _ => None,
        };
        let names = book.filter(|_| cx.workspace().auto_links() && crate::autolink::links_for(cx.actor()))
            .map(|b| crate::autolink::book_matcher(&b, &doc));
        let slot = cx.prose(&doc)?;
        cx.summarize(format!("{} → {}", input.find, input.replace));
        let (find, replace, block) = (input.find.clone(), input.replace.clone(), input.block_id.clone());
        let (at, bid, linked, changed) = cx.write_prose(&slot, move |txn| {
            // Validate on the state the edit applies to, before writing.
            let view = txn.view();
            let mut hits = Vec::new();
            for p in view.paragraphs() {
                if let Some(b) = &block && p.id.as_ref().map(|x| x.as_str()) != Some(b.as_str()) { continue; }
                let text = p.text();
                for (byte, _) in text.match_indices(&find) {
                    hits.push((p.range.start + text[..byte].chars().count(), p.id.clone()));
                }
            }
            let (at, bid) = match hits.len() {
                0 => return Err(WsError::not_found("text", find.clone())),
                1 => hits.remove(0),
                n => return Err(WsError::Ambiguous(format!("{find:?} occurs {n} times"))),
            };
            if find == replace { return Ok((at, bid, 0, false)); }
            let len = find.chars().count();
            txn.delete(at..at + len)?;
            txn.insert_text(at, &replace)?;
            // Links on names inside the new text, in this commit: the
            // inverse deletes the text and its links with it.
            let linked = match &names {
                Some(n) => crate::autolink::link_written_v3(txn, n, at..at + replace.chars().count())?,
                None => 0,
            };
            Ok((at, bid, linked, true))
        })?;
        if !changed {
            cx.undo_nothing();
            return Ok(Replaced { at, block_id: bid.map(|b| b.to_string()), linked });
        }
        cx.effect(EffectAction::Updated, "prose", input.doc.as_str(), None);
        if input.replace.is_empty() {
            cx.irreversible();
        } else {
            cx.undo_with(Invocation::new("prose.replace", ProseReplaceIn {
                doc: input.doc.clone(), find: input.replace.clone(), replace: input.find.clone(),
                block_id: bid.as_ref().map(|b| b.to_string()),
            }));
        }
        Ok(Replaced { at, block_id: bid.map(|b| b.to_string()), linked })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ProseRestoreIn {
    pub doc: String,
    /// The version to go back to (hex frontiers, from history).
    pub at: String,
}

op! {
    ProseRestore = "prose.restore", Write, Book,
    "Restore a prose document to an earlier version, as a new change (history stays).",
    fn(cx, input: ProseRestoreIn) -> Done {
        let doc = doc_id(&input.doc)?;
        let at = frontiers_from_hex(&input.at)?;
        if let Some(info) = cx.workspace().library().doc_info(&input.doc)?
            && let Some(b) = info.book_id { cx.book(&b)?; }
        let slot = cx.prose(&doc)?;
        let pre = cx.write_prose_raw(&slot, move |doc| {
            let pre = doc.oplog_frontiers();
            doc.revert_to(&at)?;
            Ok(pre)
        })?;
        cx.effect(EffectAction::Restored, "prose", input.doc.as_str(), None);
        cx.undo_with(Invocation::new("prose.restore", ProseRestoreIn { doc: input.doc.clone(), at: frontiers_hex(&pre) }));
        Ok(Done { id: input.doc })
    }
}

pub(crate) fn seed_prose(
    cx: &Cx<'_>,
    book: &dr_model::id::BookId,
    doc: &DocId,
    text: Option<&str>,
) -> Result<()> {
    cx.create_prose(book, doc)?;
    if let Some(t) = text.filter(|t| !t.is_empty()) {
        if t.contains('\u{FFFC}') {
            return Err(WsError::invalid("text may not contain U+FFFC"));
        }
        let names = if cx.workspace().auto_links() && crate::autolink::links_for(cx.actor()) {
            Some(crate::autolink::book_matcher(
                &*cx.book(book.as_str())?,
                doc,
            ))
        } else {
            None
        };
        let slot = cx.prose(doc)?;
        let t = t.replace("\r\n", "\n");
        cx.write_prose(&slot, move |txn| {
            let end = txn.view().len().saturating_sub(1);
            let caret = txn.insert_paragraphs(end, &t)?;
            // Automatic links on the names in the new text, same commit.
            if let Some(n) = &names {
                crate::autolink::link_written_v3(txn, n, end..caret)?;
            }
            Ok(())
        })?;
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct LinkIn {
    pub doc: String,
    /// A canonical entry or material. This inverse represents bare links;
    /// richer existing marks must use the versioned prose edit protocol.
    pub target: crate::dto::Target,
    /// The ranges, as anchors (two cursors each, as comments keep them), so
    /// typing since moves nothing.
    pub anchors: Vec<crate::dto::AnchorBytes>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct LinksIn {
    /// Any number of documents and targets: each document is written once.
    pub links: Vec<LinkIn>,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct LinksChanged {
    /// Ranges whose link changed (an anchor whose text is gone counts for
    /// nothing).
    pub ranges: usize,
    /// Documents written.
    pub docs: usize,
}

/// One document's links of a [`LinksIn`]: each target with its anchors.
type DocLinks = Vec<(dr_model::prose::EntityLink, Vec<dr_doc::anchor::Anchor>)>;

/// Put the links of `input` on (`on`) or off. Documents are opened and
/// written a few at a time (an automatic backfill's undo touches hundreds).
fn set_links(cx: &Cx<'_>, input: &LinksIn, on: bool) -> Result<LinksChanged> {
    use dr_model::prose::EntityLink;
    // Validate everything before writing anything.
    let mut by_doc: Vec<(DocId, DocLinks)> = Vec::new();
    for l in &input.links {
        let doc = doc_id(&l.doc)?;
        let kind = dr_model::kind::EntityKind::parse(&l.target.kind);
        if !matches!(
            kind,
            dr_model::kind::EntityKind::Entry | dr_model::kind::EntityKind::Material
        ) {
            return Err(WsError::invalid(format!(
                "{:?} cannot be linked",
                l.target.kind
            )));
        }
        if l.target.id.is_empty() {
            return Err(WsError::invalid("target id is empty"));
        }
        let anchors = l
            .anchors
            .iter()
            .map(super::comment_shared::decode_anchor)
            .collect::<Result<Vec<_>>>()?;
        let link = EntityLink {
            target: l.target.id.clone(),
            kind,
            block: None,
            end_block: None,
        };
        match by_doc.iter_mut().find(|(d, _)| *d == doc) {
            Some((_, v)) => v.push((link, anchors)),
            None => by_doc.push((doc, vec![(link, anchors)])),
        }
    }
    let lib = cx.workspace().library();
    for (doc, links) in &by_doc {
        let info = lib
            .doc_info(&doc.to_string())?
            .ok_or_else(|| WsError::not_found("document", doc.to_string()))?;
        if let Some(b) = info.book_id {
            let slot = cx.book_v3(&b)?;
            for (link, _) in links {
                if !slot
                    .reader_v3
                    .view()
                    .entity_exists(&dr_model::shared::EntityRef::new(
                        link.kind.clone(),
                        &link.target,
                    ))
                {
                    return Err(WsError::not_found("link target", &link.target));
                }
            }
        }
    }
    let ws = cx.workspace();
    // Each anchor must be of its document before anything is written: an
    // open document's own version, a closed one's stored head (no load).
    for (doc, links) in &by_doc {
        let slot = ws.prose_slot(doc)?;
        let document = slot.handle.doc().with_doc(Clone::clone);
        let reader = dr_doc::prose::BorrowedProse::new(&document, doc)?;
        let view = reader.view();
        // This shared inverse cannot describe module/block/unknown metadata.
        // Refuse the whole request before the first write rather than erase
        // data that an undo could not reconstruct.
        for (link, anchors) in links {
            let expected = dr_doc::prose::v3::encode_entity_link(
                &dr_model::v3::EntityLinkV3 {
                    target: link.target.clone(),
                    kind: link.kind.clone(),
                    module: None,
                    block: None,
                    end_block: None,
                },
                None,
            )?;
            for range in anchors
                .iter()
                .filter_map(|a| view.resolve(a))
                .filter(|r| !r.collapsed)
                .map(|r| r.range)
            {
                for (_, key, value) in view.copy_entity_links_v3(range)?.marks() {
                    if key == &format!("entity:{}", link.target) && value != &expected {
                        return Err(WsError::invalid(
                            "anchored link metadata requires the versioned prose edit protocol",
                        ));
                    }
                }
            }
        }
        let vv = document.oplog_vv();
        for (_, anchors) in links {
            for a in anchors {
                super::comment_shared::anchor_known_in(&vv, doc, a)?;
            }
        }
    }
    // Then a few documents at a time, each opened, written and let go.
    let counts = by_doc
        .iter()
        .map(|(doc, links)| {
            let ps = ws.prose_slot(doc)?;
            let (doc, links) = (doc.clone(), links.clone());
            cx.write_prose_raw(&ps, move |d| {
                let b = dr_doc::prose::BorrowedProse::new(d, &doc)?;
                let mut txn = b.txn();
                let mut n = 0;
                for (link, anchors) in &links {
                    let found: Vec<std::ops::Range<usize>> = anchors
                        .iter()
                        .filter_map(|a| txn.view().resolve(a))
                        .filter(|r| !r.collapsed)
                        .map(|r| r.range)
                        .collect();
                    for r in &found {
                        if on {
                            txn.link_entity_v3(
                                r.clone(),
                                &dr_model::v3::EntityLinkV3 {
                                    target: link.target.clone(),
                                    kind: link.kind.clone(),
                                    module: None,
                                    block: None,
                                    end_block: None,
                                },
                            )?;
                        } else {
                            txn.unlink_entity(r.clone(), &link.target)?;
                        }
                    }
                    n += found.len();
                }
                Ok(n)
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let mut out = LinksChanged { ranges: 0, docs: 0 };
    for ((doc, _), n) in by_doc.iter().zip(&counts) {
        if *n > 0 {
            out.ranges += n;
            out.docs += 1;
            cx.effect(EffectAction::Updated, "prose", doc.to_string(), None);
        }
    }
    if out.ranges > 0 {
        cx.undo_with(Invocation::new(
            if on { "prose.unlink" } else { "prose.link" },
            input.clone(),
        ));
    } else {
        cx.undo_nothing();
    }
    Ok(out)
}

op! {
    ProseLink = "prose.link", Write, Book,
    "Link anchored ranges of prose documents to entities (anchors, not positions: the undo of automatic links that were taken off).",
    fn(cx, input: LinksIn) -> LinksChanged {
        set_links(cx, &input, true)
    }
}

op! {
    ProseUnlink = "prose.unlink", Write, Book,
    "Take links to entities off anchored ranges of prose documents (anchors, not positions: the undo of automatic links).",
    fn(cx, input: LinksIn) -> LinksChanged {
        set_links(cx, &input, false)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ProseShapeIn {
    /// A canonical body, template module or material prose document.
    pub doc: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema)]
pub struct ProseShapeOut {
    /// Paragraphs that are not blank.
    pub paragraphs: u64,
    /// Sentences (a paragraph with words is at least one).
    pub sentences: u64,
    /// The share of characters inside quotation marks, 0–1.
    pub dialogue: f32,
    /// Checklist items (a note's tasks) and how many are checked.
    pub tasks: u32,
    pub done: u32,
    /// The materials it embeds, in order (repeats kept).
    pub embeds: Vec<String>,
}

op! {
    ProseShapeOp = "prose.shape", Read, Shared,
    "Shape of a prose document: paragraphs, sentences, the share of dialogue, its checklist and the materials it embeds.",
    fn(cx, input: ProseShapeIn) -> ProseShapeOut {
        let doc = DocId::parse(&input.doc).map_err(|e| WsError::invalid(format!("{:?}: {e}", input.doc)))?;
        if doc.profile().is_none() {
            return Err(WsError::invalid(format!("{} is not a prose document", input.doc)));
        }
        let slot = cx.prose(&doc)?;
        let view = cx.prose_view(&slot);
        let mut texts = Vec::new();
        let (mut tasks, mut done) = (0u32, 0u32);
        let mut embeds = Vec::new();
        for p in view.paragraphs() {
            if p.attrs.list == Some(ListKind::Task) {
                tasks += 1;
                done += u32::from(p.attrs.checked);
            }
            if let Some(id) = p.embed()
                && let Some(dr_doc::prose::EmbedView::Material { material: Some(m), .. }) = view.embed(id)
            {
                embeds.push(m.as_str().to_owned());
            }
            texts.push(dr_text::block_text(&view, &p));
        }
        let shape = dr_text::prose_shape(texts.iter().map(String::as_str));
        Ok(ProseShapeOut {
            paragraphs: shape.paragraphs,
            sentences: shape.sentences,
            dialogue: shape.dialogue,
            tasks,
            done,
            embeds,
        })
    }
}
