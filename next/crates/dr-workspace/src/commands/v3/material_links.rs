//! One generic material → entry association at a time; never replace a set.
use super::*;
use dr_model::{kind::EntityKind, shared::EntityRef};

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct SetEntryLinkIn {
    pub book: String,
    pub material: String,
    pub entry: String,
    pub linked: bool,
}

pub(crate) fn register(r: &mut Registry) {
    r.add::<SetEntryLink>();
}

op! {
    SetEntryLink = "material.set_entry_link", Write, Book,
    "Add or remove one built-in association from a material to a live entry, preserving every other relation.",
    fn(cx, input: SetEntryLinkIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let view = slot.reader_v3.view();
        if view.meta().deleted_at.is_some() {
            return Err(WsError::not_found("live book", &input.book));
        }
        let material = EntityRef::new(EntityKind::Material, &input.material);
        if !view.entity_exists(&material) {
            return Err(WsError::not_found("material", &input.material));
        }
        let entry_id: EntryId = pid("entry", &input.entry)?;
        let entries = view.entry_headers_with(&BTreeMap::new());
        if entries.get(&entry_id).is_none_or(|e| e.is_trashed())
            || m::effective_ancestors(&entries, &entry_id).iter()
                .any(|id| entries.get(id).is_none_or(|e| e.is_trashed())) {
            return Err(WsError::not_found("live entry", &input.entry));
        }
        let entry = EntityRef::new(EntityKind::Entry, &input.entry);
        let ty = dr_doc::catalog::generic_relation_type_id(&slot.book);
        let matching: Vec<_> = view.relations_raw().into_iter()
            .filter(|r| r.relation_type == ty && r.from == material && r.to == entry)
            .map(|r| r.id).collect();
        if input.linked && !matching.is_empty() || !input.linked && matching.is_empty() {
            cx.undo_nothing();
            return Ok(Done { id: input.material });
        }
        let changed = if input.linked { vec![RelationId::new_v7()] } else { matching };
        let writing = changed.clone();
        // Linking adds an edge under a fresh id; unlinking removes these.
        let removed = Replaces::records(
            changed.iter().filter(|_| !input.linked).map(|id| rec(CollectionV3::Relations, id)),
        );
        let (_, before) = cx.write_book_v3(&slot, removed, move |txn| {
            for id in &writing {
                if input.linked {
                    txn.relation(id)?.ends(&material, &entry)?.relation_type(&ty)?.created_at(Some(now()))?;
                } else {
                    txn.purge(CollectionV3::Relations, id.as_str())?;
                }
            }
            Ok(())
        })?;
        undo(cx, &slot, &before, changed.iter().map(|id| key("relations", id)).collect());
        for id in &changed {
            cx.effect(if input.linked { EffectAction::Created } else { EffectAction::Purged }, "relation", id.as_str(), None);
        }
        Ok(Done { id: input.material })
    }
}
