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

use super::{Book, Entry, Snapshot, color_of, seal_of};
use crate::nav::Target;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SettingSource {
    Default,
    Override {
        entry: String,
    },
    Template {
        entry: String,
        template: String,
    },
    /// A lane always accepts members, even if an override says false.
    Lane {
        entry: String,
    },
}

impl From<entry::SettingSource> for SettingSource {
    fn from(source: entry::SettingSource) -> Self {
        match source {
            entry::SettingSource::Default => Self::Default,
            entry::SettingSource::Override { entry } => Self::Override { entry },
            entry::SettingSource::Template { entry, template } => {
                Self::Template { entry, template }
            }
            entry::SettingSource::Lane { entry } => Self::Lane { entry },
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
#[derive(Default, Serialize)]
pub struct BookV3 {
    pub revision: String,
    pub manuscript: Vec<ManuscriptBody>,
    /// Effective tree traversal order; each row preserves its raw parent.
    pub entries: Vec<types::Entry>,
    pub templates: Vec<types::EntryTemplate>,
    pub roots: Vec<String>,
    pub levels: BTreeMap<String, Level>,
    pub memberships: Vec<types::Membership>,
    pub timeline_views: Vec<types::TimelineView>,
    pub materials: Vec<dr_workspace::dto::MaterialInfo>,
    pub material_folders: Vec<dr_workspace::dto::GroupInfo>,
    #[serde(skip)]
    entry_index: BTreeMap<String, usize>,
    #[serde(skip)]
    template_index: BTreeMap<String, usize>,
    /// Each live entry's colour ([`dr_model::v3::entry_color`]), from the
    /// same read.
    #[serde(skip)]
    colors: BTreeMap<String, String>,
    #[serde(skip)]
    ordinals: BTreeMap<String, u32>,
    /// The outermost manuscript levels, the only ones `is_manuscript` counts on.
    #[serde(skip)]
    manuscript_roots: BTreeSet<String>,
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
            let mut level = self.entry(id);
            while let Some(entry) = level {
                if !keys.insert(("entries", entry.id.as_str())) {
                    break;
                }
                if let Some(template) = entry.template.as_deref() {
                    keys.insert(("templates", template));
                }
                level = entry
                    .parent
                    .as_deref()
                    .and_then(|parent| self.entry(parent));
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
            // A level's flattened book view stays valid only while the entry
            // survives and its level switch remains on.
            Target::Book(id) => self.entry(id.as_str()).is_some_and(|e| e.level),
            // A switched template may leave a retained prose module. Its page
            // renderer resolves module.list; removing a definition must not
            // close the author's tab while the entry and its content survive.
            Target::Entry { id, .. } => self.entry(id.as_str()).is_some(),
            Target::Template(id) => self.template(id.as_str()).is_some(),
            Target::Material(id) => self.materials.iter().any(|m| m.id == id.as_str()),
        }
    }
    /// The 1-based chapter ordinal of `id` when it carries book prose in the
    /// manuscript sequence.
    pub fn manuscript_number(&self, id: &str) -> Option<u32> {
        self.ordinals.get(id).copied()
    }
    /// Whether `id` is an outermost level that declares itself a manuscript:
    /// the only kind `is_manuscript` counts on (`kernel-v4.md` "成书"),
    /// whatever the settings below it resolve to.
    pub fn is_manuscript_root(&self, id: &str) -> bool {
        self.manuscript_roots.contains(id)
    }
    /// Whether `id` holds content rather than organising it: its template
    /// is `linkable` (`kernel-v4.md` §2), and an entry without a template
    /// counts as content. A content entry is shown as a card whether or not
    /// its switch is on; only an organising entry is shown as a group.
    pub fn is_content(&self, id: &str) -> bool {
        self.entry(id).is_some() && self.template_of(id).is_none_or(|t| t.linkable)
    }
    /// Metadata for every entry surface. Marks keep the template's vocabulary;
    /// the sand renderer maps the built-in marks to the existing visual family.
    pub fn appearance(&self, id: &str) -> Option<Appearance> {
        self.entry(id)?;
        let template = self.template_of(id);
        Some(Appearance {
            mark: template.and_then(|t| t.mark.clone()),
            color: self.colors.get(id).cloned(),
            sand: mark(template.and_then(|t| t.mark.as_deref()), id),
        })
    }
    /// Whether `id` is a timeline swimlane: its switch is on and `lane` is
    /// set on its own overrides, else on its template.
    pub fn is_lane(&self, id: &str) -> bool {
        self.entry(id).is_some_and(|e| {
            e.level
                && e.overrides
                    .as_ref()
                    .and_then(|o| o.lane)
                    .or_else(|| self.template_of(id).and_then(|t| t.settings.lane))
                    .unwrap_or(false)
        })
    }
}

#[derive(Clone, Debug)]
pub struct Appearance {
    pub mark: Option<String>,
    pub color: Option<String>,
    pub sand: sand::Kind,
}

pub fn mark(name: Option<&str>, id: &str) -> sand::Kind {
    match name {
        Some("book") => sand::Kind::All,
        Some("file-text") => sand::Kind::Chapter(seal_of(id)),
        Some("lightbulb" | "sparkles") => sand::Kind::Drift { loose: false },
        Some("folder" | "tag") => sand::Kind::Category,
        Some("compass" | "route") => sand::Kind::Storyline,
        Some("git-branch") => sand::Kind::DriftGroup,
        _ => sand::Kind::Element,
    }
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
                (
                    e.id.to_string(),
                    Level {
                        settings: (&resolved.settings).into(),
                        sources: resolved
                            .sources
                            .iter()
                            .map(|(k, s)| (k.clone(), entry::SettingSource::from(s).into()))
                            .collect(),
                        children: structure
                            .children_of(Some(&e.id))
                            .into_iter()
                            .map(|c| c.id.to_string())
                            .collect(),
                        members: structure
                            .members_of(&e.id)
                            .into_iter()
                            .map(|m| m.id.to_string())
                            .collect(),
                    },
                )
            })
            .collect();
        let memberships: Vec<types::Membership> =
            structure.memberships().iter().map(Into::into).collect();
        let colors: BTreeMap<String, String> = structure
            .entries()
            .filter(|e| !e.is_trashed())
            .filter_map(|e| {
                let color = dr_model::v3::entry_color(
                    e,
                    entries_map,
                    templates_map,
                    structure.memberships(),
                )?;
                Some((e.id.to_string(), color))
            })
            .collect();

        // The manuscript sequence: each entry's own book prose before what
        // lives under it.
        let mut manuscript = Vec::new();
        let mut ordinals = BTreeMap::new();
        let mut manuscript_roots = BTreeSet::new();
        for part in structure.manuscript() {
            manuscript_roots.insert(part.root.id.to_string());
            for e in part.entries {
                if let Some(n) = e.ordinal {
                    ordinals.insert(e.entry.id.to_string(), n);
                }
                for prose in e.prose {
                    manuscript.push(ManuscriptBody {
                        entry: e.entry.id.to_string(),
                        module: prose.module.to_string(),
                        title: e.entry.title.clone(),
                    });
                }
            }
        }

        let raw_memberships = view.memberships_raw();
        let timeline_views: Vec<types::TimelineView> = view
            .timeline_views_with(entries_map, templates_map, &raw_memberships)
            .iter()
            .map(Into::into)
            .collect();
        let materials: Vec<dr_workspace::dto::MaterialInfo> =
            view.materials().iter().map(Into::into).collect();
        let material_folders: Vec<GroupInfo> = view
            .material_folders()
            .iter()
            .map(|f| GroupInfo {
                id: f.id.to_string(),
                name: f.name.clone(),
                color: None,
                parent: f.parent.as_ref().map(ToString::to_string),
            })
            .collect();

        // What a view can write over from this snapshot: every entry and its
        // place among its siblings, every template, membership, timeline
        // view, material and material folder.
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
            .chain(
                materials
                    .iter()
                    .map(|m| RecordKey::record("materials", &m.id)),
            )
            .chain(
                material_folders
                    .iter()
                    .map(|f| RecordKey::record("material_folders", &f.id)),
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
                shown,
                manuscript,
                ordinals,
                manuscript_roots,
                entries,
                templates,
                roots,
                levels,
                memberships,
                colors,
                timeline_views,
                materials,
                material_folders,
                ..Default::default()
            },
        ))
    })?;

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
        v3.materials.len() + v3.entries.len() + v3.templates.len(),
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
    Ok(Book {
        id: id.to_owned(),
        name,
        snapshot: Snapshot::V3(Box::new(v3)),
        index,
    })
}
