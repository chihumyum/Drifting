//! Field templates (字段模版): the fields every new storyline starts with
//! (the book's storyline template, on Project Home) and the fields every new
//! element of a category starts with (the category's template). The 0.1
//! interface's rules (`KvEditor`, `useStoryline`, `useBookElement`):
//!
//! - A template is copied when the storyline or element is created (new
//!   field ids, same order); changing the template later never changes
//!   existing ones, and moving an element to another category does not
//!   apply that category's template.
//! - A field is a key and a value (the value is a default or a hint),
//!   neither trimmed; keys may repeat; only a field with both empty is
//!   refused (0.1 dropped it on save).
//! - The 0.1 Agent could change only a category's template, by replacing the
//!   whole list and trimming keys; F3 has the interface's per-field commands
//!   for both templates.
//!
//! The body templates (a category's element template, a storyline's chapter
//! template) stay as 0.1 stored them: to edit and merge them they need a
//! prose document of their own (F1's 待协调 6); no command writes them yet.

use dr_model::book::KvEntry;
use dr_model::id::{CategoryId, KvEntryId};
use dr_model::pos::PosKey;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::*;
use crate::cx::{EffectAction, Invocation};
use crate::dto::FieldInfo;
use crate::naming::{Place, pos_for};
use crate::registry::Registry;

pub(crate) fn register(r: &mut Registry) {
    r.add::<StorylineTemplateList>()
        .add::<StorylineTemplatePut>()
        .add::<StorylineTemplateRemove>()
        .add::<CategoryTemplateList>()
        .add::<CategoryTemplatePut>()
        .add::<CategoryTemplateRemove>();
}

/// Copies of `template` with new ids, in the same order: what a new
/// storyline or element starts with.
pub(crate) fn copied(template: &[KvEntry]) -> Vec<KvEntry> {
    template
        .iter()
        .map(|e| KvEntry {
            id: KvEntryId::new_v7(),
            key: e.key.clone(),
            value: e.value.clone(),
            pos: e.pos.clone(),
        })
        .collect()
}

fn live_category(slot: &BookSlot, id: &str) -> Result<dr_model::book::Category> {
    categories(slot)
        .iter()
        .find(|c| c.id.as_str() == id && c.deleted_at.is_none())
        .cloned()
        .ok_or_else(|| WsError::not_found("category", id))
}

/// A field to add or change in a template.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct TemplateFieldIn {
    pub book: String,
    /// The category, for a category's template.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// The field to change; omitted, or an id not in the template: a new
    /// field (with that id).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default)]
    pub key: String,
    /// A default or a hint, copied into new storylines or elements.
    #[serde(default)]
    pub value: String,
    /// Where it goes (a new field goes last by default).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub place: Option<Place>,
    /// An exact position key (undo uses it); wins over `place`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pos: Option<String>,
}

/// The entry `input` asks for, given the template as it is.
fn entry_for(list: &[KvEntry], input: &TemplateFieldIn) -> Result<(KvEntry, Option<KvEntry>)> {
    if input.key.trim().is_empty() && input.value.trim().is_empty() {
        return Err(WsError::invalid("a template field needs a key or a value"));
    }
    // An id that is not there makes a field with that id (a removal's undo).
    let existing = input
        .id
        .as_ref()
        .and_then(|id| list.iter().find(|f| f.id.as_str() == id).cloned());
    let id = match (&existing, &input.id) {
        (Some(f), _) => f.id.clone(),
        (None, Some(id)) => pid::<KvEntryId>("template field", id)?,
        (None, None) => KvEntryId::new_v7(),
    };
    let others: Vec<(String, Option<PosKey>)> = list
        .iter()
        .filter(|f| f.id != id)
        .map(|f| (f.id.to_string(), f.pos.clone()))
        .collect();
    let pos = match (&input.pos, &input.place, &existing) {
        (Some(p), _, _) => Some(PosKey::parse(p).map_err(|e| WsError::invalid(e.to_string()))?),
        (None, Some(place), _) => Some(pos_for(&others, place)?),
        (None, None, Some(f)) => f.pos.clone(),
        (None, None, None) => Some(pos_for(&others, &Place::Last)?),
    };
    Ok((
        KvEntry {
            id,
            key: input.key.clone(),
            value: input.value.clone(),
            pos,
        },
        existing,
    ))
}

/// The inverse of a put: put back the old field, or remove the new one.
fn put_undo(
    cx: &Cx<'_>,
    input: &TemplateFieldIn,
    entry: &KvEntry,
    old: Option<KvEntry>,
    remove: &'static str,
) {
    match old {
        Some(old) => cx.undo_with(Invocation::new(
            if input.category.is_some() {
                "category_template.put"
            } else {
                "storyline_template.put"
            },
            TemplateFieldIn {
                book: input.book.clone(),
                category: input.category.clone(),
                id: Some(old.id.to_string()),
                key: old.key,
                value: old.value,
                place: None,
                pos: old.pos.map(|p| p.to_string()),
            },
        )),
        None => cx.undo_with(Invocation::new(
            remove,
            TemplateFieldRef {
                book: input.book.clone(),
                category: input.category.clone(),
                id: entry.id.to_string(),
            },
        )),
    }
}

/// One field of a template.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct TemplateFieldRef {
    pub book: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    pub id: String,
}

// ---- the book's storyline template ---------------------------------------------

op! {
    StorylineTemplateList = "storyline_template.list", Read, Shared,
    "List the fields every new storyline starts with, in order.",
    fn(cx, input: BookIn) -> Vec<FieldInfo> {
        let slot = cx.book(&input.book)?;
        Ok(meta(&slot).storyline_template.iter().map(FieldInfo::from).collect())
    }
}

op! {
    StorylineTemplatePut = "storyline_template.put", Write, Book,
    "Add a field to the storyline template or change one (key, value, position). Existing storylines keep their fields.",
    fn(cx, input: TemplateFieldIn) -> Done {
        let slot = cx.book(&input.book)?;
        if input.category.is_some() {
            return Err(WsError::invalid("the storyline template belongs to the book; leave out category"));
        }
        let (entry, old) = entry_for(&meta(&slot).storyline_template, &input)?;
        let e2 = entry.clone();
        cx.write_book(&slot, move |txn| { txn.meta().put_storyline_template_field(&e2)?; Ok(()) })?;
        cx.effect(if old.is_some() { EffectAction::Updated } else { EffectAction::Created }, "template_field", entry.id.as_str(), Some(&entry.key));
        put_undo(cx, &input, &entry, old, "storyline_template.remove");
        Ok(Done { id: entry.id.to_string() })
    }
}

op! {
    StorylineTemplateRemove = "storyline_template.remove", Write, Book,
    "Remove a field from the storyline template. Existing storylines keep theirs.",
    fn(cx, input: TemplateFieldRef) -> Done {
        let slot = cx.book(&input.book)?;
        let old = meta(&slot).storyline_template.iter().find(|f| f.id.as_str() == input.id).cloned()
            .ok_or_else(|| WsError::not_found("template field", &input.id))?;
        let id = old.id.clone();
        cx.write_book(&slot, move |txn| { txn.meta().remove_storyline_template_field(&id)?; Ok(()) })?;
        cx.effect(EffectAction::Purged, "template_field", &input.id, Some(&old.key));
        cx.undo_with(Invocation::new("storyline_template.put", TemplateFieldIn {
            book: input.book.clone(), category: None, id: Some(input.id.clone()), key: old.key, value: old.value,
            place: None, pos: old.pos.map(|p| p.to_string()),
        }));
        Ok(Done { id: input.id })
    }
}

// ---- a category's element template ------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct CategoryIn {
    pub book: String,
    pub category: String,
}

op! {
    CategoryTemplateList = "category_template.list", Read, Shared,
    "List the fields every new element of a category starts with, in order.",
    fn(cx, input: CategoryIn) -> Vec<FieldInfo> {
        let slot = cx.book(&input.book)?;
        Ok(live_category(&slot, &input.category)?.template_fields.iter().map(FieldInfo::from).collect())
    }
}

op! {
    CategoryTemplatePut = "category_template.put", Write, Book,
    "Add a field to a category's template or change one (key, value, position). Existing elements keep their fields.",
    fn(cx, input: TemplateFieldIn) -> Done {
        let slot = cx.book(&input.book)?;
        let cat_id = input.category.clone().ok_or_else(|| WsError::invalid("category is required"))?;
        let cat = live_category(&slot, &cat_id)?;
        let (entry, old) = entry_for(&cat.template_fields, &input)?;
        let (c2, e2) = (cat.id.clone(), entry.clone());
        cx.write_book(&slot, move |txn| { txn.category(&c2)?.put_template_field(&e2)?; Ok(()) })?;
        cx.effect(if old.is_some() { EffectAction::Updated } else { EffectAction::Created }, "template_field", entry.id.as_str(), Some(&entry.key));
        put_undo(cx, &input, &entry, old, "category_template.remove");
        Ok(Done { id: entry.id.to_string() })
    }
}

op! {
    CategoryTemplateRemove = "category_template.remove", Write, Book,
    "Remove a field from a category's template. Existing elements keep theirs.",
    fn(cx, input: TemplateFieldRef) -> Done {
        let slot = cx.book(&input.book)?;
        let cat_id = input.category.clone().ok_or_else(|| WsError::invalid("category is required"))?;
        let cat = live_category(&slot, &cat_id)?;
        let old = cat.template_fields.iter().find(|f| f.id.as_str() == input.id).cloned()
            .ok_or_else(|| WsError::not_found("template field", &input.id))?;
        let (c2, id): (CategoryId, KvEntryId) = (cat.id.clone(), old.id.clone());
        cx.write_book(&slot, move |txn| { txn.category(&c2)?.remove_template_field(&id)?; Ok(()) })?;
        cx.effect(EffectAction::Purged, "template_field", &input.id, Some(&old.key));
        cx.undo_with(Invocation::new("category_template.put", TemplateFieldIn {
            book: input.book.clone(), category: Some(cat_id), id: Some(input.id.clone()), key: old.key, value: old.value,
            place: None, pos: old.pos.map(|p| p.to_string()),
        }));
        Ok(Done { id: input.id })
    }
}
