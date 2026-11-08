//! Ideas (构想; internal name drift) and idea groups.

use dr_doc::book::Collection;
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
        .add::<IdeaToChapter>()
        .add::<IdeaToElement>()
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

// ---- turning an idea into a chapter or an element ------------------------------
//
// The 0.1 editor's 「转换为章节…」 / 「转换为要素…」 (`NodeEditorView`'s
// `handleConfirmConversion`), each one step here.

/// A live (not trashed) idea.
fn idea_to_convert(slot: &BookSlot, id: &str) -> Result<Node> {
    let n = live_idea(slot, id)?;
    if n.is_trashed() {
        return Err(WsError::not_found("idea", id));
    }
    Ok(n)
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct IdeaToChapterIn {
    pub book: String,
    pub id: String,
    /// The chapter's storyline (it becomes its primary one).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storyline: Option<String>,
}

op! {
    IdeaToChapter = "idea.to_chapter", Write, Book,
    "Turn an idea into a chapter, keeping its page, text, comments and relations: it becomes a draft after the last chapter, on the given storyline and out of its idea group; acts and time pins bound to it are unbound (a pin with no label keeps the idea's title).",
    fn(cx, input: IdeaToChapterIn) -> super::chapter::ChapterCreated {
        let slot = cx.book(&input.book)?;
        let old = idea_to_convert(&slot, &input.id)?;
        let storyline: Option<dr_model::id::StorylineId> = match &input.storyline {
            Some(s) => {
                let id: dr_model::id::StorylineId = pid("storyline", s)?;
                if !storylines(&slot).iter().any(|x| x.id == id && x.deleted_at.is_none()) {
                    return Err(WsError::not_found("storyline", s));
                }
                Some(id)
            }
            None => None,
        };
        let order = super::chapter::order_for(&slot, &super::chapter::ChapterPlace::Last, None)?;
        let pins: Vec<(dr_model::id::TimePinId, Option<String>)> = time_pins(&slot).iter()
            .filter(|p| p.drift.as_ref() == Some(&old.id))
            .map(|p| (p.id.clone(), p.label.trim().is_empty().then(|| {
                let t = old.title.trim();
                if t.is_empty() { super::chapter::UNTITLED.to_string() } else { t.to_string() }
            })))
            .collect();
        let bound_acts: Vec<dr_model::id::ActId> = acts(&slot).iter()
            .filter(|a| a.drift.as_ref() == Some(&old.id))
            .map(|a| a.id.clone())
            .collect();
        cx.summarize(format!("「{}」", old.title));
        let mut touched: Vec<(String, String)> = vec![(Collection::Nodes.root().to_string(), input.id.clone())];
        touched.extend(pins.iter().map(|(p, _)| (Collection::TimePins.root().to_string(), p.to_string())));
        touched.extend(bound_acts.iter().map(|a| (Collection::Acts.root().to_string(), a.to_string())));
        let (id, s2, p2, a2) = (old.id.clone(), storyline.clone(), pins.clone(), bound_acts.clone());
        let (_, before) = cx.write_book(&slot, move |txn| {
            let w = txn.node(&id)?;
            w.kind(&NodeKind::Chapter)?.status(&NodeStatus::Draft)?.book_order(Some(order))?.group(None)?;
            if let Some(s) = &s2 {
                w.add_storyline(s)?.primary_storyline(Some(s))?;
            }
            for (p, label) in &p2 {
                let w = txn.time_pin(p)?;
                w.drift(None)?;
                if let Some(l) = label { w.label(l)?; }
            }
            for a in &a2 { txn.act(a)?.drift(None)?; }
            Ok(())
        })?;
        cx.effect(EffectAction::Updated, "node", &input.id, Some(&old.title));
        for (p, _) in &pins { cx.effect(EffectAction::Updated, "time_pin", p.as_str(), None); }
        for a in &bound_acts { cx.effect(EffectAction::Updated, "act", a.as_str(), None); }
        cx.undo_with(super::history::restore_invocation(&input.book, &before, touched));
        Ok(super::chapter::ChapterCreated { id: input.id, title: old.title, book_order: order })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct IdeaToElementIn {
    pub book: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// Default: the idea's title. A name another element has is refused.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

op! {
    IdeaToElement = "idea.to_element", Write, Book,
    "Turn an idea into a new element: its title becomes the name, its summary and text move over (the element starts with its category's template fields), and the idea goes to the trash. A name another element has is refused.",
    fn(cx, input: IdeaToElementIn) -> Named {
        let slot = cx.book(&input.book)?;
        let old = idea_to_convert(&slot, &input.id)?;
        let asked = input.name.clone().unwrap_or_else(|| old.title.clone());
        let name = if asked.trim().is_empty() {
            let taken: Vec<String> = elements(&slot).iter().filter(|e| e.deleted_at.is_none())
                .flat_map(|e| std::iter::once(e.name.clone()).chain(e.aliases.iter().cloned())).collect();
            unique_name("", super::element::NEW_ELEMENT, taken.iter().map(String::as_str))
        } else {
            asked.trim().to_string()
        };
        super::element::check_names(&slot, None, std::iter::once(name.as_str()))?;
        let category = input.category.as_deref().map(|c| super::element::live_category(&slot, c)).transpose()?;
        let eid = dr_model::id::ElementId::new_v7();
        cx.summarize(format!("「{name}」"));
        // The idea's text, copied whole (marks and links too).
        let src = DocId::Node(old.id.clone());
        let body = match cx.workspace().library().doc_info(&src.to_string())? {
            Some(_) => {
                let ps = cx.prose(&src)?;
                if super::template::blank(&ps.reader.view()) {
                    None
                } else {
                    Some(ps.handle.read(|d| d.fork())?)
                }
            }
            None => None,
        };
        match body {
            Some(copy) => super::template::apply_template(cx, &slot.book, &DocId::Element(eid.clone()), super::template::Template::Doc(src, copy))?,
            None => super::chapter::seed_prose(cx, &slot.book, &DocId::Element(eid.clone()), None)?,
        }
        // Its name, linked in the text already written; the idea's title
        // (the same words) is leaving, so it does not hold the name.
        crate::autolink::backfill_element_leaving(cx, &slot, &eid, &name, &[], std::slice::from_ref(&name), Some(old.id.as_str()))?;
        let fields = category.as_ref()
            .and_then(|c| categories(&slot).iter().find(|x| &x.id == c).map(|x| super::template::copied(&x.template_fields)))
            .unwrap_or_default();
        super::trash_effects(cx, &slot, &dr_model::book::EntityRef::new(dr_model::kind::EntityKind::Node, input.id.clone()), true);
        let (e2, n2, s2, i2, at) = (eid.clone(), name.clone(), old.summary.clone(), old.id.clone(), now());
        cx.write_book(&slot, move |txn| {
            let w = txn.element(&e2)?;
            w.name(&n2)?.summary(&s2)?.category(category.as_ref())?.created_at(Some(at))?;
            for f in &fields { w.put_fact(f)?; }
            txn.node(&i2)?.deleted_at(Some(at))?;
            Ok(())
        })?;
        cx.effect(EffectAction::Created, "element", eid.as_str(), Some(&name));
        cx.effect(EffectAction::Trashed, "node", &input.id, Some(&old.title));
        cx.undo_with(Invocation::new("element.trash", EntityIn { book: input.book.clone(), id: eid.to_string() }));
        cx.undo_with(Invocation::new("idea.restore", EntityIn { book: input.book, id: input.id }));
        Ok(Named { id: eid.to_string(), name })
    }
}
