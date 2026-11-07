//! A book read back into a canonical form that does not depend on how it
//! was written: entities by name instead of id, orders as sequences, prose
//! as paragraphs with their attributes and links by target name. The direct
//! writer and the command writer must produce the same digest.
//!
//! Left out on purpose: ids, timestamps and peers (the commands make their
//! own), chapters' book-order numbers (the commands place chapters
//! themselves; the reading order is compared), category layouts, and the
//! two things no command writes yet: writing days and time pins (see
//! `f8-testkit.md` "待协调").

use std::collections::BTreeMap;

use dr_doc::book::{BookDoc, BookView};
use dr_doc::prose::ProseDoc;
use dr_model::DocId;
use dr_model::book::EntityRef;
use dr_model::id::BookId;
use dr_model::kind::EntityKind;
use serde_json::{Value, json};

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn load(lib: &dr_store::Library, id: &str) -> Result<Vec<u8>, String> {
    lib.load_copy(id)
        .map_err(err)?
        .export(loro::ExportMode::Snapshot)
        .map_err(err)
}

/// The digest of book `book` as stored in `lib`.
pub fn digest(lib: &dr_store::Library, book: &str) -> Result<Value, String> {
    let book_id = BookId::parse(book).map_err(err)?;
    let doc = BookDoc::load(book_id, 1, &[load(lib, &format!("book:{book}"))?]).map_err(err)?;
    let v = doc.view();
    let names = Names::of(&v);
    let prose = |d: DocId| -> Result<Value, String> {
        let id = d.to_string();
        if lib.doc_info(&id).map_err(err)?.is_none() {
            return Ok(Value::Null);
        }
        let p = ProseDoc::load(d, 1, &[load(lib, &id)?]).map_err(err)?;
        Ok(prose_digest(&p, &names))
    };

    let meta = v.meta();
    let mut facts: Vec<(String, String)> =
        v.facts().into_iter().map(|f| (f.key, f.value)).collect();
    facts.sort();
    let mut storylines = v.storylines();
    storylines.sort_by(|a, b| a.pos.cmp(&b.pos));
    let storylines: Vec<Value> = storylines
        .into_iter()
        .map(|s| {
            Ok(json!([
                s.name,
                s.color,
                s.summary,
                prose(DocId::Storyline(s.id))?
            ]))
        })
        .collect::<Result<_, String>>()?;
    let mut categories: Vec<Value> = v
        .categories()
        .into_iter()
        .map(|c| Ok(json!([c.name, c.color, prose(DocId::Category(c.id))?])))
        .collect::<Result<_, String>>()?;
    categories.sort_by_key(|c| c.to_string());
    let mut elements: Vec<Value> = v
        .elements()
        .into_iter()
        .map(|e| {
            let mut facts: Vec<(String, String)> = e
                .facts
                .iter()
                .map(|f| (f.key.clone(), f.value.clone()))
                .collect();
            facts.sort();
            Ok(json!({
                "name": e.name,
                "category": e.category.as_ref().map(|c| names.category(c.as_str())),
                "summary": e.summary,
                "aliases": e.aliases,
                "facts": facts,
                "body": prose(DocId::Element(e.id))?,
            }))
        })
        .collect::<Result<_, String>>()?;
    elements.sort_by_key(|e| e["name"].to_string());
    let mut relation_types: Vec<Value> = v
        .relation_types()
        .into_iter()
        .filter(|t| t.system_key.is_none())
        .map(|t| {
            json!([
                t.name,
                t.orientation.as_str(),
                t.source_role,
                t.target_role,
                t.source_kinds
                    .iter()
                    .map(|k| k.as_str())
                    .collect::<Vec<_>>(),
                t.target_kinds
                    .iter()
                    .map(|k| k.as_str())
                    .collect::<Vec<_>>(),
            ])
        })
        .collect();
    relation_types.sort_by_key(|t| t.to_string());
    let type_names: BTreeMap<String, String> = v
        .relation_types()
        .into_iter()
        .map(|t| (t.id.to_string(), t.name))
        .collect();
    let mut relations: Vec<Value> = v
        .relations()
        .into_iter()
        .map(|r| {
            json!([
                type_names.get(r.relation_type.as_str()),
                names.entity(&r.from),
                names.entity(&r.to),
            ])
        })
        .collect();
    relations.sort_by_key(|r| r.to_string());

    let chapters = v.chapters();
    let acts: Vec<Value> = v
        .acts()
        .into_iter()
        .map(|a| {
            // An act covers the chapters at or after its start
            // (`dr_model::order::act_index_for_order`).
            let first = chapters.iter().find(|c| {
                a.start_order
                    .is_none_or(|s| c.book_order.is_some_and(|o| o >= s))
            });
            json!([a.name, first.map(|c| c.title.clone())])
        })
        .collect();
    let chapters: Vec<Value> = chapters
        .into_iter()
        .map(|c| {
            let lines: Vec<&str> = c
                .storylines
                .iter()
                .map(|s| names.storyline(s.as_str()))
                .collect();
            Ok(json!({
                "title": c.title,
                "summary": c.summary,
                "status": c.status.as_str(),
                "narrativeOrder": c.narrative_order,
                "storylines": sorted(lines),
                "primary": c.primary_storyline.as_ref().map(|s| names.storyline(s.as_str())),
                "body": prose(DocId::Node(c.id))?,
            }))
        })
        .collect::<Result<_, String>>()?;

    let groups: BTreeMap<String, String> = v
        .drift_groups()
        .into_iter()
        .map(|g| (g.id.to_string(), g.name))
        .collect();
    let mut ideas: Vec<Value> = v
        .drifts()
        .into_iter()
        .map(|n| {
            Ok(json!({
                "title": n.title,
                "status": n.status.as_str(),
                "group": n.group.as_ref().and_then(|g| groups.get(g.as_str())),
                "position": [n.x, n.y],
                "body": prose(DocId::Node(n.id))?,
            }))
        })
        .collect::<Result<_, String>>()?;
    ideas.sort_by_key(|i| i["title"].to_string());
    let folders: BTreeMap<String, String> = v
        .material_folders()
        .into_iter()
        .map(|f| (f.id.to_string(), f.name))
        .collect();
    let mut materials = v.materials();
    materials.sort_by(|a, b| a.pos.cmp(&b.pos));
    let materials: Vec<Value> = materials
        .into_iter()
        .map(|m| {
            Ok(json!({
                "title": m.title,
                "kind": m.kind.as_str(),
                "folder": m.folder.as_ref().and_then(|f| folders.get(f.as_str())),
                "taskTodos": m.task_todos,
                "body": prose(DocId::Material(m.id))?,
            }))
        })
        .collect::<Result<_, String>>()?;
    let mut comments: Vec<Value> = v
        .comments()
        .into_iter()
        .map(|c| {
            json!({
                "kind": c.kind.as_str(),
                "status": c.status.as_str(),
                "priority": c.priority.as_ref().map(|p| p.as_str().to_string()),
                "target": c.target.as_ref().map(|t| names.entity(t)),
                "quote": c.quote,
                "snapshots": c.snapshots.iter().map(|s| s.text.clone()).collect::<Vec<_>>(),
                "anchored": c.anchor.is_some(),
                "body": c.body,
            })
        })
        .collect();
    comments.sort_by_key(|c| c.to_string());
    let memory: Vec<String> = sorted(
        v.memory()
            .into_iter()
            .filter(|m| m.deleted_at.is_none())
            .map(|m| m.body)
            .collect(),
    );

    Ok(json!({
        "meta": {
            "name": meta.name,
            "summary": meta.summary,
            "wordTarget": meta.word_target_set,
            "dailyWordTarget": meta.daily_word_target_set,
        },
        "facts": facts,
        "storylines": storylines,
        "categories": categories,
        "elements": elements,
        "relationTypes": relation_types,
        "relations": relations,
        "acts": acts,
        "chapters": chapters,
        "ideaGroups": sorted(groups.into_values().collect()),
        "ideas": ideas,
        "materialFolders": sorted(folders.into_values().collect()),
        "materials": materials,
        "comments": comments,
        "memory": memory,
    }))
}

fn sorted<T: Ord>(mut v: Vec<T>) -> Vec<T> {
    v.sort();
    v
}

/// Ids to names, for every kind an entity reference can name.
struct Names {
    map: BTreeMap<(String, String), String>,
}

impl Names {
    fn of(v: &BookView<'_>) -> Self {
        let mut map = BTreeMap::new();
        let mut put = |k: EntityKind, id: String, name: String| {
            map.insert((k.as_str().to_string(), id), name);
        };
        for n in v.nodes() {
            put(EntityKind::Node, n.id.to_string(), n.title);
        }
        for e in v.elements() {
            put(EntityKind::Element, e.id.to_string(), e.name);
        }
        for s in v.storylines() {
            put(EntityKind::Storyline, s.id.to_string(), s.name);
        }
        for c in v.categories() {
            put(EntityKind::Category, c.id.to_string(), c.name);
        }
        for m in v.materials() {
            put(EntityKind::Material, m.id.to_string(), m.title);
        }
        Self { map }
    }

    fn get(&self, kind: &str, id: &str) -> &str {
        self.map
            .get(&(kind.to_string(), id.to_string()))
            .map_or("?", String::as_str)
    }

    fn entity(&self, r: &EntityRef) -> String {
        format!("{}:{}", r.kind.as_str(), self.get(r.kind.as_str(), &r.id))
    }

    fn storyline(&self, id: &str) -> &str {
        self.get("storyline", id)
    }

    fn category(&self, id: &str) -> &str {
        self.get("category", id)
    }
}

/// Paragraphs (heading level, list kind, ticked, quote, text) and entity
/// links (range in the document, target name).
fn prose_digest(p: &ProseDoc, names: &Names) -> Value {
    let v = p.view();
    let paragraphs: Vec<Value> = v
        .paragraphs()
        .map(|para| {
            let a = &para.attrs;
            let styles: Vec<Value> = {
                let mut out = Vec::new();
                let mut at = 0usize;
                for r in &para.runs {
                    let n = r.text.chars().count();
                    if r.marks.bold || r.marks.italic {
                        out.push(json!([at, at + n, r.marks.bold, r.marks.italic]));
                    }
                    at += n;
                }
                out
            };
            json!([
                a.heading.map(|h| h.level()),
                a.list.as_ref().map(|l| l.as_str().to_string()),
                a.checked,
                a.quote,
                para.text(),
                styles,
            ])
        })
        .collect();
    let links: Vec<Value> = v
        .entity_links()
        .into_iter()
        .map(|(r, l)| json!([r.start, r.end, names.get(l.kind.as_str(), &l.target)]))
        .collect();
    json!({ "paragraphs": paragraphs, "links": links })
}
