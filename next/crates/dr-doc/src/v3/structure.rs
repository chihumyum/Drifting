//! Immutable, explicit structural reads. No cache is stored in the live view.
use super::BookViewV3;
use crate::catalog::fields::F;
use crate::catalog::read::forest_value;
use crate::schema::book_v3;
use dr_model::DocId;
use dr_model::id::{BodyDocId, BookId, EntryId, EntryTemplateId, ModuleId};
use dr_model::v3::*;
use loro::LoroValue;
use std::collections::{BTreeMap, BTreeSet};

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
    manuscripts: Vec<EntryId>,
}

/// One entry in a flattened walk ([`BookStructureV3::flatten`],
/// [`BookStructureV3::manuscript`]).
#[derive(Clone, Debug, PartialEq)]
pub struct FlatEntry<'a> {
    pub entry: &'a Entry,
    /// The starting level is 0, what lies directly below it 1, and so on.
    pub depth: u32,
    /// The entry's own prose, in its template's module order (none without a
    /// template). Only the template's prose modules: prose kept from an
    /// earlier template is not part of the sequence.
    pub prose: Vec<FlatProse>,
    /// Only in [`BookStructureV3::manuscript`]: entries with book prose are
    /// numbered from 1 across every manuscript part.
    pub ordinal: Option<u32>,
}

/// One prose module of a [`FlatEntry`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FlatProse {
    pub module: ModuleId,
    pub name: String,
    pub doc: DocId,
    pub in_book: bool,
}

/// How to flatten ([`BookStructureV3::flatten`]).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Flatten {
    /// Only prose whose module is `in_book`.
    pub in_book_only: bool,
    /// After the entries living under each level, the entries that belong
    /// to it (author 2026-11-13: what belongs to a level counts). On by
    /// default for the whole-book view; never for the manuscript.
    pub include_members: bool,
}

/// One outermost manuscript level and what it holds, in sequence.
#[derive(Clone, Debug, PartialEq)]
pub struct ManuscriptPart<'a> {
    pub root: &'a Entry,
    pub entries: Vec<FlatEntry<'a>>,
}

/// [`BookStructureV3::flatten`] starts at a live entry whose switch is on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NotALevel(pub EntryId);

impl std::fmt::Display for NotALevel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "entry {} is not a live entry with its switch on", self.0)
    }
}

impl std::error::Error for NotALevel {}

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
        let ordered: Vec<EntryId> = raw.iter().map(|e| e.id.clone()).collect();
        let mut entries: BTreeMap<_, _> = raw.into_iter().map(|e| (e.id.clone(), e)).collect();
        let raw_memberships = BookViewV3::read_memberships(f.get(book_v3::MEMBERSHIPS));
        resolve_autolink_name_conflicts(&mut entries, &raw_memberships, &templates);
        let memberships = filter_valid_memberships(&raw_memberships, &entries, &templates);
        let parents: BTreeMap<_, _> = entries
            .values()
            .map(|e| (e.id.clone(), effective_parent_id(e, &entries)))
            .collect();
        let settings = entries
            .values()
            .filter(|e| !e.is_trashed() && e.is_level())
            .map(|e| {
                (
                    e.id.clone(),
                    resolve_level_settings_with_sources(Some(&e.id), &entries, &templates),
                )
            })
            .collect();
        let outermost = effective_manuscript_levels(&entries, &templates);
        let manuscripts = ordered
            .iter()
            .filter(|id| outermost.contains(*id))
            .cloned()
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
            manuscripts,
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
    /// Live entries whose effective residence is `parent`, in manuscript order.
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
    /// Entries validly belonging to `host`, in the memberships' own order.
    pub fn members_of(&self, host: &EntryId) -> Vec<&Entry> {
        self.members
            .get(host)
            .into_iter()
            .flatten()
            .map(|id| &self.entries[id])
            .collect()
    }
    /// Live entries whose switch is on, in manuscript order.
    pub fn levels(&self) -> impl Iterator<Item = &Entry> {
        self.entries().filter(|e| self.settings.contains_key(&e.id))
    }
    /// Resolved settings of a live entry whose switch is on.
    pub fn level_settings(&self, id: &EntryId) -> Option<&ResolvedLevelSettings> {
        self.settings.get(id)
    }

    fn prose_of(&self, entry: &Entry, in_book_only: bool) -> Vec<FlatProse> {
        let Some(tpl) = entry.effective_template(&self.templates) else {
            return Vec::new();
        };
        tpl.prose_modules()
            .filter(|m| !in_book_only || m.config.in_book)
            .map(|m| FlatProse {
                module: m.id.clone(),
                name: m.name.clone(),
                doc: DocId::Body(BodyDocId::new(entry.id.clone(), m.id.clone())),
                in_book: m.config.in_book,
            })
            .collect()
    }

    fn walk<'a>(
        &'a self,
        id: &EntryId,
        depth: u32,
        how: Flatten,
        seen: &mut BTreeSet<EntryId>,
        out: &mut Vec<FlatEntry<'a>>,
    ) {
        if !seen.insert(id.clone()) {
            return;
        }
        let entry = &self.entries[id];
        out.push(FlatEntry {
            entry,
            depth,
            prose: self.prose_of(entry, how.in_book_only),
            ordinal: None,
        });
        if !entry.is_level() {
            return;
        }
        let residents = self.children.get(&Some(id.clone())).into_iter().flatten();
        let members = how
            .include_members
            .then(|| self.members.get(id))
            .flatten()
            .into_iter()
            .flatten();
        for next in residents.chain(members) {
            self.walk(next, depth + 1, how, seen, out);
        }
    }

    /// Flatten what lies below `from` (`kernel-v4.md` §7): `from` first, then
    /// depth first, each entry's own prose before what lies below it. Below a
    /// level come the entries living under it in manuscript order, then (with
    /// `include_members`) the entries validly belonging to it in the
    /// memberships' order. Each entry appears once, where it is first reached;
    /// trashed entries and what lives under them do not appear; an entry
    /// a merge left under an entry whose switch is off appears under the
    /// nearest level, as in the sidebar. Entries without prose appear too.
    pub fn flatten(&self, from: &EntryId, how: Flatten) -> Result<Vec<FlatEntry<'_>>, NotALevel> {
        let start = self
            .entries
            .get(from)
            .filter(|e| !e.is_trashed() && e.is_level())
            .ok_or_else(|| NotALevel(from.clone()))?;
        let mut out = Vec::new();
        self.walk(&start.id, 0, how, &mut BTreeSet::new(), &mut out);
        Ok(out)
    }

    /// The manuscript sequence (`成书序列`): one part per outermost manuscript
    /// level, in tree order, each flattened with book prose only and no
    /// memberships. Entries with book prose are numbered from 1 across all
    /// parts (`ordinal`). Export, the book's word count and chapter numbers
    /// all read this.
    pub fn manuscript(&self) -> Vec<ManuscriptPart<'_>> {
        let how = Flatten {
            in_book_only: true,
            include_members: false,
        };
        let mut ordinal = 0;
        self.manuscripts
            .iter()
            .filter_map(|root| {
                let mut entries = self.flatten(root, how).ok()?;
                for e in &mut entries {
                    if !e.prose.is_empty() {
                        ordinal += 1;
                        e.ordinal = Some(ordinal);
                    }
                }
                Some(ManuscriptPart {
                    root: &self.entries[root],
                    entries,
                })
            })
            .collect()
    }

    /// Every document of the manuscript sequence, in order.
    pub fn manuscript_docs(&self) -> Vec<DocId> {
        self.manuscript()
            .into_iter()
            .flat_map(|p| p.entries)
            .flat_map(|e| e.prose.into_iter().map(|p| p.doc))
            .collect()
    }

    /// The chapter number of `id` in the manuscript sequence, if it has one.
    pub fn ordinal(&self, id: &EntryId) -> Option<u32> {
        self.manuscript()
            .into_iter()
            .flat_map(|p| p.entries)
            .find(|e| &e.entry.id == id)
            .and_then(|e| e.ordinal)
    }
}
