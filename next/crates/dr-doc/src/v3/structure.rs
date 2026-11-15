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
    manual_children: BTreeMap<Option<EntryId>, Vec<EntryId>>,
    children: BTreeMap<Option<EntryId>, Vec<EntryId>>,
    memberships: Vec<Membership>,
    members: BTreeMap<EntryId, Vec<EntryId>>,
    timeline_views: BTreeMap<TimelineViewId, TimelineView>,
    ordered_views: Vec<TimelineViewId>,
    settings: BTreeMap<EntryId, ResolvedLevelSettings>,
}

/// One entry in a sequence walk ([`BookStructureV3::sequence`],
/// [`BookStructureV3::book_sequence`], [`BookStructureV3::flatten`]).
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
    /// Set when `in_book_only` is true (`sequence(..., true)` /
    /// [`BookStructureV3::book_sequence`]): entries with book prose are numbered
    /// from 1 across the sequence, except those living (at any depth) under an
    /// entry inside the sequence that has book prose of its own
    /// (`MANUSCRIPT-NUMBER-OUTERMOST-PROSE`).
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

/// [`BookStructureV3::sequence`] requires a valid [`BookRoot`] (`BOOK-ROOT-VALID`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InvalidBookRoot(pub BookRoot);

impl std::fmt::Display for InvalidBookRoot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "invalid sequence root {:?}", self.0)
    }
}

impl std::error::Error for InvalidBookRoot {}

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
            manual_children: BTreeMap::new(),
            children: BTreeMap::new(),
            memberships,
            members: BTreeMap::new(),
            timeline_views,
            ordered_views,
            settings,
        };
        for id in &out.ordered {
            if !out.entries[id].is_trashed() {
                out.manual_children
                    .entry(out.parents[id].clone())
                    .or_default()
                    .push(id.clone());
            }
        }
        out.children = out.manual_children.clone();
        for m in &out.memberships {
            out.members
                .entry(m.host.clone())
                .or_default()
                .push(m.member.clone());
        }

        // Folders (`level == true`) that sit in at least one live view have
        // their direct children's order governed by `lane_reference_view`'s
        // scale (`VIEW-FOLDER-ORDER-FROM-SCALE`).
        let mut any_folder_in_view = false;
        let folder_parents: Vec<EntryId> = out
            .children
            .keys()
            .filter_map(|k| k.clone())
            .filter(|pid| {
                is_entry_live(pid, &out.entries)
                    && out.entries[pid].is_level()
                    && out.lane_reference_view(pid).is_some()
            })
            .collect();
        for pid in folder_parents {
            if let Some(ref_view) = out.lane_reference_view(&pid).cloned()
                && let Some(child_ids) = out.children.get_mut(&Some(pid))
            {
                sort_ids_along_view(child_ids, &ref_view);
                any_folder_in_view = true;
            }
        }
        if any_folder_in_view {
            let mut visited = BTreeSet::new();
            let mut reordered = Vec::with_capacity(out.ordered.len());
            fn dfs(
                id: &EntryId,
                children: &BTreeMap<Option<EntryId>, Vec<EntryId>>,
                visited: &mut BTreeSet<EntryId>,
                out: &mut Vec<EntryId>,
            ) {
                if !visited.insert(id.clone()) {
                    return;
                }
                out.push(id.clone());
                for c in children.get(&Some(id.clone())).into_iter().flatten() {
                    dfs(c, children, visited, out);
                }
            }
            for top in out.children.get(&None).into_iter().flatten() {
                dfs(top, &out.children, &mut visited, &mut reordered);
            }
            for id in &out.ordered {
                if visited.insert(id.clone()) {
                    reordered.push(id.clone());
                }
            }
            out.ordered = reordered;
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

    /// Live entries whose effective residence is `parent`, in authoritative
    /// order (along [`Self::lane_reference_view`]'s scale when `parent` is a
    /// folder in at least one live view, otherwise manual folder order).
    pub fn children_of(&self, parent: Option<&EntryId>) -> Vec<&Entry> {
        self.children
            .get(&parent.cloned())
            .into_iter()
            .flatten()
            .map(|id| &self.entries[id])
            .collect()
    }

    /// Live entries whose effective residence is `parent`, in manual `LoroTree`
    /// sibling order regardless of whether `parent` is in a timeline view.
    pub fn manual_children_of(&self, parent: Option<&EntryId>) -> Vec<&Entry> {
        self.manual_children
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

    /// Reference [`TimelineView`] whose scale governs `host`'s own page order
    /// (`kernel-v5.md` §4): if `project.book.root` names a live view (`View` or
    /// `Lane`) whose effective lanes contain `host`, that view wins; otherwise
    /// the first live view in `(pos, id)` order whose effective lanes contain
    /// `host`. Returns `None` when `host` is not in any live view.
    pub fn lane_reference_view(&self, host: &EntryId) -> Option<&TimelineView> {
        let in_view = |tv: &TimelineView| {
            effective_timeline_lanes(&tv.lanes, &self.entries, &self.templates)
                .iter()
                .any(|l| &l.entry == host)
        };
        if let Some(book) = &self.project.book {
            let root_view = match &book.root {
                BookRoot::View { view } | BookRoot::Lane { view, .. } => {
                    self.timeline_views.get(view)
                }
                BookRoot::Root | BookRoot::Entry { .. } | BookRoot::Unset => None,
            };
            if let Some(tv) = root_view.filter(|tv| in_view(tv)) {
                return Some(tv);
            }
        }
        self.ordered_views
            .iter()
            .map(|id| &self.timeline_views[id])
            .find(|tv| in_view(tv))
    }

    /// Direct live residents of `folder` ordered along `view`'s scale
    /// (unplaced entries last, ties by entry ID).
    pub fn residents_along_view<'a>(
        &'a self,
        view: &TimelineView,
        folder: &EntryId,
    ) -> Vec<&'a Entry> {
        if !is_entry_live(folder, &self.entries) || !self.entries[folder].is_level() {
            return Vec::new();
        }
        let mut ids: Vec<EntryId> = self
            .manual_children
            .get(&Some(folder.clone()))
            .into_iter()
            .flatten()
            .filter(|id| is_entry_live(id, &self.entries))
            .cloned()
            .collect();
        sort_ids_along_view(&mut ids, view);
        ids.into_iter().map(|id| &self.entries[&id]).collect()
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

    /// All live entries belonging to swimlane `lane_id` (direct residents when
    /// `level == true` plus valid members when `accept == true`, each once),
    /// ordered along `view`'s scale.
    pub fn lane_entries_in_view<'a>(
        &'a self,
        view: &TimelineView,
        lane_id: &EntryId,
    ) -> Vec<&'a Entry> {
        if !is_entry_live(lane_id, &self.entries) {
            return Vec::new();
        }
        let lane = &self.entries[lane_id];
        let mut seen = BTreeSet::new();
        let mut ids = Vec::new();
        if lane.is_level() {
            for id in self
                .manual_children
                .get(&Some(lane_id.clone()))
                .into_iter()
                .flatten()
            {
                if is_entry_live(id, &self.entries) && seen.insert(id.clone()) {
                    ids.push(id.clone());
                }
            }
        }
        if lane.accepts_members(&self.templates) {
            for id in self.members.get(lane_id).into_iter().flatten() {
                if is_entry_live(id, &self.entries) && seen.insert(id.clone()) {
                    ids.push(id.clone());
                }
            }
        }
        sort_ids_along_view(&mut ids, view);
        ids.into_iter().map(|id| &self.entries[&id]).collect()
    }

    /// All live entries belonging to `lane_id` in its current authoritative
    /// order: along [`Self::lane_reference_view`]'s scale when `lane_id` is in
    /// at least one live view, otherwise direct residents in manual folder
    /// order followed by valid members in `(membership.pos, id)` order, each
    /// entry at most once.
    pub fn lane_entries_order(&self, lane_id: &EntryId) -> Vec<&Entry> {
        if !is_entry_live(lane_id, &self.entries) {
            return Vec::new();
        }
        if let Some(view) = self.lane_reference_view(lane_id) {
            return self.lane_entries_in_view(view, lane_id);
        }
        let lane = &self.entries[lane_id];
        let mut seen = BTreeSet::new();
        let mut out = Vec::new();
        if lane.is_level() {
            for e in self.manual_children_of(Some(lane_id)) {
                if is_entry_live(&e.id, &self.entries) && seen.insert(e.id.clone()) {
                    out.push(e);
                }
            }
        }
        if lane.accepts_members(&self.templates) {
            for id in self.members.get(lane_id).into_iter().flatten() {
                if is_entry_live(id, &self.entries) && seen.insert(id.clone()) {
                    out.push(&self.entries[id]);
                }
            }
        }
        out
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

    /// Whether `root` currently satisfies `BOOK-ROOT-VALID`.
    pub fn is_valid_book_root(&self, root: &BookRoot) -> bool {
        check_book_root(root, &self.entries, &self.templates, &self.timeline_views).is_ok()
    }

    /// Whether `mount` currently satisfies `TAB-MOUNT-VALID`.
    pub fn is_valid_tab_mount(&self, mount: &TabMount) -> bool {
        check_tab_mount(
            mount,
            self.project.book.is_some(),
            &self.entries,
            &self.templates,
            &self.timeline_views,
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
            ordinal: None,
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
            for member in self.lane_entries_in_view(view, &lane.entry) {
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
                    ordinal: None,
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
        self.lane_entries_in_view(view, lane_id)
            .into_iter()
            .map(|entry| FlatEntry {
                entry,
                depth: 0,
                prose: self.prose_of(entry, in_book_only),
                ordinal: None,
            })
            .collect()
    }

    /// Unified sequence reader across all four [`BookRoot`] kinds (`kernel-v5.md` §3):
    /// - `Root` and `Entry`: preorder walk (own prose, then residents in folder
    ///   order, then valid members), visiting each entry at most once.
    /// - `View`: all valid members of all effective swimlanes in `view`, ordered
    ///   along `view`'s scale (unplaced entries last, ties broken by lane order
    ///   top-to-bottom then entry id), each entry once.
    /// - `Lane`: valid members of `entry` ordered along `view`'s scale (unplaced
    ///   last, ties broken by entry id).
    pub fn sequence(
        &self,
        root: &BookRoot,
        in_book_only: bool,
    ) -> Result<Vec<FlatEntry<'_>>, InvalidBookRoot> {
        if !self.is_valid_book_root(root) {
            return Err(InvalidBookRoot(root.clone()));
        }
        let mut entries = match root {
            BookRoot::Root => {
                let mut seen = BTreeSet::new();
                let mut out = Vec::new();
                for top in self.children.get(&None).into_iter().flatten() {
                    self.walk(top, 0, in_book_only, &mut seen, &mut out);
                }
                out
            }
            BookRoot::Entry { entry } => {
                let mut seen = BTreeSet::new();
                let mut out = Vec::new();
                self.walk(entry, 0, in_book_only, &mut seen, &mut out);
                out
            }
            BookRoot::View { view } => self.view_sequence(&self.timeline_views[view], in_book_only),
            BookRoot::Lane { view, entry } => {
                self.lane_in_view_sequence(&self.timeline_views[view], entry, in_book_only)
            }
            // Never valid: refused above.
            BookRoot::Unset => Vec::new(),
        };
        if in_book_only {
            // Entries with book prose are numbered from 1 across the sequence,
            // except what lives under an entry with book prose of its own
            // (`MANUSCRIPT-NUMBER-OUTERMOST-PROSE`). For `BookRoot::Entry`, the
            // starting level itself (`depth == 0`) may carry a preface without
            // stopping the chapters under it from being numbered.
            let start_is_entry = matches!(root, BookRoot::Entry { .. });
            let mut ordinal = 0u32;
            let mut inside: Option<u32> = None;
            for e in &mut entries {
                if inside.is_some_and(|depth| e.depth <= depth) {
                    inside = None;
                }
                if inside.is_none() && !e.prose.is_empty() {
                    ordinal += 1;
                    e.ordinal = Some(ordinal);
                    if !(start_is_entry && e.depth == 0) {
                        inside = Some(e.depth);
                    }
                }
            }
        }
        Ok(entries)
    }

    /// Flatten what lies below `from` (`BookRoot::Entry`): delegates to the
    /// unified [`Self::sequence`] reader.
    pub fn flatten(&self, from: &EntryId, how: Flatten) -> Result<Vec<FlatEntry<'_>>, NotALevel> {
        self.sequence(
            &BookRoot::Entry {
                entry: from.clone(),
            },
            how.in_book_only,
        )
        .map_err(|_| NotALevel(from.clone()))
    }

    /// The project's book sequence (`成书序列`, `kernel-v5.md` §3): reads from
    /// `project.book.root` with `in_book_only = true` and numbers entries with
    /// book prose from 1 (`ordinal`). Returns empty when the project has no
    /// book (`project.book == None`) or when `project.book.root` is invalid.
    pub fn book_sequence(&self) -> Vec<FlatEntry<'_>> {
        let Some(book) = &self.project.book else {
            return Vec::new();
        };
        self.sequence(&book.root, true).unwrap_or_default()
    }

    /// The entries of [`Self::book_sequence`] that carry book prose, in order,
    /// numbered or not (`MANUSCRIPT-NUMBER-OUTERMOST-PROSE`).
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

    /// The 1-based number of `id` in [`Self::book_sequence`], if it has one.
    pub fn ordinal(&self, id: &EntryId) -> Option<u32> {
        self.book_sequence()
            .into_iter()
            .find(|e| &e.entry.id == id)
            .and_then(|e| e.ordinal)
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
