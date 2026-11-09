//! V3 query snapshot. Level values and provenance come from the same F3 DTO;
//! every query must share the book frontier before the snapshot is published.
use std::collections::{BTreeMap, BTreeSet};

use dr_doc::v3::BorrowedBookV3;
use dr_ui::sand;
use dr_workspace::{
    Actor, Workspace, WsError,
    commands::{
        BookIn,
        v3::{entry, membership, template, timeline, types},
    },
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
        template: String,
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
            entry::SettingSource::Lane { entry, template } => Self::Lane { entry, template },
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

#[derive(Default, Serialize)]
pub struct BookV3 {
    pub revision: String,
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
}

impl BookV3 {
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
            // This snapshot belongs to a loaded, live book. Its manuscript
            // page remains valid when entries move or the book is empty.
            Target::Book => true,
            // A switched template may leave a retained prose module. Its page
            // renderer resolves module.list; removing a definition must not
            // close the author's tab while the entry and its content survive.
            Target::Entry { id, .. } => self.entry(id.as_str()).is_some(),
            Target::Template(id) => self.template(id.as_str()).is_some(),
            Target::Material(id) => self.materials.iter().any(|m| m.id == id.as_str()),
            _ => false,
        }
    }
    /// Metadata for every entry surface. Marks keep the template's vocabulary;
    /// the sand renderer maps the built-in marks to the existing visual family.
    pub fn appearance(&self, id: &str) -> Option<Appearance> {
        let entry = self.entry(id)?;
        let template = self.template_of(id);
        let own_color = self.own_color(id);
        let color = if template.is_some_and(|t| t.kind == "leaf") {
            let valid: BTreeSet<&str> = self
                .memberships
                .iter()
                .filter(|m| m.member == id)
                .map(|m| m.host.as_str())
                .collect();
            let primary = entry
                .primary
                .as_deref()
                .filter(|p| valid.contains(p))
                .or_else(|| valid.first().copied());
            match primary.filter(|p| self.template_of(p).is_some_and(|t| t.lane)) {
                Some(lane) => self.own_color(lane),
                None => own_color,
            }
        } else {
            own_color
        };
        Some(Appearance {
            mark: template.and_then(|t| t.mark.clone()),
            color,
            sand: mark(template.and_then(|t| t.mark.as_deref()), id),
        })
    }
    fn own_color(&self, id: &str) -> Option<String> {
        let entry = self.entry(id)?;
        let template = self.template_of(id)?;
        // Per-entry field colour (e.g. a lane) precedes the template default.
        template
            .modules
            .iter()
            .find_map(|m| {
                let field = m.config.color_field.as_ref()?;
                match entry.fields.get(&m.id)?.get(field)? {
                    types::FieldValue::Text(s) if !s.is_empty() => Some(s.clone()),
                    _ => None,
                }
            })
            .or_else(|| template.color.clone())
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
    // A remote commit can arrive between queries. Never publish a mixed
    // snapshot: retry the batch against a stable book frontier.
    for _ in 0..3 {
        let before = lib.observe(&format!("book:{id}"))?;
        if before
            .value
            .pointer("/meta/deleted_at")
            .is_some_and(|v| !v.is_null())
        {
            return Err(WsError::NotFound {
                what: "book",
                id: id.to_owned(),
            });
        }
        let input = || BookIn {
            book: id.to_owned(),
        };
        let entries = lib
            .run::<entry::EntryList>(
                &Actor::User,
                entry::ListIn {
                    book: id.to_owned(),
                    all: true,
                    parent: None,
                    trashed: true,
                    query: None,
                },
            )?
            .output;
        let templates = lib
            .run::<template::TemplateList>(&Actor::User, input())?
            .output;
        let resolved = lib.run::<entry::LevelList>(&Actor::User, input())?.output;
        let roots = lib
            .run::<entry::EntryList>(
                &Actor::User,
                entry::ListIn {
                    book: id.to_owned(),
                    all: false,
                    parent: None,
                    trashed: false,
                    query: None,
                },
            )?
            .output
            .into_iter()
            .map(|e| e.id)
            .collect();
        let memberships = lib
            .run::<membership::MembershipList>(&Actor::User, input())?
            .output;
        let timeline_views = lib.run::<timeline::ViewList>(&Actor::User, input())?.output;
        // The v3 material command facade is not available yet. Use the same
        // typed, read-only kernel query as v3 search, within this frontier
        // check; do not infer existence from a prose document or legacy rows.
        let book_id =
            dr_model::id::BookId::parse(id).map_err(|e| WsError::Invalid(e.to_string()))?;
        let materials = lib
            .library()
            .open_doc(&format!("book:{id}"), dr_store::OpenDoc::Existing)?
            .read(move |doc| {
                let book = BorrowedBookV3::new(doc, &book_id)
                    .map_err(|e| WsError::Invalid(e.to_string()))?;
                Ok::<_, WsError>(book.view().materials().iter().map(Into::into).collect())
            })??;
        let material_folders = lib
            .run::<dr_workspace::commands::material::FolderList>(&Actor::User, input())?
            .output;
        let after = lib.observe(&format!("book:{id}"))?;
        if before.version != after.version || resolved.version != after.version {
            continue;
        }
        let levels = resolved
            .levels
            .into_iter()
            .map(|info| {
                (
                    info.id,
                    Level {
                        settings: info.settings,
                        sources: info
                            .sources
                            .into_iter()
                            .map(|(key, source)| (key, source.into()))
                            .collect(),
                        children: info.children.into_iter().map(|e| e.id).collect(),
                        members: info.members.into_iter().map(|e| e.id).collect(),
                    },
                )
            })
            .collect();
        let entries: Vec<_> = entries
            .into_iter()
            .filter(|e| e.deleted_at.is_none())
            .collect();
        let mut v3 = BookV3 {
            revision: after.version,
            entries,
            templates,
            roots,
            levels,
            memberships,
            timeline_views,
            materials,
            material_folders,
            ..Default::default()
        };
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
        let mut index = std::collections::HashMap::new();
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
        return Ok(Book {
            id: id.to_owned(),
            name: after
                .value
                .pointer("/meta/name")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_owned(),
            snapshot: Snapshot::V3(v3),
            index,
        });
    }
    Err(WsError::Conflict(
        "book changed during snapshot queries".into(),
    ))
}
