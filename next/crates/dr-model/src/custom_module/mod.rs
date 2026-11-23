//! Custom entry modules: the closed data format, its one validator and the
//! values entries keep for them (`docs/rust-rewrite/custom-modules.md`).
//!
//! A module is data, never code: what it holds (blocks, §3), how it looks
//! (three box trees, §4), words for the Agent (§5) and one sample value
//! (§2). The same value is stored in a `module:<id>` library document
//! ("我的模块"), copied into a book's `modules` root, carried by project
//! templates and written to a `.driftingmodule` file; all of them go
//! through [`parse_module_json`] / [`validate_module_value`] (§12).
//!
//! Unlike the book document (which keeps unknown fields), the format is
//! closed: every struct rejects unknown keys, every enum unknown values,
//! every number outside its step table. [`to_canonical_json`] writes a value
//! the same way every time.
//!
//! Values an entry keeps for a module live in the book, keyed by block id
//! ([`values`]); a module's copy can be replaced without touching them.

mod validate;
pub mod values;

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub use validate::{
    ModuleError, is_block_id, module_name_hint, parse_module_json, to_canonical_json,
    validate_module_value,
};

/// Fixed `format` discriminator of a Drifting module.
pub const MODULE_FORMAT: &str = "drifting.module";

/// The `formatVersion` this build writes and reads (its own version, apart
/// from the project template's and the book's).
pub const MODULE_FORMAT_VERSION: i64 = 1;

/// Largest module, raw input and canonical output alike (256 KiB).
pub const MAX_MODULE_BYTES: usize = 256 * 1024;

/// Most blocks in one module, nested ones included.
pub const MAX_MODULE_BLOCKS: usize = 100;

/// Deepest nesting of lists (a list directly in the module is depth 1).
pub const MAX_MODULE_LIST_DEPTH: usize = 4;

/// Most nodes in the three box trees together.
pub const MAX_MODULE_LOOK_NODES: usize = 400;

/// Most characters (Unicode scalars) of words for the Agent in one module.
pub const MAX_MODULE_AGENT_CHARS: usize = 20_000;

/// Longest block id: ASCII letters, digits, `_` and `-`.
pub const MAX_BLOCK_ID_LEN: usize = 32;

/// Longest fixed text in a look (a text node), in characters.
pub const MAX_LOOK_TEXT_CHARS: usize = 200;

/// Longest text after a value (a value node's `suffix`), in characters.
pub const MAX_SUFFIX_CHARS: usize = 40;

/// Most lines a value node may cap its text at.
pub const MAX_VALUE_LINES: u8 = 10;

/// Most columns of a grid box.
pub const MAX_GRID_COLUMNS: usize = 12;

/// Gaps and paddings (§4 "间距、内边距").
pub const SPACING_STEPS: [u8; 6] = [0, 4, 8, 12, 16, 24];

/// Corner radii (§4 "圆角").
pub const RADIUS_STEPS: [u8; 4] = [0, 2, 4, 8];

/// Fixed widths (a grid column, a box's `max`): 48 to 320, every 8.
pub const WIDTH_STEP_MIN: u16 = 48;
pub const WIDTH_STEP_MAX: u16 = 320;
pub const WIDTH_STEP: u16 = 8;

/// The App's ink levels (§4 "墨色", one to four).
pub const INK_LEVELS: std::ops::RangeInclusive<u8> = 1..=4;

/// The sand marks a mark node may draw (dr-ui's seven, the mark picker's).
pub const MODULE_MARKS: [&str; 7] = [
    "file-text",
    "square",
    "compass",
    "folder",
    "lightbulb",
    "git-branch",
    "book",
];

/// Whether `n` is one of the fixed width steps.
pub fn is_width_step(n: u16) -> bool {
    (WIDTH_STEP_MIN..=WIDTH_STEP_MAX).contains(&n) && (n - WIDTH_STEP_MIN) % WIDTH_STEP == 0
}

/// Attribution: the exporter's account name only (as a project template's).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModuleCredit {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub author: String,
}

impl ModuleCredit {
    pub fn is_empty(&self) -> bool {
        self.author.is_empty()
    }
}

/// One module (§6): the value stored in my modules, in a book's copy, in a
/// project template and in a `.driftingmodule` file.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModuleValue {
    pub format: String,
    #[serde(rename = "formatVersion")]
    pub format_version: i64,
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub locale: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credit: Option<ModuleCredit>,
    #[serde(default)]
    pub blocks: Vec<Block>,
    pub look: Look,
    #[serde(default, skip_serializing_if = "ModuleAgent::is_empty")]
    pub agent: ModuleAgent,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub sample: BTreeMap<String, SampleValue>,
}

/// A block's kind (§3). `group` keeps no value; `list` keeps items.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockKind {
    /// 一行字: one line of plain text.
    Text,
    /// 一段字: plain text on several lines (not prose).
    LongText,
    /// 数字: a finite real number.
    Number,
    /// 日期: `YYYY-MM-DD`.
    Date,
    /// 单选: one of the options.
    Select,
    /// 多选: some of the options.
    MultiSelect,
    /// 勾选: on or off.
    Toggle,
    /// 条目: one or more entries of the project (any template).
    Entry,
    /// 图片: one file of the asset library.
    Image,
    /// 一组: holds blocks, keeps no value of its own.
    Group,
    /// 一串: items, each holding the same blocks.
    List,
}

impl BlockKind {
    pub const ALL: [BlockKind; 11] = [
        BlockKind::Text,
        BlockKind::LongText,
        BlockKind::Number,
        BlockKind::Date,
        BlockKind::Select,
        BlockKind::MultiSelect,
        BlockKind::Toggle,
        BlockKind::Entry,
        BlockKind::Image,
        BlockKind::Group,
        BlockKind::List,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            BlockKind::Text => "text",
            BlockKind::LongText => "long_text",
            BlockKind::Number => "number",
            BlockKind::Date => "date",
            BlockKind::Select => "select",
            BlockKind::MultiSelect => "multi_select",
            BlockKind::Toggle => "toggle",
            BlockKind::Entry => "entry",
            BlockKind::Image => "image",
            BlockKind::Group => "group",
            BlockKind::List => "list",
        }
    }

    /// `group` and `list` hold other blocks.
    pub fn holds_blocks(self) -> bool {
        matches!(self, BlockKind::Group | BlockKind::List)
    }

    /// `select` and `multi_select` have options.
    pub fn has_options(self) -> bool {
        matches!(self, BlockKind::Select | BlockKind::MultiSelect)
    }
}

/// One block (§3). Its id never changes when it is renamed, moved or put
/// into a group: an entry's values are kept by it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Block {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: BlockKind,
    pub name: String,
    /// `select` and `multi_select` only.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
    /// `group` and `list` only.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blocks: Vec<Block>,
}

/// The three sizes a module is drawn at (§4).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LookSize {
    /// 一行: one row in an entry's hover card.
    Line,
    /// 一块: the module on the entry page. Always has its own tree.
    Block,
    /// 铺满: the module filling the middle column.
    Full,
}

/// How the module looks (§4): `block` is required; `line` and `full` follow
/// it while they are absent.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Look {
    pub block: Node,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<Node>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full: Option<Node>,
}

impl Look {
    /// The tree laid out on its own for `size` (`None`: it follows 一块;
    /// for 一行 that means the first blocks' values joined in a row, for 铺满
    /// 一块 stretched).
    pub fn own(&self, size: LookSize) -> Option<&Node> {
        match size {
            LookSize::Block => Some(&self.block),
            LookSize::Line => self.line.as_ref(),
            LookSize::Full => self.full.as_ref(),
        }
    }

    /// Every tree the look has, with its size.
    pub fn trees(&self) -> impl Iterator<Item = (LookSize, &Node)> {
        [
            Some((LookSize::Block, &self.block)),
            self.line.as_ref().map(|n| (LookSize::Line, n)),
            self.full.as_ref().map(|n| (LookSize::Full, n)),
        ]
        .into_iter()
        .flatten()
    }
}

macro_rules! closed_enum {
    ($(#[$meta:meta])* $name:ident { $($(#[$vmeta:meta])* $var:ident = $s:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum $name {
            $($(#[$vmeta])* #[serde(rename = $s)] $var,)+
        }
        impl $name {
            pub fn as_str(self) -> &'static str {
                match self { $($name::$var => $s,)+ }
            }
        }
    };
}

closed_enum!(
    /// How a box lays out its kids: 竖、横、格.
    BoxDir { Col = "col", Row = "row", Grid = "grid" }
);
closed_enum!(
    /// How a list's items follow each other.
    EachDir { Col = "col", Row = "row" }
);
closed_enum!(
    /// 对齐: 起、中、末、撑.
    Align { Start = "start", Center = "center", End = "end", Stretch = "stretch" }
);
closed_enum!(
    /// 宽: 自动、随内容、填满.
    Width { Auto = "auto", Hug = "hug", Fill = "fill" }
);
closed_enum!(
    /// 边: 无、发丝线、玻璃线、砂笔框.
    Border { None = "none", Hair = "hair", Glass = "glass", Sand = "sand" }
);
closed_enum!(
    /// 底: 无、稿纸、淡墨.
    Background { None = "none", Paper = "paper", Wash = "wash" }
);
closed_enum!(
    /// 装饰: 无、弧线 (one sand arc).
    Decoration { None = "none", Arc = "arc" }
);
closed_enum!(
    /// Between a list's items: 无、线、轴.
    Separator { None = "none", Hair = "hair", Axis = "axis" }
);
closed_enum!(
    /// 连接: 无、箭头.
    Connector { None = "none", Arrow = "arrow" }
);
closed_enum!(
    /// 显示成: as text, a number as dots, a select as a mark, a list as its
    /// count (counted when drawn, never stored).
    Show { Text = "text", Dots = "dots", Mark = "mark", Count = "count" }
);
closed_enum!(
    /// The App's three faces.
    Font { Serif = "serif", Sans = "sans", Mono = "mono" }
);
closed_enum!(
    /// 大小: 标题、正文、小、注.
    TextSize { Title = "title", Body = "body", Small = "small", Note = "note" }
);
closed_enum!(
    /// A grid column that fills what is left.
    ColumnFill { Fill = "fill" }
);

/// A grid column's width: `"fill"` or one of the width steps.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Column {
    Fixed(u16),
    Fill(ColumnFill),
}

/// 盒子: holds other nodes.
#[derive(Clone, Debug, PartialEq)]
pub struct BoxNode {
    pub dir: BoxDir,
    pub gap: Option<u8>,
    pub pad: Option<u8>,
    pub align: Option<Align>,
    pub width: Option<Width>,
    pub border: Option<Border>,
    pub bg: Option<Background>,
    pub radius: Option<u8>,
    pub deco: Option<Decoration>,
    /// A grid's columns.
    pub cols: Vec<Column>,
    /// 不换行.
    pub nowrap: bool,
    /// 最宽: one of the width steps.
    pub max: Option<u16>,
    pub kids: Vec<Node>,
}

impl BoxNode {
    /// An empty box laid out `dir`.
    pub fn new(dir: BoxDir) -> Self {
        BoxNode {
            dir,
            gap: None,
            pad: None,
            align: None,
            width: None,
            border: None,
            bg: None,
            radius: None,
            deco: None,
            cols: Vec::new(),
            nowrap: false,
            max: None,
            kids: Vec::new(),
        }
    }
}

/// 每一项: draws each item of a list with `item`.
#[derive(Clone, Debug, PartialEq)]
pub struct EachNode {
    /// The list block.
    pub list: String,
    pub dir: Option<EachDir>,
    pub gap: Option<u8>,
    pub sep: Option<Separator>,
    pub link: Option<Connector>,
    pub item: Box<BoxNode>,
}

/// 值: draws one block's value.
#[derive(Clone, Debug, PartialEq)]
pub struct ValueNode {
    pub block: String,
    pub show: Option<Show>,
    pub font: Option<Font>,
    pub size: Option<TextSize>,
    pub ink: Option<u8>,
    pub lines: Option<u8>,
    pub width: Option<Width>,
    /// Fixed words drawn right after the value (`" 处伏笔"` after a count).
    pub suffix: Option<String>,
}

/// 字: fixed words.
#[derive(Clone, Debug, PartialEq)]
pub struct TextNode {
    pub text: String,
    pub font: Option<Font>,
    pub size: Option<TextSize>,
    pub ink: Option<u8>,
    pub width: Option<Width>,
}

/// 记号: one sand mark ([`MODULE_MARKS`]).
#[derive(Clone, Debug, PartialEq)]
pub struct MarkNode {
    pub mark: String,
}

/// One node of a box tree (§4). Written as a JSON object whose first key
/// says which node it is (`box`, `each`, `value`, `text`, `mark`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "RawNode", into = "RawNode")]
pub enum Node {
    Box(BoxNode),
    Each(EachNode),
    Value(ValueNode),
    Text(TextNode),
    Mark(MarkNode),
}

impl Node {
    /// This node and every node under it, depth first (an each node's item
    /// box is not a node of its own here: its kids are).
    pub fn walk(&self, f: &mut impl FnMut(&Node)) {
        f(self);
        match self {
            Node::Box(b) => b.kids.iter().for_each(|k| k.walk(f)),
            Node::Each(e) => e.item.kids.iter().for_each(|k| k.walk(f)),
            _ => {}
        }
    }

    /// How many nodes this tree has.
    pub fn count(&self) -> usize {
        match self {
            Node::Box(b) => 1 + b.kids.iter().map(Node::count).sum::<usize>(),
            Node::Each(e) => 1 + 1 + e.item.kids.iter().map(Node::count).sum::<usize>(),
            _ => 1,
        }
    }
}

/// The JSON shape of a node: every key any node may have, closed.
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawNode {
    #[serde(rename = "box", default, skip_serializing_if = "Option::is_none")]
    boxed: Option<BoxDir>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    each: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mark: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    dir: Option<EachDir>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    show: Option<Show>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    font: Option<Font>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    size: Option<TextSize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ink: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    lines: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    gap: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pad: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    align: Option<Align>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    width: Option<Width>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    border: Option<Border>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bg: Option<Background>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    radius: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    deco: Option<Decoration>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cols: Option<Vec<Column>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    nowrap: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    max: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sep: Option<Separator>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    link: Option<Connector>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    suffix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    item: Option<Box<Node>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    kids: Option<Vec<Node>>,
}

impl RawNode {
    /// The keys present, by name, for the "only these keys" check.
    fn present(&self) -> Vec<&'static str> {
        let mut out = Vec::new();
        macro_rules! has {
            ($($field:ident => $key:literal),+) => {
                $(if self.$field.is_some() { out.push($key); })+
            };
        }
        has!(
            boxed => "box", each => "each", value => "value", text => "text", mark => "mark",
            dir => "dir", show => "show", font => "font", size => "size", ink => "ink",
            lines => "lines", gap => "gap", pad => "pad", align => "align", width => "width",
            border => "border", bg => "bg", radius => "radius", deco => "deco", cols => "cols",
            nowrap => "nowrap", max => "max", sep => "sep", link => "link", suffix => "suffix",
            item => "item", kids => "kids"
        );
        out
    }
}

impl TryFrom<RawNode> for Node {
    type Error = String;

    fn try_from(raw: RawNode) -> Result<Self, String> {
        let present = raw.present();
        let kinds: Vec<&str> = present
            .iter()
            .copied()
            .filter(|k| matches!(*k, "box" | "each" | "value" | "text" | "mark"))
            .collect();
        let kind = match kinds.as_slice() {
            [one] => *one,
            [] => return Err("a node needs one of box, each, value, text or mark".into()),
            _ => return Err(format!("a node is one thing, not {}", kinds.join(" and "))),
        };
        let allowed: &[&str] = match kind {
            "box" => &[
                "box", "gap", "pad", "align", "width", "border", "bg", "radius", "deco", "cols",
                "nowrap", "max", "kids",
            ],
            "each" => &["each", "dir", "gap", "sep", "link", "item"],
            "value" => &[
                "value", "show", "font", "size", "ink", "lines", "width", "suffix",
            ],
            "text" => &["text", "font", "size", "ink", "width"],
            _ => &["mark"],
        };
        if let Some(bad) = present.iter().find(|k| !allowed.contains(k)) {
            return Err(format!("a {kind} node has no {bad:?}"));
        }
        Ok(match kind {
            "box" => Node::Box(BoxNode {
                dir: raw.boxed.expect("present"),
                gap: raw.gap,
                pad: raw.pad,
                align: raw.align,
                width: raw.width,
                border: raw.border,
                bg: raw.bg,
                radius: raw.radius,
                deco: raw.deco,
                cols: raw.cols.unwrap_or_default(),
                nowrap: raw.nowrap.unwrap_or(false),
                max: raw.max,
                kids: raw.kids.unwrap_or_default(),
            }),
            "each" => {
                let item = match raw.item.map(|b| *b) {
                    Some(Node::Box(b)) => b,
                    Some(_) => return Err("an each node's item is a box".into()),
                    None => return Err("an each node needs its item (a box)".into()),
                };
                Node::Each(EachNode {
                    list: raw.each.expect("present"),
                    dir: raw.dir,
                    gap: raw.gap,
                    sep: raw.sep,
                    link: raw.link,
                    item: Box::new(item),
                })
            }
            "value" => Node::Value(ValueNode {
                block: raw.value.expect("present"),
                show: raw.show,
                font: raw.font,
                size: raw.size,
                ink: raw.ink,
                lines: raw.lines,
                width: raw.width,
                suffix: raw.suffix,
            }),
            "text" => Node::Text(TextNode {
                text: raw.text.expect("present"),
                font: raw.font,
                size: raw.size,
                ink: raw.ink,
                width: raw.width,
            }),
            _ => Node::Mark(MarkNode {
                mark: raw.mark.expect("present"),
            }),
        })
    }
}

impl From<Node> for RawNode {
    fn from(node: Node) -> RawNode {
        match node {
            Node::Box(b) => RawNode {
                boxed: Some(b.dir),
                gap: b.gap,
                pad: b.pad,
                align: b.align,
                width: b.width,
                border: b.border,
                bg: b.bg,
                radius: b.radius,
                deco: b.deco,
                cols: (!b.cols.is_empty()).then_some(b.cols),
                nowrap: b.nowrap.then_some(true),
                max: b.max,
                kids: (!b.kids.is_empty()).then_some(b.kids),
                ..RawNode::default()
            },
            Node::Each(e) => RawNode {
                each: Some(e.list),
                dir: e.dir,
                gap: e.gap,
                sep: e.sep,
                link: e.link,
                item: Some(Box::new(Node::Box(*e.item))),
                ..RawNode::default()
            },
            Node::Value(v) => RawNode {
                value: Some(v.block),
                show: v.show,
                font: v.font,
                size: v.size,
                ink: v.ink,
                lines: v.lines,
                width: v.width,
                suffix: v.suffix,
                ..RawNode::default()
            },
            Node::Text(t) => RawNode {
                text: Some(t.text),
                font: t.font,
                size: t.size,
                ink: t.ink,
                width: t.width,
                ..RawNode::default()
            },
            Node::Mark(m) => RawNode {
                mark: Some(m.mark),
                ..RawNode::default()
            },
        }
    }
}

/// Words for the Agent (§5): the same shape as an entry template's, plus one
/// sentence for each block (`blocks`, by block id).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModuleAgent {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub instructions: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub blocks: BTreeMap<String, String>,
}

impl ModuleAgent {
    pub fn is_empty(&self) -> bool {
        self.name.is_empty()
            && self.description.is_empty()
            && self.instructions.is_empty()
            && self.blocks.is_empty()
    }

    /// Unicode scalars of every word for the Agent.
    pub fn chars(&self) -> usize {
        self.name.chars().count()
            + self.description.chars().count()
            + self.instructions.chars().count()
            + self
                .blocks
                .values()
                .map(|s| s.chars().count())
                .sum::<usize>()
    }
}

/// One sample value (§2, §6): a block's value in the workbench's preview and
/// when browsing. An entry block's sample is a few words (never an entry),
/// and there is no sample image (a module carries no files).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SampleValue {
    Bool(bool),
    Number(f64),
    Text(String),
    Texts(Vec<String>),
    Items(Vec<BTreeMap<String, SampleValue>>),
}

impl ModuleValue {
    /// A new module with nothing in it yet: no blocks, an empty column for
    /// 一块 (the workbench's 「新建模块…」 starts here).
    pub fn empty(name: &str) -> Self {
        ModuleValue {
            format: MODULE_FORMAT.to_owned(),
            format_version: MODULE_FORMAT_VERSION,
            name: name.trim().to_owned(),
            locale: String::new(),
            credit: None,
            blocks: Vec::new(),
            look: Look {
                block: Node::Box(BoxNode::new(BoxDir::Col)),
                line: None,
                full: None,
            },
            agent: ModuleAgent::default(),
            sample: BTreeMap::new(),
        }
    }

    /// Every block, depth first, with the list whose items keep its value
    /// (`None`: the entry keeps it directly).
    pub fn blocks_with_scope(&self) -> Vec<(&Block, Option<&str>)> {
        fn walk<'a>(
            blocks: &'a [Block],
            scope: Option<&'a str>,
            out: &mut Vec<(&'a Block, Option<&'a str>)>,
        ) {
            for b in blocks {
                out.push((b, scope));
                match b.kind {
                    BlockKind::Group => walk(&b.blocks, scope, out),
                    BlockKind::List => walk(&b.blocks, Some(b.id.as_str()), out),
                    _ => {}
                }
            }
        }
        let mut out = Vec::new();
        walk(&self.blocks, None, &mut out);
        out
    }

    /// The block `id`, wherever it is.
    pub fn block(&self, id: &str) -> Option<&Block> {
        self.blocks_with_scope()
            .into_iter()
            .find(|(b, _)| b.id == id)
            .map(|(b, _)| b)
    }

    /// The list whose items keep `id`'s value: `Some(None)` for a block the
    /// entry keeps directly, `None` for a block the module does not have. A
    /// list block's own items live in the scope it is in.
    pub fn scope_of(&self, id: &str) -> Option<Option<&str>> {
        self.blocks_with_scope()
            .into_iter()
            .find(|(b, _)| b.id == id)
            .map(|(_, s)| s)
    }

    /// The lists from the entry down to the scope `id`'s value is kept in,
    /// outermost first (empty for a block the entry keeps directly).
    pub fn list_chain(&self, id: &str) -> Option<Vec<&str>> {
        let mut chain = Vec::new();
        let mut at = self.scope_of(id)?;
        while let Some(list) = at {
            chain.push(list);
            at = self.scope_of(list)?;
        }
        chain.reverse();
        Some(chain)
    }

    /// The blocks whose values a scope keeps (`None`: the entry's own; a
    /// list's id: each of its items), groups looked through, a nested list
    /// itself included but not what it holds.
    pub fn scope_blocks(&self, scope: Option<&str>) -> Vec<&Block> {
        self.blocks_with_scope()
            .into_iter()
            .filter(|(b, s)| *s == scope && b.kind != BlockKind::Group)
            .map(|(b, _)| b)
            .collect()
    }

    /// The first `n` blocks an automatic 一行 shows (§4: a list as its count,
    /// images and groups left out), entry's own scope only.
    pub fn line_blocks(&self, n: usize) -> Vec<&Block> {
        self.scope_blocks(None)
            .into_iter()
            .filter(|b| b.kind != BlockKind::Image)
            .take(n)
            .collect()
    }
}
