//! Storylines.

use dr_doc::book::Collection;
use dr_model::DocId;
use dr_model::book::EntityRef;
use dr_model::id::StorylineId;
use dr_model::kind::EntityKind;
use dr_model::pos::PosKey;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::*;
use crate::cx::{EffectAction, Invocation};
use crate::dto::StorylineInfo;
use crate::naming::{Place, pos_for, unique_name};
use crate::registry::Registry;

pub(crate) fn register(r: &mut Registry) {
    r.add::<StorylineList>()
        .add::<StorylineCreate>()
        .add::<StorylineUpdate>()
        .add::<StorylineMove>()
        .add::<StorylineTrash>()
        .add::<StorylineRestore>()
        .add::<StorylinePurge>();
}

const UNTITLED_STORYLINE: &str = "New Storyline";
const DEFAULT_COLOR: &str = "#8A8A8A";

fn find(slot: &BookSlot, id: &str) -> Result<dr_model::book::Storyline> {
    storylines(slot)
        .iter()
        .find(|s| s.id.as_str() == id)
        .cloned()
        .ok_or_else(|| WsError::not_found("storyline", id))
}

fn live_names(slot: &BookSlot, except: Option<&StorylineId>) -> Vec<String> {
    storylines(slot)
        .iter()
        .filter(|s| s.deleted_at.is_none() && Some(&s.id) != except)
        .map(|s| s.name.clone())
        .collect()
}

op! {
    StorylineList = "storyline.list", Read, Shared,
    "List storylines in order, with how many live chapters each has.",
    fn(cx, input: ListIn) -> Vec<StorylineInfo> {
        let slot = cx.book(&input.book)?;
        let chs = chapters(&slot);
        storylines(&slot).iter().filter(|s| input.trashed || s.deleted_at.is_none()).map(|s| Ok(StorylineInfo {
            id: s.id.to_string(), name: s.name.clone(), color: s.color.clone(), summary: s.summary.clone(),
            pos: s.pos.as_ref().map(|p| p.to_string()), trashed: s.deleted_at.is_some(),
            chapters: chs.iter().filter(|c| c.storylines.contains(&s.id)).count() as u32,
            fields: s.facts.iter().map(crate::dto::FieldInfo::from).collect(),
            has_chapter_template: super::template::has_template(
                cx, &dr_model::id::TemplateOwner::Storyline(s.id.clone()), s.chapter_template.as_deref())?,
        })).collect()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct StorylineCreateIn {
    pub book: String,
    /// A taken name gets a ` 2` suffix.
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default)]
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub place: Option<Place>,
    /// Initial description text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

op! {
    StorylineCreate = "storyline.create", Write, Book,
    "Create a storyline (a taken name gets a numbered suffix; the final name is returned). It starts with the book's storyline template fields.",
    fn(cx, input: StorylineCreateIn) -> Named {
        let slot = cx.book(&input.book)?;
        let name = unique_name(&input.name, UNTITLED_STORYLINE, live_names(&slot, None).iter().map(String::as_str));
        let items: Vec<(String, Option<PosKey>)> = storylines(&slot).iter().map(|s| (s.id.to_string(), s.pos.clone())).collect();
        let pos = pos_for(&items, input.place.as_ref().unwrap_or(&Place::Last))?;
        let id = StorylineId::new_v7();
        cx.summarize(format!("「{name}」"));
        super::chapter::seed_prose(cx, &slot.book, &DocId::Storyline(id.clone()), input.text.as_deref())?;
        let (i2, n2, c2, s2) = (id.clone(), name.clone(), input.color.clone().unwrap_or_else(|| DEFAULT_COLOR.into()), input.summary.clone());
        // The book's storyline template, copied (new ids, same order).
        let fields = super::template::copied(&meta(&slot).storyline_template);
        cx.write_book(&slot, move |txn| {
            let w = txn.storyline(&i2)?;
            w.name(&n2)?.color(&c2)?.summary(&s2)?.pos(&pos)?;
            for f in &fields { w.put_fact(f)?; }
            Ok(())
        })?;
        cx.effect(EffectAction::Created, "storyline", id.as_str(), Some(&name));
        cx.undo_with(Invocation::new("storyline.trash", EntityIn { book: input.book, id: id.to_string() }));
        Ok(Named { id: id.to_string(), name })
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct StorylineUpdateIn {
    pub book: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub put_fields: Vec<super::element::FieldIn>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub remove_fields: Vec<String>,
}

op! {
    StorylineUpdate = "storyline.update", Write, Book,
    "Rename a storyline (a taken name gets a suffix), recolour it, change its summary or its fields.",
    fn(cx, input: StorylineUpdateIn) -> Named {
        let slot = cx.book(&input.book)?;
        let old = find(&slot, &input.id)?;
        let name = input.name.as_ref().map(|n| unique_name(n, UNTITLED_STORYLINE, live_names(&slot, Some(&old.id)).iter().map(String::as_str)));
        let plan = super::element::plan_fields(&old.facts, &input.put_fields, &input.remove_fields)?;
        let (id, n2, c2, s2) = (old.id.clone(), name.clone(), input.color.clone(), input.summary.clone());
        let (f2, r2) = (plan.put.clone(), plan.removed.clone());
        cx.write_book(&slot, move |txn| {
            let w = txn.storyline(&id)?;
            if let Some(n) = &n2 { w.name(n)?; }
            if let Some(c) = &c2 { w.color(c)?; }
            if let Some(s) = &s2 { w.summary(s)?; }
            for f in &f2 { w.put_fact(f)?; }
            for f in &r2 { w.remove_fact(&f.id)?; }
            Ok(())
        })?;
        let final_name = name.clone().unwrap_or_else(|| old.name.clone());
        cx.effect(if name.is_some() { EffectAction::Renamed } else { EffectAction::Updated }, "storyline", &input.id, Some(&final_name));
        cx.undo_with(Invocation::new("storyline.update", StorylineUpdateIn {
            book: input.book.clone(), id: input.id.clone(),
            name: name.as_ref().map(|_| old.name.clone()),
            color: input.color.as_ref().map(|_| old.color.clone()),
            summary: input.summary.as_ref().map(|_| old.summary.clone()),
            put_fields: plan.undo_put,
            remove_fields: plan.undo_remove,
        }));
        Ok(Named { id: input.id, name: final_name })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct StorylineMoveIn {
    pub book: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub place: Option<Place>,
    /// An exact position key (undo uses it); wins over `place`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pos: Option<String>,
}

op! {
    StorylineMove = "storyline.move", Write, Book,
    "Move a storyline in the list (only its own position changes).",
    fn(cx, input: StorylineMoveIn) -> Done {
        let slot = cx.book(&input.book)?;
        let old = find(&slot, &input.id)?;
        let pos = match (&input.pos, &input.place) {
            (Some(p), _) => PosKey::parse(p).map_err(|e| WsError::invalid(e.to_string()))?,
            (None, Some(place)) => {
                let items: Vec<(String, Option<PosKey>)> = storylines(&slot).iter().filter(|s| s.id != old.id)
                    .map(|s| (s.id.to_string(), s.pos.clone())).collect();
                pos_for(&items, place)?
            }
            (None, None) => return Err(WsError::invalid("give place or pos")),
        };
        let id = old.id.clone();
        cx.write_book(&slot, move |txn| { txn.storyline(&id)?.pos(&pos)?; Ok(()) })?;
        cx.effect(EffectAction::Moved, "storyline", &input.id, Some(&old.name));
        match old.pos {
            Some(p) => cx.undo_with(Invocation::new("storyline.move", StorylineMoveIn { book: input.book.clone(), id: input.id.clone(), place: None, pos: Some(p.to_string()) })),
            None => cx.irreversible(),
        }
        Ok(Done { id: input.id })
    }
}

fn set_trashed(cx: &Cx<'_>, input: &EntityIn, trash: bool) -> Result<Named> {
    let slot = cx.book(&input.book)?;
    let old = find(&slot, &input.id)?;
    if trash == old.deleted_at.is_some() {
        cx.undo_nothing();
        return Ok(Named {
            id: input.id.clone(),
            name: old.name,
        });
    }
    let name = if trash {
        old.name.clone()
    } else {
        unique_name(
            &old.name,
            UNTITLED_STORYLINE,
            live_names(&slot, Some(&old.id)).iter().map(String::as_str),
        )
    };
    let target = EntityRef::new(EntityKind::Storyline, input.id.clone());
    if trash {
        trash_effects(cx, &slot, &target, true);
    }
    let (id, n2, renamed) = (old.id.clone(), name.clone(), name != old.name);
    let at = trash.then(now);
    cx.write_book(&slot, move |txn| {
        let w = txn.storyline(&id)?;
        w.deleted_at(at)?;
        if renamed {
            w.name(&n2)?;
        }
        Ok(())
    })?;
    if !trash {
        trash_effects(cx, &slot, &target, false);
    }
    cx.effect(
        if trash {
            EffectAction::Trashed
        } else {
            EffectAction::Restored
        },
        "storyline",
        &input.id,
        Some(&name),
    );
    cx.undo_with(Invocation::new(
        if trash {
            "storyline.restore"
        } else {
            "storyline.trash"
        },
        input,
    ));
    Ok(Named {
        id: input.id.clone(),
        name,
    })
}

op! {
    StorylineTrash = "storyline.trash", Write, Book,
    "Move a storyline to the trash. Never refused: chapters keep their membership, hidden until it is restored.",
    fn(cx, input: EntityIn) -> Named { set_trashed(cx, &input, true) }
}

op! {
    StorylineRestore = "storyline.restore", Write, Book,
    "Bring a storyline back from the trash, with its chapters' membership.",
    fn(cx, input: EntityIn) -> Named { set_trashed(cx, &input, false) }
}

op! {
    StorylinePurge = "storyline.purge", Write, Book,
    "Delete a storyline for good: chapters leave it, its relations go and comments on it become floating, in one commit.",
    fn(cx, input: EntityIn) -> Done {
        let slot = cx.book(&input.book)?;
        let old = find(&slot, &input.id)?;
        let target = EntityRef::new(EntityKind::Storyline, input.id.clone());
        let (rels, cmts) = purge_fallout(&slot, &target);
        let members: Vec<_> = nodes(&slot).values()
            .filter(|n| n.storylines.contains(&old.id) || n.primary_storyline.as_ref() == Some(&old.id))
            .map(|n| n.id.clone()).collect();
        let mut touched: Vec<(String, String)> = vec![("storylines".into(), input.id.clone())];
        touched.extend(rels.iter().map(|r| ("relations".to_string(), r.to_string())));
        touched.extend(cmts.iter().map(|c| ("comments".to_string(), c.to_string())));
        touched.extend(members.iter().map(|n| ("nodes".to_string(), n.to_string())));
        let (id, r2, c2, m2) = (old.id.clone(), rels.clone(), cmts.clone(), members.clone());
        let faults = cx.faults();
        let (_, before) = cx.write_book(&slot, move |txn| {
            for n in &m2 {
                let w = txn.node(n)?;
                w.remove_storyline(&id)?;
                if txn.view().node(n).and_then(|x| x.primary_storyline).as_ref() == Some(&id) {
                    txn.node(n)?.primary_storyline(None)?;
                }
            }
            faults.check("in_book")?;
            apply_fallout(txn, &r2, &c2)?;
            txn.purge(Collection::Storylines, id.as_str())?;
            Ok(())
        })?;
        report_fallout(cx, &rels, &cmts);
        for n in &members { cx.effect(EffectAction::Detached, "node", n.as_str(), None); }
        cx.effect(EffectAction::Purged, "storyline", &input.id, Some(&old.name));
        cx.undo_with(super::history::restore_invocation(&input.book, &before, touched));
        Ok(Done { id: input.id })
    }
}
