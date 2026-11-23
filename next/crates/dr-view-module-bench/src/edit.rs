//! What the workbench does to a module, without a window: every change is
//! a new whole value (my modules are replaced whole, `custom-modules.md`
//! §7), checked by the one validator before it is written. Nothing here
//! touches the values entries keep: a block keeps its id when it is
//! renamed or moved, so they stay where they are (§3, §7 「值不丢」).
//!
//! A change that would leave the look drawing what it can no longer draw
//! (a block taken away, moved out of the list whose items keep it) is
//! [`repair`]ed in the same step: those nodes go, and with them a box that
//! only labelled the value; the sample and the words for the Agent forget
//! what the module no longer keeps. The validator still has the last word.

use std::collections::BTreeMap;

use dr_model::custom_module::{
    Align, Background, Block, BlockKind, Border, BoxDir, BoxNode, Column, ColumnFill, Connector,
    Decoration, EachDir, EachNode, Font, LookSize, ModuleValue, Node, SampleValue, Separator, Show,
    TextNode, TextSize, ValueNode, Width, is_block_id, validate_module_value,
};

/// Where a node is in one of the look's box trees: the index of each kid
/// from the root down, an each node's item box being its kid `0`.
pub type NodePath = Vec<u16>;

/// The tree a size is laid out with, when it has one of its own (一块
/// always has).
pub fn tree(value: &ModuleValue, size: LookSize) -> Option<&Node> {
    value.look.own(size)
}

fn tree_mut(value: &mut ModuleValue, size: LookSize) -> Option<&mut Node> {
    match size {
        LookSize::Block => Some(&mut value.look.block),
        LookSize::Line => value.look.line.as_mut(),
        LookSize::Full => value.look.full.as_mut(),
    }
}

/// A node of a tree, or an each node's item box.
#[derive(Clone, Copy, Debug)]
pub enum Spot<'a> {
    Node(&'a Node),
    Item(&'a BoxNode),
}

enum SpotMut<'a> {
    Node(&'a mut Node),
    Item(&'a mut BoxNode),
}

/// What is at `path` in `root`.
pub fn spot<'a>(root: &'a Node, path: &[u16]) -> Option<Spot<'a>> {
    let Some((&first, rest)) = path.split_first() else {
        return Some(Spot::Node(root));
    };
    match root {
        Node::Box(b) => spot(b.kids.get(usize::from(first))?, rest),
        Node::Each(e) if first == 0 => item_spot(&e.item, rest),
        _ => None,
    }
}

fn item_spot<'a>(b: &'a BoxNode, path: &[u16]) -> Option<Spot<'a>> {
    let Some((&first, rest)) = path.split_first() else {
        return Some(Spot::Item(b));
    };
    spot(b.kids.get(usize::from(first))?, rest)
}

fn spot_mut<'a>(root: &'a mut Node, path: &[u16]) -> Option<SpotMut<'a>> {
    let Some((&first, rest)) = path.split_first() else {
        return Some(SpotMut::Node(root));
    };
    match root {
        Node::Box(b) => spot_mut(b.kids.get_mut(usize::from(first))?, rest),
        Node::Each(e) if first == 0 => item_spot_mut(&mut e.item, rest),
        _ => None,
    }
}

fn item_spot_mut<'a>(b: &'a mut BoxNode, path: &[u16]) -> Option<SpotMut<'a>> {
    let Some((&first, rest)) = path.split_first() else {
        return Some(SpotMut::Item(b));
    };
    spot_mut(b.kids.get_mut(usize::from(first))?, rest)
}

/// Every node of a tree with its path and depth, depth first: an each
/// node, then its item box, then the item's kids (the order the right
/// column lists them in, the prototype's `boxTree`).
pub fn rows(root: &Node) -> Vec<(NodePath, usize, Spot<'_>)> {
    fn walk<'a>(
        n: &'a Node,
        path: NodePath,
        depth: usize,
        out: &mut Vec<(NodePath, usize, Spot<'a>)>,
    ) {
        out.push((path.clone(), depth, Spot::Node(n)));
        match n {
            Node::Box(b) => kids(b, &path, depth + 1, out),
            Node::Each(e) => {
                let mut item = path.clone();
                item.push(0);
                out.push((item.clone(), depth + 1, Spot::Item(&e.item)));
                kids(&e.item, &item, depth + 2, out);
            }
            _ => {}
        }
    }
    fn kids<'a>(
        b: &'a BoxNode,
        path: &[u16],
        depth: usize,
        out: &mut Vec<(NodePath, usize, Spot<'a>)>,
    ) {
        for (i, kid) in b.kids.iter().enumerate() {
            let mut p = path.to_vec();
            p.push(i as u16);
            walk(kid, p, depth, out);
        }
    }
    let mut out = Vec::new();
    walk(root, Vec::new(), 0, &mut out);
    out
}

/// One property of a node, on the §4 vocabulary's steps only.
#[derive(Clone, Debug, PartialEq)]
pub enum Prop {
    Dir(BoxDir),
    Gap(u8),
    Pad(u8),
    Align(Align),
    Width(Width),
    Border(Border),
    Bg(Background),
    Radius(u8),
    Deco(Decoration),
    EachDir(EachDir),
    Sep(Separator),
    Link(Connector),
    Show(Show),
    Font(Font),
    Size(TextSize),
    Ink(u8),
    Text(String),
    Mark(String),
}

/// What a box shows when the format leaves a property out (the renderer's
/// defaults, `dr_view_module_look::plan`).
pub fn box_props(b: &BoxNode) -> [Prop; 9] {
    [
        Prop::Dir(b.dir),
        Prop::Gap(b.gap.unwrap_or(0)),
        Prop::Pad(b.pad.unwrap_or(0)),
        Prop::Align(b.align.unwrap_or(Align::Stretch)),
        Prop::Width(b.width.unwrap_or(Width::Auto)),
        Prop::Border(b.border.unwrap_or(Border::None)),
        Prop::Bg(b.bg.unwrap_or(Background::None)),
        Prop::Radius(b.radius.unwrap_or(0)),
        Prop::Deco(b.deco.unwrap_or(Decoration::None)),
    ]
}

/// An each node's properties, as the renderer reads them.
pub fn each_props(e: &EachNode) -> [Prop; 4] {
    [
        Prop::EachDir(e.dir.unwrap_or(EachDir::Col)),
        Prop::Gap(e.gap.unwrap_or(0)),
        Prop::Sep(e.sep.unwrap_or(Separator::None)),
        Prop::Link(e.link.unwrap_or(Connector::None)),
    ]
}

/// What a value node shows its block as when it does not say: a list as
/// its count, anything else as words.
pub fn shown_as(v: &ValueNode, kind: Option<BlockKind>) -> Show {
    v.show.unwrap_or(match kind {
        Some(BlockKind::List) => Show::Count,
        _ => Show::Text,
    })
}

/// A value node's type, as the renderer reads it.
pub fn value_type(v: &ValueNode) -> (Font, TextSize, u8) {
    (
        v.font.unwrap_or(Font::Sans),
        v.size.unwrap_or(TextSize::Body),
        v.ink.unwrap_or(2),
    )
}

/// A text node's type, as the renderer reads it.
pub fn text_type(t: &TextNode) -> (Font, TextSize, u8) {
    (
        t.font.unwrap_or(Font::Mono),
        t.size.unwrap_or(TextSize::Note),
        t.ink.unwrap_or(4),
    )
}

/// `value` with `prop` set on the node at `path` of `size`'s tree; `None`
/// when there is no such node or it has no such property.
pub fn set_prop(
    value: &ModuleValue,
    size: LookSize,
    path: &[u16],
    prop: Prop,
) -> Option<ModuleValue> {
    let mut next = value.clone();
    let root = tree_mut(&mut next, size)?;
    match spot_mut(root, path)? {
        SpotMut::Item(b) => set_box(b, prop)?,
        SpotMut::Node(Node::Box(b)) => set_box(b, prop)?,
        SpotMut::Node(Node::Each(e)) => match prop {
            Prop::EachDir(d) => e.dir = Some(d),
            Prop::Gap(g) => e.gap = Some(g),
            Prop::Sep(s) => e.sep = Some(s),
            Prop::Link(l) => e.link = Some(l),
            _ => return None,
        },
        SpotMut::Node(Node::Value(v)) => match prop {
            Prop::Show(s) => v.show = Some(s),
            Prop::Font(f) => v.font = Some(f),
            Prop::Size(s) => v.size = Some(s),
            Prop::Ink(i) => v.ink = Some(i),
            _ => return None,
        },
        SpotMut::Node(Node::Text(t)) => match prop {
            Prop::Font(f) => t.font = Some(f),
            Prop::Size(s) => t.size = Some(s),
            Prop::Ink(i) => t.ink = Some(i),
            Prop::Text(s) => t.text = s,
            _ => return None,
        },
        SpotMut::Node(Node::Mark(m)) => match prop {
            Prop::Mark(s) => m.mark = s,
            _ => return None,
        },
    }
    (next != *value).then_some(next)
}

fn set_box(b: &mut BoxNode, prop: Prop) -> Option<()> {
    match prop {
        Prop::Dir(d) => {
            b.dir = d;
            // A grid has its columns (two that fill, until the author
            // says otherwise); nothing else has any.
            if d == BoxDir::Grid {
                if b.cols.is_empty() {
                    b.cols = vec![Column::Fill(ColumnFill::Fill); 2];
                }
            } else {
                b.cols.clear();
            }
        }
        Prop::Gap(g) => b.gap = Some(g),
        Prop::Pad(p) => b.pad = Some(p),
        Prop::Align(a) => b.align = Some(a),
        Prop::Width(w) => b.width = Some(w),
        Prop::Border(x) => b.border = Some(x),
        Prop::Bg(x) => b.bg = Some(x),
        Prop::Radius(r) => b.radius = Some(r),
        Prop::Deco(d) => b.deco = Some(d),
        _ => return None,
    }
    Some(())
}

/// `value` with 一行 or 铺满 laid out on its own (`own`: 「单独摆」, a copy
/// of 一块 to change) or following 一块 again (「跟着一块」).
pub fn set_own(value: &ModuleValue, size: LookSize, own: bool) -> Option<ModuleValue> {
    let mut next = value.clone();
    let slot = match size {
        LookSize::Block => return None,
        LookSize::Line => &mut next.look.line,
        LookSize::Full => &mut next.look.full,
    };
    match (own, slot.is_some()) {
        (true, false) => *slot = Some(value.look.block.clone()),
        (false, true) => *slot = None,
        _ => return None,
    }
    Some(next)
}

/// A new block id: `b` and eight hex digits, never one the module has. A
/// block taken away may still have values in some book (they come back
/// when it does, §7), so ids are not counted up but drawn at random.
pub fn new_block_id(value: &ModuleValue) -> String {
    loop {
        let raw = uuid::Uuid::new_v4().simple().to_string();
        let id = format!("b{}", &raw[..8]);
        if is_block_id(&id) && value.block(&id).is_none() {
            return id;
        }
    }
}

/// The block `id` and the list of blocks it is in.
fn find_mut<'a>(blocks: &'a mut [Block], id: &str) -> Option<&'a mut Block> {
    for b in blocks.iter_mut() {
        if b.id == id {
            return Some(b);
        }
        if let Some(found) = find_mut(&mut b.blocks, id) {
            return Some(found);
        }
    }
    None
}

fn take(blocks: &mut Vec<Block>, id: &str) -> Option<Block> {
    if let Some(i) = blocks.iter().position(|b| b.id == id) {
        return Some(blocks.remove(i));
    }
    blocks.iter_mut().find_map(|b| take(&mut b.blocks, id))
}

/// `value` with a new block of `kind` called `name` (a select's or a
/// multi-select's with `options`), at the end of `into` (a group or a list)
/// or of the module itself, and its value drawn in 一块: a list as a
/// column of its items, each a row; a group as a framed box with its name;
/// another block in a list as its value, elsewhere as its name over its
/// value (the prototype's `addBlock`). Returns the value and the new id.
pub fn add_block(
    value: &ModuleValue,
    kind: BlockKind,
    name: &str,
    options: &[String],
    into: Option<&str>,
) -> Option<(ModuleValue, String)> {
    let mut next = value.clone();
    let id = new_block_id(value);
    let block = Block {
        id: id.clone(),
        kind,
        name: name.to_owned(),
        options: if kind.has_options() {
            options.to_vec()
        } else {
            Vec::new()
        },
        blocks: Vec::new(),
    };
    let host = into
        .and_then(|h| value.block(h))
        .filter(|h| h.kind.holds_blocks());
    match host {
        Some(h) => find_mut(&mut next.blocks, &h.id)?.blocks.push(block),
        None => next.blocks.push(block),
    }
    let in_list = host.is_some_and(|h| h.kind == BlockKind::List);
    let node = match kind {
        BlockKind::List => Node::Each(EachNode {
            list: id.clone(),
            dir: Some(EachDir::Col),
            gap: None,
            sep: Some(Separator::Hair),
            link: None,
            item: Box::new(BoxNode {
                gap: Some(12),
                ..BoxNode::new(BoxDir::Row)
            }),
        }),
        BlockKind::Group => Node::Box(BoxNode {
            gap: Some(4),
            pad: Some(8),
            border: Some(Border::Hair),
            radius: Some(4),
            kids: vec![label(name)],
            ..BoxNode::new(BoxDir::Col)
        }),
        _ if in_list => Node::Value(ValueNode {
            size: Some(TextSize::Small),
            ..value_node(&id)
        }),
        _ => Node::Box(BoxNode {
            gap: Some(4),
            kids: vec![
                label(name),
                Node::Value(ValueNode {
                    ink: Some(1),
                    ..value_node(&id)
                }),
            ],
            ..BoxNode::new(BoxDir::Col)
        }),
    };
    // Drawn where the items keeping it are: inside the each over its list
    // (the first one in 一块), or anywhere for the entry's own.
    let scope = next.scope_of(&id).flatten().map(str::to_owned);
    match scope {
        Some(list) => {
            if let Some(item) = each_item_mut(&mut next.look.block, &list) {
                item.kids.push(node);
            }
        }
        None => match &mut next.look.block {
            Node::Box(b) => b.kids.push(node),
            other => {
                let old = std::mem::replace(other, Node::Box(BoxNode::new(BoxDir::Col)));
                if let Node::Box(b) = other {
                    b.kids = vec![old, node];
                }
            }
        },
    }
    Some((next, id))
}

fn label(name: &str) -> Node {
    let text: String = name
        .chars()
        .take(dr_model::custom_module::MAX_LOOK_TEXT_CHARS)
        .collect();
    Node::Text(TextNode {
        text,
        font: None,
        size: None,
        ink: None,
        width: None,
    })
}

fn value_node(block: &str) -> ValueNode {
    ValueNode {
        block: block.to_owned(),
        show: None,
        font: None,
        size: None,
        ink: None,
        lines: None,
        width: None,
        suffix: None,
    }
}

/// The item box of the first each node over `list` in `root`.
fn each_item_mut<'a>(root: &'a mut Node, list: &str) -> Option<&'a mut BoxNode> {
    match root {
        Node::Each(e) => {
            if e.list == list {
                Some(&mut e.item)
            } else {
                e.item.kids.iter_mut().find_map(|k| each_item_mut(k, list))
            }
        }
        Node::Box(b) => b.kids.iter_mut().find_map(|k| each_item_mut(k, list)),
        _ => None,
    }
}

/// `value` with block `id` called `name` (one line, not empty).
pub fn rename_block(value: &ModuleValue, id: &str, name: &str) -> Option<ModuleValue> {
    let name = name.trim();
    if name.is_empty() || name.chars().any(char::is_control) {
        return None;
    }
    let mut next = value.clone();
    let block = find_mut(&mut next.blocks, id)?;
    if block.name == name {
        return None;
    }
    block.name = name.to_owned();
    Some(next)
}

/// `value` with a select's or a multi-select's options set to `lines`
/// (each trimmed, empty ones and repeats left out); `None` when none are
/// left or nothing changes.
pub fn set_options(value: &ModuleValue, id: &str, lines: &str) -> Option<ModuleValue> {
    let mut options: Vec<String> = Vec::new();
    for line in lines.lines() {
        let o = line.trim();
        if !o.is_empty() && !o.chars().any(char::is_control) && !options.iter().any(|x| x == o) {
            options.push(o.to_owned());
        }
    }
    if options.is_empty() {
        return None;
    }
    let mut next = value.clone();
    let block = find_mut(&mut next.blocks, id)?;
    if !block.kind.has_options() || block.options == options {
        return None;
    }
    block.options = options;
    repair(&mut next);
    Some(next)
}

/// `value` without block `id` (and what it holds). Entries keep its values.
pub fn remove_block(value: &ModuleValue, id: &str) -> Option<ModuleValue> {
    let mut next = value.clone();
    take(&mut next.blocks, id)?;
    repair(&mut next);
    Some(next)
}

/// Where a moved block goes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MoveTo {
    /// Just before block `id`, among the blocks it is in.
    Before(String),
    /// At the end of group or list `id`.
    Into(String),
    /// At the end of the module's own blocks.
    End,
}

/// `value` with block `id` moved. A block never goes into itself or what
/// it holds; one moved out of (or into) a list's items loses the nodes that
/// drew it where its value is no longer kept.
pub fn move_block(value: &ModuleValue, id: &str, to: &MoveTo) -> Option<ModuleValue> {
    let target = match to {
        MoveTo::Before(t) | MoveTo::Into(t) => Some(t.as_str()),
        MoveTo::End => None,
    };
    if let Some(t) = target {
        if t == id || holds(value.block(id)?, t) {
            return None;
        }
        if matches!(to, MoveTo::Into(_)) && !value.block(t)?.kind.holds_blocks() {
            return None;
        }
    }
    let mut next = value.clone();
    let block = take(&mut next.blocks, id)?;
    match to {
        MoveTo::End => next.blocks.push(block),
        MoveTo::Into(t) => find_mut(&mut next.blocks, t)?.blocks.push(block),
        MoveTo::Before(t) => insert_before(&mut next.blocks, t, block).ok()?,
    }
    if next.blocks == value.blocks {
        return None;
    }
    repair(&mut next);
    Some(next)
}

fn holds(block: &Block, id: &str) -> bool {
    block.blocks.iter().any(|b| b.id == id || holds(b, id))
}

fn insert_before(blocks: &mut Vec<Block>, before: &str, block: Block) -> Result<(), Block> {
    if let Some(i) = blocks.iter().position(|b| b.id == before) {
        blocks.insert(i, block);
        return Ok(());
    }
    let mut block = block;
    for b in blocks.iter_mut() {
        match insert_before(&mut b.blocks, before, block) {
            Ok(()) => return Ok(()),
            Err(back) => block = back,
        }
    }
    Err(block)
}

/// `value` with its name (one line, not empty).
pub fn rename(value: &ModuleValue, name: &str) -> Option<ModuleValue> {
    let name = name.trim();
    if name.is_empty() || name.chars().any(char::is_control) || name == value.name {
        return None;
    }
    let mut next = value.clone();
    next.name = name.to_owned();
    Some(next)
}

/// Which of the words for the Agent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Words {
    Name,
    Description,
    Instructions,
    /// The sentence for one block.
    Block(String),
}

/// `value` with one of its words for the Agent set (an empty sentence for
/// a block is no sentence).
pub fn set_words(value: &ModuleValue, which: &Words, text: &str) -> Option<ModuleValue> {
    let mut next = value.clone();
    let a = &mut next.agent;
    match which {
        Words::Name => a.name = text.trim().to_owned(),
        Words::Description => a.description = text.to_owned(),
        Words::Instructions => a.instructions = text.to_owned(),
        Words::Block(id) => {
            value.block(id)?;
            let line = text.trim();
            if line.is_empty() {
                a.blocks.remove(id);
            } else {
                a.blocks.insert(id.clone(), line.to_owned());
            }
        }
    }
    (next != *value).then_some(next)
}

/// Keeps what the module can still draw and keep after its blocks changed:
/// the look's nodes whose blocks are there, kept in the items that draw
/// them, shown in a way their kind can be; the sample's values for blocks
/// in the right part of the module, a select's among its options; the
/// words for the Agent for blocks it has.
pub fn repair(value: &mut ModuleValue) {
    let snapshot = value.clone();
    let check = |root: &mut Node| {
        if !prune_node(&snapshot, root, &mut vec![None]) {
            *root = Node::Box(BoxNode::new(BoxDir::Col));
        }
    };
    check(&mut value.look.block);
    if let Some(line) = &mut value.look.line {
        check(line);
    }
    if let Some(full) = &mut value.look.full {
        check(full);
    }
    value
        .agent
        .blocks
        .retain(|id, _| snapshot.block(id).is_some());
    let sample = std::mem::take(&mut value.sample);
    value.sample = prune_sample(&snapshot, None, sample);
}

/// Whether `node` stays (and, a box, with what kids).
fn prune_node<'a>(
    value: &'a ModuleValue,
    node: &mut Node,
    chain: &mut Vec<Option<&'a str>>,
) -> bool {
    match node {
        Node::Box(b) => {
            prune_kids(value, b, chain);
            true
        }
        Node::Each(e) => {
            let Some(block) = value.block(&e.list) else {
                return false;
            };
            if block.kind != BlockKind::List {
                return false;
            }
            let scope = value.scope_of(&e.list).flatten();
            if !chain.contains(&scope) {
                return false;
            }
            chain.push(Some(block.id.as_str()));
            prune_kids(value, &mut e.item, chain);
            chain.pop();
            true
        }
        Node::Value(v) => {
            let Some(block) = value.block(&v.block) else {
                return false;
            };
            let scope = value.scope_of(&v.block).flatten();
            if block.kind == BlockKind::Group || !chain.contains(&scope) {
                return false;
            }
            let fits = match (v.show, block.kind) {
                (None, _) => true,
                (Some(Show::Count), BlockKind::List) => true,
                (Some(Show::Count), _) | (_, BlockKind::List) => false,
                (Some(Show::Dots), k) => k == BlockKind::Number,
                (Some(Show::Mark), k) => k == BlockKind::Select,
                (Some(Show::Text), k) => k != BlockKind::Image,
            };
            if !fits {
                v.show = None;
            }
            true
        }
        Node::Text(_) | Node::Mark(_) => true,
    }
}

/// A box's kids that stay. A box that held a value or a list that went and
/// is left with only words or marks (two kids at most: the prototype's
/// label over its value) goes with it.
fn prune_kids<'a>(value: &'a ModuleValue, b: &mut BoxNode, chain: &mut Vec<Option<&'a str>>) {
    let kids = std::mem::take(&mut b.kids);
    for mut kid in kids {
        let before = matches!(&kid, Node::Box(k) if k.kids.len() <= 2 && k.kids.iter().any(|n| matches!(n, Node::Value(_) | Node::Each(_))));
        if !prune_node(value, &mut kid, chain) {
            continue;
        }
        if before
            && let Node::Box(k) = &kid
            && k.kids
                .iter()
                .all(|n| matches!(n, Node::Text(_) | Node::Mark(_)))
        {
            continue;
        }
        b.kids.push(kid);
    }
}

fn prune_sample(
    value: &ModuleValue,
    scope: Option<&str>,
    sample: BTreeMap<String, SampleValue>,
) -> BTreeMap<String, SampleValue> {
    let blocks = value.scope_blocks(scope);
    sample
        .into_iter()
        .filter_map(|(id, v)| {
            let block = blocks.iter().find(|b| b.id == id)?;
            let v = match (block.kind, v) {
                (BlockKind::Select, SampleValue::Text(s)) => {
                    block.options.contains(&s).then_some(SampleValue::Text(s))?
                }
                (BlockKind::MultiSelect, SampleValue::Texts(xs)) => SampleValue::Texts(
                    xs.into_iter()
                        .filter(|x| block.options.contains(x))
                        .collect(),
                ),
                (BlockKind::List, SampleValue::Items(items)) => SampleValue::Items(
                    items
                        .into_iter()
                        .map(|item| prune_sample(value, Some(block.id.as_str()), item))
                        .collect(),
                ),
                (_, v) => v,
            };
            Some((id, v))
        })
        .collect()
}

/// Whether `value` passes the validator (every write goes through it again
/// in the command; this keeps the workbench from even trying).
pub fn valid(value: &ModuleValue) -> bool {
    validate_module_value(value).is_ok()
}
