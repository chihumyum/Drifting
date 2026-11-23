//! Canonical data format and unified validator for user project templates
//! (`docs/rust-rewrite/project-templates.md`, `docs/rust-rewrite/project-template-format.md`).
//!
//! Unlike `book:<id>` (which keeps unknown fields and enum values under `UNKNOWN-KEPT`),
//! a project template is a closed, history-free data value shared across libraries,
//! `.driftingtemplate` files and the community catalog:
//! - Every struct rejects unknown fields (`#[serde(deny_unknown_fields)]`).
//! - Every enum rejects unknown variants.
//! - Entry and view identities use deterministic symbolic codes (`e1`, `e2`, … and
//!   `v1`, `v2`, …); real entry, view, book, asset and device IDs never appear.
//! - One validator ([`validate_project_template_value`] / [`parse_project_template_json`])
//!   gates saving from a project, reading from the library, creating a project,
//!   importing a `.driftingtemplate` file, and CI checks.

mod validate;

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::prose::{Align, BlockAttrs, Heading};
use crate::v3::{
    ChildDisplayMode, EntryTemplateId, FieldDef, FieldType, FieldValue, FormatShortcuts,
    LevelSettingsOverride, LinkedText, MediaArrangement, ModuleAgentConfig, ModuleConfig, ModuleId,
    ModuleKind, ModuleSpec, RelationDirection, TemplateAgentConfig, TemplateVerb,
};

pub use validate::{
    ProjectTemplateError, is_symbolic_entry_ref, is_symbolic_view_ref, parse_project_template_json,
    to_canonical_json, validate_project_template_value,
};

/// Fixed `format` discriminator of a Drifting project template.
pub const PROJECT_TEMPLATE_FORMAT: &str = "drifting.project-template";

/// Current `formatVersion` understood by this build.
pub const PROJECT_TEMPLATE_FORMAT_VERSION: i64 = 1;

/// Maximum serialized UTF-8 byte length of a project template (`2 MiB`).
pub const MAX_PROJECT_TEMPLATE_BYTES: usize = 2 * 1024 * 1024;

/// Maximum number of entry templates in one project template.
pub const MAX_PROJECT_TEMPLATE_TEMPLATES: usize = 200;

/// Maximum number of seed/sample entries in one project template.
pub const MAX_PROJECT_TEMPLATE_ENTRIES: usize = 2_000;

/// Maximum total Unicode scalar count across all Agent-facing strings in a
/// project template (`project.agent`, `templates[].agent`,
/// `templates[].modules[].agent.instructions`, `templates[].verbs[].{name, description}`).
pub const MAX_PROJECT_TEMPLATE_AGENT_CHARS: usize = 100_000;

fn default_true() -> bool {
    true
}

fn default_plot_lines() -> u32 {
    3
}

fn is_false(b: &bool) -> bool {
    !*b
}

fn nullable_override<'de, T: Deserialize<'de>, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(d).map(Some)
}

/// Provenance of a template stored in `project-template:<id>.info.origin`
/// (`project-templates.md` §5).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StoredTemplateOrigin {
    /// Saved from one of the author's own projects.
    Own,
    /// Imported from a `.driftingtemplate` file.
    File,
}

impl StoredTemplateOrigin {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Own => "own",
            Self::File => "file",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "own" => Some(Self::Own),
            "file" => Some(Self::File),
            _ => None,
        }
    }
}

/// Optional attribution carried by a project template and recorded in
/// `project.source.credit`: the author's name only (2026-11-15 night: no
/// homepage, no 「改自」; a template carrying either is refused).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectTemplateCredit {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub author: String,
}

impl ProjectTemplateCredit {
    pub fn is_empty(&self) -> bool {
        self.author.is_empty()
    }
}

/// Closed-schema project template value (`project-templates.md` §4).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectTemplateValue {
    pub format: String,
    #[serde(rename = "formatVersion")]
    pub format_version: i64,
    #[serde(rename = "madeWith", default)]
    pub made_with: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub locale: String,
    pub revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credit: Option<ProjectTemplateCredit>,
    pub project: TemplateProject,
    #[serde(default)]
    pub templates: Vec<TemplateEntryTemplate>,
    #[serde(default)]
    pub relation_types: Vec<TemplateRelationType>,
    #[serde(default)]
    pub entries: Vec<TemplateEntry>,
    #[serde(default)]
    pub memberships: Vec<TemplateMembership>,
    #[serde(default)]
    pub views: Vec<TemplateView>,
    #[serde(default)]
    pub template_prose: BTreeMap<String, Vec<TemplateParagraph>>,
    /// The custom modules the template's `custom` modules draw, by module id
    /// (`custom-modules.md` §11): each one a module value of the module
    /// format, carried whole. A module id that my modules have makes the
    /// new project's copy follow my modules (§7).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub modules: BTreeMap<String, crate::custom_module::ModuleValue>,
}

/// Project-level definition inside a [`ProjectTemplateValue`] (no `source`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateProject {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<TemplateAgent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub book: Option<TemplateProjectBook>,
    #[serde(default)]
    pub tabs: Vec<TemplateTab>,
}

/// Agent instructions on the project or an entry template.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateAgent {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub instructions: String,
}

impl From<&TemplateAgentConfig> for TemplateAgent {
    fn from(c: &TemplateAgentConfig) -> Self {
        Self {
            name: c.name.clone(),
            description: c.description.clone(),
            instructions: c.instructions.clone(),
        }
    }
}

impl From<&TemplateAgent> for TemplateAgentConfig {
    fn from(c: &TemplateAgent) -> Self {
        Self {
            name: c.name.clone(),
            description: c.description.clone(),
            instructions: c.instructions.clone(),
        }
    }
}

/// Book configuration inside [`TemplateProject`]: the book is on, with two
/// word targets. The book has no start (it reads from the root,
/// `kernel-v5.md` §3); a template still carrying `root` is refused.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateProjectBook {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub word_target: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daily_word_target: Option<i64>,
}

/// One left-sidebar tab in `project.tabs` (array order defines order). A
/// tab has no name of its own: it is called by what it shows, and one thing
/// has one tab (`kernel-v5.md` §5, 2026-11-15). A tab whose target is not in
/// the template is left out when the template is extracted.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateTab {
    pub mount: TemplateTabMount,
}

/// Symbolic left-sidebar tab mount (`project.tabs[].mount`): the root, an
/// entry or the book. A Tab cannot mount a view (DV, 2026-11-16, author:
/// 「左栏不能挂视图，视图和底栏是绑定的。」), so a template value with
/// `{"kind": "view"}` is refused as an unknown variant.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum TemplateTabMount {
    Root,
    Entry { entry: String },
    Book,
}

/// Closed module kinds allowed in a project template.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TemplateModuleKind {
    Prose,
    Fields,
    #[serde(rename = "kv")]
    KeyValue,
    Patches,
    PlotGrid,
    Children,
    Members,
    Media,
    /// A custom module: `config.module` names one of the template's `modules`.
    Custom,
}

impl From<TemplateModuleKind> for ModuleKind {
    fn from(k: TemplateModuleKind) -> Self {
        match k {
            TemplateModuleKind::Prose => Self::Prose,
            TemplateModuleKind::Fields => Self::Fields,
            TemplateModuleKind::KeyValue => Self::KeyValue,
            TemplateModuleKind::Patches => Self::Patches,
            TemplateModuleKind::PlotGrid => Self::PlotGrid,
            TemplateModuleKind::Children => Self::Children,
            TemplateModuleKind::Members => Self::Members,
            TemplateModuleKind::Media => Self::Media,
            TemplateModuleKind::Custom => Self::Custom,
        }
    }
}

impl TryFrom<&ModuleKind> for TemplateModuleKind {
    type Error = String;
    fn try_from(k: &ModuleKind) -> Result<Self, Self::Error> {
        match k {
            ModuleKind::Prose => Ok(Self::Prose),
            ModuleKind::Fields => Ok(Self::Fields),
            ModuleKind::KeyValue => Ok(Self::KeyValue),
            ModuleKind::Patches => Ok(Self::Patches),
            ModuleKind::PlotGrid => Ok(Self::PlotGrid),
            ModuleKind::Children => Ok(Self::Children),
            ModuleKind::Members => Ok(Self::Members),
            ModuleKind::Media => Ok(Self::Media),
            ModuleKind::Custom => Ok(Self::Custom),
            ModuleKind::Other(s) => Err(format!("unknown module kind {s:?}")),
        }
    }
}

/// Closed field types allowed in a project template.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TemplateFieldType {
    Text,
    LongText,
    Number,
    Date,
    Select,
    MultiSelect,
    Image,
    EntityRef,
    Aliases,
    Toggle,
}

impl From<TemplateFieldType> for FieldType {
    fn from(t: TemplateFieldType) -> Self {
        match t {
            TemplateFieldType::Text => Self::Text,
            TemplateFieldType::LongText => Self::LongText,
            TemplateFieldType::Number => Self::Number,
            TemplateFieldType::Date => Self::Date,
            TemplateFieldType::Select => Self::Select,
            TemplateFieldType::MultiSelect => Self::MultiSelect,
            TemplateFieldType::Image => Self::Image,
            TemplateFieldType::EntityRef => Self::EntityRef,
            TemplateFieldType::Aliases => Self::Aliases,
            TemplateFieldType::Toggle => Self::Toggle,
        }
    }
}

impl TryFrom<&FieldType> for TemplateFieldType {
    type Error = String;
    fn try_from(t: &FieldType) -> Result<Self, Self::Error> {
        match t {
            FieldType::Text => Ok(Self::Text),
            FieldType::LongText => Ok(Self::LongText),
            FieldType::Number => Ok(Self::Number),
            FieldType::Date => Ok(Self::Date),
            FieldType::Select => Ok(Self::Select),
            FieldType::MultiSelect => Ok(Self::MultiSelect),
            FieldType::Image => Ok(Self::Image),
            FieldType::EntityRef => Ok(Self::EntityRef),
            FieldType::Aliases => Ok(Self::Aliases),
            FieldType::Toggle => Ok(Self::Toggle),
            FieldType::Other(s) => Err(format!("unknown field type {s:?}")),
        }
    }
}

/// Closed child/member display modes allowed in a project template.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TemplateDisplayMode {
    List,
    Grid,
    Board,
    Island,
}

impl From<TemplateDisplayMode> for ChildDisplayMode {
    fn from(m: TemplateDisplayMode) -> Self {
        match m {
            TemplateDisplayMode::List => Self::List,
            TemplateDisplayMode::Grid => Self::Grid,
            TemplateDisplayMode::Board => Self::Board,
            TemplateDisplayMode::Island => Self::Island,
        }
    }
}

impl TryFrom<&ChildDisplayMode> for TemplateDisplayMode {
    type Error = String;
    fn try_from(m: &ChildDisplayMode) -> Result<Self, Self::Error> {
        match m {
            ChildDisplayMode::List => Ok(Self::List),
            ChildDisplayMode::Grid => Ok(Self::Grid),
            ChildDisplayMode::Board => Ok(Self::Board),
            ChildDisplayMode::Island => Ok(Self::Island),
            ChildDisplayMode::Other(s) => Err(format!("unknown display mode {s:?}")),
        }
    }
}

/// Closed formatting shortcut profiles allowed in a project template.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TemplateFormatShortcuts {
    Full,
    Notes,
    Plain,
}

impl From<TemplateFormatShortcuts> for FormatShortcuts {
    fn from(f: TemplateFormatShortcuts) -> Self {
        match f {
            TemplateFormatShortcuts::Full => Self::Full,
            TemplateFormatShortcuts::Notes => Self::Notes,
            TemplateFormatShortcuts::Plain => Self::Plain,
        }
    }
}

impl TryFrom<&FormatShortcuts> for TemplateFormatShortcuts {
    type Error = String;
    fn try_from(f: &FormatShortcuts) -> Result<Self, Self::Error> {
        match f {
            FormatShortcuts::Full => Ok(Self::Full),
            FormatShortcuts::Notes => Ok(Self::Notes),
            FormatShortcuts::Plain => Ok(Self::Plain),
            FormatShortcuts::Other(s) => Err(format!("unknown format_shortcuts {s:?}")),
        }
    }
}

/// Closed media arrangements allowed in a project template.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TemplateMediaArrangement {
    Featured,
    Grid,
    List,
}

impl From<TemplateMediaArrangement> for MediaArrangement {
    fn from(a: TemplateMediaArrangement) -> Self {
        match a {
            TemplateMediaArrangement::Featured => Self::Featured,
            TemplateMediaArrangement::Grid => Self::Grid,
            TemplateMediaArrangement::List => Self::List,
        }
    }
}

impl TryFrom<&MediaArrangement> for TemplateMediaArrangement {
    type Error = String;
    fn try_from(a: &MediaArrangement) -> Result<Self, Self::Error> {
        match a {
            MediaArrangement::Featured => Ok(Self::Featured),
            MediaArrangement::Grid => Ok(Self::Grid),
            MediaArrangement::List => Ok(Self::List),
            MediaArrangement::Other(s) => Err(format!("unknown media arrangement {s:?}")),
        }
    }
}

/// Key/value row inside a template's `initial_kv` or a sample entry's `kv` (order is array order).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateKvRow {
    pub key: String,
    pub value: String,
}

/// Structured field definition inside a `fields` module (order is array order).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateFieldDef {
    pub id: String,
    pub name: String,
    pub field_type: TemplateFieldType,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_template: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_value: Option<FieldValue>,
}

/// Closed module configuration inside [`TemplateModuleSpec`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateModuleConfig {
    #[serde(default, skip_serializing_if = "is_false")]
    pub show_outline: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub task_todos: bool,
    #[serde(default = "default_true")]
    pub in_book: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub defs: Vec<TemplateFieldDef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aliases_field: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_field: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_field: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary_field: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub portrait_field: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub initial_kv: Vec<TemplateKvRow>,
    #[serde(default = "default_plot_lines")]
    pub default_rows: u32,
    #[serde(default = "default_plot_lines")]
    pub default_cols: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arrangement: Option<TemplateMediaArrangement>,
    /// `custom` modules only: a key of the template's `modules`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub module: Option<String>,
}

impl Default for TemplateModuleConfig {
    fn default() -> Self {
        Self {
            show_outline: false,
            task_todos: false,
            in_book: true,
            defs: Vec::new(),
            aliases_field: None,
            color_field: None,
            status_field: None,
            summary_field: None,
            portrait_field: None,
            initial_kv: Vec::new(),
            default_rows: default_plot_lines(),
            default_cols: default_plot_lines(),
            arrangement: None,
            module: None,
        }
    }
}

/// Closed module-level Agent configuration.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateModuleAgent {
    #[serde(default = "default_true")]
    pub writable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_tier: Option<String>,
    #[serde(default)]
    pub instructions: String,
}

impl From<&ModuleAgentConfig> for TemplateModuleAgent {
    fn from(c: &ModuleAgentConfig) -> Self {
        Self {
            writable: c.writable,
            read_tier: c.read_tier.clone(),
            instructions: c.instructions.clone(),
        }
    }
}

impl From<&TemplateModuleAgent> for ModuleAgentConfig {
    fn from(c: &TemplateModuleAgent) -> Self {
        Self {
            writable: c.writable,
            read_tier: c.read_tier.clone(),
            instructions: c.instructions.clone(),
        }
    }
}

/// One module in a [`TemplateEntryTemplate`] (array order defines order).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateModuleSpec {
    pub id: String,
    pub kind: TemplateModuleKind,
    pub name: String,
    #[serde(default)]
    pub config: TemplateModuleConfig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<TemplateModuleAgent>,
}

/// Sparse settings on an entry template or an entry's `overrides` (no `lane`;
/// `home` uses a symbolic entry ref `e…`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateLevelSettings {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nullable_override"
    )]
    pub default_template: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display: Option<TemplateDisplayMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_link: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accept: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nullable_override"
    )]
    pub home: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format_shortcuts: Option<TemplateFormatShortcuts>,
}

impl TemplateLevelSettings {
    pub fn is_empty(&self) -> bool {
        self.default_template.is_none()
            && self.display.is_none()
            && self.auto_link.is_none()
            && self.accept.is_none()
            && self.home.is_none()
            && self.format_shortcuts.is_none()
    }
}

/// One action declared on a [`TemplateEntryTemplate`] (array order defines order).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateVerbSpec {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_template: Option<String>,
}

/// Entry template inside a [`ProjectTemplateValue`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateEntryTemplate {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mark: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<TemplateAgent>,
    #[serde(default)]
    pub modules: Vec<TemplateModuleSpec>,
    #[serde(default)]
    pub level: bool,
    #[serde(default = "default_true")]
    pub linkable: bool,
    #[serde(default)]
    pub settings: TemplateLevelSettings,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub verbs: Vec<TemplateVerbSpec>,
}

/// An author-defined relation carried without its rows. Description links
/// use the template's symbolic entry references.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateRelationType {
    pub name: String,
    #[serde(default)]
    pub description: LinkedText,
    pub direction: RelationDirection,
}

/// Seed or sample entry in `entries` (preorder traversal; sibling array order defines order).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateEntry {
    #[serde(rename = "ref")]
    pub sym_ref: String,
    #[serde(default)]
    pub parent: Option<String>,
    pub title: String,
    #[serde(default)]
    pub template: Option<String>,
    #[serde(default)]
    pub level: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overrides: Option<TemplateLevelSettings>,
    #[serde(default)]
    pub mark: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub fields: BTreeMap<String, BTreeMap<String, FieldValue>>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub kv: BTreeMap<String, Vec<TemplateKvRow>>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub arrangements: BTreeMap<String, TemplateMediaArrangement>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub prose: BTreeMap<String, Vec<TemplateParagraph>>,
}

/// Membership between two included entries (array order defines per-host member order).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateMembership {
    pub host: String,
    pub member: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub primary: bool,
}

/// Swimlane in a [`TemplateView`] (array order defines lane order).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateViewLane {
    pub entry: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub act_track: Option<bool>,
}

/// Scale placement in a [`TemplateView`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateViewPlacement {
    pub entry: String,
    pub at: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub span: Option<f64>,
}

/// Time pin in a [`TemplateView`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateViewPin {
    pub at: f64,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry: Option<String>,
}

/// Initial view in `views` (array order defines view order).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateView {
    #[serde(rename = "ref")]
    pub sym_ref: String,
    pub name: String,
    #[serde(default)]
    pub lanes: Vec<TemplateViewLane>,
    #[serde(default)]
    pub placements: Vec<TemplateViewPlacement>,
    #[serde(default)]
    pub pins: Vec<TemplateViewPin>,
}

/// Closed list kind in [`TemplateBlockAttrs`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TemplateListKind {
    Bullet,
    Ordered,
    Task,
}

fn is_default_align(a: &Align) -> bool {
    *a == Align::Left
}

fn is_zero_u8(n: &u8) -> bool {
    *n == 0
}

fn is_zero_u32(n: &u32) -> bool {
    *n == 0
}

/// Paragraph block attributes in [`TemplateParagraph`].
/// Heading levels are numbered `1`, `2`, `3` (`H1`/`H2`/`H3` only).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateBlockAttrs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heading: Option<u8>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub quote: bool,
    #[serde(default, skip_serializing_if = "is_zero_u8")]
    pub indent: u8,
    #[serde(default, skip_serializing_if = "is_default_align")]
    pub align: Align,
    #[serde(default, skip_serializing_if = "is_false")]
    pub rule: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list: Option<TemplateListKind>,
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub list_level: u32,
    #[serde(default, skip_serializing_if = "is_false")]
    pub checked: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code_block: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub callout: Option<String>,
}

impl TemplateBlockAttrs {
    pub fn is_plain(&self) -> bool {
        *self == Self::default()
    }

    pub fn from_block_attrs(a: &BlockAttrs) -> Result<Self, String> {
        let list = match &a.list {
            None => None,
            Some(crate::kind::ListKind::Bullet) => Some(TemplateListKind::Bullet),
            Some(crate::kind::ListKind::Ordered) => Some(TemplateListKind::Ordered),
            Some(crate::kind::ListKind::Task) => Some(TemplateListKind::Task),
            Some(crate::kind::ListKind::Other(s)) => {
                return Err(format!("unknown list kind {s:?}"));
            }
        };
        Ok(Self {
            heading: a.heading.map(|h| h.level() as u8),
            quote: a.quote,
            indent: a.indent,
            align: a.align,
            rule: a.rule,
            list,
            list_level: a.list_level,
            checked: a.checked,
            code_block: a.code_block.clone(),
            callout: a.callout.clone(),
        })
    }

    pub fn to_block_attrs(&self) -> Result<BlockAttrs, String> {
        let heading = match self.heading {
            None => None,
            Some(1) => Some(Heading::H1),
            Some(2) => Some(Heading::H2),
            Some(3) => Some(Heading::H3),
            Some(other) => return Err(format!("invalid heading level {other} (expected 1..=3)")),
        };
        let list = self.list.map(|k| match k {
            TemplateListKind::Bullet => crate::kind::ListKind::Bullet,
            TemplateListKind::Ordered => crate::kind::ListKind::Ordered,
            TemplateListKind::Task => crate::kind::ListKind::Task,
        });
        Ok(BlockAttrs {
            heading,
            quote: self.quote,
            indent: self.indent,
            align: self.align,
            rule: self.rule,
            list,
            list_level: self.list_level,
            checked: self.checked,
            todo: None,
            code_block: self.code_block.clone(),
            callout: self.callout.clone(),
        })
    }
}

/// Symbolic inline link to an entry in [`TemplateRun`].
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateEntityLink {
    pub entry: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub module: Option<String>,
    /// Picked with @ (`kernel-v5.md` §16): it shows whatever the target's
    /// 「自动链接」 says. Without it the link is automatic.
    #[serde(default, skip_serializing_if = "is_false")]
    pub manual: bool,
}

/// One run of styled text inside a [`TemplateParagraph`] or [`TemplateTable`] cell.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateRun {
    pub text: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub bold: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub italic: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub underline: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub strike: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub code: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub highlight: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub entities: Vec<TemplateEntityLink>,
}

impl TemplateRun {
    pub fn plain(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            ..Self::default()
        }
    }

    pub fn same_marks(&self, other: &Self) -> bool {
        self.bold == other.bold
            && self.italic == other.italic
            && self.underline == other.underline
            && self.strike == other.strike
            && self.code == other.code
            && self.link == other.link
            && self.highlight == other.highlight
            && self.entities == other.entities
    }
}

/// Table embed inside a [`TemplateParagraph`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateTable {
    pub cols: u32,
    pub rows: Vec<Vec<Vec<TemplateRun>>>,
}

/// One paragraph of prose in `template_prose` or `entries[].prose`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateParagraph {
    #[serde(default, skip_serializing_if = "TemplateBlockAttrs::is_plain")]
    pub attrs: TemplateBlockAttrs,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub runs: Vec<TemplateRun>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table: Option<TemplateTable>,
}

// ---- helpers to convert validated template specs into domain records --------

impl TemplateLevelSettings {
    pub fn to_domain(
        &self,
        entry_map: &BTreeMap<String, crate::id::EntryId>,
    ) -> Result<LevelSettingsOverride, String> {
        let default_template = match &self.default_template {
            None => None,
            Some(None) => Some(None),
            Some(Some(s)) => Some(Some(
                EntryTemplateId::parse(s).map_err(|e| format!("default_template: {e}"))?,
            )),
        };
        let home = match &self.home {
            None => None,
            Some(None) => Some(None),
            Some(Some(sym)) => {
                Some(Some(entry_map.get(sym).cloned().ok_or_else(|| {
                    format!("unknown symbolic entry ref {sym:?} in home")
                })?))
            }
        };
        Ok(LevelSettingsOverride {
            default_template,
            display: self.display.map(Into::into),
            auto_link: self.auto_link,
            accept: self.accept,
            home,
            format_shortcuts: self.format_shortcuts.map(Into::into),
        })
    }
}

impl TemplateModuleSpec {
    pub fn to_domain(
        &self,
        pos: crate::pos::PosKey,
        entry_map: &BTreeMap<String, crate::id::EntryId>,
    ) -> Result<ModuleSpec, String> {
        let mut def_pos = crate::pos::PosKey::first();
        let mut defs = Vec::with_capacity(self.config.defs.len());
        for (idx, d) in self.config.defs.iter().enumerate() {
            if idx > 0 {
                def_pos = def_pos.after();
            }
            let target_template = d
                .target_template
                .as_deref()
                .map(EntryTemplateId::parse)
                .transpose()
                .map_err(|e| format!("field target_template: {e}"))?;
            let field_type: FieldType = d.field_type.into();
            let default_value = match &d.default_value {
                None | Some(FieldValue::Null) => None,
                Some(v) if field_type == FieldType::EntityRef => {
                    Some(rewrite_entity_ref_value(v, entry_map)?)
                }
                Some(v) => Some(v.clone()),
            };
            defs.push(FieldDef {
                id: d.id.clone(),
                name: d.name.trim().to_owned(),
                field_type,
                options: d.options.clone(),
                target_template,
                default_value,
                pos: Some(def_pos.clone()),
            });
        }
        let mut kv_pos = crate::pos::PosKey::first();
        let mut initial_kv = Vec::with_capacity(self.config.initial_kv.len());
        for (idx, row) in self.config.initial_kv.iter().enumerate() {
            if idx > 0 {
                kv_pos = kv_pos.after();
            }
            initial_kv.push(crate::shared::KvEntry {
                id: crate::id::KvEntryId::new_v7(),
                key: row.key.clone(),
                value: row.value.clone(),
                pos: Some(kv_pos.clone()),
            });
        }
        Ok(ModuleSpec {
            id: ModuleId::parse(&self.id).map_err(|e| format!("module id: {e}"))?,
            kind: self.kind.into(),
            name: self.name.trim().to_owned(),
            pos: Some(pos),
            config: ModuleConfig {
                show_outline: self.config.show_outline,
                task_todos: self.config.task_todos,
                in_book: self.config.in_book,
                defs,
                aliases_field: self.config.aliases_field.clone(),
                color_field: self.config.color_field.clone(),
                status_field: self.config.status_field.clone(),
                summary_field: self.config.summary_field.clone(),
                portrait_field: self.config.portrait_field.clone(),
                initial_kv,
                default_rows: self.config.default_rows,
                default_cols: self.config.default_cols,
                arrangement: self.config.arrangement.map(Into::into),
                module: self
                    .config
                    .module
                    .as_deref()
                    .map(crate::id::CustomModuleId::parse)
                    .transpose()
                    .map_err(|e| format!("custom module id: {e}"))?,
            },
            agent: self.agent.as_ref().map(Into::into),
        })
    }
}

impl TemplateEntryTemplate {
    pub fn to_domain(
        &self,
        entry_map: &BTreeMap<String, crate::id::EntryId>,
    ) -> Result<crate::v3::EntryTemplate, String> {
        let mut mod_pos = crate::pos::PosKey::first();
        let mut modules = Vec::with_capacity(self.modules.len());
        for (idx, m) in self.modules.iter().enumerate() {
            if idx > 0 {
                mod_pos = mod_pos.after();
            }
            modules.push(m.to_domain(mod_pos.clone(), entry_map)?);
        }
        let mut verb_pos = crate::pos::PosKey::first();
        let mut verbs = Vec::with_capacity(self.verbs.len());
        for (idx, v) in self.verbs.iter().enumerate() {
            if idx > 0 {
                verb_pos = verb_pos.after();
            }
            verbs.push(TemplateVerb {
                id: v.id.clone(),
                name: v.name.trim().to_owned(),
                description: v.description.clone(),
                target_template: v
                    .target_template
                    .as_deref()
                    .map(EntryTemplateId::parse)
                    .transpose()
                    .map_err(|e| format!("verb target_template: {e}"))?,
                pos: Some(verb_pos.clone()),
            });
        }
        Ok(crate::v3::EntryTemplate {
            id: EntryTemplateId::parse(&self.id).map_err(|e| format!("template id: {e}"))?,
            name: self.name.trim().to_owned(),
            mark: self.mark.clone(),
            color: self.color.clone(),
            agent: self.agent.as_ref().map(Into::into),
            modules,
            level: self.level,
            linkable: self.linkable,
            settings: self.settings.to_domain(entry_map)?,
            verbs,
            deleted_at: None,
        })
    }
}

/// Rewrite symbolic entry ref(s) inside an `EntityRef` `FieldValue` into real `EntryId`s.
pub fn rewrite_entity_ref_value(
    value: &FieldValue,
    entry_map: &BTreeMap<String, crate::id::EntryId>,
) -> Result<FieldValue, String> {
    match value {
        FieldValue::Text(sym) => {
            let real = entry_map
                .get(sym)
                .ok_or_else(|| format!("unknown symbolic entry ref {sym:?} in entity_ref"))?;
            Ok(FieldValue::Text(real.to_string()))
        }
        FieldValue::Null => Ok(FieldValue::Null),
        other => Err(format!("invalid entity_ref value {other:?}")),
    }
}
