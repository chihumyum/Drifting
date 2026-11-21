//! V3 query snapshot. Level values and provenance come from the same F3 DTO;
//! every query must share the book frontier before the snapshot is published.
use std::collections::{BTreeMap, BTreeSet};

use dr_doc::v3::BorrowedBookV3;
use dr_ui::sand;
use dr_workspace::{
    RecordKey, RecordPrecondition, Workspace, WritePreconditions, WsError,
    commands::v3::{entry, types},
    dto::GroupInfo,
};
use serde::Serialize;

use super::{Book, Entry, MaterialInfo, Snapshot, color_of, seal_of};
use crate::nav::Target;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SettingSource {
    Default,
    Override { entry: String },
    Template { entry: String, template: String },
}

impl From<entry::SettingSource> for SettingSource {
    fn from(source: entry::SettingSource) -> Self {
        match source {
            entry::SettingSource::Default => Self::Default,
            entry::SettingSource::Override { entry } => Self::Override { entry },
            entry::SettingSource::Template { entry, template } => {
                Self::Template { entry, template }
            }
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Level {
    pub settings: types::LevelSettings,
    pub sources: BTreeMap<String, SettingSource>,
    /// Effective resident children, in manuscript order (leaf-parent tolerance).
    pub children: Vec<String>,
    /// Accepted memberships, in their query order; residence is unchanged.
    pub members: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ManuscriptBody {
    pub entry: String,
    pub module: String,
    pub title: String,
}
pub type ScopeLayouts = BTreeMap<String, BTreeMap<String, (f64, f64)>>;
pub type BookLayouts = BTreeMap<String, ScopeLayouts>;

/// A spot outside prose text that can show a comment underline or dot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OpenSpotKind {
    EntryTitle {
        entry: String,
    },
    ModuleHeader {
        entry: String,
        module: String,
    },
    Field {
        entry: String,
        module: String,
        field: String,
    },
    KvRow {
        entry: String,
        module: String,
        row: String,
    },
    PlotCell {
        entry: String,
        module: String,
        row: String,
        col: String,
    },
    Patch {
        entry: String,
        module: String,
        patch: String,
    },
    Media {
        entry: String,
        module: String,
        asset: String,
    },
    Embed {
        entry: String,
        module: String,
        embed: String,
        asset: Option<String>,
    },
    Asset {
        asset: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenCommentSpot {
    pub id: String,
    pub spot: OpenSpotKind,
}

/// An entry in Recently Deleted, as the left column lists it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Trashed {
    pub id: String,
    pub title: String,
    /// Its mark: its own, or its template's.
    pub mark: Option<String>,
    /// When it went in (Unix seconds).
    pub deleted_at: i64,
    /// The entry it lived under and went in with (`ENTRY-TRASH-TOGETHER`):
    /// it is folded under that one's row. `None`: a row of its own.
    pub with: Option<String>,
    /// What went in with it and lived directly under it, in tree order.
    pub folded: Vec<String>,
    /// Where it lives once restored on its own (`restored_residence`):
    /// an entry, or the outermost (`None`)…
    pub lands: Option<String>,
    /// … and that entry's title.
    pub lands_title: Option<String>,
    /// For a row of its own: every entry whose Tab tree showed it or what
    /// went in with it (where they lived, all the way up, and where they
    /// were hung, all the way up from there).
    pub places: BTreeSet<String>,
    /// For a row of its own: it, or something that went in with it, has
    /// prose that is part of the book (a Tab on the book showed it).
    pub in_book: bool,
}

#[derive(Clone, Default, Serialize)]
pub struct BookV3 {
    pub revision: String,
    pub project: types::Project,
    pub manuscript: Vec<ManuscriptBody>,
    /// Effective tree traversal order; each row preserves its raw parent.
    pub entries: Vec<types::Entry>,
    pub templates: Vec<types::EntryTemplate>,
    pub roots: Vec<String>,
    pub levels: BTreeMap<String, Level>,
    pub memberships: Vec<types::Membership>,
    pub timeline_views: Vec<types::TimelineView>,
    pub layouts: BookLayouts,
    /// The titles of the entries in Recently Deleted: what a Tab mounted on
    /// one of them says (`kernel-v5.md` §5).
    pub trashed_titles: BTreeMap<String, String>,
    /// Every entry in Recently Deleted as the left column's 「最近删除」
    /// lists it (`kernel-v5.md` §16, author 2026-11-21 一甲): what each went
    /// in with, where it goes back to, which Tabs it was in.
    pub trash: BTreeMap<String, Trashed>,
    /// The rows of its own (what went in on its own, not with the entry it
    /// lived under), the most recently deleted first.
    pub trash_roots: Vec<String>,
    /// The Tab the project was left on as stored (`layout:<书>`), even when
    /// that Tab is gone: opening on a gone Tab goes to the first Tab, never
    /// having chosen one goes to 「全部」 (Tab prototype, 2026-11-15).
    /// `project.selected_tab` is the same, kept only while the Tab is there.
    pub stored_tab: Option<String>,
    pub materials: Vec<MaterialInfo>,
    pub material_folders: Vec<GroupInfo>,
    #[serde(skip)]
    pub media_items: BTreeMap<String, MaterialInfo>,
    #[serde(skip)]
    pub open_comments: Vec<OpenCommentSpot>,
    #[serde(skip)]
    entry_index: BTreeMap<String, usize>,
    #[serde(skip)]
    template_index: BTreeMap<String, usize>,
    /// Each live entry's colour ([`dr_model::v3::entry_color`]), from the
    /// same read.
    #[serde(skip)]
    colors: BTreeMap<String, String>,
    /// The digest of every record this snapshot shows, from the same read.
    #[serde(skip)]
    shown: Vec<RecordPrecondition>,
    #[serde(skip)]
    shown_index: std::collections::HashMap<RecordKey, usize>,
}

impl BookV3 {
    /// The guard of a write made from this snapshot: the workspace holds it
    /// to the shown records the write replaces, so an edit made from a
    /// snapshot that has since fallen behind is refused only when what it
    /// writes over changed (f3-write-guards.md). Keep the guard of the
    /// snapshot a draft was started from; never take a newer one to submit
    /// an older draft.
    pub fn guard(&self) -> WritePreconditions {
        WritePreconditions::default().with_shown(self.shown.iter().cloned())
    }

    /// The guard of a command a view built from this snapshot with `input`:
    /// [`Self::guard`], and held as well to every entry and template the
    /// input names, to the levels above those entries and to the templates
    /// of all of them. That is where what a dialog showed came from (where
    /// a new entry will live, what a level accepts, which template applies),
    /// whether or not the command replaces any of it.
    pub fn guard_for(&self, input: &serde_json::Value) -> WritePreconditions {
        let mut named = BTreeSet::new();
        let mut values = vec![input];
        while let Some(value) = values.pop() {
            match value {
                serde_json::Value::String(s) => {
                    named.insert(s.as_str());
                }
                serde_json::Value::Array(items) => values.extend(items),
                serde_json::Value::Object(fields) => values.extend(fields.values()),
                _ => {}
            }
        }
        let mut keys = BTreeSet::new();
        for id in named {
            if self.template_index.contains_key(id) {
                keys.insert(("templates", id));
            }
            if let Some(entry) = self.entry(id) {
                let own_home = entry
                    .overrides
                    .as_ref()
                    .and_then(|o| o.home.as_ref())
                    .or_else(|| self.template_of(id).and_then(|t| t.settings.home.as_ref()))
                    .and_then(|h| h.as_deref());
                for start in [Some(entry), own_home.and_then(|h| self.entry(h))] {
                    let mut level = start;
                    while let Some(cur) = level {
                        if !keys.insert(("entries", cur.id.as_str())) {
                            break;
                        }
                        if let Some(template) = cur.template.as_deref() {
                            keys.insert(("templates", template));
                        }
                        level = cur.parent.as_deref().and_then(|parent| self.entry(parent));
                    }
                }
            }
        }
        let mut guard = self.guard();
        guard.records.extend(
            keys.into_iter()
                .filter_map(|(collection, id)| {
                    self.shown_index.get(&RecordKey::record(collection, id))
                })
                .map(|&i| self.shown[i].clone()),
        );
        guard
    }
    /// The digest observed when this snapshot read `key`, such as a level's
    /// ordered child list (`RecordKey::children_of`).
    pub fn shown_precondition(&self, key: &RecordKey) -> Option<RecordPrecondition> {
        self.shown_index.get(key).map(|&i| self.shown[i].clone())
    }
    pub fn entry(&self, id: &str) -> Option<&types::Entry> {
        self.entry_index.get(id).map(|&i| &self.entries[i])
    }
    pub fn template(&self, id: &str) -> Option<&types::EntryTemplate> {
        self.template_index
            .get(id)
            .map(|&i| &self.templates[i])
            .filter(|t| t.deleted_at.is_none())
    }
    pub fn template_of(&self, id: &str) -> Option<&types::EntryTemplate> {
        self.entry(id)?
            .template
            .as_deref()
            .and_then(|id| self.template(id))
    }
    pub fn exists(&self, target: &Target) -> bool {
        match target {
            // A flattened book view stays valid while the entry survives and
            // can hold or accept entries below it.
            Target::Book(id) => self.has_below(id.as_str()),
            Target::BookView(view) => self
                .timeline_views
                .iter()
                .any(|v| v.deleted_at.is_none() && v.id == view.as_str()),
            Target::BookLane { view, entry } => {
                self.has_below(entry.as_str())
                    && self.timeline_views.iter().any(|v| {
                        v.deleted_at.is_none()
                            && v.id == view.as_str()
                            && v.lanes.iter().any(|l| l.entry == entry.as_str())
                    })
            }
            // A switched template may leave a retained prose module. Its page
            // renderer resolves module.list; removing a definition must not
            // close the author's tab while the entry and its content survive.
            Target::Entry { id, .. } => self.entry(id.as_str()).is_some(),
            Target::Template(id) => self.template(id.as_str()).is_some(),
            Target::Material(id) => {
                self.materials.iter().any(|m| m.id == id.as_str())
                    || self.media_items.contains_key(id.as_str())
            }
        }
    }
    /// Standalone asset viewer row for `id` (present for every live `Asset`,
    /// even when the same file is also placed in an entry's media module).
    pub fn open_spot_ids(&self, want: &OpenSpotKind) -> Vec<String> {
        self.open_comments
            .iter()
            .filter(|c| &c.spot == want)
            .map(|c| c.id.clone())
            .collect()
    }
    pub fn entry_title_comments(&self, entry: &str) -> Vec<String> {
        self.open_spot_ids(&OpenSpotKind::EntryTitle {
            entry: entry.to_owned(),
        })
    }
    pub fn module_header_comments(&self, entry: &str, module: &str) -> Vec<String> {
        self.open_spot_ids(&OpenSpotKind::ModuleHeader {
            entry: entry.to_owned(),
            module: module.to_owned(),
        })
    }
    pub fn field_comments(&self, entry: &str, module: &str, field: &str) -> Vec<String> {
        self.open_spot_ids(&OpenSpotKind::Field {
            entry: entry.to_owned(),
            module: module.to_owned(),
            field: field.to_owned(),
        })
    }
    pub fn kv_row_comments(&self, entry: &str, module: &str, row: &str) -> Vec<String> {
        self.open_spot_ids(&OpenSpotKind::KvRow {
            entry: entry.to_owned(),
            module: module.to_owned(),
            row: row.to_owned(),
        })
    }
    pub fn plot_cell_comments(
        &self,
        entry: &str,
        module: &str,
        row: &str,
        col: &str,
    ) -> Vec<String> {
        self.open_spot_ids(&OpenSpotKind::PlotCell {
            entry: entry.to_owned(),
            module: module.to_owned(),
            row: row.to_owned(),
            col: col.to_owned(),
        })
    }
    pub fn patch_comments(&self, entry: &str, module: &str, patch: &str) -> Vec<String> {
        self.open_spot_ids(&OpenSpotKind::Patch {
            entry: entry.to_owned(),
            module: module.to_owned(),
            patch: patch.to_owned(),
        })
    }
    pub fn media_comments(&self, entry: &str, module: &str, asset: &str) -> Vec<String> {
        self.open_spot_ids(&OpenSpotKind::Media {
            entry: entry.to_owned(),
            module: module.to_owned(),
            asset: asset.to_owned(),
        })
    }
    pub fn asset_comments(&self, asset: &str) -> Vec<String> {
        self.open_spot_ids(&OpenSpotKind::Asset {
            asset: asset.to_owned(),
        })
    }
    /// Open comments touching `asset` from any of the three places (direct on
    /// the asset, inside a media module, or embedded in prose).
    pub fn any_asset_comments(&self, asset: &str) -> Vec<String> {
        self.open_comments
            .iter()
            .filter(|c| match &c.spot {
                OpenSpotKind::Asset { asset: a } | OpenSpotKind::Media { asset: a, .. } => {
                    a == asset
                }
                OpenSpotKind::Embed { asset: Some(a), .. } => a == asset,
                _ => false,
            })
            .map(|c| c.id.clone())
            .collect()
    }
    /// Whether `id` holds content rather than organising it: its template
    /// is `linkable` (`kernel-v4.md` §2), and an entry without a template
    /// counts as content. A content entry is shown as a card whether or not
    /// its switch is on; only an organising entry is shown as a group.
    pub fn is_content(&self, id: &str) -> bool {
        self.entry(id).is_some() && self.template_of(id).is_none_or(|t| t.linkable)
    }
    /// Metadata for every entry surface. Entry `mark` overrides template `mark`;
    /// the sand renderer maps the built-in marks to the existing visual family.
    pub fn appearance(&self, id: &str) -> Option<Appearance> {
        let entry = self.entry(id)?;
        let template = self.template_of(id);
        let chosen = entry
            .mark
            .as_deref()
            .or_else(|| template.and_then(|t| t.mark.as_deref()));
        Some(Appearance {
            mark: chosen.map(str::to_owned),
            color: self.colors.get(id).cloned(),
            sand: mark(chosen, id),
        })
    }
    pub fn layout_position(&self, scope: &str, mode: &str, entry: &str) -> Option<(f64, f64)> {
        self.layouts
            .get(scope)
            .and_then(|m| m.get(mode))
            .and_then(|e| e.get(entry))
            .copied()
    }
    /// Whether `id` accepts memberships on its own (`overrides.accept` else
    /// `template.settings.accept`).
    pub fn accepts_members(&self, id: &str) -> bool {
        self.entry(id).is_some_and(|e| {
            e.overrides
                .as_ref()
                .and_then(|o| o.accept)
                .or_else(|| self.template_of(id).and_then(|t| t.settings.accept))
                .unwrap_or(false)
        })
    }
    /// Whether `id` can have entries below it (`level` or `accept`).
    pub fn has_below(&self, id: &str) -> bool {
        self.entry(id)
            .is_some_and(|e| e.level || self.accepts_members(id))
    }
    /// The live view whose scale orders what is hung on `id` while it is a
    /// lane (`kernel-v5.md` §4 「视图：刻度」): the first live view it is a lane
    /// in. What lives under it keeps its manual order (DV, 2026-11-16); only
    /// an entry that takes entries from elsewhere is a lane.
    pub fn ordering_view(&self, id: &str) -> Option<&types::TimelineView> {
        self.timeline_views
            .iter()
            .find(|v| v.deleted_at.is_none() && v.lanes.iter().any(|l| l.entry == id))
    }
    /// A live timeline view.
    pub fn timeline_view(&self, id: &str) -> Option<&types::TimelineView> {
        self.timeline_views
            .iter()
            .find(|v| v.id == id && v.deleted_at.is_none())
    }
    /// The entries of `lane` in `view` along the view's scale (`kernel-v5.md`
    /// §16 「泳道」): those hung on it while it takes entries from elsewhere,
    /// each once; unplaced ones last, ties by id. What only lives under it is
    /// not on the lane (DV, 2026-11-16).
    pub fn lane_entries(&self, view: &types::TimelineView, lane: &str) -> Vec<String> {
        let Some(level) = self.levels.get(lane) else {
            return Vec::new();
        };
        let mut seen = BTreeSet::new();
        let mut ids: Vec<String> = level
            .members
            .iter()
            .filter(|id| seen.insert(id.as_str()))
            .cloned()
            .collect();
        let at: BTreeMap<&str, f64> = view
            .placements
            .iter()
            .map(|p| (p.entry.as_str(), p.at))
            .collect();
        ids.sort_by(|a, b| {
            match (at.get(a.as_str()), at.get(b.as_str())) {
                (Some(x), Some(y)) => x.total_cmp(y),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            }
            .then_with(|| a.cmp(b))
        });
        ids
    }
    /// The entries of the book sequence in order (`project.book`), each
    /// once: what a Tab mounted on the book lists.
    pub fn book_entries(&self) -> Vec<String> {
        let mut seen = BTreeSet::new();
        self.manuscript
            .iter()
            .filter(|b| seen.insert(b.entry.as_str()))
            .map(|b| b.entry.clone())
            .collect()
    }

    /// Whether `id` is currently an active swimlane in at least one live
    /// timeline view.
    pub fn is_lane(&self, id: &str) -> bool {
        self.timeline_views
            .iter()
            .filter(|v| v.deleted_at.is_none())
            .any(|v| v.lanes.iter().any(|l| l.entry == id))
    }
}

#[derive(Clone, Debug)]
pub struct Appearance {
    pub mark: Option<String>,
    pub color: Option<String>,
    pub sand: sand::Kind,
}

/// The sand marks an author can pick (`kernel-v5.md` §8), one name for each
/// of the seven kinds: what the mark pickers list, in this order.
pub const SAND_MARKS: [&str; 7] = [
    "file-text",
    "square",
    "compass",
    "folder",
    "lightbulb",
    "git-branch",
    "book",
];

/// Whether `name` names a sand mark (one of [`SAND_MARKS`] or a name the
/// built-in templates also use for one of them).
pub fn is_sand_mark(name: &str) -> bool {
    SAND_MARKS.contains(&name) || matches!(name, "sparkles" | "tag" | "route")
}

/// How `name` is drawn for `id`: a sand mark by name, otherwise the single
/// character the author picked (`dr_model::v3::is_valid_mark`); anything
/// else (a name this build does not know) is the square seal.
pub fn mark(name: Option<&str>, id: &str) -> sand::Kind {
    match name {
        Some("book") => sand::Kind::All,
        Some("file-text") => sand::Kind::Chapter(seal_of(id)),
        Some("lightbulb" | "sparkles") => sand::Kind::Drift { loose: false },
        Some("folder" | "tag") => sand::Kind::Category,
        Some("compass" | "route") => sand::Kind::Storyline,
        Some("git-branch") => sand::Kind::DriftGroup,
        Some(text) if is_glyph_mark(text) => sand::Kind::Glyph(sand::Glyph::new(text)),
        _ => sand::Kind::Element,
    }
}

/// Whether `mark` is drawn as its own character: a valid mark that is one
/// grapheme and not a sand mark's name.
pub fn is_glyph_mark(mark: &str) -> bool {
    // A valid mark is a name (lowercase ASCII, digits and `-`) or one
    // grapheme; a one-letter name is that letter.
    let name = mark
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    !is_sand_mark(mark) && dr_model::v3::is_valid_mark(mark) && (!name || mark.len() == 1)
}

/// Every entry in Recently Deleted (`kernel-v5.md` §16), and the rows of
/// their own, the most recently deleted first (ties in tree order). What
/// went in with an entry is what `entry.restore` brings back with it and
/// `entry.purge` deletes with it (`dr_model::v3::trashed_with`); where each
/// lands is where `entry.restore` puts it (`restored_residence`).
fn recently_deleted(
    structure: &dr_doc::v3::BookStructureV3,
    memberships: &[dr_model::v3::Membership],
) -> (BTreeMap<String, Trashed>, Vec<String>) {
    use dr_model::v3 as m;
    let entries = structure.entries_map();
    let templates = structure.templates_map();
    let gone: Vec<&m::Entry> = structure.entries().filter(|e| e.is_trashed()).collect();
    if gone.is_empty() {
        return (BTreeMap::new(), Vec::new());
    }
    let went_in_with = |e: &m::Entry| {
        e.parent
            .as_ref()
            .and_then(|p| entries.get(p))
            .filter(|p| p.deleted_at == e.deleted_at)
            .map(|p| p.id.to_string())
    };
    let up = |id: &m::EntryId| {
        m::ancestors_without_cycle(entries, id)
            .into_iter()
            .map(|a| a.to_string())
    };
    let mut out: BTreeMap<String, Trashed> = gone
        .iter()
        .map(|e| {
            let lands = m::restored_residence(entries, &e.id);
            let trashed = Trashed {
                id: e.id.to_string(),
                title: e.title.clone(),
                mark: e.effective_mark(templates).map(str::to_owned),
                deleted_at: e.deleted_at.map_or(0, |t| t.0),
                with: went_in_with(e),
                folded: Vec::new(),
                lands_title: lands
                    .as_ref()
                    .and_then(|l| entries.get(l))
                    .map(|l| l.title.clone()),
                lands: lands.map(|l| l.to_string()),
                places: BTreeSet::new(),
                in_book: false,
            };
            (trashed.id.clone(), trashed)
        })
        .collect();
    // In tree order: a row's folded rows in the order the book had them.
    for e in &gone {
        if let Some(with) = went_in_with(e)
            && let Some(parent) = out.get_mut(&with)
        {
            parent.folded.push(e.id.to_string());
        }
    }
    let mut roots: Vec<(i64, usize, String)> = Vec::new();
    for (order, e) in gone.iter().enumerate() {
        if went_in_with(e).is_some() {
            continue;
        }
        let batch = m::trashed_with(entries, &e.id);
        let mut places = BTreeSet::new();
        let mut in_book = false;
        for id in &batch {
            places.extend(up(id));
            for ms in memberships.iter().filter(|ms| &ms.member == id) {
                places.insert(ms.host.to_string());
                places.extend(up(&ms.host));
            }
            in_book |= entries
                .get(id)
                .and_then(|x| x.effective_template(templates))
                .is_some_and(|t| t.book_prose_modules().next().is_some());
        }
        let id = e.id.to_string();
        if let Some(row) = out.get_mut(&id) {
            row.places = places;
            row.in_book = in_book;
        }
        roots.push((e.deleted_at.map_or(0, |t| t.0), order, id));
    }
    roots.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    (out, roots.into_iter().map(|(_, _, id)| id).collect())
}

pub(crate) fn parse_layout_positions(raw: dr_workspace::LayoutPositions) -> BookLayouts {
    let mut out = BookLayouts::new();
    for (scope_mode, entries) in raw {
        if let Some((scope, mode)) = scope_mode.split_once('/') {
            out.entry(scope.to_owned())
                .or_default()
                .insert(mode.to_owned(), entries);
        }
    }
    out
}

pub(super) fn load(lib: &Workspace, id: &str) -> Result<Book, WsError> {
    let book_id = dr_model::id::BookId::parse(id).map_err(|e| WsError::Invalid(e.to_string()))?;
    let id_owned = id.to_owned();
    let (name, mut v3) = lib.read_book_v3(id, move |doc, version| {
        let bb = BorrowedBookV3::new(doc, &book_id).map_err(|e| WsError::Invalid(e.to_string()))?;
        let view = bb.view();
        let meta = view.meta();
        if meta.deleted_at.is_some() {
            return Err(WsError::NotFound {
                what: "book",
                id: id_owned.clone(),
            });
        }
        let structure = view.structure_snapshot();
        let entries_map = structure.entries_map();
        let templates_map = structure.templates_map();

        let entries: Vec<types::Entry> = structure
            .entries()
            .filter(|e| !e.is_trashed())
            .map(Into::into)
            .collect();
        let trashed_titles: BTreeMap<String, String> = structure
            .entries()
            .filter(|e| e.is_trashed())
            .map(|e| (e.id.to_string(), e.title.clone()))
            .collect();
        let (trash, trash_roots) = recently_deleted(&structure, &view.memberships_raw());
        let templates: Vec<types::EntryTemplate> = templates_map.values().map(Into::into).collect();
        let roots: Vec<String> = structure
            .children_of(None)
            .into_iter()
            .map(|e| e.id.to_string())
            .collect();
        let levels: BTreeMap<String, Level> = structure
            .levels()
            .map(|e| {
                let resolved = structure.level_settings(&e.id).expect("live level");
                let children: Vec<String> = if e.is_level() {
                    structure
                        .children_of(Some(&e.id))
                        .into_iter()
                        .map(|c| c.id.to_string())
                        .collect()
                } else {
                    Vec::new()
                };
                let child_ids: BTreeSet<&str> = children.iter().map(String::as_str).collect();
                let members: Vec<String> = if e.accepts_members(templates_map) {
                    structure
                        .members_of(&e.id)
                        .into_iter()
                        .filter(|m| !child_ids.contains(m.id.as_str()))
                        .map(|m| m.id.to_string())
                        .collect()
                } else {
                    Vec::new()
                };
                (
                    e.id.to_string(),
                    Level {
                        settings: (&resolved.settings).into(),
                        sources: resolved
                            .sources
                            .iter()
                            .map(|(k, s)| (k.clone(), entry::SettingSource::from(s).into()))
                            .collect(),
                        children,
                        members,
                    },
                )
            })
            .collect();
        let memberships: Vec<types::Membership> =
            structure.memberships().iter().map(Into::into).collect();
        let raw_views = view.timeline_views_raw();
        let colors: BTreeMap<String, String> = structure
            .entries()
            .filter(|e| !e.is_trashed())
            .filter_map(|e| {
                let color = dr_model::v3::entry_color(
                    e,
                    entries_map,
                    templates_map,
                    structure.memberships(),
                    &raw_views,
                )?;
                Some((e.id.to_string(), color))
            })
            .collect();

        let project = types::Project::of(&structure);
        // The book sequence (`project.book`): entries with book prose, in sequence order.
        let mut manuscript = Vec::new();
        for e in structure.book_sequence() {
            for prose in e.prose {
                manuscript.push(ManuscriptBody {
                    entry: e.entry.id.to_string(),
                    module: prose.module.to_string(),
                    title: e.entry.title.clone(),
                });
            }
        }

        let raw_memberships = view.memberships_raw();
        let timeline_views: Vec<types::TimelineView> = view
            .timeline_views_with(entries_map, templates_map, &raw_memberships)
            .iter()
            .map(Into::into)
            .collect();
        let mut live_assets = view.assets();
        live_assets.sort_by(|a, b| {
            dr_model::pos::cmp_pos((a.pos.as_ref(), &a.id), (b.pos.as_ref(), &b.id))
        });
        let assets_by_id: BTreeMap<String, dr_model::shared::Asset> = live_assets
            .iter()
            .map(|a| (a.id.to_string(), a.clone()))
            .collect();
        let materials: Vec<MaterialInfo> = live_assets
            .iter()
            .map(|a| MaterialInfo {
                id: a.id.to_string(),
                kind: a.kind.as_str().to_owned(),
                title: a.name.clone(),
                description: String::new(),
                asset: Some(a.id.to_string()),
                folder: a.folder.as_ref().map(ToString::to_string),
                pos: a.pos.as_ref().map(|k| k.as_str().to_owned()),
                task_todos: false,
                entry: None,
                module: None,
            })
            .collect();
        let material_folders: Vec<GroupInfo> = view
            .asset_folders()
            .into_iter()
            .map(|f| GroupInfo {
                id: f.id.to_string(),
                name: f.name,
                color: None,
                parent: f.parent.map(|p| p.to_string()),
            })
            .collect();
        let mut media_items = BTreeMap::new();
        for e in structure.entries().filter(|e| !e.is_trashed()) {
            for (mod_id, items) in &e.media {
                for item in items {
                    let (kind, title) = match assets_by_id.get(item.asset.as_str()) {
                        Some(a) => (a.kind.as_str(), a.name.clone()),
                        None => ("image", e.title.clone()),
                    };
                    media_items.insert(
                        item.id.to_string(),
                        MaterialInfo {
                            id: item.id.to_string(),
                            kind: kind.to_owned(),
                            title,
                            description: item.caption.clone(),
                            asset: Some(item.asset.to_string()),
                            folder: None,
                            pos: item.pos.as_ref().map(|k| k.as_str().to_owned()),
                            task_todos: false,
                            entry: Some(e.id.to_string()),
                            module: Some(mod_id.to_string()),
                        },
                    );
                }
            }
        }
        let open_comments: Vec<OpenCommentSpot> = view
            .comments()
            .into_iter()
            .filter(|c| c.status == dr_model::kind::CommentStatus::Open && !c.target_missing)
            .filter_map(|c| {
                let target = c.target.as_ref()?;
                let spot = match target.kind {
                    dr_model::kind::EntityKind::Asset | dr_model::kind::EntityKind::Material => {
                        OpenSpotKind::Asset {
                            asset: target.id.clone(),
                        }
                    }
                    dr_model::kind::EntityKind::Entry => {
                        let entry = target.id.clone();
                        match (&c.target_module, &c.part) {
                            (Some(m), Some(dr_model::v3::CommentPart::Field { field })) => {
                                OpenSpotKind::Field {
                                    entry,
                                    module: m.to_string(),
                                    field: field.to_string(),
                                }
                            }
                            (Some(m), Some(dr_model::v3::CommentPart::KvRow { row })) => {
                                OpenSpotKind::KvRow {
                                    entry,
                                    module: m.to_string(),
                                    row: row.to_string(),
                                }
                            }
                            (Some(m), Some(dr_model::v3::CommentPart::PlotCell { row, col })) => {
                                OpenSpotKind::PlotCell {
                                    entry,
                                    module: m.to_string(),
                                    row: row.to_string(),
                                    col: col.to_string(),
                                }
                            }
                            (Some(m), Some(dr_model::v3::CommentPart::Patch { patch })) => {
                                OpenSpotKind::Patch {
                                    entry,
                                    module: m.to_string(),
                                    patch: patch.to_string(),
                                }
                            }
                            (Some(m), Some(dr_model::v3::CommentPart::Media { asset, .. })) => {
                                OpenSpotKind::Media {
                                    entry,
                                    module: m.to_string(),
                                    asset: asset.to_string(),
                                }
                            }
                            (Some(m), Some(dr_model::v3::CommentPart::Embed { embed, .. })) => {
                                OpenSpotKind::Embed {
                                    entry,
                                    module: m.to_string(),
                                    embed: embed.to_string(),
                                    asset: None,
                                }
                            }
                            (Some(m), None) if c.anchor.is_none() && c.target_block.is_none() => {
                                OpenSpotKind::ModuleHeader {
                                    entry,
                                    module: m.to_string(),
                                }
                            }
                            (None, None) if c.anchor.is_none() && c.target_block.is_none() => {
                                OpenSpotKind::EntryTitle { entry }
                            }
                            _ => return None,
                        }
                    }
                    _ => return None,
                };
                Some(OpenCommentSpot {
                    id: c.id.to_string(),
                    spot,
                })
            })
            .collect();

        // What a view can write over from this snapshot: every entry and its
        // place among its siblings, every template, membership, and timeline
        // view.
        let keys: Vec<RecordKey> = entries
            .iter()
            .map(|e| RecordKey::entry(&e.id))
            .chain(templates.iter().map(|t| RecordKey::template(&t.id)))
            .chain(
                memberships
                    .iter()
                    .map(|m| RecordKey::membership(&m.host, &m.member)),
            )
            .chain(
                timeline_views
                    .iter()
                    .map(|v| RecordKey::timeline_view(&v.id)),
            )
            .chain([RecordKey::children_of(None)])
            .chain(levels.keys().map(|id| RecordKey::children_of(Some(id))))
            .collect();
        let shown =
            dr_workspace::observe_records_in(&format!("book:{book_id}"), doc, &book_id, &keys)?
                .into_iter()
                .map(RecordPrecondition::from)
                .collect();

        Ok((
            meta.name,
            BookV3 {
                revision: version,
                project,
                shown,
                manuscript,
                entries,
                templates,
                roots,
                levels,
                memberships,
                colors,
                timeline_views,
                trashed_titles,
                trash,
                trash_roots,
                materials,
                material_folders,
                media_items,
                open_comments,
                ..Default::default()
            },
        ))
    })?;

    if v3
        .open_comments
        .iter()
        .any(|c| matches!(c.spot, OpenSpotKind::Embed { .. }))
    {
        let mut cache = std::collections::HashMap::new();
        v3.open_comments.retain_mut(|c| {
            let OpenSpotKind::Embed {
                entry,
                module,
                embed,
                asset,
            } = &mut c.spot
            else {
                return true;
            };
            let key = (entry.clone(), module.clone());
            let map = cache.entry(key).or_insert_with(|| {
                let eid = dr_model::id::EntryId::parse(entry).ok()?;
                let mid = dr_model::id::ModuleId::parse(module).ok()?;
                let doc_id = dr_model::DocId::Body(dr_model::id::BodyDocId::new(eid, mid));
                let name = doc_id.to_string();
                lib.library().doc_info(&name).ok()??;
                let mut out = std::collections::HashMap::new();
                if let Ok(handle) = lib.library().open_doc(&name, dr_store::OpenDoc::Existing)
                    && let Ok(found) = handle.read(move |doc| {
                        let mut m = std::collections::HashMap::new();
                        if let Ok(prose) = dr_doc::prose::BorrowedProse::new(doc, &doc_id) {
                            let pv = prose.view();
                            for (_, eid) in pv.embed_refs() {
                                if let Some(dr_doc::prose::EmbedView::Asset {
                                    asset: aid, ..
                                }) = pv.embed(&eid)
                                {
                                    m.insert(eid.to_string(), aid.map(|a| a.to_string()));
                                }
                            }
                        }
                        m
                    })
                {
                    out = found;
                }
                Some(out)
            });
            match map {
                None => true,
                Some(map) => match map.get(embed.as_str()) {
                    Some(found) => {
                        *asset = found.clone();
                        true
                    }
                    None => false,
                },
            }
        });
    }
    v3.layouts = parse_layout_positions(lib.layout_positions(id)?);
    v3.stored_tab = lib.stored_tab(id)?;
    v3.project = std::mem::take(&mut v3.project).with_selected_tab(v3.stored_tab.clone());
    v3.entry_index = v3
        .entries
        .iter()
        .enumerate()
        .map(|(i, e)| (e.id.clone(), i))
        .collect();
    v3.template_index = v3
        .templates
        .iter()
        .enumerate()
        .map(|(i, t)| (t.id.clone(), i))
        .collect();
    v3.shown_index = v3
        .shown
        .iter()
        .enumerate()
        .map(|(i, record)| (record.key.clone(), i))
        .collect();
    let mut index = std::collections::HashMap::with_capacity(
        v3.materials.len() + v3.media_items.len() + v3.entries.len() + v3.templates.len(),
    );
    for m in &v3.materials {
        index.insert(
            format!("material:{}", m.id),
            Entry {
                title: m.title.clone(),
                mark: sand::Kind::Material,
                color: None,
            },
        );
    }
    for m in v3.media_items.values() {
        index
            .entry(format!("material:{}", m.id))
            .or_insert_with(|| Entry {
                title: m.title.clone(),
                mark: sand::Kind::Material,
                color: None,
            });
    }
    for e in &v3.entries {
        let a = v3.appearance(&e.id).expect("indexed entry");
        index.insert(
            format!("entry:{}", e.id),
            Entry {
                title: e.title.clone(),
                mark: a.sand,
                color: a.color.as_deref().and_then(color_of),
            },
        );
    }
    for t in &v3.templates {
        index.insert(
            format!("template:{}", t.id),
            Entry {
                title: t.name.clone(),
                mark: mark(t.mark.as_deref(), &t.id),
                color: t.color.as_deref().and_then(color_of),
            },
        );
    }
    for v in v3.timeline_views.iter().filter(|v| v.deleted_at.is_none()) {
        index.insert(
            format!("timeline-view:{}", v.id),
            Entry {
                title: v.name.clone(),
                mark: sand::Kind::All,
                color: None,
            },
        );
    }
    Ok(Book {
        id: id.to_owned(),
        name,
        snapshot: Snapshot::V3(Box::new(v3)),
        index,
    })
}
