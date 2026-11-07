//! Element patches (补丁): canon the author adds to an element (要素) from a
//! point of the story on, each a title and a body, optionally taken from a
//! passage of a chapter or idea (its node, paragraph, the passage as it read,
//! and an anchor on it). The 0.1 interface's rules (`PatchesSection`,
//! `PatchEditorCard`, `PatchCreateModal`, `patch-validity.ts`), which F3
//! follows where the 0.1 Agent tools differed:
//!
//! - Created floating (「+ 新建」, even empty) or from a selection in a
//!   chapter or an idea; a source paragraph needs its node
//!   (`PATCH-BLOCK-NEEDS-NODE`). A title that is empty is none; the body is
//!   plain text (the book document keeps it as a mergeable text).
//! - 改章节归属: another chapter, or none; the paragraph is cleared, the
//!   passage and its anchor stay.
//! - 失效: a patch whose passage no longer occurs in its node's text (spaces
//!   collapsed) is marked invalidated, and unmarked when the passage comes
//!   back (`patch.check_sources`, run after the node's prose changed; only
//!   the changes are written, and it is not an author's step).
//! - Deleted at once, never refused (the 0.1 Agent refused while relations
//!   or comments pointed at it); relations to it go and comments on it
//!   float, as for every purge; the undo brings it all back. Invalidated
//!   patches are listed and editable like any other (the 0.1 Agent hid them).
//! - The list: by the source chapter's reading order, then the patch's own
//!   position; floating patches last.

use std::collections::HashMap;

use dr_doc::book::Collection;
use dr_model::DocId;
use dr_model::book::{EntityRef, Patch};
use dr_model::id::{BlockId, ElementId, NodeId, PatchId};
use dr_model::kind::EntityKind;
use dr_model::pos::PosKey;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::*;
use crate::cx::{EffectAction, Invocation};
use crate::dto::AnchorBytes;
use crate::naming::{Place, pos_for};
use crate::registry::Registry;

pub(crate) fn register(r: &mut Registry) {
    r.add::<PatchList>()
        .add::<PatchCreate>()
        .add::<PatchUpdate>()
        .add::<PatchMove>()
        .add::<PatchDelete>()
        .add::<PatchCheckSources>();
}

#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema)]
pub struct PatchInfo {
    pub id: String,
    pub element: String,
    pub title: Option<String>,
    pub body: String,
    /// The chapter or idea the patch was taken from, while it exists.
    pub source: Option<String>,
    pub source_block: Option<String>,
    /// The passage as it read when the patch was taken.
    pub source_text: Option<String>,
    /// Whether it carries an anchor on the passage.
    pub anchored: bool,
    /// Since when the passage no longer occurs in its source (Unix seconds).
    pub invalidated_at: Option<i64>,
    pub pos: Option<String>,
}

impl From<&Patch> for PatchInfo {
    fn from(p: &Patch) -> Self {
        PatchInfo {
            id: p.id.to_string(),
            element: p.element.to_string(),
            title: p.title.clone(),
            body: p.body.clone(),
            source: p.source_node.as_ref().map(|n| n.to_string()),
            source_block: p.source_block.as_ref().map(|b| b.to_string()),
            source_text: p.source_text.clone(),
            anchored: p.anchor.is_some(),
            invalidated_at: p.invalidated_at.map(|t| t.0),
            pos: p.pos.as_ref().map(|k| k.to_string()),
        }
    }
}

fn element_of(slot: &BookSlot, id: &str) -> Result<ElementId> {
    let eid: ElementId = pid("element", id)?;
    if is_live(slot, &EntityRef::new(EntityKind::Element, id)) {
        Ok(eid)
    } else {
        Err(WsError::not_found("element", id))
    }
}

/// A live chapter or idea (`chapters` only: just chapters, as 改章节归属).
fn node_of(slot: &BookSlot, id: &str, chapters: bool) -> Result<NodeId> {
    let n: NodeId = pid("node", id)?;
    match nodes(slot).get(&n) {
        Some(node) if !node.is_trashed() && (node.is_chapter() || !chapters) => Ok(n),
        _ => Err(WsError::not_found(
            if chapters {
                "chapter"
            } else {
                "chapter or idea"
            },
            id,
        )),
    }
}

fn find(slot: &BookSlot, id: &str) -> Result<Patch> {
    patches(slot)
        .iter()
        .find(|p| p.id.as_str() == id)
        .cloned()
        .ok_or_else(|| WsError::not_found("patch", id))
}

/// The element's patches other than `except`, as (id, position) in order.
fn siblings(
    slot: &BookSlot,
    element: &ElementId,
    except: Option<&PatchId>,
) -> Vec<(String, Option<PosKey>)> {
    patches(slot)
        .iter()
        .filter(|p| &p.element == element && Some(&p.id) != except)
        .map(|p| (p.id.to_string(), p.pos.clone()))
        .collect()
}

/// A title as the interface keeps it: empty is none.
fn title_of(t: Option<&str>) -> Option<String> {
    t.filter(|t| !t.is_empty()).map(str::to_string)
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct PatchListIn {
    pub book: String,
    pub element: String,
}

op! {
    PatchList = "patch.list", Read, Shared,
    "List an element's patches: by their source chapter's reading order, then their own order; floating ones last. Invalidated ones are listed too.",
    fn(cx, input: PatchListIn) -> Vec<PatchInfo> {
        let slot = cx.book(&input.book)?;
        let eid: ElementId = pid("element", &input.element)?;
        let reading: HashMap<NodeId, usize> = chapters(&slot).iter().enumerate().map(|(i, c)| (c.id.clone(), i)).collect();
        let mut list: Vec<(Option<usize>, usize, PatchInfo)> = patches(&slot).iter().enumerate()
            .filter(|(_, p)| p.element == eid)
            .map(|(i, p)| {
                // An idea, or a chapter in the trash, after the chapters.
                let at = p.source_node.as_ref().map(|n| reading.get(n).copied().unwrap_or(usize::MAX - 1));
                (at, i, PatchInfo::from(p))
            })
            .collect();
        list.sort_by_key(|(at, i, _)| (at.is_none(), at.unwrap_or(0), *i));
        Ok(list.into_iter().map(|(_, _, p)| p).collect())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct PatchCreateIn {
    pub book: String,
    pub element: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default)]
    pub body: String,
    /// The chapter or idea the passage comes from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Its paragraph (needs `source`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_block: Option<String>,
    /// The passage as it reads now.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_text: Option<String>,
    /// An anchor on the passage in `source`'s prose (dr-doc's two cursors,
    /// base64, as `comment.reanchor` takes them).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor: Option<AnchorBytes>,
    /// Where it goes among the element's patches (last by default).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub place: Option<Place>,
    /// An exact position key and id (undo uses them).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pos: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

op! {
    PatchCreate = "patch.create", Write, Book,
    "Add a patch to an element: a title (optional) and a body, floating or taken from a passage of a chapter or idea.",
    fn(cx, input: PatchCreateIn) -> Done {
        let slot = cx.book(&input.book)?;
        let element = element_of(&slot, &input.element)?;
        let node = input.source.as_deref().map(|n| node_of(&slot, n, false)).transpose()?;
        let block = input.source_block.as_deref().map(|b| pid::<BlockId>("block", b)).transpose()?;
        dr_model::check::patch_source(node.as_ref(), block.as_ref())?;
        let anchor = match (&input.anchor, &node) {
            (Some(a), Some(n)) => Some(super::comment::anchor_in(cx, &DocId::Node(n.clone()), a)?),
            (Some(_), None) => return Err(WsError::invalid("an anchor needs its source")),
            (None, _) => None,
        };
        let id: PatchId = match &input.id {
            Some(i) => {
                let id: PatchId = pid("patch", i)?;
                if patches(&slot).iter().any(|p| p.id == id) {
                    return Err(WsError::Conflict(format!("patch {i} exists")));
                }
                id
            }
            None => PatchId::new_v7(),
        };
        let pos = match (&input.pos, &input.place) {
            (Some(p), _) => PosKey::parse(p).map_err(|e| WsError::invalid(e.to_string()))?,
            (None, place) => pos_for(&siblings(&slot, &element, None), place.as_ref().unwrap_or(&Place::Last))?,
        };
        let title = title_of(input.title.as_deref());
        let (i2, e2, t2, b2, n2, bl2, s2, p2) = (id.clone(), element.clone(), title.clone(), input.body.clone(),
            node.clone(), block.clone(), input.source_text.clone(), pos.clone());
        cx.write_book(&slot, move |txn| {
            txn.patch(&i2)?.element(&e2)?.title(t2.as_deref())?.pos(&p2)?
                .source_node(n2.as_ref())?.source_block(bl2.as_ref())?.source_text(s2.as_deref())?
                .anchor(anchor.as_ref())?.body(&b2)?;
            Ok(())
        })?;
        cx.effect(EffectAction::Created, "patch", id.as_str(), title.as_deref());
        cx.undo_with(Invocation::new("patch.delete", EntityIn { book: input.book.clone(), id: id.to_string() }));
        Ok(Done { id: id.to_string() })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct PatchUpdateIn {
    pub book: String,
    pub id: String,
    /// A new title; `null` or empty clears it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub title: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// 改章节归属: another chapter, or `null` for none. The paragraph is
    /// cleared; the passage and its anchor stay.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub source: Option<Option<String>>,
    /// The paragraph to put back (undo uses it, with `source`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_block: Option<String>,
}

op! {
    PatchUpdate = "patch.update", Write, Book,
    "Change a patch's title or body, or the chapter it belongs to (none detaches it).",
    fn(cx, input: PatchUpdateIn) -> Done {
        let slot = cx.book(&input.book)?;
        let old = find(&slot, &input.id)?;
        let title = input.title.as_ref().map(|t| title_of(t.as_deref()));
        let source: Option<Option<NodeId>> = match &input.source {
            Some(Some(n)) => Some(Some(node_of(&slot, n, input.source_block.is_none())?)),
            Some(None) => Some(None),
            None => None,
        };
        let block = match (&source, &input.source_block) {
            (Some(Some(_)), Some(b)) => Some(pid::<BlockId>("block", b)?),
            (_, Some(_)) => return Err(WsError::invalid("source_block needs source")),
            _ => None,
        };
        let (id, t2, b2, s2, bl2) = (old.id.clone(), title.clone(), input.body.clone(), source.clone(), block.clone());
        cx.write_book(&slot, move |txn| {
            let w = txn.patch(&id)?;
            if let Some(t) = &t2 { w.title(t.as_deref())?; }
            if let Some(b) = &b2 { w.body(b)?; }
            if let Some(n) = &s2 { w.source_node(n.as_ref())?.source_block(bl2.as_ref())?; }
            Ok(())
        })?;
        cx.effect(EffectAction::Updated, "patch", &input.id, title.as_ref().and_then(|t| t.as_deref()));
        cx.undo_with(Invocation::new("patch.update", PatchUpdateIn {
            book: input.book.clone(),
            id: input.id.clone(),
            title: title.as_ref().map(|_| old.title.clone()),
            body: input.body.as_ref().map(|_| old.body.clone()),
            source: source.as_ref().map(|_| old.source_node.as_ref().map(|n| n.to_string())),
            source_block: source.as_ref().and(old.source_block.as_ref()).map(|b| b.to_string()),
        }));
        Ok(Done { id: input.id })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct PatchMoveIn {
    pub book: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub place: Option<Place>,
    /// An exact position key (undo uses it); wins over `place`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pos: Option<String>,
}

op! {
    PatchMove = "patch.move", Write, Book,
    "Move a patch among its element's patches (within the same source chapter the order is the patches' own).",
    fn(cx, input: PatchMoveIn) -> Done {
        let slot = cx.book(&input.book)?;
        let old = find(&slot, &input.id)?;
        let pos = match (&input.pos, &input.place) {
            (Some(p), _) => PosKey::parse(p).map_err(|e| WsError::invalid(e.to_string()))?,
            (None, Some(place)) => pos_for(&siblings(&slot, &old.element, Some(&old.id)), place)?,
            (None, None) => return Err(WsError::invalid("give place or pos")),
        };
        let (id, p2) = (old.id.clone(), pos.clone());
        cx.write_book(&slot, move |txn| { txn.patch(&id)?.pos(&p2)?; Ok(()) })?;
        cx.effect(EffectAction::Moved, "patch", &input.id, None);
        match &old.pos {
            Some(p) => cx.undo_with(Invocation::new("patch.move", PatchMoveIn {
                book: input.book.clone(), id: input.id.clone(), place: None, pos: Some(p.to_string()),
            })),
            None => cx.irreversible(),
        }
        Ok(Done { id: input.id })
    }
}

op! {
    PatchDelete = "patch.delete", Write, Book,
    "Delete a patch at once (never refused): relations to it go and comments on it float, in the same commit; undo brings it all back.",
    fn(cx, input: EntityIn) -> Done {
        let slot = cx.book(&input.book)?;
        let old = find(&slot, &input.id)?;
        let target = EntityRef::new(EntityKind::Patch, input.id.clone());
        let (rels, cmts) = purge_fallout(&slot, &target);
        let mut touched: Vec<(String, String)> = vec![("patches".into(), input.id.clone())];
        touched.extend(rels.iter().map(|r| ("relations".to_string(), r.to_string())));
        touched.extend(cmts.iter().map(|c| ("comments".to_string(), c.to_string())));
        let (id, r2, c2) = (old.id.clone(), rels.clone(), cmts.clone());
        let (_, before) = cx.write_book(&slot, move |txn| {
            apply_fallout(txn, &r2, &c2)?;
            txn.purge(Collection::Patches, id.as_str())?;
            Ok(())
        })?;
        report_fallout(cx, &rels, &cmts);
        cx.effect(EffectAction::Purged, "patch", &input.id, old.title.as_deref());
        cx.undo_with(super::history::restore_invocation(&input.book, &before, touched));
        Ok(Done { id: input.id })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct CheckSourcesIn {
    pub book: String,
    /// The chapter or idea whose prose changed.
    pub node: String,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct SourcesChecked {
    /// Patches whose passage went missing now.
    pub invalidated: Vec<String>,
    /// Patches whose passage is back.
    pub restored: Vec<String>,
}

/// The 0.1 comparison: whitespace runs collapse to one space, ends trimmed.
fn norm(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

op! {
    PatchCheckSources = "patch.check_sources", Write, Book,
    "After a chapter's or idea's prose changed: mark the patches taken from it whose passage no longer occurs as invalidated, and unmark those whose passage is back. Follows the prose; not an author's step.",
    fn(cx, input: CheckSourcesIn) -> SourcesChecked {
        let slot = cx.book(&input.book)?;
        let node: NodeId = pid("node", &input.node)?;
        let mine: Vec<Patch> = patches(&slot).iter()
            .filter(|p| p.source_node.as_ref() == Some(&node))
            .filter(|p| p.source_text.as_deref().is_some_and(|t| !norm(t).is_empty()))
            .cloned().collect();
        let mut out = SourcesChecked { invalidated: Vec::new(), restored: Vec::new() };
        cx.follows_prose();
        if mine.is_empty() {
            cx.undo_nothing();
            return Ok(out);
        }
        let text = {
            let ps = cx.prose(&DocId::Node(node.clone()))?;
            norm(&dr_text::plain_text(&ps.reader.view()))
        };
        for p in &mine {
            let found = text.contains(&norm(p.source_text.as_deref().unwrap_or_default()));
            match (found, p.invalidated_at.is_some()) {
                (false, false) => out.invalidated.push(p.id.to_string()),
                (true, true) => out.restored.push(p.id.to_string()),
                _ => {}
            }
        }
        if out.invalidated.is_empty() && out.restored.is_empty() {
            cx.undo_nothing();
            return Ok(out);
        }
        let (inv, back) = (out.invalidated.clone(), out.restored.clone());
        cx.write_book(&slot, move |txn| {
            let t = now();
            for id in &inv { txn.patch(&pid("patch", id)?)?.invalidated_at(Some(t))?; }
            for id in &back { txn.patch(&pid("patch", id)?)?.invalidated_at(None)?; }
            Ok(())
        })?;
        for id in out.invalidated.iter().chain(&out.restored) {
            cx.effect(EffectAction::Updated, "patch", id.as_str(), None);
        }
        cx.undo_nothing();
        Ok(out)
    }
}
