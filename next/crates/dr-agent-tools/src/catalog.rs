//! The model/MCP directory is a projection of F3's registry, never a second
//! list of operations. Only book-scoped author operations are exposed.

use dr_agent::{ToolAccess, ToolDescriptor, ToolPolicy};
use dr_workspace::{Access, Concurrency, Spec, registry};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// Change this when facade handler semantics change without a schema change.
const FACADE_REVISION: &str = "m29-author-facade-v1";

#[derive(Clone, Debug, Serialize)]
pub struct Entry {
    pub name: String,
    pub description: String,
    pub revision: String,
    pub access: ToolAccess,
    pub concurrency: String,
    pub input_schema: Value,
    pub output_schema: Value,
}

impl Entry {
    pub fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: self.name.clone(),
            description: self.description.clone(),
            revision: self.revision.clone(),
            input_schema: self.input_schema.clone(),
            access: self.access,
            policy: ToolPolicy::Local,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Search {
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub offset: usize,
    #[serde(default = "default_limit")]
    pub limit: usize,
}

const fn default_limit() -> usize {
    10
}

impl Default for Search {
    fn default() -> Self {
        Self {
            query: String::new(),
            offset: 0,
            limit: default_limit(),
        }
    }
}

impl Search {
    pub fn validate(&self) -> crate::Result<()> {
        if !(1..=50).contains(&self.limit) {
            return Err(crate::Error::Invalid(
                "search limit must be between 1 and 50".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct Catalog {
    entries: Vec<Entry>,
    excluded: Vec<(String, String)>,
}

impl Default for Catalog {
    fn default() -> Self {
        Self::new()
    }
}

impl Catalog {
    pub fn new() -> Self {
        let mut entries = Vec::new();
        let mut excluded = Vec::new();
        for spec in registry().iter() {
            if let Some(reason) = exclusion(spec) {
                excluded.push((spec.name.to_owned(), reason.to_owned()));
                continue;
            }
            let mut input_schema =
                crate::resolve::facade_schema(spec.name, spec.input_schema().as_value().clone());
            if spec.name == "relation.create" {
                // F3's optional caller id can name an existing hidden edge.
                // The facade only creates fresh identities; omitting a
                // property alone would still accept it in an open schema.
                input_schema["properties"]
                    .as_object_mut()
                    .expect("registered command properties")
                    .remove("id");
                input_schema["not"] = json!({"required":["id"]});
            }
            let output_schema = outcome_schema(spec.name, spec.output_schema().as_value().clone());
            let description = if spec.name.ends_with("_template.set_body") {
                format!(
                    "{} Available for existing template documents; creation is not exposed by the Agent facade yet.",
                    spec.summary
                )
            } else {
                spec.summary.to_owned()
            };
            let access = match spec.access {
                Access::Read => ToolAccess::Read,
                Access::Write => ToolAccess::Write,
            };
            let concurrency = match spec.concurrency {
                Concurrency::Shared => "shared",
                Concurrency::Book => "book",
                Concurrency::Library => "library",
            }
            .to_owned();
            let revision = digest(
                &json!({"facade":FACADE_REVISION,"name":spec.name,"description":description,"access":access,"concurrency":concurrency,"input":input_schema,"output":output_schema}),
            );
            entries.push(Entry {
                name: spec.name.to_owned(),
                description,
                revision,
                access,
                concurrency,
                input_schema,
                output_schema,
            });
        }
        Self { entries, excluded }
    }

    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }
    pub fn exclusions(&self) -> &[(String, String)] {
        &self.excluded
    }

    pub fn descriptor(&self, name: &str) -> Option<ToolDescriptor> {
        self.entries
            .iter()
            .find(|entry| entry.name == name)
            .map(Entry::descriptor)
    }

    pub fn manifest(&self) -> Value {
        serde_json::to_value(&self.entries).expect("catalog is JSON")
    }

    /// Every allowed name, access and summary, without eagerly adding schemas
    /// to the model's tool definitions. Search results carry original schemas.
    pub fn directory(&self) -> String {
        self.entries
            .iter()
            .map(|e| {
                format!(
                    "{} [{}] {}",
                    e.name,
                    if e.access == ToolAccess::Read {
                        "read"
                    } else {
                        "write"
                    },
                    e.description
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    pub fn search(&self, search: Search) -> Value {
        if let Err(error) = search.validate() {
            return json!({"error":{"code":"invalid","message":error.to_string()}});
        }
        let query = search.query.trim().to_lowercase();
        let terms: Vec<_> = query.split_whitespace().collect();
        let exact = self.entries.iter().any(|e| e.name == query);
        let matches: Vec<_> = self
            .entries
            .iter()
            .filter(|e| {
                if exact {
                    return e.name == query;
                }
                let haystack = format!("{} {}", e.name, e.description).to_lowercase();
                terms.iter().all(|term| haystack.contains(term))
            })
            .collect();
        let total = matches.len();
        let tools: Vec<_> = matches
            .into_iter()
            .skip(search.offset)
            .take(search.limit)
            .collect();
        let end = search.offset.saturating_add(tools.len());
        let next = (end < total && !tools.is_empty()).then_some(end);
        json!({"tools":tools,"total":total,"next_offset":next})
    }
}

/// A small scope policy, not a second capability inventory. New registered
/// operations enter automatically if they have a recognized book boundary.
fn exclusion(spec: &Spec) -> Option<&'static str> {
    if (spec.name.ends_with(".purge") && spec.concurrency != Concurrency::Library)
        || matches!(
            spec.name,
            "comment.delete" | "material.delete" | "patch.delete" | "relation_type.delete"
        )
    {
        return Some(
            "cascade needs an F3 query exposing affected relations, including hidden endpoints",
        );
    }
    if spec.name == "idea.to_chapter" {
        return Some("conversion needs exact affected act and time-pin coverage before mutation");
    }
    if spec.name == "idea.to_element" {
        return Some(
            "conversion needs version-checked full source prose and guarded automatic-link effects",
        );
    }
    if spec.name == "history.restore_point" {
        return Some("history restore labels require an atomic guarded owner hook");
    }
    if spec.concurrency == Concurrency::Library {
        return Some("library-wide lifecycle operation");
    }
    if matches!(spec.name, "book.trash" | "book.restore") {
        return Some("book lifecycle belongs to the library");
    }
    if matches!(
        spec.name,
        "asset.put"
            | "recent.touch"
            | "writing_day.record"
            | "patch.check_sources"
            | "todo.project"
            | "note_tasks.project"
    ) || spec.name.ends_with("_template.document")
    {
        return Some("storage, editor, or derived-state maintenance");
    }
    let schema = spec.input_schema().as_value().clone();
    let scoped = schema["properties"].as_object().is_some_and(|p| {
        p.contains_key("book")
            || p.contains_key("doc")
            || (spec.name.starts_with("prose.") && p.contains_key("links"))
            || (spec.name.starts_with("history.") && p.contains_key("session"))
    });
    (!scoped).then_some("no current-book input boundary")
}

pub(crate) fn allowed(spec: &Spec) -> bool {
    exclusion(spec).is_none()
}

fn outcome_schema(name: &str, mut output: Value) -> Value {
    // F3's references remain rooted at #/$defs when its output is nested in
    // the common Outcome. Lift definitions, do not rewrite or duplicate them.
    let definitions = output.as_object_mut().and_then(|o| o.remove("$defs"));
    if name == "prose.read" {
        output["properties"]["projection"] = json!({"type":"object","description":"Versioned editable prose projection, with immutable block and comment anchors; returned by the M29 facade."});
    }
    if name == "prose.replace" {
        output = json!({"anyOf":[output,{"type":"object","properties":{"unchanged":{"const":true}},"required":["unchanged"],"additionalProperties":false}]});
    }
    let mut schema = json!({
        "type":"object",
        "properties":{
            "output":output,
            "effects":{"type":"array","items":{"type":"object","properties":{"action":{"type":"string"},"kind":{"type":"string"},"id":{"type":"string"},"name":{"type":["string","null"]}},"required":["action","kind","id"]}},
            "undo":{"type":["array","null"],"items":{"type":"object","properties":{"command":{"type":"string"},"input":true},"required":["command","input"]}},
            "journal":{"type":["integer","null"]}
        },
        "required":["output","effects"]
    });
    if let Some(definitions) = definitions {
        schema["$defs"] = definitions;
    }
    schema
}

fn digest(value: &Value) -> String {
    // serde_json preserve_order may be enabled by another workspace member.
    // Hash a canonical key order, independent of that feature unification.
    fn append(value: &Value, bytes: &mut Vec<u8>) {
        match value {
            Value::Object(map) => {
                bytes.push(b'{');
                let mut keys: Vec<_> = map.keys().collect();
                keys.sort();
                for key in keys {
                    bytes.extend(serde_json::to_vec(key).expect("key"));
                    bytes.push(b':');
                    append(&map[key], bytes);
                    bytes.push(b',');
                }
                bytes.push(b'}');
            }
            Value::Array(items) => {
                bytes.push(b'[');
                for item in items {
                    append(item, bytes);
                    bytes.push(b',');
                }
                bytes.push(b']');
            }
            _ => bytes.extend(serde_json::to_vec(value).expect("value")),
        }
    }
    let mut bytes = Vec::new();
    append(value, &mut bytes);
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use dr_workspace::{Cx, Op, Registry, commands::comment::TodoProjectIn};

    // Reserve the M19 maintenance name before its owner implementation is
    // merged. A recognized doc boundary alone must never open it to agents.
    struct PendingNoteTasks;

    impl Op for PendingNoteTasks {
        const NAME: &'static str = "note_tasks.project";
        const ACCESS: Access = Access::Write;
        const CONCURRENCY: Concurrency = Concurrency::Book;
        const SUMMARY: &'static str = "Internal note task projection";
        type Input = TodoProjectIn;
        type Output = Value;

        fn run(_: &Cx<'_>, _: Self::Input) -> dr_workspace::Result<Self::Output> {
            unreachable!("the synthetic registration must never be dispatched")
        }
    }

    #[test]
    fn note_task_projection_is_excluded_even_with_a_scoped_write_schema() {
        let mut registry = Registry::default();
        registry.add::<PendingNoteTasks>();
        let spec = registry.get("note_tasks.project").unwrap();
        assert!(
            spec.input_schema().as_value()["properties"]
                .get("doc")
                .is_some()
        );
        assert_eq!(
            exclusion(spec),
            Some("storage, editor, or derived-state maintenance")
        );
        assert!(!allowed(spec));
    }
}
