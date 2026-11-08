//! Resolve author names through F3 queries and bind every invocation to its
//! current book. This is identity projection, never a mutation implementation.

use std::collections::{BTreeSet, HashMap};

use dr_model::{DocId, id::BookId};
use dr_workspace::{Actor, Workspace, registry};
use serde_json::{Value, json};

use crate::{Error, Result, catalog::allowed};

#[derive(Clone, Debug)]
pub struct ResolvedCall {
    pub name: String,
    pub arguments: Value,
    /// Stable document identities for the read-before-write guard. Metadata
    /// shares the book document; prose keeps its own document identity.
    pub targets: Vec<String>,
    /// Author objects whose contents the caller must have actually read.
    /// A shared book frontier is a CAS token, not permission to edit every
    /// entity stored in that document.
    pub subjects: Vec<String>,
}

pub fn resolve(ws: &Workspace, book: &BookId, name: &str, mut args: Value) -> Result<ResolvedCall> {
    let spec = registry()
        .get(name)
        .filter(|spec| allowed(spec))
        .ok_or_else(|| invalid(format!("tool {name:?} is not in this book's catalog")))?;
    let schema = spec.input_schema();
    let properties = &schema.as_value()["properties"];
    let obj = args
        .as_object_mut()
        .ok_or_else(|| invalid("tool arguments must be an object"))?;
    if let Some(given) = obj.get("book")
        && given.as_str() != Some(book.as_str())
    {
        return Err(invalid("tool belongs to another book"));
    }
    let mut resolver = Resolver {
        ws,
        book,
        rows: HashMap::new(),
        targets: BTreeSet::new(),
    };
    if properties.get("book").is_some() {
        obj.insert("book".into(), book.to_string().into());
        resolver.targets.insert(format!("book:{book}"));
    }
    if let Some(doc) = obj.get_mut("doc") {
        let resolved = resolver.document(doc, name.starts_with("prose."))?;
        resolver.targets.insert(resolved.clone());
        *doc = resolved.into();
    }
    // These operations deliberately have no top-level book input.
    if let Some(session) = obj.get("session") {
        resolver.history_session(string(session, "session")?, obj.get("turn"))?;
    }
    let domain = name.split_once('.').expect("registry name").0;
    let verb = name.split_once('.').expect("registry name").1;
    for key in ["target", "entity", "from", "to"] {
        if let Some(value) = obj.get_mut(key)
            && value.is_object()
        {
            resolver.target(value)?;
        }
    }
    // Links carry documents and targets under an array; checking only the
    // outer arguments would let a caller cross the current book boundary.
    if let Some(links) = obj.get_mut("links") {
        for link in links
            .as_array_mut()
            .ok_or_else(|| invalid("links must be an array"))?
        {
            let doc = link
                .get_mut("doc")
                .ok_or_else(|| invalid("link needs a document"))?;
            let resolved = resolver.document(doc, true)?;
            resolver.targets.insert(resolved.clone());
            *doc = resolved.into();
            resolver.target(
                link.get_mut("target")
                    .ok_or_else(|| invalid("link needs a target"))?,
            )?;
        }
    }
    for (key, kind) in [
        ("category", "category"),
        ("storyline", "storyline"),
        ("primary_storyline", "storyline"),
        ("element", "element"),
        ("source", "node"),
        ("node", "node"),
        ("start_chapter", "chapter"),
        ("drift", "idea"),
        ("idea", "idea"),
        ("group", "idea_group"),
        ("folder", "material_folder"),
        ("relation_type", "relation_type"),
    ] {
        if let Some(value) = obj.get_mut(key) {
            if value.is_null() || (key == "folder" && value == "" && name == "material.list") {
                continue;
            }
            *value = resolver.identity(kind, value, None)?.into();
        }
    }
    if let Some(parent) = obj.get_mut("parent")
        && !parent.is_null()
    {
        *parent = resolver.identity(domain, parent, None)?.into();
    }
    for key in ["add_storylines", "remove_storylines"] {
        if let Some(values) = obj.get_mut(key) {
            for value in values
                .as_array_mut()
                .ok_or_else(|| invalid("storylines must be an array"))?
            {
                *value = resolver.identity("storyline", value, None)?.into();
            }
        }
    }
    // A supplied id on create is an optional new identity, not a reference.
    if !matches!(verb, "create" | "add" | "line_add")
        && let Some(value) = obj.get_mut("id")
        && !value.is_null()
        && entity_domain(domain)
    {
        *value = resolver.identity(domain, value, None)?.into();
    }
    for (key, kind) in [("chapters", "chapter"), ("acts", "act")] {
        if let Some(values) = obj.get_mut(key) {
            for item in values
                .as_array_mut()
                .ok_or_else(|| invalid("arrangement must be an array"))?
            {
                let id = item
                    .get_mut("id")
                    .ok_or_else(|| invalid("arrangement needs a target"))?;
                *id = resolver.identity(kind, id, None)?.into();
            }
        }
    }
    if let Some(place) = obj.get_mut("place")
        && let Some(map) = place.as_object_mut()
    {
        for key in ["after", "before"] {
            if let Some(value) = map.get_mut(key)
                && entity_domain(domain)
            {
                *value = resolver.identity(domain, value, None)?.into();
            }
        }
    }
    if let Some(entities) = obj.get_mut("entities") {
        for entity in entities
            .as_array_mut()
            .ok_or_else(|| invalid("entities must be an array"))?
        {
            let collection = entity
                .get("collection")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid("restoration needs a collection"))?;
            let kind = collection_kind(collection)
                .ok_or_else(|| invalid("unsupported restoration collection"))?
                .to_owned();
            // A purged entity exists only in history. F3 validates that its
            // old identity is present in the requested version of this book.
            let id = entity
                .get_mut("id")
                .ok_or_else(|| invalid("restoration needs an id"))?;
            if !looks_like_id(string(id, "id")?) {
                *id = resolver.identity(&kind, id, None)?.into();
            }
        }
    }
    // Plot-grid line identities are local to their resolved node, not names
    // from another grid. Field identities similarly belong to one owner.
    if domain == "plot_grid" {
        resolver.grid_fields(verb, &mut args)?;
    }
    if matches!(domain, "fact" | "category_template" | "storyline_template")
        && matches!(verb, "put" | "remove")
    {
        resolver.list_fields(name, &mut args)?;
    }
    if matches!(domain, "element" | "storyline") && verb == "update" {
        resolver.entity_fields(domain, &mut args)?;
    }
    for key in ["asset", "portrait"] {
        if let Some(id) = args.get(key).filter(|id| !id.is_null()) {
            resolver.query("asset.get", json!({"book":book,"id":string(id,key)?}))?;
        }
    }
    if domain.ends_with("_template") && matches!(verb, "body" | "set_body") {
        let owner = if domain == "chapter_template" {
            "storyline"
        } else {
            "category"
        };
        if let Some(id) = args[owner].as_str() {
            let doc = format!("template:{owner}:{id}");
            if verb == "set_body"
                || resolver
                    .ws
                    .library()
                    .doc_info(&doc)
                    .map_err(dr_agent::Error::from)?
                    .is_some()
            {
                resolver.targets.insert(doc);
            }
        }
    }
    let subjects = subjects(name, &args);
    Ok(ResolvedCall {
        name: name.to_owned(),
        arguments: args,
        targets: resolver.targets.into_iter().collect(),
        subjects,
    })
}

/// Read coverage comes only from successful returned data. A filtered list
/// can establish observations for its returned rows, never for absent rows
/// or the entire collection. Call this with F3's output (or its Outcome).
pub fn coverage(name: &str, args: &Value, output: &Value) -> Vec<String> {
    let output = output.get("output").unwrap_or(output);
    let Some((domain, verb)) = name.split_once('.') else {
        return Vec::new();
    };
    let mut read = BTreeSet::new();
    if domain == "history" && verb == "agent_changes" {
        read.extend(subjects(name, args));
    } else if domain == "prose" && verb == "read" {
        if let Some(doc) = args["doc"].as_str() {
            read.insert(format!("prose:{doc}"));
        }
    } else if domain == "plot_grid" && verb == "get" {
        if let Some(node) = output["node"].as_str() {
            read.insert(format!("plot_grid:{node}"));
        }
    } else if domain.ends_with("_template") && matches!(verb, "list" | "body") {
        read.extend(subjects(name, args));
    } else if verb == "list" {
        if let Some(rows) = output.as_array() {
            for row in rows {
                if let Some(id) = row["id"].as_str() {
                    read.insert(format!("{domain}:{id}"));
                    if matches!(domain, "chapter" | "idea") {
                        read.insert(format!("node:{id}"));
                    }
                }
            }
            if domain == "patch"
                && let Some(element) = args["element"].as_str()
            {
                read.insert(format!("patches:{element}"));
            }
            let unfiltered = args.as_object().is_some_and(|args| {
                args.iter().all(|(key, value)| {
                    matches!(key.as_str(), "book" | "trashed" | "removed") || value.is_null()
                })
            });
            if unfiltered {
                read.insert(format!("{domain}:*"));
                if args["trashed"] == true
                    && registry().get(name).is_some_and(|spec| {
                        spec.input_schema().as_value()["properties"]
                            .get("trashed")
                            .is_some()
                    })
                {
                    read.insert(format!("{domain}:all"));
                }
            }
        }
    } else if verb == "get"
        && let Some(id) = output["id"].as_str()
    {
        read.insert(format!("{domain}:{id}"));
    }
    read.into_iter().collect()
}

fn subjects(name: &str, args: &Value) -> Vec<String> {
    let Some((domain, verb)) = name.split_once('.') else {
        return Vec::new();
    };
    let mut subjects = BTreeSet::new();
    let mut add = |kind: &str, id: &str| {
        subjects.insert(format!("{kind}:{id}"));
    };
    if domain == "prose" {
        if let Some(doc) = args["doc"].as_str() {
            subjects.insert(format!("prose:{doc}"));
        }
        if let Some(links) = args["links"].as_array() {
            for link in links {
                if let Some(doc) = link["doc"].as_str() {
                    subjects.insert(format!("prose:{doc}"));
                }
            }
        }
    } else if domain == "history" && matches!(verb, "agent_changes" | "undo_agent") {
        if let Some(session) = args["session"].as_str() {
            let scope = args["turn"]
                .as_u64()
                .map(|turn| format!("{session}:{turn}"))
                .unwrap_or_else(|| session.into());
            add("history", &scope);
        }
    } else if domain == "history" && verb == "restore_entities" {
        if let Some(entities) = args["entities"].as_array() {
            for entity in entities {
                if let (Some(collection), Some(id)) =
                    (entity["collection"].as_str(), entity["id"].as_str())
                {
                    add(collection_kind(collection).unwrap_or(collection), id);
                }
            }
        }
    } else if domain == "history" {
        if let Some(doc) = args["doc"].as_str() {
            subjects.insert(if doc.starts_with("book:") {
                doc.into()
            } else {
                format!("prose:{doc}")
            });
        }
    } else if domain == "plot_grid" {
        if let Some(node) = args["node"].as_str() {
            add("plot_grid", node);
        }
    } else if domain.ends_with("_template") {
        let owner = if domain == "chapter_template" {
            "storyline"
        } else {
            "category"
        };
        let id = args[owner].as_str().or_else(|| args["book"].as_str());
        if let Some(id) = id {
            if matches!(verb, "body" | "set_body") {
                add("prose", &format!("template:{owner}:{id}"));
            } else {
                add(domain, id);
            }
        }
    } else if domain == "book" {
        if let Some(book) = args["book"].as_str() {
            add("book", book);
        }
    } else if name == "patch.create" {
        if let Some(element) = args["element"].as_str() {
            add("patches", element);
        }
    } else if matches!(verb, "create" | "add") || (verb == "put" && args["id"].is_null()) {
        add(domain, "*");
    } else if name == "chapter.arrange" {
        for (key, kind) in [("chapters", "chapter"), ("acts", "act")] {
            if let Some(rows) = args[key].as_array() {
                for row in rows {
                    if let Some(id) = row["id"].as_str() {
                        add(kind, id);
                    }
                }
            }
        }
    } else if name == "chapter.spread" {
        add("chapter", "*");
        if args["axis"] == "book" {
            add("act", "*");
        }
    } else if let Some(id) = args["id"].as_str() {
        add(domain, id);
    }
    // Cascades change more than the selected entity. Require successful
    // collection reads for those related records as well, at the same book
    // revision. The guard drops all old coverage when that revision changes.
    if verb == "purge" || matches!(name, "material.delete" | "patch.delete") {
        // relation.list deliberately hides edges with deleted endpoints;
        // those rows have not been read merely because the live list ended.
        // F3 needs an all-record or affected-edge query to grant this scope.
        subjects.insert("relation:all".into());
        subjects.insert("comment:*".into());
    }
    let cascades: &[&str] = match name {
        "chapter.purge" | "idea.purge" => &["act:*", "time_pin:*"],
        "category.purge" => &["element:all"],
        "storyline.purge" => &["chapter:all", "idea:all"],
        "relation_type.delete" => &["relation:all"],
        "material_folder.delete" => &["material_folder:*", "material:*"],
        "idea_group.delete" => &["idea_group:*", "idea:all"],
        _ => &[],
    };
    subjects.extend(cascades.iter().map(|s| (*s).to_owned()));
    if name == "element.purge"
        && let Some(element) = args["id"].as_str()
    {
        subjects.insert(format!("patches:{element}"));
    }
    subjects.into_iter().collect()
}

struct Resolver<'a> {
    ws: &'a Workspace,
    book: &'a BookId,
    rows: HashMap<String, Vec<Value>>,
    targets: BTreeSet<String>,
}

impl Resolver<'_> {
    fn query(&self, name: &str, args: Value) -> Result<Value> {
        Ok(self.ws.call(&Actor::User, name, args)?["output"].clone())
    }

    fn rows(&mut self, kind: &str) -> Result<Vec<Value>> {
        if let Some(rows) = self.rows.get(kind) {
            return Ok(rows.clone());
        }
        let query = match kind {
            "chapter" => "chapter.list",
            "idea" => "idea.list",
            "element" => "element.list",
            "category" => "category.list",
            "storyline" => "storyline.list",
            "act" => "act.list",
            "idea_group" => "idea_group.list",
            "material" => "material.list",
            "material_folder" => "material_folder.list",
            "comment" => "comment.list",
            "relation" => "relation.list",
            "relation_type" => "relation_type.list",
            "memory" => "memory.list",
            "time_pin" => "time_pin.list",
            "fact" => "fact.list",
            "node" => {
                let mut rows = self.rows("chapter")?;
                rows.extend(self.rows("idea")?);
                self.rows.insert(kind.into(), rows.clone());
                return Ok(rows);
            }
            "patch" => {
                let mut rows = Vec::new();
                for element in self.rows("element")? {
                    let values = self.query(
                        "patch.list",
                        json!({"book":self.book,"element":element["id"]}),
                    )?;
                    rows.extend(array(values)?);
                }
                self.rows.insert(kind.into(), rows.clone());
                return Ok(rows);
            }
            _ => return Err(invalid(format!("unsupported author target kind {kind:?}"))),
        };
        let rows = array(self.query(
            query,
            json!({"book":self.book,"trashed":true,"removed":true}),
        )?)?;
        self.rows.insert(kind.into(), rows.clone());
        Ok(rows)
    }

    fn identity(&mut self, kind: &str, value: &Value, category: Option<&str>) -> Result<String> {
        let name = string(value, "target name or id")?;
        if name.trim().is_empty() {
            return Err(invalid("target name is empty"));
        }
        let rows = self.rows(kind)?;
        let category = category
            .map(|name| self.identity("category", &Value::String(name.into()), None))
            .transpose()?;
        select(&rows, name, category.as_deref())
    }

    fn document(&mut self, value: &Value, prose_only: bool) -> Result<String> {
        let doc = if let Some(raw) = value.as_str() {
            DocId::parse(raw)
                .map_err(|_| invalid("a document needs its id or a kind/name selector"))?
        } else {
            let kind = value["kind"]
                .as_str()
                .ok_or_else(|| invalid("document selector needs kind"))?;
            let kind = normalize_kind(kind)?;
            let name = value
                .get("name")
                .or_else(|| value.get("id"))
                .ok_or_else(|| invalid("document selector needs name"))?;
            let id = self.identity(kind, name, value["category"].as_str())?;
            let prefix = if matches!(kind, "chapter" | "idea" | "node") {
                "node"
            } else {
                kind
            };
            DocId::parse(&format!("{prefix}:{id}"))
                .map_err(|_| invalid("target has no prose document"))?
        };
        if matches!(doc, DocId::Conversation(_)) || (prose_only && doc.profile().is_none()) {
            return Err(invalid("target is not an authored prose document"));
        }
        let id = doc.to_string();
        let info = self
            .ws
            .library()
            .doc_info(&id)
            .map_err(dr_agent::Error::from)?
            .ok_or_else(|| invalid("document is not stored"))?;
        if info.book_id.as_deref() != Some(self.book.as_str()) {
            return Err(invalid("document belongs to another book"));
        }
        Ok(id)
    }

    fn target(&mut self, value: &mut Value) -> Result<()> {
        if value.is_null() {
            return Ok(());
        }
        let kind = normalize_kind(
            value["kind"]
                .as_str()
                .ok_or_else(|| invalid("target needs kind"))?,
        )?;
        let name = value
            .get("name")
            .or_else(|| value.get("id"))
            .ok_or_else(|| invalid("target needs name or id"))?;
        let id = self.identity(kind, name, value["category"].as_str())?;
        let kind = if matches!(kind, "chapter" | "idea") {
            "node"
        } else {
            kind
        };
        *value = json!({"kind":kind,"id":id});
        Ok(())
    }

    fn history_session(&mut self, session: &str, turn: Option<&Value>) -> Result<()> {
        let lib = self.ws.library();
        if let Some(run) = lib.agent_session(session).map_err(dr_agent::Error::from)?
            && run.book_id != self.book.as_str()
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
            let doc = self.document(&Value::String(row.doc_id), false)?;
            if turn.as_ref().is_none_or(|turn| turn == &row.turn) {
                self.targets.insert(doc);
            }
        }
        Ok(())
    }

    fn grid_fields(&mut self, verb: &str, args: &mut Value) -> Result<()> {
        let node = args["node"]
            .as_str()
            .ok_or_else(|| invalid("plot grid needs a node"))?;
        let grid = self.query("plot_grid.get", json!({"book":self.book,"node":node}))?;
        for (field, list) in [("row", "rows"), ("column", "columns")] {
            if let Some(value) = args.get_mut(field) {
                *value = select(
                    grid[list]
                        .as_array()
                        .ok_or_else(|| invalid("grid lines unavailable"))?,
                    string(value, field)?,
                    None,
                )?
                .into();
            }
        }
        let list = match args["axis"].as_str() {
            Some("row") => "rows",
            Some("column") => "columns",
            _ => return Ok(()),
        };
        for field in ["id", "after"] {
            if field == "id" && verb == "line_add" {
                continue;
            }
            if let Some(value) = args.get_mut(field).filter(|v| !v.is_null()) {
                *value = select(
                    grid[list]
                        .as_array()
                        .ok_or_else(|| invalid("grid lines unavailable"))?,
                    string(value, field)?,
                    None,
                )?
                .into();
            }
        }
        Ok(())
    }

    fn list_fields(&mut self, name: &str, args: &mut Value) -> Result<()> {
        let domain = name.split_once('.').expect("registry name").0;
        let rows = array(self.query(&format!("{domain}.list"), args.clone())?)?;
        resolve_field_refs(args, &rows, name.ends_with(".put"))
    }

    fn entity_fields(&mut self, kind: &str, args: &mut Value) -> Result<()> {
        let id = args["id"]
            .as_str()
            .ok_or_else(|| invalid("field owner missing"))?;
        let owner = self
            .rows(kind)?
            .into_iter()
            .find(|row| row["id"] == id)
            .ok_or_else(|| invalid("field owner not found"))?;
        let rows = owner["fields"].as_array().cloned().unwrap_or_default();
        if let Some(remove) = args.get_mut("remove_fields") {
            for value in remove
                .as_array_mut()
                .ok_or_else(|| invalid("remove_fields must be an array"))?
            {
                *value = select(&rows, string(value, "field")?, None)?.into();
            }
        }
        if let Some(put) = args.get_mut("put_fields") {
            for value in put
                .as_array_mut()
                .ok_or_else(|| invalid("put_fields must be an array"))?
            {
                resolve_field_refs(value, &rows, true)?;
            }
        }
        Ok(())
    }
}

fn resolve_field_refs(args: &mut Value, rows: &[Value], new_allowed: bool) -> Result<()> {
    if let Some(value) = args.get_mut("id").filter(|v| !v.is_null()) {
        let id = string(value, "field")?;
        if !(new_allowed && looks_like_id(id) && !rows.iter().any(|row| row["id"] == id)) {
            *value = select(rows, id, None)?.into();
        }
    }
    if let Some(place) = args.get_mut("place").and_then(Value::as_object_mut) {
        for key in ["before", "after"] {
            if let Some(value) = place.get_mut(key) {
                *value = select(rows, string(value, "field")?, None)?.into();
            }
        }
    }
    Ok(())
}

fn select(rows: &[Value], name: &str, category: Option<&str>) -> Result<String> {
    if let Some(row) = rows.iter().find(|row| {
        row["id"] == name && category.is_none_or(|category| row["category"] == category)
    }) {
        return Ok(row["id"].as_str().expect("matched id").into());
    }
    let key = name.trim().to_lowercase();
    let matches: Vec<_> = rows
        .iter()
        .filter(|row| category.is_none_or(|category| row["category"] == category))
        .filter(|row| {
            ["name", "title", "label", "key", "body"]
                .into_iter()
                .any(|field| {
                    row[field]
                        .as_str()
                        .is_some_and(|value| value.trim().to_lowercase() == key)
                })
                || row["aliases"].as_array().is_some_and(|aliases| {
                    aliases.iter().any(|alias| {
                        alias
                            .as_str()
                            .is_some_and(|value| value.trim().to_lowercase() == key)
                    })
                })
        })
        .collect();
    match matches.as_slice() {
        [row] => row["id"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| invalid("query returned no target identity")),
        [] => Err(invalid(format!(
            "author target {name:?} was not found in this book"
        ))),
        _ => Err(invalid(format!(
            "author target {name:?} is ambiguous; use a more specific kind or category"
        ))),
    }
}

fn entity_domain(kind: &str) -> bool {
    matches!(
        kind,
        "chapter"
            | "idea"
            | "element"
            | "category"
            | "storyline"
            | "act"
            | "idea_group"
            | "material"
            | "material_folder"
            | "comment"
            | "relation"
            | "relation_type"
            | "memory"
            | "time_pin"
            | "patch"
    )
}
fn normalize_kind(kind: &str) -> Result<&str> {
    if entity_domain(kind) || kind == "node" {
        Ok(kind)
    } else {
        Err(invalid(format!("unsupported author target kind {kind:?}")))
    }
}
fn collection_kind(collection: &str) -> Option<&str> {
    match collection {
        "nodes" => Some("node"),
        "elements" => Some("element"),
        "categories" => Some("category"),
        "storylines" => Some("storyline"),
        "acts" => Some("act"),
        "comments" => Some("comment"),
        "relations" => Some("relation"),
        "relation_types" => Some("relation_type"),
        "memories" => Some("memory"),
        "materials" => Some("material"),
        "patches" => Some("patch"),
        "time_pins" => Some("time_pin"),
        _ => None,
    }
}
fn looks_like_id(value: &str) -> bool {
    dr_model::id::NodeId::parse(value).is_ok()
}
fn string<'a>(value: &'a Value, what: &str) -> Result<&'a str> {
    value
        .as_str()
        .ok_or_else(|| invalid(format!("{what} must be a string")))
}
fn array(value: Value) -> Result<Vec<Value>> {
    value
        .as_array()
        .cloned()
        .ok_or_else(|| invalid("query returned no target list"))
}
fn invalid(message: impl Into<String>) -> Error {
    Error::Invalid(message.into())
}

/// The only schema transformations are scope injection and author-name
/// projection. All actual fields, defaults and result schemas come from F3.
pub(crate) fn facade_schema(name: &str, mut schema: Value) -> Value {
    if let Some(properties) = schema["properties"].as_object_mut() {
        properties.remove("book");
    }
    if let Some(required) = schema["required"].as_array_mut() {
        required.retain(|key| key != "book");
    }
    if let Some(properties) = schema["properties"].as_object_mut() {
        let (domain, verb) = name.split_once('.').expect("registry name");
        for key in [
            "id",
            "category",
            "storyline",
            "primary_storyline",
            "element",
            "source",
            "node",
            "start_chapter",
            "drift",
            "idea",
            "group",
            "folder",
            "relation_type",
            "parent",
        ] {
            let is_reference =
                key != "id" || (entity_domain(domain) && !matches!(verb, "create" | "add"));
            if is_reference && let Some(field) = properties.get_mut(key) {
                let before = field["description"].as_str().unwrap_or("");
                field["description"]=format!("{before} Existing object id or exact author name; an ambiguous name is refused.").trim().to_owned().into();
            }
        }
    }
    fn visit(value: &mut Value) {
        if let Some(properties) = value.get_mut("properties").and_then(Value::as_object_mut) {
            if let Some(doc) = properties.get_mut("doc") {
                *doc = json!({"description":"An authored document id, or its kind and exact author name.","anyOf":[doc.clone(),{"type":"object","properties":{"kind":{"type":"string","enum":["chapter","idea","node","element","category","storyline","material"]},"name":{"type":"string"},"category":{"type":"string"}},"required":["kind","name"],"additionalProperties":false}]});
            }
            if properties.contains_key("kind")
                && properties.contains_key("id")
                && properties.len() == 2
            {
                properties.insert(
                    "name".into(),
                    json!({"type":"string","description":"Exact author name; use instead of id."}),
                );
                properties.insert("category".into(),json!({"type":"string","description":"Optional element category for disambiguation."}));
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
