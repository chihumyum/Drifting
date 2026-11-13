//! Kernel v3 identity projection, template action binding, read coverage,
//! and schema projection (`docs/rust-rewrite/modules/k6-agent-tools.md`).

use std::collections::{BTreeMap, BTreeSet};

use dr_doc::v3::{BookViewV3, BorrowedBookV3};
use dr_model::{
    DocId,
    id::{BodyDocId, BookId, EntryId, EntryTemplateId, KvEntryId, ModuleId, TimelineViewId},
    shared::KvEntry,
    v3::{
        Entry, EntryTemplate, FieldType, ModuleKind, ModuleSpec, check_membership,
        check_timeline_placement_in_lane, resolve_new_entry_residence,
    },
};
use dr_workspace::{Workspace, registry};
use serde_json::{Map, Value, json};

use crate::{
    Error, Result,
    catalog::{ActionRef, BookKernelVersion, Catalog, allowed_v3, input_schema_for},
    resolve::ResolvedCall,
};

pub(crate) fn facade_schema_v3(name: &str, mut schema: Value) -> Value {
    if let Some(properties) = schema["properties"].as_object_mut() {
        properties.remove("book");
    }
    if let Some(required) = schema["required"].as_array_mut() {
        required.retain(|key| key != "book");
    }
    if let Some(properties) = schema["properties"].as_object_mut()
        && let Some((domain, verb)) = name.split_once('.')
    {
        for key in [
            "id",
            "entry",
            "parent",
            "template",
            "module",
            "host",
            "member",
            "view",
            "lane",
            "relation_type",
            "owner",
            "folder",
        ] {
            let is_reference =
                key != "id" || !matches!((domain, verb), (_, "create" | "add" | "put"));
            if is_reference && let Some(field) = properties.get_mut(key) {
                let before = field["description"].as_str().unwrap_or("");
                field["description"] = format!(
                    "{before} Existing object id or exact author name; an ambiguous name is refused."
                )
                .trim()
                .to_owned()
                .into();
            }
        }
    }
    fn visit(value: &mut Value) {
        if let Some(properties) = value.get_mut("properties").and_then(Value::as_object_mut) {
            if let Some(doc) = properties.get_mut("doc") {
                *doc = json!({
                    "description": "An authored v3 document id, or an entry/template/material selector.",
                    "anyOf": [
                        doc.clone(),
                        {
                            "type": "object",
                            "properties": {
                                "kind": {"type": "string", "enum": ["entry", "template", "material"]},
                                "entry": {"type": "string"},
                                "template": {"type": "string"},
                                "material": {"type": "string"},
                                "module": {"type": "string"},
                                "parent": {"type": "string"},
                                "name": {"type": "string"},
                                "id": {"type": "string"},
                                "retained": {"type": "boolean"}
                            },
                            "additionalProperties": false
                        }
                    ]
                });
            }
            if properties.contains_key("kind")
                && properties.contains_key("id")
                && properties.len() == 2
            {
                properties.insert(
                    "name".into(),
                    json!({"type":"string","description":"Exact author name; use instead of id."}),
                );
                properties.insert(
                    "parent".into(),
                    json!({"type":"string","description":"Optional parent level for entry disambiguation."}),
                );
                properties.insert(
                    "template".into(),
                    json!({"type":"string","description":"Optional entry template for disambiguation."}),
                );
                value["required"] = json!(["kind"]);
                value["anyOf"] = json!([{"required":["id"]},{"required":["name"]}]);
            }
        }
        if let Some(defs) = value.get_mut("$defs").and_then(Value::as_object_mut) {
            for child in defs.values_mut() {
                visit(child);
            }
        }
    }
    visit(&mut schema);
    schema
}

pub(crate) fn action_input_schema_v3(mut schema: Value) -> Value {
    if let Some(properties) = schema["properties"].as_object_mut() {
        properties.remove("book");
        properties.remove("parent");
        properties.remove("template");
    }
    if let Some(required) = schema["required"].as_array_mut() {
        required.retain(|key| !matches!(key.as_str(), Some("book" | "parent" | "template")));
    }
    schema["additionalProperties"] = Value::Bool(false);
    schema["not"] = json!({
        "anyOf": [
            {"required": ["book"]},
            {"required": ["parent"]},
            {"required": ["home"]},
            {"required": ["template"]},
            {"required": ["target_template"]}
        ]
    });
    schema
}

pub(crate) fn resolve_v3(
    ws: &Workspace,
    book: &BookId,
    name: &str,
    mut args: Value,
) -> Result<ResolvedCall> {
    if name.starts_with("action:") {
        return resolve_action(ws, book, name, args);
    }
    let spec = registry()
        .get(name)
        .filter(|spec| allowed_v3(spec))
        .ok_or_else(|| invalid(format!("tool {name:?} is not in this book's v3 catalog")))?;
    let schema = input_schema_for(spec, BookKernelVersion::V3);
    let properties = &schema["properties"];
    let obj = args
        .as_object_mut()
        .ok_or_else(|| invalid("tool arguments must be an object"))?;
    if let Some(given) = obj.get("book")
        && given.as_str() != Some(book.as_str())
    {
        return Err(invalid("tool belongs to another book"));
    }

    let doc_copy = ws
        .library()
        .load_copy(&format!("book:{book}"))
        .map_err(dr_workspace::WsError::from)?;
    let borrowed = BorrowedBookV3::new(&doc_copy, book)
        .map_err(|e| invalid(format!("invalid v3 book {book}: {e}")))?;
    let view = borrowed.view();
    let entries = view.entries_map();
    let templates = view.templates_map();

    let mut targets = BTreeSet::new();
    let mut extra_subjects = BTreeSet::new();

    if properties.get("book").is_some() {
        obj.insert("book".into(), book.to_string().into());
        targets.insert(format!("book:{book}"));
    }

    let (domain, _verb) = name.split_once('.').expect("registry name");

    if let Some(doc_val) = obj.get_mut("doc") {
        let prose_only = name.starts_with("prose.");
        let is_write = !spec.is_query();
        let resolved_doc = resolve_document_v3(
            ws, book, &view, &entries, &templates, doc_val, prose_only, is_write,
        )?;
        targets.insert(resolved_doc.clone());
        *doc_val = resolved_doc.into();
    }

    if let Some(session) = obj.get("session") {
        let session_id = string(session, "session")?;
        resolve_history_session(ws, book, &view, session_id, obj.get("turn"), &mut targets)?;
    }

    if let Some(links) = obj.get_mut("links") {
        let is_write = !spec.is_query();
        for link in links
            .as_array_mut()
            .ok_or_else(|| invalid("links must be an array"))?
        {
            let doc = link
                .get_mut("doc")
                .ok_or_else(|| invalid("link needs a document"))?;
            let resolved =
                resolve_document_v3(ws, book, &view, &entries, &templates, doc, true, is_write)?;
            targets.insert(resolved.clone());
            *doc = resolved.into();
            let target = link
                .get_mut("target")
                .ok_or_else(|| invalid("link needs a target"))?;
            resolve_entity_ref_v3(&view, &entries, &templates, target)?;
        }
    }

    for key in ["target", "entity", "from", "to", "other"] {
        if let Some(value) = obj.get_mut(key)
            && value.is_object()
        {
            resolve_entity_ref_v3(&view, &entries, &templates, value)?;
        }
    }

    match name {
        "comment.list" | "comment.anchors" | "comment.create" => {
            let anchored = name == "comment.create"
                && ["range", "block_id", "anchor"]
                    .iter()
                    .any(|k| obj.get(*k).is_some_and(|v| !v.is_null()));
            if let Some(target) = obj.get("target").filter(|t| !t.is_null()) {
                let kind = target["kind"].as_str().unwrap_or_default().to_owned();
                let id = target["id"].as_str().unwrap_or_default().to_owned();
                if !matches!(kind.as_str(), "entry" | "material") {
                    return Err(invalid("comment target must be an entry or material"));
                }
                if name == "comment.create"
                    && !anchored
                    && obj.get("module").is_none_or(Value::is_null)
                {
                    extra_subjects.insert(format!("{kind}:{id}"));
                }
                if let Some(module) = obj.get_mut("module").filter(|m| !m.is_null()) {
                    if kind != "entry" {
                        return Err(invalid("materials have no prose module"));
                    }
                    let eid = EntryId::parse(&id).map_err(|e| invalid(e.to_string()))?;
                    let entry = entries
                        .get(&eid)
                        .ok_or_else(|| invalid("entry not found"))?;
                    let mid = resolve_entry_prose_module(
                        ws, book, &view, entry, &templates, module, false, false,
                    )?;
                    *module = mid.to_string().into();
                    if name == "comment.create" && !anchored {
                        extra_subjects.insert(format!("module:{eid}:{mid}"));
                    }
                }
            } else if obj.get("module").is_some_and(|m| !m.is_null()) {
                return Err(invalid("a comment module requires an entry target"));
            }
            if anchored {
                let target = obj
                    .get("target")
                    .ok_or_else(|| invalid("an anchor needs a target"))?;
                let doc = comment_source_doc(target, obj.get("module"))?;
                let doc = resolve_document_v3(
                    ws,
                    book,
                    &view,
                    &entries,
                    &templates,
                    &json!(doc),
                    true,
                    false,
                )?;
                extra_subjects.insert(format!("prose:{doc}"));
                targets.insert(doc);
            }
        }
        "comment.update" | "comment.reanchor" => {
            if let Some(id) = obj.get_mut("id") {
                *id = resolve_comment_id(&view, id)?.into();
            }
            if name == "comment.reanchor" && obj.get("anchor").is_some_and(|a| !a.is_null()) {
                let old = view
                    .comments()
                    .into_iter()
                    .find(|c| Some(c.id.as_str()) == obj["id"].as_str())
                    .ok_or_else(|| invalid("comment not found"))?;
                let target = old
                    .target
                    .ok_or_else(|| invalid("a floating comment has no prose"))?;
                let doc = comment_source_doc(
                    &json!({"kind":target.kind.as_str(),"id":target.id}),
                    old.target_module.as_ref().map(|m| json!(m)).as_ref(),
                )?;
                let doc = resolve_document_v3(
                    ws,
                    book,
                    &view,
                    &entries,
                    &templates,
                    &json!(doc),
                    true,
                    false,
                )?;
                extra_subjects.insert(format!("prose:{doc}"));
                targets.insert(doc);
            }
        }
        "entry.list" => {
            if let Some(parent) = obj.get_mut("parent")
                && !parent.is_null()
            {
                let pid = resolve_entry_id(&view, &entries, &templates, parent, None, false, true)?;
                *parent = pid.to_string().into();
            }
        }
        "entry.get" | "entry.trash" | "entry.restore" | "entry.set_level" | "module.list" => {
            let include_trashed = matches!(name, "entry.get" | "entry.trash" | "entry.restore");
            if let Some(id_val) = obj.get_mut("id") {
                let eid = resolve_entry_id(
                    &view,
                    &entries,
                    &templates,
                    id_val,
                    None,
                    include_trashed,
                    false,
                )?;
                *id_val = eid.to_string().into();
            }
        }
        "entry.create" => {
            let context_id = if let Some(parent) = obj.get_mut("parent")
                && !parent.is_null()
            {
                let pid = resolve_entry_id(&view, &entries, &templates, parent, None, false, true)?;
                *parent = pid.to_string().into();
                Some(pid)
            } else {
                None
            };
            let tpl_id = if let Some(tpl_val) = obj.get_mut("template")
                && !tpl_val.is_null()
            {
                let tid = resolve_template_id(&view, &templates, tpl_val, false)?;
                *tpl_val = tid.to_string().into();
                Some(tid)
            } else {
                view.level_settings(context_id.as_ref()).default_template
            };
            if let Some(bodies_val) = obj.get_mut("bodies")
                && !bodies_val.is_null()
            {
                let tid = tpl_id
                    .as_ref()
                    .ok_or_else(|| invalid("entry creation has no resolved template for bodies"))?;
                let tpl = templates
                    .get(tid)
                    .ok_or_else(|| invalid("entry creation template not found"))?;
                let resolved_bodies = resolve_initial_bodies(tpl, bodies_val)?;
                *bodies_val = Value::Object(resolved_bodies);
            }
            let residence = resolve_new_entry_residence(context_id.as_ref(), &entries, &templates);
            if let Some(home) = residence
                && Some(&home) != context_id.as_ref()
            {
                extra_subjects.insert(format!("entry:{home}"));
            }
        }
        "entry.update" => {
            let parent_hint = obj.get("parent").and_then(Value::as_str).map(str::to_owned);
            if let Some(id_val) = obj.get_mut("id") {
                let eid = resolve_entry_id(
                    &view,
                    &entries,
                    &templates,
                    id_val,
                    parent_hint.as_deref(),
                    false,
                    false,
                )?;
                *id_val = eid.to_string().into();
            }
            if let Some(tpl_val) = obj.get_mut("template")
                && !tpl_val.is_null()
            {
                let tid = resolve_template_id(&view, &templates, tpl_val, false)?;
                *tpl_val = tid.to_string().into();
            }
            if let Some(ov) = obj.get_mut("overrides")
                && let Some(ov_obj) = ov.as_object_mut()
            {
                resolve_settings_override(&view, &entries, &templates, ov_obj)?;
            }
        }
        "entry.move" => {
            if let Some(id_val) = obj.get_mut("id") {
                let eid =
                    resolve_entry_id(&view, &entries, &templates, id_val, None, false, false)?;
                *id_val = eid.to_string().into();
            }
            if let Some(parent_val) = obj.get_mut("parent")
                && !parent_val.is_null()
            {
                let pid =
                    resolve_entry_id(&view, &entries, &templates, parent_val, None, false, true)?;
                *parent_val = pid.to_string().into();
            }
        }
        "entry_template.delete" => {
            if let Some(id_val) = obj.get_mut("id") {
                let tid = resolve_template_id(&view, &templates, id_val, false)?;
                *id_val = tid.to_string().into();
            }
        }
        "entry_template.put" => {
            if let Some(tpl_obj) = obj.get_mut("template").and_then(Value::as_object_mut) {
                if let Some(id_val) = tpl_obj.get_mut("id")
                    && let Some(raw) = id_val.as_str()
                    && EntryTemplateId::parse(raw).is_err()
                    && let Ok(tid) =
                        resolve_template_id(&view, &templates, &Value::String(raw.into()), true)
                {
                    *id_val = tid.to_string().into();
                }
                if let Some(settings) = tpl_obj.get_mut("settings").and_then(Value::as_object_mut) {
                    resolve_settings_override(&view, &entries, &templates, settings)?;
                }
                if let Some(verbs) = tpl_obj.get_mut("verbs").and_then(Value::as_array_mut) {
                    for v in verbs {
                        if let Some(tt) = v.get_mut("target_template")
                            && !tt.is_null()
                            && let Ok(tid) = resolve_template_id(&view, &templates, tt, false)
                        {
                            *tt = tid.to_string().into();
                        }
                    }
                }
            }
        }
        "entry_template.put_module" | "entry_template.remove_module" => {
            let tid = if let Some(tpl_val) = obj.get_mut("template") {
                let tid = resolve_template_id(&view, &templates, tpl_val, false)?;
                *tpl_val = tid.to_string().into();
                Some(tid)
            } else {
                None
            };
            if name == "entry_template.remove_module"
                && let (Some(tid), Some(mod_val)) = (tid, obj.get_mut("module"))
                && let Some(tpl) = templates.get(&tid)
            {
                let mid = resolve_template_module_id(tpl, mod_val, None)?;
                *mod_val = mid.to_string().into();
            }
        }
        "module.read"
        | "module.set_field"
        | "module.put_kv"
        | "module.remove_kv"
        | "module.put_patch"
        | "module.remove_patch"
        | "module.put_grid"
        | "module.put_relation"
        | "module.remove_relation" => {
            let eid = {
                let entry_val = obj
                    .get_mut("entry")
                    .ok_or_else(|| invalid("module operation needs entry"))?;
                let eid =
                    resolve_entry_id(&view, &entries, &templates, entry_val, None, false, false)?;
                *entry_val = eid.to_string().into();
                eid
            };
            let entry = entries
                .get(&eid)
                .ok_or_else(|| invalid("entry not found"))?;
            let is_write = name != "module.read";
            let (mid, mod_spec) = {
                let mod_val = obj
                    .get_mut("module")
                    .ok_or_else(|| invalid("module operation needs module"))?;
                let (mid, spec) = resolve_entry_module(
                    ws, book, &view, entry, &templates, mod_val, !is_write, is_write,
                )?;
                *mod_val = mid.to_string().into();
                (mid, spec)
            };
            match name {
                "module.set_field" => {
                    let spec = mod_spec.ok_or_else(|| invalid("active fields module required"))?;
                    let field_id = {
                        let f_val = obj
                            .get_mut("field")
                            .ok_or_else(|| invalid("module.set_field needs field"))?;
                        let raw = string(f_val, "field")?;
                        let def = resolve_field_def(&spec, raw)?;
                        let fid = def.id.clone();
                        let ftype = def.field_type.clone();
                        let target_tpl = def.target_template.clone();
                        *f_val = fid.clone().into();
                        (fid, ftype, target_tpl)
                    };
                    if field_id.1 == FieldType::EntityRef
                        && let Some(val) = obj.get_mut("value")
                        && val.is_string()
                    {
                        let target_entry = resolve_entry_id_filtered(
                            &view,
                            &entries,
                            &templates,
                            val,
                            field_id.2.as_ref(),
                        )?;
                        *val = target_entry.to_string().into();
                    }
                    if field_id.1 == FieldType::Image
                        && let Some(val) = obj.get("value")
                        && let Some(asset_id) = val.as_str()
                        && !view.assets().iter().any(|a| a.id.as_str() == asset_id)
                    {
                        return Err(invalid(format!(
                            "asset {asset_id:?} not found in this book"
                        )));
                    }
                }
                "module.put_kv" => {
                    let existing_rows = entry.kv.get(&mid).cloned().unwrap_or_default();
                    let row_obj = obj
                        .get_mut("row")
                        .and_then(Value::as_object_mut)
                        .ok_or_else(|| invalid("module.put_kv needs a row object"))?;
                    resolve_kv_put_row(row_obj, &existing_rows)?;
                }
                "module.remove_kv" => {
                    let existing_rows = entry.kv.get(&mid).cloned().unwrap_or_default();
                    let row_val = obj
                        .get_mut("row")
                        .ok_or_else(|| invalid("module.remove_kv needs row"))?;
                    let raw = string(row_val, "row")?;
                    let resolved = resolve_kv_row_id(&existing_rows, raw)?;
                    *row_val = resolved.to_string().into();
                }
                "module.put_patch" | "module.remove_patch" => {
                    let patches = view.patches_of(&eid, &mid);
                    if let Some(id_val) = obj.get_mut("id")
                        && !id_val.is_null()
                    {
                        let raw = string(id_val, "id")?;
                        if name == "module.remove_patch"
                            || !looks_like_uuid(raw)
                            || patches.iter().any(|p| p.id.as_str() == raw)
                        {
                            let pid = resolve_patch_id(&patches, raw)?;
                            *id_val = pid.into();
                        }
                    }
                }
                "module.put_relation" => {
                    if let Some(rt_val) = obj.get_mut("relation_type") {
                        let rtid = resolve_relation_type_id(&view, rt_val)?;
                        *rt_val = rtid.into();
                    }
                }
                "module.remove_relation" => {
                    if let Some(id_val) = obj.get_mut("id") {
                        let raw = string(id_val, "id")?;
                        let rels = view.relations_of(&dr_model::shared::EntityRef {
                            kind: dr_model::kind::EntityKind::Entry,
                            id: eid.to_string(),
                        });
                        if !rels.iter().any(|r| r.id.as_str() == raw) {
                            return Err(invalid(format!(
                                "relation {raw:?} not found on entry {eid}"
                            )));
                        }
                    }
                }
                _ => {}
            }
        }
        "module.read_prose" | "module.set_prose" | "module.replace_prose" => {
            let is_template = obj
                .get("template")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let is_write = name != "module.read_prose";
            let prose_doc = if is_template {
                let tid = {
                    let owner_val = obj
                        .get_mut("owner")
                        .ok_or_else(|| invalid("prose module operation needs owner"))?;
                    let tid = resolve_template_id(&view, &templates, owner_val, false)?;
                    *owner_val = tid.to_string().into();
                    tid
                };
                let tpl = templates
                    .get(&tid)
                    .ok_or_else(|| invalid("template not found"))?;
                let mid = {
                    let mod_val = obj
                        .get_mut("module")
                        .ok_or_else(|| invalid("prose module operation needs module"))?;
                    let mid =
                        resolve_template_prose_module(ws, book, tpl, mod_val, !is_write, is_write)?;
                    *mod_val = mid.to_string().into();
                    mid
                };
                DocId::parse(&format!("template:{book}/{tid}/{mid}"))
                    .map_err(|e| invalid(e.to_string()))?
                    .to_string()
            } else {
                let eid = {
                    let owner_val = obj
                        .get_mut("owner")
                        .ok_or_else(|| invalid("prose module operation needs owner"))?;
                    let eid = resolve_entry_id(
                        &view, &entries, &templates, owner_val, None, false, false,
                    )?;
                    *owner_val = eid.to_string().into();
                    eid
                };
                let entry = entries
                    .get(&eid)
                    .ok_or_else(|| invalid("entry not found"))?;
                let mid = {
                    let mod_val = obj
                        .get_mut("module")
                        .ok_or_else(|| invalid("prose module operation needs module"))?;
                    let mid = resolve_entry_prose_module(
                        ws, book, &view, entry, &templates, mod_val, !is_write, is_write,
                    )?;
                    *mod_val = mid.to_string().into();
                    mid
                };
                DocId::Body(BodyDocId::new(eid, mid)).to_string()
            };
            let stored = ws
                .library()
                .doc_info(&prose_doc)
                .map_err(dr_agent::Error::from)?
                .is_some();
            if stored || name == "module.replace_prose" {
                targets.insert(prose_doc.clone());
                if is_write {
                    extra_subjects.insert(format!("prose:{prose_doc}"));
                }
            } else if is_write {
                let owner = obj["owner"].as_str().unwrap_or_default();
                if is_template {
                    extra_subjects.insert(format!("entry_template:{owner}"));
                } else {
                    extra_subjects.insert(format!("entry:{owner}"));
                }
            }
        }
        "entry_relation_type.put" => {
            if let Some(def) = obj.get_mut("definition").and_then(Value::as_object_mut) {
                if let Some(id_val) = def.get_mut("id")
                    && let Some(raw) = id_val.as_str()
                    && !looks_like_uuid(raw)
                    && let Ok(rtid) = resolve_relation_type_id(&view, &Value::String(raw.into()))
                {
                    *id_val = rtid.into();
                }
                for key in ["source_templates", "target_templates"] {
                    if let Some(arr) = def.get_mut(key).and_then(Value::as_array_mut) {
                        for item in arr {
                            let tid = resolve_template_id(&view, &templates, item, false)?;
                            *item = tid.to_string().into();
                        }
                    }
                }
            }
        }
        "entry_relation_type.delete" => {
            if let Some(id_val) = obj.get_mut("id") {
                let rtid = resolve_relation_type_id(&view, id_val)?;
                *id_val = rtid.into();
            }
        }
        "membership.add" | "membership.remove" => {
            let host = {
                let h_val = obj
                    .get_mut("host")
                    .ok_or_else(|| invalid("membership needs host"))?;
                let hid = resolve_entry_id(&view, &entries, &templates, h_val, None, false, true)?;
                *h_val = hid.to_string().into();
                hid
            };
            let member = {
                let m_val = obj
                    .get_mut("member")
                    .ok_or_else(|| invalid("membership needs member"))?;
                let mid = resolve_entry_id(&view, &entries, &templates, m_val, None, false, false)?;
                *m_val = mid.to_string().into();
                mid
            };
            if name == "membership.remove" {
                for tv in
                    affected_views_on_membership_remove(&view, &host, &member, &entries, &templates)
                {
                    extra_subjects.insert(format!("timeline_view:{tv}"));
                }
            }
        }
        "membership.primary" => {
            if let Some(m_val) = obj.get_mut("member") {
                let mid = resolve_entry_id(&view, &entries, &templates, m_val, None, false, false)?;
                *m_val = mid.to_string().into();
            }
            if let Some(h_val) = obj.get_mut("host")
                && !h_val.is_null()
            {
                let hid = resolve_entry_id(&view, &entries, &templates, h_val, None, false, true)?;
                *h_val = hid.to_string().into();
            }
        }
        "timeline_view.delete" => {
            if let Some(id_val) = obj.get_mut("id") {
                let vid = resolve_timeline_view_id(&view, id_val)?;
                *id_val = vid.to_string().into();
            }
        }
        "timeline_view.put" => {
            if let Some(v_obj) = obj.get_mut("view").and_then(Value::as_object_mut) {
                if let Some(id_val) = v_obj.get_mut("id")
                    && let Some(raw) = id_val.as_str()
                    && !looks_like_uuid(raw)
                    && let Ok(vid) = resolve_timeline_view_id(&view, &Value::String(raw.into()))
                {
                    *id_val = vid.to_string().into();
                }
                if let Some(lanes) = v_obj.get_mut("lanes").and_then(Value::as_array_mut) {
                    for lane in lanes {
                        if let Some(e_val) = lane.get_mut("entry") {
                            let eid = resolve_entry_id(
                                &view, &entries, &templates, e_val, None, false, true,
                            )?;
                            *e_val = eid.to_string().into();
                        }
                    }
                }
                if let Some(placements) = v_obj.get_mut("placements").and_then(Value::as_array_mut)
                {
                    for p in placements {
                        if let Some(e_val) = p.get_mut("entry") {
                            let eid = resolve_entry_id(
                                &view, &entries, &templates, e_val, None, false, false,
                            )?;
                            *e_val = eid.to_string().into();
                        }
                    }
                }
                if let Some(pins) = v_obj.get_mut("pins").and_then(Value::as_array_mut) {
                    for pin in pins {
                        if let Some(e_val) = pin.get_mut("entry")
                            && !e_val.is_null()
                        {
                            let eid = resolve_entry_id(
                                &view, &entries, &templates, e_val, None, false, false,
                            )?;
                            *e_val = eid.to_string().into();
                        }
                    }
                }
            }
        }
        "timeline_view.place" | "timeline_view.remove" => {
            if let Some(v_val) = obj.get_mut("view") {
                let vid = resolve_timeline_view_id(&view, v_val)?;
                *v_val = vid.to_string().into();
            }
            if let Some(e_val) = obj.get_mut("entry") {
                let eid = resolve_entry_id(&view, &entries, &templates, e_val, None, false, false)?;
                *e_val = eid.to_string().into();
            }
            if let Some(l_val) = obj.get_mut("lane")
                && !l_val.is_null()
            {
                let lid = resolve_entry_id(&view, &entries, &templates, l_val, None, false, true)?;
                *l_val = lid.to_string().into();
            }
            if name == "timeline_view.remove"
                && let (Some(lane_s), Some(entry_s)) = (obj["lane"].as_str(), obj["entry"].as_str())
                && let (Ok(host), Ok(member)) = (EntryId::parse(lane_s), EntryId::parse(entry_s))
            {
                for tv in
                    affected_views_on_membership_remove(&view, &host, &member, &entries, &templates)
                {
                    extra_subjects.insert(format!("timeline_view:{tv}"));
                }
            }
        }
        "timeline_view.put_pin" => {
            if let Some(v_val) = obj.get_mut("view") {
                let vid = resolve_timeline_view_id(&view, v_val)?;
                *v_val = vid.to_string().into();
            }
            if let Some(pin_obj) = obj.get_mut("pin").and_then(Value::as_object_mut)
                && let Some(e_val) = pin_obj.get_mut("entry")
                && !e_val.is_null()
            {
                let eid = resolve_entry_id(&view, &entries, &templates, e_val, None, false, false)?;
                *e_val = eid.to_string().into();
            }
        }
        "timeline_view.remove_pin" => {
            let vid = {
                let v_val = obj
                    .get_mut("view")
                    .ok_or_else(|| invalid("timeline_view.remove_pin needs view"))?;
                let vid = resolve_timeline_view_id(&view, v_val)?;
                *v_val = vid.to_string().into();
                vid
            };
            if let Some(pin_val) = obj.get_mut("pin") {
                let pid = resolve_timeline_pin_id(&view, &vid, pin_val)?;
                *pin_val = pid.into();
            }
        }
        "entry_history.restore" => {
            if let Some(targets_arr) = obj.get_mut("targets").and_then(Value::as_array_mut) {
                for item in targets_arr {
                    let collection = item
                        .get("collection")
                        .and_then(Value::as_str)
                        .ok_or_else(|| invalid("restore target needs collection"))?
                        .to_owned();
                    let id_val = item
                        .get_mut("id")
                        .ok_or_else(|| invalid("restore target needs id"))?;
                    let raw = string(id_val, "id")?;
                    if !looks_like_uuid(raw) {
                        match collection.as_str() {
                            "entries" => {
                                if let Ok(eid) = resolve_entry_id(
                                    &view, &entries, &templates, id_val, None, true, false,
                                ) {
                                    *id_val = eid.to_string().into();
                                }
                            }
                            "templates" => {
                                if let Ok(tid) =
                                    resolve_template_id(&view, &templates, id_val, true)
                                {
                                    *id_val = tid.to_string().into();
                                }
                            }
                            "timeline_views" => {
                                if let Ok(vid) = resolve_timeline_view_id(&view, id_val) {
                                    *id_val = vid.to_string().into();
                                }
                            }
                            "relation_types" => {
                                if let Ok(rtid) = resolve_relation_type_id(&view, id_val) {
                                    *id_val = rtid.into();
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
        _ => {
            if domain == "material" || domain == "material_folder" {
                resolve_material_args(&view, name, obj)?;
            } else if domain == "relation"
                && let Some(rt_val) = obj.get_mut("relation_type")
                && !rt_val.is_null()
            {
                let rtid = resolve_relation_type_id(&view, rt_val)?;
                *rt_val = rtid.into();
            }
        }
    }

    let mut subj = subjects_v3(name, &args);
    for extra in extra_subjects {
        if !subj.contains(&extra) {
            subj.push(extra);
        }
    }
    Ok(ResolvedCall {
        name: name.to_owned(),
        arguments: args,
        targets: targets.into_iter().collect(),
        subjects: subj,
    })
}

fn comment_source_doc(target: &Value, module: Option<&Value>) -> Result<String> {
    let id = target["id"]
        .as_str()
        .ok_or_else(|| invalid("a prose target is required"))?;
    match target["kind"].as_str() {
        Some("entry") => {
            let module = module
                .and_then(Value::as_str)
                .ok_or_else(|| invalid("an entry anchor requires an explicit prose module"))?;
            Ok(format!("body:{id}/{module}"))
        }
        Some("material") if module.is_none_or(Value::is_null) => Ok(format!("material:{id}")),
        _ => Err(invalid("an anchor requires entry or text material prose")),
    }
}

fn resolve_action(ws: &Workspace, book: &BookId, name: &str, args: Value) -> Result<ResolvedCall> {
    let reference = ActionRef::parse_canonical(name)
        .ok_or_else(|| invalid("invalid template action reference"))?;
    if reference.book != book.as_str() {
        return Err(invalid("template action belongs to another book"));
    }
    let catalog = Catalog::for_book(ws, book)?;
    let binding = catalog
        .action_binding(name)
        .ok_or_else(|| {
            invalid(format!(
                "template action {name:?} is not available in this book"
            ))
        })?
        .clone();

    let obj = args
        .as_object()
        .ok_or_else(|| invalid("template action arguments must be an object"))?;
    for forbidden in [
        "book",
        "parent",
        "home",
        "template",
        "target_template",
        "level",
        "host",
    ] {
        if obj.contains_key(forbidden) {
            return Err(invalid(format!(
                "template action fixed parameter {forbidden:?} cannot be supplied or overridden"
            )));
        }
    }
    for key in obj.keys() {
        if !matches!(key.as_str(), "title" | "bodies") {
            return Err(invalid(format!("unknown template action argument {key:?}")));
        }
    }
    let title = obj
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| invalid("template action requires a non-empty `title`"))?;

    let doc_copy = ws
        .library()
        .load_copy(&format!("book:{book}"))
        .map_err(dr_workspace::WsError::from)?;
    let borrowed = BorrowedBookV3::new(&doc_copy, book)
        .map_err(|e| invalid(format!("invalid v3 book {book}: {e}")))?;
    let view = borrowed.view();
    let templates = view.templates_map();
    let target_tpl_id = EntryTemplateId::parse(&binding.target_template)
        .map_err(|_| invalid("invalid target template id"))?;
    let target_tpl = templates
        .get(&target_tpl_id)
        .filter(|t| !t.is_trashed())
        .ok_or_else(|| invalid("action target template is missing or trashed"))?;

    let mut create_args = json!({
        "book": book.as_str(),
        "parent": binding.reference.level,
        "template": binding.target_template,
        "title": title,
    });
    if let Some(bodies_val) = obj.get("bodies")
        && !bodies_val.is_null()
    {
        let resolved_bodies = resolve_initial_bodies(target_tpl, bodies_val)?;
        create_args["bodies"] = Value::Object(resolved_bodies);
    }

    let mut subjects = vec![format!("entry:{}", binding.reference.level)];
    if let Some(home) = &binding.home
        && home != &binding.reference.level
    {
        subjects.push(format!("entry:{home}"));
    }
    Ok(ResolvedCall {
        name: "entry.create".into(),
        arguments: create_args,
        targets: vec![format!("book:{book}")],
        subjects,
    })
}

/// An entry read with what lies below it covers that level and the
/// entries living under and belonging to it.
fn read_below(read: &mut BTreeSet<String>, entry: &Value) {
    let (Some(id), Some(below)) = (entry["id"].as_str(), entry["below"].as_object()) else {
        return;
    };
    read.insert(format!("level:{id}"));
    for list_key in ["children", "members"] {
        for row in below
            .get(list_key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(id) = row["id"].as_str() {
                read.insert(format!("entry:{id}"));
            }
        }
    }
}

pub(crate) fn coverage_v3(name: &str, args: &Value, output: &Value) -> Option<Vec<String>> {
    let mut read = BTreeSet::new();
    match name {
        "entry.list" => {
            if let Some(rows) = output.as_array() {
                for row in rows {
                    if let Some(id) = row["id"].as_str() {
                        read.insert(format!("entry:{id}"));
                    }
                    read_below(&mut read, row);
                }
            }
            let unfiltered_query = args
                .get("query")
                .is_none_or(|q| q.is_null() || q.as_str() == Some(""));
            if unfiltered_query {
                if args.get("all") == Some(&Value::Bool(true)) {
                    read.insert("entry:*".into());
                    if args.get("trashed") == Some(&Value::Bool(true)) {
                        read.insert("entry:all".into());
                    }
                } else if let Some(parent) = args.get("parent").and_then(Value::as_str) {
                    read.insert(format!("entry:{parent}"));
                    read.insert(format!("level:{parent}"));
                } else {
                    read.insert("entry:roots".into());
                }
            }
        }
        "entry.get" => {
            if let Some(id) = output["id"].as_str() {
                read.insert(format!("entry:{id}"));
            }
            read_below(&mut read, output);
        }
        "entry_template.list" => {
            read.insert("entry_template:*".into());
            if let Some(rows) = output.as_array() {
                for row in rows {
                    if let Some(id) = row["id"].as_str() {
                        read.insert(format!("entry_template:{id}"));
                    }
                }
            }
        }
        "module.list" => {
            if let Some(entry) = args["id"].as_str() {
                read.insert(format!("entry:{entry}"));
                read.insert(format!("module:{entry}:*"));
                if let Some(rows) = output.as_array() {
                    for row in rows {
                        if let Some(mid) = row["id"].as_str() {
                            read.insert(format!("module:{entry}:{mid}"));
                        }
                    }
                }
            }
        }
        "module.read" => {
            if let (Some(entry), Some(mid)) = (args["entry"].as_str(), args["module"].as_str()) {
                read.insert(format!("entry:{entry}"));
                read.insert(format!("module:{entry}:{mid}"));
            }
        }
        "module.read_prose" => {
            if let Some(doc) = prose_doc_from_module_args(args) {
                read.insert(format!("prose:{doc}"));
            }
            if args.get("template") != Some(&Value::Bool(true))
                && let (Some(owner), Some(module)) =
                    (args["owner"].as_str(), args["module"].as_str())
            {
                read.insert(format!("module:{owner}:{module}"));
            }
        }
        "entry_relation_type.list" => {
            read.insert("entry_relation_type:*".into());
            if let Some(rows) = output.as_array() {
                for row in rows {
                    if let Some(id) = row["id"].as_str() {
                        read.insert(format!("entry_relation_type:{id}"));
                    }
                }
            }
        }
        "membership.list" => {
            read.insert("membership:*".into());
        }
        "timeline_view.list" => {
            // This means the filtered collection was read, not that every
            // stored child or pin binding was shown. The executor records
            // per-view/pin completeness at the same guarded book frontier.
            read.insert("timeline_view:*".into());
            if let Some(rows) = output.as_array() {
                for row in rows {
                    if let Some(id) = row["id"].as_str() {
                        read.insert(format!("timeline_view:{id}"));
                    }
                }
            }
        }
        "entry_history.version" => {
            if let Some(book) = args["book"].as_str() {
                read.insert(format!("entry_history:{book}"));
            }
        }
        _ => return None,
    }
    Some(read.into_iter().collect())
}

pub(crate) fn subjects_v3(name: &str, args: &Value) -> Vec<String> {
    let mut subjects = BTreeSet::new();
    match name {
        "comment.create" => {
            // A targeted new comment needs the exact target/module read, not
            // the unrelated global comment collection. Resolver adds those.
            if args.get("target").is_none_or(Value::is_null) {
                subjects.insert("comment:*".into());
            }
        }

        "entry.create" => {
            if let Some(parent) = args.get("parent").and_then(Value::as_str) {
                subjects.insert(format!("entry:{parent}"));
            } else {
                subjects.insert("entry:*".into());
            }
        }
        "entry.update" | "entry.trash" | "entry.restore" | "entry.set_level" => {
            if let Some(id) = args.get("id").and_then(Value::as_str) {
                subjects.insert(format!("entry:{id}"));
            }
        }
        "entry.move" => {
            if let Some(id) = args.get("id").and_then(Value::as_str) {
                subjects.insert(format!("entry:{id}"));
            }
            if let Some(parent) = args.get("parent").and_then(Value::as_str) {
                subjects.insert(format!("entry:{parent}"));
            } else {
                subjects.insert("entry:*".into());
            }
        }
        "entry_template.put" => {
            subjects.insert("entry_template:*".into());
        }
        "entry_template.delete" => {
            if let Some(id) = args.get("id").and_then(Value::as_str) {
                subjects.insert(format!("entry_template:{id}"));
            }
            subjects.insert("entry:*".into());
        }
        "entry_template.put_module" | "entry_template.remove_module" => {
            if let Some(tpl) = args.get("template").and_then(Value::as_str) {
                subjects.insert(format!("entry_template:{tpl}"));
            }
        }
        "module.set_field" | "module.put_kv" | "module.remove_kv" => {
            if let (Some(entry), Some(mid)) = (
                args.get("entry").and_then(Value::as_str),
                args.get("module").and_then(Value::as_str),
            ) {
                subjects.insert(format!("module_inline:{entry}:{mid}"));
            }
        }
        "module.put_patch"
        | "module.remove_patch"
        | "module.put_grid"
        | "module.put_relation"
        | "module.remove_relation" => {
            if let (Some(entry), Some(mid)) = (
                args.get("entry").and_then(Value::as_str),
                args.get("module").and_then(Value::as_str),
            ) {
                subjects.insert(format!("module:{entry}:{mid}"));
            }
        }
        "module.set_prose" | "module.replace_prose" => {
            if name == "module.replace_prose"
                && let Some(doc) = prose_doc_from_module_args(args)
            {
                subjects.insert(format!("prose:{doc}"));
            }
        }
        "entry_relation_type.put" => {
            subjects.insert("entry_relation_type:*".into());
        }
        "entry_relation_type.delete" => {
            if let Some(id) = args.get("id").and_then(Value::as_str) {
                subjects.insert(format!("entry_relation_type:{id}"));
            }
        }
        "membership.add" | "membership.remove" => {
            if let Some(host) = args.get("host").and_then(Value::as_str) {
                subjects.insert(format!("entry:{host}"));
            }
            if let Some(member) = args.get("member").and_then(Value::as_str) {
                subjects.insert(format!("entry:{member}"));
            }
        }
        "membership.primary" => {
            if let Some(member) = args.get("member").and_then(Value::as_str) {
                subjects.insert(format!("entry:{member}"));
            }
            subjects.insert("membership:*".into());
        }
        "timeline_view.put" => {
            subjects.insert("timeline_view:*".into());
        }
        "timeline_view.delete"
        | "timeline_view.place"
        | "timeline_view.remove"
        | "timeline_view.put_pin"
        | "timeline_view.remove_pin" => {
            if let Some(vid) = args
                .get("view")
                .or_else(|| args.get("id"))
                .and_then(Value::as_str)
            {
                subjects.insert(format!("timeline_view:{vid}"));
            }
            if matches!(name, "timeline_view.place" | "timeline_view.remove")
                && let Some(entry) = args.get("entry").and_then(Value::as_str)
            {
                subjects.insert(format!("entry:{entry}"));
            }
        }
        "entry_history.restore" => {
            if let Some(book) = args.get("book").and_then(Value::as_str) {
                subjects.insert(format!("entry_history:{book}"));
            }
            if let Some(targets) = args.get("targets").and_then(Value::as_array) {
                for target in targets {
                    if let (Some(coll), Some(id)) = (
                        target.get("collection").and_then(Value::as_str),
                        target.get("id").and_then(Value::as_str),
                    ) {
                        match coll {
                            "entries" => {
                                subjects.insert(format!("entry:{id}"));
                            }
                            "facts" => {
                                subjects.insert(format!("fact:{id}"));
                            }
                            "memory" => {
                                subjects.insert(format!("memory:{id}"));
                            }
                            "templates" => {
                                subjects.insert(format!("entry_template:{id}"));
                            }
                            "timeline_views" => {
                                subjects.insert(format!("timeline_view:{id}"));
                            }
                            "memberships" => {
                                subjects.insert("membership:*".into());
                            }
                            "relation_types" => {
                                subjects.insert(format!("entry_relation_type:{id}"));
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
        _ => return crate::resolve::subjects_common(name, args),
    }
    subjects.into_iter().collect()
}

pub(crate) fn prose_doc_from_module_args(args: &Value) -> Option<String> {
    let book = args.get("book")?.as_str()?;
    let owner = args.get("owner")?.as_str()?;
    let module = args.get("module")?.as_str()?;
    let is_template = args
        .get("template")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if is_template {
        Some(format!("template:{book}/{owner}/{module}"))
    } else {
        Some(format!("body:{owner}/{module}"))
    }
}

fn resolve_initial_bodies(tpl: &EntryTemplate, bodies_val: &Value) -> Result<Map<String, Value>> {
    let obj = bodies_val
        .as_object()
        .ok_or_else(|| invalid("bodies must be an object mapping module to text"))?;
    let mut out = Map::new();
    for (raw_mod, text_val) in obj {
        let text = string(text_val, "body text")?;
        let mid = resolve_template_module_id(
            tpl,
            &Value::String(raw_mod.clone()),
            Some(ModuleKind::Prose),
        )?;
        let spec = tpl
            .module(&mid)
            .ok_or_else(|| invalid("prose module not found on template"))?;
        if spec.agent.as_ref().is_some_and(|a| !a.writable) {
            return Err(invalid(format!(
                "prose module {:?} ({}) is marked read-only for the Agent",
                spec.name, spec.id
            )));
        }
        if out
            .insert(mid.to_string(), Value::String(text.to_owned()))
            .is_some()
        {
            return Err(invalid(format!("duplicate initial body for module {mid}")));
        }
    }
    Ok(out)
}

fn resolve_settings_override(
    view: &BookViewV3<'_>,
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
    ov_obj: &mut Map<String, Value>,
) -> Result<()> {
    if let Some(dt) = ov_obj.get_mut("default_template")
        && !dt.is_null()
    {
        let tid = resolve_template_id(view, templates, dt, false)?;
        *dt = tid.to_string().into();
    }
    if let Some(home) = ov_obj.get_mut("home")
        && !home.is_null()
    {
        let hid = resolve_entry_id(view, entries, templates, home, None, false, true)?;
        *home = hid.to_string().into();
    }
    Ok(())
}

fn resolve_entry_id(
    view: &BookViewV3<'_>,
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
    value: &Value,
    parent_hint: Option<&str>,
    include_trashed: bool,
    levels_only: bool,
) -> Result<EntryId> {
    let raw = string(value, "entry")?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(invalid("entry name or id is empty"));
    }
    let parent_id = match parent_hint {
        Some(p) if !p.trim().is_empty() => Some(resolve_entry_id(
            view,
            entries,
            templates,
            &Value::String(p.into()),
            None,
            include_trashed,
            true,
        )?),
        _ => None,
    };
    if let Ok(id) = EntryId::parse(trimmed)
        && let Some(entry) = entries.get(&id)
        && (include_trashed || !entry.is_trashed())
    {
        if levels_only && !entry.is_level() {
            return Err(invalid(format!(
                "entry {trimmed:?} has its switch off: nothing lives under it"
            )));
        }
        return Ok(id);
    }
    let key = trimmed.to_lowercase();
    let matches: Vec<&Entry> = entries
        .values()
        .filter(|e| include_trashed || !e.is_trashed())
        .filter(|e| !levels_only || e.is_level())
        .filter(|e| {
            parent_id
                .as_ref()
                .is_none_or(|p| view.effective_parent(&e.id).as_ref() == Some(p))
        })
        .filter(|e| {
            e.title.trim().to_lowercase() == key
                || e.aliases(templates)
                    .iter()
                    .any(|a| a.trim().to_lowercase() == key)
        })
        .collect();
    match matches.as_slice() {
        [entry] => Ok(entry.id.clone()),
        [] => Err(invalid(format!(
            "entry {trimmed:?} was not found in this book"
        ))),
        _ => Err(invalid(format!(
            "entry {trimmed:?} is ambiguous; specify its id or parent level"
        ))),
    }
}

fn resolve_entry_id_filtered(
    view: &BookViewV3<'_>,
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
    value: &Value,
    target_template: Option<&EntryTemplateId>,
) -> Result<EntryId> {
    let raw = string(value, "entry reference")?;
    let trimmed = raw.trim();
    if let Ok(id) = EntryId::parse(trimmed)
        && let Some(e) = entries.get(&id).filter(|e| !e.is_trashed())
    {
        if target_template.is_some_and(|t| e.template.as_ref() != Some(t)) {
            return Err(invalid(
                "referenced entry does not match field target_template",
            ));
        }
        return Ok(id);
    }
    let key = trimmed.to_lowercase();
    let matches: Vec<&Entry> = entries
        .values()
        .filter(|e| !e.is_trashed())
        .filter(|e| target_template.is_none_or(|t| e.template.as_ref() == Some(t)))
        .filter(|e| {
            e.title.trim().to_lowercase() == key
                || e.aliases(templates)
                    .iter()
                    .any(|a| a.trim().to_lowercase() == key)
        })
        .collect();
    match matches.as_slice() {
        [entry] => Ok(entry.id.clone()),
        [] => {
            let _ = view;
            Err(invalid(format!(
                "referenced entry {trimmed:?} was not found"
            )))
        }
        _ => Err(invalid(format!(
            "referenced entry {trimmed:?} is ambiguous; use its entry id"
        ))),
    }
}

fn resolve_template_id(
    _view: &BookViewV3<'_>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
    value: &Value,
    include_trashed: bool,
) -> Result<EntryTemplateId> {
    let raw = string(value, "template")?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(invalid("template name or id is empty"));
    }
    if let Ok(id) = EntryTemplateId::parse(trimmed)
        && let Some(tpl) = templates.get(&id)
        && (include_trashed || !tpl.is_trashed())
    {
        return Ok(id);
    }
    let key = trimmed.to_lowercase();
    let matches: Vec<&EntryTemplate> = templates
        .values()
        .filter(|t| include_trashed || !t.is_trashed())
        .filter(|t| {
            t.name.trim().to_lowercase() == key
                || t.agent.as_ref().is_some_and(|a| {
                    !a.name.trim().is_empty() && a.name.trim().to_lowercase() == key
                })
        })
        .collect();
    match matches.as_slice() {
        [tpl] => Ok(tpl.id.clone()),
        [] => Err(invalid(format!(
            "template {trimmed:?} was not found in this book"
        ))),
        _ => Err(invalid(format!(
            "template {trimmed:?} is ambiguous; specify its template id"
        ))),
    }
}

fn resolve_template_module_id(
    tpl: &EntryTemplate,
    value: &Value,
    expected_kind: Option<ModuleKind>,
) -> Result<ModuleId> {
    let raw = string(value, "module")?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(invalid("module name or id is empty"));
    }
    if let Ok(mid) = ModuleId::parse(trimmed)
        && let Some(m) = tpl.module(&mid)
    {
        if expected_kind.as_ref().is_some_and(|k| &m.kind != k) {
            return Err(invalid(format!(
                "module {:?} ({}) does not match the required module kind",
                m.name, m.id
            )));
        }
        return Ok(mid);
    }
    let key = trimmed.to_lowercase();
    let matches: Vec<&ModuleSpec> = tpl
        .modules
        .iter()
        .filter(|m| expected_kind.as_ref().is_none_or(|k| &m.kind == k))
        .filter(|m| m.name.trim().to_lowercase() == key)
        .collect();
    match matches.as_slice() {
        [m] => Ok(m.id.clone()),
        [] => Err(invalid(format!(
            "module {trimmed:?} was not found on template {:?}",
            tpl.name
        ))),
        _ => Err(invalid(format!(
            "module {trimmed:?} on template {:?} is ambiguous; use its module id",
            tpl.name
        ))),
    }
}

#[allow(clippy::too_many_arguments)]
fn resolve_entry_module(
    ws: &Workspace,
    book: &BookId,
    view: &BookViewV3<'_>,
    entry: &Entry,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
    value: &Value,
    allow_retained: bool,
    require_writable: bool,
) -> Result<(ModuleId, Option<ModuleSpec>)> {
    let raw = string(value, "module")?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(invalid("module name or id is empty"));
    }
    let active_tpl = entry.effective_template(templates);
    let active_modules = active_tpl.map(|t| t.modules.as_slice()).unwrap_or(&[]);

    if let Ok(mid) = ModuleId::parse(trimmed) {
        if let Some(m) = active_modules.iter().find(|m| m.id == mid) {
            if require_writable && m.agent.as_ref().is_some_and(|a| !a.writable) {
                return Err(invalid(format!(
                    "module {:?} ({}) is marked read-only for the Agent",
                    m.name, m.id
                )));
            }
            return Ok((mid, Some(m.clone())));
        }
        if has_retained_module(ws, book, view, entry, &mid)? {
            if !allow_retained || require_writable {
                return Err(invalid(format!(
                    "retained module {mid} from a previous template is read-only"
                )));
            }
            return Ok((mid, None));
        }
    }

    let key = trimmed.to_lowercase();
    let matches: Vec<&ModuleSpec> = active_modules
        .iter()
        .filter(|m| m.name.trim().to_lowercase() == key)
        .collect();
    match matches.as_slice() {
        [m] => {
            if require_writable && m.agent.as_ref().is_some_and(|a| !a.writable) {
                return Err(invalid(format!(
                    "module {:?} ({}) is marked read-only for the Agent",
                    m.name, m.id
                )));
            }
            Ok((m.id.clone(), Some((*m).clone())))
        }
        [] => Err(invalid(format!(
            "module {trimmed:?} was not found on entry {:?}",
            entry.title
        ))),
        _ => Err(invalid(format!(
            "module {trimmed:?} on entry {:?} is ambiguous; specify its module id",
            entry.title
        ))),
    }
}

#[allow(clippy::too_many_arguments)]
fn resolve_entry_prose_module(
    ws: &Workspace,
    book: &BookId,
    view: &BookViewV3<'_>,
    entry: &Entry,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
    value: &Value,
    allow_retained: bool,
    require_writable: bool,
) -> Result<ModuleId> {
    let raw = string(value, "module")?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(invalid("prose module name or id is empty"));
    }
    let active_tpl = entry.effective_template(templates);
    let prose_modules: Vec<&ModuleSpec> = active_tpl
        .into_iter()
        .flat_map(|t| t.modules.iter())
        .filter(|m| m.kind == ModuleKind::Prose)
        .collect();

    if let Ok(mid) = ModuleId::parse(trimmed) {
        if let Some(m) = prose_modules.iter().find(|m| m.id == mid) {
            if require_writable && m.agent.as_ref().is_some_and(|a| !a.writable) {
                return Err(invalid(format!(
                    "prose module {:?} ({}) is marked read-only for the Agent",
                    m.name, m.id
                )));
            }
            return Ok(mid);
        }
        if has_retained_prose_doc(ws, book, &entry.id, &mid)? {
            if !allow_retained || require_writable {
                return Err(invalid(format!("retained prose module {mid} is read-only")));
            }
            return Ok(mid);
        }
    }

    let key = trimmed.to_lowercase();
    let matches: Vec<&&ModuleSpec> = prose_modules
        .iter()
        .filter(|m| m.name.trim().to_lowercase() == key)
        .collect();
    match matches.as_slice() {
        [m] => {
            if require_writable && m.agent.as_ref().is_some_and(|a| !a.writable) {
                return Err(invalid(format!(
                    "prose module {:?} ({}) is marked read-only for the Agent",
                    m.name, m.id
                )));
            }
            Ok(m.id.clone())
        }
        [] => {
            let _ = view;
            Err(invalid(format!(
                "prose module {trimmed:?} was not found on entry {:?}",
                entry.title
            )))
        }
        _ => Err(invalid(format!(
            "prose module {trimmed:?} on entry {:?} is ambiguous; specify its module id",
            entry.title
        ))),
    }
}

fn resolve_template_prose_module(
    ws: &Workspace,
    book: &BookId,
    tpl: &EntryTemplate,
    value: &Value,
    allow_retained: bool,
    require_writable: bool,
) -> Result<ModuleId> {
    let raw = string(value, "module")?;
    let trimmed = raw.trim();
    if let Ok(mid) = ModuleId::parse(trimmed) {
        if let Some(m) = tpl.module(&mid).filter(|m| m.kind == ModuleKind::Prose) {
            if require_writable && m.agent.as_ref().is_some_and(|a| !a.writable) {
                return Err(invalid(format!(
                    "template prose module {:?} ({}) is marked read-only for the Agent",
                    m.name, m.id
                )));
            }
            return Ok(mid);
        }
        let doc = format!("template:{book}/{}/{mid}", tpl.id);
        let retained = ws
            .library()
            .doc_info(&doc)
            .map_err(dr_agent::Error::from)?
            .is_some();
        if retained {
            if !allow_retained || require_writable {
                return Err(invalid(format!(
                    "retained template prose module {mid} is read-only"
                )));
            }
            return Ok(mid);
        }
    }
    let mid = resolve_template_module_id(tpl, value, Some(ModuleKind::Prose))?;
    if let Some(m) = tpl.module(&mid)
        && require_writable
        && m.agent.as_ref().is_some_and(|a| !a.writable)
    {
        return Err(invalid(format!(
            "template prose module {:?} ({}) is marked read-only for the Agent",
            m.name, m.id
        )));
    }
    Ok(mid)
}

fn has_retained_module(
    ws: &Workspace,
    book: &BookId,
    view: &BookViewV3<'_>,
    entry: &Entry,
    mid: &ModuleId,
) -> Result<bool> {
    if entry.fields.contains_key(mid)
        || entry.kv.contains_key(mid)
        || view
            .patches()
            .iter()
            .any(|p| p.entry == entry.id && &p.module == mid)
        || view
            .plot_grids()
            .iter()
            .any(|g| g.entry == entry.id && &g.module == mid)
    {
        return Ok(true);
    }
    has_retained_prose_doc(ws, book, &entry.id, mid)
}

fn has_retained_prose_doc(
    ws: &Workspace,
    book: &BookId,
    entry: &EntryId,
    mid: &ModuleId,
) -> Result<bool> {
    let doc = DocId::Body(BodyDocId::new(entry.clone(), mid.clone())).to_string();
    Ok(ws
        .library()
        .doc_info(&doc)
        .map_err(dr_agent::Error::from)?
        .is_some_and(|info| info.book_id.as_deref() == Some(book.as_str())))
}

#[allow(clippy::too_many_arguments)]
fn resolve_document_v3(
    ws: &Workspace,
    book: &BookId,
    view: &BookViewV3<'_>,
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
    value: &Value,
    prose_only: bool,
    require_writable: bool,
) -> Result<String> {
    let doc = if let Some(raw) = value.as_str() {
        let parsed = DocId::parse(raw).map_err(|_| {
            invalid("a document needs its id or an entry/template/material selector")
        })?;
        if let DocId::Body(body) = &parsed {
            let entry = entries
                .get(body.entry())
                .filter(|e| !e.is_trashed())
                .ok_or_else(|| invalid("prose document entry is missing or trashed"))?;
            let _ = resolve_entry_prose_module(
                ws,
                book,
                view,
                entry,
                templates,
                &Value::String(body.module().to_string()),
                true,
                require_writable,
            )?;
        } else if let DocId::Template(tdoc) = &parsed
            && let Some((doc_book, tid, mid)) = tdoc.entry_module()
        {
            if &doc_book != book {
                return Err(invalid("document belongs to another book"));
            }
            let tpl = templates
                .get(&tid)
                .filter(|t| !t.is_trashed())
                .ok_or_else(|| invalid("template is missing or trashed"))?;
            let _ = resolve_template_prose_module(
                ws,
                book,
                tpl,
                &Value::String(mid.to_string()),
                true,
                require_writable,
            )?;
        }
        parsed
    } else if let Some(obj) = value.as_object() {
        let kind = obj.get("kind").and_then(Value::as_str);
        if kind == Some("material") || obj.contains_key("material") {
            let selector = obj
                .get("material")
                .or_else(|| obj.get("name"))
                .or_else(|| obj.get("id"))
                .ok_or_else(|| invalid("material document selector needs name or id"))?;
            let mid = resolve_material_id(view, selector)?;
            DocId::parse(&format!("material:{mid}"))
                .map_err(|_| invalid("target has no prose document"))?
        } else if kind == Some("template")
            || (obj.contains_key("template") && !obj.contains_key("entry"))
        {
            let tpl_selector = obj
                .get("template")
                .or_else(|| obj.get("name"))
                .or_else(|| obj.get("id"))
                .ok_or_else(|| invalid("template document selector needs template"))?;
            let tid = resolve_template_id(view, templates, tpl_selector, false)?;
            let tpl = templates.get(&tid).expect("resolved template");
            let mod_val = obj
                .get("module")
                .ok_or_else(|| invalid("template document selector needs module"))?;
            let mid =
                resolve_template_prose_module(ws, book, tpl, mod_val, true, require_writable)?;
            DocId::parse(&format!("template:{book}/{tid}/{mid}"))
                .map_err(|_| invalid("invalid template prose document"))?
        } else {
            let entry_selector = obj
                .get("entry")
                .or_else(|| obj.get("name"))
                .or_else(|| obj.get("id"))
                .ok_or_else(|| invalid("entry document selector needs entry, name, or id"))?;
            let parent_hint = obj.get("parent").and_then(Value::as_str);
            let eid = resolve_entry_id(
                view,
                entries,
                templates,
                entry_selector,
                parent_hint,
                false,
                false,
            )?;
            let entry = entries.get(&eid).expect("resolved entry");
            let mid = if let Some(mod_val) = obj.get("module").filter(|v| !v.is_null()) {
                resolve_entry_prose_module(
                    ws,
                    book,
                    view,
                    entry,
                    templates,
                    mod_val,
                    true,
                    require_writable,
                )?
            } else {
                default_single_prose_module(ws, book, entry, templates, require_writable)?
            };
            DocId::Body(BodyDocId::new(eid, mid))
        }
    } else {
        return Err(invalid("document selector must be a string or object"));
    };

    if matches!(
        doc,
        DocId::Conversation(_) | DocId::Stats(_) | DocId::Checkpoints(_)
    ) || (prose_only && doc.profile().is_none())
    {
        return Err(invalid("target is not an authored prose document"));
    }
    let id = doc.to_string();
    let info = ws
        .library()
        .doc_info(&id)
        .map_err(dr_agent::Error::from)?
        .ok_or_else(|| invalid("document is not stored"))?;
    if info.book_id.as_deref() != Some(book.as_str()) {
        return Err(invalid("document belongs to another book"));
    }
    Ok(id)
}

fn default_single_prose_module(
    ws: &Workspace,
    book: &BookId,
    entry: &Entry,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
    require_writable: bool,
) -> Result<ModuleId> {
    let active_tpl = entry.effective_template(templates);
    let prose_mods: Vec<&ModuleSpec> = active_tpl
        .into_iter()
        .flat_map(|t| t.modules.iter())
        .filter(|m| m.kind == ModuleKind::Prose)
        .collect();
    let mut retained_prose = Vec::new();
    for info in ws
        .library()
        .docs(Some(book.as_str()), None)
        .map_err(dr_agent::Error::from)?
    {
        if let Ok(DocId::Body(body)) = DocId::parse(&info.doc_id)
            && body.entry() == &entry.id
            && !prose_mods.iter().any(|m| &m.id == body.module())
        {
            retained_prose.push(body.module().clone());
        }
    }
    match (prose_mods.as_slice(), retained_prose.as_slice()) {
        ([m], []) => {
            if require_writable && m.agent.as_ref().is_some_and(|a| !a.writable) {
                return Err(invalid(format!(
                    "prose module {:?} ({}) is marked read-only for the Agent",
                    m.name, m.id
                )));
            }
            Ok(m.id.clone())
        }
        ([], [retained]) if !require_writable => Ok(retained.clone()),
        ([], []) => Err(invalid(format!(
            "entry {:?} has no prose module",
            entry.title
        ))),
        _ => Err(invalid(format!(
            "entry {:?} has multiple prose modules; specify `module` explicitly",
            entry.title
        ))),
    }
}

fn resolve_entity_ref_v3(
    view: &BookViewV3<'_>,
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
    value: &mut Value,
) -> Result<()> {
    if value.is_null() {
        return Ok(());
    }
    let raw_kind = value["kind"]
        .as_str()
        .ok_or_else(|| invalid("target needs kind"))?;
    let name_or_id = value
        .get("name")
        .or_else(|| value.get("id"))
        .ok_or_else(|| invalid("target needs name or id"))?;
    let parent_hint = value.get("parent").and_then(Value::as_str);
    let tpl_hint = value.get("template").and_then(Value::as_str);
    let (canonical_kind, resolved_id) = match raw_kind {
        "entry" => {
            let eid = if let Some(tpl_s) = tpl_hint {
                let tid =
                    resolve_template_id(view, templates, &Value::String(tpl_s.into()), false)?;
                resolve_entry_id_filtered(view, entries, templates, name_or_id, Some(&tid))?
            } else {
                resolve_entry_id(
                    view,
                    entries,
                    templates,
                    name_or_id,
                    parent_hint,
                    false,
                    false,
                )?
            };
            ("entry", eid.to_string())
        }
        "material" => ("material", resolve_material_id(view, name_or_id)?),
        "comment" => ("comment", resolve_comment_id(view, name_or_id)?),
        "patch" => {
            let patches = view.patches();
            (
                "patch",
                resolve_patch_id(&patches, string(name_or_id, "patch")?)?,
            )
        }
        other => {
            return Err(invalid(format!(
                "unsupported v3 endpoint kind {other:?}; use entry, material, comment, or patch"
            )));
        }
    };
    *value = json!({"kind": canonical_kind, "id": resolved_id});
    Ok(())
}

fn resolve_history_session(
    ws: &Workspace,
    book: &BookId,
    view: &BookViewV3<'_>,
    session: &str,
    turn: Option<&Value>,
    targets: &mut BTreeSet<String>,
) -> Result<()> {
    let lib = ws.library();
    if let Some(run) = lib.agent_session(session).map_err(dr_agent::Error::from)?
        && run.book_id != book.as_str()
    {
        return Err(invalid("history session belongs to another book"));
    }
    let rows = lib
        .settlements(Some(session), None)
        .map_err(dr_agent::Error::from)?;
    if rows.is_empty()
        && lib
            .agent_session(session)
            .map_err(dr_agent::Error::from)?
            .is_none()
    {
        return Err(invalid("history session is unknown"));
    }
    let turn = turn.and_then(Value::as_u64).map(|t| t.to_string());
    for row in rows {
        let doc = DocId::parse(&row.doc_id).map_err(|_| invalid("invalid settlement doc id"))?;
        if !view.owns_prose(&doc)
            && lib
                .doc_info(&row.doc_id)
                .map_err(dr_agent::Error::from)?
                .is_none_or(|info| info.book_id.as_deref() != Some(book.as_str()))
        {
            return Err(invalid("history session document belongs to another book"));
        }
        if turn.as_ref().is_none_or(|t| t == &row.turn) {
            targets.insert(row.doc_id);
        }
    }
    Ok(())
}

fn resolve_field_def<'a>(spec: &'a ModuleSpec, raw: &str) -> Result<&'a dr_model::v3::FieldDef> {
    let trimmed = raw.trim();
    if let Some(def) = spec.config.defs.iter().find(|d| d.id == trimmed) {
        return Ok(def);
    }
    let key = trimmed.to_lowercase();
    let matches: Vec<&dr_model::v3::FieldDef> = spec
        .config
        .defs
        .iter()
        .filter(|d| d.name.trim().to_lowercase() == key)
        .collect();
    match matches.as_slice() {
        [def] => Ok(def),
        [] => Err(invalid(format!(
            "field {trimmed:?} was not found in module {:?}",
            spec.name
        ))),
        _ => Err(invalid(format!(
            "field {trimmed:?} in module {:?} is ambiguous; use its field id",
            spec.name
        ))),
    }
}

fn resolve_kv_put_row(row_obj: &mut Map<String, Value>, existing: &[KvEntry]) -> Result<()> {
    let key_str = row_obj
        .get("key")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_lowercase();
    if let Some(id_val) = row_obj.get_mut("id")
        && let Some(raw) = id_val.as_str()
        && !raw.trim().is_empty()
    {
        if KvEntryId::parse(raw).is_ok() {
            return Ok(());
        }
        let resolved = resolve_kv_row_id(existing, raw)?;
        *id_val = resolved.to_string().into();
        return Ok(());
    }
    let key_matches: Vec<&KvEntry> = existing
        .iter()
        .filter(|r| !key_str.is_empty() && r.key.trim().to_lowercase() == key_str)
        .collect();
    let id = match key_matches.as_slice() {
        [row] => row.id.clone(),
        _ => KvEntryId::new_v7(),
    };
    row_obj.insert("id".into(), id.to_string().into());
    Ok(())
}

fn resolve_kv_row_id(existing: &[KvEntry], raw: &str) -> Result<KvEntryId> {
    let trimmed = raw.trim();
    if let Ok(id) = KvEntryId::parse(trimmed)
        && existing.iter().any(|r| r.id == id)
    {
        return Ok(id);
    }
    let key = trimmed.to_lowercase();
    let matches: Vec<&KvEntry> = existing
        .iter()
        .filter(|r| r.key.trim().to_lowercase() == key)
        .collect();
    match matches.as_slice() {
        [row] => Ok(row.id.clone()),
        [] => Err(invalid(format!("kv row {trimmed:?} was not found"))),
        _ => Err(invalid(format!(
            "kv row {trimmed:?} is ambiguous; specify its row id"
        ))),
    }
}

fn resolve_patch_id(patches: &[dr_model::v3::PatchV3], raw: &str) -> Result<String> {
    let trimmed = raw.trim();
    if let Some(p) = patches.iter().find(|p| p.id.as_str() == trimmed) {
        return Ok(p.id.to_string());
    }
    let key = trimmed.to_lowercase();
    let matches: Vec<&dr_model::v3::PatchV3> = patches
        .iter()
        .filter(|p| {
            p.title
                .as_deref()
                .is_some_and(|t| t.trim().to_lowercase() == key)
                || p.body.trim().to_lowercase() == key
        })
        .collect();
    match matches.as_slice() {
        [p] => Ok(p.id.to_string()),
        [] => Err(invalid(format!("patch {trimmed:?} was not found"))),
        _ => Err(invalid(format!(
            "patch {trimmed:?} is ambiguous; specify its patch id"
        ))),
    }
}

fn resolve_relation_type_id(view: &BookViewV3<'_>, value: &Value) -> Result<String> {
    let raw = string(value, "relation_type")?;
    let trimmed = raw.trim();
    let types = view.relation_types();
    if let Some(rt) = types.iter().find(|t| t.id.as_str() == trimmed) {
        return Ok(rt.id.to_string());
    }
    let key = trimmed.to_lowercase();
    let matches: Vec<_> = types
        .iter()
        .filter(|t| {
            t.name.trim().to_lowercase() == key
                || t.normalized_name == key
                || t.system_key.as_ref().is_some_and(|k| k.as_str() == trimmed)
        })
        .collect();
    match matches.as_slice() {
        [rt] => Ok(rt.id.to_string()),
        [] => Err(invalid(format!(
            "relation type {trimmed:?} was not found in this book"
        ))),
        _ => Err(invalid(format!(
            "relation type {trimmed:?} is ambiguous; specify its id"
        ))),
    }
}

fn resolve_timeline_view_id(view: &BookViewV3<'_>, value: &Value) -> Result<TimelineViewId> {
    let raw = string(value, "timeline view")?;
    let trimmed = raw.trim();
    let views = view.timeline_views();
    if let Some(tv) = views.iter().find(|v| v.id.as_str() == trimmed) {
        return Ok(tv.id.clone());
    }
    let key = trimmed.to_lowercase();
    let matches: Vec<_> = views
        .iter()
        .filter(|v| v.name.trim().to_lowercase() == key)
        .collect();
    match matches.as_slice() {
        [tv] => Ok(tv.id.clone()),
        [] => Err(invalid(format!(
            "timeline view {trimmed:?} was not found in this book"
        ))),
        _ => Err(invalid(format!(
            "timeline view {trimmed:?} is ambiguous; specify its id"
        ))),
    }
}

fn resolve_timeline_pin_id(
    view: &BookViewV3<'_>,
    vid: &TimelineViewId,
    value: &Value,
) -> Result<String> {
    let raw = string(value, "pin")?;
    let trimmed = raw.trim();
    let tv = view
        .timeline_views()
        .into_iter()
        .find(|t| &t.id == vid)
        .ok_or_else(|| invalid("timeline view not found"))?;
    if let Some(p) = tv.pins.iter().find(|p| p.id.as_str() == trimmed) {
        return Ok(p.id.to_string());
    }
    let key = trimmed.to_lowercase();
    let matches: Vec<_> = tv
        .pins
        .iter()
        .filter(|p| p.label.trim().to_lowercase() == key)
        .collect();
    match matches.as_slice() {
        [p] => Ok(p.id.to_string()),
        [] => Err(invalid(format!(
            "time pin {trimmed:?} was not found in timeline view {:?}",
            tv.name
        ))),
        _ => Err(invalid(format!(
            "time pin {trimmed:?} is ambiguous; specify its pin id"
        ))),
    }
}

fn resolve_material_id(view: &BookViewV3<'_>, value: &Value) -> Result<String> {
    let raw = string(value, "material")?;
    let trimmed = raw.trim();
    let materials = view.materials();
    if let Some(m) = materials.iter().find(|m| m.id.as_str() == trimmed) {
        return Ok(m.id.to_string());
    }
    let key = trimmed.to_lowercase();
    let matches: Vec<_> = materials
        .iter()
        .filter(|m| m.title.trim().to_lowercase() == key)
        .collect();
    match matches.as_slice() {
        [m] => Ok(m.id.to_string()),
        [] => Err(invalid(format!(
            "material {trimmed:?} was not found in this book"
        ))),
        _ => Err(invalid(format!(
            "material {trimmed:?} is ambiguous; specify its material id"
        ))),
    }
}

fn resolve_comment_id(view: &BookViewV3<'_>, value: &Value) -> Result<String> {
    let raw = string(value, "comment")?;
    let trimmed = raw.trim();
    let comments = view.comments();
    if let Some(c) = comments.iter().find(|c| c.id.as_str() == trimmed) {
        return Ok(c.id.to_string());
    }
    let key = trimmed.to_lowercase();
    let matches: Vec<_> = comments
        .iter()
        .filter(|c| c.body.trim().to_lowercase() == key)
        .collect();
    match matches.as_slice() {
        [c] => Ok(c.id.to_string()),
        [] => Err(invalid(format!(
            "comment {trimmed:?} was not found in this book"
        ))),
        _ => Err(invalid(format!(
            "comment {trimmed:?} is ambiguous; specify its comment id"
        ))),
    }
}

fn resolve_material_args(
    view: &BookViewV3<'_>,
    name: &str,
    obj: &mut Map<String, Value>,
) -> Result<()> {
    let folders = view.material_folders();
    if let Some(folder_val) = obj.get_mut("folder")
        && !folder_val.is_null()
        && !(name == "material.list" && folder_val == "")
    {
        let raw = string(folder_val, "folder")?;
        let fid = resolve_folder_id(&folders, raw)?;
        *folder_val = fid.into();
    }
    if let Some(parent_val) = obj.get_mut("parent")
        && !parent_val.is_null()
    {
        let raw = string(parent_val, "parent")?;
        let fid = resolve_folder_id(&folders, raw)?;
        *parent_val = fid.into();
    }
    if let Some(id_val) = obj.get_mut("id")
        && !id_val.is_null()
        && !name.ends_with(".create")
    {
        if name.starts_with("material_folder.") {
            let raw = string(id_val, "id")?;
            let fid = resolve_folder_id(&folders, raw)?;
            *id_val = fid.into();
        } else {
            let mid = resolve_material_id(view, id_val)?;
            *id_val = mid.into();
        }
    }
    Ok(())
}

fn resolve_folder_id(folders: &[dr_model::shared::MaterialFolder], raw: &str) -> Result<String> {
    let trimmed = raw.trim();
    if let Some(f) = folders.iter().find(|f| f.id.as_str() == trimmed) {
        return Ok(f.id.to_string());
    }
    let key = trimmed.to_lowercase();
    let matches: Vec<_> = folders
        .iter()
        .filter(|f| f.name.trim().to_lowercase() == key)
        .collect();
    match matches.as_slice() {
        [f] => Ok(f.id.to_string()),
        [] => Err(invalid(format!(
            "material folder {trimmed:?} was not found in this book"
        ))),
        _ => Err(invalid(format!(
            "material folder {trimmed:?} is ambiguous; specify its id"
        ))),
    }
}

fn affected_views_on_membership_remove(
    view: &BookViewV3<'_>,
    host: &EntryId,
    member: &EntryId,
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> Vec<TimelineViewId> {
    let remaining: Vec<_> = view
        .memberships()
        .into_iter()
        .filter(|m| &m.host != host || &m.member != member)
        .filter(|m| check_membership(&m.host, &m.member, entries, templates).is_ok())
        .collect();
    view.timeline_views_raw()
        .into_iter()
        .filter(|tv| {
            !tv.is_trashed()
                && tv.placements.iter().any(|p| &p.entry == member)
                && check_timeline_placement_in_lane(tv, member, &remaining, entries, templates)
                    .is_err()
        })
        .map(|tv| tv.id)
        .collect()
}

fn looks_like_uuid(value: &str) -> bool {
    EntryId::parse(value).is_ok()
}

fn string<'a>(value: &'a Value, what: &str) -> Result<&'a str> {
    value
        .as_str()
        .ok_or_else(|| invalid(format!("{what} must be a string")))
}

fn invalid(message: impl Into<String>) -> Error {
    Error::Invalid(message.into())
}
