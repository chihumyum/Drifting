//! Universal kernel v3 domain types, without Loro (`docs/rust-rewrite/kernel-v3.md`).
//!
//! In v3, a book's structured content lives in a single entry tree (`entries`).
//! Entries come in two kinds determined by their [`EntryTemplate`]:
//! - **Levels (`TemplateKind::Level`)**: hold child entries, carry a description
//!   prose document (`body:<entry_id>/about`), fields, and key/value rows, and
//!   configure level settings (`LevelSettings`, inherited down the tree), a
//!   swimlane toggle (`lane`), and domain actions (`verbs`).
//! - **Leaves (`TemplateKind::Leaf`)**: hold content modules (`prose`, `fields`,
//!   `kv`, `patches`, `plot_grid`, `relations`) and cannot have child entries.
//!
//! Cross-cutting memberships (`memberships`) are governed by the target level's
//! `accept` and `allow` settings, and timeline views (`timeline_views`) place
//! entries that belong to at least one swimlane in the view.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

pub use crate::book::sort_kv;
use crate::book::{
    BlockSnapshot, DEFAULT_DAILY_WORD_TARGET, DEFAULT_WORD_TARGET, EncodedAnchor, EntityRef,
    KvEntry, MaterialRegion, PLOT_DEFAULT_CELL, PLOT_DEFAULT_LINES, PlotLine, TodoProjection,
    element_name_key,
};
use crate::check::{Violation, non_empty_name};
pub use crate::id::{
    AssetId, BlockId, BodyDocId, BookId, CommentId, DocId, EntryId, EntryTemplateId, KvEntryId,
    MaterialFolderId, MaterialId, MemoryId, ModuleId, PatchId, PlotColId, PlotRowId, RelationId,
    RelationTypeId, TemplateId, TimePinId, TimelineViewId,
};
use crate::kind::{
    CommentAuthorKind, CommentKind, CommentPriority, CommentSource, CommentStatus, EntityKind,
    RelationOrientation, SystemRelationKey,
};
use crate::order::cmp_order;
use crate::pos::{PosKey, cmp_pos};
use crate::time::Timestamp;

/// Reserved module id for a level entry's own description prose (`body:<entry_id>/about`).
pub const LEVEL_ABOUT_MODULE: &str = "about";

/// The [`ModuleId`] for a level entry's description prose (`body:<entry_id>/about`).
pub fn level_about_module_id() -> ModuleId {
    ModuleId::parse(LEVEL_ABOUT_MODULE).expect("valid module id")
}

macro_rules! v3_open_enum {
    (
        $(#[$meta:meta])*
        $name:ident {
            $( $(#[$vmeta:meta])* $var:ident = $s:literal ),+ $(,)?
        }
    ) => {
        $(#[$meta])*
        #[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub enum $name {
            $( $(#[$vmeta])* $var, )+
            /// A value this version does not know, kept as written.
            Other(Box<str>),
        }

        impl $name {
            pub const KNOWN: &'static [&'static str] = &[$($s),+];

            pub fn parse(s: &str) -> Self {
                match s {
                    $( $s => Self::$var, )+
                    other => Self::Other(other.into()),
                }
            }

            pub fn as_str(&self) -> &str {
                match self {
                    $( Self::$var => $s, )+
                    Self::Other(s) => s,
                }
            }

            pub fn is_known(&self) -> bool {
                !matches!(self, Self::Other(_))
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                match self {
                    Self::Other(s) => write!(f, "{}::Other({:?})", stringify!($name), s),
                    _ => write!(f, "{}::{}", stringify!($name), self.as_str()),
                }
            }
        }

        impl From<&str> for $name {
            fn from(s: &str) -> Self {
                Self::parse(s)
            }
        }

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_str(self.as_str())
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let s = String::deserialize(d)?;
                Ok(Self::parse(&s))
            }
        }
    };
}

v3_open_enum!(
    /// Whether an [`EntryTemplate`] defines a level (`层级模板`) or a leaf (`叶子模板`).
    #[derive(Default)]
    TemplateKind {
        /// A level entry that can hold child entries and level settings.
        Level = "level",
        /// A leaf entry that holds content modules and cannot have child entries.
        #[default]
        Leaf = "leaf",
    }
);

v3_open_enum!(
    /// Which kind of module a [`ModuleSpec`] declares (`kernel-v3.md` "模块").
    ModuleKind {
        /// Rich text (`body:<entry_id>/<module_id>`). Leaf templates only
        /// (levels always have their built-in `body:<entry_id>/about`).
        Prose = "prose",
        /// Structured fields (`fields.<module_id>` on the entry).
        Fields = "fields",
        /// Author-extensible key/value rows (`kv:<module_id>` on the entry).
        KeyValue = "kv",
        /// Excerpt patches attached to `(entry_id, module_id)` in `patches`.
        Patches = "patches",
        /// Entity relations view scoped to this entry in `relations`.
        Relations = "relations",
        /// A 2D plot grid keyed by `<entry_id>/<module_id>` in `plot_grids`.
        PlotGrid = "plot_grid",
    }
);

impl ModuleKind {
    /// Level templates may only declare `fields` and `kv` modules (`kernel-v3.md`
    /// "数据结构": "层级模板只能有字段和键值表").
    pub fn allowed_on_level(&self) -> bool {
        matches!(self, ModuleKind::Fields | ModuleKind::KeyValue)
    }
}

v3_open_enum!(
    /// How a level displays its child and member entries in the workspace.
    #[derive(Default)]
    ChildDisplayMode {
        #[default]
        List = "list",
        Grid = "grid",
        Board = "board",
        Island = "island",
    }
);

v3_open_enum!(
    /// Editor formatting shortcut profile for prose under a level.
    /// Does not restrict the underlying prose Loro schema.
    #[derive(Default)]
    FormatShortcuts {
        #[default]
        Full = "full",
        Notes = "notes",
        Plain = "plain",
    }
);

v3_open_enum!(
    /// Which field type a [`FieldDef`] declares (`kernel-v3.md` "模块":
    /// 文字、长文字、数字、日期、单选、多选、图片、条目引用、别名).
    FieldType {
        Text = "text",
        LongText = "long_text",
        Number = "number",
        Date = "date",
        Select = "select",
        MultiSelect = "multi_select",
        Image = "image",
        EntityRef = "entity_ref",
        Aliases = "aliases",
        Toggle = "toggle",
    }
);

/// Definition of a structured field inside a `fields` module.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldDef {
    pub id: String,
    pub name: String,
    pub field_type: FieldType,
    /// Candidate options for `select` and `multi_select`.
    #[serde(default)]
    pub options: Vec<String>,
    /// Optional target template filter when `field_type == FieldType::EntityRef`.
    #[serde(default)]
    pub target_template: Option<EntryTemplateId>,
    #[serde(default)]
    pub pos: Option<PosKey>,
}

/// Sort field definitions by position key, ties by field id.
pub fn sort_field_defs(defs: &mut [FieldDef]) {
    defs.sort_by(|a, b| cmp_pos((a.pos.as_ref(), &a.id), (b.pos.as_ref(), &b.id)));
}

/// A value stored in an entry's `fields.<module_id>.<field_id>` slot.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FieldValue {
    Bool(bool),
    Number(f64),
    Text(String),
    List(Vec<String>),
    Null,
}

impl FieldValue {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            FieldValue::Text(s) => Some(s.as_str()),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            FieldValue::Number(n) if n.is_finite() => Some(*n),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            FieldValue::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_list(&self) -> Option<&[String]> {
        match self {
            FieldValue::List(v) => Some(v.as_slice()),
            _ => None,
        }
    }

    /// Trimmed non-empty strings from either a `List` or a single `Text` value.
    pub fn trimmed_strings(&self) -> Vec<String> {
        match self {
            FieldValue::List(v) => v
                .iter()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned)
                .collect(),
            FieldValue::Text(s) => {
                let t = s.trim();
                if t.is_empty() {
                    Vec::new()
                } else {
                    vec![t.to_owned()]
                }
            }
            _ => Vec::new(),
        }
    }
}

/// Configuration of a [`ModuleSpec`], unioned with open defaults so unknown
/// module kinds or extra properties survive round-trips.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
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

fn default_plot_lines_u32() -> u32 {
    PLOT_DEFAULT_LINES as u32
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

/// Per-module Agent instructions and access settings (`kernel-v3.md` "两种模板").
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
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

fn default_true() -> bool {
    true
}

/// One module in an [`EntryTemplate`]'s module manifest (`modules`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModuleSpec {
    pub id: ModuleId,
    pub kind: ModuleKind,
    pub name: String,
    #[serde(default)]
    pub pos: Option<PosKey>,
    #[serde(default)]
    pub config: ModuleConfig,
    #[serde(default)]
    pub agent: Option<ModuleAgentConfig>,
}

impl ModuleSpec {
    pub fn prose(
        id: ModuleId,
        name: impl Into<String>,
        show_outline: bool,
        task_todos: bool,
    ) -> Self {
        Self {
            id,
            kind: ModuleKind::Prose,
            name: name.into(),
            pos: None,
            config: ModuleConfig {
                show_outline,
                task_todos,
                ..ModuleConfig::default()
            },
            agent: None,
        }
    }

    pub fn fields(id: ModuleId, name: impl Into<String>, defs: Vec<FieldDef>) -> Self {
        Self {
            id,
            kind: ModuleKind::Fields,
            name: name.into(),
            pos: None,
            config: ModuleConfig {
                defs,
                ..ModuleConfig::default()
            },
            agent: None,
        }
    }

    pub fn kv(id: ModuleId, name: impl Into<String>, initial_kv: Vec<KvEntry>) -> Self {
        Self {
            id,
            kind: ModuleKind::KeyValue,
            name: name.into(),
            pos: None,
            config: ModuleConfig {
                initial_kv,
                ..ModuleConfig::default()
            },
            agent: None,
        }
    }

    pub fn patches(id: ModuleId, name: impl Into<String>) -> Self {
        Self {
            id,
            kind: ModuleKind::Patches,
            name: name.into(),
            pos: None,
            config: ModuleConfig::default(),
            agent: None,
        }
    }

    pub fn relations(id: ModuleId, name: impl Into<String>) -> Self {
        Self {
            id,
            kind: ModuleKind::Relations,
            name: name.into(),
            pos: None,
            config: ModuleConfig::default(),
            agent: None,
        }
    }

    pub fn plot_grid(id: ModuleId, name: impl Into<String>, rows: u32, cols: u32) -> Self {
        Self {
            id,
            kind: ModuleKind::PlotGrid,
            name: name.into(),
            pos: None,
            config: ModuleConfig {
                default_rows: rows.max(1),
                default_cols: cols.max(1),
                ..ModuleConfig::default()
            },
            agent: None,
        }
    }
}

/// Sort a module manifest by position key, ties by module id.
pub fn sort_modules(modules: &mut [ModuleSpec]) {
    modules.sort_by(|a, b| cmp_pos((a.pos.as_ref(), &a.id), (b.pos.as_ref(), &b.id)));
}

/// Effective level settings (`层级的设置`, `kernel-v3.md`).
///
/// Resolved by walking from the level entry up its ancestor chain:
/// `entry.overrides > template.settings > nearest ancestor specifying the field > default`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LevelSettings {
    /// Default template when creating a new entry under this level (`None` = blank).
    #[serde(default)]
    pub default_template: Option<EntryTemplateId>,
    /// Allowed templates for entries placed or accepted into this level.
    /// Empty means all templates are allowed.
    #[serde(default)]
    pub allow: Vec<EntryTemplateId>,
    /// Default workspace presentation mode for entries in this level.
    #[serde(default)]
    pub display: ChildDisplayMode,
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
    pub home: Option<EntryId>,
    /// Whether leaf entries under this level in tree order form a manuscript (`成书`).
    #[serde(default)]
    pub is_manuscript: bool,
    /// Editor formatting shortcut profile for prose under this level (`格式快捷输入`).
    #[serde(default)]
    pub format_shortcuts: FormatShortcuts,
}

impl LevelSettings {
    /// Whether `template` is allowed in this level (`allow` empty means any template is allowed).
    pub fn allows_template(&self, template: Option<&EntryTemplateId>) -> bool {
        if self.allow.is_empty() {
            return true;
        }
        match template {
            Some(t) => self.allow.contains(t),
            None => false,
        }
    }
}

// A missing key inherits; an explicit JSON null clears the inherited value.
fn nullable_override<'de, T: Deserialize<'de>, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(d).map(Some)
}

/// Sparse level settings stored on a level [`EntryTemplate`] (`settings`) or a
/// level [`Entry`] (`overrides`). Any `None` field inherits from the template or
/// the nearest ancestor level that specifies it (`kernel-v3.md` "层级的设置").
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LevelSettingsOverride {
    /// `None` inherits; `Some(None)` clears to no default template; `Some(Some(t))` sets `t`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nullable_override"
    )]
    pub default_template: Option<Option<EntryTemplateId>>,
    /// `None` inherits; `Some(vec)` sets the allowed template list (`Some(vec![])` allows all).
    #[serde(default)]
    pub allow: Option<Vec<EntryTemplateId>>,
    #[serde(default)]
    pub display: Option<ChildDisplayMode>,
    #[serde(default)]
    pub auto_link: Option<bool>,
    #[serde(default)]
    pub accept: Option<bool>,
    /// `None` inherits; `Some(None)` means reside in this level itself; `Some(Some(id))` sets `home`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nullable_override"
    )]
    pub home: Option<Option<EntryId>>,
    #[serde(default)]
    pub is_manuscript: Option<bool>,
    #[serde(default)]
    pub format_shortcuts: Option<FormatShortcuts>,
}

/// Alias kept for callers that refer to child settings overrides.
pub type ChildSettings = LevelSettings;
pub type ChildSettingsOverride = LevelSettingsOverride;

impl LevelSettingsOverride {
    pub fn is_empty(&self) -> bool {
        self.default_template.is_none()
            && self.allow.is_none()
            && self.display.is_none()
            && self.auto_link.is_none()
            && self.accept.is_none()
            && self.home.is_none()
            && self.is_manuscript.is_none()
            && self.format_shortcuts.is_none()
    }

    /// Layer `higher` (e.g. an entry's `overrides`) on top of `lower` (e.g. its
    /// template's `settings` or an ancestor's settings).
    pub fn overlay(&self, lower: &LevelSettingsOverride) -> LevelSettingsOverride {
        LevelSettingsOverride {
            default_template: self
                .default_template
                .clone()
                .or_else(|| lower.default_template.clone()),
            allow: self.allow.clone().or_else(|| lower.allow.clone()),
            display: self.display.clone().or_else(|| lower.display.clone()),
            auto_link: self.auto_link.or(lower.auto_link),
            accept: self.accept.or(lower.accept),
            home: self.home.clone().or_else(|| lower.home.clone()),
            is_manuscript: self.is_manuscript.or(lower.is_manuscript),
            format_shortcuts: self
                .format_shortcuts
                .clone()
                .or_else(|| lower.format_shortcuts.clone()),
        }
    }

    /// Materialize concrete [`LevelSettings`] by filling any remaining `None`
    /// fields with system defaults. If `is_lane` is true, `accept` is always `true`
    /// (`kernel-v3.md`: "泳道层级总是收别处的条目").
    pub fn finish(&self, is_lane: bool) -> LevelSettings {
        let def = LevelSettings::default();
        LevelSettings {
            default_template: self
                .default_template
                .clone()
                .unwrap_or(def.default_template),
            allow: self.allow.clone().unwrap_or(def.allow),
            display: self.display.clone().unwrap_or(def.display),
            auto_link: self.auto_link.unwrap_or(def.auto_link),
            accept: is_lane || self.accept.unwrap_or(def.accept),
            home: self.home.clone().unwrap_or(def.home),
            is_manuscript: self.is_manuscript.unwrap_or(def.is_manuscript),
            format_shortcuts: self
                .format_shortcuts
                .clone()
                .unwrap_or(def.format_shortcuts),
        }
    }
}

impl LevelSettings {
    /// Resolve from a single template's settings and an entry's overrides (without ancestors).
    pub fn resolve(
        template_settings: Option<&LevelSettingsOverride>,
        entry_overrides: Option<&LevelSettingsOverride>,
    ) -> Self {
        let empty = LevelSettingsOverride::default();
        let tpl = template_settings.unwrap_or(&empty);
        let ov = entry_overrides.unwrap_or(&empty);
        ov.overlay(tpl).finish(false)
    }
}

/// Skill-style Agent description and instructions on an [`EntryTemplate`]
/// (`kernel-v3.md` "两种模板": 一个名字、一句「这是什么、什么时候用」，再加一段「写的时候注意什么」).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
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

/// An action declared by a level [`EntryTemplate`] (e.g. "新建章节").
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TemplateVerb {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// Template used when this verb creates or converts an entry.
    #[serde(default)]
    pub target_template: Option<EntryTemplateId>,
    #[serde(default)]
    pub pos: Option<PosKey>,
}

/// Sort template verbs by position key, ties by verb id.
pub fn sort_verbs(verbs: &mut [TemplateVerb]) {
    verbs.sort_by(|a, b| cmp_pos((a.pos.as_ref(), &a.id), (b.pos.as_ref(), &b.id)));
}

/// An entry template (`templates` map in the v3 book document).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EntryTemplate {
    pub id: EntryTemplateId,
    /// `level` (层级模板) or `leaf` (叶子模板).
    #[serde(default)]
    pub kind: TemplateKind,
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
    /// For `TemplateKind::Level`, only `fields` and `kv` modules are allowed.
    #[serde(default)]
    pub modules: Vec<ModuleSpec>,
    /// Level settings (`settings`, only used when `kind == TemplateKind::Level`).
    #[serde(default)]
    pub settings: LevelSettingsOverride,
    /// Swimlane toggle (`lane`, only used when `kind == TemplateKind::Level`).
    #[serde(default)]
    pub lane: bool,
    /// Declared actions (`verbs`, only used when `kind == TemplateKind::Level`).
    #[serde(default)]
    pub verbs: Vec<TemplateVerb>,
    #[serde(default)]
    pub deleted_at: Option<Timestamp>,
}

impl EntryTemplate {
    pub fn is_trashed(&self) -> bool {
        self.deleted_at.is_some()
    }

    pub fn is_level(&self) -> bool {
        self.kind == TemplateKind::Level
    }

    pub fn is_leaf(&self) -> bool {
        self.kind == TemplateKind::Leaf
    }

    pub fn is_lane_level(&self) -> bool {
        self.is_level() && self.lane
    }

    pub fn module(&self, id: &ModuleId) -> Option<&ModuleSpec> {
        self.modules.iter().find(|m| &m.id == id)
    }

    pub fn prose_modules(&self) -> impl Iterator<Item = &ModuleSpec> {
        self.modules.iter().filter(|m| m.kind == ModuleKind::Prose)
    }
}

/// Free-canvas coordinates stored on an [`Entry`] (`layout` sub-map).
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
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

impl EntryLayout {
    pub fn sanitized(self) -> Self {
        let finite =
            |pair: Option<(f64, f64)>| pair.filter(|(x, y)| x.is_finite() && y.is_finite());
        Self {
            board: finite(self.board),
            grid: self.grid,
            relation_graph: finite(self.relation_graph),
        }
    }
}

/// An entry in the book's unified `entries` `LoroTree` (`kernel-v3.md` "条目").
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub id: EntryId,
    /// Raw parent entry in the `entries` tree (`None` at the root).
    /// Use [`effective_parent_id`] to read with `V3-LEAF-NO-CHILDREN` tolerance.
    pub parent: Option<EntryId>,
    /// Fractional-index position among siblings in the `entries` tree (`文稿顺序`).
    pub pos: String,
    pub title: String,
    /// The template shaping this entry (`None` = untemplated entry).
    pub template: Option<EntryTemplateId>,
    /// Per-entry level setting overrides (only meaningful on level entries).
    pub overrides: Option<LevelSettingsOverride>,
    /// Values of `fields` modules: `module_id -> (field_id -> value)`.
    pub fields: BTreeMap<ModuleId, BTreeMap<String, FieldValue>>,
    /// Rows of `kv` modules (`kv:<module_id>`): `module_id -> sorted KvEntry list`.
    pub kv: BTreeMap<ModuleId, Vec<KvEntry>>,
    /// Stored primary membership host; use [`Entry::effective_primary`] to read.
    pub primary: Option<EntryId>,
    pub layout: EntryLayout,
    pub created_at: Option<Timestamp>,
    pub updated_at: Option<Timestamp>,
    pub deleted_at: Option<Timestamp>,
    /// Set by readers when this leaf participates in auto-linking and its
    /// title or alias collides with an earlier auto-link leaf (`V3-AUTOLINK-NAME-UNIQUE`).
    #[serde(default)]
    pub name_conflict: Option<EntryId>,
}

impl Entry {
    pub fn is_trashed(&self) -> bool {
        self.deleted_at.is_some()
    }

    /// The active template of this entry: `None` if untemplated or if the
    /// referenced template is missing or trashed (`V3-ENTRY-TEMPLATE-EXISTS`).
    pub fn effective_template<'a>(
        &self,
        templates: &'a BTreeMap<EntryTemplateId, EntryTemplate>,
    ) -> Option<&'a EntryTemplate> {
        let tid = self.template.as_ref()?;
        templates.get(tid).filter(|t| !t.is_trashed())
    }

    /// Whether this entry's active template is a level template (`TemplateKind::Level`).
    pub fn is_level(&self, templates: &BTreeMap<EntryTemplateId, EntryTemplate>) -> bool {
        self.effective_template(templates)
            .is_some_and(EntryTemplate::is_level)
    }

    /// Whether this entry's active template is a leaf template (`TemplateKind::Leaf`).
    pub fn is_leaf(&self, templates: &BTreeMap<EntryTemplateId, EntryTemplate>) -> bool {
        self.effective_template(templates)
            .is_some_and(EntryTemplate::is_leaf)
    }

    /// Whether this entry is a swimlane level (`kind == Level && lane == true`).
    pub fn is_lane_level(&self, templates: &BTreeMap<EntryTemplateId, EntryTemplate>) -> bool {
        self.effective_template(templates)
            .is_some_and(EntryTemplate::is_lane_level)
    }

    /// Switch this entry's template without discarding any stored `fields`,
    /// `kv`, or prose module data (`V3-TEMPLATE-SWITCH-KEEPS-DATA`).
    pub fn switch_template(&mut self, new_template: Option<EntryTemplateId>) {
        self.template = new_template;
    }

    /// The `fields` module values visible under the entry's active template.
    /// When the template is missing (`None`), all stored `fields` are exposed
    /// so untemplated/degraded entries still show their existing data (`V3-ENTRY-TEMPLATE-EXISTS`).
    pub fn visible_fields<'a>(
        &'a self,
        templates: &'a BTreeMap<EntryTemplateId, EntryTemplate>,
    ) -> BTreeMap<&'a ModuleId, &'a BTreeMap<String, FieldValue>> {
        let Some(tpl) = self.effective_template(templates) else {
            return self.fields.iter().collect();
        };
        let mut out = BTreeMap::new();
        for m in &tpl.modules {
            if m.kind == ModuleKind::Fields
                && let Some(vals) = self.fields.get(&m.id)
            {
                out.insert(&m.id, vals);
            }
        }
        out
    }

    /// `fields` modules stored on this entry that are not part of its active
    /// template (`原来的内容` after switching templates, `V3-TEMPLATE-SWITCH-KEEPS-DATA`).
    pub fn orphaned_fields<'a>(
        &'a self,
        templates: &'a BTreeMap<EntryTemplateId, EntryTemplate>,
    ) -> BTreeMap<&'a ModuleId, &'a BTreeMap<String, FieldValue>> {
        let Some(tpl) = self.effective_template(templates) else {
            return BTreeMap::new();
        };
        let active: BTreeSet<&ModuleId> = tpl
            .modules
            .iter()
            .filter(|m| m.kind == ModuleKind::Fields)
            .map(|m| &m.id)
            .collect();
        self.fields
            .iter()
            .filter(|(k, _)| !active.contains(k))
            .collect()
    }

    /// The `kv` module rows visible under the entry's active template (or all
    /// stored `kv` modules if the template is missing).
    pub fn visible_kv<'a>(
        &'a self,
        templates: &'a BTreeMap<EntryTemplateId, EntryTemplate>,
    ) -> BTreeMap<&'a ModuleId, &'a [KvEntry]> {
        let Some(tpl) = self.effective_template(templates) else {
            return self.kv.iter().map(|(k, v)| (k, v.as_slice())).collect();
        };
        let mut out = BTreeMap::new();
        for m in &tpl.modules {
            if m.kind == ModuleKind::KeyValue
                && let Some(rows) = self.kv.get(&m.id)
            {
                out.insert(&m.id, rows.as_slice());
            }
        }
        out
    }

    /// Aliases of this entry extracted from any `fields` module in its active
    /// template that declares `aliases_field` or a `FieldType::Aliases` field.
    pub fn aliases(
        &self,
        templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
    ) -> BTreeSet<String> {
        let mut set = BTreeSet::new();
        let Some(tpl) = self.effective_template(templates) else {
            return set;
        };
        for m in &tpl.modules {
            if m.kind != ModuleKind::Fields {
                continue;
            }
            let Some(vals) = self.fields.get(&m.id) else {
                continue;
            };
            if let Some(field_id) = m.config.aliases_field.as_deref()
                && let Some(val) = vals.get(field_id)
            {
                for s in val.trimmed_strings() {
                    set.insert(s);
                }
            }
            for def in &m.config.defs {
                if def.field_type == FieldType::Aliases
                    && let Some(val) = vals.get(&def.id)
                {
                    for s in val.trimmed_strings() {
                        set.insert(s);
                    }
                }
            }
        }
        set
    }

    /// Effective primary membership host: `Some` only if `self.primary` is in
    /// the entry's valid memberships (`V3-MEMBERSHIP-RULES`).
    pub fn effective_primary(&self, valid_hosts: &BTreeSet<EntryId>) -> Option<&EntryId> {
        self.primary.as_ref().filter(|h| valid_hosts.contains(*h))
    }
}

/// Cross-cutting membership record (`memberships` map, keyed `"<host>|<member>"`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Membership {
    pub host: EntryId,
    pub member: EntryId,
    #[serde(default)]
    pub pos: Option<PosKey>,
    #[serde(default)]
    pub created_at: Option<Timestamp>,
}

impl Membership {
    pub fn key(host: &EntryId, member: &EntryId) -> String {
        format!("{host}|{member}")
    }

    pub fn parse_key(key: &str) -> Option<(EntryId, EntryId)> {
        let (h, m) = key.split_once('|')?;
        Some((EntryId::parse(h).ok()?, EntryId::parse(m).ok()?))
    }
}

/// Sort memberships for a host by position key, ties by member id.
pub fn sort_memberships_by_member(list: &mut [Membership]) {
    list.sort_by(|a, b| cmp_pos((a.pos.as_ref(), &a.member), (b.pos.as_ref(), &b.member)));
}

/// Sort memberships for a member by position key, ties by host id.
pub fn sort_memberships_by_host(list: &mut [Membership]) {
    list.sort_by(|a, b| cmp_pos((a.pos.as_ref(), &a.host), (b.pos.as_ref(), &b.host)));
}

/// One swimlane in a [`TimelineView`] (`lanes` sub-map).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimelineLane {
    pub entry: EntryId,
    #[serde(default)]
    pub pos: Option<PosKey>,
}

/// Sort timeline lanes by position key, ties by entry id.
pub fn sort_timeline_lanes(lanes: &mut [TimelineLane]) {
    lanes.sort_by(|a, b| cmp_pos((a.pos.as_ref(), &a.entry), (b.pos.as_ref(), &b.entry)));
}

/// Placement of an entry on a [`TimelineView`]'s axis (`placements` sub-map).
/// Valid only when `entry` belongs to at least one swimlane in the view
/// (`V3-TIMELINE-PLACEMENT-IN-LANE`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TimelinePlacement {
    pub entry: EntryId,
    pub at: f64,
    #[serde(default)]
    pub span: Option<f64>,
}

/// Sort timeline placements by axis coordinate `at`, ties by entry id.
pub fn sort_timeline_placements(placements: &mut [TimelinePlacement]) {
    placements.sort_by(|a, b| cmp_order((Some(a.at), &a.entry), (Some(b.at), &b.entry)));
}

/// A time pin on a [`TimelineView`]'s axis (`pins` sub-map).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TimelinePin {
    pub id: TimePinId,
    pub at: f64,
    pub label: String,
    #[serde(default)]
    pub color: Option<String>,
    /// Optional entry bound to this pin (`V3-TIMELINE-TARGETS-LIVE`).
    #[serde(default)]
    pub entry: Option<EntryId>,
}

/// Sort timeline pins by axis coordinate `at`, ties by pin id.
pub fn sort_timeline_pins(pins: &mut [TimelinePin]) {
    pins.sort_by(|a, b| cmp_order((Some(a.at), &a.id), (Some(b.at), &b.id)));
}

/// A timeline view (`timeline_views` map in the v3 book document).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TimelineView {
    pub id: TimelineViewId,
    pub name: String,
    #[serde(default)]
    pub pos: Option<PosKey>,
    #[serde(default)]
    pub lanes: Vec<TimelineLane>,
    #[serde(default)]
    pub placements: Vec<TimelinePlacement>,
    #[serde(default)]
    pub pins: Vec<TimelinePin>,
    #[serde(default)]
    pub deleted_at: Option<Timestamp>,
}

impl TimelineView {
    pub fn is_trashed(&self) -> bool {
        self.deleted_at.is_some()
    }
}

/// Sort timeline views by position key, ties by view id.
pub fn sort_timeline_views(views: &mut [TimelineView]) {
    views.sort_by(|a, b| cmp_pos((a.pos.as_ref(), &a.id), (b.pos.as_ref(), &b.id)));
}

/// An excerpt patch attached to an entry's `patches` module (`patches` map in v3).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PatchV3 {
    pub id: PatchId,
    pub entry: EntryId,
    pub module: ModuleId,
    pub source_entry: Option<EntryId>,
    pub source_module: Option<ModuleId>,
    pub source_block: Option<BlockId>,
    pub source_text: Option<String>,
    pub anchor: Option<EncodedAnchor>,
    pub invalidated_at: Option<Timestamp>,
    pub title: Option<String>,
    pub body: String,
    pub pos: Option<PosKey>,
}

/// Sort v3 patches by `(entry, module, pos, id)`.
pub fn sort_patches_v3(patches: &mut [PatchV3]) {
    patches.sort_by(|a, b| {
        (&a.entry, &a.module)
            .cmp(&(&b.entry, &b.module))
            .then_with(|| cmp_pos((a.pos.as_ref(), &a.id), (b.pos.as_ref(), &b.id)))
    });
}

/// A 2D plot grid attached to an entry's `plot_grid` module (`plot_grids` map
/// in v3, keyed `"<entry_id>/<module_id>"`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlotGridV3 {
    pub entry: EntryId,
    pub module: ModuleId,
    pub cell_w: f64,
    pub cell_h: f64,
    pub rows: Vec<PlotLine<PlotRowId>>,
    pub cols: Vec<PlotLine<PlotColId>>,
    pub cells: BTreeMap<(PlotRowId, PlotColId), String>,
}

impl PlotGridV3 {
    pub fn key(entry: &EntryId, module: &ModuleId) -> String {
        format!("{entry}/{module}")
    }

    pub fn parse_key(key: &str) -> Option<(EntryId, EntryIdAndModule)> {
        let (e, m) = key.split_once('/')?;
        let entry = EntryId::parse(e).ok()?;
        let module = ModuleId::parse(m).ok()?;
        Some((entry.clone(), EntryIdAndModule { entry, module }))
    }

    pub fn default_row_id(entry: &EntryId, module: &ModuleId, n: usize) -> PlotRowId {
        PlotRowId::parse(&default_v3_plot_line(entry, module, 'r', n)).expect("valid id")
    }

    pub fn default_col_id(entry: &EntryId, module: &ModuleId, n: usize) -> PlotColId {
        PlotColId::parse(&default_v3_plot_line(entry, module, 'c', n)).expect("valid id")
    }

    pub fn empty(entry: EntryId, module: ModuleId) -> Self {
        Self {
            entry,
            module,
            cell_w: PLOT_DEFAULT_CELL.0,
            cell_h: PLOT_DEFAULT_CELL.1,
            rows: Vec::new(),
            cols: Vec::new(),
            cells: BTreeMap::new(),
        }
    }
}

/// Pair of `(EntryId, ModuleId)`.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct EntryIdAndModule {
    pub entry: EntryId,
    pub module: ModuleId,
}

fn default_v3_plot_line(entry: &EntryId, module: &ModuleId, axis: char, n: usize) -> String {
    let s = format!("{}:{}:{axis}{n}", entry.as_str(), module.as_str());
    if s.len() <= crate::id::MAX_ID_LEN {
        return s;
    }
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(format!("{}/{}", entry.as_str(), module.as_str()).as_bytes());
    let hex: String = hash[..16].iter().map(|b| format!("{b:02x}")).collect();
    format!("{hex}:{axis}{n}")
}

/// A relation type in v3: endpoints are `entry`, `material`, `comment`, or `patch`,
/// and `source_templates` / `target_templates` optionally filter by entry template.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RelationTypeV3 {
    pub id: RelationTypeId,
    pub name: String,
    pub normalized_name: String,
    pub description: String,
    pub orientation: RelationOrientation,
    pub system_key: Option<SystemRelationKey>,
    pub locked: bool,
    pub source_role: String,
    pub target_role: String,
    pub color: Option<String>,
    pub source_kinds: Vec<EntityKind>,
    pub target_kinds: Vec<EntityKind>,
    #[serde(default)]
    pub source_templates: Vec<EntryTemplateId>,
    #[serde(default)]
    pub target_templates: Vec<EntryTemplateId>,
}

/// A comment or TODO in v3: adds `target_module` when targeting a prose module
/// of an entry (`body:<entry_id>/<module_id>` or `body:<entry_id>/about`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CommentV3 {
    pub id: CommentId,
    pub kind: CommentKind,
    pub target: Option<EntityRef>,
    /// When `target` is an entry's prose module, names that module (`module` in Loro).
    pub target_module: Option<ModuleId>,
    pub target_missing: bool,
    pub target_block: Option<BlockId>,
    pub anchor: Option<EncodedAnchor>,
    pub quote: Option<String>,
    pub snapshots: Vec<BlockSnapshot>,
    pub region: Option<MaterialRegion>,
    pub author_kind: CommentAuthorKind,
    pub author: Option<String>,
    pub author_name: Option<String>,
    pub body: String,
    pub status: CommentStatus,
    pub priority: Option<CommentPriority>,
    pub source: CommentSource,
    pub metadata: Option<String>,
    pub agent_conversation: Option<String>,
    pub projection: Option<TodoProjection>,
    pub resolved_at: Option<Timestamp>,
    pub created_at: Option<Timestamp>,
    pub updated_at: Option<Timestamp>,
}

impl CommentV3 {
    pub fn is_todo(&self) -> bool {
        self.kind == CommentKind::Todo
    }

    pub fn is_done(&self) -> bool {
        self.status == CommentStatus::Resolved
    }
}

/// Which project template initialized the book (`meta.project_template`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectTemplateRef {
    pub id: String,
    pub version: i64,
}

/// Book metadata in schema v3 (`meta` container, `v = 3`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BookMetaV3 {
    pub id: BookId,
    pub schema_version: i64,
    pub name: String,
    pub summary: String,
    pub deleted_at: Option<Timestamp>,
    pub created_at: Option<Timestamp>,
    pub word_target_set: Option<i64>,
    pub daily_word_target_set: Option<i64>,
    pub project_template: Option<ProjectTemplateRef>,
}

impl BookMetaV3 {
    pub fn word_target(&self) -> Option<i64> {
        match self.word_target_set.unwrap_or(DEFAULT_WORD_TARGET) {
            0 => None,
            n => Some(n.max(0)),
        }
    }

    pub fn daily_word_target(&self) -> Option<i64> {
        match self
            .daily_word_target_set
            .unwrap_or(DEFAULT_DAILY_WORD_TARGET)
        {
            0 => None,
            n => Some(n.max(0)),
        }
    }
}

// ============================================================================
// Invariant checks & read-tolerance helpers (`kernel-v3.md` "不变量")
// ============================================================================

fn fail<T>(invariant: &'static str, detail: impl Into<String>) -> Result<T, Violation> {
    Err(Violation {
        invariant,
        detail: detail.into(),
    })
}

/// Walk `start`'s raw ancestor chain (excluding `start`), stopping immediately
/// if a cycle or missing parent is encountered (`V3-TREE-NO-CYCLE`).
pub fn ancestors_without_cycle(
    entries: &BTreeMap<EntryId, Entry>,
    start: &EntryId,
) -> Vec<EntryId> {
    let mut visited = BTreeSet::new();
    visited.insert(start.clone());
    let mut out = Vec::new();
    let mut cur = entries.get(start).and_then(|e| e.parent.clone());
    while let Some(pid) = cur {
        if !visited.insert(pid.clone()) {
            break;
        }
        let Some(parent) = entries.get(&pid) else {
            break;
        };
        out.push(pid);
        cur = parent.parent.clone();
    }
    out
}

/// Invariant 2 (`V3-LEAF-NO-CHILDREN`) read tolerance: if a concurrent merge
/// places `entry` under a leaf entry, readers treat `entry` as residing under
/// the nearest non-leaf ancestor above that leaf (or root `None`), without
/// mutating stored data.
pub fn effective_parent_id(
    entry: &Entry,
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> Option<EntryId> {
    for anc_id in ancestors_without_cycle(entries, &entry.id) {
        if let Some(anc) = entries.get(&anc_id)
            && !anc.is_leaf(templates)
        {
            return Some(anc_id);
        }
    }
    None
}

/// Effective ancestor chain of `start` skipping any leaf ancestors (`V3-LEAF-NO-CHILDREN`).
pub fn effective_ancestors(
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
    start: &EntryId,
) -> Vec<EntryId> {
    ancestors_without_cycle(entries, start)
        .into_iter()
        .filter(|id| entries.get(id).is_some_and(|e| !e.is_leaf(templates)))
        .collect()
}

/// Resolve the effective [`LevelSettings`] of `level_id` by inheriting down the
/// ancestor chain (`kernel-v3.md` "层级的设置":
/// `entry.overrides > template.settings > nearest ancestor specifying the field > default`).
pub fn resolve_level_settings(
    level_id: Option<&EntryId>,
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> LevelSettings {
    let Some(lid) = level_id else {
        return LevelSettings::default();
    };
    let Some(level_entry) = entries.get(lid) else {
        return LevelSettings::default();
    };
    let is_lane = level_entry.is_lane_level(templates);
    let mut chain = vec![lid.clone()];
    chain.extend(effective_ancestors(entries, templates, lid));

    let mut acc = LevelSettingsOverride::default();
    for id in &chain {
        let Some(e) = entries.get(id) else {
            continue;
        };
        if let Some(ov) = e.overrides.as_ref() {
            acc = acc.overlay(ov);
        }
        if let Some(tpl) = e.effective_template(templates)
            && tpl.is_level()
        {
            acc = acc.overlay(&tpl.settings);
        }
    }
    acc.finish(is_lane)
}

/// Alias kept for callers that resolve settings for a parent entry.
pub fn resolve_child_settings_for_parent(
    parent_id: Option<&EntryId>,
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> LevelSettings {
    resolve_level_settings(parent_id, entries, templates)
}

/// Resolve where a new child created from `context_level_id` should actually
/// reside in the tree (`LevelSettings::home`: if the level has `accept == true`
/// and specifies a valid live level `home`, the new entry resides under `home`
/// and is added as a member of `context_level_id`).
pub fn resolve_new_entry_residence(
    context_level_id: Option<&EntryId>,
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> Option<EntryId> {
    let lid = context_level_id?;
    let settings = resolve_level_settings(Some(lid), entries, templates);
    if settings.accept
        && let Some(home_id) = settings.home
        && let Some(home_entry) = entries.get(&home_id)
        && !home_entry.is_trashed()
        && !home_entry.is_leaf(templates)
    {
        return Some(home_id);
    }
    Some(lid.clone())
}

/// Check that a template's module manifest obeys `TemplateKind` rules:
/// level templates may only contain `fields` and `kv` modules.
pub fn check_template_modules(
    kind: &TemplateKind,
    modules: &[ModuleSpec],
) -> Result<(), Violation> {
    if *kind == TemplateKind::Level {
        for m in modules {
            if !m.kind.allowed_on_level() {
                return fail(
                    "V3-LEAF-NO-CHILDREN",
                    format!(
                        "level template cannot contain module {} of kind {}",
                        m.id, m.kind
                    ),
                );
            }
        }
    }
    Ok(())
}

/// Invariant 1 (`V3-TREE-NO-CYCLE`): moving `entry` under `new_parent` must not
/// place `entry` under itself or any of its descendants.
pub fn check_entry_move(
    entries: &BTreeMap<EntryId, Entry>,
    entry: &EntryId,
    new_parent: Option<&EntryId>,
) -> Result<(), Violation> {
    if !entries.contains_key(entry) {
        return fail("V3-TREE-NO-CYCLE", format!("entry {entry} does not exist"));
    }
    let Some(target) = new_parent else {
        return Ok(());
    };
    if target == entry {
        return fail("V3-TREE-NO-CYCLE", "an entry cannot be its own parent");
    }
    if !entries.contains_key(target) {
        return fail(
            "V3-TREE-NO-CYCLE",
            format!("parent {target} does not exist"),
        );
    }
    let anc = ancestors_without_cycle(entries, target);
    if anc.contains(entry) {
        return fail(
            "V3-TREE-NO-CYCLE",
            format!("moving {entry} under {target} would create a cycle"),
        );
    }
    Ok(())
}

/// Invariant 2 (`V3-LEAF-NO-CHILDREN`): leaf entries cannot have child entries.
pub fn check_parent_is_level(
    parent_id: Option<&EntryId>,
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> Result<(), Violation> {
    let Some(pid) = parent_id else {
        return Ok(());
    };
    let Some(parent) = entries.get(pid).filter(|e| !e.is_trashed()) else {
        return fail(
            "V3-LEAF-NO-CHILDREN",
            format!("parent entry {pid} does not exist or is trashed"),
        );
    };
    if parent.is_leaf(templates) {
        return fail(
            "V3-LEAF-NO-CHILDREN",
            format!("leaf entry {pid} cannot have child entries"),
        );
    }
    Ok(())
}

/// Invariant 3 (`V3-LEVEL-ALLOWS-TEMPLATE`): when placing or creating an entry
/// under `parent_id`, the parent level's resolved `allow` list (if non-empty)
/// must permit `child_template`.
pub fn check_level_allows_template(
    parent_id: Option<&EntryId>,
    child_template: Option<&EntryTemplateId>,
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> Result<(), Violation> {
    check_parent_is_level(parent_id, entries, templates)?;
    let Some(pid) = parent_id else {
        return Ok(());
    };
    let settings = resolve_level_settings(Some(pid), entries, templates);
    if !settings.allows_template(child_template) {
        return fail(
            "V3-LEVEL-ALLOWS-TEMPLATE",
            format!("level {pid} does not allow template {child_template:?}"),
        );
    }
    Ok(())
}

/// Invariant 4 (`V3-ENTRY-TEMPLATE-EXISTS`): when assigning a template to an
/// entry, the template must exist and not be trashed.
pub fn check_entry_template(
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
    template: Option<&EntryTemplateId>,
) -> Result<(), Violation> {
    let Some(tid) = template else {
        return Ok(());
    };
    match templates.get(tid) {
        Some(t) if !t.is_trashed() => Ok(()),
        _ => fail(
            "V3-ENTRY-TEMPLATE-EXISTS",
            format!("template {tid} does not exist"),
        ),
    }
}

/// Invariant 5 (`V3-TEMPLATE-SWITCH-KEEPS-DATA` & `V3-LEAF-NO-CHILDREN`):
/// switching a level entry to a leaf template is refused while the entry still
/// has live child entries; switching templates never deletes existing module data.
pub fn check_template_switch(
    entry_id: &EntryId,
    new_template: Option<&EntryTemplateId>,
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> Result<(), Violation> {
    check_entry_template(templates, new_template)?;
    let Some(entry) = entries.get(entry_id) else {
        return fail(
            "V3-ENTRY-TEMPLATE-EXISTS",
            format!("entry {entry_id} does not exist"),
        );
    };
    let becoming_leaf = new_template
        .and_then(|t| templates.get(t))
        .is_some_and(EntryTemplate::is_leaf);
    if becoming_leaf {
        let has_children = entries
            .values()
            .any(|c| !c.is_trashed() && c.parent.as_ref() == Some(entry_id));
        if has_children {
            return fail(
                "V3-LEAF-NO-CHILDREN",
                format!(
                    "cannot switch entry {entry_id} to a leaf template while it has child entries"
                ),
            );
        }
    }
    // Also verify parent level allows the new template if parent exists.
    if let Some(pid) = entry.parent.as_ref()
        && entries.get(pid).is_some_and(|p| !p.is_leaf(templates))
    {
        check_level_allows_template(Some(pid), new_template, entries, templates)?;
    }
    Ok(())
}

/// Invariant 6 (`V3-TEMPLATE-DELETE-UNUSED`): a template cannot be deleted
/// while any non-trashed entry still uses it.
pub fn check_template_delete(
    template_id: &EntryTemplateId,
    entries: &BTreeMap<EntryId, Entry>,
) -> Result<(), Violation> {
    let in_use: Vec<&EntryId> = entries
        .values()
        .filter(|e| !e.is_trashed() && e.template.as_ref() == Some(template_id))
        .map(|e| &e.id)
        .collect();
    if !in_use.is_empty() {
        return fail(
            "V3-TEMPLATE-DELETE-UNUSED",
            format!(
                "template {template_id} is still used by {} entries",
                in_use.len()
            ),
        );
    }
    Ok(())
}

/// Invariant 7 (`V3-MEMBERSHIP-RULES`): whether `member_id` can belong to
/// `host_id` is determined solely by the target level `host_id` (`归属由层级决定，叶子不管`):
/// - both `host` and `member` must be live;
/// - `host` must be a level entry (`!host.is_leaf(templates)`) whose resolved
///   `LevelSettings::accept` is `true` (swimlane levels always have `accept == true`);
/// - `host`'s resolved `LevelSettings::allow` (if non-empty) must allow `member`'s template.
pub fn check_membership(
    host_id: &EntryId,
    member_id: &EntryId,
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> Result<(), Violation> {
    if host_id == member_id {
        return fail(
            "V3-MEMBERSHIP-RULES",
            "an entry cannot be a member of itself",
        );
    }
    let Some(host) = entries.get(host_id).filter(|e| !e.is_trashed()) else {
        return fail("V3-MEMBERSHIP-RULES", format!("host {host_id} is not live"));
    };
    let Some(member) = entries.get(member_id).filter(|e| !e.is_trashed()) else {
        return fail(
            "V3-MEMBERSHIP-RULES",
            format!("member {member_id} is not live"),
        );
    };
    if !host.is_level(templates) {
        return fail(
            "V3-MEMBERSHIP-RULES",
            format!("host {host_id} is not a level entry"),
        );
    }
    let host_settings = resolve_level_settings(Some(host_id), entries, templates);
    if !host_settings.accept {
        return fail(
            "V3-MEMBERSHIP-RULES",
            format!("level {host_id} does not accept entries from elsewhere"),
        );
    }
    let member_tpl = member.effective_template(templates).map(|t| &t.id);
    if !host_settings.allows_template(member_tpl) {
        return fail(
            "V3-MEMBERSHIP-RULES",
            format!("level {host_id} does not allow member {member_id}'s template"),
        );
    }
    Ok(())
}

/// Read-side filter for Invariant 7 (`V3-MEMBERSHIP-RULES`): returns only valid
/// memberships where the host is a live level with `accept == true` and allows
/// the member's template.
pub fn filter_valid_memberships(
    memberships: &[Membership],
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> Vec<Membership> {
    memberships
        .iter()
        .filter(|m| check_membership(&m.host, &m.member, entries, templates).is_ok())
        .cloned()
        .collect()
}

/// Invariant 8 (`V3-TIMELINE-LANE-ENABLED`): a timeline swimlane must point to
/// a live level entry whose active template has `lane == true`.
pub fn check_timeline_lane(
    entry_id: &EntryId,
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> Result<(), Violation> {
    let Some(entry) = entries.get(entry_id).filter(|e| !e.is_trashed()) else {
        return fail(
            "V3-TIMELINE-LANE-ENABLED",
            format!("lane entry {entry_id} is not live"),
        );
    };
    if !entry.is_lane_level(templates) {
        return fail(
            "V3-TIMELINE-LANE-ENABLED",
            format!("entry {entry_id} is not a swimlane level"),
        );
    }
    Ok(())
}

/// Read-side filter for Invariant 8 (`V3-TIMELINE-LANE-ENABLED`): ignores lanes
/// whose target entry is missing, trashed, or not a swimlane level.
pub fn effective_timeline_lanes(
    lanes: &[TimelineLane],
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> Vec<TimelineLane> {
    let mut out: Vec<TimelineLane> = lanes
        .iter()
        .filter(|l| check_timeline_lane(&l.entry, entries, templates).is_ok())
        .cloned()
        .collect();
    sort_timeline_lanes(&mut out);
    out
}

/// Whether `entry_id` belongs to at least one effective swimlane of `view`
/// (`V3-TIMELINE-PLACEMENT-IN-LANE`).
pub fn is_entry_in_view_lanes(
    view: &TimelineView,
    entry_id: &EntryId,
    memberships: &[Membership],
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> bool {
    let lane_ids: BTreeSet<EntryId> = effective_timeline_lanes(&view.lanes, entries, templates)
        .into_iter()
        .map(|l| l.entry)
        .collect();
    if lane_ids.is_empty() {
        return false;
    }
    filter_valid_memberships(memberships, entries, templates)
        .iter()
        .any(|m| &m.member == entry_id && lane_ids.contains(&m.host))
}

/// Invariant 9 (`V3-TIMELINE-PLACEMENT-IN-LANE`) & Invariant 11 (`V3-TIMELINE-TARGETS-LIVE`):
/// an entry placed in `view` must be live AND belong to at least one swimlane in `view`.
pub fn check_timeline_placement_in_lane(
    view: &TimelineView,
    entry_id: &EntryId,
    memberships: &[Membership],
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> Result<(), Violation> {
    check_timeline_target_live(entry_id, entries)?;
    if !is_entry_in_view_lanes(view, entry_id, memberships, entries, templates) {
        return fail(
            "V3-TIMELINE-PLACEMENT-IN-LANE",
            format!(
                "entry {entry_id} is not in any swimlane of timeline view {}",
                view.id
            ),
        );
    }
    Ok(())
}

/// Command-layer helper for Invariant 9 (`V3-TIMELINE-PLACEMENT-IN-LANE`):
/// after removing `(lane_id, member_id)` from `memberships`, if `member_id` is
/// no longer in any swimlane of `view`, removes `member_id`'s placement from `view`.
pub fn prune_placement_if_not_in_view_lanes(
    view: &mut TimelineView,
    member_id: &EntryId,
    remaining_memberships: &[Membership],
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> bool {
    if !is_entry_in_view_lanes(view, member_id, remaining_memberships, entries, templates) {
        let before = view.placements.len();
        view.placements.retain(|p| &p.entry != member_id);
        return view.placements.len() != before;
    }
    false
}

/// Whether `entry` is a live auto-link leaf (`kernel-v3.md`:
/// "叶子的住处所在的层级，或者它归属的任何一层，只要开了自动链接，它就自动链接").
pub fn is_autolink_leaf(
    entry: &Entry,
    memberships: &[Membership],
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> bool {
    if entry.is_trashed() || !entry.is_leaf(templates) {
        return false;
    }
    let eff_parent = effective_parent_id(entry, entries, templates);
    if resolve_level_settings(eff_parent.as_ref(), entries, templates).auto_link {
        return true;
    }
    for m in filter_valid_memberships(memberships, entries, templates) {
        if m.member == entry.id
            && resolve_level_settings(Some(&m.host), entries, templates).auto_link
        {
            return true;
        }
    }
    false
}

/// All normalized name keys (`element_name_key`) claimed by `entry` (its title
/// plus any aliases from its active template's `fields` modules).
pub fn entry_autolink_keys(
    entry: &Entry,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> BTreeSet<String> {
    let mut keys = BTreeSet::new();
    let title_key = element_name_key(&entry.title);
    if !title_key.is_empty() {
        keys.insert(title_key);
    }
    for alias in entry.aliases(templates) {
        let k = element_name_key(&alias);
        if !k.is_empty() {
            keys.insert(k);
        }
    }
    keys
}

/// Invariant 10 (`V3-AUTOLINK-NAME-UNIQUE`): among live auto-link leaf entries,
/// titles and aliases (trimmed, case-insensitive) must be unique.
#[allow(clippy::too_many_arguments)]
pub fn check_autolink_name_unique(
    candidate_id: Option<&EntryId>,
    parent_id: Option<&EntryId>,
    host_ids: &[EntryId],
    is_leaf_candidate: bool,
    title: &str,
    aliases: &[String],
    memberships: &[Membership],
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> Result<(), Violation> {
    non_empty_name(title)?;
    if !is_leaf_candidate {
        return Ok(());
    }
    let autolink_enabled = resolve_level_settings(parent_id, entries, templates).auto_link
        || host_ids
            .iter()
            .any(|h| resolve_level_settings(Some(h), entries, templates).auto_link);
    if !autolink_enabled {
        return Ok(());
    }
    let mut wanted = BTreeSet::new();
    let tk = element_name_key(title);
    if !tk.is_empty() {
        wanted.insert(tk);
    }
    for a in aliases {
        let ak = element_name_key(a);
        if !ak.is_empty() {
            wanted.insert(ak);
        }
    }
    for e in entries.values() {
        if Some(&e.id) == candidate_id || !is_autolink_leaf(e, memberships, entries, templates) {
            continue;
        }
        let existing = entry_autolink_keys(e, templates);
        if let Some(dup) = wanted.intersection(&existing).next() {
            return fail(
                "V3-AUTOLINK-NAME-UNIQUE",
                format!("auto-link name {dup:?} is already used by entry {}", e.id),
            );
        }
    }
    Ok(())
}

/// Read-side resolution for Invariant 10 (`V3-AUTOLINK-NAME-UNIQUE`): orders live
/// auto-link leaf entries by `(created_at, id)` and marks later colliding
/// entries with `name_conflict = Some(winner_id)`.
pub fn resolve_autolink_name_conflicts(
    entries: &mut BTreeMap<EntryId, Entry>,
    memberships: &[Membership],
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> BTreeMap<EntryId, EntryId> {
    let snapshot = entries.clone();
    let mut order: Vec<EntryId> = snapshot
        .values()
        .filter(|e| is_autolink_leaf(e, memberships, &snapshot, templates))
        .map(|e| e.id.clone())
        .collect();
    order.sort_by(|a, b| {
        let ea = &snapshot[a];
        let eb = &snapshot[b];
        let ca = ea.created_at.unwrap_or(Timestamp(i64::MAX));
        let cb = eb.created_at.unwrap_or(Timestamp(i64::MAX));
        (ca, a).cmp(&(cb, b))
    });

    let mut owner_by_key: BTreeMap<String, EntryId> = BTreeMap::new();
    let mut conflicts: BTreeMap<EntryId, EntryId> = BTreeMap::new();
    for id in order {
        let e = &snapshot[&id];
        let keys = entry_autolink_keys(e, templates);
        let mut conflict = None;
        for k in &keys {
            if let Some(winner) = owner_by_key.get(k)
                && winner != &id
            {
                conflict = Some(winner.clone());
                break;
            }
        }
        if let Some(winner) = conflict {
            conflicts.insert(id.clone(), winner);
        } else {
            for k in keys {
                owner_by_key.entry(k).or_insert_with(|| id.clone());
            }
        }
    }
    for (id, entry) in entries.iter_mut() {
        entry.name_conflict = conflicts.get(id).cloned();
    }
    conflicts
}

/// Invariant 11 (`V3-TIMELINE-TARGETS-LIVE`): a timeline target or time pin
/// binding must reference a live entry.
pub fn check_timeline_target_live(
    entry_id: &EntryId,
    entries: &BTreeMap<EntryId, Entry>,
) -> Result<(), Violation> {
    match entries.get(entry_id) {
        Some(e) if !e.is_trashed() => Ok(()),
        _ => fail(
            "V3-TIMELINE-TARGETS-LIVE",
            format!("timeline target entry {entry_id} is not live"),
        ),
    }
}

/// Read-side filter for Invariant 9 (`V3-TIMELINE-PLACEMENT-IN-LANE`) &
/// Invariant 11 (`V3-TIMELINE-TARGETS-LIVE`): drops placements whose entry is
/// missing, trashed, or not in any effective swimlane of `view`.
pub fn effective_timeline_placements(
    view: &TimelineView,
    memberships: &[Membership],
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> Vec<TimelinePlacement> {
    let mut out: Vec<TimelinePlacement> = view
        .placements
        .iter()
        .filter(|p| {
            p.at.is_finite()
                && check_timeline_placement_in_lane(view, &p.entry, memberships, entries, templates)
                    .is_ok()
        })
        .map(|p| TimelinePlacement {
            entry: p.entry.clone(),
            at: p.at,
            span: p.span.filter(|s| s.is_finite() && *s >= 0.0),
        })
        .collect();
    sort_timeline_placements(&mut out);
    out
}

/// Read-side filter for Invariant 11 (`V3-TIMELINE-TARGETS-LIVE`): keeps all
/// finite-coordinate pins, clearing `entry` to `None` if the bound entry is
/// missing or trashed.
pub fn effective_timeline_pins(
    pins: &[TimelinePin],
    entries: &BTreeMap<EntryId, Entry>,
) -> Vec<TimelinePin> {
    let mut out: Vec<TimelinePin> = pins
        .iter()
        .filter(|p| p.at.is_finite())
        .map(|p| TimelinePin {
            id: p.id.clone(),
            at: p.at,
            label: p.label.clone(),
            color: p.color.clone(),
            entry: p
                .entry
                .as_ref()
                .filter(|eid| check_timeline_target_live(eid, entries).is_ok())
                .cloned(),
        })
        .collect();
    sort_timeline_pins(&mut out);
    out
}

/// Whether `level_id` directly declares `is_manuscript == true` in its own
/// `overrides` or its own `EntryTemplate.settings` (before inheritance/outermost
/// deduplication).
pub fn directly_declares_manuscript(
    level_id: &EntryId,
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> bool {
    let Some(entry) = entries.get(level_id) else {
        return false;
    };
    if entry.is_trashed() || entry.is_leaf(templates) {
        return false;
    }
    if let Some(ov) = entry.overrides.as_ref()
        && let Some(flag) = ov.is_manuscript
    {
        return flag;
    }
    entry
        .effective_template(templates)
        .and_then(|t| t.settings.is_manuscript)
        .unwrap_or(false)
}

/// Invariant 12 (`V3-MANUSCRIPT-NO-NEST`): manuscript levels (`成书`) cannot
/// nest inside an ancestor or above a descendant that already declares `is_manuscript`.
pub fn check_manuscript_no_nest(
    target_level: &EntryId,
    want_manuscript: bool,
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> Result<(), Violation> {
    if !want_manuscript {
        return Ok(());
    }
    for anc in effective_ancestors(entries, templates, target_level) {
        if directly_declares_manuscript(&anc, entries, templates) {
            return fail(
                "V3-MANUSCRIPT-NO-NEST",
                format!(
                    "cannot enable is_manuscript on {target_level}: ancestor {anc} already enables it"
                ),
            );
        }
    }
    for candidate in entries.values() {
        if candidate.id == *target_level || candidate.is_trashed() {
            continue;
        }
        if directly_declares_manuscript(&candidate.id, entries, templates) {
            let anc = effective_ancestors(entries, templates, &candidate.id);
            if anc.contains(target_level) {
                return fail(
                    "V3-MANUSCRIPT-NO-NEST",
                    format!(
                        "cannot enable is_manuscript on {target_level}: descendant {} already enables it",
                        candidate.id
                    ),
                );
            }
        }
    }
    Ok(())
}

/// Read-side resolution for Invariant 12 (`V3-MANUSCRIPT-NO-NEST`): if a remote
/// merge leaves both an outer level and an inner descendant level with
/// `is_manuscript == true`, only the outermost (`最外层`) level is recognized.
pub fn effective_manuscript_levels(
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> BTreeSet<EntryId> {
    let raw: BTreeSet<EntryId> = entries
        .keys()
        .filter(|id| directly_declares_manuscript(id, entries, templates))
        .cloned()
        .collect();
    raw.iter()
        .filter(|id| {
            let anc = effective_ancestors(entries, templates, id);
            !anc.iter()
                .any(|a| entries.get(a).is_some_and(Entry::is_trashed) || raw.contains(a))
        })
        .cloned()
        .collect()
}

/// Invariant 13 (`V3-CROSS-DOC-ORDER`): when a command writes both prose
/// documents (`body:` / `template:` / `material:`) and the book document
/// (`book:`), every prose document write must precede the book document write.
pub fn check_cross_doc_write_order(steps: &[String]) -> Result<(), Violation> {
    let mut seen_book = false;
    for doc_id in steps {
        if doc_id.starts_with("book:") {
            seen_book = true;
        } else if seen_book
            && (doc_id.starts_with("body:")
                || doc_id.starts_with("template:")
                || doc_id.starts_with("material:"))
        {
            return fail(
                "V3-CROSS-DOC-ORDER",
                format!("prose write {doc_id} must happen before book document write"),
            );
        }
    }
    Ok(())
}

/// Plan the cross-document write order for creating or updating an entry with
/// prose modules: prose documents (`body:<entry_id>/<module_id>`) first,
/// followed by the book document (`book:<book_id>`).
pub fn plan_entry_write_order(
    book_id: &BookId,
    entry_id: &EntryId,
    prose_modules: &[ModuleId],
) -> Vec<String> {
    let mut steps: Vec<String> = prose_modules
        .iter()
        .map(|m| DocId::Body(BodyDocId::new(entry_id.clone(), m.clone())).to_string())
        .collect();
    steps.push(DocId::Book(book_id.clone()).to_string());
    steps
}

/// Expected document IDs for the current entry/template layout. This is not a
/// persisted document inventory: retained modules, material notes and conversations
/// are not enumerated. Use the store's book-scoped document list for deletion.
pub fn book_doc_ids_v3(
    book_id: &BookId,
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> Vec<DocId> {
    let mut out = vec![DocId::Book(book_id.clone())];
    for t in templates.values() {
        for m in t.prose_modules() {
            out.push(DocId::Template(TemplateId::for_entry_module(
                book_id, &t.id, &m.id,
            )));
        }
    }
    let about = level_about_module_id();
    for e in entries.values() {
        match e.effective_template(templates) {
            Some(tpl) if tpl.is_level() => {
                out.push(DocId::Body(BodyDocId::new(e.id.clone(), about.clone())));
            }
            Some(tpl) => {
                for m in tpl.prose_modules() {
                    out.push(DocId::Body(BodyDocId::new(e.id.clone(), m.id.clone())));
                }
            }
            None => {}
        }
    }
    out
}

/// Invariant 14 (`V3-DOCID-LIBRARY-UNIQUE`): document IDs across all books in a
/// library must be globally unique (`loro_doc.doc_id` is the library-wide primary key).
pub fn check_doc_ids_unique_across_books(books: &[(BookId, Vec<DocId>)]) -> Result<(), Violation> {
    let mut seen: BTreeMap<String, BookId> = BTreeMap::new();
    for (book_id, doc_ids) in books {
        for doc_id in doc_ids {
            let key = doc_id.to_string();
            if let Some(prev) = seen.get(&key)
                && prev != book_id
            {
                return fail(
                    "V3-DOCID-LIBRARY-UNIQUE",
                    format!("document {key} is shared by books {prev} and {book_id}"),
                );
            }
            seen.insert(key, book_id.clone());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn eid(s: &str) -> EntryId {
        EntryId::parse(s).unwrap()
    }

    fn tid(s: &str) -> EntryTemplateId {
        EntryTemplateId::parse(s).unwrap()
    }

    fn mid(s: &str) -> ModuleId {
        ModuleId::parse(s).unwrap()
    }

    fn entry_with(id: &str, parent: Option<&str>, title: &str, tpl: Option<&str>) -> Entry {
        Entry {
            id: eid(id),
            parent: parent.map(eid),
            pos: "a0".into(),
            title: title.into(),
            template: tpl.map(tid),
            overrides: None,
            fields: BTreeMap::new(),
            kv: BTreeMap::new(),
            primary: None,
            layout: EntryLayout::default(),
            created_at: Some(Timestamp(1000)),
            updated_at: None,
            deleted_at: None,
            name_conflict: None,
        }
    }

    fn level_template(id: &str, name: &str, lane: bool) -> EntryTemplate {
        EntryTemplate {
            id: tid(id),
            kind: TemplateKind::Level,
            name: name.into(),
            mark: None,
            color: None,
            agent: None,
            modules: Vec::new(),
            settings: LevelSettingsOverride::default(),
            lane,
            verbs: Vec::new(),
            deleted_at: None,
        }
    }

    fn leaf_template(id: &str, name: &str) -> EntryTemplate {
        EntryTemplate {
            id: tid(id),
            kind: TemplateKind::Leaf,
            name: name.into(),
            mark: None,
            color: None,
            agent: None,
            modules: Vec::new(),
            settings: LevelSettingsOverride::default(),
            lane: false,
            verbs: Vec::new(),
            deleted_at: None,
        }
    }

    #[test]
    fn v3_level_settings_inherit_down_ancestors_and_override() {
        let mut tpl_elements = level_template("tpl-elements", "要素", false);
        tpl_elements.settings.display = Some(ChildDisplayMode::Island);
        let tpl_category = level_template("tpl-category", "分类", false);
        let tpl_group = level_template("tpl-group", "分组", false);

        let templates = BTreeMap::from([
            (tid("tpl-elements"), tpl_elements),
            (tid("tpl-category"), tpl_category),
            (tid("tpl-group"), tpl_group),
        ]);

        let root = entry_with("elements", None, "要素", Some("tpl-elements"));
        let mut cat_person =
            entry_with("cat-person", Some("elements"), "人物", Some("tpl-category"));
        cat_person.overrides = Some(LevelSettingsOverride {
            default_template: Some(Some(tid("tpl-person"))),
            auto_link: Some(true),
            ..LevelSettingsOverride::default()
        });
        let grp_heroes = entry_with(
            "grp-heroes",
            Some("cat-person"),
            "主角们",
            Some("tpl-group"),
        );

        let mut entries = BTreeMap::from([
            (eid("elements"), root),
            (eid("cat-person"), cat_person),
            (eid("grp-heroes"), grp_heroes),
        ]);

        // `grp-heroes` inherits `default_template` and `auto_link` from `cat-person`,
        // and `display: Island` from `elements`!
        let inherited = resolve_level_settings(Some(&eid("grp-heroes")), &entries, &templates);
        assert_eq!(inherited.default_template, Some(tid("tpl-person")));
        assert!(inherited.auto_link);
        assert_eq!(inherited.display, ChildDisplayMode::Island);

        // Overriding `auto_link = false` on `grp-heroes` turns it off for that sub-branch.
        entries.get_mut(&eid("grp-heroes")).unwrap().overrides = Some(LevelSettingsOverride {
            auto_link: Some(false),
            ..LevelSettingsOverride::default()
        });
        let overridden = resolve_level_settings(Some(&eid("grp-heroes")), &entries, &templates);
        assert!(!overridden.auto_link);
        assert_eq!(overridden.default_template, Some(tid("tpl-person")));
    }

    #[test]
    fn v3_entry_tree_never_cycles() {
        let mut entries = BTreeMap::new();
        entries.insert(eid("root"), entry_with("root", None, "书稿", None));
        entries.insert(
            eid("vol-1"),
            entry_with("vol-1", Some("root"), "第一卷", None),
        );
        entries.insert(
            eid("ch-1"),
            entry_with("ch-1", Some("vol-1"), "第一章", None),
        );

        assert!(check_entry_move(&entries, &eid("ch-1"), Some(&eid("root"))).is_ok());
        assert!(check_entry_move(&entries, &eid("ch-1"), None).is_ok());

        assert_eq!(
            check_entry_move(&entries, &eid("root"), Some(&eid("root")))
                .unwrap_err()
                .invariant,
            "V3-TREE-NO-CYCLE"
        );
        assert_eq!(
            check_entry_move(&entries, &eid("root"), Some(&eid("ch-1")))
                .unwrap_err()
                .invariant,
            "V3-TREE-NO-CYCLE"
        );

        entries.get_mut(&eid("root")).unwrap().parent = Some(eid("ch-1"));
        let anc = ancestors_without_cycle(&entries, &eid("ch-1"));
        assert_eq!(anc, vec![eid("vol-1"), eid("root")]);
    }

    #[test]
    fn v3_leaves_cannot_have_children_and_merge_lifts_to_ancestor_level() {
        let templates = BTreeMap::from([
            (
                tid("tpl-manuscript"),
                level_template("tpl-manuscript", "书稿", false),
            ),
            (tid("tpl-chapter"), leaf_template("tpl-chapter", "章")),
        ]);

        let entries = BTreeMap::from([
            (
                eid("ms"),
                entry_with("ms", None, "书稿", Some("tpl-manuscript")),
            ),
            (
                eid("ch-1"),
                entry_with("ch-1", Some("ms"), "第一章", Some("tpl-chapter")),
            ),
            // Simulate a remote merge that placed `ch-2` under leaf `ch-1`.
            (
                eid("ch-2"),
                entry_with("ch-2", Some("ch-1"), "第二章", Some("tpl-chapter")),
            ),
        ]);

        // Command layer refuses adding a child under leaf `ch-1`.
        assert_eq!(
            check_parent_is_level(Some(&eid("ch-1")), &entries, &templates)
                .unwrap_err()
                .invariant,
            "V3-LEAF-NO-CHILDREN"
        );
        assert!(check_parent_is_level(Some(&eid("ms")), &entries, &templates).is_ok());

        // Read layer treats `ch-2` as residing under `ms` (the leaf's parent level),
        // without modifying `ch-2.parent`.
        assert_eq!(
            effective_parent_id(&entries[&eid("ch-2")], &entries, &templates),
            Some(eid("ms"))
        );

        // Level templates cannot declare prose/patches/plot_grid modules.
        assert!(
            check_template_modules(
                &TemplateKind::Level,
                &[ModuleSpec::prose(mid("p"), "正文", true, false)]
            )
            .is_err()
        );
        assert!(
            check_template_modules(
                &TemplateKind::Level,
                &[ModuleSpec::fields(mid("f"), "字段", Vec::new())]
            )
            .is_ok()
        );
    }

    #[test]
    fn v3_level_allow_list_filters_new_entries() {
        let mut tpl_ms = level_template("tpl-ms", "书稿", false);
        tpl_ms.settings.allow = Some(vec![tid("tpl-chapter"), tid("tpl-volume")]);

        let templates = BTreeMap::from([
            (tid("tpl-ms"), tpl_ms),
            (tid("tpl-chapter"), leaf_template("tpl-chapter", "章")),
            (tid("tpl-volume"), level_template("tpl-volume", "卷", false)),
            (tid("tpl-person"), leaf_template("tpl-person", "人物")),
        ]);
        let entries = BTreeMap::from([(eid("ms"), entry_with("ms", None, "书稿", Some("tpl-ms")))]);

        assert!(
            check_level_allows_template(
                Some(&eid("ms")),
                Some(&tid("tpl-chapter")),
                &entries,
                &templates
            )
            .is_ok()
        );
        assert_eq!(
            check_level_allows_template(
                Some(&eid("ms")),
                Some(&tid("tpl-person")),
                &entries,
                &templates
            )
            .unwrap_err()
            .invariant,
            "V3-LEVEL-ALLOWS-TEMPLATE"
        );
    }

    #[test]
    fn v3_entry_template_exists_or_degrades_to_blank() {
        let mut templates = BTreeMap::new();
        templates.insert(tid("tpl-person"), leaf_template("tpl-person", "人物"));

        assert!(check_entry_template(&templates, None).is_ok());
        assert!(check_entry_template(&templates, Some(&tid("tpl-person"))).is_ok());
        assert_eq!(
            check_entry_template(&templates, Some(&tid("tpl-missing")))
                .unwrap_err()
                .invariant,
            "V3-ENTRY-TEMPLATE-EXISTS"
        );

        let mut e = entry_with("e1", None, "林凯", Some("tpl-missing"));
        e.fields.insert(
            mid("mod-fields"),
            BTreeMap::from([("role".to_string(), FieldValue::Text("船长".into()))]),
        );
        assert!(e.effective_template(&templates).is_none());
        // Existing data is still shown when the template is missing.
        assert!(
            e.visible_fields(&templates)
                .contains_key(&mid("mod-fields"))
        );
    }

    #[test]
    fn v3_switching_template_preserves_module_data_and_checks_children() {
        let mut tpl_a = leaf_template("tpl-a", "人物");
        tpl_a.modules.push(ModuleSpec::fields(
            mid("mod-bio"),
            "生平字段",
            vec![FieldDef {
                id: "age".into(),
                name: "年龄".into(),
                field_type: FieldType::Number,
                options: Vec::new(),
                target_template: None,
                pos: None,
            }],
        ));
        tpl_a
            .modules
            .push(ModuleSpec::kv(mid("mod-kv"), "设定表", Vec::new()));

        let mut tpl_b = leaf_template("tpl-b", "地点");
        tpl_b
            .modules
            .push(ModuleSpec::fields(mid("mod-geo"), "地理字段", Vec::new()));

        let tpl_level = level_template("tpl-level", "分组", false);

        let templates = BTreeMap::from([
            (tid("tpl-a"), tpl_a),
            (tid("tpl-b"), tpl_b),
            (tid("tpl-level"), tpl_level),
        ]);

        let mut entry = entry_with("e1", None, "北塔", Some("tpl-a"));
        entry.fields.insert(
            mid("mod-bio"),
            BTreeMap::from([("age".to_string(), FieldValue::Number(27.0))]),
        );
        entry.kv.insert(
            mid("mod-kv"),
            vec![KvEntry {
                id: KvEntryId::parse("kv-1").unwrap(),
                key: "阵营".into(),
                value: "守塔人".into(),
                pos: None,
            }],
        );
        assert!(
            entry
                .visible_fields(&templates)
                .contains_key(&mid("mod-bio"))
        );

        entry.switch_template(Some(tid("tpl-b")));
        assert!(
            !entry
                .visible_fields(&templates)
                .contains_key(&mid("mod-bio"))
        );
        assert!(
            entry
                .orphaned_fields(&templates)
                .contains_key(&mid("mod-bio"))
        );
        assert_eq!(entry.fields[&mid("mod-bio")]["age"].as_f64(), Some(27.0));

        entry.switch_template(Some(tid("tpl-a")));
        assert!(
            entry
                .visible_fields(&templates)
                .contains_key(&mid("mod-bio"))
        );

        // Switching a level entry to a leaf template is refused while it has children.
        let entries = BTreeMap::from([
            (
                eid("lvl"),
                entry_with("lvl", None, "第一卷", Some("tpl-level")),
            ),
            (
                eid("child"),
                entry_with("child", Some("lvl"), "第一章", Some("tpl-a")),
            ),
        ]);
        assert_eq!(
            check_template_switch(&eid("lvl"), Some(&tid("tpl-a")), &entries, &templates)
                .unwrap_err()
                .invariant,
            "V3-LEAF-NO-CHILDREN"
        );
    }

    #[test]
    fn v3_template_delete_refuses_when_in_use() {
        let mut entries = BTreeMap::new();
        entries.insert(
            eid("e1"),
            entry_with("e1", None, "第一章", Some("tpl-chapter")),
        );

        assert_eq!(
            check_template_delete(&tid("tpl-chapter"), &entries)
                .unwrap_err()
                .invariant,
            "V3-TEMPLATE-DELETE-UNUSED"
        );
        assert!(check_template_delete(&tid("tpl-unused"), &entries).is_ok());

        entries.get_mut(&eid("e1")).unwrap().deleted_at = Some(Timestamp(2000));
        assert!(check_template_delete(&tid("tpl-chapter"), &entries).is_ok());
    }

    #[test]
    fn v3_membership_governed_by_target_level_accept_and_allow() {
        let mut tpl_storyline = level_template("tpl-storyline", "故事线", true);
        tpl_storyline.settings.allow = Some(vec![tid("tpl-chapter")]);
        tpl_storyline.settings.home = Some(Some(eid("ms")));

        let tpl_folder = level_template("tpl-folder", "普通分组", false);
        let tpl_chapter = leaf_template("tpl-chapter", "章");
        let tpl_person = leaf_template("tpl-person", "人物");

        let templates = BTreeMap::from([
            (tid("tpl-storyline"), tpl_storyline),
            (tid("tpl-folder"), tpl_folder),
            (tid("tpl-chapter"), tpl_chapter),
            (tid("tpl-person"), tpl_person),
        ]);

        let entries = BTreeMap::from([
            (
                eid("ms"),
                entry_with("ms", None, "书稿", Some("tpl-folder")),
            ),
            (
                eid("line-1"),
                entry_with("line-1", None, "主线", Some("tpl-storyline")),
            ),
            (
                eid("folder-1"),
                entry_with("folder-1", None, "普通分组", Some("tpl-folder")),
            ),
            (
                eid("ch-1"),
                entry_with("ch-1", Some("ms"), "第一章", Some("tpl-chapter")),
            ),
            (
                eid("p-1"),
                entry_with("p-1", None, "阿Q", Some("tpl-person")),
            ),
        ]);

        // Swimlane level `line-1` has `accept == true` (automatically via `lane == true`)
        // and allows `tpl-chapter`, regardless of `ms`'s settings (`归属由层级决定，叶子不管`).
        assert!(check_membership(&eid("line-1"), &eid("ch-1"), &entries, &templates).is_ok());

        // Creating a new entry from `line-1` resolves its residence to `ms` (`home`).
        assert_eq!(
            resolve_new_entry_residence(Some(&eid("line-1")), &entries, &templates),
            Some(eid("ms"))
        );

        // `line-1` does not allow `tpl-person` in its `allow` list.
        assert_eq!(
            check_membership(&eid("line-1"), &eid("p-1"), &entries, &templates)
                .unwrap_err()
                .invariant,
            "V3-MEMBERSHIP-RULES"
        );

        // `folder-1` does not have `accept == true`.
        assert_eq!(
            check_membership(&eid("folder-1"), &eid("ch-1"), &entries, &templates)
                .unwrap_err()
                .invariant,
            "V3-MEMBERSHIP-RULES"
        );

        // Leaf `ch-1` cannot host memberships.
        assert_eq!(
            check_membership(&eid("ch-1"), &eid("p-1"), &entries, &templates)
                .unwrap_err()
                .invariant,
            "V3-MEMBERSHIP-RULES"
        );
    }

    #[test]
    fn v3_timeline_lanes_and_placements_require_lane_membership() {
        let templates = BTreeMap::from([
            (
                tid("tpl-storyline"),
                level_template("tpl-storyline", "故事线", true),
            ),
            (tid("tpl-chapter"), leaf_template("tpl-chapter", "章")),
        ]);
        let entries = BTreeMap::from([
            (
                eid("line-1"),
                entry_with("line-1", None, "主线", Some("tpl-storyline")),
            ),
            (
                eid("line-2"),
                entry_with("line-2", None, "支线", Some("tpl-storyline")),
            ),
            (
                eid("ch-1"),
                entry_with("ch-1", None, "第一章", Some("tpl-chapter")),
            ),
            (
                eid("ch-2"),
                entry_with("ch-2", None, "第二章", Some("tpl-chapter")),
            ),
        ]);

        assert!(check_timeline_lane(&eid("line-1"), &entries, &templates).is_ok());
        assert_eq!(
            check_timeline_lane(&eid("ch-1"), &entries, &templates)
                .unwrap_err()
                .invariant,
            "V3-TIMELINE-LANE-ENABLED"
        );

        let mut view = TimelineView {
            id: TimelineViewId::parse("view-1").unwrap(),
            name: "叙事时间线".into(),
            pos: None,
            lanes: vec![
                TimelineLane {
                    entry: eid("line-1"),
                    pos: None,
                },
                TimelineLane {
                    entry: eid("ch-1"), // invalid lane, ignored on read
                    pos: None,
                },
            ],
            placements: vec![
                TimelinePlacement {
                    entry: eid("ch-1"),
                    at: 10.0,
                    span: Some(5.0),
                },
                TimelinePlacement {
                    entry: eid("ch-2"),
                    at: 20.0,
                    span: None,
                },
            ],
            pins: Vec::new(),
            deleted_at: None,
        };

        // Only `ch-1` is a member of `line-1`; `ch-2` is not in any lane of `view`.
        let memberships = vec![Membership {
            host: eid("line-1"),
            member: eid("ch-1"),
            pos: None,
            created_at: None,
        }];

        assert!(
            check_timeline_placement_in_lane(
                &view,
                &eid("ch-1"),
                &memberships,
                &entries,
                &templates
            )
            .is_ok()
        );
        assert_eq!(
            check_timeline_placement_in_lane(
                &view,
                &eid("ch-2"),
                &memberships,
                &entries,
                &templates
            )
            .unwrap_err()
            .invariant,
            "V3-TIMELINE-PLACEMENT-IN-LANE"
        );

        // Read-side `effective_timeline_placements` only returns `ch-1`.
        let eff = effective_timeline_placements(&view, &memberships, &entries, &templates);
        assert_eq!(eff.len(), 1);
        assert_eq!(eff[0].entry, eid("ch-1"));

        // When `ch-1` is removed from its last lane in `view`, its placement is pruned too.
        assert!(prune_placement_if_not_in_view_lanes(
            &mut view,
            &eid("ch-1"),
            &[],
            &entries,
            &templates
        ));
        assert!(view.placements.iter().all(|p| p.entry != eid("ch-1")));
    }

    #[test]
    fn v3_autolink_names_and_aliases_are_unique_across_autolink_leaves() {
        let mut tpl_cat = level_template("tpl-cat", "分类", false);
        tpl_cat.settings.auto_link = Some(true);
        tpl_cat.settings.accept = Some(true);

        let mut tpl_person = leaf_template("tpl-person", "人物");
        tpl_person.modules.push(ModuleSpec::fields(
            mid("mod-fields"),
            "人物字段",
            vec![FieldDef {
                id: "aliases".into(),
                name: "别名".into(),
                field_type: FieldType::Aliases,
                options: Vec::new(),
                target_template: None,
                pos: None,
            }],
        ));

        let templates =
            BTreeMap::from([(tid("tpl-cat"), tpl_cat), (tid("tpl-person"), tpl_person)]);

        let mut e1 = entry_with("e1", Some("cat-1"), "林凯", Some("tpl-person"));
        e1.created_at = Some(Timestamp(1000));
        e1.fields.insert(
            mid("mod-fields"),
            BTreeMap::from([(
                "aliases".to_string(),
                FieldValue::List(vec!["凯哥".into(), "Captain Lin".into()]),
            )]),
        );

        // `e2` resides elsewhere (`None`), but belongs to `cat-1` via `memberships`,
        // so it also participates in auto-linking!
        let mut e2 = entry_with("e2", None, "captain lin", Some("tpl-person"));
        e2.created_at = Some(Timestamp(2000));

        let memberships = vec![Membership {
            host: eid("cat-1"),
            member: eid("e2"),
            pos: None,
            created_at: None,
        }];

        let mut entries = BTreeMap::from([
            (
                eid("cat-1"),
                entry_with("cat-1", None, "人物", Some("tpl-cat")),
            ),
            (eid("e1"), e1),
        ]);

        assert_eq!(
            check_autolink_name_unique(
                None,
                Some(&eid("cat-1")),
                &[],
                true,
                "  CAPTAIN LIN ",
                &[],
                &memberships,
                &entries,
                &templates,
            )
            .unwrap_err()
            .invariant,
            "V3-AUTOLINK-NAME-UNIQUE"
        );

        entries.insert(eid("e2"), e2);
        let conflicts = resolve_autolink_name_conflicts(&mut entries, &memberships, &templates);
        assert_eq!(conflicts.get(&eid("e2")), Some(&eid("e1")));
        assert_eq!(entries[&eid("e1")].name_conflict, None);
        assert_eq!(entries[&eid("e2")].name_conflict, Some(eid("e1")));
    }

    #[test]
    fn v3_timeline_targets_filter_deleted_entries() {
        let mut ch_deleted = entry_with("ch-2", None, "第二章", None);
        ch_deleted.deleted_at = Some(Timestamp(3000));

        let entries = BTreeMap::from([
            (eid("ch-1"), entry_with("ch-1", None, "第一章", None)),
            (eid("ch-2"), ch_deleted),
        ]);

        assert!(check_timeline_target_live(&eid("ch-1"), &entries).is_ok());
        assert_eq!(
            check_timeline_target_live(&eid("ch-2"), &entries)
                .unwrap_err()
                .invariant,
            "V3-TIMELINE-TARGETS-LIVE"
        );

        let pins = vec![TimelinePin {
            id: TimePinId::parse("pin-1").unwrap(),
            at: 15.0,
            label: "伏笔".into(),
            color: None,
            entry: Some(eid("ch-2")),
        }];
        let eff_pins = effective_timeline_pins(&pins, &entries);
        assert_eq!(eff_pins.len(), 1);
        assert_eq!(eff_pins[0].entry, None);
    }

    #[test]
    fn v3_manuscript_levels_never_nest_and_read_outermost() {
        let mut tpl_ms = level_template("tpl-ms", "书稿", false);
        tpl_ms.settings.is_manuscript = Some(true);
        let tpl_vol = level_template("tpl-vol", "卷", false);
        let templates = BTreeMap::from([(tid("tpl-ms"), tpl_ms), (tid("tpl-vol"), tpl_vol)]);

        let mut entries = BTreeMap::new();
        entries.insert(eid("ms"), entry_with("ms", None, "书稿", Some("tpl-ms")));
        entries.insert(
            eid("vol-1"),
            entry_with("vol-1", Some("ms"), "第一卷", Some("tpl-vol")),
        );

        // `ms` already has `is_manuscript == true`, so enabling it on descendant `vol-1` is rejected.
        assert_eq!(
            check_manuscript_no_nest(&eid("vol-1"), true, &entries, &templates)
                .unwrap_err()
                .invariant,
            "V3-MANUSCRIPT-NO-NEST"
        );

        // If a merge leaves both `ms` and `vol-1` with `is_manuscript == true`,
        // `effective_manuscript_levels` recognizes only the outermost one (`ms`).
        entries.get_mut(&eid("vol-1")).unwrap().overrides = Some(LevelSettingsOverride {
            is_manuscript: Some(true),
            ..LevelSettingsOverride::default()
        });
        let eff = effective_manuscript_levels(&entries, &templates);
        assert_eq!(eff, BTreeSet::from([eid("ms")]));
    }

    #[test]
    fn v3_cross_document_writes_put_prose_before_book() {
        let book_id = BookId::parse("b1").unwrap();
        let entry_id = eid("e1");
        let plan = plan_entry_write_order(&book_id, &entry_id, &[mid("m1"), mid("m2")]);
        assert_eq!(plan, vec!["body:e1/m1", "body:e1/m2", "book:b1"]);
        assert!(check_cross_doc_write_order(&plan).is_ok());

        let bad = vec!["book:b1".to_string(), "body:e1/m1".to_string()];
        assert_eq!(
            check_cross_doc_write_order(&bad).unwrap_err().invariant,
            "V3-CROSS-DOC-ORDER"
        );
    }

    #[test]
    fn v3_doc_ids_are_unique_across_books_in_library() {
        let b1 = BookId::parse("b1").unwrap();
        let b2 = BookId::parse("b2").unwrap();
        let tpl_ms = level_template("tpl-manuscript", "书稿", false);
        let mut tpl_ch = leaf_template("tpl-chapter", "章");
        tpl_ch
            .modules
            .push(ModuleSpec::prose(mid("mod-prose"), "正文", true, false));
        let templates = BTreeMap::from([
            (tid("tpl-manuscript"), tpl_ms),
            (tid("tpl-chapter"), tpl_ch),
        ]);

        // Two books share fixed template IDs (`tpl-manuscript`, `tpl-chapter`),
        // but generate distinct entry IDs (`EntryId::new_v7()`): all document IDs
        // (`book:`, `body:`, `template:<book>/<tpl>/<mod>`) are disjoint.
        let mut entries_b1 = BTreeMap::new();
        let ms_b1 = EntryId::new_v7();
        let ch_b1 = EntryId::new_v7();
        entries_b1.insert(
            ms_b1.clone(),
            entry_with(ms_b1.as_str(), None, "书稿", Some("tpl-manuscript")),
        );
        entries_b1.insert(
            ch_b1.clone(),
            entry_with(
                ch_b1.as_str(),
                Some(ms_b1.as_str()),
                "第一章",
                Some("tpl-chapter"),
            ),
        );

        let mut entries_b2 = BTreeMap::new();
        let ms_b2 = EntryId::new_v7();
        let ch_b2 = EntryId::new_v7();
        entries_b2.insert(
            ms_b2.clone(),
            entry_with(ms_b2.as_str(), None, "书稿", Some("tpl-manuscript")),
        );
        entries_b2.insert(
            ch_b2.clone(),
            entry_with(
                ch_b2.as_str(),
                Some(ms_b2.as_str()),
                "第一章",
                Some("tpl-chapter"),
            ),
        );

        let docs_b1 = book_doc_ids_v3(&b1, &entries_b1, &templates);
        let docs_b2 = book_doc_ids_v3(&b2, &entries_b2, &templates);
        assert!(docs_b1.contains(&DocId::parse("template:b1/tpl-chapter/mod-prose").unwrap()));
        assert!(docs_b2.contains(&DocId::parse("template:b2/tpl-chapter/mod-prose").unwrap()));
        assert!(
            check_doc_ids_unique_across_books(&[
                (b1.clone(), docs_b1.clone()),
                (b2.clone(), docs_b2)
            ])
            .is_ok()
        );

        // If two books accidentally reused an entry ID, `check_doc_ids_unique_across_books` catches it.
        let bad_b2 = book_doc_ids_v3(&b2, &entries_b1, &templates);
        assert_eq!(
            check_doc_ids_unique_across_books(&[(b1, docs_b1), (b2, bad_b2)])
                .unwrap_err()
                .invariant,
            "V3-DOCID-LIBRARY-UNIQUE"
        );
    }

    #[test]
    fn v3_sorting_and_key_helpers() {
        let a = eid("host-1");
        let b = eid("member-1");
        let k = Membership::key(&a, &b);
        assert_eq!(k, "host-1|member-1");
        assert_eq!(Membership::parse_key(&k), Some((a.clone(), b)));
        assert_eq!(level_about_module_id().as_str(), "about");

        let m = mid("grid-1");
        let gk = PlotGridV3::key(&a, &m);
        assert_eq!(gk, "host-1/grid-1");
        let (_, pair) = PlotGridV3::parse_key(&gk).unwrap();
        assert_eq!((pair.entry, pair.module), (a.clone(), m.clone()));
        assert_eq!(
            PlotGridV3::default_row_id(&a, &m, 1).as_str(),
            "host-1:grid-1:r1"
        );
        assert_eq!(
            PlotGridV3::default_col_id(&a, &m, 2).as_str(),
            "host-1:grid-1:c2"
        );

        let mut kv = vec![
            KvEntry {
                id: KvEntryId::parse("2").unwrap(),
                key: "k".into(),
                value: "v".into(),
                pos: None,
            },
            KvEntry {
                id: KvEntryId::parse("1").unwrap(),
                key: "k".into(),
                value: "v".into(),
                pos: None,
            },
        ];
        sort_kv(&mut kv);
        assert_eq!(kv[0].id.as_str(), "1");
    }
}
