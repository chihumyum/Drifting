//! The minimal prose interface: read paragraphs, replace an exact passage,
//! restore a version, put entity links on or off anchored ranges (the undo
//! of automatic links, `crate::autolink`). Editing proper is the editor's
//! (F4); the Agent's projection of prose into editable text is M29.

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
        .add::<ProseLink>()
        .add::<ProseUnlink>()
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
            .map(|b| crate::autolink::matcher(&b.reader.view(), &doc));
        let slot = cx.prose(&doc)?;
        cx.summarize(format!("{} → {}", input.find, input.replace));
        let (find, replace, block) = (input.find.clone(), input.replace.clone(), input.block_id.clone());
        let (at, bid, linked) = cx.write_prose(&slot, move |txn| {
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
            // Links on names inside the new text, in this commit: the
            // inverse deletes the text and its links with it.
            let linked = match &names {
                Some(n) => crate::autolink::link_written(txn, n, at..at + replace.chars().count())?,
                None => 0,
            };
            Ok((at, bid, linked))
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

// ---- entity links on anchored ranges ------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct LinkIn {
    pub doc: String,
    /// What the links point at (`element`, `node`, `storyline`, `category`,
    /// `material`).
    pub target: crate::dto::Target,
    /// The ranges, as anchors (two cursors each, as comments keep them), so
    /// typing since moves nothing.
    pub anchors: Vec<crate::dto::AnchorBytes>,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct LinksChanged {
    /// Ranges whose link changed (an anchor whose text is gone counts for
    /// nothing).
    pub ranges: usize,
}

/// Put links to `input.target` on (`on`) or off its anchored ranges.
fn set_links(cx: &Cx<'_>, input: &LinkIn, on: bool) -> Result<LinksChanged> {
    let doc = doc_id(&input.doc)?;
    let kind = dr_model::kind::EntityKind::parse(&input.target.kind);
    if !kind.may_be_linked() {
        return Err(WsError::invalid(format!(
            "{:?} cannot be linked",
            input.target.kind
        )));
    }
    if input.target.id.is_empty() {
        return Err(WsError::invalid("target id is empty"));
    }
    if let Some(info) = cx.workspace().library().doc_info(&input.doc)?
        && let Some(b) = info.book_id
    {
        cx.book(&b)?;
    }
    let anchors: Vec<dr_doc::anchor::Anchor> = input
        .anchors
        .iter()
        .map(|a| super::comment::anchor_in(cx, &doc, a))
        .collect::<Result<_>>()?;
    let slot = cx.prose(&doc)?;
    let link = dr_model::prose::EntityLink {
        target: input.target.id.clone(),
        kind,
        block: None,
        end_block: None,
    };
    let ranges = cx.write_prose(&slot, move |txn| {
        let found: Vec<std::ops::Range<usize>> = anchors
            .iter()
            .filter_map(|a| txn.view().resolve(a))
            .filter(|r| !r.collapsed)
            .map(|r| r.range)
            .collect();
        for r in &found {
            if on {
                txn.link_entity(r.clone(), &link)?;
            } else {
                txn.unlink_entity(r.clone(), &link.target)?;
            }
        }
        Ok(found.len())
    })?;
    if ranges > 0 {
        cx.effect(EffectAction::Updated, "prose", input.doc.as_str(), None);
        cx.undo_with(Invocation::new(
            if on { "prose.unlink" } else { "prose.link" },
            input.clone(),
        ));
    } else {
        cx.undo_nothing();
    }
    Ok(LinksChanged { ranges })
}

op! {
    ProseLink = "prose.link", Write, Book,
    "Link anchored ranges of a prose document to an entity (anchors, not positions: the undo of automatic links that were taken off).",
    fn(cx, input: LinkIn) -> LinksChanged {
        set_links(cx, &input, true)
    }
}

op! {
    ProseUnlink = "prose.unlink", Write, Book,
    "Take the links to an entity off anchored ranges of a prose document (anchors, not positions: the undo of automatic links).",
    fn(cx, input: LinkIn) -> LinksChanged {
        set_links(cx, &input, false)
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

#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema)]
pub struct SearchHitInfo {
    /// The owner's prose document.
    pub doc: String,
    /// What owns the text: `chapter`, `idea`, `element`, `storyline`,
    /// `category`, `material`.
    pub kind: String,
    pub owner: String,
    /// The owner's title or name.
    pub title: String,
    /// Where the match is: `body` (the prose), `title`, `summary`,
    /// `description` (a material's) or `patch` (one of an element's
    /// patches, its title or its text).
    pub field: String,
    pub block_id: Option<String>,
    /// The paragraph of the prose (0-based); body hits only.
    pub paragraph: Option<u32>,
    /// Character offset of the match in its paragraph or field.
    pub offset: usize,
    /// The match with a little context, on one line.
    pub snippet: String,
    /// Where the match starts in `snippet` and how long it is, in
    /// characters.
    pub snippet_match: usize,
    pub match_len: usize,
}

/// Characters of context on each side of a match (dr-store's snippets).
const SNIPPET_CONTEXT: usize = 24;

/// Case-insensitive (simple case folding) character offset of `needle`,
/// dr-store's rule for prose hits.
fn find_folded(hay: &[char], needle: &[char]) -> Option<usize> {
    if needle.is_empty() || needle.len() > hay.len() {
        return None;
    }
    let fold = |c: char| c.to_lowercase().next().unwrap_or(c);
    (0..=hay.len() - needle.len()).find(|&i| {
        hay[i..i + needle.len()]
            .iter()
            .zip(needle)
            .all(|(a, b)| fold(*a) == fold(*b))
    })
}

/// Line and paragraph breaks read as spaces in a snippet.
fn one_line(s: impl Iterator<Item = char>) -> String {
    s.map(|c| {
        if matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}') {
            ' '
        } else {
            c
        }
    })
    .collect()
}

/// The first match of `needle` in a short text of the book document:
/// (offset, snippet, where the match starts in the snippet).
fn text_hit(text: &str, needle: &[char]) -> Option<(usize, String, usize)> {
    let chars: Vec<char> = text.chars().collect();
    let at = find_folded(&chars, needle)?;
    let start = at.saturating_sub(SNIPPET_CONTEXT);
    let end = (at + needle.len() + SNIPPET_CONTEXT).min(chars.len());
    Some((at, one_line(chars[start..end].iter().copied()), at - start))
}

/// One owner of searchable text, in book order: its prose document, and the
/// short texts the book document keeps for it.
struct Owner {
    doc: String,
    kind: &'static str,
    title: String,
    /// `summary` or `description`, when it has one.
    about: Option<(&'static str, String)>,
    /// An element's patches: title and text.
    patches: Vec<String>,
}

op! {
    Search = "book.search", Read, Shared,
    "Search a book: titles, summaries, prose, material descriptions and element patches (chapters in reading order first, then ideas, elements, storylines, categories, materials). One- and two-character queries work.",
    fn(cx, input: SearchIn) -> Vec<SearchHitInfo> {
        let slot = cx.book(&input.book)?;
        let limit = input.limit.unwrap_or(50);
        let needle: Vec<char> = input.query.trim().chars().collect();
        if needle.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        // Every live owner in book order; dr-store sorts the prose hits by
        // this order before it cuts at `limit`.
        let mut owners: Vec<Owner> = Vec::new();
        let node = |n: &dr_model::book::Node, kind| Owner {
            doc: format!("node:{}", n.id), kind, title: n.title.clone(),
            about: Some(("summary", n.summary.clone())), patches: Vec::new(),
        };
        for c in chapters(&slot) {
            owners.push(node(&c, "chapter"));
        }
        let mut ideas: Vec<_> = nodes(&slot).values().filter(|n| n.is_drift() && !n.is_trashed()).cloned().collect();
        ideas.sort_by(|a, b| a.title.cmp(&b.title).then(a.id.cmp(&b.id)));
        for n in &ideas {
            owners.push(node(n, "idea"));
        }
        let all_patches = patches(&slot);
        for e in elements(&slot).iter().filter(|e| e.deleted_at.is_none()) {
            let mut mine: Vec<&dr_model::book::Patch> = all_patches.iter().filter(|p| p.element == e.id).collect();
            mine.sort_by(|a, b| dr_model::pos::cmp_pos((a.pos.as_ref(), &a.id), (b.pos.as_ref(), &b.id)));
            owners.push(Owner {
                doc: format!("element:{}", e.id), kind: "element", title: e.name.clone(),
                about: Some(("summary", e.summary.clone())),
                patches: mine.iter().map(|p| match &p.title {
                    Some(t) if !t.trim().is_empty() => format!("{t}\n{}", p.body),
                    _ => p.body.clone(),
                }).collect(),
            });
        }
        for s in storylines(&slot).iter().filter(|s| s.deleted_at.is_none()) {
            owners.push(Owner {
                doc: format!("storyline:{}", s.id), kind: "storyline", title: s.name.clone(),
                about: Some(("summary", s.summary.clone())), patches: Vec::new(),
            });
        }
        for c in categories(&slot).iter().filter(|c| c.deleted_at.is_none()) {
            owners.push(Owner {
                doc: format!("category:{}", c.id), kind: "category", title: c.name.clone(),
                about: None, patches: Vec::new(),
            });
        }
        for m in materials(&slot).iter() {
            owners.push(Owner {
                doc: format!("material:{}", m.id), kind: "material", title: m.title.clone(),
                about: Some(("description", m.description.clone())), patches: Vec::new(),
            });
        }
        let order: Vec<&str> = owners.iter().map(|o| o.doc.as_str()).collect();
        let prose = cx.workspace().library().search_in_order(Some(&input.book), &input.query, limit, &order)?;
        // Prose hits by document, in paragraph order. Documents not in the
        // order (trashed owners, orphans) come last from dr-store; they are
        // left out.
        let mut by_doc: std::collections::HashMap<String, Vec<dr_store::index::SearchHit>> = Default::default();
        for h in prose {
            by_doc.entry(h.doc_id.clone()).or_default().push(h);
        }
        let mut out = Vec::new();
        for o in &owners {
            if out.len() >= limit {
                break;
            }
            let owner = o.doc.split_once(':').map(|(_, id)| id.to_string()).unwrap_or_default();
            let short = |field: &str, text: &str| text_hit(text, &needle).map(|(offset, snippet, at)| SearchHitInfo {
                doc: o.doc.clone(), kind: o.kind.to_string(), owner: owner.clone(), title: o.title.clone(),
                field: field.to_string(), block_id: None, paragraph: None, offset, snippet,
                snippet_match: at, match_len: needle.len(),
            });
            out.extend(short("title", &o.title));
            if let Some((field, text)) = &o.about {
                out.extend(short(field, text));
            }
            for h in by_doc.remove(&o.doc).unwrap_or_default() {
                let snippet: Vec<char> = h.snippet.chars().collect();
                let at = find_folded(&snippet, &needle).unwrap_or(0);
                out.push(SearchHitInfo {
                    doc: o.doc.clone(), kind: o.kind.to_string(), owner: owner.clone(), title: o.title.clone(),
                    field: "body".to_string(), block_id: h.block_id, paragraph: Some(h.ord),
                    offset: h.match_offset, snippet: one_line(snippet.into_iter()), snippet_match: at,
                    match_len: needle.len(),
                });
            }
            for p in &o.patches {
                out.extend(short("patch", p));
            }
        }
        out.truncate(limit);
        Ok(out)
    }
}
