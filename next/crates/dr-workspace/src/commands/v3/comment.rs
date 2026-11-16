//! Comments on v5 entries, any of their modules, or module sub-parts (`part`).
//! Typed inputs live here; `commands::comment` re-exports them.
use super::*;
pub use crate::commands::comment_shared::{
    CommentProjected, CommentReanchorIn, CommentTaskIn, CommentUpdateIn, EMPTY_MARKER_TASK,
    TodoMarkerIn,
};
use crate::commands::comment_shared::{
    MARKER_META_KIND, ProjectionMeta, TASK_META_KIND, anchor_known_in, decode_anchor, has_seen,
};
use crate::dto::{AnchorBytes, CommentAnchor, CommentPartDto, LinkedTextIn, Region};
use dr_doc::prose::{BorrowedProse, EmbedView};
use dr_model::DocId;
use dr_model::id::{BodyDocId, EmbedId};
use dr_model::kind::{
    CommentAuthorKind, CommentOrigin, CommentSource, CommentStatus, EntityKind, ProjectionKind,
};
use dr_model::shared::{BlockSnapshot, EntityRef};
use dr_model::v3::{
    CommentPart, CommentV3 as Comment, EntityLinkV3, EntryTextLink, LinkedText, ModuleKind,
    check_comment_part_kind,
};
use std::ops::Range;

fn planned_body(
    cx: &Cx<'_>,
    slot: &BookSlot,
    target: Option<&EntityRef>,
    body: LinkedTextIn,
) -> Result<LinkedText> {
    let owner = target
        .filter(|r| r.kind == EntityKind::Entry)
        .and_then(|r| EntryId::parse(&r.id).ok());
    let automatic = cx.workspace().auto_links()
        && (crate::autolink::links_for(cx.actor()) || matches!(cx.actor(), crate::Actor::User));
    crate::autolink::plan_book_text(
        &slot.reader_v3.view(),
        owner.as_ref(),
        automatic,
        &body.into(),
    )
}

/// Copy the marks in the saved task suffix of a prose line. Only entry
/// targets belong in a comment. The stable order resolves overlapping
/// prose links, taking each character once.
fn projected_body(
    line: &str,
    line_start: usize,
    task: &str,
    links: &[(Range<usize>, EntityLinkV3)],
    owner: &str,
) -> LinkedText {
    if task.is_empty() {
        return LinkedText::plain(EMPTY_MARKER_TASK);
    }
    let mut body = LinkedText::plain(task);
    let Some(prefix) = line.trim_end().strip_suffix(task) else {
        return body;
    };
    let start = line_start + prefix.chars().count();
    let end = start + task.chars().count();
    let mut next = start;
    for (range, link) in links.iter().take_while(|(r, _)| r.start < end) {
        let from = next.max(range.start);
        let to = range.end.min(end);
        if from < to
            && link.kind == EntityKind::Entry
            && link.target != owner
            && let Ok(entry) = EntryId::parse(&link.target)
        {
            body.links.push(EntryTextLink {
                start: from - start,
                end: to - start,
                entry,
            });
            next = to;
        }
    }
    body
}

fn comments(slot: &BookSlot) -> Vec<Comment> {
    slot.reader_v3.view().comments()
}

/// Whether `comment` was projected from a checklist item.
fn is_checklist(comment: &Comment) -> bool {
    comment
        .projection
        .as_ref()
        .is_some_and(|p| p.kind == ProjectionKind::NoteTask)
}

/// Tick (`checked`) or clear the checklist item `block` that `comment` was
/// projected from, and give the metadata the comment keeps: the prose version
/// with the new tick, so another device follows only once it has that prose.
fn tick_task(cx: &Cx<'_>, comment: &Comment, block: &BlockId, checked: bool) -> Result<String> {
    let (Some(target), Some(module)) = (&comment.target, &comment.target_module) else {
        return Err(WsError::invalid("a checklist comment has no prose"));
    };
    let entry: EntryId = pid("entry", &target.id)?;
    let doc = DocId::Body(BodyDocId::new(entry, module.clone()));
    let ps = cx.prose(&doc)?;
    let (doc2, block2) = (doc.clone(), block.clone());
    let found = cx.write_prose_raw(&ps, move |d| {
        let prose = BorrowedProse::new(d, &doc2)?;
        let pos = prose
            .view()
            .paragraphs()
            .find(|p| {
                p.id.as_ref() == Some(&block2)
                    && p.attrs.list == Some(dr_model::kind::ListKind::Task)
            })
            .map(|p| p.range.start);
        let Some(pos) = pos else { return Ok(false) };
        prose.txn().set_checked(pos, checked)?;
        Ok(true)
    })?;
    if !found {
        return Err(WsError::not_found("checklist item", block.as_str()));
    }
    let vv = ps.handle.doc().with_doc(|d| d.oplog_vv());
    serde_json::to_string(&ProjectionMeta {
        kind: TASK_META_KIND.to_string(),
        prose_vv: vv
            .iter()
            .map(|(p, c)| (p.to_string(), i64::from(*c)))
            .collect(),
    })
    .map_err(|e| WsError::Internal(e.to_string()))
}

/// The book's comments with those on an embed their prose no longer holds
/// marked as not located (`kernel-v5.md` §7).
fn located_comments(cx: &Cx<'_>, slot: &BookSlot) -> Vec<Comment> {
    slot.reader_v3
        .view()
        .comments_with_embeds(None, &mut |entry, module| {
            cx.ws.prose_file_embeds(entry, module)
        })
}

fn require_live(slot: &BookSlot, kind: EntityKind, id: &str) -> Result<()> {
    if !kind.may_be_commented_v3()
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
}

fn active_entry_module(
    slot: &BookSlot,
    entry_id: &str,
    module_id: &str,
) -> Result<(dr_model::v3::Entry, dr_model::v3::ModuleSpec)> {
    let v = slot.reader_v3.view();
    let eid: EntryId = pid("entry", entry_id)?;
    let mid: ModuleId = pid("module", module_id)?;
    let entry = v
        .entry(&eid)
        .filter(|e| !e.is_trashed())
        .ok_or_else(|| WsError::not_found("comment target", entry_id))?;
    let templates = v.templates_map();
    let spec = entry
        .effective_template(&templates)
        .and_then(|et| et.modules.iter().find(|m| m.id == mid).cloned())
        .ok_or_else(|| WsError::not_found("module", module_id))?;
    Ok((entry, spec))
}

/// The file the embed `embed` of `doc` shows, if it is a file embed there.
fn embed_file(cx: &Cx<'_>, doc: &DocId, embed: &EmbedId) -> Option<AssetId> {
    let ps = cx.prose(doc).ok()?;
    let view = cx.prose_view(&ps);
    // Its placeholder must still be in the text.
    if !view.embed_refs().into_iter().any(|(_, e)| &e == embed) {
        return None;
    }
    match view.embed(embed) {
        Some(EmbedView::Asset { asset, .. }) => asset,
        _ => None,
    }
}

/// A comment target (`entry` or `asset`). Old structural kinds and `material` are not accepted.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "CommentTargetV3")]
pub struct Target {
    /// `entry` or `asset`.
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
#[schemars(rename = "CommentProjectIn")]
pub struct CommentProjectIn {
    /// `body:<entry>/<module>` of a book.
    pub doc: String,
    /// Paragraphs starting with TODO / 待办 markers.
    #[serde(default)]
    pub markers: Vec<TodoMarkerIn>,
    /// Present (even empty): project the document's checklist items too.
    /// Their text and ticks are read from the document itself, not from
    /// this list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tasks: Option<Vec<CommentTaskIn>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub editing: Option<String>,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
#[schemars(rename = "CommentInfoV3")]
pub struct CommentInfo {
    pub id: String,
    /// Module on `target` (any module kind); null for whole-entry or floating comments.
    pub module: Option<String>,
    /// Sub-part inside `module` (`embed`, `field`, `kv_row`, `plot_cell`, `patch`, `media`).
    pub part: Option<CommentPartDto>,
    pub target: Option<Target>,
    /// The target or module sub-part is in the trash or gone: show as unlocated.
    pub unlocated: bool,
    pub target_block: Option<String>,
    pub anchored: bool,
    pub quote: Option<String>,
    pub body: LinkedText,
    /// `open` or `resolved` (a comment has no priority).
    pub status: String,
    /// `manual`, `marker`, `task`, `agent` or `reader`.
    pub origin: String,
    /// `user`, `ai` or `external`.
    pub author_kind: String,
    pub author_name: Option<String>,
    /// `manual` or `api`.
    pub source: String,
    pub agent_conversation: Option<String>,
    /// Generated from prose (`marker` or `note_task`).
    pub projection: Option<String>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
}
impl CommentInfo {
    /// Image or PDF rectangle carried by `part`, if any.
    pub fn region(&self) -> Option<&Region> {
        self.part.as_ref().and_then(CommentPartDto::region)
    }
}
impl From<&Comment> for CommentInfo {
    fn from(c: &Comment) -> Self {
        Self {
            module: c.target_module.as_ref().map(ToString::to_string),
            part: c.part.as_ref().map(CommentPartDto::from),
            id: c.id.to_string(),
            target: c.target.as_ref().map(Target::from),
            unlocated: c.target_missing,
            target_block: c.target_block.as_ref().map(ToString::to_string),
            anchored: c.anchor.is_some(),
            quote: c.quote.clone(),
            body: c.body.clone(),
            status: c.status.as_str().into(),
            origin: c.origin.as_str().into(),
            author_kind: c.author_kind.as_str().into(),
            author_name: c.author_name.clone(),
            source: c.source.as_str().into(),
            agent_conversation: c.agent_conversation.clone(),
            projection: c.projection.as_ref().map(|p| p.kind.as_str().into()),
            created_at: c.created_at.map(|t| t.0),
            updated_at: c.updated_at.map(|t| t.0),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "CommentListInV3")]
pub struct CommentListIn {
    pub book: String,
    /// Optional module filter (requires an `entry` target).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub module: Option<String>,
    /// `manual`, `marker`, `task`, `agent` or `reader`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
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
    /// Module on `target` (any module kind on an entry).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub module: Option<String>,
    /// Specific sub-item inside `module` (`embed`, `field`, `kv_row`, `plot_cell`, `patch`, `media`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub part: Option<CommentPartDto>,
    /// `manual`, `agent` or `reader`; defaults from the caller. `marker`
    /// and `task` are refused: those comments are only made by
    /// `comment.project`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    /// What it is on; omitted: a floating comment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<Target>,
    /// The paragraph it sits on (needs a prose target).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block_id: Option<String>,
    /// Anchor it to characters `[start, end)` of the target's prose.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<(usize, usize)>,
    /// Stable cursors captured in the selected prose; mutually exclusive with range and part.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor: Option<AnchorBytes>,
    #[serde(default)]
    pub body: LinkedTextIn,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_name: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "CommentAnchorsInV3")]
pub struct CommentAnchorsIn {
    pub book: String,
    /// The entry's prose module.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub module: Option<String>,
    /// The entry whose prose the anchors are in.
    pub target: Target,
}

op! {
    CommentList = "comment.list", Read, Shared,
    "List comments (a target or module sub-part in the trash or gone shows as unlocated).",
    fn(cx, input: CommentListIn) -> Vec<CommentInfo> {
        let slot = cx.book_v3(&input.book)?;
        if input.module.is_some() && input.target.as_ref().is_none_or(|t| t.kind != "entry") {
            return Err(WsError::invalid("module filtering requires an entry target"));
        }
        let module = input.module.as_deref().map(|id| pid::<ModuleId>("module", id)).transpose()?;
        let t = input.target.as_ref().map(Target::to_ref);
        Ok(located_comments(cx, &slot).iter()
            .filter(|c| input.origin.as_ref().is_none_or(|o| c.origin.as_str() == o))
            .filter(|c| input.status.as_ref().is_none_or(|s| c.status.as_str() == s))
            .filter(|c| t.as_ref().is_none_or(|t| c.target.as_ref() == Some(t)))
            .filter(|c| module.as_ref().is_none_or(|m| c.target_module.as_ref() == Some(m)))
            .map(CommentInfo::from)
            .collect())
    }
}

op! {
    CommentCreate = "comment.create", Write, Book,
    "Add a comment on an entry, any module of an entry, a sub-part inside that module, a passage of prose, or floating.",
    fn(cx, input: CommentCreateIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let agent = matches!(cx.actor(), crate::Actor::Agent { .. });
        let origin = match input.origin.as_deref() {
            Some(o) => {
                let parsed = CommentOrigin::parse(o);
                if !parsed.is_known() {
                    return Err(WsError::invalid(format!("unknown comment origin {:?}", parsed.as_str())));
                }
                // Markers and checklist items are projected from prose
                // (`comment.project`); nobody writes those origins by hand.
                if matches!(parsed, CommentOrigin::Marker | CommentOrigin::Task) {
                    return Err(WsError::invalid(format!(
                        "comments with origin {:?} are only projected from prose",
                        parsed.as_str()
                    )));
                }
                parsed
            }
            None => if agent { CommentOrigin::Agent } else { CommentOrigin::Manual },
        };
        if input.range.is_some() && input.anchor.is_some() {
            return Err(WsError::invalid("a comment has a range or an anchor, not both"));
        }
        let target = input.target.as_ref().map(Target::to_ref);
        let block = input.block_id.as_deref().map(|b| pid::<BlockId>("block", b)).transpose()?;
        let part = input.part.as_ref().map(CommentPartDto::to_model).transpose()?;
        let needs_prose = block.is_some() || input.range.is_some() || input.anchor.is_some();

        if part.is_some() && (input.range.is_some() || input.anchor.is_some()) {
            return Err(WsError::invalid("a comment on a module part cannot also carry a prose range or anchor"));
        }

        // The file a region is drawn on: a page is required on a PDF and
        // refused on an image (checked below, once the file is known).
        let mut region_file: Option<AssetId> = None;
        let module = match &input.target {
            None => {
                if input.module.is_some() || part.is_some() || needs_prose {
                    return Err(WsError::invalid("a floating comment cannot set module, part, block, range or anchor"));
                }
                None
            }
            Some(t) if t.kind == "entry" => {
                require_live(&slot, EntityKind::Entry, &t.id)?;
                match input.module.as_deref() {
                    None => {
                        if part.is_some() || needs_prose {
                            return Err(WsError::invalid("an entry part or prose target requires a module"));
                        }
                        None
                    }
                    Some(mod_str) => {
                        let (entry, mod_spec) = active_entry_module(&slot, &t.id, mod_str)?;
                        if needs_prose && mod_spec.kind != ModuleKind::Prose {
                            return Err(WsError::invalid("block, range and anchor require a prose module"));
                        }
                        if mod_spec.kind == ModuleKind::Prose && (needs_prose || matches!(part, Some(CommentPart::Embed { .. }))) {
                            prose_of(cx, &slot, t, Some(mod_str))?;
                        }
                        if let Some(ref p) = part {
                            check_comment_part_kind(p, &mod_spec.kind)?;
                            let v = slot.reader_v3.view();
                            match p {
                                CommentPart::Embed { embed, .. } => {
                                    let doc = DocId::Body(BodyDocId::new(entry.id.clone(), mod_spec.id.clone()));
                                    region_file = embed_file(cx, &doc, embed);
                                    if region_file.is_none() {
                                        return Err(WsError::not_found("embed", embed.as_str()));
                                    }
                                }
                                CommentPart::Field { field } => {
                                    if !mod_spec.config.defs.iter().any(|d| d.id == field.as_str()) {
                                        return Err(WsError::not_found("field", field.as_str()));
                                    }
                                }
                                CommentPart::KvRow { row } => {
                                    if !entry.kv.get(&mod_spec.id).is_some_and(|rows| rows.iter().any(|r| &r.id == row)) {
                                        return Err(WsError::not_found("kv_row", row.as_str()));
                                    }
                                }
                                CommentPart::PlotCell { row, col } => {
                                    let grid = super::content::grid(&v, &entry.id, &mod_spec);
                                    if !grid.rows.iter().any(|r| r.id == row.as_str())
                                        || !grid.columns.iter().any(|c| c.id == col.as_str())
                                    {
                                        return Err(WsError::not_found("plot_cell", format!("{row}/{col}")));
                                    }
                                }
                                CommentPart::Patch { patch } => {
                                    if !v.patches_of(&entry.id, &mod_spec.id).iter().any(|pa| &pa.id == patch) {
                                        return Err(WsError::not_found("patch", patch.as_str()));
                                    }
                                }
                                CommentPart::Media { asset, .. } => {
                                    if !entry
                                        .media
                                        .get(&mod_spec.id)
                                        .is_some_and(|items| items.iter().any(|it| &it.asset == asset))
                                    {
                                        return Err(WsError::not_found("media", asset.as_str()));
                                    }
                                    region_file = Some(asset.clone());
                                }
                                CommentPart::Region { .. } => {
                                    return Err(WsError::invalid("region part only applies to asset targets"));
                                }
                            }
                        }
                        Some(mod_spec.id)
                    }
                }
            }
            Some(t) if t.kind == "asset" => {
                require_live(&slot, EntityKind::Asset, &t.id)?;
                if input.module.is_some() || needs_prose {
                    return Err(WsError::invalid("a comment on an asset cannot set module, block, range or anchor"));
                }
                if let Some(ref p) = part {
                    match p {
                        CommentPart::Region { .. } => {
                            region_file = Some(pid("asset", &t.id)?);
                        }
                        _ => return Err(WsError::invalid("a comment on an asset only accepts a region part")),
                    }
                }
                None
            }
            Some(t) => return Err(WsError::not_found("comment target", &t.id)),
        };
        if let (Some(region), Some(file)) = (part.as_ref().and_then(CommentPart::region), &region_file)
            && let Some(asset) = slot.reader_v3.view().asset_raw(file)
        {
            match asset.kind {
                dr_model::kind::AssetKind::Pdf if region.page.is_none() => {
                    return Err(WsError::invalid("a region on a PDF names its page"));
                }
                dr_model::kind::AssetKind::Image if region.page.is_some() => {
                    return Err(WsError::invalid("an image region cannot set page"));
                }
                _ => {}
            }
        }

        // Anchor, quote and block snapshots from the target's prose.
        let mut anchor = None;
        let mut quote = None;
        let mut snapshots = Vec::new();
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
        let body = planned_body(cx, &slot, target.as_ref(), input.body)?;
        let (i2, an) = (id.clone(), input.author_name.clone());
        cx.write_book_v3(&slot, Replaces::nothing(), move |txn| {
            let w = txn.comment(&i2)?;
            w.origin(&origin)?.target(target.as_ref())?.module(module.as_ref())?.part(part.as_ref())?
                .target_block(block.as_ref())?.anchor(anchor.as_ref())?
                .quote(quote.as_deref())?.linked_body(&body)?.status(&CommentStatus::Open)?
                .author_kind(if agent { &CommentAuthorKind::Ai } else { &CommentAuthorKind::User })?
                .author_name(an.as_deref())?
                .source(if agent { &CommentSource::Api } else { &CommentSource::Manual })?
                .created_at(Some(now()))?.updated_at(Some(now()))?;
            if !snapshots.is_empty() { w.snapshots(&snapshots)?; }
            Ok(())
        })?;
        cx.effect(EffectAction::Created, "comment", id.as_str(), None);
        cx.undo_with(Invocation::new("comment.delete", EntityIn { book: input.book, id: id.to_string() }));
        Ok(Done { id: id.to_string() })
    }
}

op! {
    CommentUpdate = "comment.update", Write, Book,
    "Change a comment: its text, status (resolve / reopen; a checklist item's comment ticks or clears the item in the prose) or linked Agent conversation. A checklist item's comment takes no other text: its words are the line's, so change the line in the prose.",
    fn(cx, input: CommentUpdateIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let old = comments(&slot).iter().find(|c| c.id.as_str() == input.id).cloned()
            .ok_or_else(|| WsError::not_found("comment", &input.id))?;
        let status = input.status.as_deref().map(CommentStatus::parse);
        if let Some(s) = &status && !s.is_known() { return Err(WsError::invalid(format!("unknown status {:?}", s.as_str()))); }
        // A checklist item's comment is the line's shadow (`kernel-v5.md` §7,
        // the author 2026-11-15): its words are read from the line, so other
        // words are refused here instead of being overwritten by the next
        // projection.
        let checklist = is_checklist(&old);
        let mut body = input.body.clone().map(LinkedText::from);
        if checklist {
            if body.as_ref().is_some_and(|b| b != &old.body) {
                return Err(WsError::invalid(
                    "a checklist item's comment follows its line: change the line in the prose",
                ));
            }
            body = None;
        } else if let Some(draft) = body.take() {
            body = Some(planned_body(cx, &slot, old.target.as_ref(), LinkedTextIn::Linked(draft))?);
        }
        let editing_text = body.is_some();
        // A checklist item's comment is the line's shadow: resolving it ticks
        // the item in the prose and reopening clears the tick, one ordinary
        // prose change before the comment follows (`kernel-v5.md` §7).
        let task_meta = match (&status, &old.projection) {
            (Some(s), Some(p)) if p.kind == ProjectionKind::NoteTask && *s != old.status => {
                // The tick is written before the comment: a guarded caller
                // whose read of the comment is stale is refused here, not
                // after the item is ticked.
                cx.check_book_guards(&slot, &Replaces::record(CollectionV3::Comments, &old.id))?;
                Some(tick_task(cx, &old, &p.block, *s == CommentStatus::Resolved)?)
            }
            _ => None,
        };
        let (id, i) = (old.id.clone(), input.clone());
        let (_, at) = cx.write_book_v3(&slot, Replaces::record(CollectionV3::Comments, &id), move |txn| {
            let w = txn.comment(&id)?;
            if let Some(b) = &body { w.linked_body(b)?; }
            if let Some(s) = &status {
                w.status(s)?.resolved_at((*s == CommentStatus::Resolved).then(now))?;
            }
            if let Some(meta) = &task_meta { w.metadata(Some(meta))?; }
            if let Some(a) = &i.agent_conversation { w.agent_conversation(a.as_deref())?; }
            w.updated_at(Some(now()))?;
            Ok(())
        })?;
        cx.effect(EffectAction::Updated, "comment", &input.id, None);
        if editing_text {
            undo(cx, &slot, &at, vec![key("comments", &input.id)]);
        } else {
            cx.undo_with(Invocation::new("comment.update", CommentUpdateIn {
                book: input.book.clone(), id: input.id.clone(),
                body: None,
                status: input.status.as_ref().map(|_| old.status.as_str().to_string()),
                agent_conversation: input.agent_conversation.as_ref().map(|_| old.agent_conversation.clone()),
            }));
        }
        Ok(Done { id: input.id })
    }
}

op! {
    CommentDelete = "comment.delete", Write, Book,
    "Delete a comment. A checklist item's comment is not deleted here: it goes when its line is deleted in the prose.",
    fn(cx, input: EntityIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let id: CommentId = pid("comment", &input.id)?;
        let Some(old) = comments(&slot).into_iter().find(|c| c.id == id) else {
            return Err(WsError::not_found("comment", &input.id));
        };
        // The next projection would make it again from its line.
        if is_checklist(&old) {
            return Err(WsError::invalid(
                "a checklist item's comment goes with its line: delete the line in the prose",
            ));
        }
        let saved = id.clone();
        let (_, before) = cx.write_book_v3(&slot, Replaces::record(CollectionV3::Comments, &id), move |txn| {
            txn.purge(CollectionV3::Comments, saved.as_str())?;
            Ok(())
        })?;
        cx.effect(EffectAction::Purged, "comment", &input.id, None);
        undo(cx, &slot, &before, vec![key("comments", &id)]);
        Ok(Done { id: input.id })
    }
}

op! {
    CommentAnchors = "comment.anchors", Read, Shared,
    "The stored anchors of the comments on one entity's prose, for an editor laying them out (comments without an anchor are not listed).",
    fn(cx, input: CommentAnchorsIn) -> Vec<CommentAnchor> {
        let slot = cx.book_v3(&input.book)?;
        prose_of(cx, &slot, &input.target, input.module.as_deref())?;
        let module = input.module.as_deref().map(|m| pid("module", m)).transpose()?;
        let t = input.target.to_ref();
        Ok(comments(&slot).iter()
            .filter(|c| c.target.as_ref() == Some(&t) && c.target_module == module)
            .filter_map(|c| Some(CommentAnchor {
                id: c.id.to_string(),
                origin: c.origin.as_str().to_string(),
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
    CommentProject = "comment.project", Write, Book,
    "Keep projected comments from TODO markers (origin = marker) and checklist items (origin = task) in one prose document in step with it: a new marker or checklist item gets a comment; a marker's open comment whose line is gone is deleted and its resolved one stays; a checklist item's comment follows the line's text and tick (ticked = resolved) and is deleted with the line, resolved or not; deterministic ids merge across devices.",
    fn(cx, input: CommentProjectIn) -> CommentProjected {
        let doc = DocId::parse(&input.doc).map_err(|e| WsError::invalid(format!("{:?}: {e}", input.doc)))?;
        let (owner, module) = match &doc {
            DocId::Body(b) => (EntityRef::new(EntityKind::Entry, b.entry().as_str()), Some(b.module().clone())),
            _ => return Err(WsError::invalid("projected comments require entry prose")),
        };
        let ps = cx.prose(&doc)?;
        let book = ps.book.clone().ok_or_else(|| WsError::invalid(format!("{} belongs to no book", input.doc)))?;
        let slot = cx.book_v3(book.as_str())?;
        prose_of(cx, &slot, &Target::from(&owner), module.as_ref().map(|m| m.as_str()))?;
        require_live(&slot, owner.kind.clone(), &owner.id)?;

        // Markers, deduplicated (first marker of a block wins).
        let mut markers: Vec<(BlockId, String)> = Vec::new();
        for m in &input.markers {
            let b: BlockId = pid("block", &m.block)?;
            if !markers.iter().any(|(x, _)| x == &b) {
                markers.push((b, m.task.trim().to_string()));
            }
        }
        for t in input.tasks.iter().flatten() {
            let _: BlockId = pid("block", &t.block)?;
        }
        let editing = input.editing.as_deref().map(|b| pid::<BlockId>("block", b)).transpose()?;

        // The document now: its blocks and its version.
        let view = cx.prose_view(&ps);
        let links = if input.tasks.is_some() || !markers.is_empty() {
            view.entity_links_v3()
        } else {
            Vec::new()
        };
        let vv = ps.handle.doc().with_doc(|d| d.oplog_vv());
        let mut marker_bodies = BTreeMap::new();
        let mut tasks = input.tasks.as_ref().map(|_| BTreeMap::new());
        for p in view.paragraphs() {
            let Some(block) = p.id.clone() else { continue };
            if let Some((_, task)) = markers.iter().find(|(id, _)| id == &block) {
                marker_bodies.entry(block.clone()).or_insert_with(|| {
                    projected_body(&p.text(), p.range.start, task, &links, &owner.id)
                });
            }
            if p.attrs.list == Some(dr_model::kind::ListKind::Task)
                && let Some(tasks) = &mut tasks
            {
                tasks.entry(block).or_insert_with(|| {
                    let text = p.text();
                    (projected_body(&text, p.range.start, text.trim(), &links, &owner.id), p.attrs.checked)
                });
            }
        }

        let doc_comments: Vec<Comment> = comments(&slot)
            .into_iter()
            .filter(|c| c.target.as_ref() == Some(&owner) && c.target_module == module)
            .collect();

        let existing_markers: BTreeMap<BlockId, Comment> = doc_comments
            .iter()
            .filter_map(|c| {
                let p = c.projection.as_ref().filter(|p| p.kind == ProjectionKind::Marker)?;
                Some((p.block.clone(), c.clone()))
            })
            .collect();

        let existing_tasks: BTreeMap<BlockId, Comment> = doc_comments
            .iter()
            .filter_map(|c| {
                let p = c.projection.as_ref().filter(|p| p.kind == ProjectionKind::NoteTask)?;
                Some((p.block.clone(), c.clone()))
            })
            .collect();

        let mut out = CommentProjected::default();
        let mut create: Vec<(ProjectionKind, BlockId, LinkedText, bool)> = Vec::new();
        let mut sync_tasks: Vec<(CommentId, Option<LinkedText>, Option<CommentStatus>)> = Vec::new();
        let mut remove: Vec<CommentId> = Vec::new();

        for (b, body) in marker_bodies {
            if !existing_markers.contains_key(&b) && editing.as_ref() != Some(&b) {
                create.push((ProjectionKind::Marker, b, body, false));
            }
        }
        for (b, c) in &existing_markers {
            if c.status != CommentStatus::Open || markers.iter().any(|(x, _)| x == b) {
                continue;
            }
            if has_seen(&vv, c.metadata.as_deref()) {
                remove.push(c.id.clone());
            } else {
                out.waiting.push(c.id.to_string());
            }
        }

        if let Some(ref tasks) = tasks {
            let book = slot.reader_v3.view();
            for (b, (body, checked)) in tasks {
                if let Some(existing) = existing_tasks.get(b) {
                    // A resolve or reopen made on another device writes the
                    // tick first; until that prose is here the comment is
                    // not turned back by an older tick.
                    if !has_seen(&vv, existing.metadata.as_deref()) {
                        out.waiting.push(existing.id.to_string());
                        continue;
                    }
                    let want_status = if *checked { CommentStatus::Resolved } else { CommentStatus::Open };
                    let status_change = (existing.status != want_status).then_some(want_status);
                    let body_change = (editing.as_ref() != Some(b)
                        && book.comment_body_raw(&existing.id).as_ref() != Some(body)).then(|| body.clone());
                    if status_change.is_some() || body_change.is_some() {
                        sync_tasks.push((existing.id.clone(), body_change, status_change));
                    }
                    continue;
                }
                if editing.as_ref() == Some(b) {
                    continue;
                }
                create.push((ProjectionKind::NoteTask, b.clone(), body.clone(), *checked));
            }
            // An item that is gone takes its comment with it, resolved or not
            // (the comment is only the line's shadow; a marker's resolved
            // comment stays, a checklist item's does not).
            for (b, c) in &existing_tasks {
                if tasks.contains_key(b) {
                    continue;
                }
                if has_seen(&vv, c.metadata.as_deref()) {
                    remove.push(c.id.clone());
                } else {
                    out.waiting.push(c.id.to_string());
                }
            }
        }

        cx.follows_prose();
        if create.is_empty() && sync_tasks.is_empty() && remove.is_empty() {
            cx.undo_nothing();
            return Ok(out);
        }
        let prose_vv: BTreeMap<String, i64> =
            vv.iter().map(|(p, c)| (p.to_string(), i64::from(*c))).collect();
        let marker_meta = serde_json::to_string(&ProjectionMeta {
            kind: MARKER_META_KIND.to_string(),
            prose_vv: prose_vv.clone(),
        }).map_err(|e| WsError::Internal(e.to_string()))?;
        let task_meta = serde_json::to_string(&ProjectionMeta {
            kind: TASK_META_KIND.to_string(),
            prose_vv,
        }).map_err(|e| WsError::Internal(e.to_string()))?;
        let agent = matches!(cx.actor(), crate::Actor::Agent { .. });
        let (d2, c2, s2, rm2) = (doc.clone(), create, sync_tasks.clone(), remove.clone());
        let created = cx.write_book_v3(&slot, Replaces::nothing(), move |txn| {
            let mut ids = Vec::new();
            for (kind, b, task, checked) in &c2 {
                let (id, w) = txn.project_todo(kind, &d2, b, task)?;
                let meta = match kind {
                    ProjectionKind::NoteTask => &task_meta,
                    _ => &marker_meta,
                };
                w.author_kind(if agent { &CommentAuthorKind::Ai } else { &CommentAuthorKind::User })?
                    .source(if agent { &CommentSource::Api } else { &CommentSource::Manual })?
                    .metadata(Some(meta))?
                    .created_at(Some(now()))?.updated_at(Some(now()))?;
                if *checked {
                    w.status(&CommentStatus::Resolved)?.resolved_at(Some(now()))?;
                }
                ids.push(id);
            }
            for (id, body_change, status_change) in &s2 {
                let w = txn.comment(id)?;
                if let Some(body) = body_change {
                    w.linked_body(body)?;
                }
                if let Some(status) = status_change {
                    w.status(status)?.resolved_at((*status == CommentStatus::Resolved).then(now))?;
                }
                // The prose version the item now follows: another device
                // keeps this until it has that prose too.
                w.metadata(Some(&task_meta))?.updated_at(Some(now()))?;
            }
            for c in &rm2 { txn.purge(CollectionV3::Comments, c.as_str())?; }
            Ok(ids)
        })?.0;
        for id in &created {
            cx.effect(EffectAction::Created, "comment", id.as_str(), None);
            out.created.push(id.to_string());
        }
        for (id, _, _) in &sync_tasks {
            cx.effect(EffectAction::Updated, "comment", id.as_str(), None);
        }
        for id in &remove {
            cx.effect(EffectAction::Purged, "comment", id.as_str(), None);
            out.removed.push(id.to_string());
        }
        Ok(out)
    }
}
