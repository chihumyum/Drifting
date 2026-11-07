//! The minimal prose interface: read paragraphs, replace an exact passage,
//! restore a version. Editing proper is the editor's (F4); the Agent's
//! projection of prose into editable text is M29.

use dr_model::DocId;
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
        .add::<Search>();
}

fn doc_id(s: &str) -> Result<DocId> {
    let d = DocId::parse(s).map_err(|e| WsError::invalid(format!("{s:?}: {e}")))?;
    if d.is_book() {
        return Err(WsError::invalid(format!("{s} is not a prose document")));
    }
    Ok(d)
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ProseReadIn {
    /// The prose document: `node:<id>`, `element:<id>`, `storyline:<id>`,
    /// `category:<id>` or `material:<id>`.
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
        let view = cx.prose_view(&slot);
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
        Ok(ProseText { paragraphs, total, version: frontiers_hex(&slot.handle.doc().oplog_frontiers()) })
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
        if let Some(info) = cx.workspace().library().doc_info(&input.doc)?
            && let Some(b) = info.book_id { cx.book(&b)?; }
        let slot = cx.prose(&doc)?;
        cx.summarize(format!("{} → {}", input.find, input.replace));
        let (find, replace, block) = (input.find.clone(), input.replace.clone(), input.block_id.clone());
        let (at, bid) = cx.write_prose(&slot, move |txn| {
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
            let len = find.chars().count();
            txn.delete(at..at + len)?;
            txn.insert_text(at, &replace)?;
            Ok((at, bid))
        })?;
        cx.effect(EffectAction::Updated, "prose", input.doc.as_str(), None);
        if input.replace.is_empty() {
            cx.irreversible();
        } else {
            cx.undo_with(Invocation::new("prose.replace", ProseReplaceIn {
                doc: input.doc.clone(), find: input.replace.clone(), replace: input.find.clone(),
                block_id: bid.as_ref().map(|b| b.to_string()),
            }));
        }
        Ok(Replaced { at, block_id: bid.map(|b| b.to_string()) })
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

// ---- search -------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct SearchIn {
    pub book: String,
    pub query: String,
    /// At most this many hits (default 50).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct SearchHitInfo {
    pub doc: String,
    /// What owns the document: `node`, `element`, `storyline`, `category`,
    /// `material`.
    pub kind: String,
    pub owner: String,
    /// The owner's title or name.
    pub title: String,
    pub block_id: Option<String>,
    pub paragraph: u32,
    pub offset: usize,
    pub snippet: String,
}

op! {
    Search = "book.search", Read, Shared,
    "Search a book's prose (chapters in reading order first, then ideas, elements, storylines, categories, materials). One- and two-character queries work.",
    fn(cx, input: SearchIn) -> Vec<SearchHitInfo> {
        let slot = cx.book(&input.book)?;
        let limit = input.limit.unwrap_or(50);
        // Every live owner's document in book order, with its kind and
        // title; dr-store sorts by this order before it cuts at `limit`.
        let mut owners: Vec<(String, &'static str, String)> = Vec::new();
        for c in chapters(&slot) {
            owners.push((format!("node:{}", c.id), "node", c.title));
        }
        let mut ideas: Vec<_> = nodes(&slot).values().filter(|n| n.is_drift() && !n.is_trashed()).cloned().collect();
        ideas.sort_by(|a, b| a.title.cmp(&b.title).then(a.id.cmp(&b.id)));
        for n in ideas {
            owners.push((format!("node:{}", n.id), "node", n.title));
        }
        for e in elements(&slot).iter().filter(|e| e.deleted_at.is_none()) {
            owners.push((format!("element:{}", e.id), "element", e.name.clone()));
        }
        for s in storylines(&slot).iter().filter(|s| s.deleted_at.is_none()) {
            owners.push((format!("storyline:{}", s.id), "storyline", s.name.clone()));
        }
        for c in categories(&slot).iter().filter(|c| c.deleted_at.is_none()) {
            owners.push((format!("category:{}", c.id), "category", c.name.clone()));
        }
        for m in materials(&slot).iter() {
            owners.push((format!("material:{}", m.id), "material", m.title.clone()));
        }
        let order: Vec<&str> = owners.iter().map(|(d, ..)| d.as_str()).collect();
        let hits = cx.workspace().library().search_in_order(Some(&input.book), &input.query, limit, &order)?;
        let by_doc: std::collections::HashMap<&str, (&'static str, &str)> =
            owners.iter().map(|(d, k, t)| (d.as_str(), (*k, t.as_str()))).collect();
        // Documents not in the order (trashed owners, orphans) come last
        // from dr-store; they are left out.
        Ok(hits.into_iter().filter_map(|h| {
            let (kind, title) = *by_doc.get(h.doc_id.as_str())?;
            let owner = h.doc_id.split_once(':').map(|(_, id)| id.to_string()).unwrap_or_default();
            Some(SearchHitInfo {
                kind: kind.to_string(), owner, title: title.to_string(), block_id: h.block_id,
                paragraph: h.ord, offset: h.match_offset, snippet: h.snippet, doc: h.doc_id,
            })
        }).collect())
    }
}
