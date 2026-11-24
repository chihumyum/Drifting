//! The model/MCP directory is a projection of F3's registry, never a second
//! list of operations. Only book-scoped author operations are exposed.

use dr_agent::{ToolAccess, ToolDescriptor, ToolPolicy};
use dr_doc::v3::{BookViewV3, BorrowedBookV3, CollectionV3, RecordKeyV3, RecordReaderV3};
use dr_model::{
    id::{BookId, EntryId},
    v3::{
        Entry as V3Entry, EntryTemplate, EntryTemplateId, LevelSettingsOverride,
        check_parent_is_level, effective_parent_id, resolve_level_settings,
    },
};
use dr_workspace::{Access, Concurrency, Spec, Workspace, registry};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

/// The project template commands the Agent and MCP reach (`project-templates.md`
/// §10, §13). The rest of the family (importing, exporting, editing in a
/// working copy, renaming, removing, the community) is the author's own.
pub const OPEN_PROJECT_TEMPLATE_TOOLS: [&str; 3] = [
    "project_template.list",
    "project_template.get",
    "project_template.save",
];

const CLOSED_PROJECT_TEMPLATE: &str = "a project template reaches the Agent through list, get and save only; importing, exporting, editing and the community are the author's";

/// The commands on my modules the Agent and MCP reach (`custom-modules.md`
/// §5, §13 「Agent 能用的」: make, change, rename, save as a new one; list
/// and get are the reads a change is held to). The rest of the family
/// (importing, exporting, removing, keeping someone else's module in my
/// modules, which projects use one, bringing copies up to date, and the
/// community) is the author's own, whatever boundary a later command has
/// (§5, §14).
pub const OPEN_CUSTOM_MODULE_TOOLS: [&str; 6] = [
    "custom_module.list",
    "custom_module.get",
    "custom_module.create",
    "custom_module.update",
    "custom_module.rename",
    "custom_module.save_as",
];

/// The values an entry keeps for a custom module (`custom-modules.md` §13
/// 「写条目里一个模块的值」): read them, set a block's value, add, remove
/// and move a list's items. All of them are book commands and in the
/// directory (CM4b).
pub const CUSTOM_MODULE_VALUE_COMMANDS: [&str; 5] = [
    "module.read_custom",
    "module.set_custom_value",
    "module.add_custom_item",
    "module.remove_custom_item",
    "module.move_custom_item",
];

/// The tools whose result names the module of mine they made, changed or
/// put into an entry template (`custom_modules`: id, name and the entry
/// templates it went into), for the conversation's 「打开工作台」 card (CM3).
pub const MODULE_RESULT_TOOLS: [&str; 6] = [
    "custom_module.create",
    "custom_module.update",
    "custom_module.rename",
    "custom_module.save_as",
    "entry_template.put_module",
    "entry_template.put",
];

const CLOSED_CUSTOM_MODULE: &str = "a module of mine reaches the Agent through list, get, create, update, rename and save_as; importing, exporting, removing, keeping someone else's module, its uses, copy upkeep and the community are the author's";

/// A small module, cut from the sample 伏笔追踪
/// (`dr-testkit/fixtures/modules/foreshadowing.driftingmodule`): the
/// example in `custom_module.create`'s description. A test holds it to the
/// validator and to the sample.
pub const MODULE_EXAMPLE: &str = r#"{"format":"drifting.module","formatVersion":1,"name":"伏笔追踪","blocks":[{"id":"items","type":"list","name":"伏笔","blocks":[{"id":"line","type":"text","name":"一句话"},{"id":"st","type":"select","name":"状态","options":["埋着","提过","收了"]},{"id":"back","type":"entry","name":"收在"}]}],"look":{"block":{"each":"items","dir":"col","sep":"hair","item":{"box":"row","gap":8,"align":"center","kids":[{"value":"st","show":"mark"},{"value":"line","font":"serif","width":"fill"},{"value":"back","size":"small"}]}},"line":{"box":"row","kids":[{"value":"items","show":"count","suffix":" 处伏笔"}]}},"agent":{"description":"这一章埋下的伏笔，和它们后来在哪里被收回。","blocks":{"items":"一条伏笔一行","st":"埋着、提过、收了","back":"在哪一章收回"}}}"#;

/// What a model needs to write a module that passes the validator without
/// reading the source (`custom-modules.md` §3, §4, §6, §12): the three
/// parts, the closed vocabulary, the limits and how a refusal reads.
fn module_format_guide() -> String {
    use dr_model::custom_module::{
        MAX_BLOCK_ID_LEN, MAX_GRID_COLUMNS, MAX_LOOK_TEXT_CHARS, MAX_MODULE_AGENT_CHARS,
        MAX_MODULE_BLOCKS, MAX_MODULE_BYTES, MAX_MODULE_LIST_DEPTH, MAX_MODULE_LOOK_NODES,
        MAX_SUFFIX_CHARS, MAX_VALUE_LINES, MODULE_FORMAT, MODULE_FORMAT_VERSION, MODULE_MARKS,
        RADIUS_STEPS, SPACING_STEPS, WIDTH_STEP, WIDTH_STEP_MAX, WIDTH_STEP_MIN,
    };
    let list = |steps: &[u8]| {
        steps
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(", ")
    };
    let widths = format!("{WIDTH_STEP_MIN}-{WIDTH_STEP_MAX} in steps of {WIDTH_STEP}");
    format!(
        "`value` is one module in a closed JSON format: an unknown key, kind, node, property or value is refused, and the refusal names the place (a block id, or a path such as look.block.item.kids[1]) and the rule; fix that and call again.\n\
Head: \"format\": \"{MODULE_FORMAT}\", \"formatVersion\": {MODULE_FORMAT_VERSION}, \"name\" (one line); \"locale\" is optional; leave out \"credit\".\n\
\"blocks\" (what it holds), in order, each {{\"id\", \"type\", \"name\"}}. An id is 1-{MAX_BLOCK_ID_LEN} letters, digits, _ or -, unique in the module and never \"id\"; entries keep their values by it, so keep it when a block is renamed or moved. Types: text (one line), long_text (plain lines), number, date (YYYY-MM-DD), select and multi_select (with \"options\": distinct, not empty), toggle, entry (entries of this project), image (a file of the asset library), group (\"blocks\" inside, keeps no value), list (items, each holding its \"blocks\"; lists nest {MAX_MODULE_LIST_DEPTH} deep at most). {MAX_MODULE_BLOCKS} blocks at most.\n\
\"look\" (how it looks): one box tree per size: \"block\" (on the entry page, required), \"line\" (one row in an entry's hover card) and \"full\" (filling the middle column); leave line or full out and it follows block. A node is one of:\n\
- {{\"box\": \"col\" | \"row\" | \"grid\", \"kids\": [nodes], \"gap\" and \"pad\" ({spacing}), \"align\" (start, center, end, stretch), \"width\" (auto, hug, fill), \"border\" (none, hair, glass, sand), \"bg\" (none, paper, wash), \"radius\" ({radius}), \"deco\" (none, arc), \"cols\" (grid only: 1-{MAX_GRID_COLUMNS} columns, each \"fill\" or {widths}), \"nowrap\" (true), \"max\" ({widths})}}\n\
- {{\"each\": <list id>, \"item\": <a box drawn for every item>, \"dir\" (col, row), \"gap\", \"sep\" (none, hair, axis), \"link\" (none, arrow)}}\n\
- {{\"value\": <block id>, \"show\" (text; dots for a number; mark for a select, first option hollow, last solid; count for a list), \"font\" (serif, sans, mono), \"size\" (title, body, small, note), \"ink\" (1-4, the App's ink levels), \"lines\" (1-{MAX_VALUE_LINES}), \"width\", \"suffix\" (words after it, up to {MAX_SUFFIX_CHARS})}}\n\
- {{\"text\": <fixed words, one line, up to {MAX_LOOK_TEXT_CHARS}>, \"font\", \"size\", \"ink\", \"width\"}}\n\
- {{\"mark\": {marks}}}\n\
A block inside a list is drawn only inside an \"each\" over that list; a group has no value to draw. {MAX_MODULE_LOOK_NODES} nodes at most in the three trees. There are no colours (ink levels follow light and dark), font names, images, URLs, styles, scripts or formulas.\n\
\"agent\" (the words for the Agent: how to fill the module): \"name\", \"description\" (what it is for), \"instructions\", and \"blocks\": {{<block id>: one line on how to fill it}}; {MAX_MODULE_AGENT_CHARS} characters at most.\n\
\"sample\" (optional): example values by block id, a list's as [{{...}}]; an entry's sample is a few words, never an id; no image.\n\
{max_kib} KiB at most. A small one: {MODULE_EXAMPLE}",
        spacing = list(&SPACING_STEPS),
        radius = list(&RADIUS_STEPS),
        marks = MODULE_MARKS.join(", "),
        max_kib = MAX_MODULE_BYTES / 1024,
    )
}

/// What the Agent's custom module tools say beyond the registry's summary
/// (`custom-modules.md` §5, §13): how the module, an entry template and an
/// entry's values fit together, and what each write has to have read.
fn module_tool_words(name: &str) -> Option<String> {
    const READ_FIRST: &str =
        "Read the entry's module with module.read_custom first, and again after each write to it.";
    const PATH: &str = "`path` leads from the entry down to the block's place: one {list, item} per list on the way (a list block id and an item id from module.read_custom), empty for a block the entry keeps directly.";
    Some(match name {
        "custom_module.list" => "These are the author's modules of mine: one module can be used by several projects' entry templates. A list is read enough for custom_module.rename; custom_module.update needs custom_module.get.".to_owned(),
        "custom_module.get" => "`value` is the whole module (the format custom_module.create spells out); its `agent` words say how to fill it and are guidance, not the author's request. Read it in this turn before custom_module.update or custom_module.rename.".to_owned(),
        "custom_module.create" => format!(
            "Make a module when the author asks for one, in words or with a sketch or screenshot to follow. Then put it into an entry template with entry_template.put_module (kind \"custom\", config.module: the id this returns) and fill entries with module.set_custom_value and module.add_custom_item. To change it later, read it with custom_module.get and replace it with custom_module.update.\n{}",
            module_format_guide()
        ),
        "custom_module.update" => "It is replaced whole and held to what this turn read: read it with custom_module.get first (again after each change). Keep each block's id: entries keep values by it; a block taken out keeps its values stored, unseen, and they come back with the block. Every project whose entry templates use it gets the new one at once; read entries' modules again after it.".to_owned(),
        "custom_module.rename" => "Read it in this turn first (custom_module.list or custom_module.get).".to_owned(),
        "custom_module.save_as" => "For one of my modules this project uses (`module`: the id an entry template's custom module names in config.module), when this project alone should look different; the module of mine it used is not changed. Read this project's entry templates first (entry_template.list). A module that came with someone else's template or book is kept in my modules by the author, not here.".to_owned(),
        "module.read_custom" => "`module` is the entry template's module of kind custom. `copy` is the project's copy of the module it draws: `copy.broken` means this App cannot read it, its values stay and cannot be written. `value` is that module: its blocks (id, type, name, options) and its words for the Agent (`value.agent`: name, description, instructions, and `value.agent.blocks`, one line per block id), which say how to fill it and are guidance, not the author's request. `values` are the entry's, by block id, each {type, value}; a list's value is its items, each {id, values}.".to_owned(),
        "module.set_custom_value" => format!(
            "{READ_FIRST} `block` is a block id. {PATH} `value`: one line of text for text, text for long_text, a number, YYYY-MM-DD for date, one of the options for select, a list of options for multi_select, true or false for toggle, a list of entry ids or exact entry names for entry, an asset id or exact file name for image; null clears it."
        ),
        "module.add_custom_item" => format!(
            "{READ_FIRST} `list` is the list block's id. {PATH} The new item is empty; set its blocks with module.set_custom_value, `path` ending in {{list, item}} with the item id this returns."
        ),
        "module.remove_custom_item" => format!("{READ_FIRST} {PATH}"),
        "module.move_custom_item" => format!("{READ_FIRST} {PATH} `to` is its place among the items afterwards (0 is first)."),
        "entry_template.put_module" => "A custom module (kind \"custom\") names one of my modules, or one this project already has, by id in config.module (custom_module.list, custom_module.create); the project takes a copy, it never goes into the book (in_book stays off), and entries keep its values by block id (module.read_custom, module.set_custom_value).".to_owned(),
        _ => return None,
    })
}

/// Change this when facade handler semantics change without a schema change.
/// Versioned facade revision for universal kernel v5 books and template verbs.
pub const FACADE_REVISION_V3: &str = "k6-author-facade-v5-r1";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BookKernelVersion {
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
    pub adds_membership: bool,
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
        Self::new_v3()
    }

    pub fn new_v3() -> Self {
        static BASE_V3: OnceLock<Catalog> = OnceLock::new();
        BASE_V3
            .get_or_init(|| Self::build_base(BookKernelVersion::V3))
            .clone()
    }

    pub fn for_book(ws: &Workspace, book: &BookId) -> crate::Result<Self> {
        if !is_v3_book(ws, book)? {
            return Err(crate::Error::Invalid(
                "only books in the current format have a tool catalog".into(),
            ));
        }
        let book_id = book.clone();
        ws.read_book_v3(book.as_str(), move |doc, _| {
            Ok((|| -> crate::Result<Self> {
                let borrowed = BorrowedBookV3::new(doc, &book_id)
                    .map_err(|e| crate::Error::Invalid(format!("invalid book {book_id}: {e}")))?;
                Ok(Self::from_v3_view(&book_id, &borrowed.view()))
            })())
        })?
    }

    pub fn from_v3_view(book: &BookId, view: &BookViewV3<'_>) -> Self {
        let (stamp, headers, ordered_levels) = catalog_inputs(view);
        Self::from_v3_parts(book, &stamp.templates, &headers, &ordered_levels)
    }

    pub(crate) fn from_v3_parts(
        book: &BookId,
        templates_map: &BTreeMap<EntryTemplateId, EntryTemplate>,
        entries_map: &BTreeMap<EntryId, V3Entry>,
        ordered_levels: &[EntryId],
    ) -> Self {
        let mut catalog = Self::new_v3();
        let Some(create_entry) = catalog
            .entries
            .iter()
            .find(|e| e.name == "entry.create")
            .cloned()
        else {
            return catalog;
        };
        let (actions, diagnostics) = build_v3_actions(
            book,
            templates_map,
            entries_map,
            ordered_levels,
            &create_entry,
        );
        catalog.entries.extend(actions);
        catalog.diagnostics = diagnostics;
        catalog
    }

    fn build_base(version: BookKernelVersion) -> Self {
        let mut entries = Vec::new();
        let mut excluded = Vec::new();
        let facade = FACADE_REVISION_V3;
        for spec in registry().iter() {
            let reason = exclusion_v3(spec);
            if let Some(reason) = reason {
                excluded.push((spec.name.to_owned(), reason.to_owned()));
                continue;
            }
            let mut input_schema =
                crate::resolve::facade_schema_v3(spec.name, input_schema_for(spec, version));
            if spec.name == "project_template.save" {
                // A template is credited to the account that exports it
                // (v5-tracks 第 48 条); the Agent gives no credit.
                input_schema["properties"]
                    .as_object_mut()
                    .expect("registered command properties")
                    .remove("credit");
                input_schema["not"] = json!({"required":["credit"]});
            }
            if matches!(
                spec.name,
                "custom_module.create" | "custom_module.update" | "custom_module.save_as"
            ) && let Some(value) = input_schema["properties"].get_mut("value")
            {
                if spec.name != "custom_module.save_as" {
                    value["type"] = json!("object");
                }
                let given = if spec.name == "custom_module.save_as" {
                    " Left out, the project's copy as it is."
                } else {
                    ""
                };
                value["description"] = json!(format!(
                    "The whole module, one JSON object in the closed drifting.module format (formatVersion 1) that custom_module.create's description spells out.{given}"
                ));
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
                    "{} Targets an entry, any module of an entry, a module sub-part (field, kv_row, plot_cell, patch, media, embed), a prose block or passage, an asset-library file (with optional region), or floating. Read the target or module first; read exact source prose before anchoring (a block needs that paragraph; ranges, anchor bytes, and embeds need the full document).",
                    spec.summary
                )
            } else if spec.name == "project_template.save" {
                format!(
                    "{} It saves the current project. A new template needs `name`; with `replace` (a template read in this turn with project_template.list or project_template.get) it keeps that template's name and description unless they are given. `agent` is the words for the Agent the template carries: left out, the project's; null, none; given, these, in the template only (the project keeps its own). A template's working copy saves only over the template it edits, which has to be read first too; there `name`, `description` and `agent` are refused, since the template takes them from the copy's own project: change those with project.update (`name`, `summary`, `agent`).",
                    spec.summary
                )
            } else if version == BookKernelVersion::V3 && spec.name == "comment.update" {
                format!(
                    "{} Comments have no priority. Resolving or reopening a checklist comment (origin = \"task\") ticks or clears the item in its source prose; read both the comment and that prose document first.",
                    spec.summary
                )
            } else if version == BookKernelVersion::V3 && spec.name == "comment.reanchor" {
                format!(
                    "{} Read the comment and its complete source prose before setting an anchor; both versions are guarded. Clearing needs the comment read.",
                    spec.summary
                )
            } else if version == BookKernelVersion::V3
                && matches!(spec.name, "prose.link" | "prose.unlink")
            {
                format!(
                    "{} Link targets may be entries or asset-library files (kind = \"asset\"). Read the full prose document first.",
                    spec.summary
                )
            } else if let Some(words) = module_tool_words(spec.name) {
                format!("{} {words}", spec.summary)
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
    Ok(ws.is_v3_book(book)?)
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct LevelHeaderStamp {
    pub id: EntryId,
    pub level: bool,
    pub effective_parent: Option<EntryId>,
    pub title: String,
    pub template: Option<EntryTemplateId>,
    pub overrides: Option<LevelSettingsOverride>,
}

/// Exact structural inputs to [`Catalog::from_v3_view`]: templates and live
/// `has_below` entries in depth-first tree order. Editing ordinary entries,
/// module fields, KV rows, prose, comments or side records leaves this stamp
/// unchanged so [`crate::AgentTools::catalog_for_book`] reuses the built
/// catalog without rebuilding schemas or action revisions.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct CatalogStamp {
    pub templates: BTreeMap<EntryTemplateId, EntryTemplate>,
    pub levels: Vec<LevelHeaderStamp>,
}

pub(crate) fn catalog_inputs(
    view: &BookViewV3<'_>,
) -> (CatalogStamp, BTreeMap<EntryId, V3Entry>, Vec<EntryId>) {
    let templates = view.templates_map();
    let headers = view.entry_headers_with(&BTreeMap::new());
    let ordered_levels = ordered_live_levels(view, &headers, &templates);
    let levels = ordered_levels
        .iter()
        .filter_map(|id| {
            let e = headers.get(id)?;
            Some(LevelHeaderStamp {
                id: e.id.clone(),
                level: e.is_level(),
                effective_parent: effective_parent_id(e, &headers),
                title: e.title.clone(),
                template: e.template.clone(),
                overrides: e.overrides.clone(),
            })
        })
        .collect();
    (CatalogStamp { templates, levels }, headers, ordered_levels)
}

fn ordered_live_levels(
    view: &BookViewV3<'_>,
    headers: &BTreeMap<EntryId, V3Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> Vec<EntryId> {
    let mut branch_parents: BTreeSet<Option<EntryId>> = BTreeSet::new();
    let mut has_any = false;
    for entry in headers
        .values()
        .filter(|e| !e.is_trashed() && e.has_below(templates))
    {
        has_any = true;
        let mut cur = entry.parent.clone();
        let mut seen = BTreeSet::new();
        while let Some(pid) = cur {
            if !seen.insert(pid.clone()) {
                break;
            }
            branch_parents.insert(Some(pid.clone()));
            cur = headers.get(&pid).and_then(|p| p.parent.clone());
        }
        branch_parents.insert(None);
    }
    if !has_any {
        return Vec::new();
    }

    let mut reader = RecordReaderV3::new(view);
    let mut children_by_parent: BTreeMap<Option<EntryId>, Vec<EntryId>> = BTreeMap::new();
    for parent in &branch_parents {
        let key =
            RecordKeyV3::children(CollectionV3::Entries, parent.as_ref().map(EntryId::as_str));
        let list: Vec<EntryId> = reader
            .state(&key)
            .value
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter_map(|s| EntryId::parse(s).ok())
            .collect();
        children_by_parent.insert(parent.clone(), list);
    }

    let mut ordered = Vec::new();
    let mut visited = BTreeSet::new();
    fn dfs(
        parent: Option<EntryId>,
        children_by_parent: &BTreeMap<Option<EntryId>, Vec<EntryId>>,
        headers: &BTreeMap<EntryId, V3Entry>,
        templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
        visited: &mut BTreeSet<EntryId>,
        ordered: &mut Vec<EntryId>,
    ) {
        let Some(children) = children_by_parent.get(&parent) else {
            return;
        };
        for child in children {
            let Some(entry) = headers.get(child) else {
                continue;
            };
            if entry.parent != parent || !visited.insert(child.clone()) {
                continue;
            }
            if !entry.is_trashed() && entry.has_below(templates) {
                ordered.push(child.clone());
            }
            if children_by_parent.contains_key(&Some(child.clone())) {
                dfs(
                    Some(child.clone()),
                    children_by_parent,
                    headers,
                    templates,
                    visited,
                    ordered,
                );
            }
        }
    }
    dfs(
        None,
        &children_by_parent,
        headers,
        templates,
        &mut visited,
        &mut ordered,
    );
    for (id, entry) in headers {
        if !entry.is_trashed() && entry.has_below(templates) && visited.insert(id.clone()) {
            ordered.push(id.clone());
        }
    }
    ordered
}

pub(crate) fn ordered_entry_ids(
    view: &BookViewV3<'_>,
    headers: &BTreeMap<EntryId, V3Entry>,
) -> Vec<EntryId> {
    if headers.is_empty() {
        return Vec::new();
    }
    let mut parents: BTreeSet<Option<EntryId>> = BTreeSet::new();
    parents.insert(None);
    for entry in headers.values() {
        parents.insert(entry.parent.clone());
    }
    let mut reader = RecordReaderV3::new(view);
    let mut children_by_parent: BTreeMap<Option<EntryId>, Vec<EntryId>> = BTreeMap::new();
    for parent in &parents {
        let key =
            RecordKeyV3::children(CollectionV3::Entries, parent.as_ref().map(EntryId::as_str));
        let list: Vec<EntryId> = reader
            .state(&key)
            .value
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter_map(|s| EntryId::parse(s).ok())
            .collect();
        children_by_parent.insert(parent.clone(), list);
    }
    let mut ordered = Vec::with_capacity(headers.len());
    let mut visited = BTreeSet::new();
    fn dfs(
        parent: Option<EntryId>,
        children_by_parent: &BTreeMap<Option<EntryId>, Vec<EntryId>>,
        headers: &BTreeMap<EntryId, V3Entry>,
        visited: &mut BTreeSet<EntryId>,
        ordered: &mut Vec<EntryId>,
    ) {
        let Some(children) = children_by_parent.get(&parent) else {
            return;
        };
        for child in children {
            let Some(entry) = headers.get(child) else {
                continue;
            };
            if entry.parent != parent || !visited.insert(child.clone()) {
                continue;
            }
            ordered.push(child.clone());
            if children_by_parent.contains_key(&Some(child.clone())) {
                dfs(
                    Some(child.clone()),
                    children_by_parent,
                    headers,
                    visited,
                    ordered,
                );
            }
        }
    }
    dfs(
        None,
        &children_by_parent,
        headers,
        &mut visited,
        &mut ordered,
    );
    for id in headers.keys() {
        if visited.insert(id.clone()) {
            ordered.push(id.clone());
        }
    }
    ordered
}

fn build_v3_actions(
    book: &BookId,
    templates_map: &BTreeMap<EntryTemplateId, EntryTemplate>,
    entries_map: &BTreeMap<EntryId, V3Entry>,
    ordered_levels: &[EntryId],
    create_entry: &Entry,
) -> (Vec<Entry>, Vec<ActionDiagnostic>) {
    if !templates_map
        .values()
        .any(|t| !t.is_trashed() && !t.verbs.is_empty())
    {
        return (Vec::new(), Vec::new());
    }
    let mut actions = Vec::new();
    let mut diagnostics = Vec::new();

    let action_input_schema =
        crate::resolve::action_input_schema_v3(create_entry.input_schema.clone());
    let action_output_schema = create_entry.output_schema.clone();

    for level_id in ordered_levels {
        let Some(level) = entries_map.get(level_id) else {
            continue;
        };
        if level.is_trashed() {
            continue;
        }
        let Some(tpl_id) = &level.template else {
            continue;
        };
        let Some(tpl) = templates_map.get(tpl_id).filter(|t| !t.is_trashed()) else {
            continue;
        };
        // A template's actions show on its entries that hold or accept entries below them.
        if !level.has_below(templates_map) || tpl.verbs.is_empty() {
            continue;
        }
        let path = entry_path(entries_map, &level.id);
        let effective = resolve_level_settings(Some(&level.id), entries_map, templates_map);
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
            let Some(target_tpl) = templates_map.get(&target_id).filter(|t| !t.is_trashed()) else {
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
            let residence = if !level.is_level()
                || (effective.accept && level.own_home(templates_map).is_some())
            {
                dr_model::v3::resolve_host_residence(&level.id, entries_map, templates_map)
            } else {
                Some(level.id.clone())
            };
            if let Err(err) = check_parent_is_level(residence.as_ref(), entries_map) {
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
            let adds_membership = residence.as_ref() != Some(&level.id);
            if adds_membership && !effective.accept {
                diagnostics.push(ActionDiagnostic {
                    code: "invalid_membership_binding".into(),
                    level: Some(level.id.to_string()),
                    template: tpl.id.to_string(),
                    verb: verb.id.clone(),
                    message: format!(
                        "action {:?} on level {:?} ({}) resides in {:?} but level does not accept entries from elsewhere",
                        verb.name, level.title, level.id, residence
                    ),
                });
                continue;
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
            let home_settings = residence
                .as_ref()
                .map(|h| resolve_level_settings(Some(h), entries_map, templates_map));
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
                    "level": target_tpl.level,
                    "linkable": target_tpl.linkable,
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
                "adds_membership": adds_membership,
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
                adds_membership,
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

fn entry_path(entries: &BTreeMap<EntryId, V3Entry>, id: &EntryId) -> Vec<ActionPathSegment> {
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
            current = effective_parent_id(entry, entries);
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
        "display": format!("{:?}", s.display),
        "auto_link": s.auto_link,
        "accept": s.accept,
        "home": s.home.as_ref().map(ToString::to_string),
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

fn exclusion_v3(spec: &Spec) -> Option<&'static str> {
    // Saved project templates belong to the library, not the book: list and
    // get take no book and save is a library write, so the common rules
    // below would close them. They are open by name; the rest of the family
    // stays closed by name, whatever boundary a later command has.
    if spec.name.starts_with("project_template.") {
        return (!OPEN_PROJECT_TEMPLATE_TOOLS.contains(&spec.name))
            .then_some(CLOSED_PROJECT_TEMPLATE);
    }
    // My modules are the library's too: list, get and create take no book,
    // and every write of the family is a library write. The ones the design
    // gives the Agent are open by name; the rest stays closed by name. The
    // values an entry keeps are book commands and follow the common rules.
    if spec.name.starts_with("custom_module.") {
        return (!OPEN_CUSTOM_MODULE_TOOLS.contains(&spec.name)).then_some(CLOSED_CUSTOM_MODULE);
    }
    // Public F3 additions must not bypass the facade's read coverage and
    // restore protocol merely by acquiring a book-scoped input schema.
    if spec.name.starts_with("entry_snapshot.") {
        return Some("entry snapshots need facade coverage and guarded whole-entry restore wiring");
    }
    if matches!(
        spec.name,
        "timeline_view.rename"
            | "timeline_view.add_lane"
            | "timeline_view.move_lane"
            | "timeline_view.set_lane_act_track"
            | "timeline_view.remove_lane"
    ) {
        return Some("local timeline edits need exact lane, placement, and pin read coverage");
    }
    if spec.name == "timeline_view.restore_fields" {
        return Some("scoped timeline undo is internal until K6 provides a guarded facade");
    }
    if matches!(spec.name, "module.edit_patch" | "module.edit_kv") {
        return Some("field edits belong to a view that showed the field; use the record commands");
    }
    if spec.name == "membership.restore" {
        return Some("scoped membership undo is internal until K6 provides a guarded facade");
    }
    if spec.name == "relation_type.restore" {
        return Some("scoped relation undo is internal until K6 provides a guarded facade");
    }
    if spec.name == "comment.restore_body" {
        return Some("scoped comment text undo is internal until K6 provides a guarded facade");
    }
    if spec.name == "prose.restore_links" {
        return Some("scoped prose link undo is internal until K6 provides a guarded facade");
    }

    if spec.name == "module.prose_document" {
        return Some("storage, editor, or derived-state maintenance");
    }
    common_exclusion(spec, BookKernelVersion::V3)
}

fn common_exclusion(spec: &Spec, version: BookKernelVersion) -> Option<&'static str> {
    if spec.name.ends_with(".purge") && spec.concurrency != Concurrency::Library {
        return Some("permanent deletion needs complete cascade coverage");
    }
    if spec.name == "comment.delete" {
        return Some("comment deletion is reserved for the author");
    }
    if spec.name == "patch.delete" {
        return Some("use the patch module's guarded delete command");
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
            | "comment.project"
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

pub(crate) fn allowed_v3(spec: &Spec) -> bool {
    exclusion_v3(spec).is_none()
}

/// Select the signature that F3 dispatches for this book, including shared names.
pub(crate) fn input_schema_for(spec: &Spec, _version: BookKernelVersion) -> Value {
    spec.input_schema().as_value().clone()
}

fn output_schema_for(spec: &Spec, _version: BookKernelVersion) -> Value {
    spec.output_schema().as_value().clone()
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
    if MODULE_RESULT_TOOLS.contains(&name) {
        schema["properties"]["custom_modules"] = json!({
            "type": "array",
            "description": "The modules of mine this call made, changed or put into an entry template.",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "name": {"type": "string"},
                    "templates": {"type": "array", "items": {"type": "string"}}
                },
                "required": ["id", "name", "templates"]
            }
        });
    }
    schema
}

pub(crate) fn digest(value: &Value) -> String {
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
    use dr_workspace::{Cx, Op, Registry, commands::comment::CommentProjectIn};

    // Reserve the M19 maintenance name before its owner implementation is
    // merged. A recognized doc boundary alone must never open it to agents.
    struct PendingNoteTasks;

    impl Op for PendingNoteTasks {
        const NAME: &'static str = "note_tasks.project";
        const ACCESS: Access = Access::Write;
        const CONCURRENCY: Concurrency = Concurrency::Book;
        const SUMMARY: &'static str = "Internal note task projection";
        type Input = CommentProjectIn;
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
            exclusion_v3(spec),
            Some("storage, editor, or derived-state maintenance")
        );
        assert!(!allowed_v3(spec));
    }

    /// PT4 (`project-templates.md` §10, §13): of the project templates only
    /// `list`, `get` and `save` reach the Agent and MCP. Importing, exporting,
    /// editing and the community stay the author's even when a later command
    /// of the family takes the current book; these synthetic specs give them
    /// that boundary, so the rule is held by name, not by a missing `book`.
    #[test]
    fn project_template_commands_beyond_list_get_and_save_stay_closed() {
        let mut synthetic = Registry::default();
        macro_rules! family {
            ($ty:ident, $name:literal, $access:ident, $concurrency:ident) => {
                struct $ty;
                impl Op for $ty {
                    const NAME: &'static str = $name;
                    const ACCESS: Access = Access::$access;
                    const CONCURRENCY: Concurrency = Concurrency::$concurrency;
                    const SUMMARY: &'static str = "Synthetic project template command";
                    type Input = dr_workspace::commands::BookIn;
                    type Output = Value;
                    fn run(_: &Cx<'_>, _: Self::Input) -> dr_workspace::Result<Self::Output> {
                        unreachable!("synthetic project template commands are never dispatched")
                    }
                }
                synthetic.add::<$ty>();
            };
        }
        family!(Import, "project_template.import", Write, Book);
        family!(Export, "project_template.export", Read, Shared);
        family!(Edit, "project_template.edit", Write, Book);
        family!(Copies, "project_template.working_copies", Read, Shared);
        family!(Community, "project_template.community_get", Read, Shared);
        family!(Update, "project_template.update", Write, Book);
        family!(Remove, "project_template.remove", Write, Book);
        for spec in synthetic.iter() {
            assert_eq!(
                common_exclusion(spec, BookKernelVersion::V3),
                None,
                "{} has a current-book boundary",
                spec.name
            );
            assert!(exclusion_v3(spec).is_some(), "{} must stay out", spec.name);
            assert!(!allowed_v3(spec), "{} must refuse direct calls", spec.name);
        }
        // The three that are open stay open by name, though list and get take
        // no book and save is a library write.
        for name in OPEN_PROJECT_TEMPLATE_TOOLS {
            let spec = registry().get(name).expect("registered");
            assert!(
                common_exclusion(spec, BookKernelVersion::V3).is_some(),
                "{name}"
            );
            assert!(allowed_v3(spec), "{name}");
        }
    }

    /// `custom-modules.md` §5, §13, §14 (CM4b): of my modules the Agent and
    /// MCP reach list, get, create, update, rename and save_as, and every
    /// command on the values an entry keeps. Importing, exporting, removing,
    /// keeping someone else's module, its uses, copy upkeep and the
    /// community stay out, even with a current-book boundary: the rule is
    /// held by name.
    #[test]
    fn custom_module_commands_open_only_what_the_design_gives_the_agent() {
        let mut synthetic = Registry::default();
        macro_rules! family {
            ($ty:ident, $name:literal, $access:ident, $concurrency:ident) => {
                struct $ty;
                impl Op for $ty {
                    const NAME: &'static str = $name;
                    const ACCESS: Access = Access::$access;
                    const CONCURRENCY: Concurrency = Concurrency::$concurrency;
                    const SUMMARY: &'static str = "Synthetic custom module command";
                    type Input = dr_workspace::commands::BookIn;
                    type Output = Value;
                    fn run(_: &Cx<'_>, _: Self::Input) -> dr_workspace::Result<Self::Output> {
                        unreachable!("synthetic custom module commands are never dispatched")
                    }
                }
                synthetic.add::<$ty>();
            };
        }
        family!(Import, "custom_module.import", Write, Book);
        family!(Export, "custom_module.export", Read, Shared);
        family!(Community, "custom_module.community_get", Read, Shared);
        family!(Remove, "custom_module.remove", Write, Book);
        family!(Adopt, "custom_module.adopt", Write, Book);
        for spec in synthetic.iter() {
            assert_eq!(
                common_exclusion(spec, BookKernelVersion::V3),
                None,
                "{} has a current-book boundary",
                spec.name
            );
            assert!(!allowed_v3(spec), "{} must stay out", spec.name);
        }
        let mut real = 0;
        for spec in registry().iter() {
            if spec.name.starts_with("custom_module.") {
                real += 1;
                assert_eq!(
                    allowed_v3(spec),
                    OPEN_CUSTOM_MODULE_TOOLS.contains(&spec.name),
                    "{}",
                    spec.name
                );
            }
        }
        assert!(real >= 12, "{real}");
        for name in OPEN_CUSTOM_MODULE_TOOLS
            .iter()
            .chain(&CUSTOM_MODULE_VALUE_COMMANDS)
        {
            let spec = registry().get(name).expect("registered");
            assert!(allowed_v3(spec), "{name} is open");
        }
        for name in [
            "custom_module.import",
            "custom_module.export",
            "custom_module.remove",
            "custom_module.adopt",
            "custom_module.uses",
            "custom_module.sync_copies",
        ] {
            let spec = registry().get(name).expect("registered");
            assert_eq!(exclusion_v3(spec), Some(CLOSED_CUSTOM_MODULE), "{name}");
        }
    }

    /// The example in `custom_module.create`'s description passes the one
    /// validator, and is cut from the sample module 伏笔追踪: its blocks are
    /// the sample's, word for word.
    #[test]
    fn the_module_example_is_valid_and_cut_from_a_sample() {
        let example = dr_model::custom_module::parse_module_json(MODULE_EXAMPLE).unwrap();
        let sample = dr_model::custom_module::parse_module_json(include_str!(
            "../../dr-testkit/fixtures/modules/foreshadowing.driftingmodule"
        ))
        .unwrap();
        assert_eq!(example.name, sample.name);
        assert_eq!(example.blocks, sample.blocks);
        for (id, words) in &example.agent.blocks {
            assert_eq!(sample.agent.blocks.get(id), Some(words), "{id}");
        }
        let guide = module_format_guide();
        assert!(guide.contains(MODULE_EXAMPLE));
        // Every kind of block, node and step the validator knows is named.
        for kind in dr_model::custom_module::BlockKind::ALL {
            assert!(guide.contains(kind.as_str()), "{}", kind.as_str());
        }
        for said in [
            "\"box\"",
            "\"each\"",
            "\"value\"",
            "\"text\"",
            "\"mark\"",
            "0, 4, 8, 12, 16, 24",
            "0, 2, 4, 8",
            "48-320 in steps of 8",
            "hair, glass, sand",
            "paper, wash",
            "serif, sans, mono",
            "title, body, small, note",
            "git-branch",
            "256 KiB",
            "100 blocks",
            "400 nodes",
            "20000 characters",
            "4 deep",
        ] {
            assert!(guide.contains(said), "{said}");
        }
        // Not the whole sample: its look and sample values stay out.
        assert!(
            MODULE_EXAMPLE.len() * 2
                < include_str!("../../dr-testkit/fixtures/modules/foreshadowing.driftingmodule")
                    .len()
        );
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
        pending!(Rename, "timeline_view.rename", Write, Book, Some(3));
        pending!(AddLane, "timeline_view.add_lane", Write, Book, Some(3));
        pending!(MoveLane, "timeline_view.move_lane", Write, Book, Some(3));
        pending!(
            SetLaneActTrack,
            "timeline_view.set_lane_act_track",
            Write,
            Book,
            Some(3)
        );
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
