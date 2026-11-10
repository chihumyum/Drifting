//! Immutable, explicit structural reads. No cache is stored in the live view.
use super::BookViewV3;
use crate::catalog::fields::F;
use crate::catalog::read::forest_value;
use crate::schema::book_v3;
use dr_model::id::{BookId, EntryId, EntryTemplateId};
use dr_model::v3::*;
use loro::LoroValue;
use std::collections::BTreeMap;

/// One atomic read of entries, templates and memberships. A snapshot remains
/// unchanged; a new snapshot sees pending transaction writes, imports or checkouts.
/// It does not commit the Loro transaction or retain an internally mutable document.
pub struct BookStructureV3 {
    book: BookId,
    ordered: Vec<EntryId>,
    entries: BTreeMap<EntryId, Entry>,
    templates: BTreeMap<EntryTemplateId, EntryTemplate>,
    parents: BTreeMap<EntryId, Option<EntryId>>,
    children: BTreeMap<Option<EntryId>, Vec<EntryId>>,
    memberships: Vec<Membership>,
    members: BTreeMap<EntryId, Vec<EntryId>>,
    settings: BTreeMap<EntryId, ResolvedLevelSettings>,
}
impl BookStructureV3 {
    pub(super) fn from_value(book: BookId, value: &LoroValue) -> Self {
        let f = F(value);
        let templates: BTreeMap<_, _> = match f.get(book_v3::TEMPLATES) {
            Some(LoroValue::Map(m)) => m
                .iter()
                .filter_map(|(id, v)| BookViewV3::read_template(id, v))
                .map(|t| (t.id.clone(), t))
                .collect(),
            _ => BTreeMap::new(),
        };
        let raw: Vec<_> = f
            .get(book_v3::ENTRIES)
            .map(forest_value)
            .unwrap_or_default()
            .iter()
            .filter_map(BookViewV3::read_entry_node)
            .collect();
        let ordered = raw.iter().map(|e| e.id.clone()).collect();
        let mut entries: BTreeMap<_, _> = raw.into_iter().map(|e| (e.id.clone(), e)).collect();
        let raw_memberships = BookViewV3::read_memberships(f.get(book_v3::MEMBERSHIPS));
        resolve_autolink_name_conflicts(&mut entries, &raw_memberships, &templates);
        let memberships = filter_valid_memberships(&raw_memberships, &entries, &templates);
        let parents: BTreeMap<_, _> = entries
            .values()
            .map(|e| (e.id.clone(), effective_parent_id(e, &entries, &templates)))
            .collect();
        let settings = entries
            .values()
            .filter(|e| !e.is_trashed() && e.is_level(&templates))
            .map(|e| {
                (
                    e.id.clone(),
                    resolve_level_settings_with_sources(Some(&e.id), &entries, &templates),
                )
            })
            .collect();
        let mut out = Self {
            book,
            ordered,
            entries,
            templates,
            parents,
            children: BTreeMap::new(),
            memberships,
            members: BTreeMap::new(),
            settings,
        };
        for id in &out.ordered {
            if !out.entries[id].is_trashed() {
                out.children
                    .entry(out.parents[id].clone())
                    .or_default()
                    .push(id.clone());
            }
        }
        for m in &out.memberships {
            out.members
                .entry(m.host.clone())
                .or_default()
                .push(m.member.clone());
        }
        out
    }
    pub fn book_id(&self) -> &BookId {
        &self.book
    }
    pub fn entry(&self, id: &EntryId) -> Option<&Entry> {
        self.entries.get(id)
    }
    pub fn entries(&self) -> impl Iterator<Item = &Entry> {
        self.ordered.iter().map(|id| &self.entries[id])
    }
    pub fn entries_map(&self) -> &BTreeMap<EntryId, Entry> {
        &self.entries
    }
    pub fn templates_map(&self) -> &BTreeMap<EntryTemplateId, EntryTemplate> {
        &self.templates
    }
    pub fn effective_parent(&self, id: &EntryId) -> Option<&EntryId> {
        self.parents.get(id).and_then(Option::as_ref)
    }
    pub fn children_of(&self, parent: Option<&EntryId>) -> Vec<&Entry> {
        self.children
            .get(&parent.cloned())
            .into_iter()
            .flatten()
            .map(|id| &self.entries[id])
            .collect()
    }
    pub fn memberships(&self) -> &[Membership] {
        &self.memberships
    }
    pub fn members_of(&self, host: &EntryId) -> Vec<&Entry> {
        self.members
            .get(host)
            .into_iter()
            .flatten()
            .map(|id| &self.entries[id])
            .collect()
    }
    pub fn levels(&self) -> impl Iterator<Item = &Entry> {
        self.entries().filter(|e| self.settings.contains_key(&e.id))
    }
    pub fn level_settings(&self, id: &EntryId) -> Option<&ResolvedLevelSettings> {
        self.settings.get(id)
    }
}
