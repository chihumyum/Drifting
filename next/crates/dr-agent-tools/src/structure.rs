//! Per-request book structure description (`StructureContext`) for universal
//! kernel v3 books (`docs/rust-rewrite/modules/k6-agent-tools.md`).
//!
//! Assembled from the same coherent `BorrowedBookV3` snapshot as the v3 tool
//! catalog. Never falls back to `builtin:novel` or any application template
//! constants after book creation.

use std::collections::{BTreeMap, BTreeSet};

use dr_doc::v3::{BookViewV3, BorrowedBookV3, is_v3_doc};
use dr_model::{
    DocId,
    id::{BodyDocId, BookId, EntryId, EntryTemplateId, ModuleId, TimelineViewId},
    v3::{
        Entry, EntryTemplate, LevelSettingSource, LevelSettings, ModuleKind, ModuleSpec,
        ProjectTemplateRef, TemplateKind, effective_ancestors, level_about_module_id,
        resolve_level_settings_with_sources,
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

pub const STRUCTURE_REVISION_PREFIX: &str = "k6-structure-v3";
pub const STRUCTURE_CONTEXT_SOURCE: &str = "BOOK_STRUCTURE.json (this book's templates, levels, actions, and author-configured guidance; project guidance, not a substitute for reading source prose or write authorization)";

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
    pub kind: String,
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
    pub kind: String,
    pub name: String,
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
    pub lane: bool,
    pub effective_settings: EffectiveLevelSettingsSummary,
    pub actions: Vec<LevelActionSummary>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_template_source: Option<ProjectTemplateRef>,
    pub roots: Vec<RootSummary>,
    pub templates: Vec<TemplateSummary>,
    pub levels: Vec<LevelSummary>,
    pub manuscript_roots: Vec<String>,
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
        let book_doc = format!("book:{book}");
        for _ in 0..3 {
            let before = ws.version(&book_doc)?;
            let copy = ws.library().load_copy(&book_doc)?;
            if !is_v3_doc(&copy) {
                return Ok(None);
            }
            let borrowed =
                BorrowedBookV3::new(&copy, book).map_err(|e| Error::Workspace(e.into()))?;
            let view = borrowed.view();
            if view.trashed_at().is_some() {
                return Err(Error::Invalid("book is unavailable".into()));
            }
            let built = Self::from_v3_view(Some(ws.library()), &view, &before, focus)?;
            if before == ws.version(&book_doc)? {
                return Ok(Some(built));
            }
        }
        Err(Error::Conflict(
            "book structure changed while assembling context; read again".into(),
        ))
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
        let catalog = Catalog::from_v3_view(view.book_id(), view);
        let meta = view.meta();
        let ordered_entries = view.entries();
        let entries_map: BTreeMap<EntryId, Entry> = ordered_entries
            .iter()
            .map(|e| (e.id.clone(), e.clone()))
            .collect();
        let templates_map = view.templates_map();
        let live_templates: BTreeMap<EntryTemplateId, EntryTemplate> = templates_map
            .iter()
            .filter(|(_, t)| !t.is_trashed())
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();

        let mut diagnostics = Vec::new();
        for diag in catalog.action_diagnostics() {
            diagnostics.push(action_diagnostic_to_structure(diag));
        }

        // 1. Roots: top-level live entries in manuscript order.
        let roots: Vec<RootSummary> = view
            .children_of(None)
            .into_iter()
            .map(|e| {
                let effective = e.effective_template(&templates_map);
                let missing_template = e
                    .template
                    .as_ref()
                    .filter(|_| effective.is_none())
                    .map(ToString::to_string);
                let kind = match effective {
                    Some(t) => t.kind.as_str().to_owned(),
                    None => "untemplated".to_owned(),
                };
                RootSummary {
                    id: e.id.to_string(),
                    title: e.title,
                    template: effective.map(|t| t.id.to_string()),
                    missing_template,
                    kind,
                }
            })
            .collect();

        // 2. Collect relevant live templates and record missing-template diagnostics.
        let mut included_templates = BTreeSet::new();
        let live_entries: Vec<&Entry> =
            ordered_entries.iter().filter(|e| !e.is_trashed()).collect();

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
            if e.is_level(&templates_map) {
                let eff = view.level_settings(Some(&e.id));
                if let Some(def_tid) = eff.default_template
                    && live_templates.contains_key(&def_tid)
                {
                    included_templates.insert(def_tid);
                }
                for allow_tid in eff.allow {
                    if live_templates.contains_key(&allow_tid) {
                        included_templates.insert(allow_tid);
                    }
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
            .map(|template| summarize_template(template, &catalog))
            .collect();

        // 5. Build LevelSummary list for all live levels in manuscript tree order.
        let levels: Vec<LevelSummary> = live_entries
            .iter()
            .filter(|e| e.is_level(&templates_map))
            .map(|e| {
                let path = level_path(&e.id, &entries_map, &templates_map);
                let effective_settings =
                    resolve_settings_with_sources(&e.id, &entries_map, &templates_map);
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
                            home_id: b.home.clone().unwrap_or_else(|| e.id.to_string()),
                            adds_membership: b.home.as_deref() != Some(e.id.as_str()),
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
                    lane: e.is_lane_level(&templates_map),
                    effective_settings,
                    actions,
                }
            })
            .collect();

        // 6. Manuscript roots in tree order.
        let manuscript_set = view.manuscript_levels();
        let manuscript_roots: Vec<String> = live_entries
            .iter()
            .filter(|e| manuscript_set.contains(&e.id))
            .map(|e| e.id.to_string())
            .collect();

        let catalog_revision = catalog.revision();
        let digest_payload = json!({
            "book": view.book_id(),
            "book_version": book_version,
            "catalog_revision": &catalog_revision,
            "roots": &roots,
            "templates": &templates,
            "levels": &levels,
            "manuscript_roots": &manuscript_roots,
        });
        let digest_bytes =
            serde_json::to_vec(&digest_payload).map_err(|e| Error::Invalid(e.to_string()))?;
        let digest_hex = format!("{:x}", Sha256::digest(&digest_bytes));
        let structure_revision = format!("{STRUCTURE_REVISION_PREFIX}-{}", &digest_hex[..16]);

        Ok(Self {
            book: view.book_id().to_string(),
            schema_version: 3,
            structure_revision,
            catalog_revision,
            project_template_source: meta.project_template,
            roots,
            templates,
            levels,
            manuscript_roots,
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
        if tpl.kind == TemplateKind::Level && !m.kind.allowed_on_level() {
            continue;
        }
        if !seen_modules.insert(m.id.clone()) {
            continue;
        }
        modules.push(summarize_module(m, catalog));
    }
    TemplateSummary {
        id: tpl.id.to_string(),
        kind: tpl.kind.as_str().to_owned(),
        name: tpl.name.clone(),
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
        ModuleKind::Relations => (
            vec!["module.read", "module.list"],
            vec!["module.put_relation", "module.remove_relation"],
        ),
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

fn level_path(
    level_id: &EntryId,
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> Vec<ActionPathSegment> {
    let mut chain = effective_ancestors(entries, templates, level_id);
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
        let entry = resolve_focus_entry(entries_map, raw_entry)?;
        let effective_tpl = entry.effective_template(templates_map);
        let missing_template = entry
            .template
            .as_ref()
            .filter(|_| effective_tpl.is_none())
            .map(ToString::to_string);
        if let Some(tpl) = effective_tpl {
            included_templates.insert(tpl.id.clone());
        }
        let home = view.effective_parent(&entry.id);
        for anc_id in effective_ancestors(entries_map, templates_map, &entry.id) {
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
                    let eff = view.level_settings(Some(&m.host));
                    if let Some(def_tid) = eff.default_template
                        && live_templates.contains_key(&def_tid)
                    {
                        included_templates.insert(def_tid);
                    }
                    for allow_tid in eff.allow {
                        if live_templates.contains_key(&allow_tid) {
                            included_templates.insert(allow_tid);
                        }
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
        .map(|t| {
            t.modules
                .iter()
                .filter(|m| !t.is_level() || m.kind.allowed_on_level())
                .cloned()
                .collect()
        })
        .unwrap_or_default();

    let mut ordered_ids: Vec<ModuleId> = Vec::new();
    let mut seen: BTreeSet<ModuleId> = BTreeSet::new();
    let mut push_id = |id: ModuleId| {
        if seen.insert(id.clone()) {
            ordered_ids.push(id);
        }
    };

    if entry.is_level(templates_map) {
        push_id(level_about_module_id());
    }
    for m in &active {
        push_id(m.id.clone());
    }
    for id in entry.fields.keys() {
        push_id(id.clone());
    }
    for id in entry.kv.keys() {
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
        let is_level_about = entry.is_level(templates_map) && id == level_about_module_id();
        let retained = def.is_none() && !is_level_about;
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
        let is_prose = is_level_about
            || def.is_some_and(|m| m.kind == ModuleKind::Prose)
            || registered_prose.contains_key(&id);
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
            kind: if is_level_about {
                Some(ModuleKind::Prose.as_str().to_owned())
            } else {
                def.map(|m| m.kind.as_str().to_owned())
            },
            name: if is_level_about {
                Some(level_about_module_id().to_string())
            } else {
                def.map(|m| m.name.clone())
            },
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
