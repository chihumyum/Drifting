//! Unified-entry import (book format 5, `kernel-v5.md` §13). Source catalogs
//! are replayed only in memory. The pipeline owns staging, prose history,
//! anchors, receipts, assets and resume. Unresolved policy and malformed source
//! rows stop before target writes.

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
use crate::prose::Notes;
use crate::run::Options;
use crate::{ImportError, Result};

pub use dr_samples::v3::{MappingChoices, Pending, category_template};

pub(crate) fn mapping_key(options: &Options) -> Result<String> {
    // A cached pre-RI catalog lacks the recovered association rows. Its
    // history frontiers cannot be used with the new mapping.
    let mut mapping = Sha256::new();
    mapping.update(b"relation-association-v1\0");
    mapping.update(serde_json::to_vec(&options.v3)?);
    Ok(format!(
        "{}-g{}:{:x}",
        dr_doc::schema::BOOK_SCHEMA_VERSION,
        dr_doc::schema::BOOK_GENESIS_VERSION,
        mapping.finalize()
    ))
}

pub(crate) fn relation_times(rows: &BookRows) -> BTreeMap<&str, i64> {
    rows.relations
        .iter()
        .filter_map(|rel| Some((rel.id.as_str(), crate::time::parse_iso_ms(&rel.created_at)?)))
        .collect()
}

pub(crate) fn doc_id(_options: &Options, book: &BookId, old: &DocId) -> DocId {
    dr_samples::v3::prose_id(book, old)
}

/// Read-only preflight. It allocates no target ids on disk, adopts no device
/// identity, writes no receipt and never repairs the old library. Returns
/// only what still stops the import ([`findings`]).
pub fn pending(legacy: &Legacy, choices: &MappingChoices) -> Result<Vec<Pending>> {
    Ok(findings(legacy, choices)?.0)
}

/// What the preflight finds on the staging copy, after the import's
/// defaults (`crate::defaults`, `m10-import.md` 「替作者定的，等作者过目」):
///
/// - what still stops the import: ids the book's documents cannot be named
///   by, a body whose cache is not JSON, a body or catalog the book's writers
///   refuse (each named, with its source);
/// - what the book takes with a recorded default (links it cannot keep,
///   table cells it flattens, history metadata left out), as adjustments.
pub fn findings(
    legacy: &Legacy,
    choices: &MappingChoices,
) -> Result<(Vec<Pending>, Vec<crate::defaults::Adjustment>)> {
    let mut pending = Vec::new();
    let mut adjusted: Vec<crate::defaults::Adjustment> = Vec::new();
    let mut element_categories = BTreeMap::new();
    let mut category_fields: BTreeMap<_, BTreeSet<String>> = BTreeMap::new();
    let mut non_text_materials_by_book: BTreeMap<String, BTreeMap<String, String>> =
        BTreeMap::new();
    let mut bad_books: BTreeSet<String> = BTreeSet::new();
    let record = |adjusted: &mut Vec<crate::defaults::Adjustment>,
                  code: &str,
                  book: &str,
                  table: &str,
                  id: &str,
                  done: &str| {
        adjusted.push(crate::defaults::Adjustment {
            code: code.into(),
            book: book.into(),
            table: table.into(),
            id: id.into(),
            done: done.into(),
            original: None,
        });
    };
    for project in legacy.projects()? {
        let rows = legacy.book(&project.id)?;
        non_text_materials_by_book.insert(
            project.id.clone(),
            rows.materials
                .iter()
                .filter(|m| m.kind != "text")
                .map(|m| (m.id.clone(), m.title.clone()))
                .collect(),
        );
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
        let mut refused_here = false;
        let mut add = |code: &str, source: &str| {
            refused_here = true;
            pending.push(Pending {
                code: code.into(),
                source: source.into(),
            })
        };
        let folders_by_id: BTreeMap<&str, &crate::legacy::TreeRow> =
            rows.folders.iter().map(|f| (f.id.as_str(), f)).collect();
        let mut note_folder_ids: BTreeSet<&str> = BTreeSet::new();
        for m in rows.materials.iter().filter(|m| m.kind == "text") {
            let mut cur = m.folder.as_deref();
            let mut seen = BTreeSet::new();
            while let Some(fid) = cur {
                let Some(f) = folders_by_id.get(fid) else {
                    break;
                };
                if !seen.insert(fid) {
                    break;
                }
                note_folder_ids.insert(fid);
                cur = f.parent.as_deref();
            }
        }
        // Entry ids name the documents (`body:<entry>/<module>`), the links,
        // anchors and the Markdown folder: one that cannot be an entry id,
        // or that two rows share, stops the import (0.1 itself only writes
        // uuidv7; `m10-import.md` 「还会拒绝导入的」).
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
            .chain(
                rows.folders
                    .iter()
                    .filter(|r| note_folder_ids.contains(r.id.as_str()))
                    .map(|r| &r.id),
            )
            .chain(
                rows.materials
                    .iter()
                    .filter(|r| r.kind == "text")
                    .map(|r| &r.id),
            )
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
        let Ok(id) = BookId::parse(&project.id) else {
            add("invalid-book-id", &project.id);
            bad_books.insert(project.id.clone());
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
        // A book whose ids cannot name its documents is not converted any
        // further: the import stops on them.
        if refused_here {
            bad_books.insert(project.id.clone());
            continue;
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
            task_ticks: &HashMap::new(),
            unlinked_tasks: &[],
            anchors: &HashMap::new(),
            span: &|_| None,
            import_ts: crate::time::parse_iso_ms(&project.updated_at).unwrap_or(0) / 1000,
        };
        let (r, _) = catalog.edit(Origin::Import, |t| book::write(t, &inputs, &mut notes));
        r?;
        if notes.0.contains_key("invalid-id") {
            pending.push(Pending {
                code: "invalid-id".into(),
                source: project.id.clone(),
            });
        }
        pending.extend(choices.pending(&catalog.view()));
        let non_text = non_text_materials_by_book
            .get(&project.id)
            .cloned()
            .unwrap_or_default();
        let prose_module = ModuleId::parse(dr_doc::v3::novel::MOD_PROSE).expect("module id");
        for (table, source, json, template) in rows
            .categories
            .iter()
            .filter_map(|c| {
                c.template_json.as_deref().map(|j| {
                    (
                        "element_category",
                        c.id.as_str(),
                        j,
                        dr_samples::v3::category_template(&c.id),
                    )
                })
            })
            .chain(rows.storylines.iter().map(|s| {
                (
                    "storylines",
                    s.id.as_str(),
                    s.template.as_str(),
                    dr_samples::v3::storyline_template(&s.id),
                )
            }))
        {
            let mut found = Vec::new();
            inspect_json(
                source,
                json,
                dr_model::ProseProfile::Prose,
                &non_text,
                &mut found,
            );
            for f in found.iter().filter(|f| f.code != "unreadable-source-prose") {
                record(
                    &mut adjusted,
                    &f.code,
                    &project.id,
                    table,
                    source,
                    "kept as text",
                );
            }
            // (An unrepresentable template document id is reported above.)
            if let Ok(lines) = crate::prose::pm::parse(json)
                && let Ok(doc) = TemplateId::parse(&format!("{id}/{template}/{prose_module}"))
                && let Some(why) = unwritable(&DocId::Template(doc), &lines, &non_text)
            {
                pending.push(Pending {
                    code: "prose-not-writable".into(),
                    source: format!("{source}: {why}"),
                });
            }
        }
        // Explicit choices are validated in memory before prose is stored.
        if choices.pending(&catalog.view()).is_empty() {
            let mut target = dr_doc::v3::BookDocV3::create(id, import_peer("v3-preflight-target"))?;
            let (r, _) = target.edit(Origin::Import, |t| {
                dr_samples::v3::sync_catalog_with_relation_times(
                    t,
                    &catalog.view(),
                    choices,
                    &dr_samples::v3::ProjectedLines::default(),
                    &relation_times(&rows),
                )
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
    // History rows of an element with two values under one field name: the
    // first fills the field at that point, the others stay facts, as for the
    // current values (`crate::defaults`).
    for row in &history {
        let Some(category) =
            element_categories.get(&(row.project_id.clone(), row.entity_id.clone()))
        else {
            continue;
        };
        let mut fields = category_fields
            .get(&(row.project_id.clone(), category.clone()))
            .cloned()
            .unwrap_or_default();
        for r in &history {
            if r.entity_kind == "category"
                && &r.entity_id == category
                && let Some(t) = r
                    .meta
                    .as_deref()
                    .and_then(crate::meta::parse)
                    .and_then(|m| m.template_kv)
            {
                fields.extend(t.into_iter().map(|(k, _)| k));
            }
        }
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
            record(
                &mut adjusted,
                "duplicate-history-value-for-template-field",
                &row.project_id,
                "entity_snapshot_history",
                &row.id,
                "first value in the field, the others as facts",
            );
        }
    }
    let empty_non_text = BTreeMap::new();
    let books: BTreeMap<String, BookId> = legacy
        .projects()?
        .into_iter()
        .filter_map(|p| Some((p.id.clone(), BookId::parse(&p.id).ok()?)))
        .collect();
    for o in owners.iter().filter(|o| !bad_books.contains(&o.project_id)) {
        let Some(json) = o.cache.as_deref() else {
            continue;
        };
        let non_text = non_text_materials_by_book
            .get(&o.project_id)
            .unwrap_or(&empty_non_text);
        let mut found = Vec::new();
        inspect_json(
            &o.old_doc_id(),
            json,
            dr_model::ProseProfile::Prose,
            non_text,
            &mut found,
        );
        for f in found {
            if f.code == "unreadable-source-prose" {
                // The text is in this cache and nowhere the import can read.
                pending.push(f);
            } else {
                record(
                    &mut adjusted,
                    &f.code,
                    &o.project_id,
                    "prose",
                    &o.old_doc_id(),
                    "kept as text",
                );
            }
        }
        if let (Some(book), Ok(lines), Ok(old)) = (
            books.get(&o.project_id),
            crate::prose::pm::parse(json),
            DocId::parse(&o.new_doc_id()),
        ) && let Some(why) = unwritable(&dr_samples::v3::prose_id(book, &old), &lines, non_text)
        {
            pending.push(Pending {
                code: "prose-not-writable".into(),
                source: format!("{}: {why}", o.old_doc_id()),
            });
        }
    }
    for h in &history {
        let Some(json) = h.preview.as_deref() else {
            continue;
        };
        let non_text = non_text_materials_by_book
            .get(&h.project_id)
            .unwrap_or(&empty_non_text);
        let mut found = Vec::new();
        inspect_json(
            &h.id,
            json,
            dr_model::ProseProfile::Prose,
            non_text,
            &mut found,
        );
        for f in found {
            let (code, done) = if f.code == "unreadable-source-prose" {
                ("history-preview-unreadable", "skipped")
            } else {
                (f.code.as_str(), "kept as text")
            };
            record(
                &mut adjusted,
                code,
                &h.project_id,
                "entity_snapshot_history",
                &h.id,
                done,
            );
        }
    }
    pending.sort_by(|a, b| (&a.code, &a.source).cmp(&(&b.code, &b.source)));
    pending.dedup();
    adjusted.sort_by(|a, b| (&a.book, &a.code, &a.id).cmp(&(&b.book, &b.code, &b.id)));
    adjusted.dedup();
    Ok((pending, adjusted))
}

/// Why the book's prose writer would refuse this body, planned the way the
/// import plans it (without the cross-document maps, which only move
/// blocks): `None` when it takes it.
fn unwritable(
    doc_id: &DocId,
    lines: &crate::prose::pm::Prose,
    non_text: &BTreeMap<String, String>,
) -> Option<String> {
    let profile = doc_id.profile().unwrap_or(dr_model::ProseProfile::Prose);
    let blocks = crate::prose::doc_blocks(lines);
    let planned = crate::prose::plan_v3(
        lines,
        &blocks,
        &crate::prose::Context {
            profile,
            span: &|_| None,
            todo: &|_| None,
            asset: &|_| None,
            non_text_material: &|id| non_text.get(id).cloned(),
        },
    );
    let id_s = doc_id.to_string();
    let mut doc = match dr_doc::prose::ProseDoc::create(doc_id.clone(), import_peer(&id_s)) {
        Ok(d) => d,
        Err(e) => return Some(e.to_string()),
    };
    let (r, _) = doc.edit_at(Origin::Import, None, |t| {
        crate::prose::write::sync_v3(t, &planned.paras)
    });
    r.err().map(|e| e.to_string())
}

fn inspect_entity_link(
    attrs: Option<&Value>,
    source: &str,
    non_text_materials: &BTreeMap<String, String>,
    pending: &mut Vec<Pending>,
) {
    let Some(attrs) = attrs.and_then(Value::as_object) else {
        pending.push(Pending {
            code: "invalid-source-entity-link".into(),
            source: source.into(),
        });
        return;
    };
    let Some(target) = attrs
        .get("targetId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        pending.push(Pending {
            code: "invalid-source-entity-link".into(),
            source: source.into(),
        });
        return;
    };
    let raw_kind = attrs
        .get("targetKind")
        .and_then(Value::as_str)
        .unwrap_or("element");
    let old_kind = dr_model::import_v1::legacy::entity_kind(raw_kind);
    if old_kind == dr_model::kind::EntityKind::Material && non_text_materials.contains_key(target) {
        return;
    }
    let mapped_kind = dr_samples::v3::map_kind(&old_kind);
    if !mapped_kind.may_be_linked_v3() {
        pending.push(Pending {
            code: "unsupported-entity-link-target-kind".into(),
            source: source.into(),
        });
        return;
    }
    let valid_target = match mapped_kind {
        dr_model::kind::EntityKind::Entry => EntryId::parse(target).is_ok(),
        _ => false,
    };
    if !valid_target {
        pending.push(Pending {
            code: "invalid-source-entity-link".into(),
            source: source.into(),
        });
        return;
    }
    let m1 = attrs.get("module").filter(|v| !v.is_null());
    let m2 = attrs.get("targetModule").filter(|v| !v.is_null());
    if let (Some(a), Some(b)) = (m1, m2)
        && a != b
    {
        pending.push(Pending {
            code: "invalid-source-entity-link".into(),
            source: source.into(),
        });
        return;
    }
    if let Some(raw_mod) = m1.or(m2) {
        let valid_mod = mapped_kind == dr_model::kind::EntityKind::Entry
            && raw_mod.as_str().is_some_and(|s| ModuleId::parse(s).is_ok());
        if !valid_mod {
            pending.push(Pending {
                code: "invalid-source-entity-link".into(),
                source: source.into(),
            });
            return;
        }
    }
    for key in ["targetBlockId", "targetEndBlockId"] {
        if let Some(raw_block) = attrs.get(key).filter(|v| !v.is_null())
            && raw_block
                .as_str()
                .is_none_or(|s| s.is_empty() || BlockId::parse(s).is_err())
        {
            pending.push(Pending {
                code: "invalid-source-entity-link".into(),
                source: source.into(),
            });
            return;
        }
    }
}

fn inspect_json(
    source: &str,
    json: &str,
    _profile: dr_model::ProseProfile,
    non_text_materials: &BTreeMap<String, String>,
    pending: &mut Vec<Pending>,
) {
    if json.trim().is_empty() {
        return;
    }
    fn walk(
        v: &Value,
        source: &str,
        in_table: bool,
        is_mark: bool,
        non_text_materials: &BTreeMap<String, String>,
        pending: &mut Vec<Pending>,
    ) {
        if let Some(object) = v.as_object() {
            let kind = object.get("type").and_then(Value::as_str);
            if is_mark {
                if kind == Some("entityLink") {
                    inspect_entity_link(object.get("attrs"), source, non_text_materials, pending);
                } else if in_table {
                    let allowed = match kind {
                        Some("bold" | "italic" | "underline" | "strike" | "highlight" | "code") => {
                            true
                        }
                        Some("link") => object
                            .get("attrs")
                            .and_then(|a| a.get("href"))
                            .and_then(Value::as_str)
                            .is_some(),
                        _ => false,
                    };
                    if !allowed {
                        pending.push(Pending {
                            code: "unsupported-table-cell-mark".into(),
                            source: source.into(),
                        });
                    }
                }
                return;
            }
            let in_table = in_table || kind == Some("table");
            if in_table
                && let Some(k) = kind
                && !matches!(
                    k,
                    "table"
                        | "tableRow"
                        | "tableCell"
                        | "tableHeader"
                        | "paragraph"
                        | "text"
                        | "hardBreak"
                )
            {
                pending.push(Pending {
                    code: "unsupported-table-cell-content".into(),
                    source: source.into(),
                });
            }
            if let Some(marks) = object.get("marks").and_then(Value::as_array) {
                for mark in marks {
                    walk(mark, source, in_table, true, non_text_materials, pending);
                }
            }
            for (k, value) in object {
                if k == "marks" || k == "attrs" {
                    continue;
                }
                walk(value, source, in_table, false, non_text_materials, pending);
            }
        } else if let Some(array) = v.as_array() {
            for value in array {
                walk(
                    value,
                    source,
                    in_table,
                    is_mark,
                    non_text_materials,
                    pending,
                );
            }
        }
    }
    match serde_json::from_str(json) {
        Ok(value) => walk(&value, source, false, false, non_text_materials, pending),
        Err(_) => pending.push(Pending {
            code: "unreadable-source-prose".into(),
            source: source.into(),
        }),
    }
}

/// Stop the import on what [`findings`] cannot take; otherwise return what
/// it takes with a recorded default.
pub(crate) fn preflight(
    legacy: &Legacy,
    options: &Options,
) -> Result<Vec<crate::defaults::Adjustment>> {
    let (pending, adjusted) = findings(legacy, &options.v3)?;
    if !pending.is_empty() {
        return Err(ImportError::V3Pending(pending));
    }
    Ok(adjusted)
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
            let target_kind = dr_model::import_v1::legacy::entity_kind(
                row.target_kind.as_deref().unwrap_or_default(),
            );
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
        Owner::Material(id) => id.as_str(),
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
        // A field takes the first value under its name; the others are the
        // entry's own rows (`dr_samples::v3` `put_element`).
        let mut filled = BTreeSet::new();
        let mut in_fields = 0usize;
        for fact in facts {
            let def = template.as_ref().and_then(|t| {
                t.modules
                    .iter()
                    .flat_map(|m| &m.config.defs)
                    .find(|d| custom(&d.id) && d.name == fact.key)
            });
            match def {
                Some(def) if filled.insert(def.id.clone()) => {
                    in_fields += 1;
                    if field(&entry, &def.id).as_str() != Some(fact.value.as_str()) {
                        return false;
                    }
                }
                _ => {
                    if !kv.iter().any(|k| {
                        k.id == fact.id
                            && k.key == fact.key
                            && k.value == fact.value
                            && k.pos == fact.pos
                    }) {
                        return false;
                    }
                }
            }
        }
        if kv.len() + in_fields != facts.len() {
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
            let want_default = (!f.value.is_empty()).then(|| FieldValue::Text(f.value.clone()));
            defs.get(f.id.as_str()).is_none_or(|d| {
                d.name != f.key || d.pos != f.pos || d.default_value != want_default
            })
        }) {
            return false;
        }
    }
    true
}
