//! Library-level saved project templates (`project-template:<id>`):
//! `project_template.{list, get, save, update, remove}` (`project-templates.md` §5, §7, §13).

use super::*;
use crate::{Actor, Workspace};
use dr_doc::project_template::{
    BorrowedProjectTemplate, ExtractSelection, ExtractTemplateMeta, ProjectTemplateInfo,
    extract_project_template, extract_prose_paragraphs,
};
use dr_doc::v3::BorrowedBookV3;
use dr_model::project_template::{
    ProjectTemplateValue, StoredTemplateOrigin, validate_project_template_value,
};
use dr_store::OpenDoc;

pub(crate) fn register(r: &mut Registry) {
    r.add::<ProjectTemplateList>()
        .add::<ProjectTemplateGet>()
        .add::<ProjectTemplateSave>()
        .add::<ProjectTemplateUpdate>()
        .add::<ProjectTemplateRemove>();
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
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// Optional BCP-47 locale tag (defaults to `"zh-CN"`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
    /// Optional author attribution (`credit`: the author's name). Nothing is
    /// filled in from `project.source`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credit: Option<types::ProjectTemplateCredit>,
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

op! {
    ProjectTemplateSave = "project_template.save", Write, Library,
    "Save a project's structure and selected sample items as a project template.",
    fn(cx, input: ProjectTemplateSaveIn) -> ProjectTemplateSummary {
        name_ok(&input.name)?;
        check_description(&input.description)?;
        let trimmed_name = input.name.trim().to_owned();
        let book_id: BookId = pid("book", &input.book)?;
        let replace_id = input
            .replace
            .as_deref()
            .map(|r| pid("project_template", r))
            .transpose()?;

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

        // Capture a fixed read-only snapshot of `book:<id>` without holding the
        // book's holder thread while reading prose documents, and without ever
        // mutating `book:<id>` or `project.source`.
        let ws = cx.workspace();
        let snap_bytes = ws.read_book_v3(&input.book, |raw_doc, _ver| {
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
            return Err(WsError::not_found("book", &input.book));
        }

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
            input.credit.as_ref().map(Into::into);
        let credit = credit.filter(|c| !c.is_empty());

        let locale = input
            .locale
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("zh-CN")
            .to_owned();
        let made_with = ws.library().options().app_version.clone();

        let meta = ExtractTemplateMeta {
            name: trimmed_name,
            description: input.description,
            locale,
            made_with,
            revision: 1,
            credit,
        };
        let selection = ExtractSelection {
            exclude_skeleton,
            sample_entries,
            view_pins,
        };

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
        let value = match extracted {
            Ok(v) => v,
            Err(e) => {
                if let Some(we) = read_err {
                    return Err(we);
                }
                return Err(WsError::invalid(e.to_string()));
            }
        };

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
