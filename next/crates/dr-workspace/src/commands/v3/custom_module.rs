//! Custom modules (`docs/rust-rewrite/custom-modules.md`):
//!
//! - my modules, one library document each (`module:<id>`): `custom_module.{list, get,
//!   uses, create, update, rename, remove, save_as, adopt, import, export}` (§7, §10, §13);
//! - a book's copies follow my modules (§7 丙): [`sync_slot_copies`] runs when a book is
//!   opened, after every change to a module of mine here, and when one arrives from
//!   another device; `custom_module.sync_copies` runs it on request;
//! - the values an entry keeps: `module.read_custom`, `module.set_custom_value`,
//!   `module.add_custom_item`, `module.remove_custom_item`, `module.move_custom_item`.
//!
//! A copy follows my modules exactly when my modules have its id; importing, 「另存一份」
//! and 「存进我的模块」 always make a new id (§7 "怎么认「跟着我的模块走」").

use super::*;
use crate::Workspace;
use dr_doc::custom_module::{BorrowedModuleDoc, ModuleInfo, ModuleOrigin};
use dr_doc::v3::modules::{CopySource, entry_key};
use dr_model::custom_module::values::{
    BlockValue, InputValue, ItemStep, StoredScope, StoredValue, check_input, check_path, read_scope,
};
use dr_model::custom_module::{
    BlockKind, MAX_MODULE_BYTES, ModuleCredit, ModuleValue, parse_module_json, to_canonical_json,
};
use dr_store::OpenDoc;

pub(crate) fn register(r: &mut Registry) {
    r.add::<CustomModuleList>()
        .add::<CustomModuleGet>()
        .add::<CustomModuleUses>()
        .add::<CustomModuleCreate>()
        .add::<CustomModuleUpdate>()
        .add::<CustomModuleRename>()
        .add::<CustomModuleRemove>()
        .add::<CustomModuleSaveAs>()
        .add::<CustomModuleAdopt>()
        .add::<CustomModuleImport>()
        .add::<CustomModuleExport>()
        .add::<CustomModuleSyncCopies>()
        .add::<CustomRead>()
        .add::<CustomSetValue>()
        .add::<CustomAddItem>()
        .add::<CustomRemoveItem>()
        .add::<CustomMoveItem>();
}

/// The store's kind of a module document.
pub const DOC_KIND: &str = dr_store::index::DOC_KIND_MODULE;

/// Whether a store event is a change to my modules (a `module:<id>`
/// document written, added or purged, here or by sync): what lists my
/// modules reads again (the shelf's left column does the same for
/// `project-template:` documents).
pub fn is_my_module_store_event(event: &dr_store::StoreEvent) -> bool {
    match event {
        dr_store::StoreEvent::Doc(ev) => ev.doc_id.starts_with("module:"),
        dr_store::StoreEvent::Local(c) => {
            matches!(c.table.as_str(), "doc" | "purged_doc") && c.key.starts_with("module:")
        }
    }
}

fn doc_id(id: &CustomModuleId) -> String {
    DocId::Module(id.clone()).to_string()
}

/// One of my modules, as lists show it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ModuleSummary {
    pub id: String,
    pub name: String,
    /// `own` (made here) or `file` (imported from a `.driftingmodule`).
    pub origin: String,
    /// Blocks, nested ones included.
    pub blocks: usize,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub locale: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
}

/// One of my modules with its value.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ModuleDetail {
    pub summary: ModuleSummary,
    #[schemars(with = "serde_json::Value")]
    pub value: ModuleValue,
}

fn summary_of(id: &CustomModuleId, info: &ModuleInfo, value: &ModuleValue) -> ModuleSummary {
    ModuleSummary {
        id: id.to_string(),
        name: value.name.clone(),
        origin: info.origin.as_str().to_owned(),
        blocks: value.blocks_with_scope().len(),
        locale: value.locale.clone(),
        author: value
            .credit
            .as_ref()
            .map(|c| c.author.clone())
            .filter(|a| !a.is_empty()),
        created_at: info.created_at.map(|t| t.0),
        updated_at: info.updated_at.map(|t| t.0),
    }
}

/// The module my modules keep as `id`: `None` when they do not have it
/// (never saved here, or removed). A document whose value does not pass the
/// validator is an error.
pub fn my_module(ws: &Workspace, id: &CustomModuleId) -> Result<Option<(ModuleInfo, ModuleValue)>> {
    let doc = doc_id(id);
    let lib = ws.library();
    if lib.doc_info(&doc)?.is_none() {
        return Ok(None);
    }
    let raw = lib.load_copy(&doc)?;
    let borrowed = BorrowedModuleDoc::new(&raw, id)?;
    let view = borrowed.view();
    let Some(info) = view.info() else {
        return Ok(None);
    };
    let value = view.value().map_err(|e| WsError::invalid(e.to_string()))?;
    Ok(Some((info, value)))
}

fn need_my_module(ws: &Workspace, id: &CustomModuleId) -> Result<(ModuleInfo, ModuleValue)> {
    my_module(ws, id)?.ok_or_else(|| WsError::not_found("module", id.as_str()))
}

/// Whether my modules have `id`: a book's copy with this id follows them.
pub fn in_my_modules(ws: &Workspace, id: &CustomModuleId) -> Result<bool> {
    Ok(ws.library().doc_info(&doc_id(id))?.is_some())
}

/// A module given as JSON, through the one validator.
fn module_from_json(v: &serde_json::Value) -> Result<ModuleValue> {
    let raw = serde_json::to_string(v).map_err(|e| WsError::invalid(e.to_string()))?;
    parse_module_json(&raw).map_err(|e| WsError::invalid(e.to_string()))
}

/// Store `value` in my modules: as a new module (`replace` `None`, a new
/// id) or over module `replace`, whole. Returns its id and record.
fn store_module(
    ws: &Workspace,
    actor: &crate::Actor,
    origin: ModuleOrigin,
    value: &ModuleValue,
    replace: Option<&CustomModuleId>,
) -> Result<(CustomModuleId, ModuleInfo)> {
    dr_model::custom_module::validate_module_value(value)
        .map_err(|e| WsError::invalid(e.to_string()))?;
    let lib = ws.library();
    let ts = now();
    let (id, handle, info) = match replace {
        Some(id) => {
            let (old, _) = need_my_module(ws, id)?;
            let handle = lib.open_doc(&doc_id(id), OpenDoc::Existing)?;
            let info = ModuleInfo {
                origin: old.origin,
                created_at: old.created_at.or(Some(ts)),
                updated_at: Some(ts),
            };
            (id.clone(), handle, info)
        }
        None => {
            let id = CustomModuleId::new_v7();
            let g = dr_doc::custom_module::genesis(&id);
            let genesis = move |d: &loro::LoroDoc| {
                if let Err(e) = d.import(&g) {
                    log::error!("module genesis: {e}");
                }
            };
            let handle = lib.open_doc(
                &doc_id(&id),
                OpenDoc::CreateIfMissing {
                    kind: DOC_KIND,
                    book_id: None,
                    genesis: &genesis,
                },
            )?;
            let info = ModuleInfo {
                origin,
                created_at: Some(ts),
                updated_at: Some(ts),
            };
            (id, handle, info)
        }
    };
    let write_id = id.clone();
    let write_info = info.clone();
    let write_value = value.clone();
    let agent = actor.agent_write(&format!("custom_module: {}", value.name));
    let r = crate::holder::write(&handle, actor.store_origin(), agent, move |doc| {
        BorrowedModuleDoc::new(doc, &write_id)?
            .txn()
            .save(&write_info, &write_value)
            .map_err(|e| WsError::invalid(e.to_string()))
    });
    handle.close();
    r?;
    Ok((id, info))
}

// ---- copies follow my modules ---------------------------------------------

/// Bring the copies in the open book `slot` up to date with my modules
/// (§7 丙): every copy (or only `only`) whose id my modules have and whose
/// value differs from theirs is replaced, whole, in one commit. Values are
/// not touched. A module of mine that does not pass the validator is left
/// alone. Returns the ids replaced.
pub(crate) fn sync_slot_copies(
    ws: &Workspace,
    slot: &crate::workspace::BookSlot,
    only: Option<&CustomModuleId>,
) -> Result<Vec<CustomModuleId>> {
    let copies = slot.reader_v3.view().module_copies();
    let mut replace: Vec<(CustomModuleId, ModuleValue)> = Vec::new();
    for (id, copy) in copies {
        if only.is_some_and(|o| *o != id) {
            continue;
        }
        let mine = match my_module(ws, &id) {
            Ok(Some((_, value))) => value,
            Ok(None) => continue,
            Err(e) => {
                log::warn!("my module {id} cannot be read: {e}");
                continue;
            }
        };
        let json = to_canonical_json(&mine).map_err(|e| WsError::invalid(e.to_string()))?;
        if json != copy.raw {
            replace.push((id, mine));
        }
    }
    if replace.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<CustomModuleId> = replace.iter().map(|(id, _)| id.clone()).collect();
    let book = slot.book.clone();
    crate::holder::write(&slot.handle, dr_store::Origin::Command, None, move |doc| {
        let b = dr_doc::v3::BorrowedBookV3::new(doc, &book)?;
        let txn = b.txn();
        for (id, value) in &replace {
            txn.put_module_copy(id, value, &CopySource::Library)?;
        }
        Ok(())
    })?;
    Ok(ids)
}

/// After module `id` of mine changed (here or from another device): every
/// open book that has a copy of it gets the new one. Errors are logged: the
/// change to my modules stands, and the book catches up when it is opened.
pub(crate) fn sync_open_books(ws: &Workspace, id: &CustomModuleId) {
    for slot in ws.open_book_slots() {
        if slot.reader_v3.view().module_copy(id).is_none() {
            continue;
        }
        let gate = ws.book_gate(&slot.book);
        let _lease = gate.enter();
        if let Err(e) = sync_slot_copies(ws, &slot, Some(id)) {
            log::warn!(
                "module {id}: book {} keeps its copy for now: {e}",
                slot.book
            );
        }
    }
}

// ---- my modules: queries ---------------------------------------------------

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct ListIn {}

op! {
    CustomModuleList = "custom_module.list", Read, Shared,
    "List my modules (custom entry modules kept in this library), most recently changed first.",
    fn(cx, _input: ListIn) -> Vec<ModuleSummary> {
        let ws = cx.workspace();
        let mut out = Vec::new();
        for d in ws.library().docs(None, Some(DOC_KIND))? {
            let Some(raw) = d.doc_id.strip_prefix("module:") else { continue };
            let Ok(id) = CustomModuleId::parse(raw) else { continue };
            if let Ok(Some((info, value))) = my_module(ws, &id) {
                out.push(summary_of(&id, &info, &value));
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
pub struct IdIn {
    pub id: String,
}

op! {
    CustomModuleGet = "custom_module.get", Read, Shared,
    "Read one of my modules and its value.",
    fn(cx, input: IdIn) -> ModuleDetail {
        let id: CustomModuleId = pid("module", &input.id)?;
        let (info, value) = need_my_module(cx.workspace(), &id)?;
        Ok(ModuleDetail { summary: summary_of(&id, &info, &value), value })
    }
}

/// A project that uses one of my modules.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ModuleUse {
    pub book: String,
    pub name: String,
}

op! {
    CustomModuleUses = "custom_module.uses", Read, Shared,
    "The projects (not in Recently Deleted, not a template's working copy) whose entry templates use one of my modules.",
    fn(cx, input: IdIn) -> Vec<ModuleUse> {
        let id: CustomModuleId = pid("module", &input.id)?;
        let ws = cx.workspace();
        let lib = ws.library();
        let local: BTreeSet<String> = lib.local_books()?.into_iter().map(|b| b.book_id).collect();
        let mut out = Vec::new();
        for d in lib.docs(None, Some("book"))? {
            let Some(raw) = d.doc_id.strip_prefix("book:") else { continue };
            let Ok(book) = BookId::parse(raw) else { continue };
            if local.contains(book.as_str()) {
                continue;
            }
            let doc = lib.load_copy(&d.doc_id)?;
            let Ok(b) = dr_doc::v3::BorrowedBookV3::new(&doc, &book) else { continue };
            let view = b.view();
            let meta = view.meta();
            if meta.deleted_at.is_some() {
                continue;
            }
            let used = view.templates().iter().filter(|t| !t.is_trashed()).any(|t| {
                t.modules.iter().any(|m| {
                    m.kind == m::ModuleKind::Custom && m.config.module.as_ref() == Some(&id)
                })
            });
            if used {
                out.push(ModuleUse { book: book.to_string(), name: meta.name });
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.book.cmp(&b.book)));
        Ok(out)
    }
}

// ---- my modules: writes ----------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct CreateIn {
    /// The module (`drifting.module`, format version 1).
    pub value: serde_json::Value,
}

op! {
    CustomModuleCreate = "custom_module.create", Write, Library,
    "Make a new module in my modules from a module value (format drifting.module); it gets a new id.",
    fn(cx, input: CreateIn) -> ModuleSummary {
        let value = module_from_json(&input.value)?;
        let (id, info) = store_module(cx.workspace(), cx.actor(), ModuleOrigin::Own, &value, None)?;
        cx.irreversible();
        cx.effect(EffectAction::Created, "custom_module", id.as_str(), Some(&value.name));
        Ok(summary_of(&id, &info, &value))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct UpdateIn {
    pub id: String,
    /// The whole new module (format drifting.module).
    pub value: serde_json::Value,
}

/// Replace module `id` of mine with `value` and bring open books' copies
/// along; undone by putting the old value back.
fn update(cx: &Cx<'_>, id: &CustomModuleId, value: ModuleValue) -> Result<ModuleSummary> {
    let ws = cx.workspace();
    let (info, old) = need_my_module(ws, id)?;
    if old == value {
        cx.undo_nothing();
        return Ok(summary_of(id, &info, &old));
    }
    let (_, info) = store_module(ws, cx.actor(), info.origin, &value, Some(id))?;
    sync_open_books(ws, id);
    cx.undo_with(Invocation::new(
        "custom_module.update",
        UpdateIn {
            id: id.to_string(),
            value: serde_json::to_value(&old).map_err(|e| WsError::Internal(e.to_string()))?,
        },
    ));
    cx.effect(
        EffectAction::Updated,
        "custom_module",
        id.as_str(),
        Some(&value.name),
    );
    Ok(summary_of(id, &info, &value))
}

op! {
    CustomModuleUpdate = "custom_module.update", Write, Library,
    "Replace one of my modules with a new value, whole; every project using it gets the new one (entries keep their values).",
    fn(cx, input: UpdateIn) -> ModuleSummary {
        let id: CustomModuleId = pid("module", &input.id)?;
        let value = module_from_json(&input.value)?;
        update(cx, &id, value)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct RenameIn {
    pub id: String,
    pub name: String,
}

op! {
    CustomModuleRename = "custom_module.rename", Write, Library,
    "Rename one of my modules; every project using it gets the new name.",
    fn(cx, input: RenameIn) -> ModuleSummary {
        let id: CustomModuleId = pid("module", &input.id)?;
        let (_, mut value) = need_my_module(cx.workspace(), &id)?;
        value.name = input.name.trim().to_owned();
        dr_model::custom_module::validate_module_value(&value)
            .map_err(|e| WsError::invalid(e.to_string()))?;
        update(cx, &id, value)
    }
}

op! {
    CustomModuleRemove = "custom_module.remove", Write, Library,
    "Delete one of my modules for good. Projects using it keep their copies and stop following it.",
    fn(cx, input: IdIn) -> Done {
        if matches!(cx.actor(), crate::Actor::Agent { .. }) {
            return Err(WsError::invalid("custom_module.remove is the author's own"));
        }
        let id: CustomModuleId = pid("module", &input.id)?;
        let lib = cx.workspace().library();
        if lib.doc_info(&doc_id(&id))?.is_none() {
            return Err(WsError::not_found("module", &input.id));
        }
        let name = my_module(cx.workspace(), &id).ok().flatten().map(|(_, v)| v.name);
        lib.purge_doc(&doc_id(&id))?;
        cx.irreversible();
        cx.effect(EffectAction::Purged, "custom_module", id.as_str(), name.as_deref());
        Ok(Done { id: id.to_string() })
    }
}

/// What 「另存一份」 and 「存进我的模块」 made.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Saved {
    /// The new module of mine.
    pub module: ModuleSummary,
    /// The entry templates of the book that now use it.
    pub templates: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct SaveAsIn {
    pub book: String,
    /// The module the book's entry templates use now (its copy's id).
    pub module: String,
    /// The value to save: left out, the book's copy as it is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
}

/// Save `value` as a new module of mine and point every entry template of
/// `book` that uses `old` at it, with the new copy, in one book commit.
fn save_into_my_modules(
    cx: &Cx<'_>,
    book: &str,
    old: &CustomModuleId,
    value: Option<ModuleValue>,
) -> Result<Saved> {
    let ws = cx.workspace();
    let book_id: BookId = pid("book", book)?;
    let gate = ws.book_gate(&book_id);
    let _lease = gate.enter();
    let slot = cx.book_v3(book)?;
    let view = slot.reader_v3.view();
    let value = match value {
        Some(v) => v,
        None => {
            let copy = view
                .module_copy(old)
                .ok_or_else(|| WsError::not_found("module copy", old.as_str()))?;
            copy.value.map_err(|e| {
                WsError::invalid(format!("the book's copy of {old} cannot be read: {e}"))
            })?
        }
    };
    let users: Vec<m::EntryTemplate> = view
        .templates()
        .into_iter()
        .filter(|t| !t.is_trashed())
        .filter(|t| {
            t.modules
                .iter()
                .any(|m| m.kind == m::ModuleKind::Custom && m.config.module.as_ref() == Some(old))
        })
        .collect();
    let (new_id, info) = store_module(ws, cx.actor(), ModuleOrigin::Own, &value, None)?;
    let mut keys = vec![rec(CollectionV3::Modules, &new_id)];
    keys.extend(users.iter().map(|t| rec(CollectionV3::Templates, &t.id)));
    let names: Vec<String> = users.iter().map(|t| t.id.to_string()).collect();
    let write_id = new_id.clone();
    let write_value = value.clone();
    let old_id = old.clone();
    cx.write_book_v3(&slot, Replaces::records(keys), move |t| {
        t.put_module_copy(&write_id, &write_value, &CopySource::Library)?;
        for tpl in &users {
            for spec in tpl.modules.iter().filter(|m| {
                m.kind == m::ModuleKind::Custom && m.config.module.as_ref() == Some(&old_id)
            }) {
                let mut spec = spec.clone();
                spec.config.module = Some(write_id.clone());
                t.template(&tpl.id)?.put_module(&spec)?;
            }
        }
        Ok(())
    })?;
    cx.irreversible();
    cx.effect(
        EffectAction::Created,
        "custom_module",
        new_id.as_str(),
        Some(&value.name),
    );
    for t in &names {
        cx.effect(EffectAction::Updated, "entry_template", t, None);
    }
    Ok(Saved {
        module: summary_of(&new_id, &info, &value),
        templates: names,
    })
}

op! {
    CustomModuleSaveAs = "custom_module.save_as", Write, Library,
    "Save a module this project uses as a new module of mine (new id) and make this project's entry templates use it; the module it used before is not changed.",
    fn(cx, input: SaveAsIn) -> Saved {
        let old: CustomModuleId = pid("module", &input.module)?;
        let value = input.value.as_ref().map(module_from_json).transpose()?;
        save_into_my_modules(cx, &input.book, &old, value)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct AdoptIn {
    pub book: String,
    /// A module that came with someone else's template or book (not in my modules).
    pub module: String,
}

op! {
    CustomModuleAdopt = "custom_module.adopt", Write, Library,
    "Keep a module that came with someone else's template or book in my modules (new id); this project's entry templates use it from now on and follow it.",
    fn(cx, input: AdoptIn) -> Saved {
        let old: CustomModuleId = pid("module", &input.module)?;
        if in_my_modules(cx.workspace(), &old)? {
            return Err(WsError::invalid("this module is already one of my modules"));
        }
        save_into_my_modules(cx, &input.book, &old, None)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ImportIn {
    /// A `.driftingmodule` file on disk.
    pub path: String,
}

/// Read and validate a `.driftingmodule` file (256 KiB at most).
pub fn read_module_file(path: &std::path::Path) -> Result<ModuleValue> {
    use std::io::Read as _;
    let file = std::fs::File::open(path)
        .map_err(|e| WsError::invalid(format!("{}: {e}", path.display())))?;
    let mut bytes = Vec::new();
    file.take(MAX_MODULE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| WsError::invalid(format!("{}: {e}", path.display())))?;
    let raw = std::str::from_utf8(&bytes)
        .map_err(|_| WsError::invalid("the file is not a UTF-8 Drifting module"))?;
    parse_module_json(raw).map_err(|e| WsError::invalid(e.to_string()))
}

op! {
    CustomModuleImport = "custom_module.import", Write, Library,
    "Validate a .driftingmodule file and add it to my modules as a new module (always a new one, with a new id).",
    fn(cx, input: ImportIn) -> ModuleSummary {
        if matches!(cx.actor(), crate::Actor::Agent { .. }) {
            return Err(WsError::invalid("custom_module.import is not callable by the Agent"));
        }
        let value = read_module_file(std::path::Path::new(&input.path))?;
        let (id, info) = store_module(cx.workspace(), cx.actor(), ModuleOrigin::File, &value, None)?;
        cx.irreversible();
        cx.effect(EffectAction::Created, "custom_module", id.as_str(), Some(&value.name));
        Ok(summary_of(&id, &info, &value))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ExportIn {
    pub id: String,
    /// The `.driftingmodule` file to write.
    pub path: String,
    /// The signed-in account's display name (left out or blank: no credit).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ExportOut {
    pub id: String,
    pub name: String,
    pub path: String,
    pub bytes: u64,
}

/// One of my modules as it is exported: its credit is the exporter's
/// account name only (on one line; none when not given), the stored module
/// unchanged.
pub fn prepare_export(
    ws: &Workspace,
    id: &str,
    author: Option<&str>,
) -> Result<(CustomModuleId, ModuleValue)> {
    let id: CustomModuleId = pid("module", id)?;
    let (_, mut value) = need_my_module(ws, &id)?;
    value.credit = author
        .map(|a| a.chars().filter(|c| !c.is_control()).collect::<String>())
        .map(|a| a.trim().to_owned())
        .filter(|a| !a.is_empty())
        .map(|author| ModuleCredit { author });
    dr_model::custom_module::validate_module_value(&value)
        .map_err(|e| WsError::invalid(e.to_string()))?;
    Ok((id, value))
}

op! {
    CustomModuleExport = "custom_module.export", Read, Shared,
    "Write one of my modules to a .driftingmodule file (the same module is the same bytes every time).",
    fn(cx, input: ExportIn) -> ExportOut {
        if matches!(cx.actor(), crate::Actor::Agent { .. }) {
            return Err(WsError::invalid("custom_module.export is not callable by the Agent"));
        }
        let (id, value) = prepare_export(cx.workspace(), &input.id, input.author.as_deref())?;
        let json = to_canonical_json(&value).map_err(|e| WsError::invalid(e.to_string()))?;
        super::project_template::write_file_atomic(std::path::Path::new(&input.path), json.as_bytes())?;
        Ok(ExportOut {
            id: id.to_string(),
            name: value.name,
            path: input.path,
            bytes: json.len() as u64,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Synced {
    /// The copies replaced with my modules' values.
    pub replaced: Vec<String>,
}

op! {
    CustomModuleSyncCopies = "custom_module.sync_copies", Write, Book,
    "Bring this project's copies of my modules up to date (a project does this itself when it is opened and when a module of mine changes); entries keep their values.",
    fn(cx, input: BookIn) -> Synced {
        let slot = cx.book_v3(&input.book)?;
        let replaced = sync_slot_copies(cx.workspace(), &slot, None)?;
        cx.irreversible();
        Ok(Synced { replaced: replaced.iter().map(ToString::to_string).collect() })
    }
}

// ---- the values an entry keeps ---------------------------------------------

/// An entry's custom module.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct CustomIn {
    pub book: String,
    pub entry: String,
    /// The template module (of kind `custom`).
    pub module: String,
}

/// A book's copy of a module, as a reader needs it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct CopyInfo {
    pub id: String,
    /// The module's name (for a broken copy: what its JSON still says).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// `library` or `template`.
    pub source: String,
    /// My modules have this id: the copy follows them (§7).
    pub follows: bool,
    /// This build's validator refuses the copy (§16 item 6): it is drawn as
    /// an empty placeholder with its name; the values stay.
    pub broken: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `module.read_custom`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CustomData {
    /// The template module.
    pub module: String,
    pub name: String,
    /// `None`: the template names a module the book has no copy of.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub copy: Option<CopyInfo>,
    /// The copy's module, when it can be read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "Option<serde_json::Value>")]
    pub value: Option<ModuleValue>,
    /// What the copy can read of the entry's values, by block id (a list as
    /// its items, each with its id). A value its block cannot read now is
    /// left out, and stays stored.
    #[schemars(with = "serde_json::Value")]
    pub values: BTreeMap<String, BlockValue>,
}

/// The entry, its template module (kind `custom`) and the module it names.
fn custom_target(
    v: &BookViewV3<'_>,
    i: &CustomIn,
) -> Result<(m::Entry, m::ModuleSpec, CustomModuleId)> {
    let (e, spec) = super::module::selected(
        v,
        &super::module::In {
            book: i.book.clone(),
            entry: i.entry.clone(),
            module: i.module.clone(),
        },
    )?;
    if spec.kind != m::ModuleKind::Custom {
        return Err(WsError::invalid("module is not a custom module"));
    }
    let mid = spec
        .config
        .module
        .clone()
        .ok_or_else(|| WsError::invalid("the custom module names no module"))?;
    Ok((e, spec, mid))
}

/// The copy of `id`, readable, for a write.
fn readable_copy(v: &BookViewV3<'_>, id: &CustomModuleId) -> Result<ModuleValue> {
    let copy = v
        .module_copy(id)
        .ok_or_else(|| WsError::not_found("module copy", id.as_str()))?;
    let name = copy.name();
    copy.value.map_err(|e| {
        WsError::invalid(format!(
            "module {} cannot be read by this build ({e}); its values stay as they are",
            name.as_deref().unwrap_or(id.as_str())
        ))
    })
}

fn has_scope(stored: &StoredScope, path: &[ItemStep]) -> bool {
    let mut at = stored;
    for step in path {
        let Some(item) = at
            .lists
            .get(&step.list)
            .and_then(|items| items.iter().find(|i| i.id == step.item))
        else {
            return false;
        };
        at = &item.scope;
    }
    true
}

fn scope_at<'s>(stored: &'s StoredScope, path: &[ItemStep]) -> Option<&'s StoredScope> {
    let mut at = stored;
    for step in path {
        at = &at
            .lists
            .get(&step.list)?
            .iter()
            .find(|i| i.id == step.item)?
            .scope;
    }
    Some(at)
}

op! {
    CustomRead = "module.read_custom", Read, Shared,
    "Read an entry's custom module: the book's copy of the module (or that it is broken), and the values the copy can read, by block id.",
    fn(cx, input: CustomIn) -> CustomData {
        let s = cx.book_v3(&input.book)?;
        let v = s.reader_v3.view();
        let (e, spec, mid) = custom_target(&v, &input)?;
        let copy = v.module_copy(&mid);
        let stored = v.custom_values(&e.id, &spec.id);
        let value = copy.as_ref().and_then(|c| c.module().cloned());
        let values = value
            .as_ref()
            .map(|m| read_scope(m, None, &stored))
            .unwrap_or_default();
        let info = match copy {
            Some(c) => Some(CopyInfo {
                id: c.id.to_string(),
                name: c.name(),
                source: c.source.as_str().to_owned(),
                follows: in_my_modules(cx.workspace(), &c.id)?,
                broken: c.is_broken(),
                error: c.value.as_ref().err().map(ToString::to_string),
            }),
            None => None,
        };
        Ok(CustomData {
            module: spec.id.to_string(),
            name: spec.name,
            copy: info,
            value,
            values,
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct SetValueIn {
    #[serde(flatten)]
    pub target: CustomIn,
    /// The items down to the block's scope, one per list from the entry
    /// down (empty for a block the entry keeps directly).
    #[serde(default)]
    pub path: Vec<ItemStep>,
    pub block: String,
    /// The value (`null` clears it): text for text, long_text, date, select
    /// and image (an asset id); a number; true or false for a toggle; a list
    /// of texts for multi_select and entry (entry ids).
    pub value: InputValue,
}

/// One write to an entry's values in the module's scope, with its undo.
fn write_values(
    cx: &Cx<'_>,
    s: &Arc<BookSlot>,
    entry: &EntryId,
    module: &ModuleId,
    f: impl FnOnce(&dr_doc::v3::write::EntryWriterV3) -> dr_doc::Result<()> + Send + 'static,
) -> Result<()> {
    let id = entry.clone();
    let replaced = rec(CollectionV3::Entries, entry).at([entry_key(module)]);
    let (_, at) = cx.write_book_v3(s, Replaces::records([replaced]), move |t| {
        f(&t.entries().entry(&id)?)?;
        Ok(())
    })?;
    undo(cx, s, &at, vec![key("entries", entry)]);
    cx.effect(EffectAction::Updated, "entry", entry.as_str(), None);
    Ok(())
}

op! {
    CustomSetValue = "module.set_custom_value", Write, Book,
    "Set or clear one block's value in an entry's custom module, checked against the block's kind; a block in a list is reached through its items (`path`).",
    fn(cx, input: SetValueIn) -> Done {
        let s = cx.book_v3(&input.target.book)?;
        let v = s.reader_v3.view();
        let (e, spec, mid) = custom_target(&v, &input.target)?;
        let module = readable_copy(&v, &mid)?;
        let block = module
            .block(&input.block)
            .ok_or_else(|| WsError::not_found("block", &input.block))?;
        if block.kind.holds_blocks() {
            return Err(WsError::invalid("a group or a list has no value of its own"));
        }
        check_path(&module, &input.block, &input.path).map_err(WsError::invalid)?;
        let stored = check_input(block, &input.value).map_err(WsError::invalid)?;
        match (block.kind, &stored) {
            (BlockKind::Entry, Some(StoredValue::Texts(ids))) => {
                for raw in ids {
                    live(&v, raw)?;
                }
            }
            (BlockKind::Image, Some(StoredValue::Text(asset)))
                if !v.assets().iter().any(|a| a.id.as_str() == asset) =>
            {
                return Err(WsError::not_found("asset", asset));
            }
            _ => {}
        }
        if !has_scope(&v.custom_values(&e.id, &spec.id), &input.path) {
            return Err(WsError::not_found("item", input.path.last().map(|s| s.item.as_str()).unwrap_or("")));
        }
        let (module_id, path, block_id) = (spec.id.clone(), input.path.clone(), input.block.clone());
        write_values(cx, &s, &e.id, &spec.id, move |w| {
            w.set_custom_value(&module_id, &path, &block_id, stored.as_ref())
        })?;
        Ok(Done { id: e.id.to_string() })
    }
}

/// A list, in the scope `path` leads to.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ListAt {
    #[serde(flatten)]
    pub target: CustomIn,
    /// The items down to the list's scope (empty: the entry's own).
    #[serde(default)]
    pub path: Vec<ItemStep>,
    /// The list block.
    pub list: String,
}

/// The list block `list` of the copy, and the path to it checked.
fn list_target(v: &BookViewV3<'_>, at: &ListAt) -> Result<(m::Entry, m::ModuleSpec, StoredScope)> {
    let (e, spec, mid) = custom_target(v, &at.target)?;
    let module = readable_copy(v, &mid)?;
    let block = module
        .block(&at.list)
        .ok_or_else(|| WsError::not_found("block", &at.list))?;
    if block.kind != BlockKind::List {
        return Err(WsError::invalid(format!("{} is not a list", at.list)));
    }
    check_path(&module, &at.list, &at.path).map_err(WsError::invalid)?;
    let stored = v.custom_values(&e.id, &spec.id);
    if !has_scope(&stored, &at.path) {
        return Err(WsError::not_found(
            "item",
            at.path.last().map(|s| s.item.as_str()).unwrap_or(""),
        ));
    }
    Ok((e, spec, stored))
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct AddItemIn {
    #[serde(flatten)]
    pub at: ListAt,
    /// Where the new item goes (left out: last).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<usize>,
}

/// A new item.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ItemAdded {
    pub entry: String,
    /// The new item's id.
    pub item: String,
    pub index: usize,
}

op! {
    CustomAddItem = "module.add_custom_item", Write, Book,
    "Add an item to a list in an entry's custom module (at `index`, or last); returns the new item's id.",
    fn(cx, input: AddItemIn) -> ItemAdded {
        let s = cx.book_v3(&input.at.target.book)?;
        let v = s.reader_v3.view();
        let (e, spec, stored) = list_target(&v, &input.at)?;
        let len = scope_at(&stored, &input.at.path)
            .and_then(|sc| sc.lists.get(&input.at.list))
            .map_or(0, Vec::len);
        let index = input.index.unwrap_or(len).min(len);
        let item = ModuleItemId::new_v7();
        let (module_id, path, list, new_item) =
            (spec.id.clone(), input.at.path.clone(), input.at.list.clone(), item.clone());
        write_values(cx, &s, &e.id, &spec.id, move |w| {
            w.insert_custom_item(&module_id, &path, &list, Some(index), &new_item)
                .map(|_| ())
        })?;
        Ok(ItemAdded { entry: e.id.to_string(), item: item.to_string(), index })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ItemIn {
    #[serde(flatten)]
    pub at: ListAt,
    pub item: String,
}

fn item_exists(stored: &StoredScope, at: &ListAt, item: &str) -> Result<usize> {
    scope_at(stored, &at.path)
        .and_then(|sc| sc.lists.get(&at.list))
        .and_then(|items| items.iter().position(|i| i.id == item))
        .ok_or_else(|| WsError::not_found("item", item))
}

op! {
    CustomRemoveItem = "module.remove_custom_item", Write, Book,
    "Remove an item, with what it keeps, from a list in an entry's custom module.",
    fn(cx, input: ItemIn) -> Done {
        let s = cx.book_v3(&input.at.target.book)?;
        let v = s.reader_v3.view();
        let (e, spec, stored) = list_target(&v, &input.at)?;
        item_exists(&stored, &input.at, &input.item)?;
        let (module_id, path, list, item) =
            (spec.id.clone(), input.at.path.clone(), input.at.list.clone(), input.item.clone());
        write_values(cx, &s, &e.id, &spec.id, move |w| {
            w.remove_custom_item(&module_id, &path, &list, &item)
        })?;
        Ok(Done { id: e.id.to_string() })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct MoveItemIn {
    #[serde(flatten)]
    pub at: ListAt,
    pub item: String,
    /// Its place among the list's items afterwards (0 is first).
    pub to: usize,
}

op! {
    CustomMoveItem = "module.move_custom_item", Write, Book,
    "Move an item of a list in an entry's custom module to another place; its values move with it.",
    fn(cx, input: MoveItemIn) -> Done {
        let s = cx.book_v3(&input.at.target.book)?;
        let v = s.reader_v3.view();
        let (e, spec, stored) = list_target(&v, &input.at)?;
        let from = item_exists(&stored, &input.at, &input.item)?;
        let len = scope_at(&stored, &input.at.path)
            .and_then(|sc| sc.lists.get(&input.at.list))
            .map_or(0, Vec::len);
        let to = input.to.min(len.saturating_sub(1));
        if from == to {
            cx.undo_nothing();
            return Ok(Done { id: e.id.to_string() });
        }
        let (module_id, path, list, item) =
            (spec.id.clone(), input.at.path.clone(), input.at.list.clone(), input.item.clone());
        write_values(cx, &s, &e.id, &spec.id, move |w| {
            w.move_custom_item(&module_id, &path, &list, &item, to).map(|_| ())
        })?;
        Ok(Done { id: e.id.to_string() })
    }
}
