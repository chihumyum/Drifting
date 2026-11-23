//! Universal kernel domain types, without Loro (`docs/rust-rewrite/kernel-v4.md`).
//!
//! A book's structured content lives in a single entry tree (`entries`). There
//! is one kind of entry: its [`EntryTemplate`] composes any modules (`prose`,
//! `fields`, `kv`, `patches`, `plot_grid`, `children`), and the
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
    AssetFolderId, AssetId, BlockId, BodyDocId, BookId, CommentId, DocId, EmbedId, EntryId,
    EntryTemplateId, FieldId, KvEntryId, MediaItemId, MemoryId, ModuleId, PatchId, PlotColId,
    PlotRowId, ProjectTemplateDocId, RelationId, RelationTypeId, TabId, TemplateId, TimePinId,
    TimelineViewId,
};
use crate::kind::{CommentAuthorKind, CommentOrigin, CommentSource, CommentStatus, EntityKind};
use crate::order::cmp_order;
use crate::pos::{PosKey, cmp_pos};
pub use crate::relations::{
    EntryTextLink, LinkedText, PairPlacement, RelationDirection, RelationRow, RelationSide,
    RelationTypeV3, kept_relation_rows, pair_key, plan_pair_removal, plan_relation_pair,
    relation_type_winners, visible_relation_rows,
};
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
    /// Picked with @ ([`crate::prose::LINK_MANUAL`]): it shows whatever the
    /// switches of automatic linking say (`kernel-v5.md` §16).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub manual: bool,
}

/// Default block width on a timeline axis when a placement omits `span`:
/// the view draws such a card this many units wide, and
/// [`timeline_scale_end`] counts it that wide.
pub const DEFAULT_PLACEMENT_SPAN: f64 = 4.0;

/// Air left after the last card when an entry is placed at the end of a
/// timeline scale (`VIEW-LANE-MEMBERS-PLACED`).
pub const PLACEMENT_GAP: f64 = 1.0;

/// Distance between entries without a span placed at the end of a scale in
/// one go: a card's drawn width plus the air after it, so the cards do not
/// overlap. 0.1 spaced new chapters the same way
/// ([`crate::import_v1::order::CHAPTER_ORDER_STRIDE`]).
pub const PLACEMENT_STEP: f64 = DEFAULT_PLACEMENT_SPAN + PLACEMENT_GAP;

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
        /// A 2D plot grid keyed by `<entry_id>/<module_id>` in `plot_grids`.
        PlotGrid = "plot_grid",
        /// What lives below the entry (`下面的条目`): its resident children,
        /// drawn by the level's `display`. Stores no data and shows while the
        /// entry's `level` switch is on.
        Children = "children",
        /// What belongs here via memberships (`挂在这里的条目`, `kernel-v5.md` §16),
        /// drawn by `display`. Stores no data and shows while `accept` is on.
        Members = "members",
        /// Files with captions and order (`media:<module_id>` on the entry, `kernel-v5.md` §6).
        Media = "media",
    }
);

v3_open_enum!(
    /// How a `media` module lays out its files (`kernel-v5.md` §6 媒体模块的摆法):
    /// one large picture with a row of small ones to switch, a grid, or a
    /// list. The template's module gives the default; an entry may choose
    /// its own for its module (`arrangement:<module>`, never `layout`).
    #[derive(Default)]
    MediaArrangement {
        #[default]
        Featured = "featured",
        Grid = "grid",
        List = "list",
    }
);

v3_open_enum!(
    /// The size of an image embedded in prose (`kernel-v5.md` §6): small,
    /// medium, or the width of the text. A PDF embed is a card and has none.
    #[derive(Default)]
    EmbedSize {
        Small = "small",
        #[default]
        Medium = "medium",
        Full = "full",
    }
);

v3_open_enum!(
    /// Where an image embedded in prose sits (`kernel-v5.md` §6).
    #[derive(Default)]
    EmbedAlign {
        Left = "left",
        #[default]
        Center = "center",
        Right = "right",
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
    /// For `media` modules: how entries of the template lay the files out
    /// unless an entry chooses its own (`None`: the default, `featured`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arrangement: Option<MediaArrangement>,
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
            arrangement: None,
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

    /// A `members` module (`挂在这里的条目`, `kernel-v5.md` §16): no data, no configuration.
    pub fn members(id: ModuleId, name: impl Into<String>) -> Self {
        Self {
            id,
            kind: ModuleKind::Members,
            name: name.into(),
            pos: None,
            config: ModuleConfig::default(),
            agent: None,
        }
    }

    /// A `media` module (`文件`): ordered files with captions (`media:<module_id>`).
    pub fn media(id: ModuleId, name: impl Into<String>) -> Self {
        Self {
            id,
            kind: ModuleKind::Media,
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

/// Effective settings for what lives under or belongs to an entry (`「下面」的设置`,
/// `kernel-v5.md` §16).
///
/// `accept` and `home` come strictly from the entry's own `overrides` and its
/// active `template` (never inherited down the tree, independent of `level`).
/// The remaining settings (`default_template`, `display`, `auto_link`,
/// `format_shortcuts`) inherit along `effective_ancestors`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LevelSettings {
    /// Default template when creating a new entry under or on this entry (`None` = blank).
    #[serde(default)]
    pub default_template: Option<EntryTemplateId>,
    /// Default workspace presentation mode for entries below or belonging here.
    #[serde(default)]
    pub display: ChildDisplayMode,
    /// The level's 「自动链接」 (`kernel-v5.md` §16 「自动链接」): whether an
    /// entry newly created to live here starts with its own switch
    /// ([`Entry::auto_link`]) on, when its template is `linkable`. It decides
    /// nothing about existing entries: turning it on or off through
    /// `entry.set_below_auto_link` sets the switch of every `linkable` entry
    /// living below, once.
    #[serde(default)]
    pub auto_link: bool,
    /// Whether entries residing elsewhere may belong to this entry via `memberships` (`收别处的条目`).
    /// Read from the entry's own overrides, else its template; never inherited.
    #[serde(default)]
    pub accept: bool,
    /// For entries with `accept == true`: which level entry newly attached entries reside under (`新条目住在`).
    /// Read from the entry's own overrides, else its template; never inherited.
    #[serde(default)]
    pub home: Option<EntryId>,
    /// Editor formatting shortcut profile for prose under this entry (`格式快捷输入`).
    #[serde(default)]
    pub format_shortcuts: FormatShortcuts,
}

// A missing key inherits; an explicit JSON null clears the inherited value.
fn nullable_override<'de, T: Deserialize<'de>, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(d).map(Some)
}

/// Sparse settings stored on an [`EntryTemplate`] (`settings`) or an [`Entry`]
/// (`overrides`). `accept` and `home` come from the entry and its template only;
/// the other fields inherit from the nearest ancestor level when `None`
/// (`kernel-v5.md` §16).
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
    /// `None` leaves `accept` to the template (on an entry) or off (on a template).
    #[serde(default)]
    pub accept: Option<bool>,
    /// `None` leaves `home` to the template (on an entry) or unset (on a template);
    /// `Some(None)` clears a template's `home`; `Some(Some(id))` sets `home`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nullable_override"
    )]
    pub home: Option<Option<EntryId>>,
    #[serde(default)]
    pub format_shortcuts: Option<FormatShortcuts>,
}

impl LevelSettingsOverride {
    pub fn is_empty(&self) -> bool {
        self.default_template.is_none()
            && self.display.is_none()
            && self.auto_link.is_none()
            && self.accept.is_none()
            && self.home.is_none()
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
            display: self.display.clone().or_else(|| lower.display.clone()),
            auto_link: self.auto_link.or(lower.auto_link),
            accept: self.accept.or(lower.accept),
            home: self.home.clone().or_else(|| lower.home.clone()),
            format_shortcuts: self
                .format_shortcuts
                .clone()
                .or_else(|| lower.format_shortcuts.clone()),
        }
    }

    /// Materialize concrete [`LevelSettings`] using `accept` and `home` resolved
    /// from the entry itself / its template (`kernel-v5.md` §16) and inherited
    /// values for the remaining fields.
    pub fn finish(&self, accept: bool, home: Option<EntryId>) -> LevelSettings {
        let def = LevelSettings::default();
        LevelSettings {
            default_template: self
                .default_template
                .clone()
                .unwrap_or(def.default_template),
            display: self.display.clone().unwrap_or(def.display),
            auto_link: self.auto_link.unwrap_or(def.auto_link),
            accept,
            home,
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
        let both = ov.overlay(tpl);
        let accept = both.accept.unwrap_or(false);
        let home = both.home.clone().unwrap_or(None);
        both.finish(accept, home)
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
    /// Whether entries of this template follow the level they live in for
    /// 「自动链接」 (`linkable`, on by default; `kernel-v5.md` §16): a new
    /// entry starts with the level's default, and turning the level's switch
    /// on or off carries it along. A container (a group, a category) is not
    /// `linkable` and keeps its own switch. It never vetoes a link: an entry
    /// whose own switch the author turned on links whatever its template.
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

/// Whether `mark` is an allowed entry or template badge (`kernel-v5.md` §8 & §15.6):
/// either a sand-brush mark slug (`book`, `file-text`, `git-branch`, …) or a
/// single Unicode extended grapheme cluster (including emoji).
pub fn is_valid_mark(mark: &str) -> bool {
    use unicode_segmentation::UnicodeSegmentation;
    if mark.is_empty() || mark.len() > 64 {
        return false;
    }
    if mark.chars().any(char::is_control) {
        return false;
    }
    if !mark.chars().any(|c| {
        !c.is_whitespace() && !c.is_control() && !matches!(c, '\u{200B}'..='\u{200F}' | '\u{FEFF}')
    }) {
        return false;
    }
    let is_slug = !mark.starts_with('-')
        && !mark.ends_with('-')
        && !mark.contains("--")
        && mark
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    is_slug || mark.graphemes(true).count() == 1
}

/// One file item inside an entry's `media` module (`media:<module_id>` on the entry,
/// `kernel-v5.md` §6 & §10). Sorted by `pos`, ties by `id`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MediaItem {
    pub id: MediaItemId,
    pub asset: AssetId,
    #[serde(default)]
    pub caption: String,
    #[serde(default)]
    pub pos: Option<PosKey>,
}

/// Sort a media module's items by position key, ties by item id.
pub fn sort_media(items: &mut [MediaItem]) {
    items.sort_by(|a, b| cmp_pos((a.pos.as_ref(), &a.id), (b.pos.as_ref(), &b.id)));
}

/// Invariant `MEDIA-ASSET-ONCE` (`kernel-v5.md` §11): a file sits in one
/// media module at most once. `item` (new, or an update of its own id) may
/// not hold a file another item of `items` already holds.
pub fn check_media_asset_once(items: &[MediaItem], item: &MediaItem) -> Result<(), Violation> {
    if items
        .iter()
        .any(|other| other.id != item.id && other.asset == item.asset)
    {
        return fail(
            "MEDIA-ASSET-ONCE",
            format!("file {} is already in this media module", item.asset),
        );
    }
    Ok(())
}

/// Invariant `ASSET-FOLDER-TREE` (`kernel-v5.md` §11): asset folders form a
/// tree. Moving `folder` under `parent` (`None`: the top) may not put it
/// under itself. `parents` maps each folder to its parent.
pub fn check_asset_folder_parent(
    parents: &BTreeMap<AssetFolderId, Option<AssetFolderId>>,
    folder: &AssetFolderId,
    parent: Option<&AssetFolderId>,
) -> Result<(), Violation> {
    let mut at = parent.cloned();
    let mut steps = 0;
    while let Some(p) = at {
        if &p == folder {
            return fail(
                "ASSET-FOLDER-TREE",
                format!("asset folder {folder} cannot live under itself"),
            );
        }
        steps += 1;
        if steps > parents.len() {
            break;
        }
        at = parents.get(&p).cloned().flatten();
    }
    Ok(())
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
    /// Optional per-entry badge/icon mark (`记号`); falls back to the active
    /// template's `mark` when unset (`kernel-v5.md` §8).
    #[serde(default)]
    pub mark: Option<String>,
    /// The template shaping this entry (`None` = untemplated entry).
    pub template: Option<EntryTemplateId>,
    /// The entry's own switch (`层级`): whether entries can live under it.
    /// Set from the template's default when the entry is created; only
    /// `entry.create` and `entry.set_level` write it afterwards.
    #[serde(default)]
    pub level: bool,
    /// The entry's own 「自动链接」 (`kernel-v5.md` §16): whether its title
    /// and aliases link by themselves in the book's text, and whether the
    /// automatic links already pointing at it show as links. Off unless
    /// someone turned it on: `entry.create` takes the default of the level
    /// it starts living in ([`new_entry_auto_link`]); `entry.set_auto_link`
    /// and a level's `entry.set_below_auto_link` write it afterwards. Moving
    /// the entry or switching its template leaves it alone.
    #[serde(default)]
    pub auto_link: bool,
    /// Per-entry overrides of the settings for what lives below (kept, but
    /// read as absent, while the switch is off).
    pub overrides: Option<LevelSettingsOverride>,
    /// Values of `fields` modules: `module_id -> (field_id -> value)`.
    pub fields: BTreeMap<ModuleId, BTreeMap<String, FieldValue>>,
    /// Rows of `kv` modules (`kv:<module_id>`): `module_id -> sorted KvEntry list`.
    pub kv: BTreeMap<ModuleId, Vec<KvEntry>>,
    /// Items of `media` modules (`media:<module_id>`): `module_id -> sorted MediaItem list`.
    #[serde(default)]
    pub media: BTreeMap<ModuleId, Vec<MediaItem>>,
    /// This entry's own arrangement of a media module (`arrangement:<module_id>`);
    /// a module without one uses its template's ([`Entry::media_arrangement`]).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub arrangements: BTreeMap<ModuleId, MediaArrangement>,
    /// Stored primary membership host; use [`Entry::effective_primary`] to read.
    pub primary: Option<EntryId>,
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

    /// The badge/icon mark displayed for this entry: the entry's own `mark`,
    /// or its active template's `mark` when unset (`kernel-v5.md` §8).
    pub fn effective_mark<'a>(
        &'a self,
        templates: &'a BTreeMap<EntryTemplateId, EntryTemplate>,
    ) -> Option<&'a str> {
        self.mark
            .as_deref()
            .or_else(|| self.effective_template(templates)?.mark.as_deref())
    }

    /// Whether this entry's switch is on (`层级`): entries can live under it.
    pub fn is_level(&self) -> bool {
        self.level
    }

    /// Whether entries residing elsewhere may belong to this entry (`收别处的条目`,
    /// `kernel-v5.md` §16): read strictly from the entry's own `overrides` and
    /// its active `template` (never inherited, independent of `level`).
    pub fn accepts_members(&self, templates: &BTreeMap<EntryTemplateId, EntryTemplate>) -> bool {
        own_accept(self, templates).is_some_and(|(accept, _)| accept)
    }

    /// Where newly attached entries reside when `accept` is on (`新条目住在`,
    /// `kernel-v5.md` §16): read strictly from the entry's own `overrides` and
    /// its active `template` (never inherited).
    pub fn own_home(
        &self,
        templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
    ) -> Option<EntryId> {
        own_home(self, templates).and_then(|(home, _)| home)
    }

    /// Whether this entry holds entries below (`level`) or accepts memberships
    /// (`accept`), making it eligible for `below` settings, swimlanes, book
    /// roots, and tab mounts (`kernel-v5.md` §16).
    pub fn has_below(&self, templates: &BTreeMap<EntryTemplateId, EntryTemplate>) -> bool {
        self.level || self.accepts_members(templates)
    }

    /// Whether this entry follows its level for 「自动链接」 (`linkable`): its
    /// template says so, or it has no active template. Not whether it links:
    /// that is [`Entry::auto_link`].
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

    /// The `media` module items visible under the entry's active template (or all
    /// stored `media` modules if the template is missing).
    pub fn visible_media<'a>(
        &'a self,
        templates: &'a BTreeMap<EntryTemplateId, EntryTemplate>,
    ) -> BTreeMap<&'a ModuleId, &'a [MediaItem]> {
        let Some(tpl) = self.effective_template(templates) else {
            return self.media.iter().map(|(k, v)| (k, v.as_slice())).collect();
        };
        let mut out = BTreeMap::new();
        for m in &tpl.modules {
            if m.kind == ModuleKind::Media
                && let Some(items) = self.media.get(&m.id)
            {
                out.insert(&m.id, items.as_slice());
            }
        }
        out
    }

    /// How this entry lays out its media module `module`: its own choice,
    /// else its active template's default for the module, else `featured`.
    pub fn media_arrangement(
        &self,
        module: &ModuleId,
        templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
    ) -> MediaArrangement {
        if let Some(own) = self.arrangements.get(module) {
            return own.clone();
        }
        self.effective_template(templates)
            .and_then(|t| t.module(module))
            .and_then(|m| m.config.arrangement.clone())
            .unwrap_or_default()
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

/// Next coordinate at the end of `placements` (`VIEW-LANE-MEMBERS-PLACED`,
/// `kernel-v5.md` §4): after the last card as the view draws it, with
/// [`PLACEMENT_GAP`] of air. `0.0` when there are no finite placements,
/// otherwise `max(at + span) + PLACEMENT_GAP`, where a placement without a
/// usable span (none, negative or not finite) counts
/// [`DEFAULT_PLACEMENT_SPAN`] wide. Entries placed there in one go without
/// a span follow each other [`PLACEMENT_STEP`] apart.
pub fn timeline_scale_end(placements: &[TimelinePlacement]) -> f64 {
    placements
        .iter()
        .filter(|p| p.at.is_finite())
        .map(|p| {
            let span = p
                .span
                .filter(|s| s.is_finite() && *s >= 0.0)
                .unwrap_or(DEFAULT_PLACEMENT_SPAN);
            p.at + span
        })
        .reduce(f64::max)
        .map_or(0.0, |m| m + PLACEMENT_GAP)
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

/// Where inside `target_module` (or directly on an asset) a comment sits (`comments.<id>.part`, `kernel-v5.md` §6, §7 & §10).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CommentPart {
    /// An embedded file inside a `prose` module, optionally with a region on it.
    Embed {
        embed: EmbedId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        region: Option<MaterialRegion>,
    },
    /// A field definition inside a `fields` module, keyed by `FieldDef.id` (never `FieldDef.name`).
    Field { field: FieldId },
    /// A row inside a `key_value` module.
    KvRow { row: KvEntryId },
    /// A cell inside a `plot_grid` module.
    PlotCell { row: PlotRowId, col: PlotColId },
    /// A patch inside a `patches` module.
    Patch { patch: PatchId },
    /// A file inside a `media` module, optionally with a region on the image
    /// or PDF page. The file names the place: it sits in the module once
    /// (`MEDIA-ASSET-ONCE`), so the comment survives the item being put back.
    Media {
        asset: AssetId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        region: Option<MaterialRegion>,
    },
    /// A rectangle on an image or PDF page when commenting directly on an asset in the asset library.
    Region { region: MaterialRegion },
}

impl CommentPart {
    /// Image or PDF rectangle carried by this part, if any.
    pub fn region(&self) -> Option<&MaterialRegion> {
        match self {
            CommentPart::Embed { region, .. } | CommentPart::Media { region, .. } => {
                region.as_ref()
            }
            CommentPart::Region { region } => Some(region),
            _ => None,
        }
    }
}

/// A comment in schema v5 (`comments` map, `kernel-v5.md` §7 & §10).
/// Targets `(target, target_module, part)`, any prefix of which may be omitted.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CommentV3 {
    pub id: CommentId,
    pub target: Option<EntityRef>,
    /// Module on `target` (`module` in Loro): any module kind on the entry.
    pub target_module: Option<ModuleId>,
    /// Specific sub-item inside `target_module` (`part` in Loro).
    pub part: Option<CommentPart>,
    pub target_missing: bool,
    pub target_block: Option<BlockId>,
    pub anchor: Option<EncodedAnchor>,
    pub quote: Option<String>,
    pub snapshots: Vec<BlockSnapshot>,
    pub origin: CommentOrigin,
    pub author_kind: CommentAuthorKind,
    pub author: Option<String>,
    pub author_name: Option<String>,
    pub body: LinkedText,
    /// Open or resolved; a comment has no priority (`kernel-v5.md` §7).
    pub status: CommentStatus,
    pub source: CommentSource,
    pub metadata: Option<String>,
    pub agent_conversation: Option<String>,
    pub projection: Option<TodoProjection>,
    pub resolved_at: Option<Timestamp>,
    pub created_at: Option<Timestamp>,
    pub updated_at: Option<Timestamp>,
}

impl CommentV3 {
    pub fn is_done(&self) -> bool {
        self.status == CommentStatus::Resolved
    }

    pub fn region(&self) -> Option<&MaterialRegion> {
        self.part.as_ref().and_then(CommentPart::region)
    }
}

/// Invariant `COMMENT-PART-IN-MODULE` (`kernel-v5.md` §7 & §11): a comment's
/// `part` kind must match the kind of `module` it addresses.
/// `CommentPart::Region` only applies to comments directly targeting an asset
/// (`target_module == None`) and never belongs to an entry module.
pub fn check_comment_part_kind(
    part: &CommentPart,
    module_kind: &ModuleKind,
) -> Result<(), Violation> {
    let ok = match part {
        CommentPart::Embed { .. } => *module_kind == ModuleKind::Prose,
        CommentPart::Field { .. } => *module_kind == ModuleKind::Fields,
        CommentPart::KvRow { .. } => *module_kind == ModuleKind::KeyValue,
        CommentPart::PlotCell { .. } => *module_kind == ModuleKind::PlotGrid,
        CommentPart::Patch { .. } => *module_kind == ModuleKind::Patches,
        CommentPart::Media { .. } => *module_kind == ModuleKind::Media,
        CommentPart::Region { .. } => false,
    };
    if !ok {
        return fail(
            "COMMENT-PART-IN-MODULE",
            format!("comment part {part:?} does not belong to a {module_kind} module"),
        );
    }
    Ok(())
}

v3_open_enum!(
    /// Where a book's initial project template came from (`project.source.origin`,
    /// `project-templates.md` §8).
    ProjectTemplateOrigin {
        Builtin = "builtin",
        Own = "own",
        File = "file",
        Community = "community",
    }
);

pub use crate::project_template::ProjectTemplateCredit;

/// Which project template initialized the book (`project.source`,
/// `project-templates.md` §8).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectTemplateRef {
    pub id: String,
    pub version: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<ProjectTemplateOrigin>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credit: Option<ProjectTemplateCredit>,
}

/// Book metadata in schema v5 (`meta` container, `v = 5`).
/// Word targets and project source live in `project` ([`ProjectDefinition`]).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BookMetaV3 {
    pub id: BookId,
    pub schema_version: i64,
    pub name: String,
    pub summary: String,
    pub deleted_at: Option<Timestamp>,
    pub created_at: Option<Timestamp>,
}

/// Where a flatten starts (整书视图的出发点, `kernel-v5.md` §3 「怎么读」 and
/// §16 「摊平、成书、整书视图」): the root, an entry with its level switch or
/// 「收别处的条目」 on, a view (its lanes along its scale), or one lane of a
/// view. It has nothing to do with the book, which always reads from the
/// root ([`FlattenFrom::Root`]); it is not stored in the book.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FlattenFrom {
    Root,
    Entry {
        entry: EntryId,
    },
    View {
        view: TimelineViewId,
    },
    Lane {
        view: TimelineViewId,
        entry: EntryId,
    },
}

/// The book inside `project.book` (`kernel-v5.md` §3 & §10): the switch is
/// the record being there, and two word targets. The book has no start: it
/// reads the whole project from the root. A `root` an older book still
/// stores is not read.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectBook {
    #[serde(default)]
    pub word_target_set: Option<i64>,
    #[serde(default)]
    pub daily_word_target_set: Option<i64>,
}

impl ProjectBook {
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

/// Target mounted on a left-sidebar tab (`project.tabs.<id>.mount`, `kernel-v5.md` §5 & §10).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TabMount {
    Root,
    Entry { entry: EntryId },
    View { view: TimelineViewId },
    Book,
}

/// One left-sidebar tab in `project.tabs` (`kernel-v5.md` §5 & §10).
///
/// A tab has no name of its own: it is called what it mounts (an entry's
/// title, a view's name, 「成书」, or 「全部」 for the root). A stored or
/// template tab that still carries an old `name` key reads as if it had none.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectTab {
    pub id: TabId,
    #[serde(default)]
    pub pos: Option<PosKey>,
    pub mount: TabMount,
    /// The title of the entry it mounts, written in the step that deletes
    /// that entry for good (`entry.purge`, `TAB-KEEPS-GONE-NAME`): the Tab
    /// keeps being called by it (`kernel-v5.md` §5). Read only while the
    /// entry is not in the book.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gone_title: Option<String>,
}

/// The fixed id of 「全部」, the tab mounted at the root (`TAB-ROOT-ALWAYS`,
/// `kernel-v5.md` §5 & §10). A project that stores no root tab reads one
/// with this id, so two devices that each move it write the same key.
pub const ALL_TAB_ID: &str = "tab-all";

/// [`ALL_TAB_ID`] as a [`TabId`].
pub fn all_tab_id() -> TabId {
    TabId::parse(ALL_TAB_ID).expect("the fixed tab id is valid")
}

/// Sort project tabs deterministically by `(pos, id)`.
pub fn sort_project_tabs(tabs: &mut [ProjectTab]) {
    tabs.sort_by(|a, b| cmp_pos((a.pos.as_ref(), &a.id), (b.pos.as_ref(), &b.id)));
}

/// The tabs as a project shows them (`TAB-MOUNT-ONCE`, `TAB-ROOT-ALWAYS`):
/// sorted by `(pos, id)`; a tab whose mount an earlier tab already has is
/// left out (two devices mounted the same thing at once); and, when no tab
/// is mounted at the root, 「全部」 is added first with [`ALL_TAB_ID`] and a
/// position before every other tab's, computed from the tabs alone so every
/// device reads the same one. A stored tab that has the fixed id but is not
/// mounted at the root is left out too: the id belongs to 「全部」. Nothing
/// is written; what is left out stays stored.
pub fn shown_project_tabs(mut tabs: Vec<ProjectTab>) -> Vec<ProjectTab> {
    sort_project_tabs(&mut tabs);
    let all = all_tab_id();
    let mut seen: Vec<TabMount> = Vec::with_capacity(tabs.len());
    tabs.retain(|t| {
        if (t.id == all && t.mount != TabMount::Root) || seen.contains(&t.mount) {
            return false;
        }
        seen.push(t.mount.clone());
        true
    });
    if !seen.contains(&TabMount::Root) {
        let pos = match tabs.first().and_then(|t| t.pos.as_ref()) {
            Some(first) => PosKey::between(None, Some(first)).unwrap_or_else(|_| first.clone()),
            None => PosKey::first(),
        };
        tabs.insert(
            0,
            ProjectTab {
                id: all,
                pos: Some(pos),
                mount: TabMount::Root,
                gone_title: None,
            },
        );
    }
    tabs
}

/// Project-level definition in the `project` root container (`kernel-v5.md` §2 & §10).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectDefinition {
    #[serde(default)]
    pub source: Option<ProjectTemplateRef>,
    #[serde(default)]
    pub agent: Option<TemplateAgentConfig>,
    #[serde(default)]
    pub book: Option<ProjectBook>,
    #[serde(default)]
    pub tabs: Vec<ProjectTab>,
}

impl ProjectDefinition {
    /// Effective whole-book word target (`None` when the project has no book or turned it off).
    pub fn word_target(&self) -> Option<i64> {
        self.book.as_ref().and_then(ProjectBook::word_target)
    }

    /// Effective daily word target (`None` when the project has no book or turned it off).
    pub fn daily_word_target(&self) -> Option<i64> {
        self.book.as_ref().and_then(ProjectBook::daily_word_target)
    }
}

/// Initial entry seeded by a [`ProjectTemplate`] (`kernel-v5.md` §2).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProjectSeedEntry {
    pub id: EntryId,
    #[serde(default)]
    pub parent: Option<EntryId>,
    pub title: String,
    #[serde(default)]
    pub mark: Option<String>,
    #[serde(default)]
    pub template: Option<EntryTemplateId>,
    #[serde(default)]
    pub level: bool,
    #[serde(default)]
    pub overrides: Option<LevelSettingsOverride>,
    #[serde(default)]
    pub fields: BTreeMap<ModuleId, BTreeMap<String, FieldValue>>,
}

/// Self-contained project template (`项目定义 + 条目模板 + 起始条目 + 起始视图`, `kernel-v5.md` §2).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ProjectTemplate {
    #[serde(default)]
    pub project: ProjectDefinition,
    #[serde(default)]
    pub templates: Vec<EntryTemplate>,
    #[serde(default)]
    pub entries: Vec<ProjectSeedEntry>,
    #[serde(default)]
    pub views: Vec<TimelineView>,
}

impl ProjectTemplate {
    /// The same template with a fresh id for every seed entry, view, tab
    /// (but 「全部」, which takes [`ALL_TAB_ID`]) and time pin, and every
    /// reference to one of them rewritten: residence,
    /// `home`, entity-reference fields, lanes, placements, pins and tab
    /// mounts. A project is created from this copy, so two
    /// projects made from one template never share a `body:<entry>/<module>`
    /// document (`V3-DOCID-LIBRARY-UNIQUE`). Template ids stay: they are keys
    /// inside one book.
    pub fn with_fresh_ids(&self) -> Self {
        let entry_ids: BTreeMap<EntryId, EntryId> = self
            .entries
            .iter()
            .map(|e| (e.id.clone(), EntryId::new_v7()))
            .collect();
        let view_ids: BTreeMap<TimelineViewId, TimelineViewId> = self
            .views
            .iter()
            .map(|v| (v.id.clone(), TimelineViewId::new_v7()))
            .collect();
        let entry = |id: &EntryId| entry_ids.get(id).cloned().unwrap_or_else(|| id.clone());
        let view = |id: &TimelineViewId| view_ids.get(id).cloned().unwrap_or_else(|| id.clone());
        let entity_ref = |value: &mut FieldValue| {
            let one = |s: &mut String| {
                if let Some(fresh) = EntryId::parse(s).ok().and_then(|id| entry_ids.get(&id)) {
                    *s = fresh.to_string();
                }
            };
            match value {
                FieldValue::Text(s) => one(s),
                FieldValue::List(items) => items.iter_mut().for_each(one),
                _ => {}
            }
        };
        let is_entity_ref = |template: Option<&EntryTemplateId>, module: &ModuleId, field: &str| {
            self.templates
                .iter()
                .find(|t| Some(&t.id) == template)
                .and_then(|t| t.module(module))
                .and_then(|m| m.config.defs.iter().find(|d| d.id == field))
                .is_some_and(|d| d.field_type == FieldType::EntityRef)
        };

        let mut out = self.clone();
        for tab in &mut out.project.tabs {
            // 「全部」 keeps its fixed id in every project (`TAB-ROOT-ALWAYS`).
            tab.id = if tab.mount == TabMount::Root {
                all_tab_id()
            } else {
                TabId::new_v7()
            };
            tab.mount = match &tab.mount {
                TabMount::Entry { entry: e } => TabMount::Entry { entry: entry(e) },
                TabMount::View { view: v } => TabMount::View { view: view(v) },
                other => other.clone(),
            };
        }
        for template in &mut out.templates {
            if let Some(Some(home)) = &mut template.settings.home {
                *home = entry(home);
            }
            for module in &mut template.modules {
                for def in &mut module.config.defs {
                    if def.field_type == FieldType::EntityRef
                        && let Some(value) = &mut def.default_value
                    {
                        entity_ref(value);
                    }
                }
            }
        }
        for seed in &mut out.entries {
            let template = seed.template.clone();
            seed.id = entry(&seed.id);
            seed.parent = seed.parent.as_ref().map(&entry);
            if let Some(ov) = &mut seed.overrides
                && let Some(Some(home)) = &mut ov.home
            {
                *home = entry(home);
            }
            for (module, fields) in &mut seed.fields {
                for (field, value) in fields.iter_mut() {
                    if is_entity_ref(template.as_ref(), module, field) {
                        entity_ref(value);
                    }
                }
            }
        }
        for v in &mut out.views {
            v.id = view(&v.id);
            for lane in &mut v.lanes {
                lane.entry = entry(&lane.entry);
            }
            for placement in &mut v.placements {
                placement.entry = entry(&placement.entry);
            }
            for pin in &mut v.pins {
                pin.id = TimePinId::new_v7();
                pin.entry = pin.entry.as_ref().map(&entry);
            }
        }
        out
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

/// What goes with `id` when it is restored from Recently Deleted or deleted
/// for good (`kernel-v5.md` §16, `ENTRY-TRASH-TOGETHER`): `id` itself and
/// every entry living below it that went in with it, which carries the same
/// `deleted_at`. An entry below it that went in on its own (another time)
/// stays out, and so does everything below that one. A live `id` takes only
/// its live subtree, as `entry.trash` does.
pub fn trashed_with(entries: &BTreeMap<EntryId, Entry>, id: &EntryId) -> BTreeSet<EntryId> {
    let Some(stamp) = entries.get(id).map(|e| e.deleted_at) else {
        return BTreeSet::new();
    };
    let mut children: BTreeMap<&EntryId, Vec<&Entry>> = BTreeMap::new();
    for e in entries.values() {
        if let Some(parent) = &e.parent {
            children.entry(parent).or_default().push(e);
        }
    }
    let mut out = BTreeSet::from([id.clone()]);
    let mut todo = vec![id];
    while let Some(cur) = todo.pop() {
        for child in children.get(cur).into_iter().flatten() {
            if child.deleted_at == stamp && out.insert(child.id.clone()) {
                todo.push(&child.id);
            }
        }
    }
    out
}

/// Where `id` lives once it is restored on its own from Recently Deleted
/// (`kernel-v5.md` §16): where it lived, while that entry is still there,
/// out of Recently Deleted and with its `层级` switch on; otherwise the
/// nearest entry above it that is all three, or the outermost (`None`). An
/// entry above it that is no longer stored ends the walk at the outermost.
pub fn restored_residence(entries: &BTreeMap<EntryId, Entry>, id: &EntryId) -> Option<EntryId> {
    let takes = |e: &Entry| !e.is_trashed() && e.is_level();
    let mut cur = entries.get(id)?.parent.clone();
    let mut seen = BTreeSet::from([id.clone()]);
    while let Some(anc) = cur {
        if !seen.insert(anc.clone()) {
            return None;
        }
        let e = entries.get(&anc)?;
        if takes(e) {
            return Some(anc);
        }
        cur = e.parent.clone();
    }
    None
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
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ResolvedLevelSettings {
    pub settings: LevelSettings,
    pub sources: BTreeMap<String, LevelSettingSource>,
}
pub const LEVEL_SETTING_KEYS: [&str; 6] = [
    "default_template",
    "display",
    "auto_link",
    "accept",
    "home",
    "format_shortcuts",
];

/// `accept` as set on `entry` itself or, failing that, on its template: the
/// value and where it came from (`None` when neither says). Never inherited.
fn own_accept(
    entry: &Entry,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> Option<(bool, LevelSettingSource)> {
    if let Some(accept) = entry.overrides.as_ref().and_then(|o| o.accept) {
        return Some((
            accept,
            LevelSettingSource::Override {
                entry: entry.id.clone(),
            },
        ));
    }
    let tpl = entry.effective_template(templates)?;
    tpl.settings.accept.map(|accept| {
        (
            accept,
            LevelSettingSource::Template {
                entry: entry.id.clone(),
                template: tpl.id.clone(),
            },
        )
    })
}

/// `home` as set on `entry` itself or, failing that, on its template: the
/// value and where it came from (`None` when neither says). Never inherited.
fn own_home(
    entry: &Entry,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> Option<(Option<EntryId>, LevelSettingSource)> {
    if let Some(home) = entry.overrides.as_ref().and_then(|o| o.home.clone()) {
        return Some((
            home,
            LevelSettingSource::Override {
                entry: entry.id.clone(),
            },
        ));
    }
    let tpl = entry.effective_template(templates)?;
    tpl.settings.home.clone().map(|home| {
        (
            home,
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
                sources.insert(stringify!($field).into(), source());
            }
        )* }; }
        provenance!(default_template, display, auto_link, format_shortcuts);
    }
    acc.default_template = acc
        .default_template
        .clone()
        .or_else(|| from.default_template.clone());
    acc.display = acc.display.clone().or_else(|| from.display.clone());
    acc.auto_link = acc.auto_link.or(from.auto_link);
    acc.format_shortcuts = acc
        .format_shortcuts
        .clone()
        .or_else(|| from.format_shortcuts.clone());
}

/// Resolve the effective [`LevelSettings`] of `level_id` (`kernel-v5.md` §16):
/// `accept` and `home` come strictly from the entry's own overrides and its
/// active template (never inherited, independent of `level`), while
/// `default_template`, `display`, `auto_link`, and `format_shortcuts` inherit
/// along `effective_ancestors`. Entries with both `level == false` and
/// `accept == false`, the root (`None`), and missing entries read as defaults.
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
    let Some(target) = entries.get(lid).filter(|e| e.has_below(templates)) else {
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
    let own_acc = own_accept(target, templates);
    let own_hm = own_home(target, templates);
    let accept = own_acc.as_ref().is_some_and(|(a, _)| *a);
    let home = own_hm.as_ref().and_then(|(h, _)| h.clone());
    if let Some(sources) = sources {
        if let Some((_, src)) = own_acc {
            sources.insert("accept".into(), src);
        }
        if let Some((_, src)) = own_hm {
            sources.insert("home".into(), src);
        }
    }
    acc.finish(accept, home)
}

/// Resolve where a new entry attached to `host_id` ("挂到", `kernel-v5.md` §16)
/// resides in the tree:
/// - `host`'s own `home` when set and pointing to a live level (`is_level`);
/// - otherwise `Some(host_id)` when `host` itself is a live level;
/// - otherwise `None` (the root / 最外层).
pub fn resolve_host_residence(
    host_id: &EntryId,
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> Option<EntryId> {
    let host = entries.get(host_id)?;
    if let Some(home_id) = host.own_home(templates)
        && check_parent_is_level(Some(&home_id), entries).is_ok()
    {
        return Some(home_id);
    }
    if check_parent_is_level(Some(host_id), entries).is_ok() {
        return Some(host_id.clone());
    }
    None
}

/// Resolve where a new entry created from `context_level_id` resides in the
/// tree (`kernel-v5.md` §16): when `context_level_id` accepts memberships, uses
/// [`resolve_host_residence`]; otherwise resides under `context_level_id` if it
/// is a live level, else at the root.
pub fn resolve_new_entry_residence(
    context_level_id: Option<&EntryId>,
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> Option<EntryId> {
    let lid = context_level_id?;
    let entry = entries.get(lid)?;
    if entry.accepts_members(templates) {
        return resolve_host_residence(lid, entries, templates);
    }
    check_parent_is_level(Some(lid), entries)
        .ok()
        .map(|()| lid.clone())
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

/// Invariant 7 (`V3-MEMBERSHIP-RULES`, `kernel-v5.md` §16): whether
/// `member_id` can belong to `host_id` is decided by the host alone: both ends
/// live, and the host's `accept` on (from its own overrides or its template,
/// regardless of `level`). The member's template does not matter.
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
    if !host.accepts_members(templates) {
        return fail(
            "V3-MEMBERSHIP-RULES",
            format!("entry {host_id} does not accept entries from elsewhere"),
        );
    }
    Ok(())
}

/// Read-side filter for Invariant 7 (`V3-MEMBERSHIP-RULES`, `kernel-v5.md` §16):
/// only the memberships whose two ends are live and whose host accepts
/// memberships (`accepts_members`). Each host is checked once.
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
                        .is_some_and(|h| !h.is_trashed() && h.accepts_members(templates))
                })
        })
        .cloned()
        .collect()
}

/// Invariant 8 (`V3-TIMELINE-LANE-ENABLED`, `kernel-v5.md` §16 「泳道」): a
/// timeline swimlane must point to a live entry that takes entries from
/// elsewhere (`accept`, [`Entry::accepts_members`]); its level switch does not
/// count (DV, 2026-11-16: an entry with only its level on is no lane). The
/// command layer refuses a new such lane; readers
/// ([`effective_timeline_lanes`]) leave out a stored one, data kept.
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
    if !entry.accepts_members(templates) {
        return fail(
            "V3-TIMELINE-LANE-ENABLED",
            format!("entry {entry_id} does not take entries from elsewhere (accept is off)"),
        );
    }
    Ok(())
}

/// DV2 (`kernel-v5.md` §15 item 31): whether a stored lane is one of the old
/// lanes that are only a level, which a book clears once when it opens: its
/// entry is live (and so is every entry above it), has its level switch on
/// and takes no entries from elsewhere. Every such lane fails
/// [`check_timeline_lane`], so readers ([`effective_timeline_lanes`]) leave
/// it out already. The other lanes they leave out are not these and stay: a
/// lane whose entry is gone or in Recently Deleted (or under an entry that
/// is), and one with both switches off (a storyline whose 「收别处的条目」
/// the author turned off comes back when it is turned on again).
pub fn is_level_only_lane(
    entry_id: &EntryId,
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> bool {
    is_entry_live(entry_id, entries)
        && entries[entry_id].is_level()
        && !entries[entry_id].accepts_members(templates)
}

/// Read-side filter for Invariant 8 (`V3-TIMELINE-LANE-ENABLED`): ignores lanes
/// whose target entry is missing, trashed, or does not take entries from
/// elsewhere (`accept` off, whatever its level switch). The stored lane stays.
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

/// All entry IDs that are effective swimlanes in at least one non-deleted view
/// (`kernel-v5.md` §16: "原来问「是不是泳道」的地方，改成问「它在不在某个视图里」").
pub fn active_lane_ids(
    views: &[TimelineView],
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> BTreeSet<EntryId> {
    let mut out = BTreeSet::new();
    for v in views.iter().filter(|v| !v.is_trashed()) {
        for l in effective_timeline_lanes(&v.lanes, entries, templates) {
            out.insert(l.entry);
        }
    }
    out
}

/// Whether `entry_id` is an effective swimlane in at least one non-deleted view.
pub fn is_in_any_view(
    entry_id: &EntryId,
    views: &[TimelineView],
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> bool {
    views.iter().filter(|v| !v.is_trashed()).any(|v| {
        effective_timeline_lanes(&v.lanes, entries, templates)
            .iter()
            .any(|l| &l.entry == entry_id)
    })
}

/// Whether `entry_id` belongs to swimlane `lane_id` (`kernel-v5.md` §16
/// 「泳道」): it is validly hung on `lane_id` (a membership, `lane_id` taking
/// entries from elsewhere). Living under `lane_id` does not count (DV,
/// 2026-11-16: a lane holds only what is hung on it).
pub fn is_entry_in_lane(
    lane_id: &EntryId,
    entry_id: &EntryId,
    memberships: &[Membership],
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> bool {
    let Some(lane) = entries.get(lane_id).filter(|e| !e.is_trashed()) else {
        return false;
    };
    if entries.get(entry_id).is_none_or(Entry::is_trashed) {
        return false;
    }
    lane.accepts_members(templates)
        && lane_id != entry_id
        && memberships
            .iter()
            .any(|m| &m.host == lane_id && &m.member == entry_id)
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
    effective_timeline_lanes(&view.lanes, entries, templates)
        .iter()
        .any(|l| is_entry_in_lane(&l.entry, entry_id, memberships, entries, templates))
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
/// no longer in any swimlane of `view`, removes `member_id`'s placement from
/// `view`.
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

/// The lane an entry is coloured and marked by (`kernel-v5.md` §16): its
/// primary membership's host when that host is in a non-deleted view, else the
/// first host in `memberships` order that is in a non-deleted view.
/// `memberships` are the valid ones ([`filter_valid_memberships`]).
pub fn primary_lane<'a>(
    entry: &Entry,
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
    memberships: &'a [Membership],
    views: &[TimelineView],
) -> Option<&'a EntryId> {
    let lanes = active_lane_ids(views, entries, templates);
    let is_lane = |host: &EntryId| lanes.contains(host);
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

/// The colour an entry is shown in (`kernel-v5.md` §16), whatever its
/// switch: its own colour field when it has a value, else its primary
/// lane's colour ([`primary_lane`], [`lane_color`]), else its template's
/// colour. `memberships` are the valid ones.
pub fn entry_color(
    entry: &Entry,
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
    memberships: &[Membership],
    views: &[TimelineView],
) -> Option<String> {
    own_color(entry, templates)
        .or_else(|| {
            primary_lane(entry, entries, templates, memberships, views)
                .and_then(|lane| entries.get(lane))
                .and_then(|lane| lane_color(lane, templates))
        })
        .or_else(|| template_color(entry, templates))
}

/// Whether `entry` auto-links (`kernel-v5.md` §16 「自动链接」): it is live
/// and its own switch ([`Entry::auto_link`]) is on. Where it lives, what it
/// belongs to and its template do not count.
pub fn is_autolinked(entry: &Entry) -> bool {
    !entry.is_trashed() && entry.auto_link
}

/// The switch a new entry of `template` starts with when it comes to live
/// under `parent` (`None`: the outermost level; `kernel-v5.md` §16): on when
/// the template is `linkable` (no template counts as `linkable`) and the
/// level's 「自动链接」 resolves on, the nearest level that sets it deciding.
/// The root sets nothing, so an entry at the outermost level starts off.
pub fn new_entry_auto_link(
    parent: Option<&EntryId>,
    template: Option<&EntryTemplateId>,
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> bool {
    let linkable = template
        .and_then(|t| templates.get(t))
        .filter(|t| !t.is_trashed())
        .is_none_or(|t| t.linkable);
    linkable && resolve_level_settings(parent, entries, templates).auto_link
}

/// The entries a level's 「自动链接」 carries along when the author turns it
/// on or off (`kernel-v5.md` §16): every live entry living below `level`,
/// however deep, whose template is `linkable`. A container that is not
/// `linkable` keeps its own switch, but what lives in it is carried along.
/// Entries in Recently Deleted keep theirs.
pub fn below_auto_link_entries(
    level: &EntryId,
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> Vec<EntryId> {
    let mut children: BTreeMap<&EntryId, Vec<&Entry>> = BTreeMap::new();
    for e in entries.values().filter(|e| !e.is_trashed()) {
        if let Some(p) = e.parent.as_ref() {
            children.entry(p).or_default().push(e);
        }
    }
    let mut out = Vec::new();
    let mut seen = BTreeSet::new();
    let mut stack = vec![level];
    while let Some(at) = stack.pop() {
        for c in children.get(at).into_iter().flatten() {
            if c.id == *level || !seen.insert(&c.id) {
                continue;
            }
            if c.is_linkable(templates) {
                out.push(c.id.clone());
            }
            stack.push(&c.id);
        }
    }
    out.sort();
    out
}

/// What a link in text shows as (`kernel-v5.md` §16 「自动链接」), for every
/// reader of links: the editor's paint, its name cards and clicks, the
/// dotted suggestions, the index queries, the mention lists, the relation
/// graph, the right bar, and the links of comments and descriptions. The
/// link's data stays in the text whatever it shows as.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LinkShow {
    /// A link: underlined, it opens its entry, its name card shows.
    Live,
    /// A link whose entry is gone (in Recently Deleted, purged, not in this
    /// book): drawn muted, as before.
    Gone,
    /// Ordinary text: an automatic link to an entry whose own switch is off,
    /// or any automatic link while the author's setting
    /// (`editor.auto_entity_links`) is off. Turning either back on shows it
    /// again.
    Plain,
}

impl LinkShow {
    /// Whether it reads as a link at all (live or gone).
    pub fn is_link(self) -> bool {
        !matches!(self, LinkShow::Plain)
    }
}

/// What the link reader knows about the entry a link points at.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct LinkEntry {
    /// Not in Recently Deleted.
    pub live: bool,
    /// Its own 「自动链接」 ([`Entry::auto_link`]).
    pub auto_link: bool,
}

impl From<&Entry> for LinkEntry {
    fn from(e: &Entry) -> Self {
        Self {
            live: !e.is_trashed(),
            auto_link: e.auto_link,
        }
    }
}

/// **The one rule** for what a link shows as (`kernel-v5.md` §16): a link
/// picked with @ (`manual`) is a link whatever the switches say; an
/// automatic one (every link written before manual links were recorded
/// counts as one) is plain text while the author's setting `auto_links` or
/// its entry's own switch is off. Then a link whose entry is live is
/// [`LinkShow::Live`], and one whose entry is gone or unknown (`target`
/// `None`) is [`LinkShow::Gone`].
pub fn link_show(manual: bool, target: Option<LinkEntry>, auto_links: bool) -> LinkShow {
    if !manual && (!auto_links || target.is_some_and(|t| !t.auto_link)) {
        return LinkShow::Plain;
    }
    match target {
        Some(t) if t.live => LinkShow::Live,
        _ => LinkShow::Gone,
    }
}

/// The link targets of one read of a book, for [`link_show`] over many
/// links: every entry of the book (Recently Deleted included) with its
/// state.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LinkEntries {
    entries: std::collections::HashMap<String, LinkEntry>,
}

impl LinkEntries {
    pub fn of<'a>(entries: impl IntoIterator<Item = &'a Entry>) -> Self {
        Self {
            entries: entries
                .into_iter()
                .map(|e| (e.id.to_string(), LinkEntry::from(e)))
                .collect(),
        }
    }

    /// The state of entry `id`, `None` when the book has no such entry.
    pub fn get(&self, id: &str) -> Option<LinkEntry> {
        self.entries.get(id).copied()
    }

    /// [`link_show`] for a link to entry `id`.
    pub fn show(&self, id: &str, manual: bool, auto_links: bool) -> LinkShow {
        link_show(manual, self.get(id), auto_links)
    }

    /// Whether entry `id` is live.
    pub fn is_live(&self, id: &str) -> bool {
        self.get(id).is_some_and(|t| t.live)
    }
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

/// The auto-link names of one read of a book (`V3-AUTOLINK-NAME-UNIQUE`,
/// `kernel-v5.md` §16): which entries auto-link (their own switch), and every
/// name key with the auto-linked entries that claim it. Built in one pass.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AutolinkNames {
    linked: BTreeSet<EntryId>,
    owners: BTreeMap<String, BTreeSet<EntryId>>,
}

impl AutolinkNames {
    pub fn of(
        entries: &BTreeMap<EntryId, Entry>,
        templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
    ) -> Self {
        let mut out = Self::default();
        for e in entries.values() {
            if !is_autolinked(e) {
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
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> BTreeMap<EntryId, EntryId> {
    let snapshot = &*entries;
    let names = AutolinkNames::of(snapshot, templates);
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

/// Whether `entry_id` exists in `entries` and neither it nor any ancestor in
/// its tree chain is trashed.
pub fn is_entry_live(entry_id: &EntryId, entries: &BTreeMap<EntryId, Entry>) -> bool {
    let Some(entry) = entries.get(entry_id) else {
        return false;
    };
    if entry.is_trashed() {
        return false;
    }
    !ancestors_without_cycle(entries, entry_id)
        .iter()
        .any(|a| entries.get(a).is_some_and(Entry::is_trashed))
}

/// Whether a flatten can start at `from` (`kernel-v5.md` §16 「摊平、成书、
/// 整书视图」): the root; a live entry with its level switch or 「收别处的条目」
/// on; a view that is not deleted; or an effective lane of such a view.
pub fn is_valid_flatten_from(
    from: &FlattenFrom,
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
    views: &BTreeMap<TimelineViewId, TimelineView>,
) -> bool {
    let live_view = |view: &TimelineViewId| views.get(view).filter(|v| v.deleted_at.is_none());
    match from {
        FlattenFrom::Root => true,
        FlattenFrom::Entry { entry } => {
            is_entry_live(entry, entries) && entries[entry].has_below(templates)
        }
        FlattenFrom::View { view } => live_view(view).is_some(),
        FlattenFrom::Lane { view, entry } => live_view(view).is_some_and(|v| {
            is_entry_live(entry, entries)
                && effective_timeline_lanes(&v.lanes, entries, templates)
                    .iter()
                    .any(|l| &l.entry == entry)
        }),
    }
}

/// Invariant `TAB-MOUNT-VALID` (`kernel-v5.md` §5, §11 & §16): a tab mount must
/// be the root, a live entry with `level == true` or `accept == true`, or the
/// book sequence when `has_book` is on. A Tab cannot mount a view (DV,
/// 2026-11-16, author: 「左栏不能挂视图，视图和底栏是绑定的。」): a view
/// mount is always refused, so a Tab a book stored on a view reads as gone.
pub fn check_tab_mount(
    mount: &TabMount,
    has_book: bool,
    entries: &BTreeMap<EntryId, Entry>,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> Result<(), Violation> {
    match mount {
        TabMount::Root => Ok(()),
        TabMount::Entry { entry } => {
            if !is_entry_live(entry, entries) {
                return fail(
                    "TAB-MOUNT-VALID",
                    format!("tab mount entry {entry} is not live"),
                );
            }
            if !entries[entry].has_below(templates) {
                return fail(
                    "TAB-MOUNT-VALID",
                    format!(
                        "tab mount entry {entry} has neither its level switch nor accept enabled"
                    ),
                );
            }
            Ok(())
        }
        TabMount::View { view } => fail(
            "TAB-MOUNT-VALID",
            format!("a tab cannot mount a view (view {view}); views go with the bottom panel"),
        ),
        TabMount::Book => {
            if !has_book {
                return fail(
                    "TAB-MOUNT-VALID",
                    "cannot mount the book sequence when the project has no book",
                );
            }
            Ok(())
        }
    }
}

fn tab_mount_text(mount: &TabMount) -> String {
    match mount {
        TabMount::Root => "the root".into(),
        TabMount::Entry { entry } => format!("entry {entry}"),
        TabMount::View { view } => format!("view {view}"),
        TabMount::Book => "the book sequence".into(),
    }
}

/// Invariant `TAB-MOUNT-ONCE` (`kernel-v5.md` §5 & §11): one thing is mounted
/// on one tab. `tabs` are the tabs as shown ([`shown_project_tabs`], so
/// 「全部」 is among them); mounting `mount` again is refused, naming the tab
/// that has it.
pub fn check_tab_mount_once(tabs: &[ProjectTab], mount: &TabMount) -> Result<(), Violation> {
    match tabs.iter().find(|t| &t.mount == mount) {
        Some(t) => fail(
            "TAB-MOUNT-ONCE",
            format!("{} is already on tab {}", tab_mount_text(mount), t.id),
        ),
        None => Ok(()),
    }
}

/// Invariant `TAB-ROOT-ALWAYS` (`kernel-v5.md` §5 & §11): 「全部」, the tab
/// mounted at the root, cannot be removed.
pub fn check_tab_removable(tab: &ProjectTab) -> Result<(), Violation> {
    if tab.mount == TabMount::Root {
        return fail(
            "TAB-ROOT-ALWAYS",
            format!("tab {} is 「全部」 (mounted at the root) and stays", tab.id),
        );
    }
    Ok(())
}

/// What the structural invariants look at in one read of a book: its entries
/// (structural parts are enough: ids, parents, titles, templates, switches,
/// overrides, alias fields, created and deleted times) and its templates.
/// Auto-linking is each entry's own switch (`kernel-v5.md` §16).
#[derive(Clone, Copy, Debug)]
pub struct BookGraph<'a> {
    pub entries: &'a BTreeMap<EntryId, Entry>,
    pub templates: &'a BTreeMap<EntryTemplateId, EntryTemplate>,
}

/// The command layer's check of a write (`kernel-v4.md` "命令层的预防：只拒绝这次
/// 写入新造成的违规"): `after` is refused only for a violation `before` did not
/// have. A duplicate auto-link name a merge left behind is tolerated by readers
/// and blocks no unrelated write; a write that resolves it (a rename, a move)
/// passes.
///
/// - `V3-AUTOLINK-NAME-UNIQUE`: a name claimed by more than one auto-linked
///   entry after the write, at least one of which did not claim it before.
///
/// Writes that change many entries at once (a level's 「自动链接」 carried
/// along, a template switch, a restore, turning a switch off) go through the
/// same comparison.
pub fn check_new_violations(before: BookGraph<'_>, after: BookGraph<'_>) -> Result<(), Violation> {
    let was = AutolinkNames::of(before.entries, before.templates);
    let now = AutolinkNames::of(after.entries, after.templates);
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
    Ok(())
}

/// Invariant 13 (`V3-CROSS-DOC-ORDER`): when a command writes both prose
/// documents (`body:` / `template:`) and the book document (`book:`), every
/// prose document write must precede the book document write.
pub fn check_cross_doc_write_order(steps: &[String]) -> Result<(), Violation> {
    let mut seen_book = false;
    for doc_id in steps {
        if doc_id.starts_with("book:") {
            seen_book = true;
        } else if seen_book && (doc_id.starts_with("body:") || doc_id.starts_with("template:")) {
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
        DocId::Layout(book_id.clone()),
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
            mark: None,
            template: tpl.map(tid),
            level: false,
            auto_link: false,
            overrides: None,
            fields: BTreeMap::new(),
            kv: BTreeMap::new(),
            media: BTreeMap::new(),
            arrangements: BTreeMap::new(),
            primary: None,
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

    /// A template whose new entries start with the switch on; `accept` in its settings.
    fn level_template(id: &str, name: &str, accept: bool) -> EntryTemplate {
        let mut t = template(id, name);
        t.level = true;
        t.linkable = false;
        if accept {
            t.settings.accept = Some(true);
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
    ) -> BookGraph<'a> {
        BookGraph { entries, templates }
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
        lane_tpl.level = false;
        lane_tpl.linkable = false;
        lane_tpl.settings.accept = Some(true);
        let mut cat_tpl = coloured("tpl-cat", Some("#cat"));
        cat_tpl.level = true;
        cat_tpl.linkable = false;
        cat_tpl.settings.accept = Some(true);
        let templates = BTreeMap::from([
            (tid("tpl-lane"), lane_tpl),
            (tid("tpl-cat"), cat_tpl),
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
        let mut red = entry_with("lane-red", None, "红线", Some("tpl-lane"));
        paint(&mut red, "#red");
        let blue = entry_with("lane-blue", None, "蓝线", Some("tpl-lane"));
        let cat = level_with("cat", None, "分类（不在视图里）", Some("tpl-cat"));
        let mut chapter = entry_with("chapter", None, "一", Some("tpl-chapter"));
        chapter.primary = Some(eid("lane-red"));
        let entries: BTreeMap<_, _> = [red, blue, cat, chapter.clone()]
            .into_iter()
            .map(|e| (e.id.clone(), e))
            .collect();
        let views = vec![TimelineView {
            id: TimelineViewId::parse("v1").unwrap(),
            name: "主视图".into(),
            pos: None,
            lanes: vec![
                TimelineLane {
                    entry: eid("lane-blue"),
                    pos: None,
                    act_track: None,
                },
                TimelineLane {
                    entry: eid("lane-red"),
                    pos: None,
                    act_track: None,
                },
            ],
            placements: Vec::new(),
            pins: Vec::new(),
            deleted_at: None,
        }];
        let memberships = vec![
            membership("cat", "chapter"),
            membership("lane-blue", "chapter"),
            membership("lane-red", "chapter"),
        ];
        let colour = |e: &Entry, entries: &BTreeMap<EntryId, Entry>, ms: &[Membership]| {
            entry_color(e, entries, &templates, ms, &views)
        };
        // The primary lane's own colour comes before the entry's template's;
        // `cat` is not in any view so it is not treated as a lane.
        assert_eq!(
            primary_lane(&chapter, &entries, &templates, &memberships, &views),
            Some(&eid("lane-red"))
        );
        assert_eq!(
            colour(&chapter, &entries, &memberships).as_deref(),
            Some("#red")
        );
        // Without a primary (or primary not in a view): the first host in a view.
        let mut loose = chapter.clone();
        loose.primary = Some(eid("cat"));
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
        // No lane in any view: its template's colour.
        assert_eq!(colour(&chapter, &entries, &[]).as_deref(), Some("#chapter"));
    }

    #[test]
    fn v3_level_settings_inherit_down_ancestors_and_override() {
        let mut tpl_elements = level_template("tpl-elements", "要素", false);
        tpl_elements.settings.display = Some(ChildDisplayMode::Island);
        let tpl_category = level_template("tpl-category", "分类", true);
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
            home: Some(Some(eid("elements"))),
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
        // and `display: Island` from `elements`, while `accept` and `home` do NOT inherit.
        let inherited = resolve_level_settings(Some(&eid("grp-heroes")), &entries, &templates);
        assert_eq!(inherited.default_template, Some(tid("tpl-person")));
        assert!(inherited.auto_link);
        assert_eq!(inherited.display, ChildDisplayMode::Island);
        assert!(!inherited.accept);
        assert_eq!(inherited.home, None);

        // Overriding `auto_link = false` on `grp-heroes` turns it off for that sub-branch.
        entries.get_mut(&eid("grp-heroes")).unwrap().overrides = Some(LevelSettingsOverride {
            auto_link: Some(false),
            ..LevelSettingsOverride::default()
        });
        let overridden = resolve_level_settings(Some(&eid("grp-heroes")), &entries, &templates);
        assert!(!overridden.auto_link);
        assert_eq!(overridden.default_template, Some(tid("tpl-person")));

        // An ancestor whose `level` switch is off passes nothing down to residents
        // under it in the tree, even if `accept` is on for `cat-person` itself.
        entries.get_mut(&eid("cat-person")).unwrap().level = false;
        let skipped = resolve_level_settings(Some(&eid("grp-heroes")), &entries, &templates);
        assert_eq!(skipped.default_template, None);
        assert_eq!(skipped.display, ChildDisplayMode::Island);
        // Meanwhile `cat-person` itself still resolves its settings because `accept` is on.
        let cat_resolved = resolve_level_settings(Some(&eid("cat-person")), &entries, &templates);
        assert!(cat_resolved.accept);
        assert_eq!(cat_resolved.display, ChildDisplayMode::Island);
    }

    #[test]
    fn settings_sources_follow_the_value_resolver_without_inheriting_accept_or_home() {
        let mut parent_tpl = level_template("parent-tpl", "Parent", true);
        parent_tpl.settings.display = Some(ChildDisplayMode::Island);
        parent_tpl.settings.home = Some(Some(eid("home")));
        let mut lane_tpl = template("lane-tpl", "Lane");
        lane_tpl.level = false;
        lane_tpl.linkable = false;
        lane_tpl.settings.auto_link = Some(false);
        lane_tpl.settings.accept = Some(true);
        lane_tpl.settings.home = Some(Some(eid("home")));
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
        // `lane` has `level == false` and `accept == true`: it still resolves settings!
        let mut lane = entry_with("lane", Some("parent"), "Lane", Some("lane-tpl"));
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
        assert_eq!(resolved.sources.len(), 6);
        assert!(resolved.settings.accept);
        assert!(!resolved.settings.auto_link);
        assert_eq!(resolved.settings.home, None);
        assert_eq!(resolved.settings.display, ChildDisplayMode::Island);
        assert_eq!(
            resolved.sources["home"],
            LevelSettingSource::Override { entry: eid("lane") }
        );
        assert_eq!(
            resolved.sources["accept"],
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
        // `parent`'s `accept` and `home` never inherit to `plain`.
        let plain = resolve_level_settings_with_sources(Some(&eid("plain")), &entries, &templates);
        assert!(!plain.settings.accept);
        assert_eq!(plain.settings.home, None);
        assert_eq!(plain.sources["accept"], LevelSettingSource::Default);
        assert_eq!(plain.sources["home"], LevelSettingSource::Default);
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
    fn autolink_follows_each_entrys_own_switch_with_trash_and_tie_breaking() {
        // A level whose new entries start linked: it no longer decides for
        // the entries already there (`kernel-v5.md` §16).
        let mut host_tpl = level_template("host-tpl", "Host", true);
        host_tpl.settings.auto_link = Some(true);
        let templates = BTreeMap::from([
            (host_tpl.id.clone(), host_tpl),
            (tid("leaf"), template("leaf", "Leaf")),
        ]);
        let on = |e: Entry| Entry {
            auto_link: true,
            ..e
        };
        let mut entries = BTreeMap::new();
        for e in [
            level_with("host", None, "Host", Some("host-tpl")),
            on(entry_with("a", Some("host"), "Same", Some("leaf"))),
            // Lives under a level that links, its own switch off: not linked.
            entry_with("b", Some("host"), "Same", Some("leaf")),
            // Lives outside any level that links, its own switch on: linked.
            on(entry_with("c", None, "Same", Some("leaf"))),
            on(entry_with("d", Some("host"), "Same", Some("leaf"))),
            on(entry_with("e", Some("a"), "Same", Some("leaf"))),
        ] {
            entries.insert(e.id.clone(), e);
        }
        entries.get_mut(&eid("d")).unwrap().deleted_at = Some(Timestamp(2));
        // The single-entry rule and the one-pass table agree.
        let eligible: Vec<_> = entries
            .values()
            .filter(|e| is_autolinked(e))
            .map(|e| e.id.clone())
            .collect();
        assert_eq!(eligible, vec![eid("a"), eid("c"), eid("e")]);
        let names = AutolinkNames::of(&entries, &templates);
        assert_eq!(names.linked().iter().cloned().collect::<Vec<_>>(), eligible);
        assert!(!names.is_linked(&eid("b")));
        assert_eq!(
            names.owners("same"),
            Some(&BTreeSet::from([eid("a"), eid("c"), eid("e")]))
        );
        let conflicts = resolve_autolink_name_conflicts(&mut entries, &templates);
        assert_eq!(
            conflicts,
            BTreeMap::from([(eid("c"), eid("a")), (eid("e"), eid("a"))])
        );
        assert_eq!(entries[&eid("b")].name_conflict, None);
        entries.get_mut(&eid("a")).unwrap().deleted_at = Some(Timestamp(3));
        let conflicts = resolve_autolink_name_conflicts(&mut entries, &templates);
        assert_eq!(conflicts, BTreeMap::from([(eid("e"), eid("c"))]));
        assert_eq!(entries[&eid("c")].name_conflict, None);
        // Memberships, moves and templates change nothing: only the switch.
        let mut moved = entries.clone();
        moved.get_mut(&eid("b")).unwrap().parent = None;
        moved.get_mut(&eid("c")).unwrap().parent = Some(eid("host"));
        moved.get_mut(&eid("c")).unwrap().template = None;
        assert_eq!(
            AutolinkNames::of(&moved, &templates).linked(),
            AutolinkNames::of(&entries, &templates).linked()
        );
    }

    #[test]
    fn a_new_entry_takes_the_default_of_the_nearest_level_that_sets_one_when_linkable() {
        let mut cat_tpl = level_template("tpl-cat", "分类", true);
        cat_tpl.settings.auto_link = Some(true);
        // A container keeps its own switch: not `linkable`.
        let group_tpl = level_template("tpl-group", "分组", false);
        let templates = BTreeMap::from([
            (tid("tpl-cat"), cat_tpl),
            (tid("tpl-group"), group_tpl),
            (tid("tpl-person"), aliases_template("tpl-person")),
        ]);
        let mut quiet = level_with("quiet", Some("grp"), "安静的一组", Some("tpl-group"));
        quiet.overrides = Some(LevelSettingsOverride {
            auto_link: Some(false),
            ..Default::default()
        });
        let entries = BTreeMap::from([
            (eid("cat"), level_with("cat", None, "人物", Some("tpl-cat"))),
            (
                eid("grp"),
                level_with("grp", Some("cat"), "主要人物", Some("tpl-group")),
            ),
            (eid("quiet"), quiet),
            (eid("ms"), level_with("ms", None, "书稿", None)),
        ]);
        let new = |parent: Option<&str>, tpl: Option<&str>| {
            new_entry_auto_link(
                parent.map(eid).as_ref(),
                tpl.map(tid).as_ref(),
                &entries,
                &templates,
            )
        };
        assert!(new(Some("cat"), Some("tpl-person")));
        // A group inside sets nothing: the category above decides.
        assert!(new(Some("grp"), Some("tpl-person")));
        assert!(new(Some("grp"), None), "no template counts as linkable");
        // A level that sets off decides for what is made in it.
        assert!(!new(Some("quiet"), Some("tpl-person")));
        // A container template does not follow the level.
        assert!(!new(Some("cat"), Some("tpl-group")));
        // A level that sets nothing, and the outermost level: off.
        assert!(!new(Some("ms"), Some("tpl-person")));
        assert!(!new(None, Some("tpl-person")));
        // A missing template counts as none.
        assert!(new(Some("cat"), Some("tpl-gone")));
    }

    #[test]
    fn a_levels_switch_carries_every_linkable_entry_living_below_it() {
        let templates = BTreeMap::from([
            (tid("tpl-cat"), level_template("tpl-cat", "分类", true)),
            (tid("tpl-group"), level_template("tpl-group", "分组", false)),
            (tid("tpl-person"), aliases_template("tpl-person")),
        ]);
        let mut gone = entry_with("gone", Some("cat"), "走了的人", Some("tpl-person"));
        gone.deleted_at = Some(Timestamp(9));
        let entries = BTreeMap::from([
            (eid("cat"), level_with("cat", None, "人物", Some("tpl-cat"))),
            (
                eid("grp"),
                level_with("grp", Some("cat"), "主要人物", Some("tpl-group")),
            ),
            (
                eid("a"),
                entry_with("a", Some("grp"), "林凯", Some("tpl-person")),
            ),
            (eid("b"), entry_with("b", Some("cat"), "沈青", None)),
            (eid("gone"), gone),
            (
                eid("outside"),
                entry_with("outside", None, "外人", Some("tpl-person")),
            ),
        ]);
        // What lives in the group is carried along; the group itself and the
        // entry in Recently Deleted keep their own switch.
        assert_eq!(
            below_auto_link_entries(&eid("cat"), &entries, &templates),
            vec![eid("a"), eid("b")]
        );
        assert_eq!(
            below_auto_link_entries(&eid("grp"), &entries, &templates),
            vec![eid("a")]
        );
        assert!(below_auto_link_entries(&eid("a"), &entries, &templates).is_empty());
    }

    #[test]
    fn what_a_link_shows_as_is_one_rule() {
        let entry = |live: bool, auto_link: bool| Some(LinkEntry { live, auto_link });
        // An automatic link follows its entry's switch and the setting.
        assert_eq!(link_show(false, entry(true, true), true), LinkShow::Live);
        assert_eq!(link_show(false, entry(true, false), true), LinkShow::Plain);
        assert_eq!(link_show(false, entry(true, true), false), LinkShow::Plain);
        // Gone stays gone while it would show, plain while it would not.
        assert_eq!(link_show(false, entry(false, true), true), LinkShow::Gone);
        assert_eq!(link_show(false, entry(false, false), true), LinkShow::Plain);
        assert_eq!(link_show(false, None, true), LinkShow::Gone);
        assert_eq!(link_show(false, None, false), LinkShow::Plain);
        // A link picked with @ shows whatever the switches say.
        for auto_links in [true, false] {
            for auto_link in [true, false] {
                assert_eq!(
                    link_show(true, entry(true, auto_link), auto_links),
                    LinkShow::Live
                );
                assert_eq!(
                    link_show(true, entry(false, auto_link), auto_links),
                    LinkShow::Gone
                );
            }
            assert_eq!(link_show(true, None, auto_links), LinkShow::Gone);
        }
        assert!(LinkShow::Gone.is_link() && !LinkShow::Plain.is_link());
        // The table of a book says the same.
        let mut off = entry_with("off", None, "关着的", None);
        off.auto_link = false;
        let mut on = entry_with("on", None, "开着的", None);
        on.auto_link = true;
        let table = LinkEntries::of([&off, &on]);
        assert_eq!(table.show("on", false, true), LinkShow::Live);
        assert_eq!(table.show("off", false, true), LinkShow::Plain);
        assert_eq!(table.show("off", true, true), LinkShow::Live);
        assert_eq!(table.show("nobody", false, true), LinkShow::Gone);
        assert!(table.is_live("off") && !table.is_live("nobody"));
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
            display: Some(ChildDisplayMode::Board),
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
                resolve_level_settings(Some(&eid("line")), entries, &templates).display,
                valid.len(),
                entries[&eid("ch")].effective_primary(&hosts).cloned(),
                effective_timeline_lanes(&view.lanes, entries, &templates).len(),
                effective_timeline_placements(&view, &memberships, entries, &templates).len(),
                // Belonging to `line` never links `ch`: only its own switch does.
                is_autolinked(&entries[&eid("ch")]),
            )
        };
        let on = read(&entries);
        assert_eq!(
            on,
            (ChildDisplayMode::Board, 1, Some(eid("line")), 1, 1, false)
        );

        // Turning `level` off keeps `overrides` intact AND leaves `accept`-backed
        // memberships, swimlanes, and placements active (`kernel-v5.md` §16).
        let stored = entries.clone();
        entries.get_mut(&eid("line")).unwrap().level = false;
        assert_eq!(read(&entries), on);
        assert!(is_in_any_view(
            &eid("line"),
            std::slice::from_ref(&view),
            &entries,
            &templates
        ));
        assert_eq!(
            entries[&eid("line")].overrides,
            stored[&eid("line")].overrides
        );
        assert_eq!(entries[&eid("ch")], stored[&eid("ch")]);

        // Turning both `level` and `accept` off hides below settings, memberships,
        // and lane status while keeping stored overrides and memberships intact.
        entries
            .get_mut(&eid("line"))
            .unwrap()
            .overrides
            .as_mut()
            .unwrap()
            .accept = Some(false);
        assert_eq!(
            read(&entries),
            (ChildDisplayMode::List, 0, None, 0, 0, false)
        );

        // Turning `accept` and `level` back on restores everything.
        entries
            .get_mut(&eid("line"))
            .unwrap()
            .overrides
            .as_mut()
            .unwrap()
            .accept = None;
        entries.get_mut(&eid("line")).unwrap().level = true;
        assert_eq!(read(&entries), on);
    }

    #[test]
    fn accept_off_hides_memberships_without_deleting_them() {
        let mut tpl_line = template("tpl-line", "故事线");
        tpl_line.linkable = false;
        tpl_line.settings.accept = Some(true);
        let templates = BTreeMap::from([
            (tid("tpl-line"), tpl_line),
            (tid("tpl-chapter"), template("tpl-chapter", "章")),
        ]);
        let line = entry_with("line", None, "主线", Some("tpl-line"));
        let mut ch = entry_with("ch", None, "第一章", Some("tpl-chapter"));
        ch.primary = Some(eid("line"));
        let mut entries = BTreeMap::from([(eid("line"), line), (eid("ch"), ch)]);
        let memberships = vec![membership("line", "ch")];
        let view = TimelineView {
            id: TimelineViewId::parse("v1").unwrap(),
            name: "主视图".into(),
            pos: None,
            lanes: vec![TimelineLane {
                entry: eid("line"),
                pos: None,
                act_track: None,
            }],
            placements: vec![TimelinePlacement {
                entry: eid("ch"),
                at: 2.0,
                span: None,
            }],
            pins: Vec::new(),
            deleted_at: None,
        };

        assert_eq!(
            filter_valid_memberships(&memberships, &entries, &templates).len(),
            1
        );
        assert_eq!(
            effective_timeline_placements(&view, &memberships, &entries, &templates).len(),
            1
        );

        // Turn `accept` off on `line`: memberships and lane placements read as
        // absent without mutating `memberships` or `view.placements`.
        entries.get_mut(&eid("line")).unwrap().overrides = Some(LevelSettingsOverride {
            accept: Some(false),
            ..Default::default()
        });
        assert!(filter_valid_memberships(&memberships, &entries, &templates).is_empty());
        assert!(effective_timeline_lanes(&view.lanes, &entries, &templates).is_empty());
        assert!(
            effective_timeline_placements(&view, &memberships, &entries, &templates).is_empty()
        );
        assert_eq!(memberships.len(), 1);
        assert_eq!(view.placements.len(), 1);

        // Turn `accept` back on: memberships and placements reappear immediately.
        entries.get_mut(&eid("line")).unwrap().overrides = None;
        assert_eq!(
            filter_valid_memberships(&memberships, &entries, &templates).len(),
            1
        );
        assert_eq!(
            effective_timeline_placements(&view, &memberships, &entries, &templates).len(),
            1
        );
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
            ModuleSpec::members(mid("mod-members"), "挂在这里的条目"),
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
        let mut tpl_storyline = template("tpl-storyline", "故事线");
        tpl_storyline.level = false;
        tpl_storyline.linkable = false;
        tpl_storyline.settings.accept = Some(true);
        tpl_storyline.settings.home = Some(Some(eid("ms")));

        let tpl_category = level_template("tpl-category", "分类", true);
        let tpl_folder = level_template("tpl-folder", "普通分组", false);
        let tpl_chapter = template("tpl-chapter", "章");
        let tpl_person = template("tpl-person", "人物");

        let templates = BTreeMap::from([
            (tid("tpl-storyline"), tpl_storyline),
            (tid("tpl-category"), tpl_category),
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
                entry_with("line-1", None, "主线", Some("tpl-storyline")),
            ),
            (
                eid("cat-1"),
                level_with("cat-1", None, "分类", Some("tpl-category")),
            ),
            (
                eid("sub-under-cat"),
                level_with(
                    "sub-under-cat",
                    Some("cat-1"),
                    "未写明分组",
                    Some("tpl-folder"),
                ),
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

        // `line-1` has `level == false` and `accept == true`: it accepts members
        // regardless of its `level` switch or the member's template.
        assert!(!entries[&eid("line-1")].is_level());
        assert!(check_membership(&eid("line-1"), &eid("ch-1"), &entries, &templates).is_ok());
        assert!(check_membership(&eid("line-1"), &eid("p-1"), &entries, &templates).is_ok());

        // Creating a new entry attached to `line-1` resolves its residence to `ms` (`home`).
        assert_eq!(
            resolve_new_entry_residence(Some(&eid("line-1")), &entries, &templates),
            Some(eid("ms"))
        );

        // `folder-1` and `sub-under-cat` do NOT accept entries from elsewhere
        // (`accept` never inherits from `cat-1`).
        for non_host in ["folder-1", "sub-under-cat"] {
            assert_eq!(
                check_membership(&eid(non_host), &eid("ch-1"), &entries, &templates)
                    .unwrap_err()
                    .invariant,
                "V3-MEMBERSHIP-RULES"
            );
        }

        // `ch-1` has `level == false` and `accept == false`, so it hosts nothing;
        // setting `overrides.accept = Some(true)` alone lets it host without `level = true`.
        assert_eq!(
            check_membership(&eid("ch-1"), &eid("p-1"), &entries, &templates)
                .unwrap_err()
                .invariant,
            "V3-MEMBERSHIP-RULES"
        );
        entries.get_mut(&eid("ch-1")).unwrap().overrides = Some(LevelSettingsOverride {
            accept: Some(true),
            ..Default::default()
        });
        assert!(check_membership(&eid("ch-1"), &eid("p-1"), &entries, &templates).is_ok());

        // `home` must be a live level: with `ms`'s switch off, `line-1` (`level == false`)
        // falls back to root (`None`), while `cat-1` (`level == true`) falls back to itself.
        entries.get_mut(&eid("ms")).unwrap().level = false;
        assert_eq!(
            resolve_new_entry_residence(Some(&eid("line-1")), &entries, &templates),
            None
        );
        assert_eq!(
            resolve_new_entry_residence(Some(&eid("cat-1")), &entries, &templates),
            Some(eid("cat-1"))
        );
    }

    #[test]
    fn v3_timeline_lanes_and_placements_require_lane_membership() {
        let mut tpl_storyline = template("tpl-storyline", "故事线");
        tpl_storyline.level = false;
        tpl_storyline.linkable = false;
        tpl_storyline.settings.accept = Some(true);
        let templates = BTreeMap::from([
            (tid("tpl-storyline"), tpl_storyline),
            (
                tid("tpl-folder"),
                level_template("tpl-folder", "文件夹", false),
            ),
            (tid("tpl-chapter"), template("tpl-chapter", "章")),
        ]);
        let mut entries = BTreeMap::from([
            (
                eid("line-1"),
                entry_with("line-1", None, "主线", Some("tpl-storyline")),
            ),
            (
                eid("line-2"),
                entry_with("line-2", None, "支线", Some("tpl-storyline")),
            ),
            (
                eid("folder"),
                level_with("folder", None, "书稿", Some("tpl-folder")),
            ),
            (
                eid("ch-1"),
                entry_with("ch-1", None, "第一章", Some("tpl-chapter")),
            ),
            (
                eid("ch-2"),
                entry_with("ch-2", None, "第二章", Some("tpl-chapter")),
            ),
            (
                eid("ch-res"),
                entry_with(
                    "ch-res",
                    Some("folder"),
                    "文件夹里的章",
                    Some("tpl-chapter"),
                ),
            ),
        ]);

        // A non-level `accept` entry (`line-1`) is a swimlane; a level folder
        // that takes no entries from elsewhere (`folder`) is not (DV,
        // 2026-11-16), nor is a leaf with neither switch (`ch-1`). The folder
        // with 「收别处的条目」 turned on is one.
        assert!(check_timeline_lane(&eid("line-1"), &entries, &templates).is_ok());
        assert_eq!(
            check_timeline_lane(&eid("folder"), &entries, &templates)
                .unwrap_err()
                .invariant,
            "V3-TIMELINE-LANE-ENABLED"
        );
        let mut both = entries.clone();
        both.get_mut(&eid("folder")).unwrap().overrides = Some(LevelSettingsOverride {
            accept: Some(true),
            ..Default::default()
        });
        assert!(check_timeline_lane(&eid("folder"), &both, &templates).is_ok());
        assert_eq!(
            check_timeline_lane(&eid("ch-1"), &entries, &templates)
                .unwrap_err()
                .invariant,
            "V3-TIMELINE-LANE-ENABLED"
        );
        // Turning `accept = false` on a non-level entry makes it ineligible as a swimlane.
        entries.get_mut(&eid("line-2")).unwrap().overrides = Some(LevelSettingsOverride {
            accept: Some(false),
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
                    entry: eid("folder"), // only a level: ignored on read, kept
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
                    entry: eid("ch-res"),
                    at: 15.0,
                    span: None,
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

        // `ch-1` belongs to `line-1` via membership; `ch-res` resides directly
        // under `folder`, which is no lane, so it is on no lane; `ch-2` is in
        // neither.
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
                &eid("ch-res"),
                &memberships,
                &entries,
                &templates
            )
            .unwrap_err()
            .invariant,
            "V3-TIMELINE-PLACEMENT-IN-LANE"
        );
        // Living under a lane is not being on it: with `folder` taking entries
        // from elsewhere, `ch-res` (only living under it) is still on no lane.
        assert!(
            check_timeline_placement_in_lane(
                &view,
                &eid("ch-res"),
                &memberships,
                &both,
                &templates
            )
            .is_err()
        );
        assert!(is_entry_in_lane(
            &eid("folder"),
            &eid("ch-res"),
            &[membership("folder", "ch-res")],
            &both,
            &templates
        ));
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

        // Read-side `effective_timeline_placements` returns `ch-1` only; the
        // stored lane and placement of `folder` and `ch-res` stay in `view`.
        let eff = effective_timeline_placements(&view, &memberships, &entries, &templates);
        assert_eq!(
            eff.iter().map(|p| p.entry.clone()).collect::<Vec<_>>(),
            vec![eid("ch-1")]
        );
        assert_eq!(
            effective_timeline_lanes(&view.lanes, &entries, &templates)
                .iter()
                .map(|l| l.entry.clone())
                .collect::<Vec<_>>(),
            vec![eid("line-1")]
        );
        assert!(view.lanes.iter().any(|l| l.entry == eid("folder")));
        assert!(view.placements.iter().any(|p| p.entry == eid("ch-res")));

        // When `ch-1` is removed from its last lane in `view`, its placement is pruned too.
        assert!(prune_placement_if_not_in_view_lanes(
            &mut view,
            &eid("ch-1"),
            &[],
            &entries,
            &templates
        ));
        assert!(view.placements.iter().all(|p| p.entry != eid("ch-1")));
        // `ch-2` is still hung on `line-1` here, so it is NOT pruned.
        assert!(!prune_placement_if_not_in_view_lanes(
            &mut view,
            &eid("ch-2"),
            &[membership("line-1", "ch-2")],
            &entries,
            &templates
        ));
    }

    /// DV2: the lanes a book clears once when it opens are the old lanes
    /// that are only a level: a live entry with its level on and
    /// 「收别处的条目」 off. Each of them is a lane the readers leave out
    /// (`V3-TIMELINE-LANE-ENABLED`); the other lanes the readers leave out
    /// (both switches off, in Recently Deleted or under an entry that is,
    /// gone) are not cleared, nor is any lane they show.
    #[test]
    fn a_level_only_lane_is_a_live_level_that_takes_nothing_from_elsewhere() {
        let mut tpl_storyline = template("tpl-storyline", "故事线");
        tpl_storyline.level = false;
        tpl_storyline.settings.accept = Some(true);
        let templates = BTreeMap::from([
            (tid("tpl-storyline"), tpl_storyline),
            (
                tid("tpl-folder"),
                level_template("tpl-folder", "文件夹", false),
            ),
        ]);
        let mut trashed = level_with("trashed", None, "旧卷", Some("tpl-folder"));
        trashed.deleted_at = Some(Timestamp(2000));
        let mut gone_above = level_with("gone-above", None, "上一层", Some("tpl-folder"));
        gone_above.deleted_at = Some(Timestamp(2000));
        let mut both = level_with("both", None, "幕", Some("tpl-folder"));
        both.overrides = Some(LevelSettingsOverride {
            accept: Some(true),
            ..Default::default()
        });
        let mut line_off = entry_with("line-off", None, "关掉的线", Some("tpl-storyline"));
        line_off.overrides = Some(LevelSettingsOverride {
            accept: Some(false),
            ..Default::default()
        });
        let mut line_level = level_with("line-level", None, "开了层级的线", Some("tpl-storyline"));
        line_level.overrides = Some(LevelSettingsOverride {
            accept: Some(false),
            ..Default::default()
        });
        let entries = BTreeMap::from([
            (
                eid("folder"),
                level_with("folder", None, "书稿", Some("tpl-folder")),
            ),
            (eid("trashed"), trashed),
            (eid("gone-above"), gone_above),
            (
                eid("under-gone"),
                level_with(
                    "under-gone",
                    Some("gone-above"),
                    "下一层",
                    Some("tpl-folder"),
                ),
            ),
            (eid("both"), both),
            (
                eid("line"),
                entry_with("line", None, "主线", Some("tpl-storyline")),
            ),
            (eid("line-off"), line_off),
            (eid("line-level"), line_level),
        ]);
        let level_only = |id: &str| is_level_only_lane(&eid(id), &entries, &templates);
        let hidden = |id: &str| check_timeline_lane(&eid(id), &entries, &templates).is_err();
        for id in ["folder", "line-level"] {
            assert!(level_only(id), "{id}");
            assert!(hidden(id), "{id}");
        }
        for id in ["trashed", "under-gone", "line-off", "missing"] {
            assert!(!level_only(id), "{id}");
            assert!(hidden(id), "{id}");
        }
        for id in ["both", "line"] {
            assert!(!level_only(id), "{id}");
            assert!(!hidden(id), "{id}");
        }
    }

    #[test]
    fn autolink_names_are_unique_among_the_entries_whose_own_switch_is_on() {
        let mut tpl_cat = level_template("tpl-cat", "分类", true);
        tpl_cat.settings.auto_link = Some(true);
        // A grouping template: not linkable, which vetoes nothing.
        let tpl_group = level_template("tpl-group", "分组", false);
        let templates = BTreeMap::from([
            (tid("tpl-cat"), tpl_cat),
            (tid("tpl-group"), tpl_group),
            (tid("tpl-person"), aliases_template("tpl-person")),
        ]);
        let on = |e: Entry| Entry {
            auto_link: true,
            ..e
        };

        // `e1` has entries under it (its `level` switch is on): it still links.
        let mut e1 = on(level_with("e1", Some("cat-1"), "林凯", Some("tpl-person")));
        e1.created_at = Some(Timestamp(1000));
        e1.fields.insert(
            mid("mod-fields"),
            BTreeMap::from([(
                "aliases".to_string(),
                FieldValue::List(vec!["凯哥".into(), "Captain Lin".into()]),
            )]),
        );
        let past = on(entry_with(
            "past",
            Some("e1"),
            "林凯的过去",
            Some("tpl-person"),
        ));
        let group = level_with("grp", Some("cat-1"), "主要人物", Some("tpl-group"));
        let before = BTreeMap::from([
            (
                eid("cat-1"),
                level_with("cat-1", None, "人物", Some("tpl-cat")),
            ),
            (eid("e1"), e1),
            (eid("past"), past),
            (eid("grp"), group),
        ]);
        let names = AutolinkNames::of(&before, &templates);
        assert!(names.is_linked(&eid("e1")));
        assert!(names.is_linked(&eid("past")));
        assert!(!names.is_linked(&eid("grp")));

        // `quiet` lives in the category with its own switch off: even with the
        // same name as `e1`'s alias it claims nothing until it is turned on.
        let mut with_quiet = before.clone();
        with_quiet.insert(
            eid("quiet"),
            entry_with("quiet", Some("cat-1"), "  CAPTAIN LIN ", Some("tpl-person")),
        );
        assert!(
            check_new_violations(graph(&before, &templates), graph(&with_quiet, &templates))
                .is_ok()
        );
        assert!(!AutolinkNames::of(&with_quiet, &templates).is_linked(&eid("quiet")));
        // Turning it on is refused (trimmed, case-insensitive).
        let mut quiet_on = with_quiet.clone();
        quiet_on.get_mut(&eid("quiet")).unwrap().auto_link = true;
        assert_eq!(
            check_new_violations(graph(&with_quiet, &templates), graph(&quiet_on, &templates))
                .unwrap_err()
                .invariant,
            "V3-AUTOLINK-NAME-UNIQUE"
        );

        // `e2` outside every level, its switch on, named like `e1`'s alias:
        // refused, wherever it lives.
        let mut after = before.clone();
        let mut e2 = on(entry_with("e2", None, "  CAPTAIN LIN ", Some("tpl-person")));
        e2.created_at = Some(Timestamp(2000));
        after.insert(eid("e2"), e2);
        assert_eq!(
            check_new_violations(graph(&before, &templates), graph(&after, &templates))
                .unwrap_err()
                .invariant,
            "V3-AUTOLINK-NAME-UNIQUE"
        );
        // A group named like a person claims nothing while its switch is off…
        let mut renamed = before.clone();
        renamed.get_mut(&eid("grp")).unwrap().title = "林凯".into();
        assert!(
            check_new_violations(graph(&before, &templates), graph(&renamed, &templates)).is_ok()
        );
        // …and claims its name once the author turns it on: `linkable` is no veto.
        let mut grp_on = renamed.clone();
        grp_on.get_mut(&eid("grp")).unwrap().auto_link = true;
        assert!(
            check_new_violations(graph(&renamed, &templates), graph(&grp_on, &templates)).is_err()
        );
        // A template's `linkable` changes no name.
        let mut linkable = templates.clone();
        linkable.get_mut(&tid("tpl-group")).unwrap().linkable = true;
        assert!(
            check_new_violations(graph(&renamed, &templates), graph(&renamed, &linkable)).is_ok()
        );

        // A merge brought `e2` in anyway: readers mark the later one.
        let mut merged = after.clone();
        let conflicts = resolve_autolink_name_conflicts(&mut merged, &templates);
        assert_eq!(conflicts.get(&eid("e2")), Some(&eid("e1")));
        assert_eq!(merged[&eid("e1")].name_conflict, None);
        assert_eq!(merged[&eid("e2")].name_conflict, Some(eid("e1")));
        // That old duplicate blocks no unrelated write...
        let mut unrelated = after.clone();
        unrelated.get_mut(&eid("past")).unwrap().title = "另一段过去".into();
        assert!(
            check_new_violations(graph(&after, &templates), graph(&unrelated, &templates)).is_ok()
        );
        // ...renaming one of the pair or turning it off resolves it.
        let mut resolved = after.clone();
        resolved.get_mut(&eid("e2")).unwrap().title = "林二".into();
        assert!(
            check_new_violations(graph(&after, &templates), graph(&resolved, &templates)).is_ok()
        );
        let mut off = after.clone();
        off.get_mut(&eid("e2")).unwrap().auto_link = false;
        assert!(check_new_violations(graph(&after, &templates), graph(&off, &templates)).is_ok());
        // A third entry joining the old duplicate is refused.
        let mut third = after.clone();
        third.insert(
            eid("e3"),
            on(entry_with(
                "e3",
                Some("cat-1"),
                "captain lin",
                Some("tpl-person"),
            )),
        );
        assert!(
            check_new_violations(graph(&after, &templates), graph(&third, &templates)).is_err()
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
    fn the_scale_ends_after_the_last_card_as_drawn_with_one_unit_of_air() {
        let p = |entry: &str, at: f64, span: Option<f64>| TimelinePlacement {
            entry: eid(entry),
            at,
            span,
        };
        assert_eq!(DEFAULT_PLACEMENT_SPAN, 4.0);
        assert_eq!(PLACEMENT_STEP, 5.0);
        // An empty scale starts at 0.
        assert_eq!(timeline_scale_end(&[]), 0.0);
        // A card without a span is drawn four units wide.
        assert_eq!(timeline_scale_end(&[p("a", 10.0, None)]), 15.0);
        // A stored span counts as it is, however short.
        assert_eq!(timeline_scale_end(&[p("a", 10.0, Some(2.5))]), 13.5);
        assert_eq!(timeline_scale_end(&[p("a", 10.0, Some(0.0))]), 11.0);
        // The card that ends last counts, not the one that starts last.
        assert_eq!(
            timeline_scale_end(&[p("a", 0.0, Some(30.0)), p("b", 20.0, None)]),
            31.0
        );
        assert_eq!(
            timeline_scale_end(&[p("a", 0.0, Some(3.0)), p("b", 20.0, None)]),
            25.0
        );
        // A coordinate that is not finite is not on the scale.
        assert_eq!(
            timeline_scale_end(&[p("a", f64::NAN, None), p("b", f64::INFINITY, None)]),
            0.0
        );
        assert_eq!(
            timeline_scale_end(&[p("a", f64::NEG_INFINITY, None), p("b", 2.0, None)]),
            7.0
        );
        // A span that is not finite or is negative is drawn as no span.
        for bad in [f64::NAN, f64::INFINITY, -3.0] {
            assert_eq!(timeline_scale_end(&[p("a", 2.0, Some(bad))]), 7.0, "{bad}");
        }
        // Entries placed there one step apart never overlap.
        let mut placements = vec![p("a", 1.0, None)];
        let start = timeline_scale_end(&placements);
        for (i, id) in ["b", "c", "d"].into_iter().enumerate() {
            placements.push(p(id, start + PLACEMENT_STEP * i as f64, None));
        }
        assert_eq!(
            placements.iter().map(|p| p.at).collect::<Vec<_>>(),
            [1.0, 6.0, 11.0, 16.0]
        );
        assert_eq!(timeline_scale_end(&placements), 21.0);
    }

    #[test]
    fn v5_flatten_starts_and_tab_mounts_validate_all_four_kinds() {
        let mut tpl_lane = template("tpl-lane", "故事线");
        tpl_lane.level = false;
        tpl_lane.linkable = false;
        tpl_lane.settings.accept = Some(true);
        let tpl_folder = level_template("tpl-folder", "文件夹", false);
        let templates =
            BTreeMap::from([(tid("tpl-lane"), tpl_lane), (tid("tpl-folder"), tpl_folder)]);

        let mut trashed_parent = level_with("trashed-folder", None, "旧卷", Some("tpl-folder"));
        trashed_parent.deleted_at = Some(Timestamp(10));
        let entries = BTreeMap::from([
            (
                eid("ms"),
                level_with("ms", None, "书稿", Some("tpl-folder")),
            ),
            (eid("leaf"), entry_with("leaf", Some("ms"), "甲", None)),
            // `lane-a` has `level == false` and `accept == true`!
            (
                eid("lane-a"),
                entry_with("lane-a", None, "主线", Some("tpl-lane")),
            ),
            (
                eid("lane-out"),
                entry_with("lane-out", None, "支线", Some("tpl-lane")),
            ),
            (eid("trashed-folder"), trashed_parent),
            (
                eid("nested-under-trash"),
                level_with(
                    "nested-under-trash",
                    Some("trashed-folder"),
                    "子夹",
                    Some("tpl-folder"),
                ),
            ),
        ]);

        let view_id = TimelineViewId::parse("v-main").unwrap();
        let views = BTreeMap::from([(
            view_id.clone(),
            TimelineView {
                id: view_id.clone(),
                name: "主刻度".into(),
                pos: None,
                lanes: vec![TimelineLane {
                    entry: eid("lane-a"),
                    pos: None,
                    act_track: None,
                }],
                placements: Vec::new(),
                pins: Vec::new(),
                deleted_at: None,
            },
        )]);

        let valid = |from: &FlattenFrom| is_valid_flatten_from(from, &entries, &templates, &views);
        assert!(valid(&FlattenFrom::Root));
        assert!(valid(&FlattenFrom::Entry { entry: eid("ms") }));
        // A non-level `accept` entry (`lane-a`) can be flattened from.
        assert!(valid(&FlattenFrom::Entry {
            entry: eid("lane-a")
        }));
        assert!(valid(&FlattenFrom::View {
            view: view_id.clone()
        }));
        assert!(valid(&FlattenFrom::Lane {
            view: view_id.clone(),
            entry: eid("lane-a")
        }));
        for bad in [
            FlattenFrom::Entry { entry: eid("leaf") },
            FlattenFrom::Entry {
                entry: eid("nested-under-trash"),
            },
            FlattenFrom::View {
                view: TimelineViewId::parse("v-gone").unwrap(),
            },
            FlattenFrom::Lane {
                view: view_id.clone(),
                entry: eid("lane-out"),
            },
        ] {
            assert!(!valid(&bad), "{bad:?}");
        }

        assert!(check_tab_mount(&TabMount::Root, false, &entries, &templates).is_ok());
        assert!(
            check_tab_mount(
                &TabMount::Entry { entry: eid("ms") },
                false,
                &entries,
                &templates,
            )
            .is_ok()
        );
        // Non-level `accept` entry (`lane-a`) is valid as `TabMount::Entry`!
        assert!(
            check_tab_mount(
                &TabMount::Entry {
                    entry: eid("lane-a")
                },
                false,
                &entries,
                &templates,
            )
            .is_ok()
        );
        // A Tab cannot mount a view, even one that is there (DV, 2026-11-16).
        assert!(views.contains_key(&view_id));
        assert_eq!(
            check_tab_mount(
                &TabMount::View {
                    view: view_id.clone()
                },
                false,
                &entries,
                &templates,
            )
            .unwrap_err()
            .invariant,
            "TAB-MOUNT-VALID"
        );
        assert!(check_tab_mount(&TabMount::Book, true, &entries, &templates).is_ok());
        assert_eq!(
            check_tab_mount(&TabMount::Book, false, &entries, &templates)
                .unwrap_err()
                .invariant,
            "TAB-MOUNT-VALID"
        );
        assert_eq!(
            check_tab_mount(
                &TabMount::Entry { entry: eid("leaf") },
                true,
                &entries,
                &templates,
            )
            .unwrap_err()
            .invariant,
            "TAB-MOUNT-VALID"
        );
    }

    fn tab(id: &str, pos: Option<&str>, mount: TabMount) -> ProjectTab {
        ProjectTab {
            id: TabId::parse(id).unwrap(),
            pos: pos.map(|p| PosKey::parse(p).unwrap()),
            mount,
            gone_title: None,
        }
    }

    #[test]
    fn shown_tabs_keep_the_first_of_each_mount_and_always_have_all_first() {
        let folder = || TabMount::Entry { entry: eid("ms") };
        // Two devices mounted the same folder: the first by `(pos, id)` stays.
        let shown = shown_project_tabs(vec![
            tab("t-b", Some("a1"), folder()),
            tab("t-a", Some("a1"), folder()),
            tab("t-view", Some("a0"), TabMount::Book),
        ]);
        let ids: Vec<&str> = shown.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, [ALL_TAB_ID, "t-view", "t-a"]);
        // 「全部」 is added before the first, at a position every device
        // computes the same from the same tabs.
        assert_eq!(shown[0].mount, TabMount::Root);
        assert!(shown[0].pos.as_ref().unwrap() < shown[1].pos.as_ref().unwrap());
        assert_eq!(
            shown,
            shown_project_tabs(vec![
                tab("t-view", Some("a0"), TabMount::Book),
                tab("t-a", Some("a1"), folder()),
                tab("t-b", Some("a1"), folder()),
            ])
        );
        // No tabs at all: 「全部」 alone.
        assert_eq!(
            shown_project_tabs(Vec::new()),
            vec![tab(ALL_TAB_ID, Some("a0"), TabMount::Root)]
        );
        // Tabs without a position sort last, so 「全部」 still comes first.
        let shown = shown_project_tabs(vec![tab("t-a", None, folder())]);
        assert_eq!(shown[0].id.as_str(), ALL_TAB_ID);
        // A root tab with another id is 「全部」: none is added. A second root
        // tab is left out like any repeat.
        let shown = shown_project_tabs(vec![
            tab("t-a", Some("a0"), folder()),
            tab("t-root", Some("a1"), TabMount::Root),
            tab(ALL_TAB_ID, Some("a2"), TabMount::Root),
        ]);
        let ids: Vec<&str> = shown.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["t-a", "t-root"]);
        // The fixed id on something other than the root is not shown.
        let shown = shown_project_tabs(vec![tab(ALL_TAB_ID, Some("a0"), folder())]);
        assert_eq!(shown, vec![tab(ALL_TAB_ID, Some("a0"), TabMount::Root)]);
    }

    #[test]
    fn a_mount_goes_on_one_tab_and_the_root_tab_stays() {
        let shown = shown_project_tabs(vec![tab(
            "t-a",
            Some("a1"),
            TabMount::Entry { entry: eid("ms") },
        )]);
        let refused =
            check_tab_mount_once(&shown, &TabMount::Entry { entry: eid("ms") }).unwrap_err();
        assert_eq!(refused.invariant, "TAB-MOUNT-ONCE");
        assert!(refused.detail.contains("t-a"), "{}", refused.detail);
        let refused = check_tab_mount_once(&shown, &TabMount::Root).unwrap_err();
        assert_eq!(refused.invariant, "TAB-MOUNT-ONCE");
        assert!(refused.detail.contains(ALL_TAB_ID), "{}", refused.detail);
        assert!(check_tab_mount_once(&shown, &TabMount::Book).is_ok());
        assert_eq!(
            check_tab_removable(&shown[0]).unwrap_err().invariant,
            "TAB-ROOT-ALWAYS"
        );
        assert!(check_tab_removable(&shown[1]).is_ok());
    }

    #[test]
    fn a_tab_with_an_old_name_reads_without_one() {
        let old = serde_json::json!({"id": "t-a", "name": "旧名字", "pos": "a0", "mount": {"kind": "root"}});
        let read: ProjectTab = serde_json::from_value(old).unwrap();
        assert_eq!(read, tab("t-a", Some("a0"), TabMount::Root));
        let written = serde_json::to_value(&read).unwrap();
        assert!(written.get("name").is_none(), "{written}");
        // A template's tabs too: `ProjectTemplate` reads them the same way.
        let pt: ProjectTemplate = serde_json::from_value(serde_json::json!({
            "project": {"tabs": [{"id": "t-a", "name": "旧名字", "mount": {"kind": "book"}}]}
        }))
        .unwrap();
        assert_eq!(pt.project.tabs, vec![tab("t-a", None, TabMount::Book)]);
    }

    #[test]
    fn fresh_template_ids_keep_the_fixed_id_of_all() {
        let pt = ProjectTemplate {
            project: ProjectDefinition {
                tabs: vec![
                    tab("seed-root", Some("a0"), TabMount::Root),
                    tab("seed-book", Some("a1"), TabMount::Book),
                ],
                ..Default::default()
            },
            ..Default::default()
        };
        let fresh = pt.with_fresh_ids();
        assert_eq!(fresh.project.tabs[0].id.as_str(), ALL_TAB_ID);
        assert!(crate::id::is_uuid_v7(fresh.project.tabs[1].id.as_str()));
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
            "created_at": null, "updated_at": null, "deleted_at": null
        }))
        .unwrap();
        assert!(!e.is_level());
        assert_eq!(e.mark, None);
        let c: ModuleConfig = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(c.in_book);
        assert_eq!(ModuleKind::parse("children"), ModuleKind::Children);
    }

    #[test]
    fn valid_marks_accept_sand_slugs_and_single_graphemes_only() {
        assert!(is_valid_mark("book"));
        assert!(is_valid_mark("sand-pen-1"));
        assert!(is_valid_mark("章"));
        assert!(is_valid_mark("A"));
        assert!(is_valid_mark("🌙"));
        assert!(is_valid_mark("👩‍🔬"));
        assert!(!is_valid_mark(""));
        assert!(!is_valid_mark(" "));
        assert!(!is_valid_mark("\n"));
        assert!(!is_valid_mark("章节"));
        assert!(!is_valid_mark("Book"));
        assert!(!is_valid_mark("-bad"));
        assert!(!is_valid_mark("bad-"));
    }
}
