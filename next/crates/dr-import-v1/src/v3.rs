//! Canonical v3 import. Source catalogs are replayed only in memory. The
//! pipeline owns staging, prose history, anchors, receipts, assets and resume.
//! Unresolved policy and malformed source rows stop before target writes.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use dr_doc::import_v1::BookDoc;
use dr_doc::peer::import_peer;
use dr_doc::v3::BookViewV3;
use dr_model::id::*;
use dr_model::kind::ProjectionKind;
use dr_model::v3::FieldValue;
use dr_model::{DocId, Origin};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::book;
use crate::legacy::{BookRows, Legacy};
use crate::meta::{Fields, Owner};
use crate::prose::{Notes, Plan};
use crate::run::Options;
use crate::{ImportError, Result};

pub use dr_samples::v3::{
    ActBindingChoice, MappingChoices, Pending, RootReference, TemplateRestriction,
    UnaffiliatedChoice, category_template,
};

pub(crate) fn mapping_key(options: &Options) -> Result<String> {
    Ok(format!(
        "3:{:x}",
        Sha256::digest(serde_json::to_vec(&options.v3)?)
    ))
}

pub(crate) fn doc_id(_options: &Options, book: &BookId, old: &DocId) -> DocId {
    dr_samples::v3::prose_id(book, old)
}

pub(crate) fn plan(_options: &Options, mut plan: Plan) -> Plan {
    for para in &mut plan.paras {
        for run in &mut para.runs {
            for link in &mut run.marks.entities {
                link.kind = dr_samples::v3::map_kind(&link.kind);
            }
        }
    }

    plan
}

/// Read-only preflight. It allocates no target ids on disk, adopts no device
/// identity, writes no receipt and never repairs the old library.
pub fn pending(legacy: &Legacy, choices: &MappingChoices) -> Result<Vec<Pending>> {
    let mut pending = Vec::new();
    let mut node_kinds = BTreeMap::new();
    let mut element_categories = BTreeMap::new();
    let mut category_fields: BTreeMap<_, BTreeSet<String>> = BTreeMap::new();
    for project in legacy.projects()? {
        let rows = legacy.book(&project.id)?;
        for node in &rows.nodes {
            node_kinds.insert(
                (project.id.clone(), node.id.clone()),
                dr_model::kind::NodeKind::parse(&node.kind),
            );
        }
        for element in &rows.elements {
            if let Some(category) = &element.category {
                element_categories
                    .insert((project.id.clone(), element.id.clone()), category.clone());
            }
        }
        for field in rows
            .kv
            .iter()
            .filter(|f| f.owner_kind == "element-category" && f.namespace == "element-template")
        {
            category_fields
                .entry((project.id.clone(), field.owner_id.clone()))
                .or_default()
                .insert(field.key.clone());
        }
        let mut add = |code: &str, source: &str| {
            pending.push(Pending {
                code: code.into(),
                source: source.into(),
            })
        };
        for (owner, json) in [
            (project.id.as_str(), rows.project_kv_json.as_str()),
            (project.id.as_str(), rows.project_template_kv_json.as_str()),
        ]
        .into_iter()
        .chain(
            rows.categories
                .iter()
                .map(|r| (r.id.as_str(), r.template_kv_json.as_str())),
        )
        .chain(
            rows.elements
                .iter()
                .map(|r| (r.id.as_str(), r.kv_json.as_str())),
        )
        .chain(
            rows.storyline_kv_json
                .iter()
                .map(|(id, json)| (id.as_str(), json.as_str())),
        ) {
            if !valid_kv_json(json) {
                add("unreadable-source-kv-projection", owner);
            }
        }
        let mut ids = BTreeSet::new();
        for id in rows
            .nodes
            .iter()
            .map(|r| &r.id)
            .chain(rows.acts.iter().map(|r| &r.id))
            .chain(rows.groups.iter().map(|r| &r.id))
            .chain(rows.categories.iter().map(|r| &r.id))
            .chain(rows.elements.iter().map(|r| &r.id))
            .chain(rows.storylines.iter().map(|r| &r.id))
        {
            if EntryId::parse(id).is_err()
                || id.len() + 1 + dr_doc::v3::novel::MOD_PROSE.len() > dr_model::id::MAX_ID_LEN
                || !ids.insert(id.clone())
                || id.starts_with("root-")
                || id.starts_with("import-")
            {
                add("entry-id-invalid-or-colliding", id);
            }
        }
        let mut boundaries = BTreeSet::new();
        for act in &rows.acts {
            if act.start_order.is_none() {
                add("act-without-boundary", &act.id);
            }
            let key = act
                .start_order
                .map(|n| if n == 0. { 0 } else { n.to_bits() });
            if !boundaries.insert(key) {
                add("duplicate-act-boundary", &act.id);
            }
            if act
                .drift
                .as_ref()
                .is_some_and(|id| !rows.nodes.iter().any(|n| &n.id == id && n.kind == "drift"))
            {
                add("act-binding-missing-idea", &act.id);
            }
        }
        for tree in [&rows.groups, &rows.folders] {
            for node in tree {
                let mut seen = BTreeSet::new();
                let mut at = Some(node.id.as_str());
                while let Some(id) = at {
                    if !seen.insert(id) {
                        add("source-tree-cycle", &node.id);
                        break;
                    }
                    let Some(n) = tree.iter().find(|n| n.id == id) else {
                        add("source-tree-missing-parent", &node.id);
                        break;
                    };
                    at = n.parent.as_deref();
                }
            }
        }
        for element in &rows.elements {
            if serde_json::from_str::<Vec<String>>(&element.aliases_json).is_err() {
                add("unreadable-source-aliases", &element.id);
            }
            let Some(category) = element.category.as_ref().and_then(|c| {
                rows.categories
                    .iter()
                    .find(|r| &r.id == c && r.deleted_at.is_none())
            }) else {
                add("element-missing-category", &element.id);
                continue;
            };
            let mut values = BTreeSet::new();
            for value in rows
                .kv
                .iter()
                .filter(|kv| kv.owner_id == element.id && kv.owner_kind == "element")
            {
                if !values.insert(&value.key)
                    && rows.kv.iter().any(|f| {
                        f.owner_id == category.id
                            && f.namespace == "element-template"
                            && f.key == value.key
                    })
                {
                    add("duplicate-value-for-template-field", &element.id);
                }
            }
        }
        for category in &rows.categories {
            if !["auto", "pinned"].contains(&category.layout.as_str()) {
                add("unknown-category-layout", &category.id);
            }
            if category.grid_x.is_some() != category.grid_y.is_some()
                || (category.layout == "pinned" && category.grid_x.is_none())
            {
                add("incomplete-category-grid-position", &category.id);
            }
            if category.layout == "auto" && category.grid_x.is_some() {
                add("auto-category-has-grid-position", &category.id);
            }
            let mut names = BTreeSet::new();
            for field in rows
                .kv
                .iter()
                .filter(|kv| kv.owner_id == category.id && kv.namespace == "element-template")
            {
                if !names.insert(&field.key)
                    || ["aliases", "summary", "portrait"].contains(&field.id.as_str())
                {
                    add("ambiguous-template-field", &category.id);
                }
                if !field.value.is_empty() {
                    add("field-default-value-interface-missing", &category.id);
                }
            }
        }
        for link in &rows.links {
            if !rows.nodes.iter().any(|n| n.id == link.node)
                || !rows
                    .storylines
                    .iter()
                    .any(|s| s.id == link.storyline && s.deleted_at.is_none())
            {
                add("membership-target-missing-or-trashed", &link.node);
            }
        }
        for node in &rows.nodes {
            if node.kind != "chapter" && node.kind != "drift" {
                add("unknown-node-kind", &node.id);
            }
            if node.kind == "chapter" && node.book_order.is_none() {
                add("chapter-without-book-order", &node.id);
            }
            if node.kind == "drift" && node.book_order.is_some() {
                add("idea-has-legacy-book-order", &node.id);
            }
            if !dr_model::kind::NodeStatus::parse(&node.status)
                .fits(&dr_model::kind::NodeKind::parse(&node.kind))
            {
                add("incompatible-source-node-status", &node.id);
            }
            if rows
                .links
                .iter()
                .filter(|l| l.node == node.id && l.primary)
                .count()
                > 1
            {
                add("multiple-primary-memberships", &node.id);
            }
            if node
                .group
                .as_ref()
                .is_some_and(|g| !rows.groups.iter().any(|r| &r.id == g))
            {
                add("idea-group-missing", &node.id);
            }
        }
        for pin in &rows.time_pins {
            if pin
                .drift
                .as_ref()
                .is_some_and(|id| !rows.nodes.iter().any(|n| &n.id == id && n.kind == "drift"))
            {
                add("pin-binding-missing-idea", &pin.id);
            }
        }
        let Ok(id) = BookId::parse(&project.id) else {
            add("invalid-book-id", &project.id);
            continue;
        };
        for (owner, template) in rows
            .categories
            .iter()
            .map(|c| (&c.id, dr_samples::v3::category_template(&c.id)))
            .chain(
                rows.storylines
                    .iter()
                    .map(|s| (&s.id, dr_samples::v3::storyline_template(&s.id))),
            )
        {
            // The public constructor expects valid compound ids. Historical
            // ids may be long or contain separators: report before writes,
            // rather than panic or silently change their identity.
            let encoded = format!("{id}/{template}/{}", dr_doc::v3::novel::MOD_PROSE);
            let decoded = TemplateId::parse(&encoded)
                .ok()
                .and_then(|t| t.entry_module());
            if decoded
                .as_ref()
                .is_none_or(|(b, t, _)| b != &id || t != &template)
            {
                add("template-prose-id-not-representable", owner);
            }
        }
        let mut catalog = BookDoc::create(id.clone(), import_peer(&format!("preflight:{id}")))?;
        let mut notes = Notes::default();
        let empty = crate::handoff::BookSettings::default();
        let settings = legacy
            .stamp
            .as_ref()
            .and_then(|s| s.books.get(&project.id))
            .unwrap_or(&empty);
        let inputs = book::Inputs {
            book: &id,
            project: &project,
            rows: &rows,
            settings: Some(settings),
            projected: &HashMap::new(),
            anchors: &HashMap::new(),
            span: &|_| None,
        };
        let (r, _) = catalog.edit(Origin::Import, |t| book::write(t, &inputs, &mut notes));
        r?;
        for code in notes.0.keys().filter(|c| {
            c.contains("cycle")
                || c.contains("missing-parent")
                || c.as_str() == "invalid-id"
                || c.as_str() == "plot-grid-position-key-regenerated"
                || c.as_str() == "writing-day-invalid"
                || c.as_str() == "chapter-in-group-dropped"
                || c.as_str() == "locked-relation-type-imported-unlocked"
        }) {
            add(code, &project.id);
        }
        for comment in catalog.view().comments() {
            if comment.target_missing {
                add("comment-target-missing-or-trashed", comment.id.as_str());
            }
        }
        // A tolerant v2 reader can hide broken edges. The v3 import does
        // not turn those hidden records into successful imports.
        if catalog.view().relations_raw().len() != catalog.view().relations().len() {
            add("invalid-or-duplicate-source-relation", &project.id);
        }
        pending.extend(choices.pending(&catalog.view()));
        for (source, json) in rows
            .categories
            .iter()
            .filter_map(|c| c.template_json.as_deref().map(|j| (c.id.as_str(), j)))
            .chain(
                rows.storylines
                    .iter()
                    .map(|s| (s.id.as_str(), s.template.as_str())),
            )
        {
            inspect_json(source, json, &mut pending);
            if !json.trim().is_empty() && crate::prose::pm::parse(json).is_err() {
                pending.push(Pending {
                    code: "unreadable-source-template".into(),
                    source: source.into(),
                });
            }
        }
        // Explicit choices are validated in memory before prose is stored.
        if choices.pending(&catalog.view()).is_empty() {
            let mut target = dr_doc::v3::BookDocV3::create(id, import_peer("v3-preflight-target"))?;
            let (r, _) = target.edit(Origin::Import, |t| {
                dr_samples::v3::sync_catalog(t, &catalog.view(), choices)
            });
            if let Err(error) = r {
                pending.push(Pending {
                    code: "mapping-choice-invalid".into(),
                    source: error.to_string(),
                });
            } else if let Err(error) = dr_samples::v3::validate(&target.view()) {
                pending.push(Pending {
                    code: "v3-invariant".into(),
                    source: error,
                });
            }
        }
    }
    let (owners, _) = legacy.prose_owners()?;
    let history = legacy.history()?;
    let sources: BTreeSet<_> = owners
        .iter()
        .map(|owner| (owner.project_id.clone(), owner.old_doc_id()))
        .collect();
    for row in &history {
        let mut add = |code: &str| {
            pending.push(Pending {
                code: code.into(),
                source: row.id.clone(),
            })
        };
        if !sources.contains(&(row.project_id.clone(), row.old_doc_id())) {
            add("orphan-history-source");
        }
        if row.preview.is_none() {
            add("history-preview-missing");
        }
        let Some(json) = row.meta.as_deref() else {
            continue;
        };
        let Some(meta) = crate::meta::parse(json) else {
            add("unreadable-history-metadata");
            continue;
        };
        let value: Value = serde_json::from_str(json)?;
        for key in ["kvJson", "elementTemplateKvJson"] {
            if let Some(encoded) = value.get(key)
                && encoded.as_str().is_none_or(|text| !valid_kv_json(text))
            {
                add("unreadable-history-metadata");
            }
        }
        for key in ["title", "summary", "name", "writingStatus"] {
            if value.get(key).is_some_and(|v| !v.is_string()) {
                add("unreadable-history-metadata");
            }
        }
        if value.get("aliases").is_some_and(|v| {
            v.as_array()
                .is_none_or(|aliases| aliases.iter().any(|a| !a.is_string()))
        }) {
            add("unreadable-history-metadata");
        }
        if value
            .get("groupName")
            .is_some_and(|v| !v.is_null() && !v.is_string())
        {
            add("unreadable-history-metadata");
        }
        if let Some(status) = meta.writing_status
            && let Some(kind) = node_kinds.get(&(row.project_id.clone(), row.entity_id.clone()))
            && !dr_model::kind::NodeStatus::parse(&status).fits(kind)
        {
            add("incompatible-history-node-status");
        }
        if let Some(fields) = meta.template_kv {
            let mut names = BTreeSet::new();
            for (key, value) in fields {
                if !names.insert(key.clone()) {
                    add("ambiguous-history-template-field");
                }
                if !value.is_empty() {
                    add("field-default-value-interface-missing");
                }
                category_fields
                    .entry((row.project_id.clone(), row.entity_id.clone()))
                    .or_default()
                    .insert(key);
            }
        }
    }
    for row in &history {
        let Some(category) =
            element_categories.get(&(row.project_id.clone(), row.entity_id.clone()))
        else {
            continue;
        };
        let Some(fields) = category_fields.get(&(row.project_id.clone(), category.clone())) else {
            continue;
        };
        let Some(facts) = row
            .meta
            .as_deref()
            .and_then(crate::meta::parse)
            .and_then(|meta| meta.kv)
        else {
            continue;
        };
        let mut keys = BTreeSet::new();
        if facts
            .iter()
            .any(|(key, _)| fields.contains(key) && !keys.insert(key))
        {
            pending.push(Pending {
                code: "duplicate-history-value-for-template-field".into(),
                source: row.id.clone(),
            });
        }
    }
    for (source, json) in owners
        .iter()
        .filter_map(|o| o.cache.as_deref().map(|j| (o.old_doc_id(), j)))
        .chain(
            history
                .iter()
                .filter_map(|h| h.preview.as_deref().map(|j| (h.id.clone(), j))),
        )
    {
        inspect_json(&source, json, &mut pending);
    }
    pending.sort_by(|a, b| (&a.code, &a.source).cmp(&(&b.code, &b.source)));
    pending.dedup();
    Ok(pending)
}

fn valid_kv_json(json: &str) -> bool {
    serde_json::from_str::<Vec<Value>>(json).is_ok_and(|rows| {
        rows.iter().all(|row| {
            row.get("key").and_then(Value::as_str).is_some()
                && row.get("value").and_then(Value::as_str).is_some()
        })
    })
}

fn inspect_json(source: &str, json: &str, pending: &mut Vec<Pending>) {
    if json.trim().is_empty() {
        return;
    }
    fn walk(v: &Value, source: &str, in_table: bool, pending: &mut Vec<Pending>) {
        if let Some(object) = v.as_object() {
            let in_table = in_table || object.get("type").and_then(Value::as_str) == Some("table");
            if in_table
                && object
                    .get("marks")
                    .and_then(Value::as_array)
                    .is_some_and(|marks| !marks.is_empty())
            {
                pending.push(Pending {
                    code: "legacy-table-cell-format-mapping".into(),
                    source: source.into(),
                });
            }
            if object.get("type").and_then(Value::as_str) == Some("entityLink") {
                let attrs = &v["attrs"];
                if [Some("material"), Some("library_item")].contains(&attrs["targetKind"].as_str())
                    || attrs.get("module").is_some()
                    || attrs.get("targetModule").is_some()
                    || ["targetBlockId", "targetEndBlockId"]
                        .iter()
                        .any(|key| attrs.get(key).is_some_and(|value| !value.is_null()))
                {
                    pending.push(Pending {
                        code: "v3-prose-link-writer-missing".into(),
                        source: source.into(),
                    });
                }
            }
            for value in object.values() {
                walk(value, source, in_table, pending);
            }
        } else if let Some(array) = v.as_array() {
            for value in array {
                walk(value, source, in_table, pending);
            }
        }
    }
    match serde_json::from_str(json) {
        Ok(value) => walk(&value, source, false, pending),
        Err(_) => pending.push(Pending {
            code: "unreadable-source-prose".into(),
            source: source.into(),
        }),
    }
}

pub(crate) fn preflight(legacy: &Legacy, options: &Options) -> Result<()> {
    let pending = pending(legacy, &options.v3)?;
    if !pending.is_empty() {
        return Err(ImportError::V3Pending(pending));
    }
    Ok(())
}

type Projections = HashMap<String, (CommentId, ProjectionKind, DocId, BlockId)>;

/// The v2 replay catalog uses its original deterministic TODO ids. They
/// are converted to the v3 body-based ids with their relations in the
/// adapter, while prose plans and the persisted catalog use v3 ids.
pub(crate) fn catalog_projections(
    _options: &Options,
    projected: &Projections,
    rows: &BookRows,
) -> Projections {
    projected
        .iter()
        .map(|(old, (_, kind, _, block))| {
            let row = rows
                .comments
                .iter()
                .find(|r| &r.id == old)
                .expect("projection source");
            let target_kind =
                dr_model::legacy::entity_kind(row.target_kind.as_deref().unwrap_or_default());
            let prefix = target_kind.as_str();
            let doc = DocId::parse(&format!(
                "{prefix}:{}",
                row.target_id.as_deref().unwrap_or_default()
            ))
            .expect("preflight checked projection target");
            (
                old.clone(),
                (
                    CommentId::for_projection(kind, &doc, block),
                    kind.clone(),
                    doc,
                    block.clone(),
                ),
            )
        })
        .collect()
}

pub(crate) fn holds(view: &BookViewV3<'_>, owner: &Owner, want: &Fields) -> bool {
    use dr_doc::v3::novel::{MOD_FIELDS, MOD_KV};
    let eq = |want: &Option<String>, have: &str| want.as_deref().is_none_or(|w| w == have);
    let field = |e: &dr_model::v3::Entry, key: &str| {
        e.fields
            .get(&ModuleId::parse(MOD_FIELDS).unwrap())
            .and_then(|f| f.get(key))
            .cloned()
            .unwrap_or(FieldValue::Null)
    };
    let id = match owner {
        Owner::Node(id) => id.as_str(),
        Owner::Element(id) => id.as_str(),
        Owner::Storyline(id) => id.as_str(),
        Owner::Category(id) => id.as_str(),
        Owner::Material(id) => {
            return view
                .materials()
                .iter()
                .any(|m| &m.id == id && eq(&want.title, &m.title));
        }
    };
    let Some(entry) = view.entry(&EntryId::parse(id).unwrap()) else {
        return false;
    };
    if !eq(&want.title, &entry.title) || !eq(&want.name, &entry.title) {
        return false;
    }
    if want
        .summary
        .as_ref()
        .is_some_and(|s| field(&entry, "summary").as_str() != Some(s))
        || want
            .status
            .as_ref()
            .is_some_and(|s| field(&entry, "status").as_str() != Some(s.as_str()))
    {
        return false;
    }
    if let Some(aliases) = &want.aliases
        && field(&entry, "aliases") != FieldValue::List(aliases.iter().cloned().collect())
    {
        return false;
    }
    if let Some(group) = &want.group_name {
        let actual = entry
            .parent
            .as_ref()
            .and_then(|p| view.entry(p))
            .filter(|p| {
                p.template
                    .as_ref()
                    .is_some_and(|t| t.as_str() == dr_doc::v3::novel::TPL_GROUP)
            })
            .map(|p| p.title);
        if &actual != group {
            return false;
        }
    }
    if let Some(facts) = &want.facts {
        let kv = entry
            .kv
            .get(&ModuleId::parse(MOD_KV).unwrap())
            .cloned()
            .unwrap_or_default();
        // Only category-template fields receive legacy facts. A storyline
        // KV named "摘要" is independent of its built-in summary field;
        // an element's custom field may have that same display name too.
        let template = matches!(owner, Owner::Element(_))
            .then(|| entry.template.as_ref().and_then(|id| view.template(id)))
            .flatten();
        let custom = |id: &str| !["aliases", "summary", "portrait"].contains(&id);
        for fact in facts {
            if let Some(def) = template.as_ref().and_then(|t| {
                t.modules
                    .iter()
                    .flat_map(|m| &m.config.defs)
                    .find(|d| custom(&d.id) && d.name == fact.key)
            }) {
                if field(&entry, &def.id).as_str() != Some(fact.value.as_str()) {
                    return false;
                }
            } else if !kv.iter().any(|k| {
                k.id == fact.id && k.key == fact.key && k.value == fact.value && k.pos == fact.pos
            }) {
                return false;
            }
        }
        if kv.len()
            + facts
                .iter()
                .filter(|f| {
                    template.as_ref().is_some_and(|t| {
                        t.modules
                            .iter()
                            .flat_map(|m| &m.config.defs)
                            .any(|d| custom(&d.id) && d.name == f.key)
                    })
                })
                .count()
            != facts.len()
        {
            return false;
        }
    }
    if let Some(fields) = &want.template_fields {
        let Some(template) = view.template(&dr_samples::v3::category_template(id)) else {
            return false;
        };
        let defs: BTreeMap<_, _> = template
            .modules
            .iter()
            .flat_map(|m| &m.config.defs)
            .map(|d| (d.id.as_str(), d))
            .collect();
        if fields.iter().any(|f| {
            defs.get(f.id.as_str())
                .is_none_or(|d| d.name != f.key || d.pos != f.pos)
        }) {
            return false;
        }
    }
    true
}
