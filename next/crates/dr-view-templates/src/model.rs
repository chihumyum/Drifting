//! Template definitions only. Entry values and retained prose never pass through this editor.
use std::collections::BTreeSet;

use dr_workspace::{
    Actor, Workspace, WritePreconditions, WsError,
    commands::{
        BookIn,
        v3::{template::TemplateList, types::*},
    },
};
use serde_json::{Value, json};

pub const MODULES: &[&str] = &["prose", "kv", "patches", "plot_grid", "relations"];
pub const FIELDS: &[&str] = &[
    "text",
    "long_text",
    "number",
    "date",
    "select",
    "multi_select",
    "image",
    "entity_ref",
    "aliases",
];
/// The vocabulary already rendered by the shell's shared sand mark function.
pub const MARKS: &[&str] = &[
    "book",
    "file-text",
    "lightbulb",
    "folder",
    "compass",
    "git-branch",
    "square",
];

pub fn blank(kind: &str, name: String) -> EntryTemplate {
    EntryTemplate {
        id: dr_model::v3::EntryTemplateId::new_v7().to_string(),
        kind: kind.into(),
        name,
        mark: None,
        color: None,
        agent: None,
        modules: Vec::new(),
        settings: LevelSettingsOverride::default(),
        lane: false,
        verbs: Vec::new(),
        deleted_at: None,
    }
}

pub fn module(kind: &str, name: String) -> ModuleSpec {
    let field = FIELDS.contains(&kind);
    let mut config = ModuleConfig::default();
    if field {
        let id = dr_model::v3::ModuleId::new_v7().to_string();
        config.defs.push(FieldDef {
            id: id.clone(),
            name: name.clone(),
            field_type: kind.into(),
            options: Vec::new(),
            target_template: None,
            default_value: None,
            pos: None,
        });
        if kind == "aliases" {
            config.aliases_field = Some(id);
        }
    }
    ModuleSpec {
        id: dr_model::v3::ModuleId::new_v7().to_string(),
        kind: if field { "fields" } else { kind }.into(),
        name,
        pos: None,
        config,
        agent: None,
    }
}

pub fn move_module(t: &mut EntryTemplate, id: &str, before: Option<&str>) {
    if before == Some(id) {
        return;
    }
    ensure_positions(t);
    let Some(ix) = t.modules.iter().position(|m| m.id == id) else {
        return;
    };
    let module = t.modules.remove(ix);
    let at = before
        .and_then(|id| t.modules.iter().position(|m| m.id == id))
        .unwrap_or(t.modules.len());
    let mut module = module;
    let left = at
        .checked_sub(1)
        .and_then(|ix| t.modules[ix].pos.as_deref())
        .and_then(|p| dr_model::pos::PosKey::parse(p).ok());
    let right = t
        .modules
        .get(at)
        .and_then(|m| m.pos.as_deref())
        .and_then(|p| dr_model::pos::PosKey::parse(p).ok());
    match dr_model::pos::PosKey::between(left.as_ref(), right.as_ref()) {
        Ok(pos) => {
            module.pos = Some(pos.to_string());
            t.modules.insert(at, module);
        }
        Err(_) => {
            // Concurrent insertions may legitimately share a position key.
            // Make room in that case; a failed move must never drop a module.
            t.modules.insert(at, module);
            let mut pos = dr_model::pos::PosKey::first();
            for module in &mut t.modules {
                module.pos = Some(pos.to_string());
                pos = pos.after();
            }
        }
    }
}

fn ensure_positions(t: &mut EntryTemplate) {
    let mut last = None;
    for m in &mut t.modules {
        let pos = m
            .pos
            .as_deref()
            .and_then(|p| dr_model::pos::PosKey::parse(p).ok());
        let pos = pos.unwrap_or_else(|| {
            dr_model::pos::PosKey::between(last.as_ref(), None).expect("append position")
        });
        m.pos = Some(pos.to_string());
        last = Some(pos);
    }
}

pub fn add_module(t: &mut EntryTemplate, module: ModuleSpec) {
    t.modules.push(module);
    ensure_positions(t);
}

fn conflict() -> WsError {
    WsError::Conflict("template changed while editing".into())
}

/// Merge untouched remote properties; reject edits to the same property. Keyed
/// manifests merge by stable id, so removing a module cannot erase another edit.
fn merge(
    base: Option<&Value>,
    local: Option<&Value>,
    remote: Option<&Value>,
) -> Result<Option<Value>, WsError> {
    if local == base {
        return Ok(remote.cloned());
    }
    if remote == base || local == remote {
        return Ok(local.cloned());
    }
    let (Some(base), Some(local), Some(remote)) = (base, local, remote) else {
        return Err(conflict());
    };
    if let (Some(b), Some(l), Some(r)) = (base.as_object(), local.as_object(), remote.as_object()) {
        let keys: BTreeSet<_> = b.keys().chain(l.keys()).chain(r.keys()).collect();
        let mut out = serde_json::Map::new();
        for key in keys {
            if let Some(value) = merge(b.get(key), l.get(key), r.get(key))? {
                out.insert(key.clone(), value);
            }
        }
        return Ok(Some(Value::Object(out)));
    }
    if let (Some(b), Some(l), Some(r)) = (base.as_array(), local.as_array(), remote.as_array()) {
        let keyed = |v: &[Value]| v.iter().all(|x| x.get("id").is_some_and(Value::is_string));
        if keyed(b) && keyed(l) && keyed(r) {
            let ids = |v: &[Value]| {
                v.iter()
                    .map(|x| x["id"].as_str().unwrap().to_string())
                    .collect::<Vec<_>>()
            };
            let (bi, li, ri) = (ids(b), ids(l), ids(r));
            // Comparing only surviving base ids distinguishes additions from reorders.
            let order = |v: &[String]| {
                v.iter()
                    .filter(|id| bi.contains(id) && li.contains(id) && ri.contains(id))
                    .cloned()
                    .collect::<Vec<_>>()
            };
            let (bo, lo, ro) = (order(&bi), order(&li), order(&ri));
            if lo != bo && ro != bo && lo != ro {
                return Err(conflict());
            }
            let mut sequence = if lo != bo { li.clone() } else { ri.clone() };
            for id in li.iter().chain(ri.iter()) {
                if !sequence.contains(id) {
                    sequence.push(id.clone());
                }
            }
            let mut out = Vec::new();
            for id in sequence {
                if let Some(v) = merge(
                    b.iter().find(|x| x["id"] == id),
                    l.iter().find(|x| x["id"] == id),
                    r.iter().find(|x| x["id"] == id),
                )? {
                    out.push(v);
                }
            }
            return Ok(Some(Value::Array(out)));
        }
    }
    Err(conflict())
}

pub fn reconcile(
    base: &EntryTemplate,
    local: &EntryTemplate,
    remote: &EntryTemplate,
) -> Result<EntryTemplate, WsError> {
    serde_json::from_value(
        merge(
            Some(&json!(base)),
            Some(&json!(local)),
            Some(&json!(remote)),
        )?
        .ok_or_else(conflict)?,
    )
    .map_err(|e| WsError::Internal(e.to_string()))
}

/// Actions have the typed, generic create meaning; descriptions are never code.
pub fn validate_actions(
    template: &EntryTemplate,
    templates: &[EntryTemplate],
) -> Result<(), WsError> {
    let live = |id: &str| {
        id == template.id
            || templates
                .iter()
                .any(|t| t.id == id && t.deleted_at.is_none())
    };
    let allowed = |id: &str| {
        template
            .settings
            .allow
            .as_ref()
            .is_none_or(|allow| allow.is_empty() || allow.iter().any(|tid| tid == id))
    };
    let mut ids = BTreeSet::new();
    for action in &template.verbs {
        if action.id.is_empty()
            || !ids.insert(&action.id)
            || action.name.trim().is_empty()
            || action
                .target_template
                .as_deref()
                .is_none_or(|target| !live(target) || !allowed(target))
        {
            return Err(WsError::Invalid(
                "action needs a unique id, a name and an allowed live target template".into(),
            ));
        }
    }
    Ok(())
}

/// One guarded template command. A conflict is returned to the editor with its
/// draft intact, never retried as an unguarded full replacement.
pub fn save(
    lib: &Workspace,
    book: &str,
    base: Option<&EntryTemplate>,
    draft: &EntryTemplate,
) -> Result<EntryTemplate, WsError> {
    let observed = lib.observe(&format!("book:{book}"))?;
    let templates = lib
        .run::<TemplateList>(&Actor::User, BookIn { book: book.into() })?
        .output;
    let current = templates
        .iter()
        .find(|t| t.id == draft.id && t.deleted_at.is_none());
    let merged = match (base, current) {
        (Some(base), Some(remote)) => reconcile(base, draft, remote)?,
        (None, None) => draft.clone(),
        _ => return Err(conflict()),
    };
    validate_actions(&merged, &templates)?;
    lib.call_guarded(
        &Actor::User,
        "entry_template.put",
        json!({"book": book, "template": merged}),
        WritePreconditions::from_observations([observed]),
    )?;
    Ok(merged)
}
