//! Library-level saved project templates (`project-template:<id>`):
//! `project_template.{list, get, save, update, remove}` (`project-templates.md` §5, §7, §13),
//! and the working copy a template is edited in: `project_template.edit`,
//! `project_template.working_copies` (§12, `WORKING-COPY-LOCAL`).

use super::*;
use crate::{Actor, Workspace};
use dr_doc::project_template::{
    BorrowedProjectTemplate, ExtractSelection, ExtractTemplateMeta, ProjectTemplateInfo,
    extract_project_template, extract_prose_paragraphs,
};
use dr_doc::v3::{BookViewV3, BorrowedBookV3};
use dr_model::project_template::{
    ProjectTemplateValue, StoredTemplateOrigin, TemplateAgent, to_canonical_json,
    validate_project_template_value,
};
use dr_store::OpenDoc;

pub(crate) fn register(r: &mut Registry) {
    r.add::<ProjectTemplateList>()
        .add::<ProjectTemplateGet>()
        .add::<ProjectTemplateSave>()
        .add::<ProjectTemplateUpdate>()
        .add::<ProjectTemplateRemove>()
        .add::<ProjectTemplateEdit>()
        .add::<ProjectTemplateWorkingCopies>();
}

fn check_description(desc: &str) -> Result<()> {
    if desc
        .chars()
        .any(|c| c != '\n' && c != '\r' && c != '\t' && c.is_control())
    {
        return Err(WsError::invalid(
            "template description must not contain disallowed control characters",
        ));
    }
    Ok(())
}

/// Summary card of a saved project template in `project-template:<id>`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ProjectTemplateSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    /// `"own"` (saved from a project on this library) or `"file"` (imported from `.driftingtemplate`).
    pub origin: String,
    pub revision: i64,
    pub locale: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credit: Option<types::ProjectTemplateCredit>,
    pub has_book: bool,
    pub template_count: usize,
    pub entry_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
}

/// Full saved project template record returned by `project_template.get`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ProjectTemplateDetail {
    pub summary: ProjectTemplateSummary,
    #[schemars(with = "serde_json::Value")]
    pub value: ProjectTemplateValue,
}

fn summary_from_info_and_value(
    id: &ProjectTemplateDocId,
    info: &ProjectTemplateInfo,
    value: &ProjectTemplateValue,
) -> ProjectTemplateSummary {
    ProjectTemplateSummary {
        id: id.to_string(),
        name: value.name.clone(),
        description: value.description.clone(),
        origin: info.origin.as_str().to_owned(),
        revision: value.revision,
        locale: value.locale.clone(),
        credit: value
            .credit
            .as_ref()
            .filter(|c| !c.is_empty())
            .map(Into::into),
        has_book: value.project.book.is_some(),
        template_count: value.templates.len(),
        entry_count: value.entries.len(),
        created_at: info.created_at.map(|t| t.0),
        updated_at: info.updated_at.map(|t| t.0),
    }
}

fn load_saved_template(
    ws: &Workspace,
    pt_id: &ProjectTemplateDocId,
) -> Result<(ProjectTemplateInfo, ProjectTemplateValue)> {
    let doc_str = DocId::ProjectTemplate(pt_id.clone()).to_string();
    let lib = ws.library();
    if lib.doc_info(&doc_str)?.is_none() {
        return Err(WsError::not_found("project_template", pt_id.as_str()));
    }
    let raw = lib.load_copy(&doc_str)?;
    let borrowed = BorrowedProjectTemplate::new(&raw, pt_id)?;
    let view = borrowed.view();
    let info = view
        .info()
        .ok_or_else(|| WsError::invalid("saved project template is missing metadata"))?;
    let val = view.value().map_err(|e| WsError::invalid(e.to_string()))?;
    Ok((info, val))
}

/// Validate and store `value` in `project-template:<id>` (either creating a new
/// library document or replacing `replace` atomically while incrementing `revision`).
/// Shared by `project_template.save` and PT2's `project_template.import`.
pub fn store_project_template_value(
    ws: &Workspace,
    actor: &Actor,
    origin: StoredTemplateOrigin,
    value: &ProjectTemplateValue,
    replace: Option<&ProjectTemplateDocId>,
) -> Result<ProjectTemplateSummary> {
    name_ok(&value.name)?;
    check_description(&value.description)?;
    validate_project_template_value(value).map_err(|e| WsError::invalid(e.to_string()))?;

    let lib = ws.library();
    let ts = now();

    let (pt_id, handle, info) = match replace {
        Some(existing_id) => {
            let doc_str = DocId::ProjectTemplate(existing_id.clone()).to_string();
            if lib.doc_info(&doc_str)?.is_none() {
                return Err(WsError::not_found("project_template", existing_id.as_str()));
            }
            let handle = lib.open_doc(&doc_str, OpenDoc::Existing)?;
            let old_info = handle.doc().with_doc(|d| {
                BorrowedProjectTemplate::new(d, existing_id).map(|b| b.view().info())
            });
            let old_info = match old_info {
                Ok(opt) => opt,
                Err(e) => {
                    handle.close();
                    return Err(e.into());
                }
            };
            let (revision, created_at, kept_origin) = match old_info {
                Some(oi) => (
                    oi.revision.saturating_add(1),
                    oi.created_at.or(Some(ts)),
                    oi.origin,
                ),
                None => (1, Some(ts), origin),
            };
            let info = ProjectTemplateInfo {
                name: value.name.trim().to_owned(),
                description: value.description.clone(),
                origin: kept_origin,
                revision,
                created_at,
                updated_at: Some(ts),
            };
            (existing_id.clone(), handle, info)
        }
        None => {
            let new_id = ProjectTemplateDocId::new_v7();
            let doc_str = DocId::ProjectTemplate(new_id.clone()).to_string();
            let g = dr_doc::project_template::genesis(&new_id);
            let genesis = move |d: &loro::LoroDoc| {
                if let Err(e) = d.import(&g) {
                    log::error!("project-template genesis: {e}");
                }
            };
            let handle = lib.open_doc(
                &doc_str,
                OpenDoc::CreateIfMissing {
                    kind: "project-template",
                    book_id: None,
                    genesis: &genesis,
                },
            )?;
            let info = ProjectTemplateInfo {
                name: value.name.trim().to_owned(),
                description: value.description.clone(),
                origin,
                revision: value.revision.max(1),
                created_at: Some(ts),
                updated_at: Some(ts),
            };
            (new_id, handle, info)
        }
    };

    let mut normalized = value.clone();
    normalized.name = info.name.clone();
    normalized.description = info.description.clone();
    normalized.revision = info.revision;

    let pt_id_for_write = pt_id.clone();
    let info_for_write = info.clone();
    let val_for_write = normalized.clone();
    let agent_meta = actor.agent_write(&format!("project_template.save: {}", info.name));
    let write_res =
        crate::holder::write(&handle, actor.store_origin(), agent_meta, move |raw_doc| {
            let borrowed = BorrowedProjectTemplate::new(raw_doc, &pt_id_for_write)?;
            let mut txn = borrowed.txn();
            txn.save(&info_for_write, &val_for_write)
                .map_err(|e| WsError::invalid(e.to_string()))?;
            Ok(())
        });
    handle.close();
    write_res?;

    Ok(summary_from_info_and_value(&pt_id, &info, &normalized))
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct ProjectTemplateListIn {}

op! {
    ProjectTemplateList = "project_template.list", Read, Shared,
    "List saved project templates in this library.",
    fn(cx, _input: ProjectTemplateListIn) -> Vec<ProjectTemplateSummary> {
        let ws = cx.workspace();
        let mut out = Vec::new();
        for d in ws.library().docs(None, Some("project-template"))? {
            let Some(raw_id) = d.doc_id.strip_prefix("project-template:") else {
                continue;
            };
            let Ok(pt_id) = ProjectTemplateDocId::parse(raw_id) else {
                continue;
            };
            if let Ok((info, val)) = load_saved_template(ws, &pt_id) {
                out.push(summary_from_info_and_value(&pt_id, &info, &val));
            }
        }
        out.sort_by(|a, b| {
            b.updated_at
                .unwrap_or(0)
                .cmp(&a.updated_at.unwrap_or(0))
                .then_with(|| b.id.cmp(&a.id))
        });
        Ok(out)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ProjectTemplateIdIn {
    pub id: String,
}

op! {
    ProjectTemplateGet = "project_template.get", Read, Shared,
    "Read a saved project template and its validated value.",
    fn(cx, input: ProjectTemplateIdIn) -> ProjectTemplateDetail {
        let pt_id: ProjectTemplateDocId = pid("project_template", &input.id)?;
        let (info, value) = load_saved_template(cx.workspace(), &pt_id)?;
        let summary = summary_from_info_and_value(&pt_id, &info, &value);
        Ok(ProjectTemplateDetail { summary, value })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ProjectTemplateSaveIn {
    pub book: String,
    /// The template's name. Needed for a new template; replacing one
    /// (`replace`) without it keeps the name that one has. A working copy
    /// saves under its book's name when it is left out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Left out when replacing: the replaced template keeps its own; a
    /// working copy takes its book's profile.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Optional BCP-47 locale tag (defaults to `"zh-CN"`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
    /// Optional author attribution (`credit`: the author's name). Nothing is
    /// filled in from `project.source`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credit: Option<types::ProjectTemplateCredit>,
    /// The words for the Agent the template carries (`project.agent`):
    /// left out, the project's own; `null`, none; given, these (the
    /// project keeps its own either way).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub agent: Option<Option<types::TemplateAgentConfig>>,
    /// Unlocked skeleton entries (`level` or `accept` on) to exclude from the template.
    #[serde(default)]
    pub exclude_skeleton: Vec<String>,
    /// Live entries whose content (`fields`, `kv`, `arrangements`, `prose`, `memberships`, `placements`) is carried as sample content.
    #[serde(default)]
    pub sample_entries: Vec<String>,
    /// Live timeline views whose time pins are carried.
    #[serde(default)]
    pub view_pins: Vec<String>,
    /// Optional existing `project-template:<id>` to replace (`revision` increments by 1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replace: Option<String>,
}

/// The digest of a template's content: everything but its revision and
/// the app version that wrote it.
pub fn content_digest(value: &ProjectTemplateValue) -> String {
    let mut v = value.clone();
    v.revision = 1;
    v.made_with = String::new();
    match to_canonical_json(&v) {
        Ok(json) => dr_store::digest::sha256_hex(json.as_bytes()),
        Err(_) => String::new(),
    }
}

fn agent_words(given: &Option<types::TemplateAgentConfig>) -> Result<Option<TemplateAgent>> {
    let Some(cfg) = given else {
        return Ok(None);
    };
    let cfg: m::TemplateAgentConfig = convert(cfg)?;
    Ok(
        (!(cfg.name.is_empty() && cfg.description.is_empty() && cfg.instructions.is_empty()))
            .then(|| TemplateAgent::from(&cfg)),
    )
}

/// Extract a template from a fixed snapshot of `book`: `plan` reads the
/// snapshot and says what to take. Never writes `book:<id>` or
/// `project.source`.
fn extract_book(
    ws: &Workspace,
    book: &str,
    plan: impl FnOnce(&BookViewV3<'_>) -> Result<(ExtractTemplateMeta, ExtractSelection)>,
) -> Result<ProjectTemplateValue> {
    let book_id: BookId = pid("book", book)?;
    // Capture a fixed read-only snapshot of `book:<id>` without holding the
    // book's holder thread while reading prose documents, and without ever
    // mutating `book:<id>` or `project.source`.
    let snap_bytes = ws.read_book_v3(book, |raw_doc, _ver| {
        raw_doc
            .export(loro::ExportMode::Snapshot)
            .map_err(|e| WsError::Internal(e.to_string()))
    })?;
    let fixed_book_doc = loro::LoroDoc::new();
    dr_doc::schema::configure(&fixed_book_doc);
    fixed_book_doc
        .import(&snap_bytes)
        .map_err(|e| WsError::Internal(e.to_string()))?;
    let borrowed_book = BorrowedBookV3::new(&fixed_book_doc, &book_id)?;
    let book_view = borrowed_book.view();
    if book_view.meta().deleted_at.is_some() {
        return Err(WsError::not_found("book", book));
    }
    let (meta, selection) = plan(&book_view)?;

    let mut read_err: Option<WsError> = None;
    let extracted = extract_project_template(
        &book_view,
        &meta,
        &selection,
        |doc_id, entry_refs, tpls, live_ents| {
            let refs_c = entry_refs.clone();
            let tpls_c = tpls.clone();
            let ents_c = live_ents.clone();
            match ws.read_prose_readonly(doc_id, move |pview| {
                extract_prose_paragraphs(pview, &refs_c, &tpls_c, &ents_c)
                    .map_err(|e| WsError::invalid(e.to_string()))
            }) {
                Ok(opt) => Ok(opt),
                Err(e) => {
                    let msg = e.to_string();
                    read_err = Some(e);
                    Err(dr_model::project_template::ProjectTemplateError::Invalid(
                        msg,
                    ))
                }
            }
        },
    );
    match extracted {
        Ok(v) => Ok(v),
        Err(e) => Err(read_err.unwrap_or_else(|| WsError::invalid(e.to_string()))),
    }
}

/// Everything a working copy holds, as a template over the one it edits
/// (`project-templates.md` §12): every live entry with its content, every
/// view's time pins; the name and description are the copy's book name and
/// profile (or `name` / `description` when given); the Agent's words its
/// project's; the locale, origin and credit (its author) the template's
/// own.
fn extract_working_copy(
    ws: &Workspace,
    book: &str,
    current: &ProjectTemplateValue,
    name: Option<String>,
    description: Option<String>,
) -> Result<ProjectTemplateValue> {
    let made_with = ws.library().options().app_version.clone();
    let mut value = extract_book(ws, book, |view| {
        let entries = view.entries_map();
        let meta = view.meta();
        let selection = ExtractSelection {
            exclude_skeleton: BTreeSet::new(),
            sample_entries: entries
                .keys()
                .filter(|id| m::is_entry_live(id, &entries))
                .cloned()
                .collect(),
            view_pins: view
                .timeline_views_raw()
                .into_iter()
                .filter(|v| v.deleted_at.is_none())
                .map(|v| v.id)
                .collect(),
        };
        let meta = ExtractTemplateMeta {
            name: name.unwrap_or(meta.name).trim().to_owned(),
            description: description.unwrap_or(meta.summary),
            locale: current.locale.clone(),
            made_with,
            revision: current.revision,
            credit: None,
        };
        Ok((meta, selection))
    })?;
    // Its own credit, as it was.
    value.credit = current.credit.clone();
    Ok(value)
}

/// Save the working copy `book` over the template it edits, when what it
/// holds differs from the template (`WORKING-COPY-LOCAL`). `None` when
/// `book` is no working copy or its template is gone; otherwise the
/// template as it is now.
pub fn save_working_copy(
    ws: &Workspace,
    actor: &Actor,
    book: &str,
    words: Option<(
        Option<String>,
        Option<String>,
        Option<Option<TemplateAgent>>,
    )>,
) -> Result<Option<ProjectTemplateSummary>> {
    let Some(note) = ws.working_copy_note(book)? else {
        return Ok(None);
    };
    let pt_id: ProjectTemplateDocId = pid("project_template", &note.template)?;
    let (info, current) = match load_saved_template(ws, &pt_id) {
        Ok(found) => found,
        Err(WsError::NotFound { .. }) => return Ok(None),
        Err(e) => return Err(e),
    };
    let (name, description, agent) = words.unwrap_or_default();
    let mut value = extract_working_copy(ws, book, &current, name, description)?;
    if let Some(agent) = agent {
        value.project.agent = agent;
    }
    let digest = content_digest(&value);
    let summary = if digest == content_digest(&current) {
        summary_from_info_and_value(&pt_id, &info, &current)
    } else {
        store_project_template_value(ws, actor, info.origin, &value, Some(&pt_id))?
    };
    let synced = crate::working_copy::CopyNote {
        template: note.template.clone(),
        revision: summary.revision,
        digest,
    };
    if synced != note {
        ws.library().set_local_note(book, &synced.to_json())?;
    }
    Ok(Some(summary))
}

op! {
    ProjectTemplateSave = "project_template.save", Write, Library,
    "Save a project's structure and selected sample items as a project template, or a template's working copy over that template.",
    fn(cx, input: ProjectTemplateSaveIn) -> ProjectTemplateSummary {
        let ws = cx.workspace();
        let agent = input.agent.as_ref().map(agent_words).transpose()?;
        if let Some(note) = ws.working_copy_note(&input.book)? {
            // A working copy saves everything it holds over its own template,
            // with that template's history (`project-templates.md` §12).
            if input.replace.as_deref().is_some_and(|r| r != note.template) {
                return Err(WsError::invalid(
                    "a working copy saves over the template it edits",
                ));
            }
            if !input.exclude_skeleton.is_empty()
                || !input.sample_entries.is_empty()
                || !input.view_pins.is_empty()
                || input.credit.is_some()
            {
                return Err(WsError::invalid(
                    "a working copy saves everything it holds, with its template's own credit",
                ));
            }
            if let Some(n) = &input.name {
                name_ok(n)?;
            }
            if let Some(d) = &input.description {
                check_description(d)?;
            }
            let summary = save_working_copy(
                ws,
                cx.actor(),
                &input.book,
                Some((input.name, input.description, agent)),
            )?
            .ok_or_else(|| WsError::not_found("project_template", &note.template))?;
            cx.irreversible();
            cx.effect(EffectAction::Updated, "project_template", &summary.id, Some(&summary.name));
            return Ok(summary);
        }

        let _: BookId = pid("book", &input.book)?;
        let replace_id = input
            .replace
            .as_deref()
            .map(|r| pid("project_template", r))
            .transpose()?;
        // Replacing without a name or a description keeps the replaced
        // template's (`project-templates.md` §7: 覆盖时留着原来的名字和描述).
        let replaced = match &replace_id {
            Some(id) => Some(load_saved_template(ws, id)?.1),
            None => None,
        };
        let name = match (&input.name, &replaced) {
            (Some(n), _) => n.clone(),
            (None, Some(old)) => old.name.clone(),
            (None, None) => return Err(WsError::invalid("a new template needs a name")),
        };
        name_ok(&name)?;
        let description = match (&input.description, &replaced) {
            (Some(d), _) => d.clone(),
            (None, Some(old)) => old.description.clone(),
            (None, None) => String::new(),
        };
        check_description(&description)?;
        let trimmed_name = name.trim().to_owned();

        let mut exclude_skeleton: BTreeSet<EntryId> = BTreeSet::new();
        for raw in &input.exclude_skeleton {
            exclude_skeleton.insert(pid("entry", raw)?);
        }
        let mut sample_entries: BTreeSet<EntryId> = BTreeSet::new();
        for raw in &input.sample_entries {
            sample_entries.insert(pid("entry", raw)?);
        }
        let mut view_pins: BTreeSet<TimelineViewId> = BTreeSet::new();
        for raw in &input.view_pins {
            view_pins.insert(pid("timeline_view", raw)?);
        }

        let locale = input
            .locale
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("zh-CN")
            .to_owned();
        let made_with = ws.library().options().app_version.clone();
        let input_credit = input.credit.clone();
        let mut value = extract_book(ws, &input.book, move |book_view| {
            let entries_map = book_view.entries_map();
            let live_templates: BTreeMap<EntryTemplateId, m::EntryTemplate> = book_view
                .templates()
                .into_iter()
                .filter(|t| !t.is_trashed())
                .map(|t| (t.id.clone(), t))
                .collect();
            for eid in exclude_skeleton.iter().chain(sample_entries.iter()) {
                if !m::is_entry_live(eid, &entries_map) {
                    return Err(WsError::not_found("entry", eid.as_str()));
                }
            }
            for eid in &exclude_skeleton {
                if !entries_map[eid].has_below(&live_templates) {
                    return Err(WsError::invalid(format!(
                        "exclude_skeleton entry {eid} is not a skeleton entry"
                    )));
                }
            }
            let live_views: BTreeSet<TimelineViewId> = book_view
                .timeline_views_raw()
                .into_iter()
                .filter(|v| v.deleted_at.is_none())
                .map(|v| v.id)
                .collect();
            for vid in &view_pins {
                if !live_views.contains(vid) {
                    return Err(WsError::not_found("timeline_view", vid.as_str()));
                }
            }

            let credit: Option<dr_model::project_template::ProjectTemplateCredit> =
                input_credit.as_ref().map(Into::into);
            let credit = credit.filter(|c| !c.is_empty());
            Ok((
                ExtractTemplateMeta {
                    name: trimmed_name,
                    description,
                    locale,
                    made_with,
                    revision: 1,
                    credit,
                },
                ExtractSelection {
                    exclude_skeleton,
                    sample_entries,
                    view_pins,
                },
            ))
        })?;
        // Words for the Agent given here go into the template only.
        if let Some(agent) = agent {
            value.project.agent = agent;
        }

        let action = if replace_id.is_some() {
            EffectAction::Updated
        } else {
            EffectAction::Created
        };
        let summary = store_project_template_value(
            ws,
            cx.actor(),
            StoredTemplateOrigin::Own,
            &value,
            replace_id.as_ref(),
        )?;
        cx.irreversible();
        cx.effect(action, "project_template", &summary.id, Some(&summary.name));
        Ok(summary)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ProjectTemplateUpdateIn {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

op! {
    ProjectTemplateUpdate = "project_template.update", Write, Library,
    "Rename a saved project template or update its description.",
    fn(cx, input: ProjectTemplateUpdateIn) -> ProjectTemplateSummary {
        let pt_id: ProjectTemplateDocId = pid("project_template", &input.id)?;
        let new_name = match &input.name {
            Some(n) => {
                name_ok(n)?;
                Some(n.trim().to_owned())
            }
            None => None,
        };
        if let Some(d) = &input.description {
            check_description(d)?;
        }

        let ws = cx.workspace();
        let (old_info, old_val) = load_saved_template(ws, &pt_id)?;

        let name_changed = new_name.as_ref().is_some_and(|n| n != &old_val.name);
        let desc_changed = input
            .description
            .as_ref()
            .is_some_and(|d| d != &old_val.description);
        if !name_changed && !desc_changed {
            cx.undo_nothing();
            return Ok(summary_from_info_and_value(&pt_id, &old_info, &old_val));
        }

        let doc_str = DocId::ProjectTemplate(pt_id.clone()).to_string();
        let handle = ws.library().open_doc(&doc_str, OpenDoc::Existing)?;
        let ts = now();
        let pt_for_write = pt_id.clone();
        let n_for_write = new_name.clone();
        let d_for_write = input.description.clone();
        let agent_meta = cx
            .actor()
            .agent_write(&format!("project_template.update: {}", pt_id));
        let write_res = crate::holder::write(
            &handle,
            cx.actor().store_origin(),
            agent_meta,
            move |raw_doc| {
                let borrowed = BorrowedProjectTemplate::new(raw_doc, &pt_for_write)?;
                let mut txn = borrowed.txn();
                txn.update_info(n_for_write.as_deref(), d_for_write.as_deref(), ts)?;
                Ok(())
            },
        );
        handle.close();
        write_res?;

        let (updated_info, updated_val) = load_saved_template(ws, &pt_id)?;
        let summary = summary_from_info_and_value(&pt_id, &updated_info, &updated_val);
        cx.undo_with(Invocation::new(
            "project_template.update",
            ProjectTemplateUpdateIn {
                id: pt_id.to_string(),
                name: name_changed.then_some(old_val.name),
                description: desc_changed.then_some(old_val.description),
            },
        ));
        cx.effect(
            EffectAction::Updated,
            "project_template",
            &summary.id,
            Some(&summary.name),
        );
        Ok(summary)
    }
}

op! {
    ProjectTemplateRemove = "project_template.remove", Write, Library,
    "Permanently delete a saved project template from this library.",
    fn(cx, input: ProjectTemplateIdIn) -> Done {
        let pt_id: ProjectTemplateDocId = pid("project_template", &input.id)?;
        let doc_str = DocId::ProjectTemplate(pt_id.clone()).to_string();
        let lib = cx.workspace().library();
        if lib.doc_info(&doc_str)?.is_none() {
            return Err(WsError::not_found("project_template", &input.id));
        }
        let old_name = load_saved_template(cx.workspace(), &pt_id)
            .ok()
            .map(|(_, val)| val.name);
        lib.purge_doc(&doc_str)?;
        cx.irreversible();
        cx.effect(
            EffectAction::Purged,
            "project_template",
            pt_id.as_str(),
            old_name.as_deref(),
        );
        Ok(Done {
            id: pt_id.to_string(),
        })
    }
}

/// A template's working copy (`project_template.edit`,
/// `project_template.working_copies`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct WorkingCopy {
    /// The working copy's book: open it like any project.
    pub book: String,
    /// The saved template it edits.
    pub template: String,
    /// Its name (the template's, as edited there); `None` when its book
    /// document is not there (a copy cut short while it was being made).
    pub name: Option<String>,
    /// When it was made (Unix milliseconds).
    pub created_at: i64,
}

fn working_copy_of(ws: &Workspace, book: &dr_store::LocalBook) -> WorkingCopy {
    let note = crate::working_copy::CopyNote::parse(&book.note);
    let name = BookId::parse(&book.book_id)
        .ok()
        .and_then(|id| ws.book_slot(&id).ok())
        .map(|slot| slot.reader_v3.view().meta().name);
    WorkingCopy {
        book: book.book_id.clone(),
        template: note.template,
        name,
        created_at: book.created_ms,
    }
}

/// What to do with a working copy of `template` left from before
/// (`project_template.edit`): bring it up to date and use it again, or
/// clear it. Never throws away a change the template does not have.
enum Left {
    Use,
    Clear,
    Keep,
}

fn left_behind(
    ws: &Workspace,
    actor: &Actor,
    copy: &dr_store::LocalBook,
    revision: i64,
    current: &ProjectTemplateValue,
) -> Result<Left> {
    let note = crate::working_copy::CopyNote::parse(&copy.note);
    let book_doc = DocId::Book(pid("book", &copy.book_id)?).to_string();
    if ws.library().doc_info(&book_doc)?.is_none() {
        // Cut short while it was being made: it holds nothing of its own.
        return Ok(Left::Clear);
    }
    let held = content_digest(&extract_working_copy(
        ws,
        &copy.book_id,
        current,
        None,
        None,
    )?);
    if held == content_digest(current) || note.revision == revision {
        // In step with the template, or the template has not moved since
        // the copy last saved: its last writes (if the App stopped before
        // they were saved) go over the template now.
        save_working_copy(ws, actor, &copy.book_id, None)?;
        return Ok(Left::Use);
    }
    if held == note.digest {
        // The template moved on elsewhere (another device, another save)
        // and the copy holds nothing it does not: a fresh one is made.
        return Ok(Left::Clear);
    }
    // Both moved: the copy stays (listed by `project_template.working_copies`)
    // and a fresh one is made.
    Ok(Left::Keep)
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ProjectTemplateEditIn {
    /// The saved template to edit.
    pub id: String,
}

op! {
    ProjectTemplateEdit = "project_template.edit", Write, Library,
    "Edit a saved project template in its working copy: a project made from it the way project.create makes one, kept on this device and out of the project lists, recording no writing days; every change made in it saves itself over the template. A working copy left from before is used again when it is in step with the template.",
    fn(cx, input: ProjectTemplateEditIn) -> WorkingCopy {
        let pt_id: ProjectTemplateDocId = pid("project_template", &input.id)?;
        let ws = cx.workspace();
        let (info, value) = load_saved_template(ws, &pt_id)?;
        let template = pt_id.to_string();
        for copy in ws.library().local_books()? {
            if crate::working_copy::CopyNote::parse(&copy.note).template != template {
                continue;
            }
            match left_behind(ws, cx.actor(), &copy, info.revision, &value)? {
                Left::Use => {
                    ws.inner.saver.add(ws.library(), &copy.book_id);
                    cx.irreversible();
                    return Ok(working_copy_of(ws, &copy));
                }
                Left::Clear => {
                    let id: BookId = pid("book", &copy.book_id)?;
                    let gate = ws.book_gate(&id);
                    let _lease = gate.enter();
                    match ws.purge_book(&id) {
                        Ok(_) => ws.inner.saver.remove(&copy.book_id),
                        // Open somewhere: it stays, listed, and a fresh one is made.
                        Err(WsError::Conflict(_)) => {}
                        Err(e) => return Err(e),
                    }
                }
                Left::Keep => {}
            }
        }
        let (info, value) = load_saved_template(ws, &pt_id)?;
        let note = crate::working_copy::CopyNote {
            template: template.clone(),
            revision: info.revision,
            digest: content_digest(&value),
        };
        let book = super::novel_book::create_book(
            cx,
            value.name.trim(),
            value.description.clone(),
            Some(types::ProjectCreateTemplate::Library { template_id: template.clone() }),
            Some(&note.to_json()),
        )?;
        ws.inner.saver.add(ws.library(), book.as_str());
        cx.irreversible();
        cx.effect(EffectAction::Created, "book", book.as_str(), Some(value.name.trim()));
        let made = ws
            .library()
            .local_book(book.as_str())?
            .ok_or_else(|| WsError::Internal("the working copy is missing".into()))?;
        Ok(working_copy_of(ws, &made))
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct ProjectTemplateWorkingCopiesIn {}

op! {
    ProjectTemplateWorkingCopies = "project_template.working_copies", Read, Shared,
    "List the templates' working copies still on this device, oldest first.",
    fn(cx, _input: ProjectTemplateWorkingCopiesIn) -> Vec<WorkingCopy> {
        let ws = cx.workspace();
        Ok(ws
            .library()
            .local_books()?
            .iter()
            .map(|b| working_copy_of(ws, b))
            .collect())
    }
}
