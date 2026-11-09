//! The model/MCP directory is a projection of F3's registry, never a second
//! list of operations. Only book-scoped author operations are exposed.

use dr_agent::{ToolAccess, ToolDescriptor, ToolPolicy};
use dr_doc::v3::{BookViewV3, BorrowedBookV3, is_v3_doc};
use dr_model::{
    id::{BookId, EntryId},
    v3::{
        Entry as V3Entry, EntryTemplate, EntryTemplateId, TemplateKind,
        check_level_allows_template, check_parent_is_level, resolve_new_entry_residence,
    },
};
use dr_workspace::{Access, Concurrency, Spec, Workspace, registry};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

/// Change this when facade handler semantics change without a schema change.
const FACADE_REVISION: &str = "m29-author-facade-v1";
/// Versioned facade revision for universal kernel v3 books and template verbs.
pub const FACADE_REVISION_V3: &str = "k6-author-facade-v3-r3";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BookKernelVersion {
    V2_2,
    V3,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionRef {
    pub book: String,
    pub level: String,
    pub template: String,
    pub verb: String,
}

impl ActionRef {
    /// Canonical ASCII technical identifier (`action:<book>/<level>/<template>/<verb>`).
    pub fn canonical_id(&self) -> String {
        format!(
            "action:{}/{}/{}/{}",
            self.book,
            self.level,
            self.template,
            encode_verb_segment(&self.verb)
        )
    }

    pub fn parse_canonical(raw: &str) -> Option<Self> {
        let rest = raw.strip_prefix("action:")?;
        let mut parts = rest.splitn(4, '/');
        let book = parts.next()?.to_owned();
        let level = parts.next()?.to_owned();
        let template = parts.next()?.to_owned();
        let verb = decode_verb_segment(parts.next()?)?;
        if book.is_empty()
            || level.is_empty()
            || template.is_empty()
            || verb.is_empty()
            || !book.is_ascii()
            || !level.is_ascii()
            || !template.is_ascii()
        {
            return None;
        }
        Some(Self {
            book,
            level,
            template,
            verb,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ActionTarget(pub ActionRef);

impl ActionTarget {
    pub fn canonical_id(&self) -> String {
        self.0.canonical_id()
    }
}

impl<'de> Deserialize<'de> for ActionTarget {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        match value {
            Value::String(raw) => ActionRef::parse_canonical(&raw)
                .map(ActionTarget)
                .ok_or_else(|| {
                    serde::de::Error::custom(
                        "template action must be a canonical action:<book>/<level>/<template>/<verb> reference or {book, level, template, verb} object",
                    )
                }),
            Value::Object(_) => serde_json::from_value::<ActionRef>(value)
                .map_err(serde::de::Error::custom)
                .and_then(|reference| {
                    if reference.book.trim().is_empty()
                        || reference.level.trim().is_empty()
                        || reference.template.trim().is_empty()
                        || reference.verb.trim().is_empty()
                    {
                        Err(serde::de::Error::custom(
                            "template action reference fields must be non-empty",
                        ))
                    } else {
                        Ok(ActionTarget(reference))
                    }
                }),
            _ => Err(serde::de::Error::custom(
                "template action must be a string or object action reference",
            )),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActionPathSegment {
    pub entry: String,
    pub title: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActionBinding {
    pub id: String,
    pub reference: ActionRef,
    pub display_name: String,
    pub description: String,
    pub path: Vec<ActionPathSegment>,
    pub target_template: String,
    pub target_template_name: String,
    pub home: Option<String>,
    pub command: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActionDiagnostic {
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<String>,
    pub template: String,
    pub verb: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct Entry {
    pub name: String,
    pub description: String,
    pub revision: String,
    pub access: ToolAccess,
    pub concurrency: String,
    pub input_schema: Value,
    pub output_schema: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<ActionBinding>,
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
    version: BookKernelVersion,
    entries: Vec<Entry>,
    excluded: Vec<(String, String)>,
    diagnostics: Vec<ActionDiagnostic>,
}

impl Default for Catalog {
    fn default() -> Self {
        Self::new()
    }
}

impl Catalog {
    pub fn new() -> Self {
        Self::build_base(BookKernelVersion::V2_2)
    }

    pub fn new_v3() -> Self {
        Self::build_base(BookKernelVersion::V3)
    }

    pub fn for_book(ws: &Workspace, book: &BookId) -> crate::Result<Self> {
        let doc = ws
            .library()
            .load_copy(&format!("book:{book}"))
            .map_err(dr_workspace::WsError::from)?;
        if !is_v3_doc(&doc) {
            return Ok(Self::new());
        }
        let borrowed = BorrowedBookV3::new(&doc, book)
            .map_err(|e| crate::Error::Invalid(format!("invalid v3 book {book}: {e}")))?;
        Ok(Self::from_v3_view(book, &borrowed.view()))
    }

    pub fn from_v3_view(book: &BookId, view: &BookViewV3<'_>) -> Self {
        let mut catalog = Self::new_v3();
        let Some(create_entry) = catalog
            .entries
            .iter()
            .find(|e| e.name == "entry.create")
            .cloned()
        else {
            return catalog;
        };
        let (actions, diagnostics) = build_v3_actions(book, view, &create_entry);
        catalog.entries.extend(actions);
        catalog.diagnostics = diagnostics;
        catalog
    }

    fn build_base(version: BookKernelVersion) -> Self {
        let mut entries = Vec::new();
        let mut excluded = Vec::new();
        let facade = match version {
            BookKernelVersion::V2_2 => FACADE_REVISION,
            BookKernelVersion::V3 => FACADE_REVISION_V3,
        };
        for spec in registry().iter() {
            let reason = match version {
                BookKernelVersion::V2_2 => exclusion(spec),
                BookKernelVersion::V3 => exclusion_v3(spec),
            };
            if let Some(reason) = reason {
                excluded.push((spec.name.to_owned(), reason.to_owned()));
                continue;
            }
            let mut input_schema = match version {
                BookKernelVersion::V2_2 => {
                    crate::resolve::facade_schema(spec.name, spec.input_schema().as_value().clone())
                }
                BookKernelVersion::V3 => {
                    crate::resolve::facade_schema_v3(spec.name, input_schema_for(spec, version))
                }
            };
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
            let output_schema = outcome_schema(spec.name, output_schema_for(spec, version));
            let description = if spec.name.ends_with("_template.set_body") {
                format!(
                    "{} Available for existing template documents; creation is not exposed by the Agent facade yet.",
                    spec.summary
                )
            } else if version == BookKernelVersion::V3 && spec.name == "timeline_view.put" {
                format!(
                    "{} Whole-view replacement requires a complete timeline_view.list at the guarded version. Hidden lanes, placements or pin data prevent replacement; use supported item commands instead.",
                    spec.summary
                )
            } else if version == BookKernelVersion::V3
                && matches!(spec.name, "membership.remove" | "timeline_view.remove")
            {
                format!(
                    "{} Requires a complete timeline_view.list at the guarded version; hidden timeline data prevents removal until the kernel cascade preserves it.",
                    spec.summary
                )
            } else if version == BookKernelVersion::V3 && spec.name == "comment.create" {
                format!(
                    "{} Whole-entry, module, material or floating comments only; range, block and anchor creation await guarded source-prose support.",
                    spec.summary
                )
            } else if version == BookKernelVersion::V3 && spec.name == "comment.reanchor" {
                format!(
                    "{} Only clearing an anchor is available until guarded source-prose support lands.",
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
                &json!({"facade":facade,"name":spec.name,"description":description,"access":access,"concurrency":concurrency,"input":input_schema,"output":output_schema}),
            );
            entries.push(Entry {
                name: spec.name.to_owned(),
                description,
                revision,
                access,
                concurrency,
                input_schema,
                output_schema,
                action: None,
            });
        }
        Self {
            version,
            entries,
            excluded,
            diagnostics: Vec::new(),
        }
    }

    pub fn version(&self) -> BookKernelVersion {
        self.version
    }

    pub fn kernel_version(&self) -> BookKernelVersion {
        self.version
    }

    pub fn revision(&self) -> String {
        let names: Vec<_> = self
            .entries
            .iter()
            .map(|e| (&e.name, &e.revision))
            .collect();
        digest(&json!({"version": self.version, "entries": names}))
    }

    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }
    pub fn exclusions(&self) -> &[(String, String)] {
        &self.excluded
    }
    pub fn actions(&self) -> Vec<&ActionBinding> {
        self.entries
            .iter()
            .filter_map(|e| e.action.as_ref())
            .collect()
    }
    pub fn action_diagnostics(&self) -> &[ActionDiagnostic] {
        &self.diagnostics
    }

    pub fn descriptor(&self, name: &str) -> Option<ToolDescriptor> {
        self.entries
            .iter()
            .find(|entry| entry.name == name)
            .map(Entry::descriptor)
    }

    pub fn action_binding(&self, name: &str) -> Option<&ActionBinding> {
        self.entries
            .iter()
            .find(|entry| entry.name == name)
            .and_then(|entry| entry.action.as_ref())
    }

    pub fn resolve_action_target(
        &self,
        book: &BookId,
        target: &Value,
    ) -> crate::Result<ActionBinding> {
        if let Some(raw) = target.as_str() {
            let reference = ActionRef::parse_canonical(raw)
                .ok_or_else(|| crate::Error::Invalid("invalid canonical action id".into()))?;
            if reference.book != book.as_str() {
                return Err(crate::Error::Invalid(
                    "template action belongs to another book".into(),
                ));
            }
            if let Some(binding) = self.action_binding(raw) {
                return Ok(binding.clone());
            }
            if let Some(diag) = self.diagnostics.iter().find(|d| {
                d.level.as_deref() == Some(reference.level.as_str())
                    && (d.verb == reference.verb || d.message.contains(&reference.verb))
            }) {
                return Err(crate::Error::Invalid(format!(
                    "template action is disabled ({}): {}",
                    diag.code, diag.message
                )));
            }
            return Err(crate::Error::Invalid(format!(
                "template action {raw:?} is not available in this book"
            )));
        }
        let obj = target.as_object().ok_or_else(|| {
            crate::Error::Invalid("action must be a canonical string or object".into())
        })?;
        if let Some(given_book) = obj.get("book").and_then(Value::as_str)
            && given_book != book.as_str()
        {
            return Err(crate::Error::Invalid(
                "template action belongs to another book".into(),
            ));
        }
        let verb = obj
            .get("verb")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| crate::Error::Invalid("action requires a non-empty verb".into()))?;
        let has_level = obj.get("level").is_some_and(|v| !v.is_null());
        let has_path = obj.get("path").is_some_and(|v| !v.is_null());
        if has_level == has_path {
            return Err(crate::Error::Invalid(
                "action requires exactly one of level or path".into(),
            ));
        }
        if has_level {
            let level = obj["level"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    crate::Error::Invalid("action.level must be a non-empty string".into())
                })?;
            let template_filter = obj
                .get("template")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let matches: Vec<&ActionBinding> = self
                .actions()
                .into_iter()
                .filter(|a| {
                    a.reference.level == level
                        && template_filter.is_none_or(|t| a.reference.template == t)
                        && (a.reference.verb == verb || a.display_name == verb)
                })
                .collect();
            match matches.as_slice() {
                [binding] => return Ok((*binding).clone()),
                [] => {
                    if let Some(diag) = self.diagnostics.iter().find(|d| {
                        d.level.as_deref() == Some(level)
                            && (d.verb == verb || d.message.contains(verb))
                    }) {
                        return Err(crate::Error::Invalid(format!(
                            "template action is disabled ({}): {}",
                            diag.code, diag.message
                        )));
                    }
                    return Err(crate::Error::Invalid(format!(
                        "template action {verb:?} is not available on level {level:?}"
                    )));
                }
                _ => {
                    return Err(crate::Error::Invalid(format!(
                        "template action {verb:?} on level {level:?} is ambiguous; specify verb id"
                    )));
                }
            }
        }
        let path_arr = obj["path"].as_array().ok_or_else(|| {
            crate::Error::Invalid("action.path must be a non-empty array of strings".into())
        })?;
        let mut path_segments = Vec::with_capacity(path_arr.len());
        for item in path_arr {
            let s = item
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    crate::Error::Invalid("action.path segments must be non-empty strings".into())
                })?;
            path_segments.push(s);
        }
        if path_segments.is_empty() {
            return Err(crate::Error::Invalid(
                "action.path must not be empty".into(),
            ));
        }
        let matches: Vec<&ActionBinding> = self
            .actions()
            .into_iter()
            .filter(|a| {
                a.path.len() == path_segments.len()
                    && a.path
                        .iter()
                        .zip(&path_segments)
                        .all(|(seg, want)| seg.title == *want || seg.entry == *want)
                    && (a.reference.verb == verb || a.display_name == verb)
            })
            .collect();
        match matches.as_slice() {
            [binding] => Ok((*binding).clone()),
            [] => Err(crate::Error::Invalid(format!(
                "template action {verb:?} at path {path_segments:?} was not found"
            ))),
            _ => Err(crate::Error::Invalid(format!(
                "action path {path_segments:?} for verb {verb:?} is ambiguous across {} levels; use the canonical action reference",
                matches.len()
            ))),
        }
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
        let exact = self.entries.iter().any(|e| e.name.to_lowercase() == query);
        let matches: Vec<_> = self
            .entries
            .iter()
            .filter(|e| {
                if exact {
                    return e.name.to_lowercase() == query;
                }
                let mut haystack = format!("{} {}", e.name, e.description).to_lowercase();
                if let Some(action) = &e.action {
                    haystack.push(' ');
                    haystack.push_str(&action.display_name.to_lowercase());
                    haystack.push(' ');
                    haystack.push_str(&action.description.to_lowercase());
                    haystack.push(' ');
                    haystack.push_str(&action.reference.verb.to_lowercase());
                    haystack.push(' ');
                    haystack.push_str(&action.target_template_name.to_lowercase());
                    for seg in &action.path {
                        haystack.push(' ');
                        haystack.push_str(&seg.title.to_lowercase());
                    }
                }
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

pub fn is_v3_book(ws: &Workspace, book: &BookId) -> crate::Result<bool> {
    let doc = ws
        .library()
        .load_copy(&format!("book:{book}"))
        .map_err(dr_workspace::WsError::from)?;
    Ok(is_v3_doc(&doc))
}

fn build_v3_actions(
    book: &BookId,
    view: &BookViewV3<'_>,
    create_entry: &Entry,
) -> (Vec<Entry>, Vec<ActionDiagnostic>) {
    let entries_list = view.entries();
    let entries_map: BTreeMap<EntryId, V3Entry> = view.entries_map();
    let templates_map: BTreeMap<EntryTemplateId, EntryTemplate> = view.templates_map();
    let mut actions = Vec::new();
    let mut diagnostics = Vec::new();

    for tpl in view.templates() {
        if tpl.is_trashed() {
            continue;
        }
        if tpl.kind == TemplateKind::Leaf {
            for verb in &tpl.verbs {
                diagnostics.push(ActionDiagnostic {
                    code: "leaf_template_verb".into(),
                    level: None,
                    template: tpl.id.to_string(),
                    verb: verb.id.clone(),
                    message: format!(
                        "leaf template {:?} ({}) cannot declare level actions",
                        tpl.name, tpl.id
                    ),
                });
            }
        }
    }

    let action_input_schema =
        crate::resolve::action_input_schema_v3(create_entry.input_schema.clone());
    let action_output_schema = create_entry.output_schema.clone();

    for level in &entries_list {
        if level.is_trashed() {
            continue;
        }
        let Some(tpl_id) = &level.template else {
            continue;
        };
        let Some(tpl) = templates_map.get(tpl_id).filter(|t| !t.is_trashed()) else {
            continue;
        };
        if tpl.kind != TemplateKind::Level {
            continue;
        }
        if tpl.verbs.is_empty() {
            continue;
        }
        let path = entry_path(view, &entries_map, &level.id);
        let effective = view.level_settings(Some(&level.id));
        for verb in &tpl.verbs {
            if verb.id.trim().is_empty() || verb.name.trim().is_empty() {
                diagnostics.push(ActionDiagnostic {
                    code: "invalid_verb_definition".into(),
                    level: Some(level.id.to_string()),
                    template: tpl.id.to_string(),
                    verb: verb.id.clone(),
                    message: format!(
                        "action on level {:?} ({}) has an empty id or name",
                        level.title, level.id
                    ),
                });
                continue;
            }
            let target_id = verb
                .target_template
                .clone()
                .or_else(|| effective.default_template.clone());
            let Some(target_id) = target_id else {
                diagnostics.push(ActionDiagnostic {
                    code: "missing_target_template".into(),
                    level: Some(level.id.to_string()),
                    template: tpl.id.to_string(),
                    verb: verb.id.clone(),
                    message: format!(
                        "action {:?} on level {:?} ({}) has no explicit target_template or effective default_template",
                        verb.name, level.title, level.id
                    ),
                });
                continue;
            };
            let Some(target_tpl) = templates_map
                .get(&target_id)
                .filter(|t| !t.is_trashed() && t.kind.is_known())
            else {
                diagnostics.push(ActionDiagnostic {
                    code: "missing_target_template".into(),
                    level: Some(level.id.to_string()),
                    template: tpl.id.to_string(),
                    verb: verb.id.clone(),
                    message: format!(
                        "action {:?} on level {:?} ({}) references missing or trashed target template {}",
                        verb.name, level.title, level.id, target_id
                    ),
                });
                continue;
            };
            let residence =
                resolve_new_entry_residence(Some(&level.id), &entries_map, &templates_map);
            if let Err(err) =
                check_parent_is_level(residence.as_ref(), &entries_map, &templates_map).and_then(
                    |()| {
                        check_level_allows_template(
                            residence.as_ref(),
                            Some(&target_id),
                            &entries_map,
                            &templates_map,
                        )
                    },
                )
            {
                diagnostics.push(ActionDiagnostic {
                    code: "invalid_residence_binding".into(),
                    level: Some(level.id.to_string()),
                    template: tpl.id.to_string(),
                    verb: verb.id.clone(),
                    message: format!(
                        "action {:?} on level {:?} ({}) has invalid residence {:?}: {err}",
                        verb.name, level.title, level.id, residence
                    ),
                });
                continue;
            }
            if residence.as_ref() != Some(&level.id) {
                let host_allows = effective.accept
                    && effective.allows_template(Some(&target_id))
                    && (!tpl.lane || target_tpl.is_leaf());
                if !host_allows {
                    diagnostics.push(ActionDiagnostic {
                        code: "invalid_membership_binding".into(),
                        level: Some(level.id.to_string()),
                        template: tpl.id.to_string(),
                        verb: verb.id.clone(),
                        message: format!(
                            "action {:?} on level {:?} ({}) resides in {:?} but level cannot accept target template {}",
                            verb.name, level.title, level.id, residence, target_id
                        ),
                    });
                    continue;
                }
            }

            let reference = ActionRef {
                book: book.to_string(),
                level: level.id.to_string(),
                template: tpl.id.to_string(),
                verb: verb.id.clone(),
            };
            let id = reference.canonical_id();
            let path_titles = path
                .iter()
                .map(|seg| seg.title.as_str())
                .collect::<Vec<_>>()
                .join(" / ");
            let description = if verb.description.trim().is_empty() {
                format!("{} ({path_titles} -> {})", verb.name, target_tpl.name)
            } else {
                format!(
                    "{} ({path_titles} -> {}): {}",
                    verb.name, target_tpl.name, verb.description
                )
            };
            let home_settings = residence.as_ref().map(|h| view.level_settings(Some(h)));
            let revision = digest(&json!({
                "facade": FACADE_REVISION_V3,
                "command": "entry.create",
                "command_revision": create_entry.revision,
                "reference": reference,
                "display_name": verb.name,
                "description": verb.description,
                "verb_target_template": verb.target_template.as_ref().map(ToString::to_string),
                "target_template": {
                    "id": target_tpl.id.to_string(),
                    "kind": format!("{:?}", target_tpl.kind),
                    "name": target_tpl.name,
                    "agent": target_tpl.agent.as_ref().map(|a| json!({
                        "name": a.name,
                        "description": a.description,
                        "instructions": a.instructions,
                    })),
                    "modules": target_tpl.modules.iter().map(|m| json!({
                        "id": m.id.to_string(),
                        "kind": format!("{:?}", m.kind),
                        "name": m.name,
                        "agent": m.agent.as_ref().map(|a| json!({
                            "writable": a.writable,
                            "read_tier": a.read_tier,
                            "instructions": a.instructions,
                        })),
                    })).collect::<Vec<_>>(),
                },
                "home": residence.as_ref().map(ToString::to_string),
                "level_effective_settings": settings_digest_value(&effective),
                "home_effective_settings": home_settings.as_ref().map(settings_digest_value),
                "input": action_input_schema,
                "output": action_output_schema,
            }));
            let binding = ActionBinding {
                id: id.clone(),
                reference,
                display_name: verb.name.clone(),
                description: verb.description.clone(),
                path: path.clone(),
                target_template: target_id.to_string(),
                target_template_name: target_tpl.name.clone(),
                home: residence.as_ref().map(ToString::to_string),
                command: "entry.create".into(),
            };
            actions.push(Entry {
                name: id,
                description,
                revision,
                access: ToolAccess::Write,
                concurrency: "book".into(),
                input_schema: action_input_schema.clone(),
                output_schema: action_output_schema.clone(),
                action: Some(binding),
            });
        }
    }

    (actions, diagnostics)
}

fn entry_path(
    view: &BookViewV3<'_>,
    entries: &BTreeMap<EntryId, V3Entry>,
    id: &EntryId,
) -> Vec<ActionPathSegment> {
    let mut chain = Vec::new();
    let mut current = Some(id.clone());
    let mut visited = std::collections::BTreeSet::new();
    while let Some(cur) = current {
        if !visited.insert(cur.clone()) {
            break;
        }
        if let Some(entry) = entries.get(&cur) {
            chain.push(ActionPathSegment {
                entry: entry.id.to_string(),
                title: entry.title.clone(),
            });
            current = view.effective_parent(&cur);
        } else {
            break;
        }
    }
    chain.reverse();
    chain
}

fn settings_digest_value(s: &dr_model::v3::LevelSettings) -> Value {
    json!({
        "default_template": s.default_template.as_ref().map(ToString::to_string),
        "allow": s.allow.iter().map(ToString::to_string).collect::<Vec<_>>(),
        "display": format!("{:?}", s.display),
        "auto_link": s.auto_link,
        "accept": s.accept,
        "home": s.home.as_ref().map(ToString::to_string),
        "is_manuscript": s.is_manuscript,
        "format_shortcuts": format!("{:?}", s.format_shortcuts),
    })
}

fn encode_verb_segment(verb: &str) -> String {
    let mut out = String::with_capacity(verb.len());
    for byte in verb.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'_' | b'.') {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn decode_verb_segment(encoded: &str) -> Option<String> {
    let bytes = encoded.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut idx = 0;
    while idx < bytes.len() {
        if bytes[idx] == b'%' {
            if idx + 2 >= bytes.len() {
                return None;
            }
            let hex = std::str::from_utf8(&bytes[idx + 1..idx + 3]).ok()?;
            let byte = u8::from_str_radix(hex, 16).ok()?;
            out.push(byte);
            idx += 3;
        } else if bytes[idx].is_ascii_alphanumeric() || matches!(bytes[idx], b'-' | b'_' | b'.') {
            out.push(bytes[idx]);
            idx += 1;
        } else {
            return None;
        }
    }
    String::from_utf8(out).ok()
}

/// A small scope policy, not a second capability inventory. New registered
/// operations enter automatically if they have a recognized book boundary.
fn exclusion(spec: &Spec) -> Option<&'static str> {
    if spec.book_version == Some(3) {
        return Some("v3 commands remain excluded until K6 opens the versioned catalog");
    }
    common_exclusion(spec, BookKernelVersion::V2_2)
}

fn exclusion_v3(spec: &Spec) -> Option<&'static str> {
    if spec.name == "timeline_view.restore_fields" {
        return Some("scoped timeline undo is internal until K6 provides a guarded facade");
    }
    if spec.name == "membership.restore" {
        return Some("scoped membership undo is internal until K6 provides a guarded facade");
    }
    // Public F3 additions must not bypass the facade's read coverage and
    // restore protocol merely by acquiring a book-scoped input schema.
    if spec.name.starts_with("entry_snapshot.") {
        return Some("entry snapshots need facade coverage and guarded whole-entry restore wiring");
    }
    if spec.name == "material.set_entry_link" {
        return Some("material entry links need exact endpoint and relation read coverage");
    }
    if matches!(
        spec.name,
        "timeline_view.rename"
            | "timeline_view.add_lane"
            | "timeline_view.move_lane"
            | "timeline_view.remove_lane"
    ) {
        return Some("local timeline edits need exact lane, placement, and pin read coverage");
    }
    if spec.book_version != Some(3) {
        let domain = spec
            .name
            .split_once('.')
            .map(|(d, _)| d)
            .unwrap_or(spec.name);
        if domain == "act" {
            return Some(
                "retired in v3; levels and timeline pins use generic entry and timeline_view commands",
            );
        }
        if matches!(
            domain,
            "chapter" | "idea" | "element" | "category" | "storyline" | "idea_group"
        ) && !matches!(spec.name, "idea.to_chapter" | "idea.to_element")
            && !spec.name.ends_with(".purge")
        {
            return Some(
                "replaced in v3 by generic entry, level, module, membership, and timeline_view commands",
            );
        }
        if matches!(
            domain,
            "category_template" | "chapter_template" | "storyline_template"
        ) && !spec.name.ends_with(".document")
        {
            return Some("replaced in v3 by entry_template and module prose commands");
        }
        if matches!(domain, "patch" | "plot_grid")
            && !matches!(spec.name, "patch.delete" | "patch.check_sources")
        {
            return Some("replaced in v3 by entry module commands");
        }
        if domain == "time_pin" {
            return Some("replaced in v3 by timeline_view pin commands");
        }
        if domain == "relation_type" && spec.name != "relation_type.delete" {
            return Some("replaced in v3 by entry_relation_type commands");
        }
        if spec.name == "history.restore_entities" {
            return Some("replaced in v3 by entry_history.restore");
        }
    }
    if spec.name == "module.prose_document" {
        return Some("storage, editor, or derived-state maintenance");
    }
    common_exclusion(spec, BookKernelVersion::V3)
}

fn common_exclusion(spec: &Spec, version: BookKernelVersion) -> Option<&'static str> {
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
    let schema = input_schema_for(spec, version);
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

pub(crate) fn allowed_v3(spec: &Spec) -> bool {
    exclusion_v3(spec).is_none()
}

/// Select the signature that F3 dispatches for this book, including shared names.
pub(crate) fn input_schema_for(spec: &Spec, version: BookKernelVersion) -> Value {
    if version == BookKernelVersion::V3
        && let Some(v3) = &spec.v3
    {
        v3.input_schema().as_value().clone()
    } else {
        spec.input_schema().as_value().clone()
    }
}

fn output_schema_for(spec: &Spec, version: BookKernelVersion) -> Value {
    if version == BookKernelVersion::V3
        && let Some(v3) = &spec.v3
    {
        v3.output_schema().as_value().clone()
    } else {
        spec.output_schema().as_value().clone()
    }
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

    #[test]
    fn pending_v3_commands_stay_closed_after_book_scoped_registration() {
        // These synthetic specs deliberately have valid book boundaries. This
        // regression must fail when an exclusion is removed even before the
        // owning crate registers its real implementation. Snapshot suffixes
        // exercise the reserved family, not a second command inventory.
        let mut registry = Registry::default();
        macro_rules! pending {
            ($ty:ident, $name:literal, $access:ident, $concurrency:ident, $version:expr) => {
                struct $ty;
                impl Op for $ty {
                    const NAME: &'static str = $name;
                    const BOOK_VERSION: Option<i64> = $version;
                    const ACCESS: Access = Access::$access;
                    const CONCURRENCY: Concurrency = Concurrency::$concurrency;
                    const SUMMARY: &'static str = "Synthetic pending facade integration";
                    type Input = dr_workspace::commands::BookIn;
                    type Output = Value;
                    fn run(_: &Cx<'_>, _: Self::Input) -> dr_workspace::Result<Self::Output> {
                        unreachable!("pending facade integrations must never be dispatched")
                    }
                }
                registry.add::<$ty>();
            };
        }
        pending!(
            SnapshotRead,
            "entry_snapshot.future_query",
            Read,
            Shared,
            Some(3)
        );
        pending!(
            SnapshotWrite,
            "entry_snapshot.future_write",
            Write,
            Book,
            None
        );
        pending!(MaterialLink, "material.set_entry_link", Write, Book, None);
        pending!(Rename, "timeline_view.rename", Write, Book, Some(3));
        pending!(AddLane, "timeline_view.add_lane", Write, Book, Some(3));
        pending!(MoveLane, "timeline_view.move_lane", Write, Book, Some(3));
        pending!(
            RemoveLane,
            "timeline_view.remove_lane",
            Write,
            Book,
            Some(3)
        );

        for spec in registry.iter() {
            assert_eq!(
                common_exclusion(spec, BookKernelVersion::V3),
                None,
                "{}",
                spec.name
            );
            assert!(
                exclusion_v3(spec).is_some(),
                "{} must stay out of the catalog",
                spec.name
            );
            assert!(
                !allowed_v3(spec),
                "{} must also refuse direct invocation",
                spec.name
            );
        }
    }
}
