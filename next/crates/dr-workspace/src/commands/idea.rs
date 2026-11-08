//! Ideas (构想; internal name drift) and idea groups.

use dr_model::DocId;
use dr_model::book::DriftGroup;
use dr_model::id::{DriftGroupId, NodeId};
use dr_model::kind::{NodeKind, NodeStatus};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::*;
use crate::cx::{EffectAction, Invocation};
use crate::dto::{GroupInfo, IdeaInfo};
use crate::naming::unique_name;
use crate::registry::Registry;

pub(crate) fn register(r: &mut Registry) {
    r.add::<IdeaList>()
        .add::<IdeaCreate>()
        .add::<IdeaUpdate>()
        .add::<IdeaTrash>()
        .add::<IdeaRestore>()
        .add::<IdeaPurge>()
        .add::<IdeaGroupList>()
        .add::<IdeaGroupCreate>()
        .add::<IdeaGroupUpdate>()
        .add::<IdeaGroupDelete>();
}

/// Idea groups nest at most two levels (`TREE-DEPTH`).
pub const MAX_GROUP_DEPTH: usize = 2;

fn live_idea(slot: &BookSlot, id: &str) -> Result<Node> {
    let nid: NodeId = pid("idea", id)?;
    match nodes(slot).get(&nid) {
        Some(n) if n.is_drift() => Ok(n.clone()),
        _ => Err(WsError::not_found("idea", id)),
    }
}

fn group_exists(slot: &BookSlot, id: &str) -> Result<DriftGroupId> {
    let g: DriftGroupId = pid("idea group", id)?;
    if drift_groups(slot).iter().any(|x| x.id == g) {
        Ok(g)
    } else {
        Err(WsError::not_found("idea group", id))
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct IdeaListIn {
    pub book: String,
    /// Only ideas in this group (`""`: at the top level).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(default)]
    pub trashed: bool,
}

op! {
    IdeaList = "idea.list", Read, Shared,
    "List ideas (构想), optionally of one group.",
    fn(cx, input: IdeaListIn) -> Vec<IdeaInfo> {
        let slot = cx.book(&input.book)?;
        let mut v: Vec<IdeaInfo> = nodes(&slot).values()
            .filter(|n| n.is_drift() && (input.trashed || !n.is_trashed()))
            .filter(|n| match input.group.as_deref() {
                None => true,
                Some("") => n.group.is_none(),
                Some(g) => n.group.as_ref().map(|x| x.as_str()) == Some(g),
            })
            .map(IdeaInfo::from).collect();
        v.sort_by(|a, b| a.title.cmp(&b.title).then(a.id.cmp(&b.id)));
        Ok(v)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct IdeaCreateIn {
    pub book: String,
    /// A taken title (chapters and ideas share titles) gets a ` 2` suffix.
    #[serde(default)]
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<(f64, f64)>,
    #[serde(default)]
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

op! {
    IdeaCreate = "idea.create", Write, Book,
    "Create an idea (构想); a taken title gets a numbered suffix and the final title is returned.",
    fn(cx, input: IdeaCreateIn) -> Named {
        let slot = cx.book(&input.book)?;
        let group = input.group.as_deref().map(|g| group_exists(&slot, g)).transpose()?;
        let title = unique_name(&input.title, super::chapter::UNTITLED, node_titles(&slot, None).iter().map(String::as_str));
        let (x, y) = input.position.unwrap_or((0.0, 0.0));
        if !(x.is_finite() && y.is_finite()) { return Err(WsError::invalid("position must be finite")); }
        let id = NodeId::new_v7();
        cx.summarize(format!("「{title}」"));
        super::chapter::seed_prose(cx, &slot.book, &DocId::Node(id.clone()), input.text.as_deref())?;
        crate::autolink::backfill_title(cx, &slot, &id, &title)?;
        let (i2, t2, s2) = (id.clone(), title.clone(), input.summary.clone());
        cx.write_book(&slot, move |txn| {
            txn.node(&i2)?.kind(&NodeKind::Drift)?.title(&t2)?.summary(&s2)?.status(&NodeStatus::Drifting)?
                .group(group.as_ref())?.x(x)?.y(y)?.created_at(Some(now()))?;
            Ok(())
        })?;
        cx.effect(EffectAction::Created, "node", id.as_str(), Some(&title));
        cx.undo_with(Invocation::new("idea.trash", EntityIn { book: input.book, id: id.to_string() }));
        Ok(Named { id: id.to_string(), name: title })
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct IdeaUpdateIn {
    pub book: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// `drifting` or `resting`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// `null` moves it to the top level.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub group: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<(f64, f64)>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub narrative_order: Option<Option<f64>>,
}

op! {
    IdeaUpdate = "idea.update", Write, Book,
    "Change an idea's title, summary, status, group, board position or narrative position.",
    fn(cx, input: IdeaUpdateIn) -> Named {
        let slot = cx.book(&input.book)?;
        let old = live_idea(&slot, &input.id)?;
        let title = input.title.as_ref().map(|t| unique_name(t, super::chapter::UNTITLED, node_titles(&slot, Some(&old.id)).iter().map(String::as_str)));
        let status = input.status.as_deref().map(NodeStatus::parse);
        if let Some(s) = &status && !s.fits(&NodeKind::Drift) {
            return Err(WsError::invalid(format!("{:?} is not an idea status", s.as_str())));
        }
        let group: Option<Option<DriftGroupId>> = match &input.group {
            Some(Some(g)) => Some(Some(group_exists(&slot, g)?)),
            Some(None) => Some(None),
            None => None,
        };
        if let Some((x, y)) = input.position && !(x.is_finite() && y.is_finite()) { return Err(WsError::invalid("position must be finite")); }
        if let Some(Some(o)) = input.narrative_order && !o.is_finite() { return Err(WsError::invalid("narrative order must be finite")); }
        if let Some(t) = title.as_ref().filter(|t| **t != old.title) {
            crate::autolink::backfill_title(cx, &slot, &old.id, t)?;
        }
        let (id, t2, s2, st2, g2, p2, n2) = (old.id.clone(), title.clone(), input.summary.clone(), status.clone(), group.clone(), input.position, input.narrative_order);
        cx.write_book(&slot, move |txn| {
            let w = txn.node(&id)?;
            if let Some(t) = &t2 { w.title(t)?; }
            if let Some(s) = &s2 { w.summary(s)?; }
            if let Some(s) = &st2 { w.status(s)?; }
            if let Some(g) = &g2 { w.group(g.as_ref())?; }
            if let Some((x, y)) = p2 { w.x(x)?.y(y)?; }
            if let Some(o) = n2 { w.narrative_order(o)?; }
            Ok(())
        })?;
        let name = title.clone().unwrap_or_else(|| old.title.clone());
        cx.effect(if title.is_some() { EffectAction::Renamed } else { EffectAction::Updated }, "node", &input.id, Some(&name));
        cx.undo_with(Invocation::new("idea.update", IdeaUpdateIn {
            book: input.book.clone(), id: input.id.clone(),
            title: title.as_ref().map(|_| old.title.clone()),
            summary: input.summary.as_ref().map(|_| old.summary.clone()),
            status: status.as_ref().map(|_| old.status.as_str().to_string()),
            group: group.as_ref().map(|_| old.group.as_ref().map(|g| g.to_string())),
            position: input.position.map(|_| (old.x, old.y)),
            narrative_order: input.narrative_order.map(|_| old.narrative_order),
        }));
        Ok(Named { id: input.id, name })
    }
}

op! {
    IdeaTrash = "idea.trash", Write, Book,
    "Move an idea to the trash. Never refused: acts and time pins bound to it read as unbound until it is restored.",
    fn(cx, input: EntityIn) -> Named { super::chapter::set_node_trashed(cx, &input, NodeKind::Drift, true) }
}

op! {
    IdeaRestore = "idea.restore", Write, Book,
    "Bring an idea back from the trash (its bindings come back with it).",
    fn(cx, input: EntityIn) -> Named { super::chapter::set_node_trashed(cx, &input, NodeKind::Drift, false) }
}

op! {
    IdeaPurge = "idea.purge", Write, Book,
    "Delete an idea for good: time pins bound to it keep its title as their label, acts and pins lose the binding, relations go, comments become floating; one commit.",
    fn(cx, input: EntityIn) -> Done { super::chapter::purge_node(cx, &input, NodeKind::Drift) }
}

// ---- groups ---------------------------------------------------------------

fn depth(groups: &[DriftGroup], id: &DriftGroupId) -> usize {
    let mut d = 1;
    let mut cur = groups
        .iter()
        .find(|g| &g.id == id)
        .and_then(|g| g.parent.clone());
    while let Some(p) = cur {
        d += 1;
        cur = groups
            .iter()
            .find(|g| g.id == p)
            .and_then(|g| g.parent.clone());
        if d > groups.len() + 1 {
            break;
        }
    }
    d
}

/// Levels below `id`, itself included.
fn height(groups: &[DriftGroup], id: &DriftGroupId) -> usize {
    1 + groups
        .iter()
        .filter(|g| g.parent.as_ref() == Some(id))
        .map(|g| height(groups, &g.id))
        .max()
        .unwrap_or(0)
}

op! {
    IdeaGroupList = "idea_group.list", Read, Shared,
    "List idea groups, parents before children.",
    fn(cx, input: BookIn) -> Vec<GroupInfo> {
        let slot = cx.book(&input.book)?;
        Ok(drift_groups(&slot).iter().map(|g| GroupInfo {
            id: g.id.to_string(), name: g.name.clone(), color: g.color.clone(), parent: g.parent.as_ref().map(|p| p.to_string()),
        }).collect())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct GroupCreateIn {
    pub book: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

op! {
    IdeaGroupCreate = "idea_group.create", Write, Book,
    "Create an idea group (groups nest at most two levels).",
    fn(cx, input: GroupCreateIn) -> Named {
        let slot = cx.book(&input.book)?;
        name_ok(&input.name)?;
        let groups = drift_groups(&slot);
        let parent = input.parent.as_deref().map(|p| group_exists(&slot, p)).transpose()?;
        if let Some(p) = &parent && depth(&groups, p) + 1 > MAX_GROUP_DEPTH {
            return Err(WsError::invalid(format!("idea groups nest at most {MAX_GROUP_DEPTH} levels")));
        }
        let id = DriftGroupId::new_v7();
        let (i2, n2, p2, c2) = (id.clone(), input.name.trim().to_string(), parent.clone(), input.color.clone());
        cx.write_book(&slot, move |txn| {
            let t = txn.drift_groups();
            t.create(i2.as_str(), p2.as_ref().map(|p| p.as_str()), &n2)?;
            if c2.is_some() { t.set_color(i2.as_str(), c2.as_deref())?; }
            Ok(())
        })?;
        cx.effect(EffectAction::Created, "idea_group", id.as_str(), Some(input.name.trim()));
        cx.undo_with(Invocation::new("idea_group.delete", EntityIn { book: input.book, id: id.to_string() }));
        Ok(Named { id: id.to_string(), name: input.name.trim().to_string() })
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct GroupUpdateIn {
    pub book: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub color: Option<Option<String>>,
    /// Move under this group (`null`: the top level).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub parent: Option<Option<String>>,
}

op! {
    IdeaGroupUpdate = "idea_group.update", Write, Book,
    "Rename, recolour or move an idea group (at most two levels).",
    fn(cx, input: GroupUpdateIn) -> Named {
        let slot = cx.book(&input.book)?;
        let groups = drift_groups(&slot);
        let me = group_exists(&slot, &input.id)?;
        let old = groups.iter().find(|g| g.id == me).cloned().expect("exists");
        if let Some(n) = &input.name { name_ok(n)?; }
        let parent: Option<Option<DriftGroupId>> = match &input.parent {
            Some(Some(p)) => {
                let p = group_exists(&slot, p)?;
                if p == me || depth(&groups, &p) + height(&groups, &me) > MAX_GROUP_DEPTH {
                    return Err(WsError::invalid(format!("idea groups nest at most {MAX_GROUP_DEPTH} levels")));
                }
                Some(Some(p))
            }
            Some(None) => Some(None),
            None => None,
        };
        let (i2, n2, c2, p2) = (me.clone(), input.name.clone(), input.color.clone(), parent.clone());
        cx.write_book(&slot, move |txn| {
            let t = txn.drift_groups();
            if let Some(n) = &n2 { t.rename(i2.as_str(), n.trim())?; }
            if let Some(c) = &c2 { t.set_color(i2.as_str(), c.as_deref())?; }
            if let Some(p) = &p2 { t.move_to(i2.as_str(), p.as_ref().map(|p| p.as_str()))?; }
            Ok(())
        })?;
        let name = input.name.as_ref().map(|n| n.trim().to_string()).unwrap_or_else(|| old.name.clone());
        cx.effect(if parent.is_some() { EffectAction::Moved } else { EffectAction::Updated }, "idea_group", &input.id, Some(&name));
        cx.undo_with(Invocation::new("idea_group.update", GroupUpdateIn {
            book: input.book.clone(), id: input.id.clone(),
            name: input.name.as_ref().map(|_| old.name.clone()),
            color: input.color.as_ref().map(|_| old.color.clone()),
            parent: parent.as_ref().map(|_| old.parent.as_ref().map(|p| p.to_string())),
        }));
        Ok(Named { id: input.id, name })
    }
}

op! {
    IdeaGroupDelete = "idea_group.delete", Write, Book,
    "Delete an idea group: its sub-groups and ideas move up to its parent.",
    fn(cx, input: EntityIn) -> Done {
        let slot = cx.book(&input.book)?;
        let me = group_exists(&slot, &input.id)?;
        let groups = drift_groups(&slot);
        let children: Vec<String> = groups.iter().filter(|g| g.parent.as_ref() == Some(&me)).map(|g| g.id.to_string()).collect();
        let members: Vec<String> = nodes(&slot).values().filter(|n| n.group.as_ref() == Some(&me)).map(|n| n.id.to_string()).collect();
        let mut touched: Vec<(String, String)> = vec![("drift_groups".into(), input.id.clone())];
        touched.extend(children.iter().map(|c| ("drift_groups".to_string(), c.clone())));
        touched.extend(members.iter().map(|m| ("nodes".to_string(), m.clone())));
        let i2 = me.clone();
        let (_, before) = cx.write_book(&slot, move |txn| { txn.delete_drift_group(&i2)?; Ok(()) })?;
        for c in &children { cx.effect(EffectAction::Moved, "idea_group", c.as_str(), None); }
        for m in &members { cx.effect(EffectAction::Moved, "node", m.as_str(), None); }
        cx.effect(EffectAction::Purged, "idea_group", &input.id, None);
        cx.undo_with(super::history::restore_invocation(&input.book, &before, touched));
        Ok(Done { id: input.id })
    }
}
