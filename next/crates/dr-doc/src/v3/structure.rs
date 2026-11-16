//! Immutable, explicit structural reads (`docs/rust-rewrite/kernel-v5.md`).
//! No cache is stored in the live view.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap};

use dr_model::DocId;
use dr_model::id::{BodyDocId, BookId, EntryId, EntryTemplateId, ModuleId, TimelineViewId};
use dr_model::v3::*;
use loro::LoroValue;

use super::BookViewV3;
use crate::catalog::fields::F;
use crate::catalog::read::forest_value;
use crate::schema::book_v3;

/// One atomic read of project definition, entries, templates, memberships and
/// views. A snapshot remains unchanged; a new snapshot sees pending transaction
/// writes, imports or checkouts. It does not commit the Loro transaction or
/// retain an internally mutable document.
pub struct BookStructureV3 {
    book: BookId,
    project: ProjectDefinition,
    ordered: Vec<EntryId>,
    entries: BTreeMap<EntryId, Entry>,
    templates: BTreeMap<EntryTemplateId, EntryTemplate>,
    parents: BTreeMap<EntryId, Option<EntryId>>,
    /// Live entries by where they live, in manual order (a folder's only
    /// order, `kernel-v5.md` §4; a folder in a view keeps it, DV 2026-11-16).
    children: BTreeMap<Option<EntryId>, Vec<EntryId>>,
    memberships: Vec<Membership>,
    members: BTreeMap<EntryId, Vec<EntryId>>,
    timeline_views: BTreeMap<TimelineViewId, TimelineView>,
    ordered_views: Vec<TimelineViewId>,
    settings: BTreeMap<EntryId, ResolvedLevelSettings>,
}

/// One entry in a sequence walk ([`BookStructureV3::sequence`],
/// [`BookStructureV3::book_sequence`], [`BookStructureV3::flatten`]). The App
/// numbers nothing: an author who wants chapter numbers writes them.
#[derive(Clone, Debug, PartialEq)]
pub struct FlatEntry<'a> {
    pub entry: &'a Entry,
    /// For `Root`: top-level entries are 0. For `Entry`: the starting level is
    /// 0, what lies directly below it 1, and so on. For `View` and `Lane`: 0.
    pub depth: u32,
    /// The entry's own prose, in its template's module order (none without a
    /// template). Only the template's prose modules: prose kept from an
    /// earlier template is not part of the sequence.
    pub prose: Vec<FlatProse>,
}

/// One prose module of a [`FlatEntry`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FlatProse {
    pub module: ModuleId,
    pub name: String,
    pub doc: DocId,
    pub in_book: bool,
}

/// Options for [`BookStructureV3::flatten`]. Whole-book view and book sequence
/// share the same walk (`FLATTEN-MEMBERS-ONCE`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Flatten {
    /// Only prose whose module is `in_book`.
    pub in_book_only: bool,
}

/// [`BookStructureV3::flatten`] starts at a live entry with `level` or `accept` enabled.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NotALevel(pub EntryId);

impl std::fmt::Display for NotALevel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "entry {} is not a live entry with level or accept enabled",
            self.0
        )
    }
}

impl std::error::Error for NotALevel {}

/// [`BookStructureV3::sequence`] starts where a flatten can start
/// ([`is_valid_flatten_from`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InvalidFlattenFrom(pub FlattenFrom);

impl std::fmt::Display for InvalidFlattenFrom {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "cannot flatten from {:?}", self.0)
    }
}

impl std::error::Error for InvalidFlattenFrom {}

impl BookStructureV3 {
    pub(super) fn from_doc(book: BookId, doc: &loro::LoroDoc) -> Self {
        let deep = doc.get_deep_value();
        let tree_fallback = match F(&deep).get(book_v3::ENTRIES) {
            Some(LoroValue::List(_)) | None => None,
            Some(_) => Some(doc.get_tree(book_v3::ENTRIES).get_value_with_meta()),
        };
        Self::from_value_with_tree(book, &deep, tree_fallback.as_ref())
    }

    fn from_value_with_tree(
        book: BookId,
        value: &LoroValue,
        entries_override: Option<&LoroValue>,
    ) -> Self {
        let f = F(value);
        let project = BookViewV3::read_project(f.get(book_v3::PROJECT));
        let templates: BTreeMap<_, _> = match f.get(book_v3::TEMPLATES) {
            Some(LoroValue::Map(m)) => m
                .iter()
                .filter_map(|(id, v)| BookViewV3::read_template(id, v))
                .map(|t| (t.id.clone(), t))
                .collect(),
            _ => BTreeMap::new(),
        };
        let raw: Vec<_> = entries_override
            .or_else(|| f.get(book_v3::ENTRIES))
            .map(forest_value)
            .unwrap_or_default()
            .iter()
            .filter_map(BookViewV3::read_entry_node)
            .collect();
        let ordered_raw: Vec<EntryId> = raw.iter().map(|e| e.id.clone()).collect();
        let mut entries: BTreeMap<_, _> = raw.into_iter().map(|e| (e.id.clone(), e)).collect();
        let raw_memberships = BookViewV3::read_memberships(f.get(book_v3::MEMBERSHIPS));
        resolve_autolink_name_conflicts(&mut entries, &templates);
        let memberships = filter_valid_memberships(&raw_memberships, &entries, &templates);

        let mut raw_views: Vec<TimelineView> = match f.get(book_v3::TIMELINE_VIEWS) {
            Some(LoroValue::Map(m)) => m
                .iter()
                .filter_map(|(id, v)| BookViewV3::read_timeline_view_raw(id, v))
                .filter(|v| v.deleted_at.is_none())
                .collect(),
            _ => Vec::new(),
        };
        sort_timeline_views(&mut raw_views);
        let ordered_views: Vec<TimelineViewId> = raw_views.iter().map(|v| v.id.clone()).collect();
        let timeline_views: BTreeMap<_, _> =
            raw_views.into_iter().map(|v| (v.id.clone(), v)).collect();

        let parents: BTreeMap<_, _> = entries
            .values()
            .map(|e| (e.id.clone(), effective_parent_id(e, &entries)))
            .collect();
        let settings = entries
            .values()
            .filter(|e| !e.is_trashed() && e.has_below(&templates))
            .map(|e| {
                (
                    e.id.clone(),
                    resolve_level_settings_with_sources(Some(&e.id), &entries, &templates),
                )
            })
            .collect();

        let mut out = Self {
            book,
            project,
            ordered: ordered_raw,
            entries,
            templates,
            parents,
            children: BTreeMap::new(),
            memberships,
            members: BTreeMap::new(),
            timeline_views,
            ordered_views,
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

    pub fn project(&self) -> &ProjectDefinition {
        &self.project
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

    pub fn timeline_views_map(&self) -> &BTreeMap<TimelineViewId, TimelineView> {
        &self.timeline_views
    }

    pub fn timeline_views(&self) -> impl Iterator<Item = &TimelineView> {
        self.ordered_views.iter().map(|id| &self.timeline_views[id])
    }

    pub fn effective_parent(&self, id: &EntryId) -> Option<&EntryId> {
        self.parents.get(id).and_then(Option::as_ref)
    }

    /// Live entries whose effective residence is `parent`, in its manual
    /// folder order (`LoroTree` sibling order). A folder's order is its own
    /// also while it is a lane in a view: a lane holds what is hung on it,
    /// not what lives under it (DV 2026-11-16; `VIEW-FOLDER-ORDER-FROM-SCALE`
    /// is gone).
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

    /// Whether `entry` is an effective swimlane in at least one live view.
    pub fn is_in_any_view(&self, entry: &EntryId) -> bool {
        self.lane_reference_view(entry).is_some()
    }

    /// Reference [`TimelineView`] whose scale orders what is hung on `host`
    /// (`kernel-v5.md` §4 「视图：刻度」): the first live view in `(pos, id)`
    /// order whose effective lanes contain `host`. Returns `None` when `host`
    /// is not in any live view (an entry that does not take entries from
    /// elsewhere never is: it is no lane).
    pub fn lane_reference_view(&self, host: &EntryId) -> Option<&TimelineView> {
        let in_view = |tv: &TimelineView| {
            effective_timeline_lanes(&tv.lanes, &self.entries, &self.templates)
                .iter()
                .any(|l| &l.entry == host)
        };
        self.ordered_views
            .iter()
            .map(|id| &self.timeline_views[id])
            .find(|tv| in_view(tv))
    }

    /// Valid live members of `host` ordered along `view`'s scale
    /// (unplaced entries last, ties by entry ID).
    pub fn members_along_view<'a>(&'a self, view: &TimelineView, host: &EntryId) -> Vec<&'a Entry> {
        if !is_entry_live(host, &self.entries)
            || !self.entries[host].accepts_members(&self.templates)
        {
            return Vec::new();
        }
        let mut seen = BTreeSet::new();
        let mut ids: Vec<EntryId> = self
            .members
            .get(host)
            .into_iter()
            .flatten()
            .filter(|id| is_entry_live(id, &self.entries) && seen.insert((*id).clone()))
            .cloned()
            .collect();
        sort_ids_along_view(&mut ids, view);
        ids.into_iter().map(|id| &self.entries[&id]).collect()
    }

    /// Authoritative member order for `host`'s own page (`kernel-v5.md` §4,
    /// `VIEW-LANE-MEMBERS-PLACED`): when `host` is in at least one live view,
    /// ordered along [`Self::lane_reference_view`]'s scale (unplaced members
    /// last, never reading `membership.pos`); otherwise ordered by
    /// `(membership.pos, id)`.
    pub fn lane_members_order(&self, host: &EntryId) -> Vec<&Entry> {
        if !is_entry_live(host, &self.entries)
            || !self.entries[host].accepts_members(&self.templates)
        {
            return Vec::new();
        }
        if let Some(view) = self.lane_reference_view(host) {
            self.members_along_view(view, host)
        } else {
            self.members
                .get(host)
                .into_iter()
                .flatten()
                .filter(|id| is_entry_live(id, &self.entries))
                .map(|id| &self.entries[id])
                .collect()
        }
    }

    /// Entries validly belonging to `host`, in `host`'s authoritative member
    /// order ([`Self::lane_members_order`]).
    pub fn members_of(&self, host: &EntryId) -> Vec<&Entry> {
        self.lane_members_order(host)
    }

    /// Live entries with `level` or `accept` enabled (`has_below`), in folder order.
    pub fn levels(&self) -> impl Iterator<Item = &Entry> {
        self.entries()
            .filter(|e| !e.is_trashed() && e.has_below(&self.templates))
    }

    /// Resolved settings of a live entry with `level` or `accept` enabled.
    pub fn level_settings(&self, id: &EntryId) -> Option<&ResolvedLevelSettings> {
        self.settings.get(id)
    }

    /// Whether a flatten can start at `from` now ([`is_valid_flatten_from`]).
    pub fn is_valid_flatten_from(&self, from: &FlattenFrom) -> bool {
        is_valid_flatten_from(from, &self.entries, &self.templates, &self.timeline_views)
    }

    /// Whether `mount` currently satisfies `TAB-MOUNT-VALID`.
    pub fn is_valid_tab_mount(&self, mount: &TabMount) -> bool {
        check_tab_mount(
            mount,
            self.project.book.is_some(),
            &self.entries,
            &self.templates,
        )
        .is_ok()
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
        in_book_only: bool,
        seen: &mut BTreeSet<EntryId>,
        out: &mut Vec<FlatEntry<'a>>,
    ) {
        if !is_entry_live(id, &self.entries) || !seen.insert(id.clone()) {
            return;
        }
        let entry = &self.entries[id];
        out.push(FlatEntry {
            entry,
            depth,
            prose: self.prose_of(entry, in_book_only),
        });
        if entry.is_level() {
            for next in self.children.get(&Some(id.clone())).into_iter().flatten() {
                self.walk(next, depth + 1, in_book_only, seen, out);
            }
        }
        if entry.accepts_members(&self.templates) {
            for next in self.lane_members_order(id) {
                self.walk(&next.id, depth + 1, in_book_only, seen, out);
            }
        }
    }

    fn view_sequence<'a>(&'a self, view: &TimelineView, in_book_only: bool) -> Vec<FlatEntry<'a>> {
        let mut lanes = effective_timeline_lanes(&view.lanes, &self.entries, &self.templates);
        lanes.sort_by_key(|l| !l.is_act_track());
        let placement_at: HashMap<&EntryId, f64> = view
            .placements
            .iter()
            .filter(|p| p.at.is_finite())
            .map(|p| (&p.entry, p.at))
            .collect();
        let mut min_lane_idx: HashMap<EntryId, usize> = HashMap::new();
        let mut unique: Vec<EntryId> = Vec::new();
        for (lane_idx, lane) in lanes.iter().enumerate() {
            for member in self.members_along_view(view, &lane.entry) {
                min_lane_idx.entry(member.id.clone()).or_insert_with(|| {
                    unique.push(member.id.clone());
                    lane_idx
                });
            }
        }
        unique.sort_by(|a, b| {
            let pa = placement_at.get(a);
            let pb = placement_at.get(b);
            pa.is_none()
                .cmp(&pb.is_none())
                .then_with(|| match (pa, pb) {
                    (Some(xa), Some(xb)) => xa.total_cmp(xb),
                    _ => Ordering::Equal,
                })
                .then_with(|| min_lane_idx[a].cmp(&min_lane_idx[b]))
                .then_with(|| a.cmp(b))
        });
        unique
            .into_iter()
            .map(|id| {
                let entry = &self.entries[&id];
                FlatEntry {
                    entry,
                    depth: 0,
                    prose: self.prose_of(entry, in_book_only),
                }
            })
            .collect()
    }

    fn lane_in_view_sequence<'a>(
        &'a self,
        view: &TimelineView,
        lane_id: &EntryId,
        in_book_only: bool,
    ) -> Vec<FlatEntry<'a>> {
        self.members_along_view(view, lane_id)
            .into_iter()
            .map(|entry| FlatEntry {
                entry,
                depth: 0,
                prose: self.prose_of(entry, in_book_only),
            })
            .collect()
    }

    /// Unified sequence reader across all four [`FlattenFrom`] kinds
    /// (`kernel-v5.md` §3 「怎么读」):
    /// - `Root` and `Entry`: preorder walk (own prose, then residents in folder
    ///   order, then valid members), visiting each entry at most once.
    /// - `View`: all valid members of all effective swimlanes in `view`, ordered
    ///   along `view`'s scale (unplaced entries last, ties broken by lane order
    ///   top-to-bottom then entry id), each entry once.
    /// - `Lane`: valid members of `entry` ordered along `view`'s scale (unplaced
    ///   last, ties broken by entry id).
    pub fn sequence(
        &self,
        from: &FlattenFrom,
        in_book_only: bool,
    ) -> Result<Vec<FlatEntry<'_>>, InvalidFlattenFrom> {
        if !self.is_valid_flatten_from(from) {
            return Err(InvalidFlattenFrom(from.clone()));
        }
        Ok(match from {
            FlattenFrom::Root => {
                let mut seen = BTreeSet::new();
                let mut out = Vec::new();
                for top in self.children.get(&None).into_iter().flatten() {
                    self.walk(top, 0, in_book_only, &mut seen, &mut out);
                }
                out
            }
            FlattenFrom::Entry { entry } => {
                let mut seen = BTreeSet::new();
                let mut out = Vec::new();
                self.walk(entry, 0, in_book_only, &mut seen, &mut out);
                out
            }
            FlattenFrom::View { view } => {
                self.view_sequence(&self.timeline_views[view], in_book_only)
            }
            FlattenFrom::Lane { view, entry } => {
                self.lane_in_view_sequence(&self.timeline_views[view], entry, in_book_only)
            }
        })
    }

    /// Flatten what lies below `from` ([`FlattenFrom::Entry`]): delegates to
    /// the unified [`Self::sequence`] reader.
    pub fn flatten(&self, from: &EntryId, how: Flatten) -> Result<Vec<FlatEntry<'_>>, NotALevel> {
        self.sequence(
            &FlattenFrom::Entry {
                entry: from.clone(),
            },
            how.in_book_only,
        )
        .map_err(|_| NotALevel(from.clone()))
    }

    /// The project's book sequence (`成书序列`, `kernel-v5.md` §3): the whole
    /// project read from the root ([`FlattenFrom::Root`]) with
    /// `in_book_only = true`. The book has no start; a `project.book.root`
    /// an older book stores is not read. Empty when the project has no book
    /// (`project.book == None`).
    pub fn book_sequence(&self) -> Vec<FlatEntry<'_>> {
        if self.project.book.is_none() {
            return Vec::new();
        }
        self.sequence(&FlattenFrom::Root, true).unwrap_or_default()
    }

    /// The entries of [`Self::book_sequence`] that carry book prose, in order.
    pub fn book_entries(&self) -> Vec<Entry> {
        self.book_sequence()
            .into_iter()
            .filter(|e| !e.prose.is_empty())
            .map(|e| e.entry.clone())
            .collect()
    }

    /// Every document of [`Self::book_sequence`], in order.
    pub fn book_docs(&self) -> Vec<DocId> {
        self.book_sequence()
            .into_iter()
            .flat_map(|e| e.prose.into_iter().map(|p| p.doc))
            .collect()
    }
}

fn sort_ids_along_view(ids: &mut [EntryId], view: &TimelineView) {
    let placement_at: HashMap<&EntryId, f64> = view
        .placements
        .iter()
        .filter(|p| p.at.is_finite())
        .map(|p| (&p.entry, p.at))
        .collect();
    ids.sort_by(|a, b| {
        let pa = placement_at.get(a);
        let pb = placement_at.get(b);
        pa.is_none()
            .cmp(&pb.is_none())
            .then_with(|| match (pa, pb) {
                (Some(xa), Some(xb)) => xa.total_cmp(xb),
                _ => Ordering::Equal,
            })
            .then_with(|| a.cmp(b))
    });
}
