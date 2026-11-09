//! JSON command records. IDs and open enum values use strings, like the existing workspace DTOs.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct FieldDef {
    pub id: String,
    pub name: String,
    pub field_type: String,
    /// Candidate options for `select` and `multi_select`.
    #[serde(default)]
    pub options: Vec<String>,
    /// Optional target template filter when `field_type == "entity_ref"`.
    #[serde(default)]
    pub target_template: Option<String>,
    #[serde(default)]
    pub pos: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum FieldValue {
    Bool(bool),
    Number(f64),
    Text(String),
    List(Vec<String>),
    Null,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ModuleConfig {
    /// For `prose` modules: whether H1/H2/H3 outline headings appear in the outline tree.
    #[serde(default)]
    pub show_outline: bool,
    /// For `prose` modules: whether checklist items project into TODOs.
    #[serde(default)]
    pub task_todos: bool,
    /// For `fields` modules: ordered field definitions.
    #[serde(default)]
    pub defs: Vec<FieldDef>,
    /// For `fields` modules: which field id supplies aliases for auto-linking.
    #[serde(default)]
    pub aliases_field: Option<String>,
    /// For `fields` modules: which field id supplies the display color.
    #[serde(default)]
    pub color_field: Option<String>,
    /// For `fields` modules: which field id supplies the status badge.
    #[serde(default)]
    pub status_field: Option<String>,
    /// For `fields` modules: which field id supplies the summary text.
    #[serde(default)]
    pub summary_field: Option<String>,
    /// For `fields` modules: which field id supplies the portrait `AssetId`.
    #[serde(default)]
    pub portrait_field: Option<String>,
    /// For `kv` modules: initial key/value rows copied into new entries of this template.
    #[serde(default)]
    pub initial_kv: Vec<KvEntry>,
    /// For `plot_grid` modules: initial row count (defaults to 3).
    #[serde(default = "default_plot_lines_u32")]
    pub default_rows: u32,
    /// For `plot_grid` modules: initial column count (defaults to 3).
    #[serde(default = "default_plot_lines_u32")]
    pub default_cols: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ModuleAgentConfig {
    /// Whether the Agent may write to this module.
    #[serde(default = "default_true")]
    pub writable: bool,
    /// Context assembly tier (e.g. `"summary"`, `"on_demand"`, `"full"`).
    #[serde(default)]
    pub read_tier: Option<String>,
    /// One-sentence instruction for the Agent when reading or writing this module.
    #[serde(default)]
    pub instructions: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ModuleSpec {
    pub id: String,
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub pos: Option<String>,
    #[serde(default)]
    pub config: ModuleConfig,
    #[serde(default)]
    pub agent: Option<ModuleAgentConfig>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct LevelSettings {
    /// Default template when creating a new entry under this level (`None` = blank).
    #[serde(default)]
    pub default_template: Option<String>,
    /// Allowed templates for entries placed or accepted into this level.
    /// Empty means all templates are allowed.
    #[serde(default)]
    pub allow: Vec<String>,
    /// Default workspace presentation mode for entries in this level.
    #[serde(default)]
    pub display: String,
    /// Whether leaf entries residing in or belonging to this level participate in auto-linking.
    #[serde(default)]
    pub auto_link: bool,
    /// Whether entries residing elsewhere may belong to this level via `memberships` (`收别处的条目`).
    /// Swimlane levels (`lane == true`) always accept memberships.
    #[serde(default)]
    pub accept: bool,
    /// For levels with `accept == true`: which level entry newly created entries reside under (`新条目住在`).
    /// `None` means they reside under this level itself.
    #[serde(default)]
    pub home: Option<String>,
    /// Whether leaf entries under this level in tree order form a manuscript (`成书`).
    #[serde(default)]
    pub is_manuscript: bool,
    /// Editor formatting shortcut profile for prose under this level (`格式快捷输入`).
    #[serde(default)]
    pub format_shortcuts: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct LevelSettingsOverride {
    /// `None` inherits; `Some(None)` clears to no default template; `Some(Some(t))` sets `t`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub default_template: Option<Option<String>>,
    /// `None` inherits; `Some(vec)` sets the allowed template list (`Some(vec![])` allows all).
    #[serde(default)]
    pub allow: Option<Vec<String>>,
    #[serde(default)]
    pub display: Option<String>,
    #[serde(default)]
    pub auto_link: Option<bool>,
    #[serde(default)]
    pub accept: Option<bool>,
    /// `None` inherits; `Some(None)` means reside in this level itself; `Some(Some(id))` sets `home`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub home: Option<Option<String>>,
    #[serde(default)]
    pub is_manuscript: Option<bool>,
    #[serde(default)]
    pub format_shortcuts: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct TemplateAgentConfig {
    /// Name the Agent uses for entries of this template.
    #[serde(default)]
    pub name: String,
    /// One-sentence description of what this template is and when to use it.
    #[serde(default)]
    pub description: String,
    /// Detailed instructions on what to pay attention to when reading or writing.
    #[serde(default)]
    pub instructions: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct TemplateVerb {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// Template used when this verb creates or converts an entry.
    #[serde(default)]
    pub target_template: Option<String>,
    #[serde(default)]
    pub pos: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EntryTemplate {
    pub id: String,
    /// `level` (层级模板) or `leaf` (叶子模板).
    #[serde(default = "leaf_kind")]
    pub kind: String,
    pub name: String,
    /// Optional badge/icon mark (`记号`).
    #[serde(default)]
    pub mark: Option<String>,
    /// Optional display color (`颜色`).
    #[serde(default)]
    pub color: Option<String>,
    /// Skill-style Agent instructions (`写给帮手的说明`).
    #[serde(default)]
    pub agent: Option<TemplateAgentConfig>,
    /// Ordered module manifest (`modules`).
    /// For `"level"`, only `fields` and `kv` modules are allowed.
    #[serde(default)]
    pub modules: Vec<ModuleSpec>,
    /// Level settings (`settings`, only used when `kind == String::Level`).
    #[serde(default)]
    pub settings: LevelSettingsOverride,
    /// Swimlane toggle (`lane`, only used when `kind == String::Level`).
    #[serde(default)]
    pub lane: bool,
    /// Declared actions (`verbs`, only used when `kind == String::Level`).
    #[serde(default)]
    pub verbs: Vec<TemplateVerb>,
    #[serde(default)]
    pub deleted_at: Option<i64>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EntryLayout {
    /// Position on a board / island canvas.
    #[serde(default)]
    pub board: Option<(f64, f64)>,
    /// Grid coordinates `(col, row)` in a grid layout.
    #[serde(default)]
    pub grid: Option<(i64, i64)>,
    /// Pinned position in the relation graph.
    #[serde(default)]
    pub relation_graph: Option<(f64, f64)>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Entry {
    pub id: String,
    /// Raw parent entry in the `entries` tree (`None` at the root).
    /// List queries apply the leaf-parent tolerance to their filtering.
    pub parent: Option<String>,
    /// Fractional-index position among siblings in the `entries` tree (`文稿顺序`).
    pub pos: String,
    pub title: String,
    /// The template shaping this entry (`None` = untemplated entry).
    pub template: Option<String>,
    /// Per-entry level setting overrides (only meaningful on level entries).
    pub overrides: Option<LevelSettingsOverride>,
    /// Values of `fields` modules: `module_id -> (field_id -> value)`.
    pub fields: BTreeMap<String, BTreeMap<String, FieldValue>>,
    /// Rows of `kv` modules (`kv:<module_id>`): `module_id -> sorted KvEntry list`.
    pub kv: BTreeMap<String, Vec<KvEntry>>,
    /// Stored primary membership host; membership queries filter invalid records.
    pub primary: Option<String>,
    pub layout: EntryLayout,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub deleted_at: Option<i64>,
    /// Set by readers when this leaf participates in auto-linking and its
    /// title or alias collides with an earlier auto-link leaf (`V3-AUTOLINK-NAME-UNIQUE`).
    #[serde(default)]
    pub name_conflict: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Membership {
    pub host: String,
    pub member: String,
    #[serde(default)]
    pub pos: Option<String>,
    #[serde(default)]
    pub created_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct TimelineLane {
    pub entry: String,
    #[serde(default)]
    pub pos: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TimelinePlacement {
    pub entry: String,
    pub at: f64,
    #[serde(default)]
    pub span: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TimelinePin {
    pub id: String,
    pub at: f64,
    pub label: String,
    #[serde(default)]
    pub color: Option<String>,
    /// Optional entry bound to this pin (`V3-TIMELINE-TARGETS-LIVE`).
    #[serde(default)]
    pub entry: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TimelineView {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub pos: Option<String>,
    #[serde(default)]
    pub lanes: Vec<TimelineLane>,
    #[serde(default)]
    pub placements: Vec<TimelinePlacement>,
    #[serde(default)]
    pub pins: Vec<TimelinePin>,
    #[serde(default)]
    pub deleted_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct KvEntry {
    pub id: String,
    pub key: String,
    pub value: String,
    #[serde(default)]
    pub pos: Option<String>,
}
fn default_true() -> bool {
    true
}
fn default_plot_lines_u32() -> u32 {
    3
}
fn leaf_kind() -> String {
    "leaf".into()
}

impl Default for ModuleConfig {
    fn default() -> Self {
        Self {
            show_outline: false,
            task_todos: false,
            defs: Vec::new(),
            aliases_field: None,
            color_field: None,
            status_field: None,
            summary_field: None,
            portrait_field: None,
            initial_kv: Vec::new(),
            default_rows: default_plot_lines_u32(),
            default_cols: default_plot_lines_u32(),
        }
    }
}
