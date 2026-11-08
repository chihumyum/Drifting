//! Elements (要素) and categories (分类).

use std::collections::BTreeSet;

use dr_doc::book::Collection;
use dr_model::DocId;
use dr_model::book::{EntityRef, KvEntry, element_name_key};
use dr_model::id::{AssetId, CategoryId, ElementId, KvEntryId, TemplateOwner};
use dr_model::kind::{AssetKind, CategoryLayout, EntityKind};
use dr_model::pos::PosKey;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::*;
use crate::cx::{EffectAction, Invocation};
use crate::dto::{CategoryInfo, ElementInfo};
use crate::naming::{Place, pos_for, unique_name};
use crate::registry::Registry;

pub(crate) fn register(r: &mut Registry) {
    r.add::<ElementList>()
        .add::<ElementCreate>()
        .add::<ElementUpdate>()
        .add::<ElementTrash>()
        .add::<ElementRestore>()
        .add::<ElementPurge>()
        .add::<CategoryList>()
        .add::<CategoryCreate>()
        .add::<CategoryUpdate>()
        .add::<CategoryTrash>()
        .add::<CategoryRestore>()
        .add::<CategoryPurge>();
}

pub(crate) const NEW_ELEMENT: &str = "New Element";
const UNTITLED_CATEGORY: &str = "Untitled";
const DEFAULT_COLOR: &str = "#8A8A8A";

fn find(slot: &BookSlot, id: &str) -> Result<dr_model::book::Element> {
    elements(slot)
        .iter()
        .find(|e| e.id.as_str() == id)
        .cloned()
        .ok_or_else(|| WsError::not_found("element", id))
}

/// Name keys of live elements (names and aliases), and who holds each.
fn taken_names(slot: &BookSlot, except: Option<&ElementId>) -> Vec<(String, ElementId)> {
    elements(slot)
        .iter()
        .filter(|e| e.deleted_at.is_none() && Some(&e.id) != except)
        .flat_map(|e| {
            std::iter::once(e.name.clone())
                .chain(e.aliases.iter().cloned())
                .map(move |n| (element_name_key(&n), e.id.clone()))
        })
        .filter(|(k, _)| !k.is_empty())
        .collect()
}

/// Refuse a name or alias another live element has (`ELEMENT-NAME-UNIQUE`).
pub(crate) fn check_names<'a>(
    slot: &BookSlot,
    except: Option<&ElementId>,
    names: impl IntoIterator<Item = &'a str>,
) -> Result<()> {
    let taken = taken_names(slot, except);
    let mut seen = BTreeSet::new();
    for n in names {
        let k = element_name_key(n);
        if k.is_empty() {
            continue;
        }
        if let Some((_, holder)) = taken.iter().find(|(t, _)| *t == k) {
            return Err(WsError::NameTaken {
                kind: "element",
                id: holder.to_string(),
                name: n.trim().to_string(),
            });
        }
        if !seen.insert(k) {
            return Err(WsError::invalid(format!("{:?} is given twice", n.trim())));
        }
    }
    Ok(())
}

pub(crate) fn live_category(slot: &BookSlot, id: &str) -> Result<CategoryId> {
    let cid: CategoryId = pid("category", id)?;
    if categories(slot)
        .iter()
        .any(|c| c.id == cid && c.deleted_at.is_none())
    {
        Ok(cid)
    } else {
        Err(WsError::not_found("category", id))
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct ElementListIn {
    pub book: String,
    /// Only this category's elements.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default)]
    pub trashed: bool,
}

/// When `e` last changed, in seconds: the latest of its own fields'
/// stamp (`Cx::touch_element`; created_at before the first), and its body's
/// last stored edit (the local index's head, so typing counts without a
/// book write).
fn updated_at(
    lib: &dr_store::Library,
    stamps: &loro::LoroMap,
    e: &dr_model::book::Element,
) -> Option<i64> {
    let stamped = match stamps.get(e.id.as_str()) {
        Some(loro::ValueOrContainer::Container(loro::Container::Map(m))) => {
            match m.get(crate::cx::ELEMENT_UPDATED_AT) {
                Some(loro::ValueOrContainer::Value(loro::LoroValue::I64(t))) => Some(t),
                _ => None,
            }
        }
        _ => None,
    };
    let fields = stamped.or(e.created_at.map(|t| t.0));
    let body = super::prose_facts(lib, &DocId::Element(e.id.clone()).to_string()).edited_at;
    fields.max(body)
}

op! {
    ElementList = "element.list", Read, Shared,
    "List elements (with a mark on names a merge left duplicated).",
    fn(cx, input: ElementListIn) -> Vec<ElementInfo> {
        let slot = cx.book(&input.book)?;
        let lib = cx.workspace().library();
        let stamps = slot.handle.doc().get_map(Collection::Elements.root());
        Ok(elements(&slot).iter()
            .filter(|e| input.trashed || e.deleted_at.is_none())
            .filter(|e| input.category.as_ref().is_none_or(|c| e.category.as_ref().map(|x| x.as_str()) == Some(c.as_str())))
            .map(|e| {
                let mut info = ElementInfo::from(e);
                info.updated_at = updated_at(lib, &stamps, e);
                info
            })
            .collect())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ElementCreateIn {
    pub book: String,
    /// The element's name. A name another element has is refused, unless
    /// `numbered` (a placeholder name, numbered ` 2`, ` 3`…).
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub numbered: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default)]
    pub summary: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    /// Initial body text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

op! {
    ElementCreate = "element.create", Write, Book,
    "Create an element (it starts with its category's template fields, and its element template as the body when no text is given). A name or alias another element already has is refused (automatic links find people by name); the error names that element.",
    fn(cx, input: ElementCreateIn) -> Named {
        let slot = cx.book(&input.book)?;
        let name = if input.numbered || input.name.trim().is_empty() {
            let taken: Vec<String> = elements(&slot).iter().filter(|e| e.deleted_at.is_none())
                .flat_map(|e| std::iter::once(e.name.clone()).chain(e.aliases.iter().cloned())).collect();
            unique_name(&input.name, NEW_ELEMENT, taken.iter().map(String::as_str))
        } else {
            input.name.trim().to_string()
        };
        check_names(&slot, None, std::iter::once(name.as_str()).chain(input.aliases.iter().map(String::as_str)))?;
        let category = input.category.as_deref().map(|c| live_category(&slot, c)).transpose()?;
        let id = ElementId::new_v7();
        cx.summarize(format!("「{name}」"));
        // The category's element template seeds the body when no text is
        // given (the 0.1 interface's rule).
        let template = match (&input.text, category.as_ref()) {
            (None, Some(c)) => {
                let legacy = categories(&slot).iter().find(|x| &x.id == c).and_then(|x| x.element_template.clone());
                super::template::template_of(cx, &TemplateOwner::Category(c.clone()), legacy.as_deref())?
            }
            _ => None,
        };
        match template {
            Some(t) => super::template::apply_template(cx, &slot.book, &DocId::Element(id.clone()), t)?,
            None => super::chapter::seed_prose(cx, &slot.book, &DocId::Element(id.clone()), input.text.as_deref())?,
        }
        // Its names, linked in the text already written.
        let added: Vec<String> = std::iter::once(name.clone()).chain(input.aliases.iter().cloned()).collect();
        crate::autolink::backfill_element(cx, &slot, &id, &name, &input.aliases, &added)?;
        let (i2, n2, s2, a2) = (id.clone(), name.clone(), input.summary.clone(), input.aliases.clone());
        // The category's field template, copied (new ids, same order).
        let fields = category.as_ref()
            .and_then(|c| categories(&slot).iter().find(|x| &x.id == c).map(|x| super::template::copied(&x.template_fields)))
            .unwrap_or_default();
        cx.write_book(&slot, move |txn| {
            let w = txn.element(&i2)?;
            w.name(&n2)?.summary(&s2)?.category(category.as_ref())?.created_at(Some(now()))?;
            for a in &a2 { w.add_alias(a)?; }
            for f in &fields { w.put_fact(f)?; }
            Ok(())
        })?;
        cx.effect(EffectAction::Created, "element", id.as_str(), Some(&name));
        cx.undo_with(Invocation::new("element.trash", EntityIn { book: input.book, id: id.to_string() }));
        Ok(Named { id: id.to_string(), name })
    }
}

/// A field of an element's key/value list to add or change.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct FieldIn {
    /// Omitted: a new field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub key: String,
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub place: Option<Place>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pos: Option<String>,
}

/// What `put` and `remove` do to a key/value list `old` (an element's or a
/// storyline's fields), and how to undo it.
pub(crate) struct FieldPlan {
    pub put: Vec<KvEntry>,
    pub removed: Vec<KvEntry>,
    /// Fields to put back: the changed ones as they were, the removed ones.
    pub undo_put: Vec<FieldIn>,
    /// Fields to remove: the new ones.
    pub undo_remove: Vec<String>,
}

pub(crate) fn plan_fields(
    old: &[KvEntry],
    put: &[FieldIn],
    remove: &[String],
) -> Result<FieldPlan> {
    let mut plan = FieldPlan {
        put: Vec::new(),
        removed: Vec::new(),
        undo_put: Vec::new(),
        undo_remove: Vec::new(),
    };
    for f in put {
        name_ok(&f.key)?;
        let existing =
            f.id.as_ref()
                .map(|id| {
                    old.iter()
                        .find(|x| x.id.as_str() == id)
                        .cloned()
                        .ok_or_else(|| WsError::not_found("field", id))
                })
                .transpose()?;
        let id = existing
            .as_ref()
            .map(|e| e.id.clone())
            .unwrap_or_else(KvEntryId::new_v7);
        let others: Vec<(String, Option<PosKey>)> = old
            .iter()
            .filter(|x| x.id != id)
            .map(|x| (x.id.to_string(), x.pos.clone()))
            .collect();
        let pos = match (&f.pos, &f.place, &existing) {
            (Some(p), _, _) => Some(PosKey::parse(p).map_err(|e| WsError::invalid(e.to_string()))?),
            (None, Some(pl), _) => Some(pos_for(&others, pl)?),
            (None, None, Some(e)) => e.pos.clone(),
            (None, None, None) => Some(pos_for(&others, &Place::Last)?),
        };
        match &existing {
            Some(e) => plan.undo_put.push(FieldIn {
                id: Some(e.id.to_string()),
                key: e.key.clone(),
                value: e.value.clone(),
                place: None,
                pos: e.pos.as_ref().map(|p| p.to_string()),
            }),
            None => plan.undo_remove.push(id.to_string()),
        }
        plan.put.push(KvEntry {
            id,
            key: f.key.trim().to_string(),
            value: f.value.clone(),
            pos,
        });
    }
    plan.removed = remove
        .iter()
        .map(|id| {
            old.iter()
                .find(|x| x.id.as_str() == id)
                .cloned()
                .ok_or_else(|| WsError::not_found("field", id))
        })
        .collect::<Result<_>>()?;
    plan.undo_put.extend(plan.removed.iter().map(|e| FieldIn {
        id: None,
        key: e.key.clone(),
        value: e.value.clone(),
        place: None,
        pos: e.pos.as_ref().map(|p| p.to_string()),
    }));
    Ok(plan)
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct ElementUpdateIn {
    pub book: String,
    pub id: String,
    /// Refused if another element has it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// `null` leaves it uncategorized.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub category: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub group_name: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub portrait: Option<Option<String>>,
    /// Pin in the relation graph (`null` unpins).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub relate_pin: Option<Option<(f64, f64)>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub add_aliases: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub remove_aliases: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub put_fields: Vec<FieldIn>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub remove_fields: Vec<String>,
}

op! {
    ElementUpdate = "element.update", Write, Book,
    "Change an element: name, summary, category, aliases, fields, portrait, relation-graph pin. A name or alias another element has is refused.",
    fn(cx, input: ElementUpdateIn) -> Named {
        let slot = cx.book(&input.book)?;
        let old = find(&slot, &input.id)?;
        if let Some(n) = &input.name { name_ok(n)?; }
        // An alias equal to the element's own (new) name or to one of its
        // aliases adds nothing.
        let mut input = input;
        let own = element_name_key(input.name.as_deref().unwrap_or(&old.name));
        let mut have: BTreeSet<String> = old.aliases.iter().map(|a| element_name_key(a)).collect();
        input.add_aliases.retain(|a| {
            let k = element_name_key(a);
            !k.is_empty() && k != own && have.insert(k)
        });
        // Renaming to one of its own aliases promotes it: the alias goes.
        if input.name.is_some() {
            for a in &old.aliases {
                if element_name_key(a) == own && !input.remove_aliases.contains(a) {
                    input.remove_aliases.push(a.clone());
                }
            }
        }
        let mut names: Vec<&str> = input.name.iter().map(String::as_str).collect();
        names.extend(input.add_aliases.iter().map(String::as_str));
        check_names(&slot, Some(&old.id), names)?;
        let category: Option<Option<CategoryId>> = match &input.category {
            Some(Some(c)) => Some(Some(live_category(&slot, c)?)),
            Some(None) => Some(None),
            None => None,
        };
        let portrait: Option<Option<AssetId>> = match &input.portrait {
            Some(Some(a)) => {
                let id: AssetId = pid("asset", a)?;
                if !assets(&slot).iter().any(|x| x.id == id && x.kind == AssetKind::Image) {
                    return Err(WsError::not_found("image asset", a));
                }
                Some(Some(id))
            }
            Some(None) => Some(None),
            None => None,
        };
        if let Some(Some((x, y))) = input.relate_pin && !(x.is_finite() && y.is_finite()) {
            return Err(WsError::invalid("pin coordinates must be finite"));
        }
        let FieldPlan { put: fields, removed, undo_put: field_undo, undo_remove: field_removed_new } =
            plan_fields(&old.facts, &input.put_fields, &input.remove_fields)?;
        // New names (a new name, added aliases), linked in the text
        // already written.
        let renamed = input.name.as_ref().map(|n| n.trim().to_string()).filter(|n| *n != old.name);
        if renamed.is_some() || !input.add_aliases.is_empty() {
            let name = renamed.clone().unwrap_or_else(|| old.name.clone());
            let aliases: Vec<String> = old.aliases.iter().filter(|a| !input.remove_aliases.contains(a))
                .chain(input.add_aliases.iter()).cloned().collect();
            let added: Vec<String> = renamed.iter().cloned().chain(input.add_aliases.iter().cloned()).collect();
            crate::autolink::backfill_element(cx, &slot, &old.id, &name, &aliases, &added)?;
        }
        cx.touch_element(&old.id);
        let id = old.id.clone();
        let i = input.clone();
        let (f2, r2) = (fields.clone(), removed.clone());
        cx.write_book(&slot, move |txn| {
            let w = txn.element(&id)?;
            if let Some(n) = &i.name { w.name(n.trim())?; }
            if let Some(s) = &i.summary { w.summary(s)?; }
            if let Some(c) = &category { w.category(c.as_ref())?; }
            if let Some(g) = &i.group_name { w.group_name(g.as_deref())?; }
            if let Some(p) = &portrait { w.portrait(p.as_ref())?; }
            if let Some(p) = i.relate_pin { w.relate_pin(p)?; }
            for a in &i.add_aliases { w.add_alias(a)?; }
            for a in &i.remove_aliases { w.remove_alias(a)?; }
            for f in &f2 { w.put_fact(f)?; }
            for f in &r2 { w.remove_fact(&f.id)?; }
            Ok(())
        })?;
        let name = input.name.as_ref().map(|n| n.trim().to_string()).unwrap_or_else(|| old.name.clone());
        cx.effect(if input.name.is_some() { EffectAction::Renamed } else { EffectAction::Updated }, "element", &input.id, Some(&name));
        let back_fields = field_undo;
        cx.undo_with(Invocation::new("element.update", ElementUpdateIn {
            book: input.book.clone(), id: input.id.clone(),
            name: input.name.as_ref().map(|_| old.name.clone()),
            summary: input.summary.as_ref().map(|_| old.summary.clone()),
            category: input.category.as_ref().map(|_| old.category.as_ref().map(|c| c.to_string())),
            group_name: input.group_name.as_ref().map(|_| old.group_name.clone()),
            portrait: input.portrait.as_ref().map(|_| old.portrait.as_ref().map(|p| p.to_string())),
            relate_pin: input.relate_pin.map(|_| old.relate_pin),
            add_aliases: input.remove_aliases.iter().filter(|a| old.aliases.contains(a.trim())).cloned().collect(),
            remove_aliases: input.add_aliases.iter().filter(|a| !old.aliases.contains(a.trim())).cloned().collect(),
            put_fields: back_fields,
            remove_fields: field_removed_new,
        }));
        Ok(Named { id: input.id, name })
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
    // A name taken while it was in the trash gets a suffix on restore, so
    // names stay unique (an undo must not fail on it).
    let name = if trash {
        old.name.clone()
    } else {
        let taken: Vec<String> = taken_names(&slot, Some(&old.id))
            .into_iter()
            .map(|(k, _)| k)
            .collect();
        unique_name(&old.name, NEW_ELEMENT, taken.iter().map(String::as_str))
    };
    let clashing_aliases: Vec<String> = if trash {
        Vec::new()
    } else {
        let taken: Vec<String> = taken_names(&slot, Some(&old.id))
            .into_iter()
            .map(|(k, _)| k)
            .collect();
        old.aliases
            .iter()
            .filter(|a| taken.contains(&element_name_key(a)))
            .cloned()
            .collect()
    };
    let target = EntityRef::new(EntityKind::Element, input.id.clone());
    if trash {
        trash_effects(cx, &slot, &target, true);
    }
    let (id, n2, renamed, ca) = (
        old.id.clone(),
        name.clone(),
        name != old.name,
        clashing_aliases.clone(),
    );
    let at = trash.then(now);
    cx.write_book(&slot, move |txn| {
        let w = txn.element(&id)?;
        w.deleted_at(at)?;
        if renamed {
            w.name(&n2)?;
        }
        for a in &ca {
            w.remove_alias(a)?;
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
        "element",
        &input.id,
        Some(&name),
    );
    cx.undo_with(Invocation::new(
        if trash {
            "element.restore"
        } else {
            "element.trash"
        },
        input,
    ));
    Ok(Named {
        id: input.id.clone(),
        name,
    })
}

op! {
    ElementTrash = "element.trash", Write, Book,
    "Move an element to the trash. Never refused: its relations are hidden and comments on it unlocated until it is restored.",
    fn(cx, input: EntityIn) -> Named { set_trashed(cx, &input, true) }
}

op! {
    ElementRestore = "element.restore", Write, Book,
    "Bring an element back from the trash (a name taken meanwhile gets a suffix).",
    fn(cx, input: EntityIn) -> Named { set_trashed(cx, &input, false) }
}

op! {
    ElementPurge = "element.purge", Write, Book,
    "Delete an element for good: its relations and patches go, comments on it become floating, in one commit.",
    fn(cx, input: EntityIn) -> Done {
        let slot = cx.book(&input.book)?;
        let old = find(&slot, &input.id)?;
        let target = EntityRef::new(EntityKind::Element, input.id.clone());
        let (rels, cmts) = purge_fallout(&slot, &target);
        let patches: Vec<_> = slot.reader.view().patches_of(&old.id).into_iter().map(|p| p.id).collect();
        let mut touched: Vec<(String, String)> = vec![("elements".into(), input.id.clone())];
        touched.extend(rels.iter().map(|r| ("relations".to_string(), r.to_string())));
        touched.extend(cmts.iter().map(|c| ("comments".to_string(), c.to_string())));
        touched.extend(patches.iter().map(|p| ("patches".to_string(), p.to_string())));
        let (id, r2, c2, p2) = (old.id.clone(), rels.clone(), cmts.clone(), patches.clone());
        let (_, before) = cx.write_book(&slot, move |txn| {
            apply_fallout(txn, &r2, &c2)?;
            for p in &p2 { txn.purge(Collection::Patches, p.as_str())?; }
            txn.purge(Collection::Elements, id.as_str())?;
            Ok(())
        })?;
        report_fallout(cx, &rels, &cmts);
        for p in &patches { cx.effect(EffectAction::Purged, "patch", p.as_str(), None); }
        cx.effect(EffectAction::Purged, "element", &input.id, Some(&old.name));
        cx.undo_with(super::history::restore_invocation(&input.book, &before, touched));
        Ok(Done { id: input.id })
    }
}

// ---- categories -------------------------------------------------------------

fn find_category(slot: &BookSlot, id: &str) -> Result<dr_model::book::Category> {
    categories(slot)
        .iter()
        .find(|c| c.id.as_str() == id)
        .cloned()
        .ok_or_else(|| WsError::not_found("category", id))
}

fn category_names(slot: &BookSlot, except: Option<&CategoryId>) -> Vec<String> {
    categories(slot)
        .iter()
        .filter(|c| c.deleted_at.is_none() && Some(&c.id) != except)
        .map(|c| c.name.clone())
        .collect()
}

op! {
    CategoryList = "category.list", Read, Shared,
    "List element categories, with how many live elements each has.",
    fn(cx, input: ListIn) -> Vec<CategoryInfo> {
        let slot = cx.book(&input.book)?;
        let els = elements(&slot);
        categories(&slot).iter().filter(|c| input.trashed || c.deleted_at.is_none()).map(|c| Ok(CategoryInfo {
            id: c.id.to_string(), name: c.name.clone(), color: c.color.clone(), layout: c.layout.as_str().to_string(),
            grid_x: c.grid_x, grid_y: c.grid_y, trashed: c.deleted_at.is_some(),
            elements: els.iter().filter(|e| e.deleted_at.is_none() && e.category.as_ref() == Some(&c.id)).count() as u32,
            template_fields: c.template_fields.iter().map(crate::dto::FieldInfo::from).collect(),
            has_element_template: super::template::has_template(
                cx, &TemplateOwner::Category(c.id.clone()), c.element_template.as_deref())?,
        })).collect()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct CategoryCreateIn {
    pub book: String,
    /// A taken name gets a ` 2` suffix; empty becomes "Untitled".
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

op! {
    CategoryCreate = "category.create", Write, Book,
    "Create an element category (a taken name gets a numbered suffix; the final name is returned).",
    fn(cx, input: CategoryCreateIn) -> Named {
        let slot = cx.book(&input.book)?;
        let name = unique_name(&input.name, UNTITLED_CATEGORY, category_names(&slot, None).iter().map(String::as_str));
        let id = CategoryId::new_v7();
        super::chapter::seed_prose(cx, &slot.book, &DocId::Category(id.clone()), input.text.as_deref())?;
        let (i2, n2, c2) = (id.clone(), name.clone(), input.color.clone().unwrap_or_else(|| DEFAULT_COLOR.into()));
        cx.write_book(&slot, move |txn| {
            txn.category(&i2)?.name(&n2)?.color(&c2)?.layout(&CategoryLayout::Auto)?;
            Ok(())
        })?;
        cx.effect(EffectAction::Created, "category", id.as_str(), Some(&name));
        cx.undo_with(Invocation::new("category.trash", EntityIn { book: input.book, id: id.to_string() }));
        Ok(Named { id: id.to_string(), name })
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct CategoryUpdateIn {
    pub book: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// `auto` or `pinned`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub grid: Option<Option<(i64, i64)>>,
}

op! {
    CategoryUpdate = "category.update", Write, Book,
    "Rename a category (a taken name gets a suffix), recolour it or change its layout.",
    fn(cx, input: CategoryUpdateIn) -> Named {
        let slot = cx.book(&input.book)?;
        let old = find_category(&slot, &input.id)?;
        let name = input.name.as_ref().map(|n| unique_name(n, UNTITLED_CATEGORY, category_names(&slot, Some(&old.id)).iter().map(String::as_str)));
        let layout = input.layout.as_deref().map(CategoryLayout::parse);
        if let Some(l) = &layout && !l.is_known() { return Err(WsError::invalid(format!("unknown layout {:?}", l.as_str()))); }
        let (id, n2, c2, l2, g2) = (old.id.clone(), name.clone(), input.color.clone(), layout.clone(), input.grid);
        cx.write_book(&slot, move |txn| {
            let w = txn.category(&id)?;
            if let Some(n) = &n2 { w.name(n)?; }
            if let Some(c) = &c2 { w.color(c)?; }
            if let Some(l) = &l2 { w.layout(l)?; }
            if let Some(g) = g2 { w.grid_x(g.map(|g| g.0))?.grid_y(g.map(|g| g.1))?; }
            Ok(())
        })?;
        let final_name = name.clone().unwrap_or_else(|| old.name.clone());
        cx.effect(if name.is_some() { EffectAction::Renamed } else { EffectAction::Updated }, "category", &input.id, Some(&final_name));
        cx.undo_with(Invocation::new("category.update", CategoryUpdateIn {
            book: input.book.clone(), id: input.id.clone(),
            name: name.as_ref().map(|_| old.name.clone()),
            color: input.color.as_ref().map(|_| old.color.clone()),
            layout: layout.as_ref().map(|_| old.layout.as_str().to_string()),
            grid: input.grid.map(|_| old.grid_x.zip(old.grid_y)),
        }));
        Ok(Named { id: input.id, name: final_name })
    }
}

fn set_category_trashed(cx: &Cx<'_>, input: &EntityIn, trash: bool) -> Result<Named> {
    let slot = cx.book(&input.book)?;
    let old = find_category(&slot, &input.id)?;
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
            UNTITLED_CATEGORY,
            category_names(&slot, Some(&old.id))
                .iter()
                .map(String::as_str),
        )
    };
    let target = EntityRef::new(EntityKind::Category, input.id.clone());
    // Its elements read as uncategorized while it is in the trash.
    let members: Vec<_> = slot
        .reader
        .view()
        .elements()
        .into_iter()
        .filter(|e| e.deleted_at.is_none())
        .collect();
    if trash {
        trash_effects(cx, &slot, &target, true);
        for e in members
            .iter()
            .filter(|e| e.category.as_ref() == Some(&old.id))
        {
            cx.effect(
                EffectAction::Hidden,
                "element_category",
                e.id.as_str(),
                Some(&e.name),
            );
        }
    }
    let (id, n2, renamed) = (old.id.clone(), name.clone(), name != old.name);
    let at = trash.then(now);
    cx.write_book(&slot, move |txn| {
        let w = txn.category(&id)?;
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
        "category",
        &input.id,
        Some(&name),
    );
    cx.undo_with(Invocation::new(
        if trash {
            "category.restore"
        } else {
            "category.trash"
        },
        input,
    ));
    Ok(Named {
        id: input.id.clone(),
        name,
    })
}

op! {
    CategoryTrash = "category.trash", Write, Book,
    "Move a category to the trash. Never refused: its elements read as uncategorized until it is restored.",
    fn(cx, input: EntityIn) -> Named { set_category_trashed(cx, &input, true) }
}

op! {
    CategoryRestore = "category.restore", Write, Book,
    "Bring a category back from the trash, with its elements.",
    fn(cx, input: EntityIn) -> Named { set_category_trashed(cx, &input, false) }
}

op! {
    CategoryPurge = "category.purge", Write, Book,
    "Delete a category for good: its elements become uncategorized, its relations go and comments on it become floating, in one commit.",
    fn(cx, input: EntityIn) -> Done {
        let slot = cx.book(&input.book)?;
        let old = find_category(&slot, &input.id)?;
        let target = EntityRef::new(EntityKind::Category, input.id.clone());
        let (rels, cmts) = purge_fallout(&slot, &target);
        // Raw element values: a trashed category already reads as none.
        let members: Vec<ElementId> = raw_members(&slot, &old.id);
        let mut touched: Vec<(String, String)> = vec![("categories".into(), input.id.clone())];
        touched.extend(rels.iter().map(|r| ("relations".to_string(), r.to_string())));
        touched.extend(cmts.iter().map(|c| ("comments".to_string(), c.to_string())));
        touched.extend(members.iter().map(|e| ("elements".to_string(), e.to_string())));
        let (id, r2, c2, m2) = (old.id.clone(), rels.clone(), cmts.clone(), members.clone());
        let (_, before) = cx.write_book(&slot, move |txn| {
            for e in &m2 { txn.element(e)?.category(None)?; }
            apply_fallout(txn, &r2, &c2)?;
            txn.purge(Collection::Categories, id.as_str())?;
            Ok(())
        })?;
        report_fallout(cx, &rels, &cmts);
        for e in &members { cx.effect(EffectAction::Detached, "element", e.as_str(), None); }
        cx.effect(EffectAction::Purged, "category", &input.id, Some(&old.name));
        cx.undo_with(super::history::restore_invocation(&input.book, &before, touched));
        Ok(Done { id: input.id })
    }
}

/// Elements whose stored category is `cat` (live or trashed category alike).
fn raw_members(slot: &BookSlot, cat: &CategoryId) -> Vec<ElementId> {
    let doc = slot.handle.doc();
    let root = doc.get_map(Collection::Elements.root());
    let loro::LoroValue::Map(all) = root.get_deep_value() else {
        return Vec::new();
    };
    all.iter()
        .filter_map(|(id, v)| match v {
            loro::LoroValue::Map(f) => match f.get("category") {
                Some(loro::LoroValue::String(c)) if c.as_str() == cat.as_str() => {
                    ElementId::parse(id).ok()
                }
                _ => None,
            },
            _ => None,
        })
        .collect()
}
