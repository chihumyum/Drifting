//! Custom modules in a book (`docs/rust-rewrite/custom-modules.md` §7).
//!
//! - **Copies**: the root map `modules` holds one value per module id,
//!   `{value: <canonical JSON>, source}`, replaced whole (the one kind of
//!   write that replaces what it read, §7 "自动换"). A copy that the module
//!   validator refuses (a newer build's, a damaged one) reads as broken:
//!   [`ModuleCopy::value`] is the error, [`ModuleCopy::name`] what its JSON
//!   still says its name is.
//! - **Values**: an entry keeps its values for template module `<m>` in
//!   `module:<m>` on its node, a mergeable map by block id; a list's items
//!   are under `list:<block id>`, a mergeable movable list of maps that each
//!   carry their own `id`. Nothing here reads the copy: replacing a copy, or
//!   a block going away or changing kind, never touches a stored value.
//!
//! Writers check nothing a command has not already checked, and never make
//! a container on a path that turns out not to exist (a failed write still
//! commits what it wrote before failing).

use std::collections::BTreeMap;

use dr_model::custom_module::values::{ItemStep, StoredItem, StoredScope, StoredValue};
use dr_model::custom_module::{
    ModuleError, ModuleValue, module_name_hint, parse_module_json, to_canonical_json,
};
use dr_model::id::{CustomModuleId, EntryId, ModuleId, ModuleItemId};
use loro::{Container, LoroMap, LoroMovableList, LoroValue, ValueOrContainer};

use super::read::BookViewV3;
use super::write::{BookTxnV3, EntryWriterV3};
use crate::error::{DocError, Result};
use crate::schema::{book_v3, custom_values as cv};

/// Where a book's copy of a module came from. Whether it follows my modules
/// is not this: it follows them exactly when my modules have its id (§7
/// "怎么认「跟着我的模块走」").
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CopySource {
    /// Put in from my modules (a template module added, 「另存一份」,
    /// 「存进我的模块」, replaced when my modules changed).
    Library,
    /// Came with a project template when the project was made.
    Template,
    /// A source this build does not know, kept as written.
    Other(String),
}

impl CopySource {
    pub fn as_str(&self) -> &str {
        match self {
            CopySource::Library => "library",
            CopySource::Template => "template",
            CopySource::Other(s) => s,
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "library" => CopySource::Library,
            "template" => CopySource::Template,
            other => CopySource::Other(other.to_owned()),
        }
    }
}

/// One copy in a book's `modules`.
#[derive(Clone, Debug, PartialEq)]
pub struct ModuleCopy {
    pub id: CustomModuleId,
    /// The stored JSON, as stored.
    pub raw: String,
    pub source: CopySource,
    /// The module, or why the validator refused it (§16 item 6: drawn as an
    /// empty placeholder with only its name; the values stay).
    pub value: std::result::Result<ModuleValue, ModuleError>,
}

impl ModuleCopy {
    /// The module's name: its own, or for a broken copy whatever name its
    /// JSON still gives.
    pub fn name(&self) -> Option<String> {
        match &self.value {
            Ok(v) => Some(v.name.clone()),
            Err(_) => module_name_hint(&self.raw),
        }
    }

    pub fn is_broken(&self) -> bool {
        self.value.is_err()
    }

    pub fn module(&self) -> Option<&ModuleValue> {
        self.value.as_ref().ok()
    }
}

fn decode_copy(id: CustomModuleId, v: &LoroValue) -> ModuleCopy {
    let (raw, source) = match v {
        LoroValue::Map(m) => (
            match m.get(cv::COPY_VALUE) {
                Some(LoroValue::String(s)) => s.to_string(),
                _ => String::new(),
            },
            match m.get(cv::COPY_SOURCE) {
                Some(LoroValue::String(s)) => CopySource::parse(s),
                _ => CopySource::Other(String::new()),
            },
        ),
        _ => (String::new(), CopySource::Other(String::new())),
    };
    let value = parse_module_json(&raw);
    ModuleCopy {
        id,
        raw,
        source,
        value,
    }
}

fn decode_plain(v: &LoroValue) -> StoredValue {
    match v {
        LoroValue::Bool(b) => StoredValue::Bool(*b),
        LoroValue::Double(d) => StoredValue::Number(*d),
        LoroValue::I64(i) => StoredValue::Number(*i as f64),
        LoroValue::String(s) => StoredValue::Text(s.to_string()),
        LoroValue::List(items) => {
            let texts: Option<Vec<String>> = items
                .iter()
                .map(|x| match x {
                    LoroValue::String(s) => Some(s.to_string()),
                    _ => None,
                })
                .collect();
            texts.map_or(StoredValue::Unknown, StoredValue::Texts)
        }
        _ => StoredValue::Unknown,
    }
}

/// A scope's stored values from its deep value.
pub(crate) fn decode_scope(v: &LoroValue) -> StoredScope {
    let mut scope = StoredScope::default();
    let LoroValue::Map(m) = v else {
        return scope;
    };
    for (key, value) in m.iter() {
        if let Some(list) = key.strip_prefix(cv::LIST_PREFIX) {
            let items = match value {
                LoroValue::List(items) => items
                    .iter()
                    .filter_map(|item| {
                        let LoroValue::Map(im) = item else {
                            return None;
                        };
                        let id = match im.get(cv::ITEM_ID) {
                            Some(LoroValue::String(s)) => s.to_string(),
                            _ => return None,
                        };
                        Some(StoredItem {
                            id,
                            scope: decode_scope(item),
                        })
                    })
                    .collect(),
                _ => Vec::new(),
            };
            scope.lists.insert(list.to_owned(), items);
        } else if key != cv::ITEM_ID {
            scope.plain.insert(key.to_string(), decode_plain(value));
        }
    }
    scope
}

fn encode_plain(v: &StoredValue) -> Option<LoroValue> {
    Some(match v {
        StoredValue::Bool(b) => LoroValue::Bool(*b),
        StoredValue::Number(n) => LoroValue::Double(*n),
        StoredValue::Text(s) => LoroValue::from(s.as_str()),
        StoredValue::Texts(xs) => LoroValue::List(
            xs.iter()
                .map(|x| LoroValue::from(x.as_str()))
                .collect::<Vec<_>>()
                .into(),
        ),
        StoredValue::Unknown => return None,
    })
}

/// The key of an entry node holding its values for template module `module`.
pub fn entry_key(module: &ModuleId) -> String {
    format!("{}{module}", cv::ENTRY_PREFIX)
}

fn list_key(list: &str) -> String {
    format!("{}{list}", cv::LIST_PREFIX)
}

impl BookViewV3<'_> {
    /// Every copy in the book's `modules`, by module id.
    pub fn module_copies(&self) -> BTreeMap<CustomModuleId, ModuleCopy> {
        let LoroValue::Map(m) = self.doc.get_map(book_v3::MODULES).get_value() else {
            return BTreeMap::new();
        };
        m.iter()
            .filter_map(|(k, v)| {
                let id = CustomModuleId::parse(k).ok()?;
                Some((id.clone(), decode_copy(id, v)))
            })
            .collect()
    }

    /// The copy of module `id`, if the book has one.
    pub fn module_copy(&self, id: &CustomModuleId) -> Option<ModuleCopy> {
        match self.doc.get_map(book_v3::MODULES).get(id.as_str())? {
            ValueOrContainer::Value(v) => Some(decode_copy(id.clone(), &v)),
            ValueOrContainer::Container(_) => Some(decode_copy(id.clone(), &LoroValue::Null)),
        }
    }

    fn entry_meta(&self, entry: &EntryId) -> Option<LoroMap> {
        let node = *self
            .tree_index(book_v3::ENTRIES)
            .get(entry.as_str())?
            .first()?;
        self.doc.get_tree(book_v3::ENTRIES).get_meta(node).ok()
    }

    /// What `entry` keeps for its template module `module` (empty when it
    /// keeps nothing), whatever the module's copy says now.
    pub fn custom_values(&self, entry: &EntryId, module: &ModuleId) -> StoredScope {
        match self
            .entry_meta(entry)
            .and_then(|meta| meta.get(&entry_key(module)))
        {
            Some(ValueOrContainer::Container(Container::Map(m))) => {
                decode_scope(&m.get_deep_value())
            }
            _ => StoredScope::default(),
        }
    }

    /// Everything `entry` keeps for custom modules, by template module id
    /// (modules its template no longer has included).
    pub fn all_custom_values(&self, entry: &EntryId) -> BTreeMap<ModuleId, StoredScope> {
        let Some(meta) = self.entry_meta(entry) else {
            return BTreeMap::new();
        };
        let LoroValue::Map(m) = meta.get_deep_value() else {
            return BTreeMap::new();
        };
        m.iter()
            .filter_map(|(k, v)| {
                let id = ModuleId::parse(k.strip_prefix(cv::ENTRY_PREFIX)?).ok()?;
                Some((id, decode_scope(v)))
            })
            .collect()
    }
}

impl BookTxnV3<'_> {
    /// Put `value` in as the book's copy of module `id`, whole (canonical
    /// JSON), over whatever copy was there. Values are not touched.
    pub fn put_module_copy(
        &self,
        id: &CustomModuleId,
        value: &ModuleValue,
        source: &CopySource,
    ) -> Result<()> {
        let json = to_canonical_json(value).map_err(|_| {
            DocError::NotInProfile("a custom module that does not pass the module validator")
        })?;
        let record: std::collections::HashMap<String, LoroValue> = [
            (cv::COPY_VALUE.to_owned(), LoroValue::from(json)),
            (cv::COPY_SOURCE.to_owned(), LoroValue::from(source.as_str())),
        ]
        .into_iter()
        .collect();
        self.view
            .doc
            .get_map(book_v3::MODULES)
            .insert(id.as_str(), LoroValue::from(record))?;
        Ok(())
    }
}

fn missing(what: &str) -> DocError {
    DocError::Missing {
        collection: "module values",
        id: what.to_owned(),
    }
}

fn find_item(list: &LoroMovableList, item: &str) -> Option<(usize, LoroMap)> {
    (0..list.len()).find_map(|i| match list.get(i)? {
        ValueOrContainer::Container(Container::Map(m)) => match m.get(cv::ITEM_ID) {
            Some(ValueOrContainer::Value(LoroValue::String(s))) if s.as_str() == item => {
                Some((i, m))
            }
            _ => None,
        },
        _ => None,
    })
}

fn existing_list(scope: &LoroMap, list: &str) -> Option<LoroMovableList> {
    match scope.get(&list_key(list))? {
        ValueOrContainer::Container(Container::MovableList(l)) => Some(l),
        _ => None,
    }
}

impl EntryWriterV3 {
    /// The scope `path` leads to, made only when `path` is empty (the
    /// entry's own); a step that is not there is an error, and nothing is
    /// written for it.
    fn custom_scope(&self, module: &ModuleId, path: &[ItemStep]) -> Result<LoroMap> {
        let key = entry_key(module);
        let mut scope = if path.is_empty() {
            self.map.ensure_mergeable_map(&key)?
        } else {
            match self.map.get(&key) {
                Some(ValueOrContainer::Container(Container::Map(m))) => m,
                _ => return Err(missing(&path[0].item)),
            }
        };
        for step in path {
            let list = existing_list(&scope, &step.list).ok_or_else(|| missing(&step.item))?;
            scope = find_item(&list, &step.item)
                .ok_or_else(|| missing(&step.item))?
                .1;
        }
        Ok(scope)
    }

    /// Whether `path` leads to a scope (without writing anything).
    pub fn has_custom_scope(&self, module: &ModuleId, path: &[ItemStep]) -> bool {
        if path.is_empty() {
            return true;
        }
        let mut scope = match self.map.get(&entry_key(module)) {
            Some(ValueOrContainer::Container(Container::Map(m))) => m,
            _ => return false,
        };
        for step in path {
            let Some(list) = existing_list(&scope, &step.list) else {
                return false;
            };
            let Some((_, m)) = find_item(&list, &step.item) else {
                return false;
            };
            scope = m;
        }
        true
    }

    /// Whether the list `list` in the scope at `path` has item `item`.
    pub fn has_custom_item(
        &self,
        module: &ModuleId,
        path: &[ItemStep],
        list: &str,
        item: &str,
    ) -> bool {
        let mut full = path.to_vec();
        full.push(ItemStep {
            list: list.to_owned(),
            item: item.to_owned(),
        });
        self.has_custom_scope(module, &full)
    }

    /// Set (or with `None` clear) block `block`'s plain value in the scope
    /// at `path`.
    pub fn set_custom_value(
        &self,
        module: &ModuleId,
        path: &[ItemStep],
        block: &str,
        value: Option<&StoredValue>,
    ) -> Result<()> {
        if !self.has_custom_scope(module, path) {
            return Err(missing(block));
        }
        let scope = self.custom_scope(module, path)?;
        match value.and_then(encode_plain) {
            Some(v) => scope.insert(block, v)?,
            None => {
                if scope.get(block).is_some() {
                    scope.delete(block)?;
                }
            }
        }
        Ok(())
    }

    /// Add item `item` to list `list` in the scope at `path`, at `index`
    /// (`None`: last). Returns where it went.
    pub fn insert_custom_item(
        &self,
        module: &ModuleId,
        path: &[ItemStep],
        list: &str,
        index: Option<usize>,
        item: &ModuleItemId,
    ) -> Result<usize> {
        if !self.has_custom_scope(module, path) {
            return Err(missing(list));
        }
        let scope = self.custom_scope(module, path)?;
        let items = scope.ensure_mergeable_movable_list(&list_key(list))?;
        let at = index.unwrap_or(items.len()).min(items.len());
        let m = items.insert_container(at, LoroMap::new())?;
        m.insert(cv::ITEM_ID, item.as_str())?;
        Ok(at)
    }

    /// Take item `item` out of list `list` in the scope at `path`, with
    /// everything it keeps.
    pub fn remove_custom_item(
        &self,
        module: &ModuleId,
        path: &[ItemStep],
        list: &str,
        item: &str,
    ) -> Result<()> {
        if !self.has_custom_item(module, path, list, item) {
            return Err(missing(item));
        }
        let scope = self.custom_scope(module, path)?;
        let items = existing_list(&scope, list).ok_or_else(|| missing(item))?;
        let (at, _) = find_item(&items, item).ok_or_else(|| missing(item))?;
        items.delete(at, 1)?;
        Ok(())
    }

    /// Move item `item` of list `list` in the scope at `path` to `to`
    /// (clamped to the list). Its values move with it.
    pub fn move_custom_item(
        &self,
        module: &ModuleId,
        path: &[ItemStep],
        list: &str,
        item: &str,
        to: usize,
    ) -> Result<usize> {
        if !self.has_custom_item(module, path, list, item) {
            return Err(missing(item));
        }
        let scope = self.custom_scope(module, path)?;
        let items = existing_list(&scope, list).ok_or_else(|| missing(item))?;
        let (from, _) = find_item(&items, item).ok_or_else(|| missing(item))?;
        let to = to.min(items.len().saturating_sub(1));
        if from != to {
            items.mov(from, to)?;
        }
        Ok(to)
    }
}

/// Bring the values in `scope` back to `want` (a deep value read from an
/// older version of the same entry: an undo). Plain values are set or
/// cleared; a list keeps the items it still has (by id, with their
/// containers), loses the ones `want` does not have, gets back the ones it
/// lost and is put in `want`'s order. A list `want` does not have is
/// emptied, not dropped: its key stays (a mergeable list would come back
/// with its old items otherwise).
pub(crate) fn restore_scope(scope: &LoroMap, want: Option<&loro::LoroMapValue>) -> Result<()> {
    let empty = loro::LoroMapValue::default();
    let want = want.unwrap_or(&empty);
    let keys: Vec<String> = scope.keys().map(|k| k.to_string()).collect();
    for key in &keys {
        if key.starts_with(cv::LIST_PREFIX) || key == cv::ITEM_ID {
            continue;
        }
        if !want.contains_key(key) {
            scope.delete(key)?;
        }
    }
    for (key, value) in want.iter() {
        if key.starts_with(cv::LIST_PREFIX) || key == cv::ITEM_ID {
            continue;
        }
        scope.insert(key, value.clone())?;
    }
    let mut lists: Vec<String> = keys
        .iter()
        .filter(|k| k.starts_with(cv::LIST_PREFIX))
        .cloned()
        .collect();
    for key in want.keys() {
        if key.starts_with(cv::LIST_PREFIX) && !lists.contains(key) {
            lists.push(key.clone());
        }
    }
    for key in lists {
        let want_items: Vec<&loro::LoroMapValue> = match want.get(&key) {
            Some(LoroValue::List(items)) => items
                .iter()
                .filter_map(|i| match i {
                    LoroValue::Map(m) => Some(m),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        };
        let list = scope.ensure_mergeable_movable_list(&key)?;
        let id_of = |m: &loro::LoroMapValue| match m.get(cv::ITEM_ID) {
            Some(LoroValue::String(s)) => Some(s.to_string()),
            _ => None,
        };
        let wanted: Vec<String> = want_items.iter().filter_map(|m| id_of(m)).collect();
        // Out: the items `want` does not have.
        let mut i = 0;
        while i < list.len() {
            let keep = match list.get(i) {
                Some(ValueOrContainer::Container(Container::Map(m))) => match m.get(cv::ITEM_ID) {
                    Some(ValueOrContainer::Value(LoroValue::String(s))) => {
                        wanted.iter().any(|w| w.as_str() == s.as_str())
                    }
                    _ => false,
                },
                _ => false,
            };
            if keep {
                i += 1;
            } else {
                list.delete(i, 1)?;
            }
        }
        // In order: each wanted item at its place, back if it was gone.
        for (at, want_item) in want_items.iter().enumerate() {
            let Some(id) = id_of(want_item) else {
                continue;
            };
            let item = match find_item(&list, &id) {
                Some((from, m)) => {
                    if from != at {
                        list.mov(from, at)?;
                    }
                    m
                }
                None => {
                    let m = list.insert_container(at.min(list.len()), LoroMap::new())?;
                    m.insert(cv::ITEM_ID, id.as_str())?;
                    m
                }
            };
            restore_scope(&item, Some(want_item))?;
        }
    }
    Ok(())
}

/// Bring every `module:` key of an entry back to `old` (its deep value at
/// an older version): the keys `old` has are restored, the others emptied.
pub(crate) fn restore_entry_values(
    entry: &LoroMap,
    old: &dyn Fn(&str) -> Option<LoroValue>,
    old_keys: &[String],
) -> Result<()> {
    let mut keys: Vec<String> = entry
        .keys()
        .filter(|k| k.starts_with(cv::ENTRY_PREFIX))
        .map(|k| k.to_string())
        .collect();
    for k in old_keys {
        if k.starts_with(cv::ENTRY_PREFIX) && !keys.contains(k) {
            keys.push(k.clone());
        }
    }
    for key in keys {
        let want = old(&key);
        let want = match &want {
            Some(LoroValue::Map(m)) => Some(m),
            _ => None,
        };
        let scope = entry.ensure_mergeable_map(&key)?;
        restore_scope(&scope, want)?;
    }
    Ok(())
}
