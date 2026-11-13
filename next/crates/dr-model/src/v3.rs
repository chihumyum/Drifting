//! Universal kernel domain types, without Loro (`docs/rust-rewrite/kernel-v4.md`).
//!
//! A book's structured content lives in a single entry tree (`entries`). There
//! is one kind of entry: its [`EntryTemplate`] composes any modules (`prose`,
//! `fields`, `kv`, `patches`, `plot_grid`, `relations`, `children`), and the
//! entry's own switch ([`Entry::level`], shown as 「层级」) says whether entries
//! can live under it. An entry with the switch on is called a level: its
//! settings for what lives below ([`LevelSettings`], inherited down the tree),
//! its swimlane setting (`lane`, not inherited) and its template's actions
//! (`verbs`) apply. With the switch off they are kept and read as absent.
//!
//! Cross-cutting memberships (`memberships`) are governed by the host level's
//! switch and `accept` setting, and timeline views (`timeline_views`) place
//! entries that belong to at least one swimlane in the view.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::check::Violation;
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
pub use crate::shared::sort_kv;
use crate::shared::{
    BlockSnapshot, DEFAULT_DAILY_WORD_TARGET, DEFAULT_WORD_TARGET, EncodedAnchor, EntityRef,
    KvEntry, MaterialRegion, PLOT_DEFAULT_CELL, PLOT_DEFAULT_LINES, PlotLine, TodoProjection,
    element_name_key,
};
use crate::time::Timestamp;

/// An inline v3 link to an entry (optionally one prose module) or a material.
/// The persisted mark key remains `entity:<target>`. Module and block range
/// are separate value fields; ids never encode a navigation URL or module.
/// `dr-doc` validates v3 link kinds when writing. The legacy
/// [`crate::prose::EntityLink`] and its v2.2 codec remain unchanged.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct EntityLinkV3 {
    pub target: String,
    pub kind: EntityKind,
    #[serde(default)]
    pub module: Option<ModuleId>,
    #[serde(default)]
    pub block: Option<BlockId>,
    #[serde(default)]
    pub end_block: Option<BlockId>,
}

/// Default block width on a timeline axis when a placement omits `span`.
pub const DEFAULT_PLACEMENT_SPAN: f64 = 4.0;

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
    /// Which kind of module a [`ModuleSpec`] declares (`kernel-v4.md` "模块").
    /// Any template may declare any kind, any number of times.
    ModuleKind {
        /// Rich text (`body:<entry_id>/<module_id>`).
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
        /// What lives below the entry (`下面的条目`): its resident children and
        /// accepted members, drawn by the level's `display`. Stores no data
        /// and shows only while the entry's switch is on.
        Children = "children",
    }
);

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
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
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
    /// Optional initial value copied into newly created entries of this template.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_value: Option<FieldValue>,
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
    /// For `prose` modules: whether this prose is part of the book (`成书`):
    /// export, the book's word count and chapter numbering, one switch for
    /// all three. On unless a template says otherwise.
    #[serde(default = "default_true")]
    pub in_book: bool,
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
            in_book: true,
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

    /// A `children` module (`下面的条目`): no data, no configuration.
    pub fn children(id: ModuleId, name: impl Into<String>) -> Self {
        Self {
            id,
            kind: ModuleKind::Children,
            name: name.into(),
            pos: None,
            config: ModuleConfig::default(),
            agent: None,
        }
    }

    /// This prose module with its `in_book` switch set.
    pub fn in_book(mut self, in_book: bool) -> Self {
        self.config.in_book = in_book;
        self
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

/// Effective settings for what lives below a level (`「下面」的设置`, `kernel-v4.md`).
///
/// Resolved by walking from the level entry up its chain of levels:
/// `entry.overrides > template.settings > nearest ancestor level specifying the field > default`.
/// `lane` is the exception: it never inherits.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LevelSettings {
    /// Default template when creating a new entry under this level (`None` = blank).
    #[serde(default)]
    pub default_template: Option<EntryTemplateId>,
    /// Default workspace presentation mode for entries in this level.
    #[serde(default)]
    pub display: ChildDisplayMode,
    /// Whether entries residing in or belonging to this level participate in
    /// auto-linking (when their template is `linkable`).
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
    /// Whether what lives under this level in tree order forms a manuscript (`成书`).
    #[serde(default)]
    pub is_manuscript: bool,
    /// Editor formatting shortcut profile for prose under this level (`格式快捷输入`).
    #[serde(default)]
    pub format_shortcuts: FormatShortcuts,
    /// Whether this level can be a timeline swimlane (`泳道`). A swimlane
    /// always accepts entries from elsewhere. Read from the entry's own
    /// override, else its template; never inherited.
    #[serde(default)]
    pub lane: bool,
}

// A missing key inherits; an explicit JSON null clears the inherited value.
fn nullable_override<'de, T: Deserialize<'de>, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(d).map(Some)
}

/// Sparse level settings stored on an [`EntryTemplate`] (`settings`) or an
/// [`Entry`] (`overrides`). Any `None` field inherits from the template or the
/// nearest ancestor level that specifies it (`kernel-v4.md` "「下面」的设置与继承");
/// `lane` comes from the entry and its template only.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LevelSettingsOverride {
    /// `None` inherits; `Some(None)` clears to no default template; `Some(Some(t))` sets `t`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nullable_override"
    )]
    pub default_template: Option<Option<EntryTemplateId>>,
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
    /// `None` leaves it to the template (an entry's override) or off (a template).
    #[serde(default)]
    pub lane: Option<bool>,
}

impl LevelSettingsOverride {
    pub fn is_empty(&self) -> bool {
        self.default_template.is_none()
            && self.display.is_none()
            && self.auto_link.is_none()
            && self.accept.is_none()
            && self.home.is_none()
            && self.is_manuscript.is_none()
            && self.format_shortcuts.is_none()
            && self.lane.is_none()
    }

    /// Layer `higher` (e.g. an entry's `overrides`) on top of `lower` (e.g. its
    /// template's `settings` or an ancestor's settings).
    pub fn overlay(&self, lower: &LevelSettingsOverride) -> LevelSettingsOverride {
        LevelSettingsOverride {
            default_template: self
                .default_template
                .clone()
                .or_else(|| lower.default_template.clone()),
            display: self.display.clone().or_else(|| lower.display.clone()),
            auto_link: self.auto_link.or(lower.auto_link),
            accept: self.accept.or(lower.accept),
            home: self.home.clone().or_else(|| lower.home.clone()),
            is_manuscript: self.is_manuscript.or(lower.is_manuscript),
            format_shortcuts: self
                .format_shortcuts
                .clone()
                .or_else(|| lower.format_shortcuts.clone()),
            lane: self.lane.or(lower.lane),
        }
    }

    /// Materialize concrete [`LevelSettings`] by filling any remaining `None`
    /// fields with system defaults. `lane` is passed in, since it never
    /// inherits; a swimlane always accepts (`泳道总是收别处的条目`).
    pub fn finish(&self, lane: bool) -> LevelSettings {
        let def = LevelSettings::default();
        LevelSettings {
            default_template: self
                .default_template
                .clone()
                .unwrap_or(def.default_template),
            display: self.display.clone().unwrap_or(def.display),
            auto_link: self.auto_link.unwrap_or(def.auto_link),
            accept: lane || self.accept.unwrap_or(def.accept),
            home: self.home.clone().unwrap_or(def.home),
            is_manuscript: self.is_manuscript.unwrap_or(def.is_manuscript),
            format_shortcuts: self
                .format_shortcuts
                .clone()
                .unwrap_or(def.format_shortcuts),
            lane,
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
        let both = ov.overlay(tpl);
        both.finish(both.lane.unwrap_or(false))
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

/// An action declared by an [`EntryTemplate`] (e.g. "新建章节"); it shows on
/// entries of that template whose switch is on.
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

/// An entry template (`templates` map in the book document).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EntryTemplate {
    pub id: EntryTemplateId,
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
    /// Ordered module manifest (`modules`), any kinds.
    #[serde(default)]
    pub modules: Vec<ModuleSpec>,
    /// Whether a new entry of this template starts with its switch on (`level`).
    /// Only [`Entry::level`] decides afterwards: changing this never touches
    /// existing entries.
    #[serde(default)]
    pub level: bool,
    /// Whether entries of this template take part in auto-linking where the
    /// level they live in or belong to turns it on (`linkable`, on by default).
    #[serde(default = "default_true")]
    pub linkable: bool,
    /// Settings for what lives below entries of this template whose switch is
    /// on (`settings`, including `lane`). Kept whatever `level` says.
    #[serde(default)]
    pub settings: LevelSettingsOverride,
    /// Declared actions (`verbs`), shown on entries whose switch is on.
    #[serde(default)]
    pub verbs: Vec<TemplateVerb>,
    #[serde(default)]
    pub deleted_at: Option<Timestamp>,
}

impl EntryTemplate {
    pub fn is_trashed(&self) -> bool {
        self.deleted_at.is_some()
    }

    pub fn module(&self, id: &ModuleId) -> Option<&ModuleSpec> {
        self.modules.iter().find(|m| &m.id == id)
    }

    pub fn prose_modules(&self) -> impl Iterator<Item = &ModuleSpec> {
        self.modules.iter().filter(|m| m.kind == ModuleKind::Prose)
    }

    /// The prose modules that are part of the book (`in_book`), in order.
    pub fn book_prose_modules(&self) -> impl Iterator<Item = &ModuleSpec> {
        self.prose_modules().filter(|m| m.config.in_book)
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

/// An entry in the book's unified `entries` `LoroTree` (`kernel-v4.md` "条目").
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
    /// The entry's own switch (`层级`): whether entries can live under it.
    /// Set from the template's default when the entry is created; only
    /// `entry.create` and `entry.set_level` write it afterwards.
    #[serde(default)]
    pub level: bool,
    /// Per-entry overrides of the settings for what lives below (kept, but
    /// read as absent, while the switch is off).
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
    /// Set by readers when this entry participates in auto-linking and its
    /// title or alias collides with an earlier auto-linked entry (`V3-AUTOLINK-NAME-UNIQUE`).
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

    /// Whether this entry's switch is on (`层级`): entries can live under it.
    pub fn is_level(&self) -> bool {
        self.level
    }

    /// Whether this entry is a timeline swimlane: its switch is on and `lane`
    /// is set on its own overrides, else on its template's settings. `lane`
    /// never inherits from an ancestor.
    pub fn is_lane(&self, templates: &BTreeMap<EntryTemplateId, EntryTemplate>) -> bool {
        self.level && own_lane(self, templates).is_some_and(|(lane, _)| lane)
    }

    /// Whether this entry's names may auto-link (`linkable`): its template
    /// says so, or it has no active template.
    pub fn is_linkable(&self, templates: &BTreeMap<EntryTemplateId, EntryTemplate>) -> bool {
        self.effective_template(templates)
            .is_none_or(|t| t.linkable)
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
    #[serde(default)]
    pub act_track: Option<bool>,
}

impl TimelineLane {
    pub fn is_act_track(&self) -> bool {
        self.act_track == Some(true)
    }
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
/// of an entry (`body:<entry_id>/<module_id>`).
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
// Invariant checks & read-tolerance helpers (`kernel-v4.md` "不变量")
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

/// Read tolerance for `V3-LEAF-NO-CHILDREN` (an entry whose switch is off
/// holds nothing): if a concurrent merge places `entry` under an entry whose
/// switch is off, readers treat `entry` as residing under the nearest
/// ancestor whose switch is on (or the root `None`), without changing stored
/// data. Turning the switch back on brings it back.
pub fn effective_parent_id(entry: &Entry, entries: &BTreeMap<EntryId, Entry>) -> Option<EntryId> {
    ancestors_without_cycle(entries, &entry.id)
        .into_iter()
        .find(|id| entries.get(id).is_some_and(Entry::is_level))
}

/// Effective ancestor chain of `start`: its ancestors whose switch is on
/// (`V3-LEAF-NO-CHILDREN`), nearest first.
pub fn effective_ancestors(entries: &BTreeMap<EntryId, Entry>, start: &EntryId) -> Vec<EntryId> {
    ancestors_without_cycle(entries, start)
        .into_iter()
        .filter(|id| entries.get(id).is_some_and(Entry::is_level))
        .collect()
}

/// Provenance of one resolved setting, using the same precedence as its value.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LevelSettingSource {
    Default,
    Override {
        entry: EntryId,
    },
    Template {
        entry: EntryId,
        template: EntryTemplateId,
    },
    /// `accept` is on because the level is a swimlane.
    Lane {
        entry: EntryId,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ResolvedLevelSettings {
    pub settings: LevelSettings,
    pub sources: BTreeMap<String, LevelSettingSource>,
}
pub const LEVEL_SETTING_KEYS: [&str; 8] = [
    "default_template",
    "display",
    "auto_link",
    "accept",
    "home",
    "is_manuscript",
    "format_shortcuts",
    "lane",
];

/// `lane` as set on `entry` itself or, failing that, on its template: the
/// value and where it came from. `None` when neither says.
fn own_lane(
    entry: &Entry,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> Option<(bool, LevelSettingSource)> {
    if let Some(lane) = entry.overrides.as_ref().and_then(|o| o.lane) {
        return Some((
            lane,
            LevelSettingSource::Override {
                entry: entry.id.clone(),
            },
        ));
    }
    let tpl = entry.effective_template(templates)?;
    tpl.settings.lane.map(|lane| {
        (
            lane,
            LevelSettingSource::Template {
                entry: entry.id.clone(),
                template: tpl.id.clone(),
            },
        )
    })
}

/// Resolve values and provenance together; callers must not independently
/// reconstruct inheritance from a different read of the book.
pub fn resolve_level_settings_with_sources(
    level_id: Option<&EntryId>,
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> ResolvedLevelSettings {
    let mut sources = LEVEL_SETTING_KEYS
        .into_iter()
        .map(|k| (k.to_owned(), LevelSettingSource::Default))
        .collect();
    let settings = resolve_level_settings_inner(level_id, entries, templates, Some(&mut sources));
    ResolvedLevelSettings { settings, sources }
}

fn inherit_settings(
    acc: &mut LevelSettingsOverride,
    from: &LevelSettingsOverride,
    source: impl Fn() -> LevelSettingSource,
    sources: &mut Option<&mut BTreeMap<String, LevelSettingSource>>,
) {
    if let Some(sources) = sources {
        macro_rules! provenance { ($($field:ident),*) => { $(
            if acc.$field.is_none() && from.$field.is_some() {
                sources.insert(stringify!($field).into(),source());
            }
        )* }; }
        provenance!(
            default_template,
            display,
            auto_link,
            accept,
            home,
            is_manuscript,
            format_shortcuts
        );
    }
    *acc = acc.overlay(from);
}

/// Resolve the effective [`LevelSettings`] of `level_id` by inheriting down
/// its chain of levels (`kernel-v4.md` "「下面」的设置与继承":
/// `entry.overrides > template.settings > nearest ancestor level specifying the field > default`).
/// An entry whose switch is off, the root (`None`) and a missing entry read
/// as the defaults: what is stored on an entry whose switch is off is kept
/// and not used.
pub fn resolve_level_settings(
    level_id: Option<&EntryId>,
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> LevelSettings {
    resolve_level_settings_inner(level_id, entries, templates, None)
}

fn resolve_level_settings_inner(
    level_id: Option<&EntryId>,
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
    mut sources: Option<&mut BTreeMap<String, LevelSettingSource>>,
) -> LevelSettings {
    let Some(lid) = level_id else {
        return LevelSettings::default();
    };
    let Some(level_entry) = entries.get(lid).filter(|e| e.is_level()) else {
        return LevelSettings::default();
    };
    let mut chain = vec![lid.clone()];
    chain.extend(effective_ancestors(entries, lid));

    let mut acc = LevelSettingsOverride::default();
    for id in &chain {
        let Some(e) = entries.get(id) else {
            continue;
        };
        if let Some(ov) = e.overrides.as_ref() {
            inherit_settings(
                &mut acc,
                ov,
                || LevelSettingSource::Override { entry: id.clone() },
                &mut sources,
            );
        }
        if let Some(tpl) = e.effective_template(templates) {
            inherit_settings(
                &mut acc,
                &tpl.settings,
                || LevelSettingSource::Template {
                    entry: id.clone(),
                    template: tpl.id.clone(),
                },
                &mut sources,
            );
        }
    }
    let lane = own_lane(level_entry, templates);
    let is_lane = lane.as_ref().is_some_and(|(lane, _)| *lane);
    if let Some(sources) = sources {
        if let Some((_, source)) = lane {
            sources.insert("lane".into(), source);
        }
        if is_lane {
            sources.insert(
                "accept".into(),
                LevelSettingSource::Lane { entry: lid.clone() },
            );
        }
    }
    acc.finish(is_lane)
}

/// Resolve where a new entry created from `context_level_id` resides in the
/// tree (`LevelSettings::home`: if the level accepts entries from elsewhere
/// and names a live level as `home`, the new entry resides under `home` and
/// is added as a member of `context_level_id`; otherwise under the level).
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
        && home_entry.is_level()
    {
        return Some(home_id);
    }
    Some(lid.clone())
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

/// Invariant 2 (`V3-LEAF-NO-CHILDREN`: an entry whose switch is off holds
/// nothing): a residence given to a new, moved or restored entry is the root
/// or a live entry whose switch is on.
pub fn check_parent_is_level(
    parent_id: Option<&EntryId>,
    entries: &BTreeMap<EntryId, Entry>,
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
    if !parent.is_level() {
        return fail(
            "V3-LEAF-NO-CHILDREN",
            format!("entry {pid} has its switch off and cannot hold entries"),
        );
    }
    Ok(())
}

/// Invariant 4 (`V3-ENTRY-TEMPLATE-EXISTS`): when assigning a template to an
/// entry, the template must exist and not be trashed. Switching an entry's
/// template only needs this: it keeps the entry's data and its switch
/// (`V3-TEMPLATE-SWITCH-KEEPS-DATA`).
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
/// `host_id` is decided by the host alone: both ends live, the host's switch
/// on and its resolved `accept` on (a swimlane always accepts). The member's
/// template does not matter.
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
    if entries.get(member_id).filter(|e| !e.is_trashed()).is_none() {
        return fail(
            "V3-MEMBERSHIP-RULES",
            format!("member {member_id} is not live"),
        );
    }
    if !host.is_level() {
        return fail(
            "V3-MEMBERSHIP-RULES",
            format!("host {host_id} has its switch off"),
        );
    }
    if !resolve_level_settings(Some(host_id), entries, templates).accept {
        return fail(
            "V3-MEMBERSHIP-RULES",
            format!("level {host_id} does not accept entries from elsewhere"),
        );
    }
    Ok(())
}

/// Read-side filter for Invariant 7 (`V3-MEMBERSHIP-RULES`): only the
/// memberships whose two ends are live and whose host has its switch on and
/// accepts. Each host's settings are resolved once.
pub fn filter_valid_memberships(
    memberships: &[Membership],
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> Vec<Membership> {
    let mut hosts: BTreeMap<&EntryId, bool> = BTreeMap::new();
    memberships
        .iter()
        .filter(|m| {
            m.host != m.member
                && entries.get(&m.member).is_some_and(|e| !e.is_trashed())
                && *hosts.entry(&m.host).or_insert_with(|| {
                    entries
                        .get(&m.host)
                        .is_some_and(|h| !h.is_trashed() && h.is_level())
                        && resolve_level_settings(Some(&m.host), entries, templates).accept
                })
        })
        .cloned()
        .collect()
}

/// Invariant 8 (`V3-TIMELINE-LANE-ENABLED`): a timeline swimlane must point to
/// a live entry whose switch is on and whose `lane` resolves true.
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
    if !entry.is_lane(templates) {
        return fail(
            "V3-TIMELINE-LANE-ENABLED",
            format!("entry {entry_id} is not a swimlane"),
        );
    }
    Ok(())
}

/// Read-side filter for Invariant 8 (`V3-TIMELINE-LANE-ENABLED`): ignores lanes
/// whose target entry is missing, trashed, or not a swimlane.
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
    memberships
        .iter()
        .filter(|m| &m.member == entry_id && lane_ids.contains(&m.host))
        .any(|m| check_membership(&m.host, &m.member, entries, templates).is_ok())
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

/// The lane an entry is coloured and marked by (`kernel-v4.md` §9): its
/// primary membership's host when that is a swimlane, else the first
/// swimlane it belongs to, in `memberships` order. `memberships` are the
/// valid ones ([`filter_valid_memberships`]).
pub fn primary_lane<'a>(
    entry: &Entry,
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
    memberships: &'a [Membership],
) -> Option<&'a EntryId> {
    let is_lane = |host: &EntryId| entries.get(host).is_some_and(|h| h.is_lane(templates));
    let mut hosts = memberships
        .iter()
        .filter(|m| m.member == entry.id)
        .map(|m| &m.host);
    hosts
        .clone()
        .find(|h| entry.primary.as_ref() == Some(*h) && is_lane(h))
        .or_else(|| hosts.find(|h| is_lane(h)))
}

/// The value of an entry's own colour field (a `fields` module's
/// `color_field`), when it has one.
pub fn own_color(
    entry: &Entry,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> Option<String> {
    entry
        .effective_template(templates)?
        .modules
        .iter()
        .find_map(|m| {
            let field = m.config.color_field.as_ref()?;
            entry
                .fields
                .get(&m.id)?
                .get(field)?
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        })
}

/// The colour of a lane as its members show it: its own colour field, else
/// its template's colour.
pub fn lane_color(
    lane: &Entry,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> Option<String> {
    own_color(lane, templates).or_else(|| template_color(lane, templates))
}

fn template_color(
    entry: &Entry,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> Option<String> {
    entry
        .effective_template(templates)?
        .color
        .clone()
        .filter(|s| !s.is_empty())
}

/// The colour an entry is shown in (`kernel-v4.md` §9), whatever its
/// switch: its own colour field when it has a value, else its primary
/// lane's colour ([`primary_lane`], [`lane_color`]), else its template's
/// colour. `memberships` are the valid ones.
pub fn entry_color(
    entry: &Entry,
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
    memberships: &[Membership],
) -> Option<String> {
    own_color(entry, templates)
        .or_else(|| {
            primary_lane(entry, entries, templates, memberships)
                .and_then(|lane| entries.get(lane))
                .and_then(|lane| lane_color(lane, templates))
        })
        .or_else(|| template_color(entry, templates))
}

/// Whether `entry` auto-links (`kernel-v4.md` "自动链接"): it is live, its
/// template is `linkable` (an entry without an active template is), and the
/// level it resides in, or any level it validly belongs to, resolves
/// `auto_link` on. Its own switch does not matter. For many entries at once
/// use [`AutolinkNames`], which resolves each level once.
pub fn is_autolinked(
    entry: &Entry,
    memberships: &[Membership],
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> bool {
    if entry.is_trashed() || !entry.is_linkable(templates) {
        return false;
    }
    let parent = effective_parent_id(entry, entries);
    if resolve_level_settings(parent.as_ref(), entries, templates).auto_link {
        return true;
    }
    memberships.iter().any(|m| {
        m.member == entry.id
            && check_membership(&m.host, &m.member, entries, templates).is_ok()
            && resolve_level_settings(Some(&m.host), entries, templates).auto_link
    })
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

/// The auto-link names of one read of a book (`V3-AUTOLINK-NAME-UNIQUE`):
/// which entries auto-link, and every name key with the auto-linked entries
/// that claim it. Built in one pass: each level's settings are resolved once,
/// each membership is read once, then every entry is visited once.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AutolinkNames {
    linked: BTreeSet<EntryId>,
    owners: BTreeMap<String, BTreeSet<EntryId>>,
}

impl AutolinkNames {
    pub fn of(
        entries: &BTreeMap<EntryId, Entry>,
        memberships: &[Membership],
        templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
    ) -> Self {
        let mut levels: BTreeMap<Option<EntryId>, LevelSettings> = BTreeMap::new();
        let mut settings_of = |id: Option<&EntryId>| -> LevelSettings {
            levels
                .entry(id.cloned())
                .or_insert_with(|| resolve_level_settings(id, entries, templates))
                .clone()
        };
        let mut members: BTreeSet<&EntryId> = BTreeSet::new();
        let mut hosts: BTreeMap<&EntryId, bool> = BTreeMap::new();
        for m in memberships {
            if m.host == m.member || !entries.get(&m.member).is_some_and(|e| !e.is_trashed()) {
                continue;
            }
            let links = *hosts.entry(&m.host).or_insert_with(|| {
                let live_level = entries
                    .get(&m.host)
                    .is_some_and(|h| !h.is_trashed() && h.is_level());
                let s = settings_of(Some(&m.host));
                live_level && s.accept && s.auto_link
            });
            if links {
                members.insert(&m.member);
            }
        }
        let mut out = Self::default();
        for e in entries.values() {
            if e.is_trashed() || !e.is_linkable(templates) {
                continue;
            }
            let linked = members.contains(&e.id)
                || settings_of(effective_parent_id(e, entries).as_ref()).auto_link;
            if !linked {
                continue;
            }
            out.linked.insert(e.id.clone());
            for key in entry_autolink_keys(e, templates) {
                out.owners.entry(key).or_default().insert(e.id.clone());
            }
        }
        out
    }

    /// Whether `id` auto-links in this read.
    pub fn is_linked(&self, id: &EntryId) -> bool {
        self.linked.contains(id)
    }

    /// The auto-linked entries.
    pub fn linked(&self) -> &BTreeSet<EntryId> {
        &self.linked
    }

    /// The auto-linked entries claiming the normalized name `key`.
    pub fn owners(&self, key: &str) -> Option<&BTreeSet<EntryId>> {
        self.owners.get(key)
    }

    /// Every name key with the auto-linked entries claiming it.
    pub fn names(&self) -> &BTreeMap<String, BTreeSet<EntryId>> {
        &self.owners
    }
}

/// Read-side resolution for Invariant 10 (`V3-AUTOLINK-NAME-UNIQUE`): orders
/// the auto-linked entries by `(created_at, id)` and marks each later entry
/// whose title or alias is already claimed with `name_conflict = Some(winner)`.
pub fn resolve_autolink_name_conflicts(
    entries: &mut BTreeMap<EntryId, Entry>,
    memberships: &[Membership],
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> BTreeMap<EntryId, EntryId> {
    let snapshot = &*entries;
    let names = AutolinkNames::of(snapshot, memberships, templates);
    let mut order: Vec<&EntryId> = names.linked().iter().collect();
    order.sort_by(|a, b| {
        let ca = snapshot[*a].created_at.unwrap_or(Timestamp(i64::MAX));
        let cb = snapshot[*b].created_at.unwrap_or(Timestamp(i64::MAX));
        (ca, a).cmp(&(cb, b))
    });

    let mut owner_by_key: BTreeMap<String, EntryId> = BTreeMap::new();
    let mut conflicts: BTreeMap<EntryId, EntryId> = BTreeMap::new();
    for id in order {
        let keys = entry_autolink_keys(&snapshot[id], templates);
        let conflict = keys
            .iter()
            .find_map(|k| owner_by_key.get(k).filter(|w| *w != id).cloned());
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
/// `overrides` or its own `EntryTemplate.settings` (before inheritance and
/// outermost deduplication). Only a live entry whose switch is on can.
pub fn directly_declares_manuscript(
    level_id: &EntryId,
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> bool {
    let Some(entry) = entries.get(level_id) else {
        return false;
    };
    if entry.is_trashed() || !entry.is_level() {
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

/// Invariant 12 (`V3-MANUSCRIPT-NO-NEST`): every pair `(outer, inner)` of
/// levels that both declare `is_manuscript`, the outer one an effective
/// ancestor of the inner one. A book with no violation has none.
pub fn manuscript_nest_pairs(
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> BTreeSet<(EntryId, EntryId)> {
    let declared: BTreeSet<&EntryId> = entries
        .keys()
        .filter(|id| directly_declares_manuscript(id, entries, templates))
        .collect();
    let mut pairs = BTreeSet::new();
    for inner in &declared {
        for outer in effective_ancestors(entries, inner) {
            if declared.contains(&outer) {
                pairs.insert((outer, (*inner).clone()));
            }
        }
    }
    pairs
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
            let anc = effective_ancestors(entries, id);
            !anc.iter()
                .any(|a| entries.get(a).is_some_and(Entry::is_trashed) || raw.contains(a))
        })
        .cloned()
        .collect()
}

/// What the structural invariants look at in one read of a book: its
/// entries (structural parts are enough: ids, parents, titles, templates,
/// switches, overrides, alias fields, created and deleted times), its
/// templates and its stored memberships.
#[derive(Clone, Copy, Debug)]
pub struct BookGraph<'a> {
    pub entries: &'a BTreeMap<EntryId, Entry>,
    pub templates: &'a BTreeMap<EntryTemplateId, EntryTemplate>,
    pub memberships: &'a [Membership],
}

/// The command layer's check of a write (`kernel-v4.md` "命令层的预防：只拒绝这次
/// 写入新造成的违规"): `after` is refused only for a violation `before` did not
/// have. A duplicate auto-link name or a nested manuscript a merge left behind
/// is tolerated by readers and blocks no unrelated write; a write that
/// resolves it (a rename, a move, turning a manuscript off) passes.
///
/// - `V3-AUTOLINK-NAME-UNIQUE`: a name claimed by more than one auto-linked
///   entry after the write, at least one of which did not claim it before.
/// - `V3-MANUSCRIPT-NO-NEST`: a nested pair of manuscripts after the write
///   that was not there before.
///
/// Writes that change many entries at once (a template switch, a template's
/// `linkable` or settings, an entry's overrides, a move, a restore, turning a
/// switch off) go through the same comparison.
pub fn check_new_violations(before: BookGraph<'_>, after: BookGraph<'_>) -> Result<(), Violation> {
    let was = AutolinkNames::of(before.entries, before.memberships, before.templates);
    let now = AutolinkNames::of(after.entries, after.memberships, after.templates);
    for (key, owners) in now.names() {
        if owners.len() < 2 {
            continue;
        }
        let had = was.owners(key);
        if let Some(newcomer) = owners.iter().find(|o| !had.is_some_and(|h| h.contains(*o))) {
            let other = owners.iter().find(|o| *o != newcomer).expect("two owners");
            return fail(
                "V3-AUTOLINK-NAME-UNIQUE",
                format!(
                    "auto-link name {key:?} of entry {newcomer} is already used by entry {other}"
                ),
            );
        }
    }
    let was = manuscript_nest_pairs(before.entries, before.templates);
    if let Some((outer, inner)) = manuscript_nest_pairs(after.entries, after.templates)
        .into_iter()
        .find(|pair| !was.contains(pair))
    {
        return fail(
            "V3-MANUSCRIPT-NO-NEST",
            format!("manuscript {inner} would nest inside manuscript {outer}"),
        );
    }
    Ok(())
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
    let mut out = vec![
        DocId::Book(book_id.clone()),
        DocId::Stats(book_id.clone()),
        DocId::Checkpoints(book_id.clone()),
    ];
    for t in templates.values() {
        for m in t.prose_modules() {
            out.push(DocId::Template(TemplateId::for_entry_module(
                book_id, &t.id, &m.id,
            )));
        }
    }
    for e in entries.values() {
        if let Some(tpl) = e.effective_template(templates) {
            for m in tpl.prose_modules() {
                out.push(DocId::Body(BodyDocId::new(e.id.clone(), m.id.clone())));
            }
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

    /// An entry with its switch off.
    fn entry_with(id: &str, parent: Option<&str>, title: &str, tpl: Option<&str>) -> Entry {
        Entry {
            id: eid(id),
            parent: parent.map(eid),
            pos: "a0".into(),
            title: title.into(),
            template: tpl.map(tid),
            level: false,
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

    /// An entry with its switch on.
    fn level_with(id: &str, parent: Option<&str>, title: &str, tpl: Option<&str>) -> Entry {
        Entry {
            level: true,
            ..entry_with(id, parent, title, tpl)
        }
    }

    fn template(id: &str, name: &str) -> EntryTemplate {
        EntryTemplate {
            id: tid(id),
            name: name.into(),
            mark: None,
            color: None,
            agent: None,
            modules: Vec::new(),
            level: false,
            linkable: true,
            settings: LevelSettingsOverride::default(),
            verbs: Vec::new(),
            deleted_at: None,
        }
    }

    /// A template whose new entries start with the switch on; `lane` in its settings.
    fn level_template(id: &str, name: &str, lane: bool) -> EntryTemplate {
        let mut t = template(id, name);
        t.level = true;
        t.linkable = false;
        if lane {
            t.settings.lane = Some(true);
        }
        t
    }

    fn membership(host: &str, member: &str) -> Membership {
        Membership {
            host: eid(host),
            member: eid(member),
            pos: None,
            created_at: None,
        }
    }

    fn graph<'a>(
        entries: &'a BTreeMap<EntryId, Entry>,
        templates: &'a BTreeMap<EntryTemplateId, EntryTemplate>,
        memberships: &'a [Membership],
    ) -> BookGraph<'a> {
        BookGraph {
            entries,
            templates,
            memberships,
        }
    }

    fn aliases_template(id: &str) -> EntryTemplate {
        let mut t = template(id, "人物");
        t.modules.push(ModuleSpec::fields(
            mid("mod-fields"),
            "人物字段",
            vec![FieldDef {
                id: "aliases".into(),
                name: "别名".into(),
                field_type: FieldType::Aliases,
                options: Vec::new(),
                target_template: None,
                default_value: None,
                pos: None,
            }],
        ));
        t
    }

    #[test]
    fn entry_colour_is_its_own_field_else_its_primary_lane_else_its_template() {
        let coloured = |id: &str, colour: Option<&str>| {
            let mut t = template(id, id);
            let mut fields = ModuleSpec::fields(mid("mod-fields"), "字段", Vec::new());
            fields.config.color_field = Some("color".into());
            t.modules.push(fields);
            t.color = colour.map(str::to_owned);
            t
        };
        let mut lane_tpl = coloured("tpl-lane", Some("#lanetpl"));
        lane_tpl.level = true;
        lane_tpl.linkable = false;
        lane_tpl.settings.lane = Some(true);
        lane_tpl.settings.accept = Some(true);
        let templates = BTreeMap::from([
            (tid("tpl-lane"), lane_tpl),
            (
                tid("tpl-chapter"),
                coloured("tpl-chapter", Some("#chapter")),
            ),
        ]);
        let paint = |e: &mut Entry, colour: &str| {
            e.fields.insert(
                mid("mod-fields"),
                BTreeMap::from([("color".to_owned(), FieldValue::Text(colour.into()))]),
            );
        };
        let mut red = level_with("lane-red", None, "红线", Some("tpl-lane"));
        paint(&mut red, "#red");
        let blue = level_with("lane-blue", None, "蓝线", Some("tpl-lane"));
        let mut chapter = entry_with("chapter", None, "一", Some("tpl-chapter"));
        chapter.primary = Some(eid("lane-red"));
        let entries: BTreeMap<_, _> = [red, blue, chapter.clone()]
            .into_iter()
            .map(|e| (e.id.clone(), e))
            .collect();
        let memberships = vec![
            membership("lane-blue", "chapter"),
            membership("lane-red", "chapter"),
        ];
        let colour = |e: &Entry, entries: &BTreeMap<EntryId, Entry>, ms: &[Membership]| {
            entry_color(e, entries, &templates, ms)
        };
        // The primary lane's own colour comes before the entry's template's.
        assert_eq!(
            primary_lane(&chapter, &entries, &templates, &memberships),
            Some(&eid("lane-red"))
        );
        assert_eq!(
            colour(&chapter, &entries, &memberships).as_deref(),
            Some("#red")
        );
        // Without a primary: the first lane it belongs to, whose colour is
        // its template's when it has none of its own.
        let mut loose = chapter.clone();
        loose.primary = None;
        assert_eq!(
            colour(&loose, &entries, &memberships).as_deref(),
            Some("#lanetpl")
        );
        // Its own colour wins whatever its switch.
        let mut own = chapter.clone();
        own.level = true;
        paint(&mut own, "#own");
        assert_eq!(
            colour(&own, &entries, &memberships).as_deref(),
            Some("#own")
        );
        // No lane: its template's colour.
        assert_eq!(colour(&chapter, &entries, &[]).as_deref(), Some("#chapter"));
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

        let root = level_with("elements", None, "要素", Some("tpl-elements"));
        let mut cat_person =
            level_with("cat-person", Some("elements"), "人物", Some("tpl-category"));
        cat_person.overrides = Some(LevelSettingsOverride {
            default_template: Some(Some(tid("tpl-person"))),
            auto_link: Some(true),
            ..LevelSettingsOverride::default()
        });
        let grp_heroes = level_with(
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
        // and `display: Island` from `elements`.
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

        // An ancestor whose switch is off passes nothing down: its stored
        // overrides are kept and not used.
        entries.get_mut(&eid("cat-person")).unwrap().level = false;
        let skipped = resolve_level_settings(Some(&eid("grp-heroes")), &entries, &templates);
        assert_eq!(skipped.default_template, None);
        assert_eq!(skipped.display, ChildDisplayMode::Island);
        assert!(
            entries[&eid("cat-person")]
                .overrides
                .as_ref()
                .is_some_and(|o| o.auto_link == Some(true))
        );
    }

    #[test]
    fn settings_sources_follow_the_value_resolver_including_null_and_lane() {
        let mut parent_tpl = level_template("parent-tpl", "Parent", false);
        parent_tpl.settings.display = Some(ChildDisplayMode::Island);
        parent_tpl.settings.home = Some(Some(eid("home")));
        // `lane` on the parent's template does not inherit.
        parent_tpl.settings.lane = Some(true);
        let mut lane_tpl = level_template("lane-tpl", "Lane", true);
        lane_tpl.settings.auto_link = Some(false);
        lane_tpl.settings.accept = Some(false);
        let plain_tpl = level_template("plain-tpl", "Plain", false);
        let templates = BTreeMap::from([
            (parent_tpl.id.clone(), parent_tpl),
            (lane_tpl.id.clone(), lane_tpl),
            (plain_tpl.id.clone(), plain_tpl),
        ]);
        let mut parent = level_with("parent", None, "Parent", Some("parent-tpl"));
        parent.overrides = Some(LevelSettingsOverride {
            auto_link: Some(true),
            ..Default::default()
        });
        let mut lane = level_with("lane", Some("parent"), "Lane", Some("lane-tpl"));
        lane.overrides = Some(LevelSettingsOverride {
            home: Some(None),
            ..Default::default()
        });
        let plain = level_with("plain", Some("parent"), "Plain", Some("plain-tpl"));
        let entries = BTreeMap::from([
            (parent.id.clone(), parent),
            (lane.id.clone(), lane),
            (plain.id.clone(), plain),
        ]);
        let resolved =
            resolve_level_settings_with_sources(Some(&eid("lane")), &entries, &templates);
        assert_eq!(
            resolved.settings,
            resolve_level_settings(Some(&eid("lane")), &entries, &templates)
        );
        assert_eq!(resolved.sources.len(), 8);
        assert!(resolved.settings.accept);
        assert!(resolved.settings.lane);
        assert!(!resolved.settings.auto_link);
        assert_eq!(resolved.settings.home, None);
        assert_eq!(resolved.settings.display, ChildDisplayMode::Island);
        assert_eq!(
            resolved.sources["home"],
            LevelSettingSource::Override { entry: eid("lane") }
        );
        assert_eq!(
            resolved.sources["accept"],
            LevelSettingSource::Lane { entry: eid("lane") }
        );
        assert_eq!(
            resolved.sources["lane"],
            LevelSettingSource::Template {
                entry: eid("lane"),
                template: tid("lane-tpl")
            }
        );
        assert_eq!(
            resolved.sources["auto_link"],
            LevelSettingSource::Template {
                entry: eid("lane"),
                template: tid("lane-tpl")
            }
        );
        assert_eq!(
            resolved.sources["display"],
            LevelSettingSource::Template {
                entry: eid("parent"),
                template: tid("parent-tpl")
            }
        );
        assert_eq!(
            resolved.sources["default_template"],
            LevelSettingSource::Default
        );
        // The parent's `lane` stays with the parent.
        let plain = resolve_level_settings_with_sources(Some(&eid("plain")), &entries, &templates);
        assert!(!plain.settings.lane);
        assert_eq!(plain.sources["lane"], LevelSettingSource::Default);
        assert!(resolve_level_settings(Some(&eid("parent")), &entries, &templates).lane);
        for missing in [None, Some(eid("missing"))] {
            let resolved =
                resolve_level_settings_with_sources(missing.as_ref(), &entries, &templates);
            assert_eq!(resolved.settings, LevelSettings::default());
            assert!(
                resolved
                    .sources
                    .values()
                    .all(|v| *v == LevelSettingSource::Default)
            );
        }
    }

    #[test]
    fn autolink_conflicts_keep_residence_membership_trash_and_tie_breaking_rules() {
        let mut host_tpl = level_template("host-tpl", "Host", false);
        host_tpl.settings.auto_link = Some(true);
        host_tpl.settings.accept = Some(true);
        let templates = BTreeMap::from([
            (host_tpl.id.clone(), host_tpl),
            (tid("leaf"), template("leaf", "Leaf")),
        ]);
        let mut entries = BTreeMap::new();
        for e in [
            level_with("host", None, "Host", Some("host-tpl")),
            level_with("closed", None, "Closed", None),
            entry_with("a", Some("host"), "Same", Some("leaf")),
            entry_with("b", None, "Same", Some("leaf")),
            entry_with("c", None, "Same", Some("leaf")),
            entry_with("d", Some("host"), "Same", Some("leaf")),
            // Under `a`, whose switch is off: it reads as living under `host`.
            entry_with("e", Some("a"), "Same", Some("leaf")),
            entry_with("f", None, "Same", Some("leaf")),
        ] {
            entries.insert(e.id.clone(), e);
        }
        entries.get_mut(&eid("d")).unwrap().deleted_at = Some(Timestamp(2));
        let memberships = vec![
            membership("host", "b"),
            membership("closed", "c"),
            membership("missing", "f"),
        ];
        // The single-entry rule and the one-pass table agree.
        let eligible: Vec<_> = entries
            .values()
            .filter(|e| is_autolinked(e, &memberships, &entries, &templates))
            .map(|e| e.id.clone())
            .collect();
        assert_eq!(eligible, vec![eid("a"), eid("b"), eid("e")]);
        let names = AutolinkNames::of(&entries, &memberships, &templates);
        assert_eq!(names.linked().iter().cloned().collect::<Vec<_>>(), eligible);
        assert_eq!(
            names.owners("same"),
            Some(&BTreeSet::from([eid("a"), eid("b"), eid("e")]))
        );
        let conflicts = resolve_autolink_name_conflicts(&mut entries, &memberships, &templates);
        assert_eq!(
            conflicts,
            BTreeMap::from([(eid("b"), eid("a")), (eid("e"), eid("a"))])
        );
        entries.get_mut(&eid("a")).unwrap().deleted_at = Some(Timestamp(3));
        let conflicts = resolve_autolink_name_conflicts(&mut entries, &memberships, &templates);
        assert_eq!(conflicts, BTreeMap::from([(eid("e"), eid("b"))]));
        assert_eq!(entries[&eid("b")].name_conflict, None);
    }

    #[test]
    fn v3_entry_tree_never_cycles() {
        let mut entries = BTreeMap::new();
        entries.insert(eid("root"), level_with("root", None, "书稿", None));
        entries.insert(
            eid("vol-1"),
            level_with("vol-1", Some("root"), "第一卷", None),
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
    fn entries_with_the_switch_off_hold_nothing_and_merge_lifts_to_the_nearest_level() {
        // The switch is the entry's own: a chapter template's entry can have
        // it on, a manuscript template's entry can have it off.
        let mut entries = BTreeMap::from([
            (
                eid("ms"),
                level_with("ms", None, "书稿", Some("tpl-manuscript")),
            ),
            (
                eid("vol"),
                entry_with("vol", Some("ms"), "第一卷", Some("tpl-manuscript")),
            ),
            (
                eid("ch-1"),
                entry_with("ch-1", Some("vol"), "第一章", Some("tpl-chapter")),
            ),
            // A remote merge placed `ch-2` under `ch-1`, whose switch is off.
            (
                eid("ch-2"),
                entry_with("ch-2", Some("ch-1"), "第二章", Some("tpl-chapter")),
            ),
        ]);

        // Command layer: only the root or a live entry whose switch is on.
        for off in ["ch-1", "vol"] {
            assert_eq!(
                check_parent_is_level(Some(&eid(off)), &entries)
                    .unwrap_err()
                    .invariant,
                "V3-LEAF-NO-CHILDREN"
            );
        }
        assert!(check_parent_is_level(Some(&eid("ms")), &entries).is_ok());
        assert!(check_parent_is_level(None, &entries).is_ok());

        // Read layer: `ch-2` and `ch-1` read as living under `ms`, the nearest
        // entry whose switch is on, without changing what is stored.
        assert_eq!(
            effective_parent_id(&entries[&eid("ch-2")], &entries),
            Some(eid("ms"))
        );
        assert_eq!(
            effective_parent_id(&entries[&eid("ch-1")], &entries),
            Some(eid("ms"))
        );
        assert_eq!(entries[&eid("ch-2")].parent, Some(eid("ch-1")));
        assert_eq!(effective_ancestors(&entries, &eid("ch-2")), vec![eid("ms")]);

        // Turning a switch on brings what lives under it back.
        entries.get_mut(&eid("ch-1")).unwrap().level = true;
        assert_eq!(
            effective_parent_id(&entries[&eid("ch-2")], &entries),
            Some(eid("ch-1"))
        );
        assert!(check_parent_is_level(Some(&eid("ch-1")), &entries).is_ok());
        // A trashed level holds nothing new either.
        entries.get_mut(&eid("ms")).unwrap().deleted_at = Some(Timestamp(5));
        assert!(check_parent_is_level(Some(&eid("ms")), &entries).is_err());
    }

    #[test]
    fn switching_off_keeps_overrides_memberships_lanes_and_placements_for_when_it_is_back() {
        let line_tpl = level_template("tpl-storyline", "故事线", true);
        let templates = BTreeMap::from([
            (tid("tpl-storyline"), line_tpl),
            (tid("tpl-chapter"), template("tpl-chapter", "章")),
        ]);
        let mut line = level_with("line", None, "主线", Some("tpl-storyline"));
        line.overrides = Some(LevelSettingsOverride {
            auto_link: Some(true),
            ..Default::default()
        });
        let mut chapter = entry_with("ch", None, "第一章", Some("tpl-chapter"));
        chapter.primary = Some(eid("line"));
        let mut entries = BTreeMap::from([(eid("line"), line), (eid("ch"), chapter)]);
        let memberships = vec![membership("line", "ch")];
        let view = TimelineView {
            id: TimelineViewId::parse("view").unwrap(),
            name: "时间线".into(),
            pos: None,
            lanes: vec![TimelineLane {
                entry: eid("line"),
                pos: None,
                act_track: None,
            }],
            placements: vec![TimelinePlacement {
                entry: eid("ch"),
                at: 1.0,
                span: None,
            }],
            pins: Vec::new(),
            deleted_at: None,
        };
        let read = |entries: &BTreeMap<EntryId, Entry>| {
            let valid = filter_valid_memberships(&memberships, entries, &templates);
            let hosts: BTreeSet<EntryId> = valid.iter().map(|m| m.host.clone()).collect();
            (
                resolve_level_settings(Some(&eid("line")), entries, &templates).auto_link,
                valid.len(),
                entries[&eid("ch")].effective_primary(&hosts).cloned(),
                effective_timeline_lanes(&view.lanes, entries, &templates).len(),
                effective_timeline_placements(&view, &memberships, entries, &templates).len(),
                is_autolinked(&entries[&eid("ch")], &memberships, entries, &templates),
            )
        };
        let on = read(&entries);
        assert_eq!(on, (true, 1, Some(eid("line")), 1, 1, true));

        // Off: everything below reads as absent; nothing stored changes.
        let stored = entries.clone();
        entries.get_mut(&eid("line")).unwrap().level = false;
        assert_eq!(read(&entries), (false, 0, None, 0, 0, false));
        assert!(!entries[&eid("line")].is_lane(&templates));
        assert_eq!(
            entries[&eid("line")].overrides,
            stored[&eid("line")].overrides
        );
        assert_eq!(entries[&eid("ch")], stored[&eid("ch")]);

        // On again: all of it is back.
        entries.get_mut(&eid("line")).unwrap().level = true;
        assert_eq!(read(&entries), on);
    }

    #[test]
    fn v3_entry_template_exists_or_degrades_to_blank() {
        let mut templates = BTreeMap::new();
        templates.insert(tid("tpl-person"), template("tpl-person", "人物"));

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
    fn switching_template_keeps_module_data_and_the_switch() {
        let mut tpl_a = template("tpl-a", "人物");
        tpl_a.modules.push(ModuleSpec::fields(
            mid("mod-bio"),
            "生平字段",
            vec![FieldDef {
                id: "age".into(),
                name: "年龄".into(),
                field_type: FieldType::Number,
                options: Vec::new(),
                target_template: None,
                default_value: None,
                pos: None,
            }],
        ));
        tpl_a
            .modules
            .push(ModuleSpec::kv(mid("mod-kv"), "设定表", Vec::new()));

        let mut tpl_b = template("tpl-b", "地点");
        tpl_b
            .modules
            .push(ModuleSpec::fields(mid("mod-geo"), "地理字段", Vec::new()));

        // Any module kind on any template; a template says only the default.
        let mut tpl_level = level_template("tpl-level", "分组", false);
        tpl_level.modules.extend([
            ModuleSpec::prose(mid("mod-description"), "说明", false, false).in_book(false),
            ModuleSpec::patches(mid("mod-patches"), "补丁"),
            ModuleSpec::children(mid("mod-children"), "下面的条目"),
        ]);

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

        // The switch does not follow the template either way: an entry with
        // children keeps them when it takes a template whose default is off,
        // and an entry without the switch does not gain it from a level template.
        let mut lvl = level_with("lvl", None, "第一卷", Some("tpl-level"));
        lvl.switch_template(Some(tid("tpl-a")));
        assert!(lvl.is_level());
        assert!(check_entry_template(&templates, Some(&tid("tpl-a"))).is_ok());
        entry.switch_template(Some(tid("tpl-level")));
        assert!(!entry.is_level());
        let description = templates[&tid("tpl-level")]
            .module(&mid("mod-description"))
            .unwrap();
        assert!(!description.config.in_book);
        assert_eq!(templates[&tid("tpl-level")].book_prose_modules().count(), 0);
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
    fn membership_is_governed_by_the_hosts_switch_and_accept() {
        let mut tpl_storyline = level_template("tpl-storyline", "故事线", true);
        tpl_storyline.settings.home = Some(Some(eid("ms")));

        let tpl_folder = level_template("tpl-folder", "普通分组", false);
        let tpl_chapter = template("tpl-chapter", "章");
        let tpl_person = template("tpl-person", "人物");

        let templates = BTreeMap::from([
            (tid("tpl-storyline"), tpl_storyline),
            (tid("tpl-folder"), tpl_folder),
            (tid("tpl-chapter"), tpl_chapter),
            (tid("tpl-person"), tpl_person),
        ]);

        let mut entries = BTreeMap::from([
            (
                eid("ms"),
                level_with("ms", None, "书稿", Some("tpl-folder")),
            ),
            (
                eid("line-1"),
                level_with("line-1", None, "主线", Some("tpl-storyline")),
            ),
            (
                eid("folder-1"),
                level_with("folder-1", None, "普通分组", Some("tpl-folder")),
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

        // Swimlane `line-1` accepts (always, as a swimlane) whatever the member's template.
        assert!(check_membership(&eid("line-1"), &eid("ch-1"), &entries, &templates).is_ok());
        assert!(check_membership(&eid("line-1"), &eid("p-1"), &entries, &templates).is_ok());

        // Creating a new entry from `line-1` resolves its residence to `ms` (`home`).
        assert_eq!(
            resolve_new_entry_residence(Some(&eid("line-1")), &entries, &templates),
            Some(eid("ms"))
        );

        // `folder-1` does not accept entries from elsewhere.
        assert_eq!(
            check_membership(&eid("folder-1"), &eid("ch-1"), &entries, &templates)
                .unwrap_err()
                .invariant,
            "V3-MEMBERSHIP-RULES"
        );

        // `ch-1` has its switch off and hosts nothing; with the switch on and
        // `accept` set it can.
        assert_eq!(
            check_membership(&eid("ch-1"), &eid("p-1"), &entries, &templates)
                .unwrap_err()
                .invariant,
            "V3-MEMBERSHIP-RULES"
        );
        let ch = entries.get_mut(&eid("ch-1")).unwrap();
        ch.level = true;
        ch.overrides = Some(LevelSettingsOverride {
            accept: Some(true),
            ..Default::default()
        });
        assert!(check_membership(&eid("ch-1"), &eid("p-1"), &entries, &templates).is_ok());

        // `home` must be a level: with `ms`'s switch off, new entries from
        // `line-1` live under `line-1` itself.
        entries.get_mut(&eid("ms")).unwrap().level = false;
        assert_eq!(
            resolve_new_entry_residence(Some(&eid("line-1")), &entries, &templates),
            Some(eid("line-1"))
        );
    }

    #[test]
    fn v3_timeline_lanes_and_placements_require_lane_membership() {
        let templates = BTreeMap::from([
            (
                tid("tpl-storyline"),
                level_template("tpl-storyline", "故事线", true),
            ),
            (tid("tpl-group"), level_template("tpl-group", "分组", false)),
            (tid("tpl-chapter"), template("tpl-chapter", "章")),
        ]);
        let mut entries = BTreeMap::from([
            (
                eid("line-1"),
                level_with("line-1", None, "主线", Some("tpl-storyline")),
            ),
            (
                eid("line-2"),
                level_with("line-2", None, "支线", Some("tpl-storyline")),
            ),
            (
                eid("sub"),
                level_with("sub", Some("line-1"), "分组", Some("tpl-group")),
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
        // `lane` does not inherit: a level under a swimlane is not one.
        assert!(check_timeline_lane(&eid("sub"), &entries, &templates).is_err());
        // An entry can make itself a swimlane, and can opt out of its template's.
        entries.get_mut(&eid("sub")).unwrap().overrides = Some(LevelSettingsOverride {
            lane: Some(true),
            ..Default::default()
        });
        assert!(check_timeline_lane(&eid("sub"), &entries, &templates).is_ok());
        entries.get_mut(&eid("line-2")).unwrap().overrides = Some(LevelSettingsOverride {
            lane: Some(false),
            ..Default::default()
        });
        assert!(check_timeline_lane(&eid("line-2"), &entries, &templates).is_err());

        let mut view = TimelineView {
            id: TimelineViewId::parse("view-1").unwrap(),
            name: "叙事时间线".into(),
            pos: None,
            lanes: vec![
                TimelineLane {
                    entry: eid("line-1"),
                    pos: None,
                    act_track: None,
                },
                TimelineLane {
                    entry: eid("ch-1"), // invalid lane, ignored on read
                    pos: None,
                    act_track: None,
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
        let memberships = vec![membership("line-1", "ch-1")];

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
    fn autolink_names_are_unique_across_autolinked_entries_whatever_their_switch() {
        let mut tpl_cat = level_template("tpl-cat", "分类", false);
        tpl_cat.settings.auto_link = Some(true);
        tpl_cat.settings.accept = Some(true);
        // A grouping template: not linkable even where auto-link is on.
        let tpl_group = level_template("tpl-group", "分组", false);
        let templates = BTreeMap::from([
            (tid("tpl-cat"), tpl_cat),
            (tid("tpl-group"), tpl_group),
            (tid("tpl-person"), aliases_template("tpl-person")),
        ]);

        // `e1` has entries under it (its switch is on): it still auto-links.
        let mut e1 = level_with("e1", Some("cat-1"), "林凯", Some("tpl-person"));
        e1.created_at = Some(Timestamp(1000));
        e1.fields.insert(
            mid("mod-fields"),
            BTreeMap::from([(
                "aliases".to_string(),
                FieldValue::List(vec!["凯哥".into(), "Captain Lin".into()]),
            )]),
        );
        let past = entry_with("past", Some("e1"), "林凯的过去", Some("tpl-person"));
        let group = level_with("grp", Some("cat-1"), "主要人物", Some("tpl-group"));
        let memberships = vec![membership("cat-1", "e2")];
        let before = BTreeMap::from([
            (
                eid("cat-1"),
                level_with("cat-1", None, "人物", Some("tpl-cat")),
            ),
            (eid("e1"), e1),
            (eid("past"), past),
            (eid("grp"), group),
        ]);
        let names = AutolinkNames::of(&before, &memberships, &templates);
        assert!(names.is_linked(&eid("e1")));
        // `past` lives under `e1`, which inherits auto-link from the category.
        assert!(names.is_linked(&eid("past")));
        assert!(!names.is_linked(&eid("grp")));

        // `e2` resides elsewhere but belongs to `cat-1`, so it auto-links,
        // and its title is `e1`'s alias (trimmed, case-insensitive): refused.
        let mut after = before.clone();
        let mut e2 = entry_with("e2", None, "  CAPTAIN LIN ", Some("tpl-person"));
        e2.created_at = Some(Timestamp(2000));
        after.insert(eid("e2"), e2);
        assert_eq!(
            check_new_violations(
                graph(&before, &templates, &memberships),
                graph(&after, &templates, &memberships)
            )
            .unwrap_err()
            .invariant,
            "V3-AUTOLINK-NAME-UNIQUE"
        );
        // A group named like a person claims nothing: it is not linkable.
        let mut renamed = before.clone();
        renamed.get_mut(&eid("grp")).unwrap().title = "林凯".into();
        assert!(
            check_new_violations(
                graph(&before, &templates, &memberships),
                graph(&renamed, &templates, &memberships)
            )
            .is_ok()
        );

        // A merge brought `e2` in anyway: readers mark the later one.
        let mut merged = after.clone();
        let conflicts = resolve_autolink_name_conflicts(&mut merged, &memberships, &templates);
        assert_eq!(conflicts.get(&eid("e2")), Some(&eid("e1")));
        assert_eq!(merged[&eid("e1")].name_conflict, None);
        assert_eq!(merged[&eid("e2")].name_conflict, Some(eid("e1")));
        // That old duplicate blocks no unrelated write...
        let mut unrelated = after.clone();
        unrelated.get_mut(&eid("past")).unwrap().title = "另一段过去".into();
        assert!(
            check_new_violations(
                graph(&after, &templates, &memberships),
                graph(&unrelated, &templates, &memberships)
            )
            .is_ok()
        );
        // ...and renaming one of the pair resolves it.
        let mut resolved = after.clone();
        resolved.get_mut(&eid("e2")).unwrap().title = "林二".into();
        assert!(
            check_new_violations(
                graph(&after, &templates, &memberships),
                graph(&resolved, &templates, &memberships)
            )
            .is_ok()
        );
        // A third entry joining the old duplicate is refused.
        let mut third = after.clone();
        third.insert(
            eid("e3"),
            entry_with("e3", Some("cat-1"), "captain lin", Some("tpl-person")),
        );
        assert!(
            check_new_violations(
                graph(&after, &templates, &memberships),
                graph(&third, &templates, &memberships)
            )
            .is_err()
        );
        // A batch change counts the same way: turning `linkable` on for the
        // group template makes `grp` claim a name already taken.
        let mut linkable = templates.clone();
        linkable.get_mut(&tid("tpl-group")).unwrap().linkable = true;
        assert!(
            check_new_violations(
                graph(&renamed, &templates, &memberships),
                graph(&renamed, &linkable, &memberships)
            )
            .is_err()
        );
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
        entries.insert(eid("ms"), level_with("ms", None, "书稿", Some("tpl-ms")));
        entries.insert(
            eid("vol-1"),
            level_with("vol-1", Some("ms"), "第一卷", Some("tpl-vol")),
        );
        let none = Vec::new();

        // `ms` already declares `is_manuscript`, so declaring it on descendant `vol-1` is refused.
        let mut nested = entries.clone();
        nested.get_mut(&eid("vol-1")).unwrap().overrides = Some(LevelSettingsOverride {
            is_manuscript: Some(true),
            ..LevelSettingsOverride::default()
        });
        assert_eq!(
            check_new_violations(
                graph(&entries, &templates, &none),
                graph(&nested, &templates, &none)
            )
            .unwrap_err()
            .invariant,
            "V3-MANUSCRIPT-NO-NEST"
        );
        assert_eq!(
            manuscript_nest_pairs(&nested, &templates),
            BTreeSet::from([(eid("ms"), eid("vol-1"))])
        );

        // If a merge leaves both with `is_manuscript == true`,
        // `effective_manuscript_levels` recognizes only the outermost one (`ms`),
        // and the old pair blocks no unrelated write.
        let eff = effective_manuscript_levels(&nested, &templates);
        assert_eq!(eff, BTreeSet::from([eid("ms")]));
        let mut renamed = nested.clone();
        renamed.get_mut(&eid("vol-1")).unwrap().title = "卷一".into();
        assert!(
            check_new_violations(
                graph(&nested, &templates, &none),
                graph(&renamed, &templates, &none)
            )
            .is_ok()
        );
        // A level whose switch is off declares nothing.
        let mut off = nested.clone();
        off.get_mut(&eid("vol-1")).unwrap().level = false;
        assert!(manuscript_nest_pairs(&off, &templates).is_empty());
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
        let mut tpl_ms = level_template("tpl-manuscript", "书稿", false);
        tpl_ms
            .modules
            .push(ModuleSpec::prose(mid("mod-description"), "说明", false, false).in_book(false));
        let mut tpl_ch = template("tpl-chapter", "章");
        tpl_ch
            .modules
            .push(ModuleSpec::prose(mid("mod-prose"), "正文", true, false));
        let templates = BTreeMap::from([
            (tid("tpl-manuscript"), tpl_ms),
            (tid("tpl-chapter"), tpl_ch),
        ]);

        // Two books share fixed template IDs (`tpl-manuscript`, `tpl-chapter`),
        // but generate distinct entry IDs (`EntryId::new_v7()`): all document IDs
        // (`book:`, `stats:`, `checkpoints:`, `body:`, `template:<book>/<tpl>/<mod>`)
        // are disjoint.
        let mut entries_b1 = BTreeMap::new();
        let ms_b1 = EntryId::new_v7();
        let ch_b1 = EntryId::new_v7();
        entries_b1.insert(
            ms_b1.clone(),
            level_with(ms_b1.as_str(), None, "书稿", Some("tpl-manuscript")),
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
            level_with(ms_b2.as_str(), None, "书稿", Some("tpl-manuscript")),
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
        // The level's description is an ordinary prose module; no `about`.
        assert!(docs_b1.contains(&DocId::Body(BodyDocId::new(
            ms_b1.clone(),
            mid("mod-description")
        ))));
        assert!(docs_b1.iter().all(|d| !d.to_string().ends_with("/about")));
        assert!(docs_b1.contains(&DocId::Stats(b1.clone())));
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

    #[test]
    fn missing_keys_read_as_off_linkable_and_in_book() {
        let t: EntryTemplate =
            serde_json::from_value(serde_json::json!({"id": "t", "name": "T"})).unwrap();
        assert!(!t.level);
        assert!(t.linkable);
        let e: Entry = serde_json::from_value(serde_json::json!({
            "id": "e", "parent": null, "pos": "a0", "title": "E", "template": null,
            "overrides": null, "fields": {}, "kv": {}, "primary": null,
            "layout": {}, "created_at": null, "updated_at": null, "deleted_at": null
        }))
        .unwrap();
        assert!(!e.is_level());
        let c: ModuleConfig = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(c.in_book);
        assert_eq!(ModuleKind::parse("children"), ModuleKind::Children);
    }
}
