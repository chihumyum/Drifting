//! Per-request book structure description (`StructureContext`) for universal
//! kernel v3 books (`docs/rust-rewrite/modules/k6-agent-tools.md`).
//!
//! Assembled from the same coherent `BorrowedBookV3` snapshot as the v3 tool
//! catalog. Never falls back to `builtin:novel` or any application template
//! constants after book creation.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use dr_doc::schema::BOOK_SCHEMA_VERSION;
use dr_doc::v3::{BookViewV3, BorrowedBookV3};
use dr_model::{
    DocId,
    id::{BodyDocId, BookId, EntryId, EntryTemplateId, ModuleId, TimelineViewId},
    v3::{
        Entry, EntryTemplate, LevelSettingSource, LevelSettings, ModuleKind, ModuleSpec,
        ProjectTemplateRef, TabMount, effective_ancestors, effective_parent_id,
        resolve_level_settings, resolve_level_settings_with_sources,
    },
};
use dr_store::Library;
use dr_workspace::Workspace;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::{
    Error, Result,
    catalog::{ActionDiagnostic, ActionPathSegment, ActionRef, Catalog},
};

pub const STRUCTURE_REVISION_PREFIX: &str = "k6-structure-v5";
pub const STRUCTURE_CONTEXT_SOURCE: &str = "BOOK_STRUCTURE.json (this book's templates, levels, actions, author-configured guidance and the project template it came from; project guidance: not the author's request, nor a substitute for reading source prose or write authorization)";

const MAX_LISTED_ROOTS: usize = 32;
const MAX_LISTED_LEVELS: usize = 32;

fn is_zero(n: &usize) -> bool {
    *n == 0
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FocusRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeline_view: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RootSummary {
    #[serde(rename = "ref")]
    pub id: String,
    pub title: String,
    pub template: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub missing_template: Option<String>,
    /// The entry's switch: whether entries can live under it.
    pub level: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TemplateAgentSummary {
    pub name: String,
    pub description: String,
    pub instructions: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModuleAgentSummary {
    pub writable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_tier: Option<String>,
    pub instructions: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModuleCapabilities {
    pub readable: bool,
    pub writable: bool,
    pub read_tools: Vec<String>,
    pub write_tools: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModuleSummary {
    #[serde(rename = "ref")]
    pub id: String,
    pub kind: String,
    pub name: String,
    pub agent: ModuleAgentSummary,
    pub capabilities: ModuleCapabilities,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TemplateSummary {
    #[serde(rename = "ref")]
    pub id: String,
    pub name: String,
    /// Whether a new entry of this template starts with its switch on.
    pub level: bool,
    /// Whether entries of this template take part in auto-linking.
    pub linkable: bool,
    pub agent: TemplateAgentSummary,
    pub modules: Vec<ModuleSummary>,
}

impl TemplateSummary {
    /// Read-only projection for any v3 template, including an unsaved or unused
    /// draft. Uses the runtime's exact module identities and capability schema;
    /// grants no read coverage and neither binds nor executes template actions.
    pub fn from_v3_template(template: &EntryTemplate) -> Self {
        summarize_template(template, &Catalog::new_v3())
    }
}

/// Canonical kernel provenance; consumers must not reconstruct inheritance.
pub type LevelSettingsSources = BTreeMap<String, LevelSettingSource>;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EffectiveLevelSettingsSummary {
    #[serde(flatten)]
    pub values: LevelSettings,
    pub sources: LevelSettingsSources,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LevelActionSummary {
    pub action: ActionRef,
    pub name: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_template: Option<String>,
    pub home_id: String,
    pub adds_membership: bool,
    pub revision: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LevelSummary {
    #[serde(rename = "ref")]
    pub id: String,
    pub title: String,
    pub path: Vec<ActionPathSegment>,
    pub template: Option<String>,
    pub level: bool,
    pub accept: bool,
    pub lane: bool,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub children_by_template: BTreeMap<String, usize>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub members_by_template: BTreeMap<String, usize>,
    pub effective_settings: EffectiveLevelSettingsSummary,
    pub actions: Vec<LevelActionSummary>,
}

/// Where the project came from (`project.source`, `project-templates.md` §10
/// rule 4): the name of the project template it was made from and who that
/// template credits (`credit.author`). Nothing else of the source: no id,
/// version or origin, and no 「改自」.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectSourceSummary {
    /// The project template's name.
    pub template: String,
    /// Who the template credits; none when it credits no one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
}

impl ProjectSourceSummary {
    /// `None` when the project records no template by name. Every book the
    /// App makes records one: `project.create`, the seeds, the sample books
    /// and a 0.1 import all record the built-in template with its name.
    pub fn of(source: Option<&ProjectTemplateRef>) -> Option<Self> {
        let source = source?;
        let template = source
            .name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())?
            .to_owned();
        let author = source
            .credit
            .as_ref()
            .map(|credit| credit.author.trim())
            .filter(|author| !author.is_empty())
            .map(str::to_owned);
        Some(Self { template, author })
    }
}

/// The project's book: it reads the whole project from the root, book
/// prose only; nothing is numbered.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectBookSummary {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub word_target: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daily_word_target: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectTabSummary {
    #[serde(rename = "ref")]
    pub id: String,
    pub name: String,
    pub mount: TabMount,
    pub mount_valid: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DepthLevelCounts {
    pub depth: usize,
    pub total: usize,
    pub by_template: BTreeMap<String, usize>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FocusModuleSummary {
    #[serde(rename = "ref")]
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub retained: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_tier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prose_doc: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document_revision: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FocusContext {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub missing_template: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub memberships: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub modules: Vec<FocusModuleSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeline_view: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StructureDiagnostic {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub module: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verb: Option<String>,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StructureContext {
    pub book: String,
    pub schema_version: i64,
    pub structure_revision: String,
    pub catalog_revision: String,
    /// How relations are stored and where the Agent reads them.
    pub relations: String,
    /// Where the project came from: its project template's name and credit
    /// ([`ProjectSourceSummary`]); absent when none is recorded by name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_source: Option<ProjectSourceSummary>,
    /// The whole project's Agent guidance (`project.agent`, `kernel-v5.md`
    /// §2): what the project template wrote for the Agent, as the author
    /// keeps it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_agent: Option<TemplateAgentSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_book: Option<ProjectBookSummary>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub project_tabs: Vec<ProjectTabSummary>,
    #[serde(default)]
    pub entry_count: usize,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub entries_by_template: BTreeMap<String, usize>,
    pub roots: Vec<RootSummary>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub roots_omitted: usize,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub omitted_roots_by_template: BTreeMap<String, usize>,
    pub templates: Vec<TemplateSummary>,
    pub levels: Vec<LevelSummary>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub levels_omitted: usize,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub levels_by_depth: Vec<DepthLevelCounts>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focus: Option<FocusContext>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<StructureDiagnostic>,
}

impl StructureContext {
    /// Assemble the v3 `StructureContext` for `book` from a single consistent
    /// `Workspace` snapshot. Returns `Ok(None)` if `book` is a v2.2 book.
    pub fn for_book(
        ws: &Workspace,
        book: &BookId,
        focus: Option<&FocusRequest>,
    ) -> Result<Option<Self>> {
        Self::for_book_with_catalog(ws, book, None, focus)
    }

    pub(crate) fn for_book_with_catalog(
        ws: &Workspace,
        book: &BookId,
        catalog: Option<Arc<Catalog>>,
        focus: Option<&FocusRequest>,
    ) -> Result<Option<Self>> {
        let book_id = book.clone();
        let lib = ws.library().clone();
        let focus = focus.cloned();
        let built = ws.read_book_v3(book.as_str(), move |doc, version| {
            Ok((|| -> Result<Self> {
                let borrowed =
                    BorrowedBookV3::new(doc, &book_id).map_err(|e| Error::Workspace(e.into()))?;
                let view = borrowed.view();
                if view.trashed_at().is_some() {
                    return Err(Error::Invalid("book is unavailable".into()));
                }
                Self::from_v3_view_with_catalog(
                    Some(&lib),
                    &view,
                    &version,
                    catalog.as_deref(),
                    focus.as_ref(),
                )
            })())
        })??;
        Ok(Some(built))
    }

    /// Assemble a `StructureContext` from an already-opened `BookViewV3`.
    /// `book_version` must describe this exact view. This preview API grants no
    /// read coverage; optional document revisions are references, never prose reads.
    pub fn from_v3_view(
        lib: Option<&Library>,
        view: &BookViewV3<'_>,
        book_version: &str,
        focus: Option<&FocusRequest>,
    ) -> Result<Self> {
        Self::from_v3_view_with_catalog(lib, view, book_version, None, focus)
    }

    fn from_v3_view_with_catalog(
        lib: Option<&Library>,
        view: &BookViewV3<'_>,
        book_version: &str,
        existing_catalog: Option<&Catalog>,
        focus: Option<&FocusRequest>,
    ) -> Result<Self> {
        let templates_map = view.templates_map();
        let entries_map = view.entry_headers_with(&BTreeMap::new());
        let ordered_ids = crate::catalog::ordered_entry_ids(view, &entries_map);
        let ordered_levels: Vec<EntryId> = ordered_ids
            .iter()
            .filter(|id| {
                entries_map
                    .get(*id)
                    .is_some_and(|e| !e.is_trashed() && e.has_below(&templates_map))
            })
            .cloned()
            .collect();
        let owned_catalog;
        let catalog = match existing_catalog {
            Some(c) => c,
            None => {
                owned_catalog = Catalog::from_v3_parts(
                    view.book_id(),
                    &templates_map,
                    &entries_map,
                    &ordered_levels,
                );
                &owned_catalog
            }
        };
        let live_templates: BTreeMap<EntryTemplateId, EntryTemplate> = templates_map
            .iter()
            .filter(|(_, t)| !t.is_trashed())
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();

        let mut diagnostics = Vec::new();
        for diag in catalog.action_diagnostics() {
            diagnostics.push(action_diagnostic_to_structure(diag));
        }

        let structure_snap = view.structure_snapshot();
        let proj = structure_snap.project().clone();

        let live_entries: Vec<&Entry> = ordered_ids
            .iter()
            .filter_map(|id| entries_map.get(id))
            .filter(|e| !e.is_trashed())
            .collect();

        let template_key = |entry: &Entry| -> String {
            entry
                .effective_template(&templates_map)
                .map(|t| t.id.to_string())
                .unwrap_or_else(|| "<untemplated>".to_string())
        };

        let entry_count = live_entries.len();
        let mut entries_by_template: BTreeMap<String, usize> = BTreeMap::new();
        for e in &live_entries {
            *entries_by_template.entry(template_key(e)).or_insert(0) += 1;
        }

        // 1. Roots: top-level live entries in manuscript order (bounded at MAX_LISTED_ROOTS).
        let all_roots: Vec<RootSummary> = live_entries
            .iter()
            .filter(|e| effective_parent_id(e, &entries_map).is_none())
            .map(|e| {
                let effective = e.effective_template(&templates_map);
                let missing_template = e
                    .template
                    .as_ref()
                    .filter(|_| effective.is_none())
                    .map(ToString::to_string);
                RootSummary {
                    id: e.id.to_string(),
                    title: e.title.clone(),
                    template: effective.map(|t| t.id.to_string()),
                    missing_template,
                    level: e.level,
                }
            })
            .collect();

        // 2. Collect relevant live templates and record missing-template diagnostics.
        let mut included_templates = BTreeSet::new();

        for e in &live_entries {
            if let Some(tid) = &e.template {
                if live_templates.contains_key(tid) {
                    included_templates.insert(tid.clone());
                } else {
                    diagnostics.push(StructureDiagnostic {
                        kind: "missing_template".into(),
                        entry: Some(e.id.to_string()),
                        template: Some(tid.to_string()),
                        module: None,
                        verb: None,
                        reason: "live entry references a missing or trashed template".into(),
                    });
                }
            }
            if e.has_below(&templates_map) {
                let eff = resolve_level_settings(Some(&e.id), &entries_map, &templates_map);
                if let Some(def_tid) = eff.default_template
                    && live_templates.contains_key(&def_tid)
                {
                    included_templates.insert(def_tid);
                }
            }
        }

        for binding in catalog.actions() {
            if let Ok(target_tid) = EntryTemplateId::parse(&binding.target_template)
                && live_templates.contains_key(&target_tid)
            {
                included_templates.insert(target_tid);
            }
        }

        // 3. Optional explicit focus.
        let focus_ctx = if let Some(req) = focus {
            Some(build_focus(
                lib,
                view,
                &entries_map,
                &templates_map,
                &live_templates,
                &mut included_templates,
                &mut diagnostics,
                req,
            )?)
        } else {
            None
        };

        // 4. Build sorted, deduplicated TemplateSummary list.
        let templates: Vec<TemplateSummary> = included_templates
            .iter()
            .filter_map(|tid| live_templates.get(tid))
            .map(|template| summarize_template(template, catalog))
            .collect();

        // 5. Build LevelSummary list + bounded summaries for large books.
        let raw_views = view.timeline_views_raw();
        let active_lanes = dr_model::v3::active_lane_ids(&raw_views, &entries_map, &templates_map);

        let mut priority_entries: BTreeSet<EntryId> = BTreeSet::new();
        let mut mark_priority = |id: &EntryId| {
            priority_entries.insert(id.clone());
            for anc in effective_ancestors(&entries_map, id) {
                priority_entries.insert(anc);
            }
        };
        for tab in &proj.tabs {
            if let TabMount::Entry { entry } = &tab.mount {
                mark_priority(entry);
            }
        }
        for lane_id in &active_lanes {
            mark_priority(lane_id);
        }
        if let Some(f) = &focus_ctx {
            if let Some(raw_id) = &f.entry
                && let Ok(eid) = EntryId::parse(raw_id)
            {
                mark_priority(&eid);
            }
            for host_raw in &f.memberships {
                if let Ok(hid) = EntryId::parse(host_raw) {
                    mark_priority(&hid);
                }
            }
        }

        let mut children_counts: BTreeMap<EntryId, BTreeMap<String, usize>> = BTreeMap::new();
        for e in &live_entries {
            if let Some(parent_id) = effective_parent_id(e, &entries_map) {
                *children_counts
                    .entry(parent_id)
                    .or_default()
                    .entry(template_key(e))
                    .or_insert(0) += 1;
            }
        }

        let mut members_counts: BTreeMap<EntryId, BTreeMap<String, usize>> = BTreeMap::new();
        for m in structure_snap.memberships() {
            if let Some(member_entry) = entries_map.get(&m.member).filter(|e| !e.is_trashed()) {
                *members_counts
                    .entry(m.host.clone())
                    .or_default()
                    .entry(template_key(member_entry))
                    .or_insert(0) += 1;
            }
        }

        let all_levels: Vec<LevelSummary> = live_entries
            .iter()
            .filter(|e| e.has_below(&templates_map))
            .map(|e| {
                let path = level_path(&e.id, &entries_map);
                let effective_settings =
                    resolve_settings_with_sources(&e.id, &entries_map, &templates_map);
                let accept = effective_settings.values.accept;
                let actions = catalog
                    .entries()
                    .iter()
                    .filter_map(|entry| {
                        let b = entry.action.as_ref()?;
                        (b.reference.level == e.id.as_str()).then(|| LevelActionSummary {
                            action: b.reference.clone(),
                            name: b.display_name.clone(),
                            description: b.description.clone(),
                            target_template: Some(b.target_template.clone()),
                            home_id: b.home.clone().unwrap_or_default(),
                            adds_membership: b.adds_membership,
                            revision: entry.revision.clone(),
                        })
                    })
                    .collect();
                LevelSummary {
                    id: e.id.to_string(),
                    title: e.title.clone(),
                    path,
                    template: e
                        .effective_template(&templates_map)
                        .map(|t| t.id.to_string()),
                    level: e.level,
                    accept,
                    lane: active_lanes.contains(&e.id),
                    children_by_template: if e.level {
                        children_counts.remove(&e.id).unwrap_or_default()
                    } else {
                        BTreeMap::new()
                    },
                    members_by_template: if accept {
                        members_counts.remove(&e.id).unwrap_or_default()
                    } else {
                        BTreeMap::new()
                    },
                    effective_settings,
                    actions,
                }
            })
            .collect();

        let mut depth_map: BTreeMap<usize, BTreeMap<String, usize>> = BTreeMap::new();
        for lvl in &all_levels {
            let depth = lvl.path.len().saturating_sub(1);
            let tpl_key = lvl
                .template
                .clone()
                .unwrap_or_else(|| "<untemplated>".to_string());
            *depth_map
                .entry(depth)
                .or_default()
                .entry(tpl_key)
                .or_insert(0) += 1;
        }
        let levels_by_depth: Vec<DepthLevelCounts> = depth_map
            .into_iter()
            .map(|(depth, by_template)| {
                let total = by_template.values().copied().sum();
                DepthLevelCounts {
                    depth,
                    total,
                    by_template,
                }
            })
            .collect();

        let (roots, roots_omitted, omitted_roots_by_template) =
            if all_roots.len() <= MAX_LISTED_ROOTS {
                (all_roots, 0, BTreeMap::new())
            } else {
                let mut ranked: Vec<usize> = (0..all_roots.len()).collect();
                ranked.sort_by_key(|&idx| {
                    let is_priority = EntryId::parse(&all_roots[idx].id)
                        .ok()
                        .is_some_and(|id| priority_entries.contains(&id));
                    (!is_priority, idx)
                });
                let kept: BTreeSet<usize> = ranked.into_iter().take(MAX_LISTED_ROOTS).collect();
                let mut kept_roots = Vec::with_capacity(MAX_LISTED_ROOTS);
                let mut omitted_by_tpl = BTreeMap::new();
                let mut omitted = 0usize;
                for (idx, root) in all_roots.into_iter().enumerate() {
                    if kept.contains(&idx) {
                        kept_roots.push(root);
                    } else {
                        omitted += 1;
                        let key = root.template.unwrap_or_else(|| "<untemplated>".to_string());
                        *omitted_by_tpl.entry(key).or_insert(0) += 1;
                    }
                }
                (kept_roots, omitted, omitted_by_tpl)
            };

        let (levels, levels_omitted) = if all_levels.len() <= MAX_LISTED_LEVELS {
            (all_levels, 0)
        } else {
            let mut ranked: Vec<usize> = (0..all_levels.len()).collect();
            ranked.sort_by_key(|&idx| {
                let lvl = &all_levels[idx];
                let is_priority = EntryId::parse(&lvl.id)
                    .ok()
                    .is_some_and(|id| priority_entries.contains(&id));
                let depth = lvl.path.len().saturating_sub(1);
                (!is_priority, depth, idx)
            });
            let kept: BTreeSet<usize> = ranked.into_iter().take(MAX_LISTED_LEVELS).collect();
            let total = all_levels.len();
            let kept_levels: Vec<LevelSummary> = all_levels
                .into_iter()
                .enumerate()
                .filter_map(|(idx, lvl)| kept.contains(&idx).then_some(lvl))
                .collect();
            let omitted = total.saturating_sub(kept_levels.len());
            (kept_levels, omitted)
        };

        let project_book = proj.book.as_ref().map(|b| ProjectBookSummary {
            word_target: b.word_target(),
            daily_word_target: b.daily_word_target(),
        });

        let project_tabs: Vec<ProjectTabSummary> = proj
            .tabs
            .iter()
            .map(|tab| ProjectTabSummary {
                id: tab.id.to_string(),
                // A tab is called by what it shows (`kernel-v5.md` §5).
                name: match &tab.mount {
                    TabMount::Root => "全部".to_owned(),
                    TabMount::Book => "成书".to_owned(),
                    TabMount::Entry { entry } => structure_snap
                        .entry(entry)
                        .map(|e| e.title.clone())
                        .unwrap_or_default(),
                    TabMount::View { view } => structure_snap
                        .timeline_views_map()
                        .get(view)
                        .map(|v| v.name.clone())
                        .unwrap_or_default(),
                },
                mount: tab.mount.clone(),
                mount_valid: structure_snap.is_valid_tab_mount(&tab.mount),
            })
            .collect();

        let project_agent = proj.agent.as_ref().map(|a| TemplateAgentSummary {
            name: a.name.clone(),
            description: a.description.clone(),
            instructions: a.instructions.clone(),
        });

        let project_source = ProjectSourceSummary::of(proj.source.as_ref());

        let catalog_revision = catalog.revision();
        let digest_payload = json!({
            "book": view.book_id(),
            "book_version": book_version,
            "catalog_revision": &catalog_revision,
            "project_source": &project_source,
            "project_agent": &project_agent,
            "project_book": &project_book,
            "project_tabs": &project_tabs,
            "entry_count": entry_count,
            "entries_by_template": &entries_by_template,
            "roots": &roots,
            "roots_omitted": roots_omitted,
            "omitted_roots_by_template": &omitted_roots_by_template,
            "templates": &templates,
            "levels": &levels,
            "levels_omitted": levels_omitted,
            "levels_by_depth": &levels_by_depth,
        });
        let digest_bytes =
            serde_json::to_vec(&digest_payload).map_err(|e| Error::Invalid(e.to_string()))?;
        let digest_hex = format!("{:x}", Sha256::digest(&digest_bytes));
        let structure_revision = format!("{STRUCTURE_REVISION_PREFIX}-{}", &digest_hex[..16]);

        Ok(Self {
            book: view.book_id().to_string(),
            schema_version: BOOK_SCHEMA_VERSION,
            structure_revision,
            catalog_revision,
            relations: "Use relation_type.list to read relations. Each relation has a name, description and direction. A row connects each entry on the left to each entry on the right.".into(),
            project_source,
            project_agent,
            project_book,
            project_tabs,
            entry_count,
            entries_by_template,
            roots,
            roots_omitted,
            omitted_roots_by_template,
            templates,
            levels,
            levels_omitted,
            levels_by_depth,
            focus: focus_ctx,
            diagnostics,
        })
    }

    /// Project this `StructureContext` as a bounded context `Contribution` for `dr_agent::context::prepare`.
    pub fn to_contribution(&self) -> Result<dr_agent::context::Contribution> {
        let text = serde_json::to_string(self).map_err(|e| Error::Invalid(e.to_string()))?;
        Ok(dr_agent::context::Contribution {
            source: STRUCTURE_CONTEXT_SOURCE.into(),
            text,
        })
    }
}

fn action_diagnostic_to_structure(diag: &ActionDiagnostic) -> StructureDiagnostic {
    StructureDiagnostic {
        kind: diag.code.clone(),
        entry: diag.level.clone(),
        template: Some(diag.template.clone()),
        module: None,
        verb: Some(diag.verb.clone()),
        reason: diag.message.clone(),
    }
}

fn summarize_template(tpl: &EntryTemplate, catalog: &Catalog) -> TemplateSummary {
    let agent = tpl
        .agent
        .as_ref()
        .map(|a| TemplateAgentSummary {
            name: a.name.clone(),
            description: a.description.clone(),
            instructions: a.instructions.clone(),
        })
        .unwrap_or_default();
    let mut seen_modules = BTreeSet::new();
    let mut modules = Vec::new();
    for m in &tpl.modules {
        if !seen_modules.insert(m.id.clone()) {
            continue;
        }
        modules.push(summarize_module(m, catalog));
    }
    TemplateSummary {
        id: tpl.id.to_string(),
        name: tpl.name.clone(),
        level: tpl.level,
        linkable: tpl.linkable,
        agent,
        modules,
    }
}

fn summarize_module(m: &ModuleSpec, catalog: &Catalog) -> ModuleSummary {
    let writable = m.agent.as_ref().is_none_or(|a| a.writable);
    let read_tier = m.agent.as_ref().and_then(|a| a.read_tier.clone());
    let instructions = m
        .agent
        .as_ref()
        .map(|a| a.instructions.clone())
        .unwrap_or_default();
    let (read_tools, candidate_write_tools): (Vec<&str>, Vec<&str>) = match m.kind {
        ModuleKind::Prose => (
            vec!["module.read_prose", "prose.read"],
            vec![
                "module.replace_prose",
                "module.set_prose",
                "prose.replace",
                "prose.link",
                "prose.unlink",
                "prose.restore",
            ],
        ),
        ModuleKind::Fields => (vec!["module.read", "module.list"], vec!["module.set_field"]),
        ModuleKind::KeyValue => (
            vec!["module.read", "module.list"],
            vec!["module.put_kv", "module.remove_kv"],
        ),
        ModuleKind::Patches => (
            vec!["module.read", "module.list"],
            vec!["module.put_patch", "module.remove_patch"],
        ),
        ModuleKind::PlotGrid => (vec!["module.read", "module.list"], vec!["module.put_grid"]),
        ModuleKind::Media => (
            vec!["module.read", "module.list"],
            vec![
                "module.put_media",
                "module.remove_media",
                "module.set_arrangement",
            ],
        ),
        // What lives below: read through the entry; moved with entry.move / membership.*.
        ModuleKind::Children | ModuleKind::Members => {
            (vec!["module.read", "entry.get"], Vec::new())
        }
        ModuleKind::Other(_) => (vec!["module.read", "module.list"], Vec::new()),
    };
    let write_tools = if writable {
        candidate_write_tools
            .into_iter()
            .filter(|name| catalog.descriptor(name).is_some())
            .map(str::to_owned)
            .collect()
    } else {
        Vec::new()
    };
    let read_tools: Vec<String> = read_tools
        .into_iter()
        .filter(|name| catalog.descriptor(name).is_some())
        .map(str::to_owned)
        .collect();
    ModuleSummary {
        id: m.id.to_string(),
        kind: m.kind.as_str().to_owned(),
        name: m.name.clone(),
        agent: ModuleAgentSummary {
            writable,
            read_tier,
            instructions,
        },
        capabilities: ModuleCapabilities {
            readable: !read_tools.is_empty(),
            writable: writable && !write_tools.is_empty(),
            read_tools,
            write_tools,
        },
    }
}

fn level_path(level_id: &EntryId, entries: &BTreeMap<EntryId, Entry>) -> Vec<ActionPathSegment> {
    let mut chain = effective_ancestors(entries, level_id);
    chain.reverse();
    chain.push(level_id.clone());
    chain
        .into_iter()
        .filter_map(|id| {
            let e = entries.get(&id)?;
            Some(ActionPathSegment {
                entry: e.id.to_string(),
                title: e.title.clone(),
            })
        })
        .collect()
}

fn resolve_settings_with_sources(
    level_id: &EntryId,
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> EffectiveLevelSettingsSummary {
    let resolved = resolve_level_settings_with_sources(Some(level_id), entries, templates);
    EffectiveLevelSettingsSummary {
        values: resolved.settings,
        sources: resolved.sources,
    }
}

#[allow(clippy::too_many_arguments)]
fn build_focus(
    lib: Option<&Library>,
    view: &BookViewV3<'_>,
    entries_map: &BTreeMap<EntryId, Entry>,
    templates_map: &BTreeMap<EntryTemplateId, EntryTemplate>,
    live_templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
    included_templates: &mut BTreeSet<EntryTemplateId>,
    diagnostics: &mut Vec<StructureDiagnostic>,
    req: &FocusRequest,
) -> Result<FocusContext> {
    let mut ctx = FocusContext::default();

    if let Some(raw_entry) = &req.entry {
        let header = resolve_focus_entry(entries_map, raw_entry)?;
        let entry = view.entry_raw(&header.id).unwrap_or(header);
        let effective_tpl = entry.effective_template(templates_map);
        let missing_template = entry
            .template
            .as_ref()
            .filter(|_| effective_tpl.is_none())
            .map(ToString::to_string);
        if let Some(tpl) = effective_tpl {
            included_templates.insert(tpl.id.clone());
        }
        let home = effective_parent_id(&entry, entries_map);
        for anc_id in effective_ancestors(entries_map, &entry.id) {
            if let Some(anc) = entries_map.get(&anc_id)
                && let Some(tpl) = anc.effective_template(templates_map)
            {
                included_templates.insert(tpl.id.clone());
            }
        }
        let memberships: Vec<String> = view
            .memberships_of_member(&entry.id)
            .into_iter()
            .map(|m| {
                if let Some(host) = entries_map.get(&m.host) {
                    if let Some(tpl) = host.effective_template(templates_map) {
                        included_templates.insert(tpl.id.clone());
                    }
                    let eff = resolve_level_settings(Some(&m.host), entries_map, templates_map);
                    if let Some(def_tid) = eff.default_template
                        && live_templates.contains_key(&def_tid)
                    {
                        included_templates.insert(def_tid);
                    }
                }
                m.host.to_string()
            })
            .collect();

        let modules = collect_focus_modules(lib, view, &entry, templates_map, diagnostics)?;

        ctx.entry = Some(entry.id.to_string());
        ctx.title = Some(entry.title);
        ctx.template = effective_tpl.map(|t| t.id.to_string());
        ctx.missing_template = missing_template;
        ctx.home = home.map(|id| id.to_string());
        ctx.memberships = memberships;
        ctx.modules = modules;
    }

    if let Some(raw_view) = &req.timeline_view {
        let tv = resolve_focus_timeline_view(view, raw_view)?;
        ctx.timeline_view = Some(tv.id.to_string());
    }

    Ok(ctx)
}

fn resolve_focus_entry(entries: &BTreeMap<EntryId, Entry>, raw: &str) -> Result<Entry> {
    let trimmed = raw.trim();
    if let Ok(id) = EntryId::parse(trimmed)
        && let Some(e) = entries.get(&id).filter(|e| !e.is_trashed())
    {
        return Ok(e.clone());
    }
    let matches: Vec<&Entry> = entries
        .values()
        .filter(|e| !e.is_trashed() && e.title.trim() == trimmed)
        .collect();
    match matches.as_slice() {
        [single] => Ok((*single).clone()),
        [] => Err(Error::Invalid(format!("focus entry not found: {trimmed}"))),
        _ => Err(Error::Invalid(format!(
            "focus entry title is ambiguous: {trimmed}"
        ))),
    }
}

fn resolve_focus_timeline_view(
    view: &BookViewV3<'_>,
    raw: &str,
) -> Result<dr_model::v3::TimelineView> {
    let trimmed = raw.trim();
    let views: Vec<_> = view
        .timeline_views()
        .into_iter()
        .filter(|v| !v.is_trashed())
        .collect();
    if let Ok(id) = TimelineViewId::parse(trimmed)
        && let Some(tv) = views.iter().find(|v| v.id == id)
    {
        return Ok(tv.clone());
    }
    let matches: Vec<_> = views
        .into_iter()
        .filter(|v| v.name.trim() == trimmed)
        .collect();
    match matches.as_slice() {
        [single] => Ok(single.clone()),
        [] => Err(Error::Invalid(format!(
            "focus timeline view not found: {trimmed}"
        ))),
        _ => Err(Error::Invalid(format!(
            "focus timeline view name is ambiguous: {trimmed}"
        ))),
    }
}

fn collect_focus_modules(
    lib: Option<&Library>,
    view: &BookViewV3<'_>,
    entry: &Entry,
    templates_map: &BTreeMap<EntryTemplateId, EntryTemplate>,
    diagnostics: &mut Vec<StructureDiagnostic>,
) -> Result<Vec<FocusModuleSummary>> {
    let active: Vec<ModuleSpec> = entry
        .effective_template(templates_map)
        .map(|t| t.modules.clone())
        .unwrap_or_default();

    let mut ordered_ids: Vec<ModuleId> = Vec::new();
    let mut seen: BTreeSet<ModuleId> = BTreeSet::new();
    let mut push_id = |id: ModuleId| {
        if seen.insert(id.clone()) {
            ordered_ids.push(id);
        }
    };

    for m in &active {
        push_id(m.id.clone());
    }
    for id in entry.fields.keys() {
        push_id(id.clone());
    }
    for id in entry.kv.keys() {
        push_id(id.clone());
    }
    for id in entry.media.keys() {
        push_id(id.clone());
    }
    for id in entry.arrangements.keys() {
        push_id(id.clone());
    }
    for p in view.patches() {
        if p.entry == entry.id {
            push_id(p.module);
        }
    }
    for g in view.plot_grids() {
        if g.entry == entry.id {
            push_id(g.module);
        }
    }

    let mut registered_prose: BTreeMap<ModuleId, String> = BTreeMap::new();
    if let Some(lib) = lib {
        for info in lib.docs(Some(view.book_id().as_str()), None)? {
            if let Ok(DocId::Body(body)) = DocId::parse(&info.doc_id)
                && body.entry() == &entry.id
            {
                push_id(body.module().clone());
                registered_prose.insert(body.module().clone(), info.doc_id);
            }
        }
    }

    let mut out = Vec::new();
    for id in ordered_ids {
        let def = active.iter().find(|m| m.id == id);
        let retained = def.is_none();
        if retained {
            diagnostics.push(StructureDiagnostic {
                kind: "retained_module".into(),
                entry: Some(entry.id.to_string()),
                template: entry.template.as_ref().map(ToString::to_string),
                module: Some(id.to_string()),
                verb: None,
                reason: "module content is retained from an earlier or missing template and remains readable".into(),
            });
        }
        let is_prose =
            def.is_some_and(|m| m.kind == ModuleKind::Prose) || registered_prose.contains_key(&id);
        let prose_doc = if is_prose {
            Some(registered_prose.remove(&id).unwrap_or_else(|| {
                DocId::Body(BodyDocId::new(entry.id.clone(), id.clone())).to_string()
            }))
        } else {
            None
        };
        let document_revision = match (lib, prose_doc.as_deref()) {
            (Some(lib), Some(doc_id)) => {
                if lib.doc_info(doc_id)?.is_some() {
                    let copy = lib.load_copy(doc_id)?;
                    Some(
                        copy.oplog_frontiers()
                            .encode()
                            .iter()
                            .map(|b| format!("{b:02x}"))
                            .collect(),
                    )
                } else {
                    None
                }
            }
            _ => None,
        };
        out.push(FocusModuleSummary {
            id: id.to_string(),
            kind: def.map(|m| m.kind.as_str().to_owned()),
            name: def.map(|m| m.name.clone()),
            retained,
            read_tier: def
                .and_then(|m| m.agent.as_ref())
                .and_then(|a| a.read_tier.clone()),
            prose_doc,
            document_revision,
        });
    }
    Ok(out)
}
