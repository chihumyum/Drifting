//! The values a look is drawn with, whatever they come from: an entry's
//! (what the book's copy can read of them, `dr_model::custom_module::values`),
//! the module's own sample (§2, the workbench's 「示例」), or none at all (its
//! 「空」). Entry ids and asset ids are resolved to what is drawn for them
//! ([`Names`]) before the look is laid out, so laying out needs no book.

use std::collections::BTreeMap;
use std::path::PathBuf;

use dr_model::custom_module::values::{BlockValue, ItemValues};
use dr_model::custom_module::{BlockKind, ModuleValue, SampleValue};

/// One block's value, as it is drawn.
#[derive(Clone, Debug, PartialEq)]
pub enum Shown {
    /// 一行字, 一段字, 日期, and 单选 (the option's words).
    Text(String),
    Number(f64),
    /// 多选: the options picked, in the order kept.
    Choices(Vec<String>),
    Toggle(bool),
    /// 条目: the entries still there (an entry since deleted is left out).
    Entries(Vec<EntryName>),
    Image(Picture),
}

/// An entry a value points to, by the title it is drawn with. A sample's
/// entries are a few words and have no id (§6).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntryName {
    pub id: Option<String>,
    pub title: String,
}

/// A file of the asset library an image value points to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Picture {
    pub id: Option<String>,
    pub name: String,
    /// The picture on disk, when there is one to show.
    pub path: Option<PathBuf>,
}

/// What one scope holds: the entry's own values, or one list item's.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Scope {
    /// Plain values by block id.
    pub plain: BTreeMap<String, Shown>,
    /// Lists by block id, items in order.
    pub lists: BTreeMap<String, Vec<Item>>,
}

/// One item of a list. Its id is the book's (`None` for a sample's item).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Item {
    pub id: Option<String>,
    pub scope: Scope,
}

/// What entry ids and asset ids are drawn as. `None`: the thing is gone
/// (deleted, or not in this book) and is not drawn.
pub trait Names {
    fn entry(&self, id: &str) -> Option<String>;
    fn image(&self, id: &str) -> Option<Picture>;
}

/// Names for nothing: every id is drawn as gone (a preview without a book).
pub struct NoNames;

impl Names for NoNames {
    fn entry(&self, _: &str) -> Option<String> {
        None
    }
    fn image(&self, _: &str) -> Option<Picture> {
        None
    }
}

impl Scope {
    /// No values at all (the workbench's 「空」).
    pub fn empty() -> Scope {
        Scope::default()
    }

    /// No values, but one item in every list, so every block shows where it
    /// is (the workbench's 「空」, drawn with [`crate::Blanks::Names`]: the
    /// prototype's empty preview).
    pub fn blank(module: &ModuleValue) -> Scope {
        fn lists(module: &ModuleValue, scope: Option<&str>) -> Scope {
            let mut out = Scope::default();
            for block in module.scope_blocks(scope) {
                if block.kind == BlockKind::List {
                    out.lists.insert(
                        block.id.clone(),
                        vec![Item {
                            id: None,
                            scope: lists(module, Some(block.id.as_str())),
                        }],
                    );
                }
            }
            out
        }
        lists(module, None)
    }

    /// The module's sample value (§6). A sample value that does not fit its
    /// block is left out; the validator lets none through.
    pub fn sample(module: &ModuleValue) -> Scope {
        sample_scope(module, None, &module.sample)
    }

    /// What a module's copy can read of an entry's values
    /// (`module.read_custom`'s `values`, `read_scope`'s result), ids
    /// resolved by `names`.
    pub fn read(values: &BTreeMap<String, BlockValue>, names: &dyn Names) -> Scope {
        read_values(values, names)
    }
}

fn read_values(values: &BTreeMap<String, BlockValue>, names: &dyn Names) -> Scope {
    let mut scope = Scope::default();
    for (id, value) in values {
        match value {
            BlockValue::List(items) => {
                scope.lists.insert(
                    id.clone(),
                    items.iter().map(|i| read_item(i, names)).collect(),
                );
            }
            other => {
                if let Some(shown) = read_plain(other, names) {
                    scope.plain.insert(id.clone(), shown);
                }
            }
        }
    }
    scope
}

fn read_item(item: &ItemValues, names: &dyn Names) -> Item {
    Item {
        id: Some(item.id.clone()),
        scope: read_values(&item.values, names),
    }
}

fn read_plain(value: &BlockValue, names: &dyn Names) -> Option<Shown> {
    Some(match value {
        BlockValue::Text(s)
        | BlockValue::LongText(s)
        | BlockValue::Date(s)
        | BlockValue::Select(s) => Shown::Text(s.clone()),
        BlockValue::Number(n) => Shown::Number(*n),
        BlockValue::MultiSelect(xs) => Shown::Choices(xs.clone()),
        BlockValue::Toggle(b) => Shown::Toggle(*b),
        BlockValue::Entry(ids) => Shown::Entries(
            ids.iter()
                .filter_map(|id| {
                    names.entry(id).map(|title| EntryName {
                        id: Some(id.clone()),
                        title,
                    })
                })
                .collect(),
        ),
        BlockValue::Image(id) => Shown::Image(names.image(id)?),
        BlockValue::List(_) => return None,
    })
}

fn sample_scope(
    module: &ModuleValue,
    scope: Option<&str>,
    sample: &BTreeMap<String, SampleValue>,
) -> Scope {
    let mut out = Scope::default();
    for block in module.scope_blocks(scope) {
        let Some(value) = sample.get(&block.id) else {
            continue;
        };
        match (block.kind, value) {
            (BlockKind::List, SampleValue::Items(items)) => {
                out.lists.insert(
                    block.id.clone(),
                    items
                        .iter()
                        .map(|item| Item {
                            id: None,
                            scope: sample_scope(module, Some(block.id.as_str()), item),
                        })
                        .collect(),
                );
            }
            (kind, value) => {
                if let Some(shown) = sample_plain(kind, value) {
                    out.plain.insert(block.id.clone(), shown);
                }
            }
        }
    }
    out
}

fn sample_plain(kind: BlockKind, value: &SampleValue) -> Option<Shown> {
    use SampleValue as S;
    Some(match (kind, value) {
        (
            BlockKind::Text | BlockKind::LongText | BlockKind::Date | BlockKind::Select,
            S::Text(s),
        ) => Shown::Text(s.clone()),
        (BlockKind::Number, S::Number(n)) => Shown::Number(*n),
        (BlockKind::MultiSelect, S::Texts(xs)) => Shown::Choices(xs.clone()),
        (BlockKind::Toggle, S::Bool(b)) => Shown::Toggle(*b),
        (BlockKind::Entry, S::Texts(xs)) => Shown::Entries(
            xs.iter()
                .map(|t| EntryName {
                    id: None,
                    title: t.clone(),
                })
                .collect(),
        ),
        (BlockKind::Entry, S::Text(t)) => Shown::Entries(vec![EntryName {
            id: None,
            title: t.clone(),
        }]),
        _ => return None,
    })
}
