//! The minimal prose interface: read paragraphs, replace an exact passage,
//! restore a version, put entity links on or off anchored ranges (and put
//! back what a change of links found there). Editing proper is the editor's
//! (F4); the Agent's projection of prose into editable text is M29.

use dr_model::DocId;
use dr_model::kind::{EntityKind, ListKind};
use dr_model::v3::EntityLinkV3;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

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
        .add::<ProseRestoreLinks>()
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
    /// Canonical prose: `body:<entry>/<module>` or `template:<book>/<template>/<module>`.
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
    /// A list item's kind: `bullet`, `ordered` or `task` (a checklist item,
    /// which is also a comment); omitted for a paragraph that is not one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub list: Option<String>,
    /// How deep a list item is nested; omitted when 0.
    #[serde(skip_serializing_if = "is_zero")]
    pub list_level: u32,
    /// A checklist item's tick (on `task` items only): ticked is its comment
    /// resolved.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked: Option<bool>,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

impl ParagraphInfo {
    fn of(index: usize, p: &dr_doc::prose::Paragraph) -> Self {
        let list = p.attrs.list.as_ref();
        Self {
            index,
            block_id: p.id.as_ref().map(|b| b.to_string()),
            heading: p.attrs.heading.map(|h| h.level() as u8).unwrap_or(0),
            text: p.text(),
            list: list.map(|l| l.as_str().to_owned()),
            list_level: if list.is_some() {
                p.attrs.list_level
            } else {
                0
            },
            checked: (list == Some(&ListKind::Task)).then_some(p.attrs.checked),
        }
    }
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
    "Read paragraphs of a prose document (text, block id, heading level; a list item's kind and level, a checklist item's tick).",
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
                    paragraphs.push(ParagraphInfo::of(i, &p));
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

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct LinkIn {
    pub doc: String,
    /// A canonical entry or asset-library file. Refused where a link to it
    /// there carries a module, blocks or unknown data.
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
type DocLinks = Vec<(EntityLinkV3, Vec<dr_doc::anchor::Anchor>)>;

/// Whether `value`, the stored link to a target of `kind` on some run, is one
/// `prose.link` and `prose.unlink` may change: none, an automatic link
/// (`{kind}`), or one made by hand (`{kind, manual: true}`, `kernel-v5.md`
/// §16). A link into a module or blocks, or one with data this version does
/// not know, is left as it is.
fn plain_link(value: Option<&loro::LoroValue>, kind: &EntityKind) -> bool {
    use loro::LoroValue;
    let Some(value) = value else {
        return true;
    };
    let LoroValue::Map(map) = value else {
        return false;
    };
    matches!(map.get("kind"), Some(LoroValue::String(k)) if k.as_str() == kind.as_str())
        && map.iter().all(|(key, v)| match key.as_str() {
            "kind" => true,
            dr_model::prose::LINK_MANUAL => matches!(v, LoroValue::Bool(_)),
            _ => false,
        })
}

fn refused_link() -> WsError {
    WsError::invalid(
        "a link there carries more than its target (a module, blocks or data this version does not know); it is left as it is",
    )
}

/// `range` of `target`'s link, before and after a write: the runs whose
/// value changed, each with the value before and the value after.
type Changed = Vec<(
    std::ops::Range<usize>,
    Option<loro::LoroValue>,
    Option<loro::LoroValue>,
)>;

fn changed_runs(
    before: &[(std::ops::Range<usize>, Option<loro::LoroValue>)],
    after: &[(std::ops::Range<usize>, Option<loro::LoroValue>)],
) -> Changed {
    let value_at = |runs: &[(std::ops::Range<usize>, Option<loro::LoroValue>)], at: usize| {
        runs.iter()
            .find(|(r, _)| r.contains(&at))
            .and_then(|(_, v)| v.clone())
    };
    let mut cuts: Vec<usize> = before
        .iter()
        .chain(after)
        .flat_map(|(r, _)| [r.start, r.end])
        .collect();
    cuts.sort_unstable();
    cuts.dedup();
    let mut out: Changed = Vec::new();
    for w in cuts.windows(2) {
        let (was, now) = (value_at(before, w[0]), value_at(after, w[0]));
        if was == now {
            continue;
        }
        match out.last_mut() {
            Some((r, b, a)) if r.end == w[0] && *b == was && *a == now => r.end = w[1],
            _ => out.push((w[0]..w[1], was, now)),
        }
    }
    out
}

/// A run's value as the undo carries it: JSON (an entity link's value is a
/// map of strings and booleans, which JSON keeps exactly).
fn json_value(v: Option<loro::LoroValue>) -> Option<Value> {
    v.map(Value::from)
}

/// The value of [`LinkSpan`] back as stored: a map that converts both ways
/// unchanged, or nothing.
fn stored_value(v: Option<&Value>) -> Result<Option<loro::LoroValue>> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(json @ Value::Object(_)) => {
            let value = loro::LoroValue::from(json.clone());
            if Value::from(value.clone()) != *json {
                return Err(WsError::invalid("a link value it cannot put back exactly"));
            }
            Ok(Some(value))
        }
        Some(_) => Err(WsError::invalid("a link value is an object or null")),
    }
}

/// Put the links of `input` on (`on`) or off. Documents are opened and
/// written a few at a time (an automatic backfill's undo touches hundreds).
///
/// A link put on is the author's kind of link (`kernel-v5.md` §16): to an
/// entry it is recorded as made by hand (`manual`, the value a pick with @
/// writes), so it shows whatever the entry's 「自动链接」 and the author's
/// setting say, and automatic linking leaves it alone; a link to a file has
/// no switch and is written as the editor writes it. The undo
/// (`prose.restore_links`) puts back on each changed run the value that was
/// there: no link, an automatic one or one made by hand.
fn set_links(cx: &Cx<'_>, input: &LinksIn, on: bool) -> Result<LinksChanged> {
    // Validate everything before writing anything.
    let mut by_doc: Vec<(DocId, DocLinks)> = Vec::new();
    for l in &input.links {
        let doc = doc_id(&l.doc)?;
        let kind = EntityKind::parse(&l.target.kind);
        if !kind.may_be_linked_v3() && kind != EntityKind::Asset {
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
        let link = EntityLinkV3 {
            target: l.target.id.clone(),
            manual: kind == EntityKind::Entry,
            kind,
            module: None,
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
    // And every run the call would change must be a plain link (or none):
    // the whole request is refused before the first write rather than
    // change a link it does not understand.
    for (doc, links) in &by_doc {
        let slot = ws.prose_slot(doc)?;
        let document = slot.handle.doc().with_doc(Clone::clone);
        let vv = document.oplog_vv();
        for (_, anchors) in links {
            for a in anchors {
                super::comment_shared::anchor_known_in(&vv, doc, a)?;
            }
        }
        let reader = dr_doc::prose::BorrowedProse::new(&document, doc)?;
        check_plain(&reader.view(), links)?;
    }
    // Then a few documents at a time, each opened, written and let go.
    let written = by_doc
        .iter()
        .map(|(doc, links)| {
            let ps = ws.prose_slot(doc)?;
            let (doc, links) = (doc.clone(), links.clone());
            cx.write_prose_raw(&ps, move |d| {
                let b = dr_doc::prose::BorrowedProse::new(d, &doc)?;
                let mut txn = b.txn();
                // Checked again on the state the edit applies to.
                let found = check_plain(&txn.view(), &links)?;
                // What each target's link was on everything this call
                // touches, before anything is written.
                let mut touched: Vec<(String, Vec<std::ops::Range<usize>>)> = Vec::new();
                for ((link, _), ranges) in links.iter().zip(&found) {
                    match touched.iter_mut().find(|(t, _)| *t == link.target) {
                        Some((_, all)) => all.extend(ranges.iter().cloned()),
                        None => touched.push((link.target.clone(), ranges.clone())),
                    }
                }
                let mut before = Vec::new();
                for (target, ranges) in &touched {
                    for range in merged(ranges.clone()) {
                        let was = txn.view().entity_link_values(range.clone(), target)?;
                        before.push((target.clone(), range, was));
                    }
                }
                let mut n = 0;
                for ((link, _), ranges) in links.iter().zip(&found) {
                    for r in ranges {
                        let was = txn.view().entity_link_values(r.clone(), &link.target)?;
                        if on {
                            txn.link_entity_v3(r.clone(), link)?;
                        } else {
                            txn.unlink_entity(r.clone(), &link.target)?;
                        }
                        if txn.view().entity_link_values(r.clone(), &link.target)? != was {
                            n += 1;
                        }
                    }
                }
                // The undo: on every run that changed, the value it had.
                let mut back: Vec<LinkValues> = Vec::new();
                for (target, range, was) in before {
                    let now = txn.view().entity_link_values(range, &target)?;
                    let spans = changed_runs(&was, &now)
                        .into_iter()
                        .map(|(run, was, now)| {
                            let anchor = txn.view().anchor(run).ok_or_else(|| {
                                WsError::Internal("a changed run has no anchor".into())
                            })?;
                            Ok(LinkSpan {
                                anchor: crate::dto::AnchorBytes::from(&anchor.encode()),
                                expected: json_value(now),
                                value: json_value(was),
                            })
                        })
                        .collect::<Result<Vec<_>>>()?;
                    push_spans(&mut back, &doc, &target, spans);
                }
                Ok((n, back))
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let mut out = LinksChanged { ranges: 0, docs: 0 };
    let mut back = Vec::new();
    for ((doc, _), (n, spans)) in by_doc.iter().zip(written) {
        if n > 0 {
            out.ranges += n;
            out.docs += 1;
            cx.effect(EffectAction::Updated, "prose", doc.to_string(), None);
        }
        back.extend(spans);
    }
    if back.is_empty() {
        cx.undo_nothing();
    } else {
        cx.undo_with(Invocation::new(
            "prose.restore_links",
            LinkValuesIn { links: back },
        ));
    }
    Ok(out)
}

/// The ranges each link of `links` is to change now (anchors whose text is
/// gone left out), once every run in them is a [`plain_link`] to its target.
fn check_plain(
    view: &dr_doc::prose::ProseView<'_>,
    links: &DocLinks,
) -> Result<Vec<Vec<std::ops::Range<usize>>>> {
    let mut found = Vec::new();
    for (link, anchors) in links {
        let ranges: Vec<std::ops::Range<usize>> = anchors
            .iter()
            .filter_map(|a| view.resolve(a))
            .filter(|r| !r.collapsed)
            .map(|r| r.range)
            .collect();
        for r in &ranges {
            for (_, value) in view.entity_link_values(r.clone(), &link.target)? {
                if !plain_link(value.as_ref(), &link.kind) {
                    return Err(refused_link());
                }
            }
        }
        found.push(ranges);
    }
    Ok(found)
}

/// `ranges` sorted, overlapping and touching ones joined.
fn merged(mut ranges: Vec<std::ops::Range<usize>>) -> Vec<std::ops::Range<usize>> {
    ranges.sort_by_key(|r| (r.start, r.end));
    let mut out: Vec<std::ops::Range<usize>> = Vec::new();
    for r in ranges {
        match out.last_mut() {
            Some(last) if r.start <= last.end => last.end = last.end.max(r.end),
            _ => out.push(r),
        }
    }
    out
}

fn push_spans(back: &mut Vec<LinkValues>, doc: &DocId, target: &str, spans: Vec<LinkSpan>) {
    if spans.is_empty() {
        return;
    }
    let doc = doc.to_string();
    match back.iter_mut().find(|l| l.doc == doc && l.target == target) {
        Some(l) => l.spans.extend(spans),
        None => back.push(LinkValues {
            doc,
            target: target.to_owned(),
            spans,
        }),
    }
}

op! {
    ProseLink = "prose.link", Write, Book,
    "Link anchored ranges of prose documents to entities (anchors, not positions). Links to entries count as the author's own: shown even where automatic linking is off.",
    fn(cx, input: LinksIn) -> LinksChanged {
        set_links(cx, &input, true)
    }
}

op! {
    ProseUnlink = "prose.unlink", Write, Book,
    "Take links to entities off anchored ranges of prose documents (anchors, not positions).",
    fn(cx, input: LinksIn) -> LinksChanged {
        set_links(cx, &input, false)
    }
}

/// One run of a target's link on an anchored span: what the recorded write
/// left there and what to put back.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct LinkSpan {
    /// The span, as an anchor (two cursors), so typing since moves nothing.
    pub anchor: crate::dto::AnchorBytes,
    /// The link's stored value there as the recorded write left it (`null`:
    /// no link).
    #[serde(default)]
    pub expected: Option<Value>,
    /// The stored value to put back (`null`: no link).
    #[serde(default)]
    pub value: Option<Value>,
}

/// One target's link on spans of one document.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct LinkValues {
    pub doc: String,
    /// The target's id (an entry's or a file's): the link is the text's
    /// mark `entity:<target>`.
    pub target: String,
    pub spans: Vec<LinkSpan>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct LinkValuesIn {
    pub links: Vec<LinkValues>,
}

/// One span of a [`LinkValues`], decoded.
#[derive(Clone)]
struct Restore {
    anchor: dr_doc::anchor::Anchor,
    expected: Option<loro::LoroValue>,
    value: Option<loro::LoroValue>,
}

/// One document's spans of a [`LinkValuesIn`]: each target with its spans.
type DocRestores = Vec<(String, Vec<Restore>)>;

/// The runs to write now, each `(target, run, value, expected)`: where a span
/// still reads `expected`; a run that reads `value` already is left alone,
/// and one that reads anything else refuses the whole call.
type Planned = Vec<(
    String,
    std::ops::Range<usize>,
    Option<loro::LoroValue>,
    Option<loro::LoroValue>,
)>;

fn plan_restore(view: &dr_doc::prose::ProseView<'_>, links: &DocRestores) -> Result<Planned> {
    let mut out = Vec::new();
    for (target, spans) in links {
        for s in spans {
            let Some(r) = view.resolve(&s.anchor).filter(|r| !r.collapsed) else {
                continue;
            };
            for (run, now) in view.entity_link_values(r.range, target)? {
                if now == s.value {
                    continue;
                }
                if now != s.expected {
                    return Err(WsError::Conflict(
                        "a link changed after the recorded write".into(),
                    ));
                }
                out.push((target.clone(), run, s.value.clone(), s.expected.clone()));
            }
        }
    }
    Ok(out)
}

/// The kind of entity a stored link value points at, when it says.
fn value_kind(value: &loro::LoroValue) -> Option<EntityKind> {
    match value {
        loro::LoroValue::Map(m) => match m.get("kind") {
            Some(loro::LoroValue::String(k)) => Some(EntityKind::parse(k)),
            _ => None,
        },
        _ => None,
    }
}

/// Undo or redo a change of links (`prose.link`, `prose.unlink`, and its own
/// undo): every span is checked before anything is written, so a link
/// another writer changed since refuses the whole call.
fn restore_links(cx: &Cx<'_>, input: &LinkValuesIn) -> Result<LinksChanged> {
    let mut by_doc: Vec<(DocId, DocRestores)> = Vec::new();
    for l in &input.links {
        let doc = doc_id(&l.doc)?;
        if dr_model::id::EntryId::parse(&l.target).is_err()
            && dr_model::id::AssetId::parse(&l.target).is_err()
        {
            return Err(WsError::invalid(format!(
                "{:?} is not a link target",
                l.target
            )));
        }
        let spans = l
            .spans
            .iter()
            .map(|s| {
                Ok(Restore {
                    anchor: super::comment_shared::decode_anchor(&s.anchor)?,
                    expected: stored_value(s.expected.as_ref())?,
                    value: stored_value(s.value.as_ref())?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        match by_doc.iter_mut().find(|(d, _)| *d == doc) {
            Some((_, v)) => v.push((l.target.clone(), spans)),
            None => by_doc.push((doc, vec![(l.target.clone(), spans)])),
        }
    }
    let lib = cx.workspace().library();
    for (doc, links) in &by_doc {
        let info = lib
            .doc_info(&doc.to_string())?
            .ok_or_else(|| WsError::not_found("document", doc.to_string()))?;
        if let Some(b) = info.book_id {
            let slot = cx.book_v3(&b)?;
            // A link put back needs its target: one deleted for good since
            // retires the step (`NotFound`).
            for (target, spans) in links {
                for kind in spans
                    .iter()
                    .filter_map(|s| s.value.as_ref())
                    .filter_map(value_kind)
                {
                    if !slot
                        .reader_v3
                        .view()
                        .entity_exists(&dr_model::shared::EntityRef::new(kind, target))
                    {
                        return Err(WsError::not_found("link target", target));
                    }
                }
            }
        }
    }
    let ws = cx.workspace();
    for (doc, links) in &by_doc {
        let slot = ws.prose_slot(doc)?;
        let document = slot.handle.doc().with_doc(Clone::clone);
        let vv = document.oplog_vv();
        for (_, spans) in links {
            for s in spans {
                super::comment_shared::anchor_known_in(&vv, doc, &s.anchor)?;
            }
        }
        let reader = dr_doc::prose::BorrowedProse::new(&document, doc)?;
        plan_restore(&reader.view(), links)?;
    }
    let written = by_doc
        .iter()
        .map(|(doc, links)| {
            let ps = ws.prose_slot(doc)?;
            let (doc, links) = (doc.clone(), links.clone());
            cx.write_prose_raw(&ps, move |d| {
                let b = dr_doc::prose::BorrowedProse::new(d, &doc)?;
                let mut txn = b.txn();
                let planned = plan_restore(&txn.view(), &links)?;
                let mut back: Vec<LinkValues> = Vec::new();
                let n = planned.len();
                for (target, run, value, expected) in planned {
                    txn.put_entity_link_value(run.clone(), &target, value.as_ref())?;
                    let anchor = txn
                        .view()
                        .anchor(run)
                        .ok_or_else(|| WsError::Internal("a restored run has no anchor".into()))?;
                    let span = LinkSpan {
                        anchor: crate::dto::AnchorBytes::from(&anchor.encode()),
                        expected: json_value(value),
                        value: json_value(expected),
                    };
                    push_spans(&mut back, &doc, &target, vec![span]);
                }
                Ok((n, back))
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let mut out = LinksChanged { ranges: 0, docs: 0 };
    let mut back = Vec::new();
    for ((doc, _), (n, spans)) in by_doc.iter().zip(written) {
        if n > 0 {
            out.ranges += n;
            out.docs += 1;
            cx.effect(EffectAction::Updated, "prose", doc.to_string(), None);
        }
        back.extend(spans);
    }
    if back.is_empty() {
        cx.undo_nothing();
    } else {
        cx.undo_with(Invocation::new(
            "prose.restore_links",
            LinkValuesIn { links: back },
        ));
    }
    Ok(out)
}

op! {
    ProseRestoreLinks = "prose.restore_links", Write, Book,
    "Undo or redo a change of entity links on anchored spans of prose documents: on each span put back `value` while the link there still reads `expected` (a span already reading `value` is left alone). A link changed otherwise since refuses the whole call before anything is written.",
    fn(cx, input: LinkValuesIn) -> LinksChanged {
        restore_links(cx, &input)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ProseShapeIn {
    /// A canonical body or template-module prose document.
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
    /// Checklist items and how many are checked.
    pub tasks: u32,
    pub done: u32,
    /// The assets it embeds, in order (repeats kept).
    pub embeds: Vec<String>,
    /// Embedded asset IDs whose asset is missing or trashed in the book's asset library (shown as placeholders).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub missing_embeds: Vec<String>,
    /// The files its links point at, in order (one per linked passage).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub file_links: Vec<String>,
    /// Linked files missing or in Recently Deleted: their links read as
    /// plain text until the file is back.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub missing_links: Vec<String>,
}

op! {
    ProseShapeOp = "prose.shape", Read, Shared,
    "Shape of a prose document: paragraphs, sentences, the share of dialogue, its checklist, the files it embeds and the files it links to (with those in Recently Deleted).",
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
        let mut file_links = Vec::new();
        for p in view.paragraphs() {
            if p.attrs.list == Some(ListKind::Task) {
                tasks += 1;
                done += u32::from(p.attrs.checked);
            }
            if let Some(id) = p.embed()
                && let Some(dr_doc::prose::EmbedView::Asset { asset: Some(a), .. }) = view.embed(id)
            {
                embeds.push(a.as_str().to_owned());
            }
            // A passage linked to a file: a new link starts where a run links
            // to a file the previous run did not.
            let mut previous: Vec<&str> = Vec::new();
            for r in &p.runs {
                let here: Vec<&str> = r
                    .marks
                    .entities
                    .iter()
                    .filter(|l| l.kind == dr_model::kind::EntityKind::Asset)
                    .map(|l| l.target.as_str())
                    .collect();
                for t in &here {
                    if !previous.contains(t) {
                        file_links.push((*t).to_owned());
                    }
                }
                previous = here;
            }
            texts.push(dr_text::block_text(&view, &p));
        }
        let live: Option<std::collections::HashSet<String>> = if (!embeds.is_empty() || !file_links.is_empty())
            && let Some(ref book_id) = slot.book
            && let Ok(book_slot) = cx.book(book_id.as_str())
        {
            Some(
                book_slot
                    .reader_v3
                    .view()
                    .assets()
                    .into_iter()
                    .map(|a| a.id.to_string())
                    .collect(),
            )
        } else {
            None
        };
        let missing = |ids: &[String]| -> Vec<String> {
            live.as_ref()
                .map(|live| ids.iter().filter(|id| !live.contains(*id)).cloned().collect())
                .unwrap_or_default()
        };
        let missing_embeds = missing(&embeds);
        let missing_links = missing(&file_links);
        let shape = dr_text::prose_shape(texts.iter().map(String::as_str));
        Ok(ProseShapeOut {
            paragraphs: shape.paragraphs,
            sentences: shape.sentences,
            dialogue: shape.dialogue,
            tasks,
            done,
            embeds,
            missing_embeds,
            file_links,
            missing_links,
        })
    }
}
