//! Writing a plan through F3's commands (`Workspace::call`, the path the
//! interface, the Agent, MCP and the command line share), so every rule the
//! command layer checks (unique names, live targets, relation types) checks
//! the seed too. Paragraph formatting (headings, task items, quotes, entity
//! links) goes through the workspace's editing sessions, as the editor's
//! would. Slower than the direct writer; the two produce the same
//! [`super::digest`].

use dr_model::DocId;
use dr_model::book::EntityRef;
use dr_model::kind::{EntityKind, NodeStatus};
use dr_workspace::{Actor, Workspace};
use serde_json::{Value, json};

use super::build::format_paras;
use super::plan::{self, Plan};
use crate::text::{self, Para};

/// What a command-written book took.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandBook {
    pub book: String,
    pub commands: usize,
    pub prose_edits: usize,
}

struct Writer<'a> {
    ws: &'a Workspace,
    actor: &'a Actor,
    commands: usize,
    prose_edits: usize,
}

impl Writer<'_> {
    fn call(&mut self, name: &str, input: Value) -> Result<Value, String> {
        self.commands += 1;
        let out = self
            .ws
            .call(self.actor, name, input)
            .map_err(|e| format!("{name}: {e}"))?;
        Ok(out["output"].clone())
    }

    fn create(&mut self, name: &str, input: Value) -> Result<String, String> {
        let out = self.call(name, input)?;
        out["id"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| format!("{name} returned no id: {out}"))
    }

    /// Headings, task items, quotes, styles and links of a body the command
    /// already wrote as plain paragraphs.
    fn format(&mut self, doc: DocId, paras: &[Para], targets: &[EntityRef]) -> Result<(), String> {
        let needs = paras.iter().any(|p| {
            p.heading.is_some()
                || p.task.is_some()
                || p.list.is_some()
                || p.quote
                || !p.links.is_empty()
                || !p.styles.is_empty()
        });
        if !needs {
            return Ok(());
        }
        let session = self
            .ws
            .prose_session(&doc.to_string())
            .map_err(|e| e.to_string())?;
        let (paras, targets) = (paras.to_vec(), targets.to_vec());
        session
            .edit(move |t| format_paras(t, &paras, &targets).map(|_| ()))
            .map_err(|e| format!("format {doc}: {e}"))?;
        self.prose_edits += 1;
        Ok(())
    }
}

fn status(s: &NodeStatus) -> &str {
    s.as_str()
}

/// Write `p` through the workspace as `actor` (normally `Actor::Import`).
pub(crate) fn write(ws: &Workspace, actor: &Actor, p: &Plan) -> Result<CommandBook, String> {
    let mut w = Writer {
        ws,
        actor,
        commands: 0,
        prose_edits: 0,
    };
    let book = w.create(
        "book.create",
        json!({ "name": p.name, "summary": plan::BOOK_SUMMARY }),
    )?;
    w.call(
        "book.update",
        json!({ "book": book, "word_target": p.word_target, "daily_word_target": p.daily_word_target }),
    )?;
    for (key, value) in &p.facts {
        w.call(
            "fact.put",
            json!({ "book": book, "key": key, "value": value }),
        )?;
    }
    let mut storylines = Vec::new();
    for (_, s) in &p.storylines {
        storylines.push(w.create(
            "storyline.create",
            json!({ "book": book, "name": s.name, "color": s.color, "summary": s.summary, "text": text::plain(&s.body) }),
        )?);
    }
    let mut categories = Vec::new();
    for (_, c) in &p.categories {
        categories.push(w.create(
            "category.create",
            json!({ "book": book, "name": c.name, "color": c.color, "text": text::plain(&c.body) }),
        )?);
    }
    let mut elements = Vec::new();
    for e in &p.elements {
        let id = w.create(
            "element.create",
            json!({
                "book": book, "name": e.name, "summary": e.summary,
                "category": categories[e.category], "aliases": e.aliases,
                "text": text::plain(&e.body),
            }),
        )?;
        if !e.facts.is_empty() {
            let fields: Vec<Value> = e
                .facts
                .iter()
                .map(|(k, v)| json!({ "key": k, "value": v }))
                .collect();
            w.call(
                "element.update",
                json!({ "book": book, "id": id, "put_fields": fields }),
            )?;
        }
        elements.push(id);
    }
    let targets: Vec<EntityRef> = elements
        .iter()
        .map(|e| EntityRef::new(EntityKind::Element, e.as_str()))
        .collect();
    let (rt_name, source_role, target_role) = plan::RELATION_TYPE;
    let rt = w.create(
        "relation_type.create",
        json!({
            "book": book, "name": rt_name, "orientation": "directed",
            "source_role": source_role, "target_role": target_role,
            "source_kinds": ["element"], "target_kinds": ["element"],
        }),
    )?;
    for (_, a, z) in &p.relations {
        w.call(
            "relation.create",
            json!({
                "book": book, "relation_type": rt,
                "from": { "kind": "element", "id": elements[*a] },
                "to": { "kind": "element", "id": elements[*z] },
            }),
        )?;
    }

    let mut chapters = Vec::new();
    for (i, c) in p.chapters.iter().enumerate() {
        let id = w.create(
            "chapter.create",
            json!({
                "book": book, "title": c.title, "summary": plan::CHAPTER_SUMMARY,
                "storyline": storylines[c.storylines[0]], "text": text::plain(&c.body),
            }),
        )?;
        let more: Vec<&String> = c.storylines[1..].iter().map(|s| &storylines[*s]).collect();
        w.call(
            "chapter.update",
            json!({
                "book": book, "id": id, "status": status(&c.status),
                "narrative_order": Plan::order(i), "add_storylines": more,
            }),
        )?;
        chapters.push(id);
    }
    for (a, (_, name, first)) in p.acts.iter().enumerate() {
        let mut input = json!({ "book": book, "name": name });
        if a > 0 {
            input["start_chapter"] = json!(chapters[*first]);
        }
        w.call("act.create", input)?;
    }

    let mut groups = Vec::new();
    for (_, name) in &p.idea_groups {
        groups.push(w.create("idea_group.create", json!({ "book": book, "name": name }))?);
    }
    let mut ideas = Vec::new();
    for idea in &p.ideas {
        let mut input = json!({
            "book": book, "title": idea.title, "position": [idea.x, idea.y],
            "text": text::plain(&idea.body),
        });
        if let Some(g) = idea.group {
            input["group"] = json!(groups[g]);
        }
        let id = w.create("idea.create", input)?;
        if idea.status != NodeStatus::Drifting {
            w.call(
                "idea.update",
                json!({ "book": book, "id": id, "status": status(&idea.status) }),
            )?;
        }
        ideas.push(id);
    }

    let mut folders = Vec::new();
    for (_, name) in &p.folders {
        folders.push(w.create(
            "material_folder.create",
            json!({ "book": book, "name": name }),
        )?);
    }
    let mut materials = Vec::new();
    for m in &p.materials {
        let mut input = json!({
            "book": book, "kind": "text", "title": m.title, "text": text::plain(&m.body),
        });
        if let Some(f) = m.folder {
            input["folder"] = json!(folders[f]);
        }
        let id = w.create("material.create", input)?;
        w.call(
            "material.update",
            json!({ "book": book, "id": id, "task_todos": m.task_todos }),
        )?;
        materials.push(id);
    }

    // Formatting, through editing sessions.
    let storyline_ids = storylines.iter().zip(&p.storylines);
    for (id, (_, s)) in storyline_ids {
        w.format(
            DocId::parse(&format!("storyline:{id}")).map_err(|e| e.to_string())?,
            &s.body,
            &[],
        )?;
    }
    for (id, (_, c)) in categories.iter().zip(&p.categories) {
        w.format(
            DocId::parse(&format!("category:{id}")).map_err(|e| e.to_string())?,
            &c.body,
            &[],
        )?;
    }
    for (id, e) in elements.iter().zip(&p.elements) {
        w.format(
            DocId::parse(&format!("element:{id}")).map_err(|e| e.to_string())?,
            &e.body,
            &[],
        )?;
    }
    for (id, c) in chapters.iter().zip(&p.chapters) {
        w.format(
            DocId::parse(&format!("node:{id}")).map_err(|e| e.to_string())?,
            &c.body,
            &targets,
        )?;
    }
    for (id, idea) in ideas.iter().zip(&p.ideas) {
        w.format(
            DocId::parse(&format!("node:{id}")).map_err(|e| e.to_string())?,
            &idea.body,
            &targets,
        )?;
    }
    for (id, m) in materials.iter().zip(&p.materials) {
        w.format(
            DocId::parse(&format!("material:{id}")).map_err(|e| e.to_string())?,
            &m.body,
            &[],
        )?;
    }

    for c in &p.comments {
        let chapter = &chapters[c.chapter];
        let block = ws
            .prose_session(&format!("node:{chapter}"))
            .map_err(|e| e.to_string())?
            .reader()
            .view()
            .blocks()
            .get(c.para)
            .and_then(|b| b.id.clone());
        let mut input = json!({
            "book": book, "kind": if c.todo { "todo" } else { "note" },
            "target": { "kind": "node", "id": chapter }, "body": c.body,
        });
        if let Some(b) = block {
            input["block_id"] = json!(b.to_string());
        }
        if c.range.0 < c.range.1 {
            input["range"] = json!([c.range.0, c.range.1]);
        }
        if let Some(pr) = c.priority {
            input["priority"] = json!(pr);
        }
        let id = w.create("comment.create", input)?;
        if c.resolved {
            w.call(
                "comment.update",
                json!({ "book": book, "id": id, "status": "resolved" }),
            )?;
        }
    }
    for (_, body) in &p.memory {
        w.call(
            "memory.add",
            json!({ "book": book, "body": body, "kind": "preference" }),
        )?;
    }
    Ok(CommandBook {
        book,
        commands: w.commands,
        prose_edits: w.prose_edits,
    })
}
