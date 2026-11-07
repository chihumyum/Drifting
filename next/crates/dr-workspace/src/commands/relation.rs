//! Relations and relation types.

use dr_doc::book::{Collection, generic_relation_type_id};
use dr_model::book::{RelationType, normalize_relation_type_name};
use dr_model::id::{RelationId, RelationTypeId};
use dr_model::kind::{EntityKind, RelationOrientation};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::*;
use crate::cx::{EffectAction, Invocation};
use crate::dto::{RelationInfo, RelationTypeInfo, Target};
use crate::registry::Registry;

pub(crate) fn register(r: &mut Registry) {
    r.add::<RelationList>()
        .add::<RelationCreate>()
        .add::<RelationDelete>()
        .add::<RelationTypeList>()
        .add::<RelationTypeCreate>()
        .add::<RelationTypeUpdate>()
        .add::<RelationTypeDelete>();
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct RelationListIn {
    pub book: String,
    /// Only relations touching this entity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entity: Option<Target>,
    /// Only relations of this type.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relation_type: Option<String>,
}

op! {
    RelationList = "relation.list", Read, Shared,
    "List the relations to show (both ends live, one per semantic edge).",
    fn(cx, input: RelationListIn) -> Vec<RelationInfo> {
        let slot = cx.book(&input.book)?;
        let e = input.entity.as_ref().map(Target::to_ref);
        // One entity's relations right after a write: F1's `relations_of`
        // checks only that entity's relations, where filling the cache would
        // check every relation of the book.
        let list = match (&e, slot.cache.peek::<Vec<dr_model::book::Relation>>(crate::cache::Key::Relations)) {
            (_, Some(all)) => all,
            (Some(e), None) => std::sync::Arc::new(slot.reader.view().relations_of(e)),
            (None, None) => relations(&slot),
        };
        Ok(list.iter()
            .filter(|r| e.as_ref().is_none_or(|e| &r.from == e || &r.to == e))
            .filter(|r| input.relation_type.as_ref().is_none_or(|t| r.relation_type.as_str() == t))
            .map(RelationInfo::from).collect())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct RelationCreateIn {
    pub book: String,
    pub from: Target,
    pub to: Target,
    /// The relation type; omitted for a comment or material linked to the
    /// book's structure (the built-in association).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relation_type: Option<String>,
    /// Keep this id (undo uses it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct RelationMade {
    pub id: String,
    /// The same relation existed already; nothing was written.
    pub existing: bool,
}

op! {
    RelationCreate = "relation.create", Write, Book,
    "Relate two entities (a symmetric type stores its ends in canonical order; an existing identical relation is returned instead).",
    fn(cx, input: RelationCreateIn) -> RelationMade {
        let slot = cx.book(&input.book)?;
        let (from, to) = (input.from.to_ref(), input.to.to_ref());
        let type_id: RelationTypeId = match &input.relation_type {
            Some(t) => pid("relation type", t)?,
            None if matches!(from.kind, EntityKind::Comment | EntityKind::Material) => generic_relation_type_id(&slot.book),
            None => return Err(WsError::invalid("relation_type is required")),
        };
        let t = relation_types(&slot).iter().find(|x| x.id == type_id).cloned()
            .ok_or_else(|| WsError::not_found("relation type", type_id.as_str()))?;
        let (from, to) = dr_model::check::relation_ends(&t, from, to)?;
        require_live(&slot, from.kind.clone(), &from.id)?;
        require_live(&slot, to.kind.clone(), &to.id)?;
        let symmetric = t.orientation == RelationOrientation::Symmetric;
        if let Some(r) = relations_raw(&slot).iter().find(|r| r.relation_type == type_id && (
            (r.from == from && r.to == to) || (symmetric && r.from == to && r.to == from))) {
            cx.undo_nothing();
            return Ok(RelationMade { id: r.id.to_string(), existing: true });
        }
        let id: RelationId = match &input.id { Some(i) => pid("relation", i)?, None => RelationId::new_v7() };
        let i2 = id.clone();
        cx.write_book(&slot, move |txn| {
            txn.relation(&i2)?.ends(&from, &to)?.relation_type(&type_id)?.created_at(Some(now()))?;
            Ok(())
        })?;
        cx.effect(EffectAction::Created, "relation", id.as_str(), None);
        cx.undo_with(Invocation::new("relation.delete", EntityIn { book: input.book, id: id.to_string() }));
        Ok(RelationMade { id: id.to_string(), existing: false })
    }
}

op! {
    RelationDelete = "relation.delete", Write, Book,
    "Delete a relation.",
    fn(cx, input: EntityIn) -> Done {
        let slot = cx.book(&input.book)?;
        let id: RelationId = pid("relation", &input.id)?;
        if !relations_raw(&slot).iter().any(|r| r.id == id) {
            return Err(WsError::not_found("relation", &input.id));
        }
        let i2 = id.clone();
        let (_, before) = cx.write_book(&slot, move |txn| { txn.purge(Collection::Relations, i2.as_str())?; Ok(()) })?;
        cx.effect(EffectAction::Purged, "relation", &input.id, None);
        cx.undo_with(super::history::restore_invocation(&input.book, &before, vec![("relations".into(), input.id.clone())]));
        Ok(Done { id: input.id })
    }
}

op! {
    RelationTypeList = "relation_type.list", Read, Shared,
    "List relation types (the built-in one is marked locked).",
    fn(cx, input: BookIn) -> Vec<RelationTypeInfo> {
        let slot = cx.book(&input.book)?;
        Ok(relation_types(&slot).iter().map(RelationTypeInfo::from).collect())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct RelationTypeCreateIn {
    pub book: String,
    pub name: String,
    /// `directed` (default) or `symmetric`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orientation: Option<String>,
    /// Entity kinds allowed at the start (`node`, `element`, …).
    pub source_kinds: Vec<String>,
    pub target_kinds: Vec<String>,
    #[serde(default)]
    pub source_role: String,
    #[serde(default)]
    pub target_role: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

fn type_by_name<'a>(
    types: &'a [RelationType],
    name: &str,
    except: Option<&RelationTypeId>,
) -> Option<&'a RelationType> {
    let n = normalize_relation_type_name(name);
    types
        .iter()
        .find(|t| t.normalized_name == n && Some(&t.id) != except)
}

op! {
    RelationTypeCreate = "relation_type.create", Write, Book,
    "Create a relation type. A name another type has is refused (`RT-NAME`); the error names that type.",
    fn(cx, input: RelationTypeCreateIn) -> Named {
        let slot = cx.book(&input.book)?;
        let orientation = RelationOrientation::parse(input.orientation.as_deref().unwrap_or("directed"));
        let kinds = |v: &[String]| v.iter().map(|k| EntityKind::parse(k)).collect::<Vec<_>>();
        let id = RelationTypeId::new_v7();
        let t = RelationType {
            id: id.clone(), name: input.name.trim().to_string(), normalized_name: normalize_relation_type_name(&input.name),
            description: input.description.clone(), orientation, system_key: None, locked: false,
            source_role: input.source_role.trim().to_string(), target_role: input.target_role.trim().to_string(),
            color: input.color.clone(), source_kinds: kinds(&input.source_kinds), target_kinds: kinds(&input.target_kinds),
        };
        dr_model::check::relation_type_definition(&t)?;
        if let Some(other) = type_by_name(&relation_types(&slot), &t.name, None) {
            return Err(WsError::NameTaken { kind: "relation_type", id: other.id.to_string(), name: t.name.clone() });
        }
        let t2 = t.clone();
        cx.write_book(&slot, move |txn| {
            txn.relation_type(&t2.id)?.name(&t2.name)?.description(&t2.description)?.orientation(&t2.orientation)?
                .source_role(&t2.source_role)?.target_role(&t2.target_role)?
                .source_kinds(&t2.source_kinds)?.target_kinds(&t2.target_kinds)?.color(t2.color.as_deref())?;
            Ok(())
        })?;
        cx.effect(EffectAction::Created, "relation_type", id.as_str(), Some(&t.name));
        cx.undo_with(Invocation::new("relation_type.delete", EntityIn { book: input.book, id: id.to_string() }));
        Ok(Named { id: id.to_string(), name: t.name })
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct RelationTypeUpdateIn {
    pub book: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_role: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub color: Option<Option<String>>,
}

fn editable_type(slot: &BookSlot, id: &str) -> Result<RelationType> {
    let t = relation_types(slot)
        .iter()
        .find(|t| t.id.as_str() == id)
        .cloned()
        .ok_or_else(|| WsError::not_found("relation type", id))?;
    if t.locked || t.system_key.is_some() || t.id == generic_relation_type_id(&slot.book) {
        return Err(WsError::Locked(id.to_string()));
    }
    Ok(t)
}

op! {
    RelationTypeUpdate = "relation_type.update", Write, Book,
    "Rename a relation type or change its description, role names or colour (the built-in type is locked).",
    fn(cx, input: RelationTypeUpdateIn) -> Named {
        let slot = cx.book(&input.book)?;
        let old = editable_type(&slot, &input.id)?;
        let mut new = old.clone();
        if let Some(n) = &input.name { new.name = n.trim().to_string(); }
        if let Some(r) = &input.source_role { new.source_role = r.trim().to_string(); }
        if let Some(r) = &input.target_role { new.target_role = r.trim().to_string(); }
        dr_model::check::relation_type_definition(&new)?;
        if input.name.is_some() && let Some(other) = type_by_name(&relation_types(&slot), &new.name, Some(&old.id)) {
            return Err(WsError::NameTaken { kind: "relation_type", id: other.id.to_string(), name: new.name.clone() });
        }
        let (id, i) = (old.id.clone(), input.clone());
        cx.write_book(&slot, move |txn| {
            let w = txn.relation_type(&id)?;
            if let Some(n) = &i.name { w.name(n)?; }
            if let Some(d) = &i.description { w.description(d)?; }
            if let Some(r) = &i.source_role { w.source_role(r.trim())?; }
            if let Some(r) = &i.target_role { w.target_role(r.trim())?; }
            if let Some(c) = &i.color { w.color(c.as_deref())?; }
            Ok(())
        })?;
        cx.effect(EffectAction::Updated, "relation_type", &input.id, Some(&new.name));
        cx.undo_with(Invocation::new("relation_type.update", RelationTypeUpdateIn {
            book: input.book.clone(), id: input.id.clone(),
            name: input.name.as_ref().map(|_| old.name.clone()),
            description: input.description.as_ref().map(|_| old.description.clone()),
            source_role: input.source_role.as_ref().map(|_| old.source_role.clone()),
            target_role: input.target_role.as_ref().map(|_| old.target_role.clone()),
            color: input.color.as_ref().map(|_| old.color.clone()),
        }));
        Ok(Named { id: input.id, name: new.name })
    }
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct TypeDeleted {
    pub id: String,
    /// Relations of this type deleted with it.
    pub relations: u32,
}

op! {
    RelationTypeDelete = "relation_type.delete", Write, Book,
    "Delete a relation type and every relation of that type, in one commit; the result says how many (the interface asks first, an Agent reports it).",
    fn(cx, input: EntityIn) -> TypeDeleted {
        let slot = cx.book(&input.book)?;
        let old = editable_type(&slot, &input.id)?;
        let rels: Vec<RelationId> = relations_raw(&slot).iter()
            .filter(|r| r.relation_type == old.id).map(|r| r.id.clone()).collect();
        let mut touched: Vec<(String, String)> = vec![("relation_types".into(), input.id.clone())];
        touched.extend(rels.iter().map(|r| ("relations".to_string(), r.to_string())));
        let (id, r2) = (old.id.clone(), rels.clone());
        let (_, before) = cx.write_book(&slot, move |txn| {
            for r in &r2 { txn.purge(Collection::Relations, r.as_str())?; }
            txn.purge(Collection::RelationTypes, id.as_str())?;
            Ok(())
        })?;
        for r in &rels { cx.effect(EffectAction::Purged, "relation", r.as_str(), None); }
        cx.effect(EffectAction::Purged, "relation_type", &input.id, Some(&old.name));
        cx.undo_with(super::history::restore_invocation(&input.book, &before, touched));
        Ok(TypeDeleted { id: input.id, relations: rels.len() as u32 })
    }
}
