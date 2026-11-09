//! V3 query snapshot. Effective values come from F3; provenance describes the
//! same precedence using its returned entries/templates, never another read of Loro.
use std::collections::{BTreeMap, BTreeSet};

use dr_doc::v3::BorrowedBookV3;
use dr_model::v3 as model;
use dr_ui::sand;
use dr_workspace::{
    Actor, Workspace, WsError,
    commands::{
        BookIn, EntityIn,
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

fn convert<T: serde::de::DeserializeOwned>(v: impl Serialize) -> Result<T, WsError> {
    serde_json::to_value(v)
        .and_then(serde_json::from_value)
        .map_err(|e| WsError::Internal(e.to_string()))
}

const SETTINGS: [&str; 8] = [
    "default_template",
    "allow",
    "display",
    "auto_link",
    "accept",
    "home",
    "is_manuscript",
    "format_shortcuts",
];

fn specified(s: &model::LevelSettingsOverride, key: &str) -> bool {
    match key {
        "default_template" => s.default_template.is_some(),
        "allow" => s.allow.is_some(),
        "display" => s.display.is_some(),
        "auto_link" => s.auto_link.is_some(),
        "accept" => s.accept.is_some(),
        "home" => s.home.is_some(),
        "is_manuscript" => s.is_manuscript.is_some(),
        "format_shortcuts" => s.format_shortcuts.is_some(),
        _ => false,
    }
}

fn sources(
    id: &model::EntryId,
    entries: &BTreeMap<model::EntryId, model::Entry>,
    templates: &BTreeMap<model::EntryTemplateId, model::EntryTemplate>,
) -> BTreeMap<String, SettingSource> {
    let chain = std::iter::once(id.clone())
        .chain(model::effective_ancestors(entries, templates, id))
        .collect::<Vec<_>>();
    SETTINGS
        .into_iter()
        .map(|key| {
            let source = if key == "accept" && entries[id].is_lane_level(templates) {
                SettingSource::Lane {
                    entry: id.to_string(),
                    template: entries[id].template.as_ref().unwrap().to_string(),
                }
            } else {
                chain
                    .iter()
                    .find_map(|ancestor| {
                        let entry = entries.get(ancestor)?;
                        if entry.overrides.as_ref().is_some_and(|s| specified(s, key)) {
                            return Some(SettingSource::Override {
                                entry: ancestor.to_string(),
                            });
                        }
                        entry
                            .effective_template(templates)
                            .filter(|t| t.is_level() && specified(&t.settings, key))
                            .map(|t| SettingSource::Template {
                                entry: ancestor.to_string(),
                                template: t.id.to_string(),
                            })
                    })
                    .unwrap_or(SettingSource::Default)
            };
            (key.to_owned(), source)
        })
        .collect()
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
        let model_entries: Vec<model::Entry> = convert(&entries)?;
        let model_templates: Vec<model::EntryTemplate> = convert(&templates)?;
        let em: BTreeMap<_, _> = model_entries
            .into_iter()
            .map(|e| (e.id.clone(), e))
            .collect();
        let tm: BTreeMap<_, _> = model_templates
            .into_iter()
            .map(|t| (t.id.clone(), t))
            .collect();
        let mut levels = BTreeMap::new();
        for e in em.values().filter(|e| !e.is_trashed() && e.is_level(&tm)) {
            let info = lib
                .run::<entry::LevelGet>(
                    &Actor::User,
                    EntityIn {
                        book: id.to_owned(),
                        id: e.id.to_string(),
                    },
                )?
                .output;
            levels.insert(
                e.id.to_string(),
                Level {
                    settings: info.settings,
                    sources: sources(&e.id, &em, &tm),
                    children: info.children.into_iter().map(|e| e.id).collect(),
                    members: info.members.into_iter().map(|e| e.id).collect(),
                },
            );
        }
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
        if before.version != after.version {
            continue;
        }
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
