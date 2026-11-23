//! The values an entry keeps for a custom module (`custom-modules.md` §3,
//! §7 "值不丢"): stored by block id, a list as items that each have an id.
//!
//! What is stored never depends on the module's current copy: a deleted
//! block's value stays, a block whose kind changed keeps its old value.
//! Reading ([`read_scope`]) shows only what the current copy can read: a
//! value that fits its block now, nothing for one that does not.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::{Block, BlockKind, ModuleValue};
use crate::id::check_id;
use crate::time::Day;

/// One stored plain value, as the book keeps it (never a list's items).
#[derive(Clone, Debug, PartialEq)]
pub enum StoredValue {
    Bool(bool),
    Number(f64),
    Text(String),
    Texts(Vec<String>),
    /// Something this build cannot read (kept as it is in the book).
    Unknown,
}

/// What one scope keeps: the entry's own values, or one list item's.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StoredScope {
    /// Plain values by block id.
    pub plain: BTreeMap<String, StoredValue>,
    /// Lists by block id, items in order.
    pub lists: BTreeMap<String, Vec<StoredItem>>,
}

/// One item of a list, with the values it keeps.
#[derive(Clone, Debug, PartialEq)]
pub struct StoredItem {
    pub id: String,
    pub scope: StoredScope,
}

/// A value read for a block of the current copy.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum BlockValue {
    Text(String),
    LongText(String),
    Number(f64),
    Date(String),
    Select(String),
    MultiSelect(Vec<String>),
    Toggle(bool),
    /// Entry ids (the entries may since have gone: a reader shows the live ones).
    Entry(Vec<String>),
    /// An asset id.
    Image(String),
    List(Vec<ItemValues>),
}

/// One list item as read: its id and the values its blocks can read.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ItemValues {
    pub id: String,
    pub values: BTreeMap<String, BlockValue>,
}

/// The values the current copy can read in `scope` (`None`: the entry's
/// own; a list id: one of its items' scope), by block id. A block with no
/// value, or whose stored value does not fit it now, is left out; the
/// stored value is not touched.
pub fn read_scope(
    module: &ModuleValue,
    scope: Option<&str>,
    stored: &StoredScope,
) -> BTreeMap<String, BlockValue> {
    module
        .scope_blocks(scope)
        .into_iter()
        .filter_map(|b| read_block(module, b, stored).map(|v| (b.id.clone(), v)))
        .collect()
}

/// `block`'s value in `stored`, if it can be read as `block`'s kind now.
pub fn read_block(module: &ModuleValue, block: &Block, stored: &StoredScope) -> Option<BlockValue> {
    if block.kind == BlockKind::List {
        let items = stored.lists.get(&block.id)?;
        return Some(BlockValue::List(
            items
                .iter()
                .map(|item| ItemValues {
                    id: item.id.clone(),
                    values: read_scope(module, Some(block.id.as_str()), &item.scope),
                })
                .collect(),
        ));
    }
    read_plain(block, stored.plain.get(&block.id)?)
}

/// A plain stored value read as `block`'s kind (§7: "读得成新类型就显示").
pub fn read_plain(block: &Block, v: &StoredValue) -> Option<BlockValue> {
    use StoredValue as S;
    let in_options = |s: &String| block.options.contains(s);
    match (block.kind, v) {
        (BlockKind::Text, S::Text(s)) => Some(BlockValue::Text(s.clone())),
        (BlockKind::LongText, S::Text(s)) => Some(BlockValue::LongText(s.clone())),
        (BlockKind::Number, S::Number(n)) if n.is_finite() => Some(BlockValue::Number(*n)),
        (BlockKind::Number, S::Text(s)) => s
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|n| n.is_finite())
            .map(BlockValue::Number),
        (BlockKind::Date, S::Text(s)) => {
            Day::parse(s.trim()).map(|d| BlockValue::Date(d.as_str().to_owned()))
        }
        (BlockKind::Select, S::Text(s)) if in_options(s) => Some(BlockValue::Select(s.clone())),
        (BlockKind::Select, S::Texts(xs)) if xs.len() == 1 && in_options(&xs[0]) => {
            Some(BlockValue::Select(xs[0].clone()))
        }
        (BlockKind::MultiSelect, S::Texts(xs)) => {
            let kept: Vec<String> = xs.iter().filter(|x| in_options(x)).cloned().collect();
            (!kept.is_empty() || xs.is_empty()).then_some(BlockValue::MultiSelect(kept))
        }
        (BlockKind::MultiSelect, S::Text(s)) if in_options(s) => {
            Some(BlockValue::MultiSelect(vec![s.clone()]))
        }
        (BlockKind::Toggle, S::Bool(b)) => Some(BlockValue::Toggle(*b)),
        (BlockKind::Entry, S::Texts(xs)) => Some(BlockValue::Entry(
            xs.iter().filter(|x| check_id(x).is_ok()).cloned().collect(),
        )),
        (BlockKind::Entry, S::Text(s)) if check_id(s).is_ok() => {
            Some(BlockValue::Entry(vec![s.clone()]))
        }
        (BlockKind::Image, S::Text(s)) if check_id(s).is_ok() => Some(BlockValue::Image(s.clone())),
        _ => None,
    }
}

/// A value given to write one block (`null` clears it).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(untagged)]
pub enum InputValue {
    Bool(bool),
    Number(f64),
    Text(String),
    Texts(Vec<String>),
    Null,
}

/// What a write of `input` to `block` stores (`None`: clear it), checked
/// against the block's kind (§13 "按积木类型校验"). Whether an entry or a
/// file exists is the book's to check: this only checks the shape.
pub fn check_input(block: &Block, input: &InputValue) -> Result<Option<StoredValue>, String> {
    use InputValue as I;
    let one_line = |s: &str| !s.chars().any(char::is_control);
    let bad = || {
        Err(format!(
            "the value does not fit block {:?} ({})",
            block.id,
            block.kind.as_str()
        ))
    };
    if matches!(input, I::Null) {
        return match block.kind {
            BlockKind::Group | BlockKind::List => bad(),
            _ => Ok(None),
        };
    }
    let stored = match (block.kind, input) {
        (BlockKind::Text, I::Text(s)) if one_line(s) => StoredValue::Text(s.clone()),
        (BlockKind::LongText, I::Text(s))
            if !s
                .chars()
                .any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t') =>
        {
            StoredValue::Text(s.clone())
        }
        (BlockKind::Number, I::Number(n)) if n.is_finite() => StoredValue::Number(*n),
        (BlockKind::Date, I::Text(s)) if Day::parse(s).is_some() => StoredValue::Text(s.clone()),
        (BlockKind::Select, I::Text(s)) if block.options.contains(s) => {
            StoredValue::Text(s.clone())
        }
        (BlockKind::MultiSelect, I::Texts(xs)) => {
            let mut seen = std::collections::BTreeSet::new();
            if !xs
                .iter()
                .all(|x| block.options.contains(x) && seen.insert(x.as_str()))
            {
                return bad();
            }
            StoredValue::Texts(xs.clone())
        }
        (BlockKind::Toggle, I::Bool(b)) => StoredValue::Bool(*b),
        (BlockKind::Entry, I::Texts(xs)) => {
            let mut seen = std::collections::BTreeSet::new();
            if !xs
                .iter()
                .all(|x| check_id(x).is_ok() && seen.insert(x.as_str()))
            {
                return bad();
            }
            StoredValue::Texts(xs.clone())
        }
        (BlockKind::Image, I::Text(s)) if check_id(s).is_ok() => StoredValue::Text(s.clone()),
        _ => return bad(),
    };
    Ok(Some(stored))
}

/// One step down to the scope a write goes to: an item of a list.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ItemStep {
    /// The list block.
    pub list: String,
    /// The item's id.
    pub item: String,
}

/// Whether `path` leads to the scope that keeps `block`'s value: one step
/// per list from the entry down (`ModuleValue::list_chain`).
pub fn check_path(module: &ModuleValue, block: &str, path: &[ItemStep]) -> Result<(), String> {
    let chain = module
        .list_chain(block)
        .ok_or_else(|| format!("the module has no block {block:?}"))?;
    if chain.len() != path.len() || chain.iter().zip(path).any(|(l, s)| *l != s.list) {
        return Err(format!(
            "block {block:?} is kept in {}; the path names {}",
            if chain.is_empty() {
                "the entry itself".to_owned()
            } else {
                format!("the items of {}", chain.join(" / "))
            },
            if path.is_empty() {
                "the entry itself".to_owned()
            } else {
                path.iter()
                    .map(|s| s.list.as_str())
                    .collect::<Vec<_>>()
                    .join(" / ")
            }
        ));
    }
    Ok(())
}
