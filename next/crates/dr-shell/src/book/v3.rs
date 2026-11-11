//! V3 query snapshot. Level values and provenance come from the same F3 DTO;
//! every query must share the book frontier before the snapshot is published.
use std::collections::{BTreeMap, BTreeSet};

use dr_doc::v3::BorrowedBookV3;
use dr_ui::sand;
use dr_workspace::{
    Workspace, WsError,
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
    #[serde(skip)]
    hosts_by_member: BTreeMap<String, BTreeSet<String>>,
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
        }
    }
    /// Metadata for every entry surface. Marks keep the template's vocabulary;
    /// the sand renderer maps the built-in marks to the existing visual family.
    pub fn appearance(&self, id: &str) -> Option<Appearance> {
        let entry = self.entry(id)?;
        let template = self.template_of(id);
        let own_color = self.own_color(id);
        let color = if template.is_some_and(|t| t.kind == "leaf") {
            let valid = self.hosts_by_member.get(id);
            let primary = entry
                .primary
                .as_deref()
                .filter(|&p| valid.is_some_and(|s| s.contains(p)))
                .or_else(|| valid.and_then(|s| s.first().map(String::as_str)));
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

        let ms_levels = dr_model::v3::effective_manuscript_levels(entries_map, templates_map);
        let mut manuscript = Vec::new();
        for level_id in ms_levels {
            for entry in structure.entries() {
                if entry.is_trashed() || !entry.is_leaf(templates_map) {
                    continue;
                }
                let anc = dr_model::v3::effective_ancestors(entries_map, templates_map, &entry.id);
                if anc.contains(&level_id)
                    && anc
                        .iter()
                        .all(|a| entries_map.get(a).is_some_and(|ae| !ae.is_trashed()))
                    && let Some(template) = entry.effective_template(templates_map)
                {
                    for module in template.prose_modules() {
                        manuscript.push(ManuscriptBody {
                            entry: entry.id.to_string(),
                            module: module.id.to_string(),
                            title: entry.title.clone(),
                        });
                    }
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

        Ok((
            meta.name,
            BookV3 {
                revision: version,
                manuscript,
                entries,
                templates,
                roots,
                levels,
                memberships,
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
    for m in &v3.memberships {
        v3.hosts_by_member
            .entry(m.member.clone())
            .or_default()
            .insert(m.host.clone());
    }
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
