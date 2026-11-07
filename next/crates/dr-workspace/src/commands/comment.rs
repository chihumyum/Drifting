//! Comments and TODOs: their metadata in the book document. Anchors are
//! made from a character range of the target's prose document.

use dr_doc::book::Collection;
use dr_model::DocId;
use dr_model::book::BlockSnapshot;
use dr_model::id::{BlockId, CommentId};
use dr_model::kind::{
    CommentAuthorKind, CommentKind, CommentPriority, CommentSource, CommentStatus, EntityKind,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::*;
use crate::cx::{EffectAction, Invocation};
use crate::dto::{CommentInfo, Target};
use crate::registry::Registry;

pub(crate) fn register(r: &mut Registry) {
    r.add::<CommentList>()
        .add::<CommentCreate>()
        .add::<CommentUpdate>()
        .add::<CommentDelete>();
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
        .filter(|d| !d.is_book())
}

op! {
    CommentCreate = "comment.create", Write, Book,
    "Add a comment or TODO, on an entity, a paragraph, a passage of its prose, or floating.",
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
