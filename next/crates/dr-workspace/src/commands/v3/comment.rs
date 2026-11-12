//! Comments on v3 entries and their selected prose modules, or materials.
//! Typed v2.2 inputs remain in `commands::comment`; named calls dispatch by book version.
use super::*;
pub use crate::commands::comment_shared::{
    CommentReanchorIn, CommentUpdateIn, EMPTY_MARKER_TASK, TodoMarkerIn, TodoProjected,
};
use crate::commands::comment_shared::{
    MARKER_META_KIND, ProjectionMeta, anchor_known_in, decode_anchor, has_seen,
};
use crate::commands::{materials, purge_fallout};
use crate::dto::{AnchorBytes, CommentAnchor, Region};
use dr_doc::prose::BorrowedProse;
use dr_model::DocId;
use dr_model::kind::{
    CommentAuthorKind, CommentKind, CommentPriority, CommentSource, CommentStatus, EntityKind,
    ProjectionKind,
};
use dr_model::shared::{BlockSnapshot, EntityRef};
use dr_model::v3::CommentV3 as Comment;
use std::collections::HashSet;

fn comments(slot: &BookSlot) -> Vec<Comment> {
    slot.reader_v3.view().comments()
}
fn require_live(slot: &BookSlot, kind: EntityKind, id: &str) -> Result<()> {
    if !matches!(kind, EntityKind::Entry | EntityKind::Material)
        || !slot
            .reader_v3
            .view()
            .entity_exists(&EntityRef::new(kind, id))
    {
        return Err(WsError::not_found("comment target", id));
    }
    Ok(())
}
fn prose_of(cx: &Cx<'_>, slot: &BookSlot, target: &Target, module: Option<&str>) -> Result<DocId> {
    require_live(slot, EntityKind::from(target.kind.as_str()), &target.id)?;
    if target.kind == "entry" {
        let module =
            module.ok_or_else(|| WsError::invalid("an entry prose target requires a module"))?;
        Ok(super::module::document(
            cx,
            &super::module::ProseIn {
                book: slot.book.to_string(),
                owner: target.id.clone(),
                module: module.into(),
                template: false,
            },
        )?
        .1)
    } else if module.is_none()
        && materials(slot)
            .iter()
            .any(|m| m.id.as_str() == target.id && m.kind == dr_model::kind::MaterialKind::Text)
    {
        let doc = DocId::Material(pid("material", &target.id)?);
        owns(cx, slot, &doc)?;
        Ok(doc)
    } else {
        Err(WsError::invalid(
            "only text material has prose; materials have no module",
        ))
    }
}
fn target_module(
    cx: &Cx<'_>,
    slot: &BookSlot,
    target: Option<&Target>,
    module: Option<&str>,
    needs_prose: bool,
) -> Result<Option<ModuleId>> {
    if let Some(t) = target {
        require_live(slot, EntityKind::from(t.kind.as_str()), &t.id)?;
    }
    if module.is_some() || needs_prose {
        prose_of(
            cx,
            slot,
            target.ok_or_else(|| WsError::invalid("a prose target is required"))?,
            module,
        )?;
    }
    module.map(|m| pid("module", m)).transpose()
}

/// A comment target. Old structural kinds are not accepted.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "CommentTargetV3")]
pub struct Target {
    /// `entry` or `material`.
    pub kind: String,
    pub id: String,
}
impl Target {
    pub fn to_ref(&self) -> EntityRef {
        EntityRef::new(EntityKind::from(self.kind.as_str()), self.id.clone())
    }
}
impl From<&EntityRef> for Target {
    fn from(t: &EntityRef) -> Self {
        Self {
            kind: t.kind.as_str().into(),
            id: t.id.clone(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "TodoProjectInV3")]
pub struct TodoProjectIn {
    /// `body:<entry>/<module>` or `material:<id>` of a book.
    pub doc: String,
    pub markers: Vec<crate::commands::comment_shared::TodoMarkerIn>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub editing: Option<String>,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
#[schemars(rename = "CommentInfoV3")]
pub struct CommentInfo {
    pub id: String,
    /// The entry prose module; null for whole-entry, material or floating comments.
    pub module: Option<String>,
    /// `note` or `todo`.
    pub kind: String,
    pub target: Option<Target>,
    /// The target is in the trash or gone: show as unlocated.
    pub unlocated: bool,
    pub target_block: Option<String>,
    pub anchored: bool,
    pub quote: Option<String>,
    pub body: String,
    /// `open` or `resolved`.
    pub status: String,
    pub priority: Option<String>,
    /// `user`, `ai` or `external`.
    pub author_kind: String,
    pub author_name: Option<String>,
    /// `manual` or `api`.
    pub source: String,
    pub agent_conversation: Option<String>,
    /// Generated from prose (`marker` or `note_task`).
    pub projection: Option<String>,
    /// The rectangle it marks on an image or a PDF page.
    pub region: Option<Region>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
}
impl From<&Comment> for CommentInfo {
    fn from(c: &Comment) -> Self {
        Self {
            module: c.target_module.as_ref().map(ToString::to_string),
            id: c.id.to_string(),
            kind: c.kind.as_str().into(),
            target: c.target.as_ref().map(Target::from),
            unlocated: c.target_missing,
            target_block: c.target_block.as_ref().map(ToString::to_string),
            anchored: c.anchor.is_some(),
            quote: c.quote.clone(),
            body: c.body.clone(),
            status: c.status.as_str().into(),
            priority: c.priority.as_ref().map(|p| p.as_str().into()),
            author_kind: c.author_kind.as_str().into(),
            author_name: c.author_name.clone(),
            source: c.source.as_str().into(),
            agent_conversation: c.agent_conversation.clone(),
            projection: c.projection.as_ref().map(|p| p.kind.as_str().into()),
            region: c.region.as_ref().map(Region::from),
            created_at: c.created_at.map(|t| t.0),
            updated_at: c.updated_at.map(|t| t.0),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "CommentListInV3")]
pub struct CommentListIn {
    pub book: String,
    /// The entry's prose module (required for ranges, blocks and anchors); omit for a material.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub module: Option<String>,
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

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "CommentCreateInV3")]
pub struct CommentCreateIn {
    pub book: String,
    /// The entry's prose module (required for ranges, blocks and anchors); omit for a material.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub module: Option<String>,
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
    /// Stable cursors captured in the selected prose; mutually exclusive with range and region.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor: Option<AnchorBytes>,
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

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "CommentAnchorsInV3")]
pub struct CommentAnchorsIn {
    pub book: String,
    /// The entry's prose module (required for ranges, blocks and anchors); omit for a material.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub module: Option<String>,
    /// The entity whose prose the anchors are in.
    pub target: Target,
}

op! {
    CommentList = "comment.list", Read, Shared,
    "List comments and TODOs (a target in the trash or gone shows as unlocated).",
    fn(cx, input: CommentListIn) -> Vec<CommentInfo> {
        let slot = cx.book_v3(&input.book)?;
        if input.module.is_some() && input.target.as_ref().is_none_or(|t| t.kind != "entry") {
            return Err(WsError::invalid("module filtering requires an entry target"));
        }
        let module = input.module.as_deref().map(|id| pid::<ModuleId>("module", id)).transpose()?;
        let t = input.target.as_ref().map(Target::to_ref);
        Ok(comments(&slot).iter()
            .filter(|c| input.kind.as_ref().is_none_or(|k| c.kind.as_str() == k))
            .filter(|c| input.status.as_ref().is_none_or(|s| c.status.as_str() == s))
            .filter(|c| t.as_ref().is_none_or(|t| c.target.as_ref() == Some(t)))
            .filter(|c| module.as_ref().is_none_or(|m| c.target_module.as_ref() == Some(m)))
            .map(CommentInfo::from).collect())
    }
}

op! {
    CommentCreate = "comment.create", Write, Book,
    "Add a comment or TODO, on an entity, a paragraph, a passage of its prose, a region of an image or PDF, or floating.",
    fn(cx, input: CommentCreateIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let kind = CommentKind::parse(input.kind.as_deref().unwrap_or("note"));
        if input.range.is_some() && input.anchor.is_some() {
            return Err(WsError::invalid("a comment has a range or an anchor, not both"));
        }
        if !kind.is_known() { return Err(WsError::invalid(format!("unknown comment kind {:?}", kind.as_str()))); }
        let target = input.target.as_ref().map(Target::to_ref);
        let block = input.block_id.as_deref().map(|b| pid::<BlockId>("block", b)).transpose()?;
        let module = target_module(cx, &slot, input.target.as_ref(), input.module.as_deref(), block.is_some() || input.range.is_some() || input.anchor.is_some())?;
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
                if input.anchor.is_some() { return Err(WsError::invalid("a comment has an anchor or a region, not both")); }
                let file = (t.kind == "material")
                    .then(|| materials(&slot).iter().find(|m| m.id.as_str() == t.id).map(|m| m.kind.needs_asset()))
                    .flatten();
                if file != Some(true) { return Err(WsError::invalid("a region is on an image or PDF material")); }
                Some(r.to_model().ok_or_else(|| WsError::invalid("the region does not fit its picture or page"))?)
            }
        };
        if let Some((start, end)) = input.range {
            let t = input.target.as_ref().ok_or_else(|| WsError::invalid("a range needs a target"))?;
            let doc = prose_of(cx, &slot, t, input.module.as_deref())?;
            let ps = cx.prose(&doc)?;
            let target_block = block.clone();
            (anchor, quote, snapshots) = cx.read_prose_source(&ps, move |source| {
                let prose = BorrowedProse::new(source, &doc)?;
                let view = prose.view();
                if start >= end || end > view.len().saturating_sub(1) {
                    return Err(WsError::invalid(format!("range {start}..{end} does not fit the text")));
                }
                if let Some(block) = target_block
                    && !view.blocks().iter().any(|b| b.id.as_ref() == Some(&block)) {
                    return Err(WsError::not_found("block in target prose", block.as_str()));
                }
                let anchor = view.anchor(start..end).ok_or_else(|| WsError::invalid("cannot anchor that range"))?;
                let quote = view.text_in(start..end)?;
                let snapshots = view.paragraphs()
                    .filter(|p| p.newline >= start && p.range.start < end)
                    .map(|p| BlockSnapshot { block: p.id.clone(), text: p.text() }).collect();
                Ok((Some(anchor), Some(quote), snapshots))
            })?;
        }
        if let Some(bytes) = &input.anchor {
            let t = input.target.as_ref().ok_or_else(|| WsError::invalid("an anchor needs a target"))?;
            let doc = prose_of(cx, &slot, t, input.module.as_deref())?;
            let ps = cx.prose(&doc)?;
            let bytes = bytes.clone();
            // Decode, resolve, quote and snapshot under one holder read. A
            // partial deletion may update the cursors but is still valid.
            let (stored, text, blocks) = cx.read_prose_source(&ps, move |state| -> Result<_> {
                let a = decode_anchor(&bytes)?;
                anchor_known_in(&state.oplog_vv(), &doc, &a)?;
                let prose = dr_doc::prose::BorrowedProse::new(state, &doc)?;
                let view = prose.view();
                let resolved = view.resolve(&a).ok_or_else(|| WsError::invalid("anchor cannot be resolved"))?;
                let range = resolved.range;
                if resolved.collapsed || range.is_empty() || range.end > view.len().saturating_sub(1) {
                    return Err(WsError::invalid("the selected text was deleted"));
                }
                let text = view.text_in(range.clone())?;
                let blocks: Vec<_> = view.paragraphs()
                    .filter(|p| p.newline >= range.start && p.range.start < range.end)
                    .map(|p| BlockSnapshot { block: p.id.clone(), text: p.text() }).collect();
                Ok((a, text, blocks))
            })?;
            anchor = Some(stored);
            quote = Some(text);
            snapshots = blocks;
        }
        if input.range.is_none() && let Some(block) = &block {
            let doc = prose_of(cx, &slot, input.target.as_ref().expect("target validated"), input.module.as_deref())?;
            let ps = cx.prose(&doc)?;
            let block = block.clone();
            cx.read_prose_source(&ps, move |source| {
                if !BorrowedProse::new(source, &doc)?.view().blocks().iter().any(|b| b.id.as_ref() == Some(&block)) {
                    return Err(WsError::not_found("block in target prose", block.as_str()));
                }
                Ok(())
            })?;
        }
        let id = CommentId::new_v7();
        let agent = matches!(cx.actor(), crate::Actor::Agent { .. });
        let (i2, body, an) = (id.clone(), input.body.clone(), input.author_name.clone());
        cx.write_book_v3(&slot, Replaces::nothing(), move |txn| {
            let w = txn.comment(&i2)?;
            w.kind(&kind)?.target(target.as_ref())?.module(module.as_ref())?.target_block(block.as_ref())?.anchor(anchor.as_ref())?
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

op! {
    CommentUpdate = "comment.update", Write, Book,
    "Change a comment or TODO: its text, status (resolve / reopen), priority, kind or linked Agent conversation.",
    fn(cx, input: CommentUpdateIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let old = comments(&slot).iter().find(|c| c.id.as_str() == input.id).cloned()
            .ok_or_else(|| WsError::not_found("comment", &input.id))?;
        let status = input.status.as_deref().map(CommentStatus::parse);
        if let Some(s) = &status && !s.is_known() { return Err(WsError::invalid(format!("unknown status {:?}", s.as_str()))); }
        let kind = input.kind.as_deref().map(CommentKind::parse);
        if let Some(k) = &kind && !k.is_known() { return Err(WsError::invalid(format!("unknown kind {:?}", k.as_str()))); }
        let priority: Option<Option<CommentPriority>> = input.priority.as_ref().map(|p| p.as_deref().map(CommentPriority::parse));
        if let Some(Some(p)) = &priority && !p.is_known() { return Err(WsError::invalid(format!("unknown priority {:?}", p.as_str()))); }
        let (id, i) = (old.id.clone(), input.clone());
        cx.write_book_v3(&slot, Replaces::record(CollectionV3::Comments, &id), move |txn| {
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
        let slot = cx.book_v3(&input.book)?;
        let id: CommentId = pid("comment", &input.id)?;
        if !comments(&slot).iter().any(|c| c.id == id) { return Err(WsError::not_found("comment", &input.id)); }
        let target = dr_model::shared::EntityRef::new(EntityKind::Comment, input.id.clone());
        let (rels, _) = purge_fallout(&slot, &target);
        let mut touched: Vec<(String, String)> = vec![("comments".into(), input.id.clone())];
        touched.extend(rels.iter().map(|r| ("relations".to_string(), r.to_string())));
        let (i2, r2) = (id.clone(), rels.clone());
        let (_, before) = cx.write_book_v3(&slot, Replaces::record(CollectionV3::Comments, &id), move |txn| {
            for r in &r2 { txn.purge(CollectionV3::Relations, r.as_str())?; }
            txn.purge(CollectionV3::Comments, i2.as_str())?;
            Ok(())
        })?;
        for r in &rels { cx.effect(EffectAction::Purged, "relation", r.as_str(), None); }
        cx.effect(EffectAction::Purged, "comment", &input.id, None);
        undo(cx, &slot, &before, touched.into_iter().map(|(collection,id)| history::Key { collection,id }).collect());
        Ok(Done { id: input.id })
    }
}

op! {
    CommentAnchors = "comment.anchors", Read, Shared,
    "The stored anchors of the comments on one entity's prose, for an editor laying them out (comments without an anchor are not listed).",
    fn(cx, input: CommentAnchorsIn) -> Vec<CommentAnchor> {
        let slot = cx.book_v3(&input.book)?;
        let module = target_module(cx, &slot, Some(&input.target), input.module.as_deref(), true)?;
        let t = input.target.to_ref();
        Ok(comments(&slot).iter()
            .filter(|c| c.target.as_ref() == Some(&t) && c.target_module == module)
            .filter_map(|c| Some(CommentAnchor {
                id: c.id.to_string(),
                kind: c.kind.as_str().to_string(),
                status: c.status.as_str().to_string(),
                anchor: AnchorBytes::from(c.anchor.as_ref()?),
            }))
            .collect())
    }
}

op! {
    CommentReanchor = "comment.reanchor", Write, Book,
    "Put a comment's anchor back where the editor's undo brought its text back (the author's change, synced; it follows the editor's undo, so it is not an entry of the object-level undo).",
    fn(cx, input: CommentReanchorIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let old = comments(&slot).iter().find(|c| c.id.as_str() == input.id).cloned()
            .ok_or_else(|| WsError::not_found("comment", &input.id))?;
        let want = input.anchor.clone()
            .ok_or_else(|| WsError::invalid("anchor is required (null removes it)"))?;
        let anchor = match &want {
            None => None,
            Some(bytes) => {
                let t = old.target.as_ref().map(Target::from)
                    .ok_or_else(|| WsError::invalid("a floating comment has no prose to anchor in"))?;
                let doc = prose_of(cx, &slot, &t, old.target_module.as_ref().map(|m| m.as_str()))?;
                let ps = cx.prose(&doc)?;
                let bytes = bytes.clone();
                Some(cx.read_prose_source(&ps, move |source| {
                    let anchor = decode_anchor(&bytes)?;
                    anchor_known_in(&source.oplog_vv(), &doc, &anchor)?;
                    Ok(anchor)
                })?)
            }
        };
        let back = old.anchor.as_ref().map(AnchorBytes::from);
        cx.follows_prose();
        if back == want {
            cx.undo_nothing();
            return Ok(Done { id: input.id });
        }
        let id = old.id.clone();
        let replaced = rec(CollectionV3::Comments, &id).at(["anchor"]);
        cx.write_book_v3(&slot, Replaces::records([replaced]), move |txn| {
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

op! {
    TodoProject = "todo.project", Write, Book,
    "Keep the TODOs typed as markers in one prose document (a paragraph starting with TODO or 待办) in step with it: a new marker gets a TODO, an open TODO whose marker is gone is deleted, resolved ones stay; the same marker makes the same TODO on every device.",
    fn(cx, input: TodoProjectIn) -> TodoProjected {
        let doc = DocId::parse(&input.doc).map_err(|e| WsError::invalid(format!("{:?}: {e}", input.doc)))?;
        let (owner, module) = match &doc {
            DocId::Body(b) => (EntityRef::new(EntityKind::Entry, b.entry().as_str()), Some(b.module().clone())),
            DocId::Material(id) => (EntityRef::new(EntityKind::Material, id.as_str()), None),
            _ => return Err(WsError::invalid("TODO markers require entry prose or a material note")),
        };
        let ps = cx.prose(&doc)?;
        let book = ps.book.clone().ok_or_else(|| WsError::invalid(format!("{} belongs to no book", input.doc)))?;
        let slot = cx.book_v3(book.as_str())?;
        prose_of(cx, &slot, &Target::from(&owner), module.as_ref().map(|m| m.as_str()))?;
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
            .filter(|c| c.target.as_ref() == Some(&owner) && c.target_module == module)
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
        // Projected from the prose it follows, under ids derived from it.
        let created = cx.write_book_v3(&slot, Replaces::nothing(), move |txn| {
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
            for r in &r2 { txn.purge(CollectionV3::Relations, r.as_str())?; }
            for c in &rm2 { txn.purge(CollectionV3::Comments, c.as_str())?; }
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
