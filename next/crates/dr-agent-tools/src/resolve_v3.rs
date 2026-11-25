//! Kernel v3 identity projection, template action binding, read coverage,
//! and schema projection (`docs/rust-rewrite/modules/k6-agent-tools.md`).

use std::borrow::Cow;
use std::cell::OnceCell;
use std::collections::{BTreeMap, BTreeSet};

use dr_doc::v3::{BookViewV3, BorrowedBookV3};
use dr_model::{
    DocId,
    id::{
        AssetFolderId, AssetId, BodyDocId, BookId, EntryId, EntryTemplateId, KvEntryId,
        MediaItemId, ModuleId, TabId, TimelineViewId,
    },
    kind::{CommentStatus, ProjectionKind},
    shared::{Asset, AssetFolder, KvEntry},
    v3::{
        Entry, EntryTemplate, FieldType, ModuleKind, ModuleSpec, check_membership,
        check_timeline_placement_in_lane, effective_parent_id, resolve_level_settings,
        resolve_new_entry_residence,
    },
};
use dr_store::Library;
use dr_workspace::commands::v3::relations;
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
        // A saved project template is the library's, named by its id only;
        // so is a module of mine (and a book's copy of one).
        && domain != "project_template"
        && domain != "custom_module"
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
            "left",
            "right",
            "owner",
            "folder",
            "item",
        ] {
            let is_reference = match key {
                "id" if domain == "relation_row" => false,
                "id" => !matches!((domain, verb), (_, "create" | "add")) || name == "tab.put",
                "item" => name == "module.remove_media",
                _ => true,
            };
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
    if name == "module.put_media"
        && let Some(required) = schema["$defs"]["MediaItem"]["required"].as_array_mut()
    {
        required.retain(|key| key != "id");
    }
    fn visit(value: &mut Value, name: &str) {
        if let Some(properties) = value.get_mut("properties").and_then(Value::as_object_mut) {
            if let Some(doc) = properties.get_mut("doc") {
                *doc = json!({
                    "description": "An authored document id, or an entry/template selector.",
                    "anyOf": [
                        doc.clone(),
                        {
                            "type": "object",
                            "properties": {
                                "kind": {"type": "string", "enum": ["entry", "template"]},
                                "entry": {"type": "string"},
                                "template": {"type": "string"},
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
                if let Some(kind_prop) = properties.get_mut("kind") {
                    if matches!(
                        name,
                        "prose.link" | "prose.unlink" | "comment.create" | "comment.list"
                    ) {
                        kind_prop["enum"] = json!(["entry", "asset"]);
                        kind_prop["description"] = json!("Canonical `entry` or `asset`.");
                    } else if kind_prop
                        .get("description")
                        .and_then(Value::as_str)
                        .is_some_and(|d| d.contains("Canonical `entry`"))
                    {
                        kind_prop["description"] =
                            json!("Canonical `entry`, `asset`, `patch` or `comment`.");
                    }
                }
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
                visit(child, name);
            }
        }
    }
    visit(&mut schema, name);
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

struct ResolveCtx<'a> {
    lib: &'a Library,
    book: &'a BookId,
    view: BookViewV3<'a>,
    templates: OnceCell<BTreeMap<EntryTemplateId, EntryTemplate>>,
    headers: OnceCell<BTreeMap<EntryId, Entry>>,
}

impl<'a> ResolveCtx<'a> {
    fn new(lib: &'a Library, book: &'a BookId, view: BookViewV3<'a>) -> Self {
        Self {
            lib,
            book,
            view,
            templates: OnceCell::new(),
            headers: OnceCell::new(),
        }
    }

    fn templates(&self) -> &BTreeMap<EntryTemplateId, EntryTemplate> {
        self.templates.get_or_init(|| self.view.templates_map())
    }

    fn headers(&self) -> &BTreeMap<EntryId, Entry> {
        self.headers
            .get_or_init(|| self.view.entry_headers_with(self.templates()))
    }

    fn entry_header(&self, id: &EntryId) -> Option<Cow<'_, Entry>> {
        if let Some(headers) = self.headers.get() {
            headers.get(id).map(Cow::Borrowed)
        } else {
            self.view.entry_raw(id).map(Cow::Owned)
        }
    }

    fn template(&self, id: &EntryTemplateId) -> Option<Cow<'_, EntryTemplate>> {
        if let Some(templates) = self.templates.get() {
            templates.get(id).map(Cow::Borrowed)
        } else {
            self.view.template(id).map(Cow::Owned)
        }
    }

    fn active_template(&self, entry: &Entry) -> Option<Cow<'_, EntryTemplate>> {
        let tid = entry.template.as_ref()?;
        self.template(tid).filter(|t| !t.is_trashed())
    }
}

pub(crate) fn resolve_v3(
    ws: &Workspace,
    book: &BookId,
    catalog: Option<&Catalog>,
    name: &str,
    mut args: Value,
) -> Result<ResolvedCall> {
    if name.starts_with("action:") {
        return resolve_action(ws, book, catalog, name, args);
    }
    let spec = registry()
        .get(name)
        .filter(|spec| allowed_v3(spec))
        .ok_or_else(|| invalid(format!("tool {name:?} is not in this book's tool catalog")))?;
    let schema = input_schema_for(spec, BookKernelVersion::V3);
    let has_book_prop = schema["properties"].get("book").is_some();
    {
        let obj = args
            .as_object()
            .ok_or_else(|| invalid("tool arguments must be an object"))?;
        if let Some(given) = obj.get("book")
            && given.as_str() != Some(book.as_str())
        {
            return Err(invalid("tool belongs to another book"));
        }
        // A working copy's template takes these from the copy itself; refused
        // here, before the template has to be read for the save.
        if name == "project_template.save"
            && ["name", "description", "agent"]
                .iter()
                .any(|key| obj.contains_key(*key))
            && ws.is_working_copy(book.as_str())?
        {
            return Err(invalid(
                dr_workspace::commands::v3::project_template::WORKING_COPY_WORDS,
            ));
        }
        // A module goes through the one validator before anything is
        // written; a refusal says where and which rule (CM4b).
        if matches!(
            name,
            "custom_module.create" | "custom_module.update" | "custom_module.save_as"
        ) && let Some(value) = obj.get("value").filter(|v| !v.is_null())
        {
            check_module_value(value)?;
        }
        // 「另存一份」 is for a module of mine; one that came with someone
        // else's template or book is kept in my modules by the author first
        // (`custom-modules.md` §7 甲, 「存进我的模块」).
        if name == "custom_module.save_as"
            && let Some(raw) = obj.get("module").and_then(Value::as_str)
        {
            let id = dr_model::id::CustomModuleId::parse(raw.trim())
                .map_err(|e| invalid(format!("module {raw:?}: {e}")))?;
            if !dr_workspace::commands::v3::custom_module::in_my_modules(ws, &id)? {
                return Err(invalid(format!(
                    "module {raw} is not one of my modules: it came with someone else's template or book, and only the author keeps it in my modules"
                )));
            }
        }
    }

    let book_id = book.clone();
    let lib = ws.library().clone();
    let tool_name = name.to_owned();
    let is_query = spec.is_query();

    ws.read_book_v3(book.as_str(), move |doc, _| {
        Ok((|| -> Result<ResolvedCall> {
            let name = tool_name.as_str();
            let borrowed = BorrowedBookV3::new(doc, &book_id)
                .map_err(|e| invalid(format!("invalid book {book_id}: {e}")))?;
            let cx = ResolveCtx::new(&lib, &book_id, borrowed.view());
            let obj = args.as_object_mut().expect("validated object");

            let mut targets = BTreeSet::new();
            let mut extra_subjects = BTreeSet::new();

            if has_book_prop {
                obj.insert("book".into(), book_id.to_string().into());
                targets.insert(format!("book:{book_id}"));
            }

            if let Some(doc_val) = obj.get_mut("doc") {
                let prose_only = name.starts_with("prose.");
                let is_write = !is_query;
                let resolved_doc = resolve_document_v3(&cx, doc_val, prose_only, is_write)?;
                targets.insert(resolved_doc.clone());
                *doc_val = resolved_doc.into();
            }

            if let Some(session) = obj.get("session") {
                let session_id = string(session, "session")?;
                resolve_history_session(&cx, session_id, obj.get("turn"), &mut targets)?;
            }

            if let Some(links) = obj.get_mut("links") {
                let is_write = !is_query;
                for link in links
                    .as_array_mut()
                    .ok_or_else(|| invalid("links must be an array"))?
                {
                    let doc = link
                        .get_mut("doc")
                        .ok_or_else(|| invalid("link needs a document"))?;
                    let resolved = resolve_document_v3(&cx, doc, true, is_write)?;
                    targets.insert(resolved.clone());
                    *doc = resolved.into();
                    let target = link
                        .get_mut("target")
                        .ok_or_else(|| invalid("link needs a target"))?;
                    resolve_entity_ref_v3(&cx, target, false)?;
                }
            }

            for key in ["target", "entity", "from", "to", "other"] {
                if let Some(value) = obj.get_mut(key)
                    && value.is_object()
                {
                    let include_trashed = key == "target" && name == "comment.list";
                    resolve_entity_ref_v3(&cx, value, include_trashed)?;
                }
            }

            match name {
                "comment.list" | "comment.anchors" | "comment.create" => {
                    let anchored = name == "comment.create"
                        && ["range", "block_id", "anchor"]
                            .iter()
                            .any(|k| obj.get(*k).is_some_and(|v| !v.is_null()));
                    let embed_part = obj
                        .get("part")
                        .and_then(|p| p.get("kind"))
                        .and_then(Value::as_str)
                        == Some("embed");
                    if let Some(target) = obj.get("target").filter(|t| !t.is_null()) {
                        let kind = target["kind"].as_str().unwrap_or_default().to_owned();
                        let id = target["id"].as_str().unwrap_or_default().to_owned();
                        if name == "comment.anchors" && kind != "entry" {
                            return Err(invalid("comment.anchors target must be an entry"));
                        }
                        if !matches!(kind.as_str(), "entry" | "asset") {
                            return Err(invalid("comment target must be an entry or asset"));
                        }
                        if kind == "asset" {
                            if obj.get("module").is_some_and(|m| !m.is_null()) {
                                return Err(invalid("an asset comment cannot specify a module"));
                            }
                            if anchored || embed_part {
                                return Err(invalid("an anchor requires entry prose"));
                            }
                            if name == "comment.create" {
                                extra_subjects.insert(format!("asset:{id}"));
                            }
                        } else {
                            if name == "comment.create"
                                && !anchored
                                && !embed_part
                                && obj.get("module").is_none_or(Value::is_null)
                            {
                                extra_subjects.insert(format!("entry:{id}"));
                            }
                            if let Some(module) = obj.get_mut("module").filter(|m| !m.is_null()) {
                                let eid =
                                    EntryId::parse(&id).map_err(|e| invalid(e.to_string()))?;
                                let entry = cx
                                    .view
                                    .entry_raw(&eid)
                                    .ok_or_else(|| invalid("entry not found"))?;
                                let allow_retained = name != "comment.create";
                                if name == "comment.anchors" || anchored || embed_part {
                                    let mid = resolve_entry_prose_module(
                                        &cx,
                                        &entry,
                                        module,
                                        allow_retained,
                                        false,
                                    )?;
                                    *module = mid.to_string().into();
                                } else {
                                    let (mid, mod_spec) = resolve_entry_module(
                                        &cx,
                                        &entry,
                                        module,
                                        allow_retained,
                                        false,
                                    )?;
                                    *module = mid.to_string().into();
                                    if name == "comment.create" {
                                        if let Some(part_obj) =
                                            obj.get_mut("part").and_then(Value::as_object_mut)
                                        {
                                            resolve_comment_part(
                                                &cx,
                                                &entry,
                                                &mid,
                                                mod_spec.as_ref(),
                                                part_obj,
                                            )?;
                                        }
                                        extra_subjects.insert(format!("module:{eid}:{mid}"));
                                    }
                                }
                            }
                        }
                    } else if obj.get("module").is_some_and(|m| !m.is_null()) {
                        return Err(invalid("a comment module requires an entry target"));
                    }
                    if anchored || (name == "comment.create" && embed_part) {
                        let target = obj
                            .get("target")
                            .ok_or_else(|| invalid("an anchor needs a target"))?;
                        let doc = comment_source_doc(target, obj.get("module"))?;
                        let doc = resolve_document_v3(&cx, &json!(doc), true, false)?;
                        extra_subjects.insert(format!("prose:{doc}"));
                        targets.insert(doc);
                    }
                }
                "comment.update" | "comment.reanchor" | "comment.delete" => {
                    if let Some(id) = obj.get_mut("id") {
                        *id = resolve_comment_id(&cx.view, id, false)?.into();
                    }
                    if name == "comment.reanchor" && obj.get("anchor").is_some_and(|a| !a.is_null())
                    {
                        let old = cx
                            .view
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
                        let doc = resolve_document_v3(&cx, &json!(doc), true, false)?;
                        extra_subjects.insert(format!("prose:{doc}"));
                        targets.insert(doc);
                    }
                    if name == "comment.update"
                        && let Some(next_status) = obj
                            .get("status")
                            .and_then(Value::as_str)
                            .map(CommentStatus::parse)
                            .filter(CommentStatus::is_known)
                        && let Some(old) = cx
                            .view
                            .comments()
                            .into_iter()
                            .find(|c| Some(c.id.as_str()) == obj["id"].as_str())
                        && old
                            .projection
                            .as_ref()
                            .is_some_and(|p| p.kind == ProjectionKind::NoteTask)
                        && next_status != old.status
                    {
                        let target = old
                            .target
                            .ok_or_else(|| invalid("a checklist comment has no prose"))?;
                        let doc = comment_source_doc(
                            &json!({"kind":target.kind.as_str(),"id":target.id}),
                            old.target_module.as_ref().map(|m| json!(m)).as_ref(),
                        )?;
                        let doc = resolve_document_v3(&cx, &json!(doc), true, true)?;
                        extra_subjects.insert(format!("prose:{doc}"));
                        targets.insert(doc);
                    }
                }
                "project_template.save" => {
                    // A template is credited to the account that exports it
                    // (v5-tracks 第 48 条), not by the Agent.
                    if obj.contains_key("credit") {
                        return Err(invalid(
                            "project_template.save takes no credit from the Agent: a template is credited to the account that exports it",
                        ));
                    }
                }
                "entry.list" => {
                    if let Some(parent) = obj.get_mut("parent")
                        && !parent.is_null()
                    {
                        let pid = resolve_entry_id(&cx, parent, None, false, EntryRole::Level)?;
                        *parent = pid.to_string().into();
                    }
                }
                "entry.mentions" => {
                    // The entry linked to; one in the trash only when the
                    // places in the trash are asked for too.
                    let include_trashed = obj.get("trashed") == Some(&Value::Bool(true));
                    if let Some(entry_val) = obj.get_mut("entry") {
                        let eid = resolve_entry_id(
                            &cx,
                            entry_val,
                            None,
                            include_trashed,
                            EntryRole::Any,
                        )?;
                        *entry_val = eid.to_string().into();
                    }
                }
                "entry.get"
                | "entry.trash"
                | "entry.restore"
                | "entry.set_level"
                | "entry.set_auto_link"
                | "entry.set_below_auto_link"
                | "module.list" => {
                    let include_trashed =
                        matches!(name, "entry.get" | "entry.trash" | "entry.restore");
                    if let Some(id_val) = obj.get_mut("id") {
                        let eid =
                            resolve_entry_id(&cx, id_val, None, include_trashed, EntryRole::Any)?;
                        *id_val = eid.to_string().into();
                    }
                }
                "entry.create" => {
                    let parent_id = if let Some(parent) = obj.get_mut("parent")
                        && !parent.is_null()
                    {
                        let pid = resolve_entry_id(&cx, parent, None, false, EntryRole::Level)?;
                        *parent = pid.to_string().into();
                        Some(pid)
                    } else {
                        None
                    };
                    let host_id = if let Some(host) = obj.get_mut("host")
                        && !host.is_null()
                    {
                        let hid = resolve_entry_id(&cx, host, None, false, EntryRole::Host)?;
                        *host = hid.to_string().into();
                        Some(hid)
                    } else {
                        None
                    };
                    let context_id = parent_id.clone().or_else(|| host_id.clone());
                    let tpl_id = if let Some(tpl_val) = obj.get_mut("template")
                        && !tpl_val.is_null()
                    {
                        let tid = resolve_template_id(&cx, tpl_val, false)?;
                        *tpl_val = tid.to_string().into();
                        Some(tid)
                    } else if context_id.is_some() {
                        resolve_level_settings(context_id.as_ref(), cx.headers(), cx.templates())
                            .default_template
                    } else {
                        None
                    };
                    if let Some(bodies_val) = obj.get_mut("bodies")
                        && !bodies_val.is_null()
                    {
                        let tid = tpl_id.as_ref().ok_or_else(|| {
                            invalid("entry creation has no resolved template for bodies")
                        })?;
                        let tpl = cx
                            .template(tid)
                            .ok_or_else(|| invalid("entry creation template not found"))?;
                        let resolved_bodies = resolve_initial_bodies(&tpl, bodies_val)?;
                        *bodies_val = Value::Object(resolved_bodies);
                    }
                    if let Some(hid) = &host_id {
                        let residence =
                            dr_model::v3::resolve_host_residence(hid, cx.headers(), cx.templates());
                        if let Some(home) = residence
                            && &home != hid
                        {
                            extra_subjects.insert(format!("entry:{home}"));
                        }
                    } else if context_id.is_some() {
                        let residence = resolve_new_entry_residence(
                            context_id.as_ref(),
                            cx.headers(),
                            cx.templates(),
                        );
                        if let Some(home) = residence
                            && Some(&home) != context_id.as_ref()
                        {
                            extra_subjects.insert(format!("entry:{home}"));
                        }
                    }
                }
                "entry.update" => {
                    let parent_hint = obj.get("parent").and_then(Value::as_str).map(str::to_owned);
                    if let Some(id_val) = obj.get_mut("id") {
                        let eid = resolve_entry_id(
                            &cx,
                            id_val,
                            parent_hint.as_deref(),
                            false,
                            EntryRole::Any,
                        )?;
                        *id_val = eid.to_string().into();
                    }
                    if let Some(tpl_val) = obj.get_mut("template")
                        && !tpl_val.is_null()
                    {
                        let tid = resolve_template_id(&cx, tpl_val, false)?;
                        *tpl_val = tid.to_string().into();
                    }
                    if let Some(ov) = obj.get_mut("overrides")
                        && let Some(ov_obj) = ov.as_object_mut()
                    {
                        resolve_settings_override(&cx, ov_obj)?;
                    }
                }
                "entry.move" => {
                    if let Some(id_val) = obj.get_mut("id") {
                        let eid = resolve_entry_id(&cx, id_val, None, false, EntryRole::Any)?;
                        *id_val = eid.to_string().into();
                    }
                    if let Some(parent_val) = obj.get_mut("parent")
                        && !parent_val.is_null()
                    {
                        let pid = resolve_entry_id(&cx, parent_val, None, false, EntryRole::Level)?;
                        *parent_val = pid.to_string().into();
                    }
                }
                "entry_template.delete" => {
                    if let Some(id_val) = obj.get_mut("id") {
                        let tid = resolve_template_id(&cx, id_val, false)?;
                        *id_val = tid.to_string().into();
                    }
                }
                "entry_template.put" => {
                    if let Some(tpl_obj) = obj.get_mut("template").and_then(Value::as_object_mut) {
                        if let Some(id_val) = tpl_obj.get_mut("id")
                            && let Some(raw) = id_val.as_str()
                            && EntryTemplateId::parse(raw).is_err()
                            && let Ok(tid) =
                                resolve_template_id(&cx, &Value::String(raw.into()), true)
                        {
                            *id_val = tid.to_string().into();
                        }
                        if let Some(settings) =
                            tpl_obj.get_mut("settings").and_then(Value::as_object_mut)
                        {
                            resolve_settings_override(&cx, settings)?;
                        }
                        if let Some(verbs) = tpl_obj.get_mut("verbs").and_then(Value::as_array_mut)
                        {
                            for v in verbs {
                                if let Some(tt) = v.get_mut("target_template")
                                    && !tt.is_null()
                                    && let Ok(tid) = resolve_template_id(&cx, tt, false)
                                {
                                    *tt = tid.to_string().into();
                                }
                            }
                        }
                    }
                }
                "entry_template.put_module" | "entry_template.remove_module" => {
                    let tid = if let Some(tpl_val) = obj.get_mut("template") {
                        let tid = resolve_template_id(&cx, tpl_val, false)?;
                        *tpl_val = tid.to_string().into();
                        Some(tid)
                    } else {
                        None
                    };
                    if name == "entry_template.remove_module"
                        && let (Some(tid), Some(mod_val)) = (tid, obj.get_mut("module"))
                        && let Some(tpl) = cx.template(&tid)
                    {
                        let mid = resolve_template_module_id(&tpl, mod_val, None)?;
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
                | "module.put_media"
                | "module.remove_media"
                | "module.set_arrangement" => {
                    let eid = {
                        let entry_val = obj
                            .get_mut("entry")
                            .ok_or_else(|| invalid("module operation needs entry"))?;
                        let eid = resolve_entry_id(&cx, entry_val, None, false, EntryRole::Any)?;
                        *entry_val = eid.to_string().into();
                        eid
                    };
                    let entry = cx
                        .view
                        .entry_raw(&eid)
                        .ok_or_else(|| invalid("entry not found"))?;
                    let is_write = name != "module.read";
                    let (mid, mod_spec) = {
                        let mod_val = obj
                            .get_mut("module")
                            .ok_or_else(|| invalid("module operation needs module"))?;
                        let (mid, spec) =
                            resolve_entry_module(&cx, &entry, mod_val, !is_write, is_write)?;
                        *mod_val = mid.to_string().into();
                        (mid, spec)
                    };
                    match name {
                        "module.set_field" => {
                            let spec =
                                mod_spec.ok_or_else(|| invalid("active fields module required"))?;
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
                                let target_entry =
                                    resolve_entry_id_filtered(&cx, val, field_id.2.as_ref())?;
                                *val = target_entry.to_string().into();
                            }
                            if field_id.1 == FieldType::Image
                                && let Some(val) = obj.get_mut("value")
                                && val.is_string()
                            {
                                let aid = resolve_asset_id(&cx.view, val, false)?;
                                *val = aid.to_string().into();
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
                            let patches = cx.view.patches_of(&eid, &mid);
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
                        "module.put_media" => {
                            let existing_items = entry.media.get(&mid).cloned().unwrap_or_default();
                            let item_obj = obj
                                .get_mut("item")
                                .and_then(Value::as_object_mut)
                                .ok_or_else(|| invalid("module.put_media needs an item object"))?;
                            resolve_media_put_item(&cx.view, item_obj, &existing_items)?;
                        }
                        "module.remove_media" => {
                            let existing_items = entry.media.get(&mid).cloned().unwrap_or_default();
                            let item_val = obj
                                .get_mut("item")
                                .ok_or_else(|| invalid("module.remove_media needs item"))?;
                            let resolved =
                                resolve_media_remove_item(&cx.view, item_val, &existing_items)?;
                            *item_val = resolved.to_string().into();
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
                            let tid = resolve_template_id(&cx, owner_val, false)?;
                            *owner_val = tid.to_string().into();
                            tid
                        };
                        let tpl = cx
                            .template(&tid)
                            .ok_or_else(|| invalid("template not found"))?;
                        let mid = {
                            let mod_val = obj
                                .get_mut("module")
                                .ok_or_else(|| invalid("prose module operation needs module"))?;
                            let mid = resolve_template_prose_module(
                                &cx, &tpl, mod_val, !is_write, is_write,
                            )?;
                            *mod_val = mid.to_string().into();
                            mid
                        };
                        DocId::parse(&format!("template:{book_id}/{tid}/{mid}"))
                            .map_err(|e| invalid(e.to_string()))?
                            .to_string()
                    } else {
                        let eid = {
                            let owner_val = obj
                                .get_mut("owner")
                                .ok_or_else(|| invalid("prose module operation needs owner"))?;
                            let eid =
                                resolve_entry_id(&cx, owner_val, None, false, EntryRole::Any)?;
                            *owner_val = eid.to_string().into();
                            eid
                        };
                        let entry = cx
                            .entry_header(&eid)
                            .ok_or_else(|| invalid("entry not found"))?;
                        let mid = {
                            let mod_val = obj
                                .get_mut("module")
                                .ok_or_else(|| invalid("prose module operation needs module"))?;
                            let mid = resolve_entry_prose_module(
                                &cx, &entry, mod_val, !is_write, is_write,
                            )?;
                            *mod_val = mid.to_string().into();
                            mid
                        };
                        DocId::Body(BodyDocId::new(eid, mid)).to_string()
                    };
                    let stored = cx
                        .lib
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
                "module.read_custom"
                | "module.set_custom_value"
                | "module.add_custom_item"
                | "module.remove_custom_item"
                | "module.move_custom_item" => {
                    let eid = {
                        let entry_val = obj
                            .get_mut("entry")
                            .ok_or_else(|| invalid("custom module operation needs entry"))?;
                        let eid = resolve_entry_id(&cx, entry_val, None, false, EntryRole::Any)?;
                        *entry_val = eid.to_string().into();
                        eid
                    };
                    let entry = cx
                        .view
                        .entry_raw(&eid)
                        .ok_or_else(|| invalid("entry not found"))?;
                    let is_write = name != "module.read_custom";
                    let spec = {
                        let mod_val = obj
                            .get_mut("module")
                            .ok_or_else(|| invalid("custom module operation needs module"))?;
                        let (mid, spec) = resolve_entry_module(&cx, &entry, mod_val, false, is_write)?;
                        *mod_val = mid.to_string().into();
                        spec.ok_or_else(|| invalid("custom module values are reached through the entry template's module"))?
                    };
                    if spec.kind != ModuleKind::Custom {
                        return Err(invalid(format!(
                            "module {:?} ({}) is a {} module, not a custom one: use module.read and its own tools",
                            spec.name,
                            spec.id,
                            spec.kind.as_str()
                        )));
                    }
                    if name == "module.set_custom_value" {
                        resolve_custom_input(&cx, &spec, obj)?;
                    }
                }
                "relation_type.list" => {
                    if let Some(entry) = obj.get_mut("entry").filter(|e| !e.is_null()) {
                        *entry = resolve_entry_id(&cx, entry, None, false, EntryRole::Any)?
                            .to_string().into();
                    }
                }
                "relation_type.rename" | "relation_type.set_description"
                | "relation_type.set_direction" | "relation_type.delete" => {
                    if let Some(id) = obj.get_mut("id") {
                        let relation = resolve_relation_type_id(&cx.view, id)?;
                        let kind = dr_model::id::RelationTypeId::parse(&relation)
                            .map_err(|e| invalid(e.to_string()))?;
                        // Renaming or deleting writes every definition a merge
                        // reads as this one (`RT-NAME`); deleting, every
                        // stored row of it, the hidden ones included.
                        if matches!(name, "relation_type.rename" | "relation_type.delete") {
                            extra_subjects.extend(relations::relation_group(&cx.view, &kind)
                                .into_iter().map(|g| format!("relation_type:{g}")));
                        }
                        if name == "relation_type.delete" {
                            extra_subjects.extend(relations::relation_stored_rows(&cx.view, &kind)
                                .into_iter().map(|r| format!("relation_row:{}", r.id)));
                        }
                        *id = relation.into();
                    }
                }
                "relation_row.create_pair" => {
                    let mut entries = Vec::with_capacity(2);
                    for key in ["left", "right"] {
                        let value = obj.get_mut(key).ok_or_else(|| invalid(format!("missing {key} entry")))?;
                        let entry = resolve_entry_id(&cx, value, None, false, EntryRole::Any)?;
                        *value = entry.to_string().into();
                        entries.push(entry);
                    }
                    if let Some(value) = obj.get_mut("relation_type").filter(|t| !t.is_null()) {
                        let id = resolve_relation_type_id(&cx.view, value)?;
                        let id = dr_model::id::RelationTypeId::parse(&id).map_err(|e| invalid(e.to_string()))?;
                        let relation = cx.view.relation_type_raw(&id)
                            .ok_or_else(|| invalid("relation type no longer exists"))?;
                        // The rows the command plans against: those that
                        // count, hidden ones included (`relation_type.list`
                        // names them in `hidden_rows`).
                        let rows = relations::relation_rows(&cx.view, &id);
                        if let dr_model::v3::PairPlacement::Add(row, _, _) =
                            dr_model::v3::plan_relation_pair(&rows, relation.direction, &entries[0], &entries[1]) {
                            extra_subjects.insert(format!("relation_row:{row}"));
                        }
                        *value = id.to_string().into();
                    }
                }
                "relation_row.create_group" => {
                    for key in ["left", "right"] {
                        let values = obj.get_mut(key).and_then(Value::as_array_mut)
                            .ok_or_else(|| invalid(format!("missing {key} entry set")))?;
                        for value in values {
                            *value = resolve_entry_id(&cx, value, None, false, EntryRole::Any)?
                                .to_string().into();
                        }
                    }
                    let value = obj.get_mut("relation_type")
                        .ok_or_else(|| invalid("missing relation type"))?;
                    *value = resolve_relation_type_id(&cx.view, value)?.into();
                }
                "relation_row.add_entry" | "relation_row.remove_entry" | "relation_row.delete" => {
                    if let Some(value) = obj.get_mut("entry") {
                        *value = resolve_entry_id(&cx, value, None, name == "relation_row.remove_entry", EntryRole::Any)?
                            .to_string().into();
                    }
                    if let Some(id) = obj.get("id").and_then(Value::as_str) {
                        let row = cx.view.relations_raw().into_iter()
                            .find(|row| row.id.as_str() == id)
                            .ok_or_else(|| invalid("relation row does not exist"))?;
                        let kind = cx.view.relation_type_winners().get(&row.relation_type)
                            .cloned().unwrap_or(row.relation_type);
                        extra_subjects.insert(format!("relation_type:{kind}"));
                        // Taking pairs out also takes them out of the other
                        // rows that hold them, and the relation with its last
                        // row: each of those has to have been read.
                        if name != "relation_row.add_entry" {
                            let entry = obj.get("entry").and_then(Value::as_str)
                                .map(|e| EntryId::parse(e).map_err(|e| invalid(e.to_string())))
                                .transpose()?;
                            if let Ok((rows, types)) =
                                relations::relation_removal_records(&cx.view, &row.id, entry.as_ref())
                            {
                                extra_subjects.extend(rows.into_iter()
                                    .filter(|r| r.as_str() != id)
                                    .map(|r| format!("relation_row:{r}")));
                                extra_subjects.extend(types.into_iter()
                                    .map(|g| format!("relation_type:{g}")));
                            }
                        }
                    }
                }
                "membership.add" | "membership.remove" => {
                    let host = {
                        let h_val = obj
                            .get_mut("host")
                            .ok_or_else(|| invalid("membership needs host"))?;
                        let hid = resolve_entry_id(&cx, h_val, None, false, EntryRole::Host)?;
                        *h_val = hid.to_string().into();
                        hid
                    };
                    let member = {
                        let m_val = obj
                            .get_mut("member")
                            .ok_or_else(|| invalid("membership needs member"))?;
                        let mid = resolve_entry_id(&cx, m_val, None, false, EntryRole::Any)?;
                        *m_val = mid.to_string().into();
                        mid
                    };
                    if name == "membership.remove" {
                        for tv in affected_views_on_membership_remove(
                            &cx.view,
                            &host,
                            &member,
                            cx.headers(),
                            cx.templates(),
                        ) {
                            extra_subjects.insert(format!("timeline_view:{tv}"));
                        }
                    }
                }
                "membership.primary" => {
                    if let Some(m_val) = obj.get_mut("member") {
                        let mid = resolve_entry_id(&cx, m_val, None, false, EntryRole::Any)?;
                        *m_val = mid.to_string().into();
                    }
                    if let Some(h_val) = obj.get_mut("host")
                        && !h_val.is_null()
                    {
                        let hid = resolve_entry_id(&cx, h_val, None, false, EntryRole::Host)?;
                        *h_val = hid.to_string().into();
                    }
                }
                "timeline_view.delete" => {
                    if let Some(id_val) = obj.get_mut("id") {
                        let vid = resolve_timeline_view_id(&cx.view, id_val)?;
                        *id_val = vid.to_string().into();
                    }
                }
                "timeline_view.put" => {
                    if let Some(v_obj) = obj.get_mut("view").and_then(Value::as_object_mut) {
                        if let Some(id_val) = v_obj.get_mut("id")
                            && let Some(raw) = id_val.as_str()
                            && !looks_like_uuid(raw)
                            && let Ok(vid) =
                                resolve_timeline_view_id(&cx.view, &Value::String(raw.into()))
                        {
                            *id_val = vid.to_string().into();
                        }
                        if let Some(lanes) = v_obj.get_mut("lanes").and_then(Value::as_array_mut) {
                            for lane in lanes {
                                if let Some(e_val) = lane.get_mut("entry") {
                                    let eid = resolve_entry_id(
                                        &cx,
                                        e_val,
                                        None,
                                        false,
                                        EntryRole::Below,
                                    )?;
                                    *e_val = eid.to_string().into();
                                }
                            }
                        }
                        if let Some(placements) =
                            v_obj.get_mut("placements").and_then(Value::as_array_mut)
                        {
                            for p in placements {
                                if let Some(e_val) = p.get_mut("entry") {
                                    let eid =
                                        resolve_entry_id(&cx, e_val, None, false, EntryRole::Any)?;
                                    *e_val = eid.to_string().into();
                                }
                            }
                        }
                        if let Some(pins) = v_obj.get_mut("pins").and_then(Value::as_array_mut) {
                            for pin in pins {
                                if let Some(e_val) = pin.get_mut("entry")
                                    && !e_val.is_null()
                                {
                                    let eid =
                                        resolve_entry_id(&cx, e_val, None, false, EntryRole::Any)?;
                                    *e_val = eid.to_string().into();
                                }
                            }
                        }
                    }
                }
                "timeline_view.place" | "timeline_view.remove" => {
                    if let Some(v_val) = obj.get_mut("view") {
                        let vid = resolve_timeline_view_id(&cx.view, v_val)?;
                        *v_val = vid.to_string().into();
                    }
                    if let Some(e_val) = obj.get_mut("entry") {
                        let eid = resolve_entry_id(&cx, e_val, None, false, EntryRole::Any)?;
                        *e_val = eid.to_string().into();
                    }
                    if let Some(l_val) = obj.get_mut("lane")
                        && !l_val.is_null()
                    {
                        let lid = resolve_entry_id(&cx, l_val, None, false, EntryRole::Below)?;
                        *l_val = lid.to_string().into();
                    }
                    if name == "timeline_view.remove"
                        && let (Some(lane_s), Some(entry_s)) =
                            (obj["lane"].as_str(), obj["entry"].as_str())
                        && let (Ok(host), Ok(member)) =
                            (EntryId::parse(lane_s), EntryId::parse(entry_s))
                    {
                        for tv in affected_views_on_membership_remove(
                            &cx.view,
                            &host,
                            &member,
                            cx.headers(),
                            cx.templates(),
                        ) {
                            extra_subjects.insert(format!("timeline_view:{tv}"));
                        }
                    }
                }
                "timeline_view.put_pin" => {
                    if let Some(v_val) = obj.get_mut("view") {
                        let vid = resolve_timeline_view_id(&cx.view, v_val)?;
                        *v_val = vid.to_string().into();
                    }
                    if let Some(pin_obj) = obj.get_mut("pin").and_then(Value::as_object_mut)
                        && let Some(e_val) = pin_obj.get_mut("entry")
                        && !e_val.is_null()
                    {
                        let eid = resolve_entry_id(&cx, e_val, None, false, EntryRole::Any)?;
                        *e_val = eid.to_string().into();
                    }
                }
                "timeline_view.remove_pin" => {
                    let vid = {
                        let v_val = obj
                            .get_mut("view")
                            .ok_or_else(|| invalid("timeline_view.remove_pin needs view"))?;
                        let vid = resolve_timeline_view_id(&cx.view, v_val)?;
                        *v_val = vid.to_string().into();
                        vid
                    };
                    if let Some(pin_val) = obj.get_mut("pin") {
                        let pid = resolve_timeline_pin_id(&cx.view, &vid, pin_val)?;
                        *pin_val = pid.into();
                    }
                }
                "tab.put" => {
                    if let Some(id_val) = obj.get_mut("id")
                        && !id_val.is_null()
                    {
                        let tid = resolve_tab_id(&cx.view, id_val)?;
                        *id_val = tid.to_string().into();
                    }
                    if let Some(mount_val) = obj.get_mut("mount")
                        && !mount_val.is_null()
                    {
                        resolve_tab_mount(&cx, mount_val)?;
                    }
                    if let Some(place_val) = obj.get_mut("place")
                        && !place_val.is_null()
                    {
                        resolve_tab_place(&cx.view, place_val)?;
                    }
                }
                "tab.remove" | "tab.move" | "tab.select" => {
                    if let Some(id_val) = obj.get_mut("id") {
                        let tid = resolve_tab_id(&cx.view, id_val)?;
                        *id_val = tid.to_string().into();
                    }
                    if name == "tab.move"
                        && let Some(place_val) = obj.get_mut("place")
                        && !place_val.is_null()
                    {
                        resolve_tab_place(&cx.view, place_val)?;
                    }
                }
                "asset.get"
                | "asset.read_content"
                | "asset.rename"
                | "asset.move"
                | "asset.trash"
                | "asset.restore" => {
                    let include_trashed = matches!(
                        name,
                        "asset.get" | "asset.read_content" | "asset.trash" | "asset.restore"
                    );
                    if let Some(id_val) = obj.get_mut("id") {
                        let aid = resolve_asset_id(&cx.view, id_val, include_trashed)?;
                        *id_val = aid.to_string().into();
                    }
                    if name == "asset.move"
                        && let Some(folder_val) = obj.get_mut("folder")
                        && !folder_val.is_null()
                    {
                        let fid = resolve_asset_folder_id(&cx.view, folder_val, false)?;
                        *folder_val = fid.to_string().into();
                        extra_subjects.insert(format!("asset_folder:{fid}"));
                    }
                }
                "asset_folder.create" => {
                    if let Some(parent_val) = obj.get_mut("parent")
                        && !parent_val.is_null()
                    {
                        let pid = resolve_asset_folder_id(&cx.view, parent_val, false)?;
                        *parent_val = pid.to_string().into();
                    }
                }
                "asset_folder.rename"
                | "asset_folder.move"
                | "asset_folder.trash"
                | "asset_folder.restore" => {
                    let include_trashed =
                        matches!(name, "asset_folder.trash" | "asset_folder.restore");
                    let resolved_fid = if let Some(id_val) = obj.get_mut("id") {
                        let fid = resolve_asset_folder_id(&cx.view, id_val, include_trashed)?;
                        *id_val = fid.to_string().into();
                        Some(fid)
                    } else {
                        None
                    };
                    if name == "asset_folder.move"
                        && let Some(parent_val) = obj.get_mut("parent")
                        && !parent_val.is_null()
                    {
                        let pid = resolve_asset_folder_id(&cx.view, parent_val, false)?;
                        *parent_val = pid.to_string().into();
                        extra_subjects.insert(format!("asset_folder:{pid}"));
                    }
                    if let Some(fid) = resolved_fid {
                        if name == "asset_folder.trash" {
                            let (folders, files) = asset_folder_subtree(&cx.view, &fid);
                            for f in folders.into_iter().filter(|f| !f.is_trashed()) {
                                extra_subjects.insert(format!("asset_folder:{}", f.id));
                            }
                            for a in files.into_iter().filter(|a| !a.is_trashed()) {
                                extra_subjects.insert(format!("asset:{}", a.id));
                            }
                        } else if name == "asset_folder.restore"
                            && let Some(have) = cx.view.asset_folder_raw(&fid)
                            && have.is_trashed()
                        {
                            let group = have.trashed_with.unwrap_or_else(|| fid.clone());
                            let (folders, files) = asset_folder_subtree(&cx.view, &fid);
                            for f in folders
                                .into_iter()
                                .filter(|f| f.id == fid || f.trashed_with.as_ref() == Some(&group))
                            {
                                extra_subjects.insert(format!("asset_folder:{}", f.id));
                            }
                            for a in files.into_iter().filter(|a| {
                                a.is_trashed() && a.trashed_with.as_ref() == Some(&group)
                            }) {
                                extra_subjects.insert(format!("asset:{}", a.id));
                            }
                        }
                    }
                }
                "layout.get" | "layout.put" | "layout.clear" => {
                    if let Some(scope_val) = obj.get_mut("scope") {
                        let raw = string(scope_val, "scope")?.trim();
                        if raw != "root" {
                            if name == "layout.put" {
                                let eid =
                                    resolve_entry_id(&cx, scope_val, None, false, EntryRole::Any)?;
                                *scope_val = eid.to_string().into();
                            } else if let Ok(eid) =
                                resolve_entry_id(&cx, scope_val, None, true, EntryRole::Any)
                            {
                                *scope_val = eid.to_string().into();
                            }
                        } else {
                            *scope_val = "root".into();
                        }
                    }
                    if name == "layout.put"
                        && let Some(pos_map) =
                            obj.get_mut("positions").and_then(Value::as_object_mut)
                    {
                        let mut resolved_positions = Map::new();
                        for (raw_key, pt_val) in std::mem::take(pos_map) {
                            let eid = resolve_entry_id(
                                &cx,
                                &Value::String(raw_key),
                                None,
                                false,
                                EntryRole::Any,
                            )?;
                            if resolved_positions.insert(eid.to_string(), pt_val).is_some() {
                                return Err(invalid(format!(
                                    "duplicate layout position for entry {eid}"
                                )));
                            }
                        }
                        *pos_map = resolved_positions;
                    }
                    if name == "layout.clear"
                        && let Some(entries_arr) =
                            obj.get_mut("entries").and_then(Value::as_array_mut)
                    {
                        for item in entries_arr {
                            if let Ok(eid) = resolve_entry_id(&cx, item, None, true, EntryRole::Any)
                            {
                                *item = eid.to_string().into();
                            }
                        }
                    }
                }
                "entry_history.restore" => {
                    if let Some(targets_arr) = obj.get_mut("targets").and_then(Value::as_array_mut)
                    {
                        for item in targets_arr {
                            let collection = item
                                .get("collection")
                                .and_then(Value::as_str)
                                .ok_or_else(|| invalid("restore target needs collection"))?
                                .to_owned();
                            let id_val = item
                                .get_mut("id")
                                .ok_or_else(|| invalid("restore target needs id"))?;
                            let raw = string(id_val, "id")?.to_owned();
                            match collection.as_str() {
                                "entries" => {
                                    if !dr_model::id::is_uuid_v7(&raw)
                                        && EntryId::parse(&raw)
                                            .ok()
                                            .is_none_or(|id| !cx.headers().contains_key(&id))
                                        && let Ok(eid) = resolve_entry_id(
                                            &cx,
                                            id_val,
                                            None,
                                            true,
                                            EntryRole::Any,
                                        )
                                    {
                                        *id_val = eid.to_string().into();
                                    }
                                }
                                "templates" => {
                                    if !dr_model::id::is_uuid_v7(&raw)
                                        && EntryTemplateId::parse(&raw)
                                            .ok()
                                            .is_none_or(|id| !cx.templates().contains_key(&id))
                                        && let Ok(tid) = resolve_template_id(&cx, id_val, true)
                                    {
                                        *id_val = tid.to_string().into();
                                    }
                                }
                                "timeline_views" => {
                                    if !dr_model::id::is_uuid_v7(&raw)
                                        && !cx
                                            .view
                                            .timeline_views_raw()
                                            .iter()
                                            .any(|v| v.id.as_str() == raw)
                                        && let Ok(vid) = resolve_timeline_view_id(&cx.view, id_val)
                                    {
                                        *id_val = vid.to_string().into();
                                    }
                                }
                                "relation_types" => {
                                    if !dr_model::id::is_uuid_v7(&raw)
                                        && !cx
                                            .view
                                            .relation_types()
                                            .iter()
                                            .any(|t| t.id.as_str() == raw)
                                        && let Ok(rtid) = resolve_relation_type_id(&cx.view, id_val)
                                    {
                                        *id_val = rtid.into();
                                    }
                                }
                                "comments" => {
                                    if !dr_model::id::is_uuid_v7(&raw)
                                        && !cx.view.comments().iter().any(|c| c.id.as_str() == raw)
                                        && let Ok(cid) = resolve_comment_id(&cx.view, id_val, true)
                                    {
                                        *id_val = cid.into();
                                    }
                                }
                                "assets" => {
                                    if !dr_model::id::is_uuid_v7(&raw)
                                        && !cx
                                            .view
                                            .assets_raw()
                                            .iter()
                                            .any(|a| a.id.as_str() == raw)
                                        && let Ok(aid) = resolve_asset_id(&cx.view, id_val, true)
                                    {
                                        *id_val = aid.to_string().into();
                                    }
                                }
                                "asset_folders" => {
                                    if !dr_model::id::is_uuid_v7(&raw)
                                        && !cx
                                            .view
                                            .asset_folders_raw()
                                            .iter()
                                            .any(|f| f.id.as_str() == raw)
                                        && let Ok(fid) =
                                            resolve_asset_folder_id(&cx.view, id_val, true)
                                    {
                                        *id_val = fid.to_string().into();
                                    }
                                }
                                "project" => {
                                    if let Some(tab_raw) = raw.strip_prefix("tabs/")
                                        && !dr_model::id::is_uuid_v7(tab_raw)
                                        && !cx
                                            .view
                                            .project()
                                            .tabs
                                            .iter()
                                            .any(|t| t.id.as_str() == tab_raw)
                                        && let Ok(tid) = resolve_tab_id(
                                            &cx.view,
                                            &Value::String(tab_raw.to_owned()),
                                        )
                                    {
                                        *id_val = format!("tabs/{tid}").into();
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                }
                _ => {}
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
        })())
    })?
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
        _ => Err(invalid("an anchor requires entry prose")),
    }
}

fn resolve_action(
    ws: &Workspace,
    book: &BookId,
    existing_catalog: Option<&Catalog>,
    name: &str,
    args: Value,
) -> Result<ResolvedCall> {
    let reference = ActionRef::parse_canonical(name)
        .ok_or_else(|| invalid("invalid template action reference"))?;
    if reference.book != book.as_str() {
        return Err(invalid("template action belongs to another book"));
    }
    let owned_catalog;
    let catalog = match existing_catalog {
        Some(c) => c,
        None => {
            owned_catalog = Catalog::for_book(ws, book)?;
            &owned_catalog
        }
    };
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
        .ok_or_else(|| invalid("template action requires a non-empty `title`"))?
        .to_owned();

    let target_tpl_id = EntryTemplateId::parse(&binding.target_template)
        .map_err(|_| invalid("invalid target template id"))?;
    let bodies_opt = obj.get("bodies").filter(|v| !v.is_null()).cloned();
    let book_id = book.clone();
    let resolved_bodies = ws.read_book_v3(book.as_str(), move |doc, _| {
        Ok((|| -> Result<Option<Map<String, Value>>> {
            let borrowed = BorrowedBookV3::new(doc, &book_id)
                .map_err(|e| invalid(format!("invalid book {book_id}: {e}")))?;
            let view = borrowed.view();
            let target_tpl = view
                .template(&target_tpl_id)
                .filter(|t| !t.is_trashed())
                .ok_or_else(|| invalid("action target template is missing or trashed"))?;
            match bodies_opt {
                Some(bodies_val) => Ok(Some(resolve_initial_bodies(&target_tpl, &bodies_val)?)),
                None => Ok(None),
            }
        })())
    })??;

    let mut create_args = json!({
        "book": book.as_str(),
        "template": binding.target_template,
        "title": title,
    });
    if !binding.adds_membership {
        create_args["parent"] = json!(binding.reference.level);
    } else {
        create_args["host"] = json!(binding.reference.level);
    }
    if let Some(resolved_bodies) = resolved_bodies {
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
    let output = output.get("output").unwrap_or(output);
    let mut read = BTreeSet::new();
    match name {
        "project.get" => {
            if let Some(book) = args["book"].as_str() {
                read.insert(format!("project:{book}"));
            }
            read.insert("tab:*".into());
            for row in output["tabs"].as_array().into_iter().flatten() {
                if let Some(id) = row["id"].as_str() {
                    read.insert(format!("tab:{id}"));
                }
            }
        }
        "book.sequence" => return Some(Vec::new()),
        // Snippets from the derived index are not a read of any entry,
        // module or prose (k6-agent-tools.md: search grants no coverage).
        "entry.search" | "entry.mentions" => return Some(Vec::new()),
        "layout.get" => {
            if let (Some(scope), Some(mode)) = (args["scope"].as_str(), args["mode"].as_str()) {
                read.insert(format!("layout:{scope}/{mode}"));
            }
        }
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
        // The entry's values of one custom module and the copy they read
        // as; not the rest of the entry.
        "module.read_custom" => {
            if let (Some(entry), Some(mid)) = (args["entry"].as_str(), args["module"].as_str()) {
                read.insert(format!("module_custom:{entry}:{mid}"));
            }
        }
        // A module of mine is a library document: the read a change to it is
        // held to (the executor keeps what it showed).
        "custom_module.get" => {
            if let Some(id) = output["summary"]["id"].as_str() {
                read.insert(format!("custom_module:{id}"));
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
        "relation_type.list" => {
            if args.get("entry").is_none_or(Value::is_null) {
                read.insert("relation_type:*".into());
            }
            for relation in output.as_array().into_iter().flatten() {
                if let Some(id) = relation["id"].as_str() {
                    read.insert(format!("relation_type:{id}"));
                }
                for row in relation["rows"].as_array().into_iter().flatten() {
                    if let Some(id) = row["id"].as_str() {
                        read.insert(format!("relation_row:{id}"));
                    }
                }
                // A row not shown was still seen to be there: a write that
                // lands in or removes it is held to it as it is now.
                for id in relation["hidden_rows"].as_array().into_iter().flatten() {
                    if let Some(id) = id.as_str() {
                        read.insert(format!("relation_row:{id}"));
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
        "project_template.get" => {
            if let Some(id) = output["summary"]["id"].as_str() {
                read.insert(format!("project_template:{id}"));
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
        "project.update" => {
            if let Some(book) = args.get("book").and_then(Value::as_str) {
                subjects.insert(format!("project:{book}"));
                if args.get("name").is_some_and(|v| !v.is_null())
                    || args.get("summary").is_some_and(|v| !v.is_null())
                {
                    subjects.insert(format!("book:{book}"));
                }
            }
        }
        "tab.put" => {
            if let Some(id) = args.get("id").and_then(Value::as_str) {
                subjects.insert(format!("tab:{id}"));
            } else {
                subjects.insert("tab:*".into());
            }
        }
        "tab.remove" | "tab.move" => {
            if let Some(id) = args.get("id").and_then(Value::as_str) {
                subjects.insert(format!("tab:{id}"));
            }
        }
        "layout.put" | "layout.clear" => {
            if let (Some(scope), Some(mode)) = (
                args.get("scope").and_then(Value::as_str),
                args.get("mode").and_then(Value::as_str),
            ) {
                subjects.insert(format!("layout:{scope}/{mode}"));
            }
        }
        "entry.create" => {
            if let Some(parent) = args.get("parent").and_then(Value::as_str) {
                subjects.insert(format!("entry:{parent}"));
            } else if let Some(host) = args.get("host").and_then(Value::as_str) {
                subjects.insert(format!("entry:{host}"));
            } else {
                subjects.insert("entry:*".into());
            }
        }
        "entry.update"
        | "entry.trash"
        | "entry.restore"
        | "entry.set_level"
        | "entry.set_auto_link" => {
            if let Some(id) = args.get("id").and_then(Value::as_str) {
                subjects.insert(format!("entry:{id}"));
            }
        }
        // A level's 「自动链接」 sets the switch of what lives below it too.
        "entry.set_below_auto_link" => {
            if let Some(id) = args.get("id").and_then(Value::as_str) {
                subjects.insert(format!("entry:{id}"));
            }
            subjects.insert("entry:*".into());
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
        "module.set_field"
        | "module.put_kv"
        | "module.remove_kv"
        | "module.put_media"
        | "module.remove_media"
        | "module.set_arrangement" => {
            if let (Some(entry), Some(mid)) = (
                args.get("entry").and_then(Value::as_str),
                args.get("module").and_then(Value::as_str),
            ) {
                subjects.insert(format!("module_inline:{entry}:{mid}"));
            }
        }
        "module.put_patch" | "module.remove_patch" | "module.put_grid" => {
            if let (Some(entry), Some(mid)) = (
                args.get("entry").and_then(Value::as_str),
                args.get("module").and_then(Value::as_str),
            ) {
                subjects.insert(format!("module:{entry}:{mid}"));
            }
        }
        // An entry's custom module is read whole (`module.read_custom`): its
        // values and the copy they are written against. A list of the
        // entry's modules is not a read of it.
        "module.set_custom_value"
        | "module.add_custom_item"
        | "module.remove_custom_item"
        | "module.move_custom_item" => {
            if let (Some(entry), Some(mid)) = (
                args.get("entry").and_then(Value::as_str),
                args.get("module").and_then(Value::as_str),
            ) {
                subjects.insert(format!("module_custom:{entry}:{mid}"));
            }
        }
        "module.set_prose" | "module.replace_prose" => {
            if name == "module.replace_prose"
                && let Some(doc) = prose_doc_from_module_args(args)
            {
                subjects.insert(format!("prose:{doc}"));
            }
        }
        "relation_type.create" => {
            subjects.insert("relation_type:*".into());
        }
        "relation_type.rename"
        | "relation_type.set_description"
        | "relation_type.set_direction"
        | "relation_type.delete" => {
            if let Some(id) = args["id"].as_str() {
                subjects.insert(format!("relation_type:{id}"));
            }
        }
        "relation_row.create_pair" => {
            if let Some(id) = args["relation_type"].as_str() {
                subjects.insert(format!("relation_type:{id}"));
            } else {
                subjects.insert("relation_type:*".into());
            }
            for key in ["left", "right"] {
                if let Some(entry) = args[key].as_str() {
                    subjects.insert(format!("entry:{entry}"));
                }
            }
        }
        "relation_row.create_group" => {
            if let Some(id) = args["relation_type"].as_str() {
                subjects.insert(format!("relation_type:{id}"));
            }
            for key in ["left", "right"] {
                for entry in args[key]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                {
                    subjects.insert(format!("entry:{entry}"));
                }
            }
        }
        "relation_row.add_entry" | "relation_row.remove_entry" | "relation_row.delete" => {
            if let Some(id) = args["id"].as_str() {
                subjects.insert(format!("relation_row:{id}"));
            }
            if name == "relation_row.add_entry"
                && let Some(entry) = args["entry"].as_str()
            {
                subjects.insert(format!("entry:{entry}"));
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
            let book = args.get("book").and_then(Value::as_str);
            if let Some(book) = book {
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
                                subjects.insert(format!("relation_type:{id}"));
                            }
                            "comments" => {
                                subjects.insert(format!("comment:{id}"));
                            }
                            "assets" => {
                                subjects.insert(format!("asset:{id}"));
                            }
                            "asset_folders" => {
                                subjects.insert(format!("asset_folder:{id}"));
                            }
                            "relations" => {
                                subjects.insert(format!("relation_row:{id}"));
                            }
                            "patches" => {
                                subjects.insert(format!("patch:{id}"));
                            }
                            "plot_grids" => {
                                subjects.insert(format!("plot_grid:{id}"));
                            }
                            "project" => {
                                if let Some(tid) = id.strip_prefix("tabs/") {
                                    subjects.insert(format!("tab:{tid}"));
                                } else if let Some(book) = book {
                                    subjects.insert(format!("project:{book}"));
                                }
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

/// A module given to `custom_module.create`, `update` or `save_as`, through
/// the one validator (`dr_model::custom_module::parse_module_json`), before
/// anything is written. A refusal is the validator's own words, which name
/// the block or the look node (`look.block.item.kids[1]`) and the rule; when
/// the JSON itself does not fit the closed format, the part that does not is
/// named by its path.
fn check_module_value(value: &Value) -> Result<()> {
    use dr_model::custom_module::{ModuleError, parse_module_json};
    let raw = serde_json::to_string(value).map_err(|e| invalid(e.to_string()))?;
    match parse_module_json(&raw) {
        Ok(_) => Ok(()),
        Err(ModuleError::MalformedJson(message)) => Err(invalid(match locate_malformed(value) {
            Some((at, why)) => format!("the module was refused at {at}: {why}"),
            None => format!("the module was refused: {}", without_position(&message)),
        })),
        Err(e) => Err(invalid(format!("the module was refused: {e}"))),
    }
}

/// serde_json's ` at line 1 column N` points into a compact copy the model
/// never saw.
fn without_position(message: &str) -> &str {
    message
        .rfind(" at line ")
        .map_or(message, |at| &message[..at])
}

/// The deepest part of a module's JSON that its own type refuses, and why:
/// a block (`blocks[0].blocks[2]`), a look node (`look.line.kids[0]`), the
/// look, the words for the Agent, the credit or the sample. Only locates:
/// the types are the validator's, nothing here is a rule of its own.
fn locate_malformed(value: &Value) -> Option<(String, String)> {
    use dr_model::custom_module::{Block, Look, ModuleAgent, ModuleCredit, Node, SampleValue};
    fn fails<T: serde::de::DeserializeOwned>(v: &Value) -> Option<String> {
        serde_json::from_value::<T>(v.clone())
            .err()
            .map(|e| e.to_string())
    }
    fn block(b: &Value, at: String) -> Option<(String, String)> {
        for (i, kid) in b["blocks"].as_array().into_iter().flatten().enumerate() {
            if let Some(found) = block(kid, format!("{at}.blocks[{i}]")) {
                return Some(found);
            }
        }
        fails::<Block>(b).map(|why| (at, why))
    }
    fn node(n: &Value, at: String) -> Option<(String, String)> {
        for (i, kid) in n["kids"].as_array().into_iter().flatten().enumerate() {
            if let Some(found) = node(kid, format!("{at}.kids[{i}]")) {
                return Some(found);
            }
        }
        if let Some(item) = n.get("item")
            && let Some(found) = node(item, format!("{at}.item"))
        {
            return Some(found);
        }
        fails::<Node>(n).map(|why| (at, why))
    }
    let obj = value.as_object()?;
    for (i, b) in obj
        .get("blocks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        if let Some(found) = block(b, format!("blocks[{i}]")) {
            return Some(found);
        }
    }
    if let Some(look) = obj.get("look") {
        for size in ["block", "line", "full"] {
            if let Some(n) = look.get(size).filter(|n| !n.is_null())
                && let Some(found) = node(n, format!("look.{size}"))
            {
                return Some(found);
            }
        }
        if let Some(why) = fails::<Look>(look) {
            return Some(("look".into(), why));
        }
    }
    [
        ("agent", obj.get("agent").and_then(fails::<ModuleAgent>)),
        ("credit", obj.get("credit").and_then(fails::<ModuleCredit>)),
        (
            "sample",
            obj.get("sample")
                .and_then(fails::<BTreeMap<String, SampleValue>>),
        ),
    ]
    .into_iter()
    .find_map(|(at, why)| why.map(|why| (at.to_owned(), why)))
}

/// The value given to `module.set_custom_value` for an entry or an image
/// block, named the way the facade takes names elsewhere: entries by id or
/// exact title or alias (one name or a list), a file by id or exact name.
/// Other kinds, and what does not resolve to a block, go to the command as
/// they are; it checks every value against the block's kind.
fn resolve_custom_input(
    cx: &ResolveCtx<'_>,
    spec: &ModuleSpec,
    obj: &mut Map<String, Value>,
) -> Result<()> {
    use dr_model::custom_module::BlockKind;
    let Some(copy) = spec
        .config
        .module
        .as_ref()
        .and_then(|id| cx.view.module_copy(id))
    else {
        return Ok(());
    };
    let Some(kind) = copy.module().and_then(|module| {
        obj.get("block")
            .and_then(Value::as_str)
            .and_then(|b| module.block(b))
            .map(|b| b.kind)
    }) else {
        return Ok(());
    };
    let Some(value) = obj.get_mut("value") else {
        return Ok(());
    };
    match kind {
        BlockKind::Entry => {
            let given: Vec<Value> = match value {
                Value::String(_) => vec![value.clone()],
                Value::Array(items) if items.iter().all(Value::is_string) => items.clone(),
                _ => return Ok(()),
            };
            let mut ids = Vec::with_capacity(given.len());
            for item in &given {
                ids.push(Value::String(
                    resolve_entry_id(cx, item, None, false, EntryRole::Any)?.to_string(),
                ));
            }
            *value = Value::Array(ids);
        }
        BlockKind::Image if value.is_string() => {
            *value = resolve_asset_id(&cx.view, value, false)?.to_string().into();
        }
        _ => {}
    }
    Ok(())
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

fn resolve_settings_override(cx: &ResolveCtx<'_>, ov_obj: &mut Map<String, Value>) -> Result<()> {
    if let Some(dt) = ov_obj.get_mut("default_template")
        && !dt.is_null()
    {
        let tid = resolve_template_id(cx, dt, false)?;
        *dt = tid.to_string().into();
    }
    if let Some(home) = ov_obj.get_mut("home")
        && !home.is_null()
    {
        let hid = resolve_entry_id(cx, home, None, false, EntryRole::Level)?;
        *home = hid.to_string().into();
    }
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum EntryRole {
    Any,
    Level,
    Host,
    Below,
}

impl EntryRole {
    fn check(self, entry: &Entry, templates: &BTreeMap<EntryTemplateId, EntryTemplate>) -> bool {
        match self {
            Self::Any => true,
            Self::Level => entry.is_level(),
            Self::Host => entry.accepts_members(templates),
            Self::Below => entry.has_below(templates),
        }
    }

    fn reject_message(self, trimmed: &str) -> String {
        match self {
            Self::Any => unreachable!(),
            Self::Level => format!("entry {trimmed:?} has its switch off: nothing lives under it"),
            Self::Host => format!("entry {trimmed:?} does not accept entries from elsewhere"),
            Self::Below => {
                format!("entry {trimmed:?} has neither level nor accept enabled")
            }
        }
    }
}

fn resolve_entry_id(
    cx: &ResolveCtx<'_>,
    value: &Value,
    parent_hint: Option<&str>,
    include_trashed: bool,
    role: EntryRole,
) -> Result<EntryId> {
    let raw = string(value, "entry")?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(invalid("entry name or id is empty"));
    }
    let parent_id = match parent_hint {
        Some(p) if !p.trim().is_empty() => Some(resolve_entry_id(
            cx,
            &Value::String(p.into()),
            None,
            include_trashed,
            EntryRole::Level,
        )?),
        _ => None,
    };
    let templates = cx.templates();
    if let Ok(id) = EntryId::parse(trimmed)
        && let Some(entry) = cx.entry_header(&id)
        && (include_trashed || !entry.is_trashed())
    {
        if !role.check(&entry, templates) {
            return Err(invalid(role.reject_message(trimmed)));
        }
        return Ok(id);
    }
    let entries = cx.headers();
    let key = trimmed.to_lowercase();
    let matches: Vec<&Entry> = entries
        .values()
        .filter(|e| include_trashed || !e.is_trashed())
        .filter(|e| role.check(e, templates))
        .filter(|e| {
            parent_id
                .as_ref()
                .is_none_or(|p| effective_parent_id(e, entries).as_ref() == Some(p))
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
    cx: &ResolveCtx<'_>,
    value: &Value,
    target_template: Option<&EntryTemplateId>,
) -> Result<EntryId> {
    let raw = string(value, "entry reference")?;
    let trimmed = raw.trim();
    if let Ok(id) = EntryId::parse(trimmed)
        && let Some(e) = cx.entry_header(&id).filter(|e| !e.is_trashed())
    {
        if target_template.is_some_and(|t| e.template.as_ref() != Some(t)) {
            return Err(invalid(
                "referenced entry does not match field target_template",
            ));
        }
        return Ok(id);
    }
    let entries = cx.headers();
    let templates = cx.templates();
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
        [] => Err(invalid(format!(
            "referenced entry {trimmed:?} was not found"
        ))),
        _ => Err(invalid(format!(
            "referenced entry {trimmed:?} is ambiguous; use its entry id"
        ))),
    }
}

fn resolve_template_id(
    cx: &ResolveCtx<'_>,
    value: &Value,
    include_trashed: bool,
) -> Result<EntryTemplateId> {
    let raw = string(value, "template")?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(invalid("template name or id is empty"));
    }
    if let Ok(id) = EntryTemplateId::parse(trimmed)
        && let Some(tpl) = cx.template(&id)
        && (include_trashed || !tpl.is_trashed())
    {
        return Ok(id);
    }
    let templates = cx.templates();
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

fn resolve_entry_module(
    cx: &ResolveCtx<'_>,
    entry: &Entry,
    value: &Value,
    allow_retained: bool,
    require_writable: bool,
) -> Result<(ModuleId, Option<ModuleSpec>)> {
    let raw = string(value, "module")?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(invalid("module name or id is empty"));
    }
    let active_tpl = cx.active_template(entry);
    let active_modules = active_tpl
        .as_deref()
        .map(|t| t.modules.as_slice())
        .unwrap_or(&[]);

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
        if has_retained_module(cx, entry, &mid)? {
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

fn resolve_entry_prose_module(
    cx: &ResolveCtx<'_>,
    entry: &Entry,
    value: &Value,
    allow_retained: bool,
    require_writable: bool,
) -> Result<ModuleId> {
    let raw = string(value, "module")?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(invalid("prose module name or id is empty"));
    }
    let active_tpl = cx.active_template(entry);
    let prose_modules: Vec<&ModuleSpec> = active_tpl
        .as_deref()
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
        if has_retained_prose_doc(cx, &entry.id, &mid)? {
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
        [] => Err(invalid(format!(
            "prose module {trimmed:?} was not found on entry {:?}",
            entry.title
        ))),
        _ => Err(invalid(format!(
            "prose module {trimmed:?} on entry {:?} is ambiguous; specify its module id",
            entry.title
        ))),
    }
}

fn resolve_template_prose_module(
    cx: &ResolveCtx<'_>,
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
        let doc = format!("template:{}/{}/{mid}", cx.book, tpl.id);
        let retained = cx
            .lib
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

fn has_retained_module(cx: &ResolveCtx<'_>, entry: &Entry, mid: &ModuleId) -> Result<bool> {
    if entry.fields.contains_key(mid)
        || entry.kv.contains_key(mid)
        || entry.media.contains_key(mid)
        || entry.arrangements.contains_key(mid)
        || cx
            .view
            .patches()
            .iter()
            .any(|p| p.entry == entry.id && &p.module == mid)
        || cx
            .view
            .plot_grids()
            .iter()
            .any(|g| g.entry == entry.id && &g.module == mid)
    {
        return Ok(true);
    }
    has_retained_prose_doc(cx, &entry.id, mid)
}

fn has_retained_prose_doc(cx: &ResolveCtx<'_>, entry: &EntryId, mid: &ModuleId) -> Result<bool> {
    let doc = DocId::Body(BodyDocId::new(entry.clone(), mid.clone())).to_string();
    Ok(cx
        .lib
        .doc_info(&doc)
        .map_err(dr_agent::Error::from)?
        .is_some_and(|info| info.book_id.as_deref() == Some(cx.book.as_str())))
}

fn resolve_document_v3(
    cx: &ResolveCtx<'_>,
    value: &Value,
    prose_only: bool,
    require_writable: bool,
) -> Result<String> {
    let doc = if let Some(raw) = value.as_str() {
        let parsed = DocId::parse(raw)
            .map_err(|_| invalid("a document needs its id or an entry/template selector"))?;
        if let DocId::Body(body) = &parsed {
            let entry = cx
                .entry_header(body.entry())
                .filter(|e| !e.is_trashed())
                .ok_or_else(|| invalid("prose document entry is missing or trashed"))?;
            let _ = resolve_entry_prose_module(
                cx,
                &entry,
                &Value::String(body.module().to_string()),
                true,
                require_writable,
            )?;
        } else if let DocId::Template(tdoc) = &parsed
            && let Some((doc_book, tid, mid)) = tdoc.entry_module()
        {
            if &doc_book != cx.book {
                return Err(invalid("document belongs to another book"));
            }
            let tpl = cx
                .template(&tid)
                .filter(|t| !t.is_trashed())
                .ok_or_else(|| invalid("template is missing or trashed"))?;
            let _ = resolve_template_prose_module(
                cx,
                &tpl,
                &Value::String(mid.to_string()),
                true,
                require_writable,
            )?;
        }
        parsed
    } else if let Some(obj) = value.as_object() {
        let kind = obj.get("kind").and_then(Value::as_str);
        if kind == Some("material") || obj.contains_key("material") {
            return Err(invalid("material documents are retired; select an entry"));
        } else if kind == Some("template")
            || (obj.contains_key("template") && !obj.contains_key("entry"))
        {
            let tpl_selector = obj
                .get("template")
                .or_else(|| obj.get("name"))
                .or_else(|| obj.get("id"))
                .ok_or_else(|| invalid("template document selector needs template"))?;
            let tid = resolve_template_id(cx, tpl_selector, false)?;
            let tpl = cx.template(&tid).expect("resolved template");
            let mod_val = obj
                .get("module")
                .ok_or_else(|| invalid("template document selector needs module"))?;
            let mid = resolve_template_prose_module(cx, &tpl, mod_val, true, require_writable)?;
            DocId::parse(&format!("template:{}/{tid}/{mid}", cx.book))
                .map_err(|_| invalid("invalid template prose document"))?
        } else {
            let entry_selector = obj
                .get("entry")
                .or_else(|| obj.get("name"))
                .or_else(|| obj.get("id"))
                .ok_or_else(|| invalid("entry document selector needs entry, name, or id"))?;
            let parent_hint = obj.get("parent").and_then(Value::as_str);
            let eid = resolve_entry_id(cx, entry_selector, parent_hint, false, EntryRole::Any)?;
            let entry = cx.entry_header(&eid).expect("resolved entry");
            let mid = if let Some(mod_val) = obj.get("module").filter(|v| !v.is_null()) {
                resolve_entry_prose_module(cx, &entry, mod_val, true, require_writable)?
            } else {
                default_single_prose_module(cx, &entry, require_writable)?
            };
            DocId::Body(BodyDocId::new(eid, mid))
        }
    } else {
        return Err(invalid("document selector must be a string or object"));
    };

    if matches!(
        doc,
        DocId::Conversation(_)
            | DocId::Stats(_)
            | DocId::Checkpoints(_)
            | DocId::Layout(_)
            | DocId::Material(_)
    ) || (prose_only && doc.profile().is_none())
    {
        return Err(invalid("target is not an authored prose document"));
    }
    let id = doc.to_string();
    let info = cx
        .lib
        .doc_info(&id)
        .map_err(dr_agent::Error::from)?
        .ok_or_else(|| invalid("document is not stored"))?;
    if info.book_id.as_deref() != Some(cx.book.as_str()) {
        return Err(invalid("document belongs to another book"));
    }
    Ok(id)
}

fn default_single_prose_module(
    cx: &ResolveCtx<'_>,
    entry: &Entry,
    require_writable: bool,
) -> Result<ModuleId> {
    let active_tpl = cx.active_template(entry);
    let prose_mods: Vec<&ModuleSpec> = active_tpl
        .as_deref()
        .into_iter()
        .flat_map(|t| t.modules.iter())
        .filter(|m| m.kind == ModuleKind::Prose)
        .collect();
    let mut retained_prose = Vec::new();
    for info in cx
        .lib
        .docs(Some(cx.book.as_str()), None)
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
    cx: &ResolveCtx<'_>,
    value: &mut Value,
    include_trashed: bool,
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
                let tid = resolve_template_id(cx, &Value::String(tpl_s.into()), false)?;
                resolve_entry_id_filtered(cx, name_or_id, Some(&tid))?
            } else {
                resolve_entry_id(cx, name_or_id, parent_hint, include_trashed, EntryRole::Any)?
            };
            ("entry", eid.to_string())
        }
        "comment" => (
            "comment",
            resolve_comment_id(&cx.view, name_or_id, include_trashed)?,
        ),
        "patch" => {
            let patches = cx.view.patches();
            (
                "patch",
                resolve_patch_id(&patches, string(name_or_id, "patch")?)?,
            )
        }
        "asset" => (
            "asset",
            resolve_asset_id(&cx.view, name_or_id, include_trashed)?.to_string(),
        ),
        other => {
            return Err(invalid(format!(
                "unsupported endpoint kind {other:?}; use entry, comment, patch, or asset"
            )));
        }
    };
    *value = json!({"kind": canonical_kind, "id": resolved_id});
    Ok(())
}

fn resolve_history_session(
    cx: &ResolveCtx<'_>,
    session: &str,
    turn: Option<&Value>,
    targets: &mut BTreeSet<String>,
) -> Result<()> {
    let lib = cx.lib;
    if let Some(run) = lib.agent_session(session).map_err(dr_agent::Error::from)?
        && run.book_id != cx.book.as_str()
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
        if !cx.view.owns_prose(&doc)
            && lib
                .doc_info(&row.doc_id)
                .map_err(dr_agent::Error::from)?
                .is_none_or(|info| info.book_id.as_deref() != Some(cx.book.as_str()))
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
    // An id is read as the relation it merges into; a name is looked up
    // among the relations shown, so two same-named relations a merge read
    // as one are not ambiguous (`RT-NAME`).
    let winners = view.relation_type_winners();
    if let Some(winner) = winners
        .iter()
        .find(|(id, _)| id.as_str() == trimmed)
        .map(|(_, w)| w)
    {
        return Ok(winner.to_string());
    }
    let types = view.relation_types();
    let key = dr_model::shared::normalize_relation_type_name(trimmed);
    let matches: Vec<_> = types.iter().filter(|t| t.normalized_name == key).collect();
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

fn resolve_comment_id(
    view: &BookViewV3<'_>,
    value: &Value,
    _include_trashed: bool,
) -> Result<String> {
    let raw = string(value, "comment")?;
    let trimmed = raw.trim();
    let comments = view.comments();
    if let Some(c) = comments.iter().find(|c| c.id.as_str() == trimmed) {
        return Ok(c.id.to_string());
    }
    let key = trimmed.to_lowercase();
    let matches: Vec<_> = comments
        .iter()
        .filter(|c| c.body.text.trim().to_lowercase() == key)
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

fn resolve_comment_part(
    cx: &ResolveCtx<'_>,
    entry: &Entry,
    mid: &ModuleId,
    mod_spec: Option<&ModuleSpec>,
    part_obj: &mut Map<String, Value>,
) -> Result<()> {
    match part_obj.get("kind").and_then(Value::as_str) {
        Some("field") => {
            if let (Some(spec), Some(f_val)) = (mod_spec, part_obj.get_mut("field")) {
                let def = resolve_field_def(spec, string(f_val, "field")?)?;
                *f_val = def.id.clone().into();
            }
        }
        Some("kv_row") => {
            if let Some(r_val) = part_obj.get_mut("row") {
                let existing = entry.kv.get(mid).map(Vec::as_slice).unwrap_or(&[]);
                let resolved = resolve_kv_row_id(existing, string(r_val, "row")?)?;
                *r_val = resolved.to_string().into();
            }
        }
        Some("patch") => {
            if let Some(p_val) = part_obj.get_mut("patch") {
                let patches = cx.view.patches_of(&entry.id, mid);
                let resolved = resolve_patch_id(&patches, string(p_val, "patch")?)?;
                *p_val = resolved.into();
            }
        }
        Some("media") => {
            if let Some(a_val) = part_obj.get_mut("asset") {
                let resolved = resolve_asset_id(&cx.view, a_val, false)?;
                *a_val = resolved.to_string().into();
            }
        }
        _ => {}
    }
    Ok(())
}

fn resolve_tab_mount(cx: &ResolveCtx<'_>, value: &mut Value) -> Result<()> {
    let obj = value
        .as_object_mut()
        .ok_or_else(|| invalid("tab mount must be an object"))?;
    match obj.get("kind").and_then(Value::as_str) {
        Some("root" | "book") => {}
        Some("entry") => {
            let e_val = obj
                .get_mut("entry")
                .ok_or_else(|| invalid("entry tab mount needs entry"))?;
            let eid = resolve_entry_id(cx, e_val, None, false, EntryRole::Below)?;
            *e_val = eid.to_string().into();
        }
        Some("view") => {
            let v_val = obj
                .get_mut("view")
                .ok_or_else(|| invalid("view tab mount needs view"))?;
            let vid = resolve_timeline_view_id(&cx.view, v_val)?;
            *v_val = vid.to_string().into();
        }
        other => {
            return Err(invalid(format!(
                "invalid tab mount kind {other:?}; use root, entry, view, or book"
            )));
        }
    }
    Ok(())
}

fn resolve_tab_id(view: &BookViewV3<'_>, value: &Value) -> Result<TabId> {
    let raw = string(value, "tab")?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(invalid("tab name or id is empty"));
    }
    let proj = view.project();
    if let Some(t) = proj.tabs.iter().find(|t| t.id.as_str() == trimmed) {
        return Ok(t.id.clone());
    }
    // A tab is called by what it shows (`kernel-v5.md` §5): an entry's
    // title, a view's name, 「全部」 (or `root`) and 「成书」 (or `book`).
    let key = trimmed.to_lowercase();
    let entries = view.entries_map();
    let views = view.timeline_views_raw();
    let named = |t: &dr_model::v3::ProjectTab| -> bool {
        match &t.mount {
            dr_model::v3::TabMount::Root => key == "root" || key == "全部",
            dr_model::v3::TabMount::Book => key == "book" || key == "成书",
            dr_model::v3::TabMount::Entry { entry } => entries
                .get(entry)
                .is_some_and(|e| e.title.trim().to_lowercase() == key),
            dr_model::v3::TabMount::View { view: id } => views
                .iter()
                .any(|v| &v.id == id && v.name.trim().to_lowercase() == key),
        }
    };
    let matches: Vec<_> = proj.tabs.iter().filter(|t| named(t)).collect();
    match matches.as_slice() {
        [t] => Ok(t.id.clone()),
        [] => Err(invalid(format!(
            "tab {trimmed:?} was not found in this book"
        ))),
        _ => Err(invalid(format!(
            "tab {trimmed:?} is ambiguous; specify its tab id"
        ))),
    }
}

fn resolve_tab_place(view: &BookViewV3<'_>, value: &mut Value) -> Result<()> {
    if let Some(obj) = value.as_object_mut() {
        for key in ["after", "before"] {
            if let Some(target_val) = obj.get_mut(key) {
                let tid = resolve_tab_id(view, target_val)?;
                *target_val = tid.to_string().into();
            }
        }
    }
    Ok(())
}

fn resolve_asset_id(
    view: &BookViewV3<'_>,
    value: &Value,
    include_trashed: bool,
) -> Result<AssetId> {
    let raw = string(value, "asset")?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(invalid("asset name or id is empty"));
    }
    let assets = if include_trashed {
        view.assets_raw()
    } else {
        view.assets()
    };
    if let Some(a) = assets.iter().find(|a| a.id.as_str() == trimmed) {
        return Ok(a.id.clone());
    }
    let key = trimmed.to_lowercase();
    let matches: Vec<_> = assets
        .iter()
        .filter(|a| !a.name.trim().is_empty() && a.name.trim().to_lowercase() == key)
        .collect();
    match matches.as_slice() {
        [a] => Ok(a.id.clone()),
        [] => Err(invalid(format!(
            "asset {trimmed:?} was not found in this book"
        ))),
        _ => Err(invalid(format!(
            "asset {trimmed:?} is ambiguous; specify its asset id"
        ))),
    }
}

fn resolve_asset_folder_id(
    view: &BookViewV3<'_>,
    value: &Value,
    include_trashed: bool,
) -> Result<AssetFolderId> {
    let raw = string(value, "asset folder")?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(invalid("asset folder name or id is empty"));
    }
    let folders = if include_trashed {
        view.asset_folders_raw()
    } else {
        view.asset_folders()
    };
    if let Some(f) = folders.iter().find(|f| f.id.as_str() == trimmed) {
        return Ok(f.id.clone());
    }
    let key = trimmed.to_lowercase();
    let matches: Vec<_> = folders
        .iter()
        .filter(|f| f.name.trim().to_lowercase() == key)
        .collect();
    match matches.as_slice() {
        [f] => Ok(f.id.clone()),
        [] => Err(invalid(format!(
            "asset folder {trimmed:?} was not found in this book"
        ))),
        _ => Err(invalid(format!(
            "asset folder {trimmed:?} is ambiguous; specify its folder id"
        ))),
    }
}

pub(crate) fn asset_folder_subtree(
    view: &BookViewV3<'_>,
    root: &AssetFolderId,
) -> (Vec<AssetFolder>, Vec<Asset>) {
    let all = view.asset_folders_raw();
    let mut inside: BTreeSet<AssetFolderId> = BTreeSet::from([root.clone()]);
    loop {
        let before = inside.len();
        for f in &all {
            if f.parent.as_ref().is_some_and(|p| inside.contains(p)) {
                inside.insert(f.id.clone());
            }
        }
        if inside.len() == before {
            break;
        }
    }
    let folders = all.into_iter().filter(|f| inside.contains(&f.id)).collect();
    let files = view
        .assets_raw()
        .into_iter()
        .filter(|a| a.folder.as_ref().is_some_and(|f| inside.contains(f)))
        .collect();
    (folders, files)
}

fn resolve_media_put_item(
    view: &BookViewV3<'_>,
    item_obj: &mut Map<String, Value>,
    existing: &[dr_model::v3::MediaItem],
) -> Result<()> {
    let asset_id = {
        let asset_val = item_obj
            .get_mut("asset")
            .ok_or_else(|| invalid("media item needs asset"))?;
        let aid = resolve_asset_id(view, asset_val, false)?;
        *asset_val = aid.to_string().into();
        aid
    };
    if let Some(id_val) = item_obj.get_mut("id")
        && let Some(raw) = id_val.as_str()
        && !raw.trim().is_empty()
    {
        let trimmed = raw.trim();
        if existing.iter().any(|m| m.id.as_str() == trimmed) || dr_model::id::is_uuid_v7(trimmed) {
            return Ok(());
        }
        let resolved = resolve_media_remove_item(view, id_val, existing)?;
        *id_val = resolved.to_string().into();
        return Ok(());
    }
    let id = existing
        .iter()
        .find(|m| m.asset == asset_id)
        .map(|m| m.id.clone())
        .unwrap_or_else(MediaItemId::new_v7);
    item_obj.insert("id".into(), id.to_string().into());
    Ok(())
}

fn resolve_media_remove_item(
    view: &BookViewV3<'_>,
    value: &Value,
    existing: &[dr_model::v3::MediaItem],
) -> Result<MediaItemId> {
    let raw = string(value, "media item")?;
    let trimmed = raw.trim();
    if let Some(item) = existing.iter().find(|m| m.id.as_str() == trimmed) {
        return Ok(item.id.clone());
    }
    if let Ok(aid) = resolve_asset_id(view, value, true)
        && let Some(item) = existing.iter().find(|m| m.asset == aid)
    {
        return Ok(item.id.clone());
    }
    let key = trimmed.to_lowercase();
    let caption_matches: Vec<_> = existing
        .iter()
        .filter(|m| !m.caption.trim().is_empty() && m.caption.trim().to_lowercase() == key)
        .collect();
    match caption_matches.as_slice() {
        [item] => Ok(item.id.clone()),
        [] => Err(invalid(format!("media item {trimmed:?} was not found"))),
        _ => Err(invalid(format!(
            "media item {trimmed:?} is ambiguous; specify its item id"
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
