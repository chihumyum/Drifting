//! Comments and TODOs: their metadata in the book document. Anchors are
//! made from a character range of the target's prose document, or handed
//! back by the editor (`comment.reanchor`); TODOs typed as markers in prose
//! are projected by `todo.project`.

use std::collections::{BTreeMap, HashSet};

use dr_doc::anchor::Anchor;
use dr_doc::book::Collection;
use dr_model::DocId;
use dr_model::book::{BlockSnapshot, Comment, EntityRef};
use dr_model::id::{BlockId, CommentId};
use dr_model::kind::{
    CommentAuthorKind, CommentKind, CommentPriority, CommentSource, CommentStatus, EntityKind,
    ProjectionKind,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::*;
use crate::cx::{EffectAction, Invocation};
use crate::dto::{AnchorBytes, CommentAnchor, CommentInfo, Region, Target};
use crate::registry::Registry;

pub(crate) fn register(r: &mut Registry) {
    r.add::<CommentList>()
        .add::<CommentAnchors>()
        .add::<CommentCreate>()
        .add::<CommentUpdate>()
        .add::<CommentReanchor>()
        .add::<CommentDelete>()
        .add::<TodoProject>();
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct CommentListIn {
    pub book: String,
    /// `note` or `todo`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// `open` or `resolved`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// Only comments on this entity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<Target>,
}

op! {
    CommentList = "comment.list", Read, Shared,
    "List comments and TODOs (a target in the trash or gone shows as unlocated).",
    fn(cx, input: CommentListIn) -> Vec<CommentInfo> {
        let slot = cx.book(&input.book)?;
        let t = input.target.as_ref().map(Target::to_ref);
        Ok(comments(&slot).iter()
            .filter(|c| input.kind.as_ref().is_none_or(|k| c.kind.as_str() == k))
            .filter(|c| input.status.as_ref().is_none_or(|s| c.status.as_str() == s))
            .filter(|c| t.as_ref().is_none_or(|t| c.target.as_ref() == Some(t)))
            .map(CommentInfo::from).collect())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct CommentCreateIn {
    pub book: String,
    /// `note` (default) or `todo`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// What it is on; omitted: a floating comment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<Target>,
    /// The paragraph it sits on (needs a target).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block_id: Option<String>,
    /// Anchor it to characters `[start, end)` of the target's prose.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<(usize, usize)>,
    /// Mark a rectangle on an image or PDF material (its target).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<Region>,
    #[serde(default)]
    pub body: String,
    /// `low`, `med` or `high`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_name: Option<String>,
}

fn prose_of(t: &Target) -> Option<DocId> {
    DocId::parse(&format!("{}:{}", t.kind, t.id))
        .ok()
        .filter(|d| d.profile().is_some())
}

op! {
    CommentCreate = "comment.create", Write, Book,
    "Add a comment or TODO, on an entity, a paragraph, a passage of its prose, a region of an image or PDF, or floating.",
    fn(cx, input: CommentCreateIn) -> Done {
        let slot = cx.book(&input.book)?;
        let kind = CommentKind::parse(input.kind.as_deref().unwrap_or("note"));
        if !kind.is_known() { return Err(WsError::invalid(format!("unknown comment kind {:?}", kind.as_str()))); }
        let target = input.target.as_ref().map(Target::to_ref);
        let block = input.block_id.as_deref().map(|b| pid::<BlockId>("block", b)).transpose()?;
        dr_model::check::comment_target(target.as_ref(), block.as_ref())?;
        if let Some(t) = &target { require_live(&slot, t.kind.clone(), &t.id)?; }
        let priority = input.priority.as_deref().map(CommentPriority::parse);
        if let Some(p) = &priority && !p.is_known() { return Err(WsError::invalid(format!("unknown priority {:?}", p.as_str()))); }
        // Anchor, quote and block snapshots from the target's prose.
        let mut anchor = None;
        let mut quote = None;
        let mut snapshots = Vec::new();
        let region = match &input.region {
            None => None,
            Some(r) => {
                let t = input.target.as_ref().ok_or_else(|| WsError::invalid("a region needs a target"))?;
                if input.range.is_some() { return Err(WsError::invalid("a comment has a range or a region, not both")); }
                let file = (t.kind == "material")
                    .then(|| materials(&slot).iter().find(|m| m.id.as_str() == t.id).map(|m| m.kind.needs_asset()))
                    .flatten();
                if file != Some(true) { return Err(WsError::invalid("a region is on an image or PDF material")); }
                Some(r.to_model().ok_or_else(|| WsError::invalid("the region does not fit its picture or page"))?)
            }
        };
        if let Some((start, end)) = input.range {
            let t = input.target.as_ref().ok_or_else(|| WsError::invalid("a range needs a target"))?;
            let doc = prose_of(t).ok_or_else(|| WsError::invalid(format!("{} has no prose", t.kind)))?;
            let ps = cx.prose(&doc)?;
            let view = cx.prose_view(&ps);
            if start >= end || end > view.len().saturating_sub(1) {
                return Err(WsError::invalid(format!("range {start}..{end} does not fit the text")));
            }
            anchor = Some(view.anchor(start..end).ok_or_else(|| WsError::invalid("cannot anchor that range"))?);
            quote = Some(view.text_in(start..end)?);
            for p in view.paragraphs() {
                if p.newline >= start && p.range.start < end {
                    snapshots.push(BlockSnapshot { block: p.id.clone(), text: p.text() });
                }
            }
        }
        let id = CommentId::new_v7();
        let agent = matches!(cx.actor(), crate::Actor::Agent { .. });
        let (i2, body, an) = (id.clone(), input.body.clone(), input.author_name.clone());
        cx.write_book(&slot, move |txn| {
            let w = txn.comment(&i2)?;
            w.kind(&kind)?.target(target.as_ref())?.target_block(block.as_ref())?.anchor(anchor.as_ref())?
                .quote(quote.as_deref())?.body(&body)?.status(&CommentStatus::Open)?.priority(priority.as_ref())?
                .author_kind(if agent { &CommentAuthorKind::Ai } else { &CommentAuthorKind::User })?
                .author_name(an.as_deref())?
                .source(if agent { &CommentSource::Api } else { &CommentSource::Manual })?
                .created_at(Some(now()))?.updated_at(Some(now()))?;
            if !snapshots.is_empty() { w.snapshots(&snapshots)?; }
            if region.is_some() { w.region(region.as_ref())?; }
            Ok(())
        })?;
        cx.effect(EffectAction::Created, "comment", id.as_str(), None);
        cx.undo_with(Invocation::new("comment.delete", EntityIn { book: input.book, id: id.to_string() }));
        Ok(Done { id: id.to_string() })
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct CommentUpdateIn {
    pub book: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// `open` or `resolved`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub priority: Option<Option<String>>,
    /// `note` or `todo`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// The Agent conversation started from this TODO.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub agent_conversation: Option<Option<String>>,
}

op! {
    CommentUpdate = "comment.update", Write, Book,
    "Change a comment or TODO: its text, status (resolve / reopen), priority, kind or linked Agent conversation.",
    fn(cx, input: CommentUpdateIn) -> Done {
        let slot = cx.book(&input.book)?;
        let old = comments(&slot).iter().find(|c| c.id.as_str() == input.id).cloned()
            .ok_or_else(|| WsError::not_found("comment", &input.id))?;
        let status = input.status.as_deref().map(CommentStatus::parse);
        if let Some(s) = &status && !s.is_known() { return Err(WsError::invalid(format!("unknown status {:?}", s.as_str()))); }
        let kind = input.kind.as_deref().map(CommentKind::parse);
        if let Some(k) = &kind && !k.is_known() { return Err(WsError::invalid(format!("unknown kind {:?}", k.as_str()))); }
        let priority: Option<Option<CommentPriority>> = input.priority.as_ref().map(|p| p.as_deref().map(CommentPriority::parse));
        if let Some(Some(p)) = &priority && !p.is_known() { return Err(WsError::invalid(format!("unknown priority {:?}", p.as_str()))); }
        let (id, i) = (old.id.clone(), input.clone());
        cx.write_book(&slot, move |txn| {
            let w = txn.comment(&id)?;
            if let Some(b) = &i.body { w.body(b)?; }
            if let Some(s) = &status {
                w.status(s)?.resolved_at((*s == CommentStatus::Resolved).then(now))?;
            }
            if let Some(k) = &kind { w.kind(k)?; }
            if let Some(p) = &priority { w.priority(p.as_ref())?; }
            if let Some(a) = &i.agent_conversation { w.agent_conversation(a.as_deref())?; }
            w.updated_at(Some(now()))?;
            Ok(())
        })?;
        cx.effect(EffectAction::Updated, "comment", &input.id, None);
        cx.undo_with(Invocation::new("comment.update", CommentUpdateIn {
            book: input.book.clone(), id: input.id.clone(),
            body: input.body.as_ref().map(|_| old.body.clone()),
            status: input.status.as_ref().map(|_| old.status.as_str().to_string()),
            priority: input.priority.as_ref().map(|_| old.priority.as_ref().map(|p| p.as_str().to_string())),
            kind: input.kind.as_ref().map(|_| old.kind.as_str().to_string()),
            agent_conversation: input.agent_conversation.as_ref().map(|_| old.agent_conversation.clone()),
        }));
        Ok(Done { id: input.id })
    }
}

op! {
    CommentDelete = "comment.delete", Write, Book,
    "Delete a comment or TODO (its relations go with it).",
    fn(cx, input: EntityIn) -> Done {
        let slot = cx.book(&input.book)?;
        let id: CommentId = pid("comment", &input.id)?;
        if !comments(&slot).iter().any(|c| c.id == id) { return Err(WsError::not_found("comment", &input.id)); }
        let target = dr_model::book::EntityRef::new(EntityKind::Comment, input.id.clone());
        let (rels, _) = purge_fallout(&slot, &target);
        let mut touched: Vec<(String, String)> = vec![("comments".into(), input.id.clone())];
        touched.extend(rels.iter().map(|r| ("relations".to_string(), r.to_string())));
        let (i2, r2) = (id.clone(), rels.clone());
        let (_, before) = cx.write_book(&slot, move |txn| {
            for r in &r2 { txn.purge(Collection::Relations, r.as_str())?; }
            txn.purge(Collection::Comments, i2.as_str())?;
            Ok(())
        })?;
        for r in &rels { cx.effect(EffectAction::Purged, "relation", r.as_str(), None); }
        cx.effect(EffectAction::Purged, "comment", &input.id, None);
        cx.undo_with(super::history::restore_invocation(&input.book, &before, touched));
        Ok(Done { id: input.id })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct CommentAnchorsIn {
    pub book: String,
    /// The entity whose prose the anchors are in.
    pub target: Target,
}

op! {
    CommentAnchors = "comment.anchors", Read, Shared,
    "The stored anchors of the comments on one entity's prose, for an editor laying them out (comments without an anchor are not listed).",
    fn(cx, input: CommentAnchorsIn) -> Vec<CommentAnchor> {
        let slot = cx.book(&input.book)?;
        let t = input.target.to_ref();
        Ok(comments(&slot).iter()
            .filter(|c| c.target.as_ref() == Some(&t))
            .filter_map(|c| Some(CommentAnchor {
                id: c.id.to_string(),
                kind: c.kind.as_str().to_string(),
                status: c.status.as_str().to_string(),
                anchor: AnchorBytes::from(c.anchor.as_ref()?),
            }))
            .collect())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct CommentReanchorIn {
    pub book: String,
    pub id: String,
    /// The anchor as the editor holds it (dr-doc's encoding, base64);
    /// `null` removes the anchor (the comment stays on its paragraph or
    /// entity).
    #[serde(deserialize_with = "crate::commands::double_option")]
    #[schemars(with = "AnchorOrNull")]
    pub anchor: Option<Option<AnchorBytes>>,
}

/// The schema of a field that must be given and may be `null` (schemars
/// makes every `Option` optional).
struct AnchorOrNull;

impl JsonSchema for AnchorOrNull {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "AnchorOrNull".into()
    }
    fn inline_schema() -> bool {
        true
    }
    fn json_schema(g: &mut schemars::SchemaGenerator) -> schemars::Schema {
        g.subschema_for::<Option<AnchorBytes>>()
    }
}

/// The anchor `bytes` decoded, refused unless both cursors point into the
/// prose body of `doc` (a character this device has seen, or an empty
/// body).
pub(crate) fn anchor_in(cx: &Cx<'_>, doc: &DocId, bytes: &AnchorBytes) -> Result<Anchor> {
    let a = decode_anchor(bytes)?;
    anchor_known(&*cx.prose_passing(doc)?, doc, &a)?;
    Ok(a)
}

/// `bytes` as dr-doc's anchor: two cursors in a prose body.
pub(crate) fn decode_anchor(bytes: &AnchorBytes) -> Result<Anchor> {
    let bad = || WsError::invalid("the anchor is not two cursors of dr-doc's encoding");
    let a = Anchor::decode(&bytes.bytes().ok_or_else(bad)?).ok_or_else(bad)?;
    let body = loro::ContainerID::new_root(dr_doc::schema::prose::BODY, loro::ContainerType::Text);
    for c in [&a.start, &a.end] {
        if c.container != body {
            return Err(WsError::invalid("the anchor is not in a prose body"));
        }
    }
    Ok(a)
}

/// Whether `a`'s cursors are of `doc` (open in `ps`) as far as it knows.
pub(crate) fn anchor_known(
    ps: &crate::workspace::ProseSlot,
    doc: &DocId,
    a: &Anchor,
) -> Result<()> {
    anchor_known_in(&ps.handle.doc().with_doc(|d| d.oplog_vv()), doc, a)
}

/// Whether `a`'s cursors are within version `vv` of `doc`.
pub(crate) fn anchor_known_in(vv: &loro::VersionVector, doc: &DocId, a: &Anchor) -> Result<()> {
    for c in [&a.start, &a.end] {
        if let Some(id) = c.id
            && !vv.includes_id(id)
        {
            return Err(WsError::invalid(format!("the anchor is not in {doc}")));
        }
    }
    Ok(())
}

op! {
    CommentReanchor = "comment.reanchor", Write, Book,
    "Put a comment's anchor back where the editor's undo brought its text back (the author's change, synced; it follows the editor's undo, so it is not an entry of the object-level undo).",
    fn(cx, input: CommentReanchorIn) -> Done {
        let slot = cx.book(&input.book)?;
        let old = comments(&slot).iter().find(|c| c.id.as_str() == input.id).cloned()
            .ok_or_else(|| WsError::not_found("comment", &input.id))?;
        let want = input.anchor.clone()
            .ok_or_else(|| WsError::invalid("anchor is required (null removes it)"))?;
        let anchor = match &want {
            None => None,
            Some(bytes) => {
                let t = old.target.as_ref().map(Target::from)
                    .ok_or_else(|| WsError::invalid("a floating comment has no prose to anchor in"))?;
                let doc = prose_of(&t).ok_or_else(|| WsError::invalid(format!("{} has no prose", t.kind)))?;
                Some(anchor_in(cx, &doc, bytes)?)
            }
        };
        let back = old.anchor.as_ref().map(AnchorBytes::from);
        cx.follows_prose();
        if back == want {
            cx.undo_nothing();
            return Ok(Done { id: input.id });
        }
        let id = old.id.clone();
        cx.write_book(&slot, move |txn| {
            txn.comment(&id)?.anchor(anchor.as_ref())?;
            Ok(())
        })?;
        cx.effect(EffectAction::Updated, "comment", &input.id, None);
        cx.undo_with(Invocation::new("comment.reanchor", CommentReanchorIn {
            book: input.book.clone(), id: input.id.clone(), anchor: Some(back),
        }));
        Ok(Done { id: input.id })
    }
}

// ---- TODO markers ---------------------------------------------------------

/// The body a marker with no task text gets (the old client's).
pub const EMPTY_MARKER_TASK: &str = "（此处待办）";

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct TodoMarkerIn {
    /// The paragraph's block id.
    pub block: String,
    /// The task text after the marker.
    #[serde(default)]
    pub task: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct TodoProjectIn {
    /// The prose document (`node:<id>`, `element:<id>`, `storyline:<id>`,
    /// `category:<id>`).
    pub doc: String,
    /// Every paragraph of the document that now starts with a TODO marker.
    pub markers: Vec<TodoMarkerIn>,
    /// The paragraph the author is typing in: its marker gets no TODO until
    /// they leave it. A TODO it already has stays while its marker does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub editing: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct TodoProjected {
    /// TODOs made for new markers.
    pub created: Vec<String>,
    /// Open TODOs whose marker or paragraph is gone, deleted.
    pub removed: Vec<String>,
    /// Open TODOs whose marker is missing here, kept because this device
    /// has not yet received the prose they were made from (sync brings the
    /// book and the prose separately).
    pub waiting: Vec<String>,
}

/// What a projected TODO keeps in its metadata: the version of the prose
/// it was made from (peer → operations seen), so another device deletes it
/// only once it has that prose too. (Round six also kept the seeded text,
/// to put back a body two devices had both seeded; dr-doc's seed change,
/// `BookTxn::project_todo`, makes that impossible, and a stored `seed` is
/// ignored.)
#[derive(Default, Serialize, Deserialize)]
struct ProjectionMeta {
    #[serde(default)]
    kind: String,
    #[serde(default)]
    prose_vv: BTreeMap<String, i64>,
}

const MARKER_META_KIND: &str = "todo-autoparse";

fn owner_of(doc: &DocId) -> Option<EntityRef> {
    let kind = match doc {
        DocId::Node(_) => EntityKind::Node,
        DocId::Element(_) => EntityKind::Element,
        DocId::Storyline(_) => EntityKind::Storyline,
        DocId::Category(_) => EntityKind::Category,
        DocId::Book(_) | DocId::Material(_) | DocId::Template(_) | DocId::Conversation(_) => {
            return None;
        }
    };
    Some(EntityRef::new(kind, doc.entity_id()))
}

/// Whether `vv` has seen everything `meta` names.
fn has_seen(vv: &loro::VersionVector, meta: Option<&str>) -> bool {
    let Some(m) = meta.and_then(|m| serde_json::from_str::<ProjectionMeta>(m).ok()) else {
        return true;
    };
    m.prose_vv.iter().all(|(peer, end)| {
        peer.parse::<u64>()
            .is_ok_and(|p| i64::from(vv.get(&p).copied().unwrap_or(0)) >= *end)
    })
}

op! {
    TodoProject = "todo.project", Write, Book,
    "Keep the TODOs typed as markers in one prose document (a paragraph starting with TODO or 待办) in step with it: a new marker gets a TODO, an open TODO whose marker is gone is deleted, resolved ones stay; the same marker makes the same TODO on every device.",
    fn(cx, input: TodoProjectIn) -> TodoProjected {
        let doc = DocId::parse(&input.doc).map_err(|e| WsError::invalid(format!("{:?}: {e}", input.doc)))?;
        let owner = owner_of(&doc).ok_or_else(|| WsError::invalid(format!(
            "{} has no TODO markers (chapters, ideas, elements, storylines and categories do)", input.doc)))?;
        let ps = cx.prose(&doc)?;
        let book = ps.book.clone().ok_or_else(|| WsError::invalid(format!("{} belongs to no book", input.doc)))?;
        let slot = cx.book(book.as_str())?;
        require_live(&slot, owner.kind.clone(), &owner.id)?;
        // The input, deduplicated (the first marker of a block wins).
        let mut markers: Vec<(BlockId, String)> = Vec::new();
        for m in &input.markers {
            let b: BlockId = pid("block", &m.block)?;
            if !markers.iter().any(|(x, _)| x == &b) {
                markers.push((b, m.task.trim().to_string()));
            }
        }
        let editing = input.editing.as_deref().map(|b| pid::<BlockId>("block", b)).transpose()?;
        // The document now: its blocks and its version.
        let view = cx.prose_view(&ps);
        let blocks: HashSet<BlockId> = view.blocks().into_iter().filter_map(|b| b.id).collect();
        let vv = ps.handle.doc().with_doc(|d| d.oplog_vv());
        // The TODOs projected from this document, by block.
        let existing: BTreeMap<BlockId, Comment> = comments(&slot).iter()
            .filter(|c| c.target.as_ref() == Some(&owner))
            .filter_map(|c| {
                let p = c.projection.as_ref().filter(|p| p.kind == ProjectionKind::Marker)?;
                Some((p.block.clone(), c.clone()))
            })
            .collect();
        let mut out = TodoProjected::default();
        let mut create: Vec<(BlockId, String)> = Vec::new();
        for (b, task) in &markers {
            if existing.contains_key(b) || editing.as_ref() == Some(b) || !blocks.contains(b) {
                continue;
            }
            let body = if task.is_empty() { EMPTY_MARKER_TASK.to_string() } else { task.clone() };
            create.push((b.clone(), body));
        }
        let mut remove: Vec<CommentId> = Vec::new();
        for (b, c) in &existing {
            if c.status != CommentStatus::Open || markers.iter().any(|(x, _)| x == b) {
                continue;
            }
            if has_seen(&vv, c.metadata.as_deref()) {
                remove.push(c.id.clone());
            } else {
                out.waiting.push(c.id.to_string());
            }
        }
        cx.follows_prose();
        if create.is_empty() && remove.is_empty() {
            cx.undo_nothing();
            return Ok(out);
        }
        let mut rels = Vec::new();
        for id in &remove {
            let target = EntityRef::new(EntityKind::Comment, id.as_str());
            rels.extend(purge_fallout(&slot, &target).0);
        }
        let prose_vv: BTreeMap<String, i64> =
            vv.iter().map(|(p, c)| (p.to_string(), i64::from(*c))).collect();
        let meta = serde_json::to_string(&ProjectionMeta {
            kind: MARKER_META_KIND.to_string(),
            prose_vv,
        }).map_err(|e| WsError::Internal(e.to_string()))?;
        let agent = matches!(cx.actor(), crate::Actor::Agent { .. });
        let (d2, c2, r2, rm2) = (doc.clone(), create.clone(), rels.clone(), remove.clone());
        let created = cx.write_book(&slot, move |txn| {
            let mut ids = Vec::new();
            // dr-doc's seed change writes kind, target, block, the task as
            // the body and the status, the same on every device; only the
            // rest is ordinary writes. (The holder set this write's commit
            // options before it ran, so the seed's import barrier commits
            // nothing without an origin; see `crate::holder`.)
            for (b, task) in &c2 {
                let (id, w) = txn.project_todo(&ProjectionKind::Marker, &d2, b, task)?;
                w.author_kind(if agent { &CommentAuthorKind::Ai } else { &CommentAuthorKind::User })?
                    .source(if agent { &CommentSource::Api } else { &CommentSource::Manual })?
                    .metadata(Some(&meta))?
                    .created_at(Some(now()))?.updated_at(Some(now()))?;
                ids.push(id);
            }
            for r in &r2 { txn.purge(Collection::Relations, r.as_str())?; }
            for c in &rm2 { txn.purge(Collection::Comments, c.as_str())?; }
            Ok(ids)
        })?.0;
        for id in &created {
            cx.effect(EffectAction::Created, "comment", id.as_str(), None);
            out.created.push(id.to_string());
        }
        for r in &rels { cx.effect(EffectAction::Purged, "relation", r.as_str(), None); }
        for id in &remove {
            cx.effect(EffectAction::Purged, "comment", id.as_str(), None);
            out.removed.push(id.to_string());
        }
        Ok(out)
    }
}
