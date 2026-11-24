//! Laying a look out, without a window: a module's box tree for one size and
//! a set of values in, the tree to draw out ([`Plan`]): every node with its
//! style resolved to the vocabulary's steps (§4 「风格甲」), every value node
//! with what it shows and where its value is kept, every list with its
//! items. Painting ([`crate::paint`]) only turns this into GPUI elements.
//!
//! What the format leaves out takes the prototype's defaults (2026-11-20
//! prototype, page 二): a box has no gap, padding, edge, ground or radius
//! and stretches its kids; a list's items follow each other down with no
//! gap; a value is sans, body size, ink 2; fixed words are mono, note size,
//! ink 4.

use dr_model::custom_module::values::ItemStep;
use dr_model::custom_module::{
    Align, Background, Block, BlockKind, Border, BoxDir, BoxNode, Column, Connector, Decoration,
    EachDir, Font, LookSize, ModuleValue, Node, Separator, Show, TextSize, Width,
};

use crate::values::{EntryName, Picture, Scope, Shown};

/// How many dots a number shown as dots has.
pub const DOTS: u8 = 5;

/// How many blocks an automatic 一行 shows (§4: 「取前几块积木的值」).
pub const AUTO_LINE_BLOCKS: usize = 3;

/// Words the layout itself writes, in the reader's language.
pub trait Words {
    /// A list's item count in an automatic 一行: 「3 个伏笔」, or 「伏笔: 3」
    /// in a language that cannot put the author's name straight after the
    /// number (CR).
    fn count_of(&self, count: usize, list: &str) -> String;
}

/// A look laid out for one size.
#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    pub size: LookSize,
    /// The module lays this size out itself; otherwise it follows 一块
    /// (一行: the first blocks in a row, 铺满: 一块 stretched).
    pub own: bool,
    pub root: PNode,
}

#[derive(Clone, Debug, PartialEq)]
pub enum PNode {
    Box(PBox),
    Each(PEach),
    Value(PValue),
    Text(PText),
    Mark(PMark),
}

/// Where a laid-out node comes from in the look's box tree (CM3, the
/// workbench picks a node by pressing it in the preview): the index of each
/// kid from the root down, an each node's item box being its kid `0`. Every
/// item of a list is laid out from the same item box, so they share it. An
/// automatic 一行's nodes (none of the module's own) have an empty one.
pub type NodePath = Vec<u16>;

/// 盒子.
#[derive(Clone, Debug, PartialEq)]
pub struct PBox {
    /// Where it is in the box tree ([`NodePath`]).
    pub node: NodePath,
    pub dir: BoxDir,
    pub gap: f32,
    pub pad: f32,
    pub align: Align,
    pub width: Width,
    pub border: Border,
    pub bg: Background,
    pub radius: f32,
    pub deco: Decoration,
    /// A grid's columns (a grid always has one or more).
    pub cols: Vec<Column>,
    pub nowrap: bool,
    pub max: Option<f32>,
    pub kids: Vec<PNode>,
}

/// 每一项: a list's items, each drawn with the same box.
#[derive(Clone, Debug, PartialEq)]
pub struct PEach {
    /// Where it is in the box tree ([`NodePath`]).
    pub node: NodePath,
    /// The list block, and its name.
    pub list: String,
    pub name: String,
    /// The items down to the scope that keeps the list (empty: the entry's
    /// own).
    pub path: Vec<ItemStep>,
    pub dir: EachDir,
    pub gap: f32,
    pub sep: Separator,
    pub link: Connector,
    pub items: Vec<PItem>,
}

/// One item of a list, laid out.
#[derive(Clone, Debug, PartialEq)]
pub struct PItem {
    /// The book's id for it (`None`: a sample's item).
    pub id: Option<String>,
    pub body: PBox,
}

/// 值: one block's value.
#[derive(Clone, Debug, PartialEq)]
pub struct PValue {
    /// Where it is in the box tree ([`NodePath`]).
    pub node: NodePath,
    pub block: String,
    pub name: String,
    pub kind: BlockKind,
    /// A select's or multi-select's options.
    pub options: Vec<String>,
    /// The items down to the scope that keeps the value (empty: the entry's
    /// own); a sample item's step has an empty item id.
    pub path: Vec<ItemStep>,
    pub show: Show,
    pub style: TextStyle,
    pub lines: Option<u8>,
    pub width: Width,
    pub suffix: Option<String>,
    pub content: Content,
}

/// 字: fixed words.
#[derive(Clone, Debug, PartialEq)]
pub struct PText {
    /// Where it is in the box tree ([`NodePath`]).
    pub node: NodePath,
    pub text: String,
    pub style: TextStyle,
    pub width: Width,
}

/// 记号: one of the seven sand marks (`MODULE_MARKS`).
#[derive(Clone, Debug, PartialEq)]
pub struct PMark {
    /// Where it is in the box tree ([`NodePath`]).
    pub node: NodePath,
    pub mark: String,
}

/// A text node's or value's type: one of the three faces, four sizes, four
/// inks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TextStyle {
    pub font: Font,
    pub size: TextSize,
    pub ink: u8,
}

/// A single-select shown as a mark (§4): the first option hollow, the last
/// full, those between half.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fill {
    Hollow,
    Half,
    Full,
}

/// What a value node shows.
#[derive(Clone, Debug, PartialEq)]
pub enum Content {
    /// The value as words (text, a date, a select's option, a number).
    Words(String),
    /// Nothing kept (or nothing this copy can read).
    Missing,
    /// A number as dots: `filled` of [`DOTS`].
    Dots {
        filled: u8,
        of: u8,
    },
    /// A select as a mark.
    Mark(Fill),
    /// A list as its number of items.
    Count(usize),
    /// A toggle: on or off, with the block's name.
    Toggle(bool),
    /// A multi-select's options.
    Choices(Vec<String>),
    Entries(Vec<EntryName>),
    Image(Picture),
}

/// `module` laid out at `size` with `values`.
pub fn plan(module: &ModuleValue, values: &Scope, size: LookSize, words: &dyn Words) -> Plan {
    let mut frames = vec![Frame {
        list: None,
        scope: values,
        path: Vec::new(),
    }];
    let own = module.look.own(size);
    let root = match (size, own) {
        (_, Some(tree)) => node(module, tree, &mut frames, Vec::new()),
        (LookSize::Line, None) => PNode::Box(auto_line(module, values, words)),
        (_, None) => {
            // 铺满 follows 一块, stretched across the column.
            let mut root = node(module, &module.look.block, &mut frames, Vec::new());
            if let PNode::Box(b) = &mut root {
                b.width = Width::Fill;
            }
            root
        }
    };
    Plan {
        size,
        own: own.is_some(),
        root,
    }
}

/// Where a node is: the scope it reads from, outermost first.
struct Frame<'a> {
    /// The list whose item this is (`None`: the entry's own values).
    list: Option<&'a str>,
    scope: &'a Scope,
    path: Vec<ItemStep>,
}

/// The innermost frame that keeps `block`'s value (the validator lets a
/// look draw a value only inside the items that keep it).
fn frame_of<'f, 'a>(module: &ModuleValue, frames: &'f [Frame<'a>], block: &str) -> &'f Frame<'a> {
    let scope = module.scope_of(block).flatten();
    frames
        .iter()
        .rev()
        .find(|f| f.list == scope)
        .unwrap_or(&frames[0])
}

fn node<'a>(
    module: &'a ModuleValue,
    n: &'a Node,
    frames: &mut Vec<Frame<'a>>,
    at: NodePath,
) -> PNode {
    match n {
        Node::Box(b) => PNode::Box(boxed(module, b, frames, at)),
        Node::Each(e) => {
            let block = module.block(&e.list);
            let (items, path): (&'a [crate::values::Item], Vec<ItemStep>) = {
                let frame = frame_of(module, frames, &e.list);
                let scope: &'a Scope = frame.scope;
                (
                    scope.lists.get(&e.list).map(Vec::as_slice).unwrap_or(&[]),
                    frame.path.clone(),
                )
            };
            let mut item_at = at.clone();
            item_at.push(0);
            let laid = items
                .iter()
                .map(|item| {
                    let mut steps = path.clone();
                    steps.push(ItemStep {
                        list: e.list.clone(),
                        item: item.id.clone().unwrap_or_default(),
                    });
                    frames.push(Frame {
                        list: Some(e.list.as_str()),
                        scope: &item.scope,
                        path: steps,
                    });
                    let body = boxed(module, &e.item, frames, item_at.clone());
                    frames.pop();
                    PItem {
                        id: item.id.clone(),
                        body,
                    }
                })
                .collect();
            PNode::Each(PEach {
                node: at,
                list: e.list.clone(),
                name: block.map(|b| b.name.clone()).unwrap_or_default(),
                path,
                dir: e.dir.unwrap_or(EachDir::Col),
                gap: f32::from(e.gap.unwrap_or(0)),
                sep: e.sep.unwrap_or(Separator::None),
                link: e.link.unwrap_or(Connector::None),
                items: laid,
            })
        }
        Node::Value(v) => {
            let Some(block) = module.block(&v.block) else {
                // The validator refuses this; drawn as nothing.
                return PNode::Text(PText {
                    node: at,
                    text: String::new(),
                    style: text_style(None, None, None),
                    width: Width::Auto,
                });
            };
            let frame = frame_of(module, frames, &v.block);
            let show = v.show.unwrap_or(match block.kind {
                BlockKind::List => Show::Count,
                _ => Show::Text,
            });
            PNode::Value(PValue {
                node: at,
                block: block.id.clone(),
                name: block.name.clone(),
                kind: block.kind,
                options: block.options.clone(),
                path: frame.path.clone(),
                show,
                style: value_style(v.font, v.size, v.ink),
                lines: v.lines,
                width: v.width.unwrap_or(Width::Auto),
                suffix: v.suffix.clone(),
                content: content(block, show, frame.scope),
            })
        }
        Node::Text(t) => PNode::Text(PText {
            node: at,
            text: t.text.clone(),
            style: text_style(t.font, t.size, t.ink),
            width: t.width.unwrap_or(Width::Auto),
        }),
        Node::Mark(m) => PNode::Mark(PMark {
            node: at,
            mark: m.mark.clone(),
        }),
    }
}

fn boxed<'a>(
    module: &'a ModuleValue,
    b: &'a BoxNode,
    frames: &mut Vec<Frame<'a>>,
    at: NodePath,
) -> PBox {
    PBox {
        dir: b.dir,
        gap: f32::from(b.gap.unwrap_or(0)),
        pad: f32::from(b.pad.unwrap_or(0)),
        align: b.align.unwrap_or(Align::Stretch),
        width: b.width.unwrap_or(Width::Auto),
        border: b.border.unwrap_or(Border::None),
        bg: b.bg.unwrap_or(Background::None),
        radius: f32::from(b.radius.unwrap_or(0)),
        deco: b.deco.unwrap_or(Decoration::None),
        cols: b.cols.clone(),
        nowrap: b.nowrap,
        max: b.max.map(f32::from),
        kids: b
            .kids
            .iter()
            .enumerate()
            .map(|(i, k)| {
                let mut kid = at.clone();
                kid.push(i as u16);
                node(module, k, frames, kid)
            })
            .collect(),
        node: at,
    }
}

fn value_style(font: Option<Font>, size: Option<TextSize>, ink: Option<u8>) -> TextStyle {
    TextStyle {
        font: font.unwrap_or(Font::Sans),
        size: size.unwrap_or(TextSize::Body),
        ink: ink.unwrap_or(2),
    }
}

fn text_style(font: Option<Font>, size: Option<TextSize>, ink: Option<u8>) -> TextStyle {
    TextStyle {
        font: font.unwrap_or(Font::Mono),
        size: size.unwrap_or(TextSize::Note),
        ink: ink.unwrap_or(4),
    }
}

/// A number as it is written: whole numbers without a point.
pub fn number_words(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

/// A select's option as a mark (§4).
pub fn fill_of(options: &[String], picked: &str) -> Option<Fill> {
    let i = options.iter().position(|o| o == picked)?;
    Some(if i == 0 {
        Fill::Hollow
    } else if i + 1 == options.len() {
        Fill::Full
    } else {
        Fill::Half
    })
}

fn content(block: &Block, show: Show, scope: &Scope) -> Content {
    if block.kind == BlockKind::List {
        return Content::Count(scope.lists.get(&block.id).map_or(0, Vec::len));
    }
    let value = scope.plain.get(&block.id);
    match (show, block.kind, value) {
        (Show::Dots, _, Some(Shown::Number(n))) => Content::Dots {
            filled: n.round().clamp(0.0, f64::from(DOTS)) as u8,
            of: DOTS,
        },
        (Show::Dots, _, _) => Content::Dots {
            filled: 0,
            of: DOTS,
        },
        (Show::Mark, _, Some(Shown::Text(s))) => match fill_of(&block.options, s) {
            Some(fill) => Content::Mark(fill),
            None => Content::Missing,
        },
        (_, BlockKind::Toggle, Some(Shown::Toggle(b))) => Content::Toggle(*b),
        (_, BlockKind::Toggle, None) => Content::Toggle(false),
        (_, _, None) => Content::Missing,
        (_, _, Some(Shown::Text(s))) if s.is_empty() => Content::Missing,
        (_, _, Some(Shown::Text(s))) => Content::Words(s.clone()),
        (_, _, Some(Shown::Number(n))) => Content::Words(number_words(*n)),
        (_, _, Some(Shown::Choices(xs))) if xs.is_empty() => Content::Missing,
        (_, _, Some(Shown::Choices(xs))) => Content::Choices(xs.clone()),
        (_, _, Some(Shown::Entries(xs))) if xs.is_empty() => Content::Missing,
        (_, _, Some(Shown::Entries(xs))) => Content::Entries(xs.clone()),
        (_, _, Some(Shown::Image(p))) => Content::Image(p.clone()),
        (_, _, Some(Shown::Toggle(b))) => Content::Toggle(*b),
    }
}

/// 一行 when the module has not laid it out (§4): the first blocks of the
/// entry's own in a row, a list as its count, images and groups left out.
fn auto_line(module: &ModuleValue, values: &Scope, words: &dyn Words) -> PBox {
    let kids = module
        .line_blocks(AUTO_LINE_BLOCKS)
        .into_iter()
        .map(|block| {
            let (style, lines, content) = if block.kind == BlockKind::List {
                let n = values.lists.get(&block.id).map_or(0, Vec::len);
                (
                    TextStyle {
                        font: Font::Mono,
                        size: TextSize::Note,
                        ink: 3,
                    },
                    None,
                    Content::Words(words.count_of(n, &block.name)),
                )
            } else {
                (
                    TextStyle {
                        font: Font::Sans,
                        size: TextSize::Small,
                        ink: 2,
                    },
                    Some(1),
                    content(block, Show::Text, values),
                )
            };
            PNode::Value(PValue {
                node: Vec::new(),
                block: block.id.clone(),
                name: block.name.clone(),
                kind: block.kind,
                options: block.options.clone(),
                path: Vec::new(),
                show: if block.kind == BlockKind::List {
                    Show::Count
                } else {
                    Show::Text
                },
                style,
                lines,
                width: Width::Auto,
                suffix: None,
                content,
            })
        })
        .collect();
    PBox {
        node: Vec::new(),
        dir: BoxDir::Row,
        gap: 8.0,
        pad: 0.0,
        align: Align::Center,
        width: Width::Auto,
        border: Border::None,
        bg: Background::None,
        radius: 0.0,
        deco: Decoration::None,
        cols: Vec::new(),
        nowrap: true,
        max: None,
        kids,
    }
}

impl PNode {
    /// This node and every node under it (a list's items included), depth
    /// first.
    pub fn walk(&self, f: &mut impl FnMut(&PNode)) {
        f(self);
        match self {
            PNode::Box(b) => b.kids.iter().for_each(|k| k.walk(f)),
            PNode::Each(e) => e
                .items
                .iter()
                .flat_map(|i| i.body.kids.iter())
                .for_each(|k| k.walk(f)),
            _ => {}
        }
    }

    /// Every value node, depth first.
    pub fn values(&self) -> Vec<&PValue> {
        let mut out = Vec::new();
        collect_values(self, &mut out);
        out
    }
}

fn collect_values<'a>(n: &'a PNode, out: &mut Vec<&'a PValue>) {
    match n {
        PNode::Box(b) => b.kids.iter().for_each(|k| collect_values(k, out)),
        PNode::Each(e) => e
            .items
            .iter()
            .flat_map(|i| i.body.kids.iter())
            .for_each(|k| collect_values(k, out)),
        PNode::Value(v) => out.push(v),
        _ => {}
    }
}
