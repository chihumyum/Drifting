//! The book (catalog) document: one per book.
//!
//! Every entity is a mergeable map under its root map, keyed by its uuidv7
//! id (`ensure_mergeable_map`), so the same entity written on two devices
//! (for example a library imported on both) merges field by field instead of
//! one side's container hiding the other's. Order is stored as numbers on the
//! entities (book and narrative order are authored coordinates with gaps, and
//! acts and time pins are boundaries on those axes), not as lists.

use std::collections::BTreeMap;

use loro::{
    CommitOptions, ExportMode, LoroDoc, LoroMap, LoroText, LoroTree, LoroValue, TreeParentId,
    ValueOrContainer,
};

use crate::ids::genesis_peer;
use crate::schema::{self, book};

pub const GENESIS_VERSION: u32 = 0;

/// Id of the built-in, locked relation type every book has. It is created by
/// the deterministic genesis, so it never exists twice.
pub fn generic_relation_type_id(book_id: &str) -> String {
    format!("rt-generic:{book_id}")
}

/// Deterministic genesis of a book document: `meta` and the built-in
/// relation type.
pub fn genesis(book_id: &str) -> Vec<u8> {
    let doc = LoroDoc::new();
    doc.config_text_style(schema::style_config());
    doc.set_peer_id(genesis_peer(&format!("book:{book_id}"), GENESIS_VERSION))
        .expect("genesis peer");
    let meta = doc.get_map(book::META);
    meta.insert("v", schema::SCHEMA_VERSION).unwrap();
    meta.insert("book", book_id).unwrap();
    let rt = doc
        .get_map(book::RELATION_TYPES)
        .ensure_mergeable_map(&generic_relation_type_id(book_id))
        .unwrap();
    rt.insert("name", "关联").unwrap();
    rt.insert("orientation", "symmetric").unwrap();
    rt.insert("system_key", "generic-association").unwrap();
    rt.insert("locked", true).unwrap();
    doc.commit_with(CommitOptions::new().timestamp(0));
    doc.export(ExportMode::all_updates())
        .expect("export genesis")
}

#[derive(Clone)]
pub struct Book {
    pub doc: LoroDoc,
}

/// Field values for an entity map.
pub type Fields = Vec<(&'static str, LoroValue)>;

impl Book {
    pub fn create(book_id: &str, peer: u64) -> Self {
        let doc = LoroDoc::new();
        schema::configure(&doc);
        doc.import(&genesis(book_id)).expect("import genesis");
        doc.set_peer_id(peer).expect("peer");
        Self { doc }
    }

    pub fn from_doc(doc: LoroDoc) -> Self {
        Self { doc }
    }

    /// Get or create the entity map `root[id]` and set `fields` on it.
    pub fn put(&self, root: &str, id: &str, fields: Fields) -> LoroMap {
        let map = self
            .doc
            .get_map(root)
            .ensure_mergeable_map(id)
            .expect("entity map");
        for (k, v) in fields {
            map.insert(k, v).expect("field");
        }
        map
    }

    pub fn entity(&self, root: &str, id: &str) -> Option<LoroMap> {
        match self.doc.get_map(root).get(id)? {
            ValueOrContainer::Container(loro::Container::Map(m)) => Some(m),
            _ => None,
        }
    }

    /// A rich-text field of an entity (comment and patch bodies).
    pub fn text_field(map: &LoroMap, key: &str) -> LoroText {
        map.ensure_mergeable_text(key).expect("text field")
    }

    /// A set field (aliases, storyline memberships): keys of a mergeable map.
    pub fn set_add(map: &LoroMap, key: &str, member: &str) {
        map.ensure_mergeable_map(key)
            .expect("set")
            .insert(member, true)
            .expect("member");
    }

    /// A key/value field list (facts, template fields): a mergeable map of
    /// entries, each `{key, value, order}`.
    pub fn kv_add(map: &LoroMap, key: &str, entry_id: &str, k: &str, v: &str, order: f64) {
        let entries = map.ensure_mergeable_map(key).expect("kv");
        let e = entries.ensure_mergeable_map(entry_id).expect("kv entry");
        e.insert("key", k).unwrap();
        e.insert("value", v).unwrap();
        e.insert("order", order).unwrap();
    }

    /// A tree root (drift groups, material folders). Tree nodes carry the
    /// domain id in their meta map; references use that id.
    pub fn tree(&self, root: &str) -> LoroTree {
        let tree = self.doc.get_tree(root);
        tree.enable_fractional_index(0);
        tree
    }

    pub fn tree_add(
        &self,
        root: &str,
        parent: Option<loro::TreeID>,
        id: &str,
        name: &str,
    ) -> loro::TreeID {
        let tree = self.tree(root);
        let parent = match parent {
            Some(p) => TreeParentId::Node(p),
            None => TreeParentId::Root,
        };
        let node = tree.create(parent).expect("tree node");
        let meta = tree.get_meta(node).expect("meta");
        meta.insert("id", id).unwrap();
        meta.insert("name", name).unwrap();
        node
    }

    /// A position anchor stored on an entity: two encoded cursors.
    pub fn put_anchor(map: &LoroMap, key: &str, start: Vec<u8>, end: Vec<u8>) {
        let a = map.ensure_mergeable_map(key).expect("anchor");
        a.insert("start", LoroValue::from(start)).unwrap();
        a.insert("end", LoroValue::from(end)).unwrap();
    }

    pub fn read_anchor(map: &LoroMap, key: &str) -> Option<(Vec<u8>, Vec<u8>)> {
        let ValueOrContainer::Container(loro::Container::Map(a)) = map.get(key)? else {
            return None;
        };
        let get = |k: &str| match a.get(k) {
            Some(ValueOrContainer::Value(LoroValue::Binary(b))) => Some(b.to_vec()),
            _ => None,
        };
        Some((get("start")?, get("end")?))
    }
}

/// What the shell needs to show a book: the chapter list and counts.
#[derive(Debug, Default)]
pub struct BookIndex {
    /// Chapter ids and titles in book order (ties broken by id), trashed ones
    /// excluded.
    pub chapters: Vec<(String, String)>,
    pub drifts: usize,
    pub acts: usize,
    pub elements: usize,
    pub categories: usize,
    pub storylines: usize,
    pub relations: usize,
    pub comments: usize,
    pub todos: usize,
    pub materials: usize,
    pub drift_groups: usize,
    pub material_folders: usize,
}

fn field<'a>(v: &'a LoroValue, key: &str) -> Option<&'a LoroValue> {
    match v {
        LoroValue::Map(m) => m.get(key),
        _ => None,
    }
}

fn as_str(v: Option<&LoroValue>) -> Option<&str> {
    match v {
        Some(LoroValue::String(s)) => Some(s.as_str()),
        _ => None,
    }
}

fn as_f64(v: Option<&LoroValue>) -> Option<f64> {
    match v {
        Some(LoroValue::Double(d)) => Some(*d),
        Some(LoroValue::I64(i)) => Some(*i as f64),
        _ => None,
    }
}

impl BookIndex {
    pub fn read(doc: &LoroDoc) -> Self {
        let mut out = BookIndex::default();
        let nodes = doc.get_map(book::NODES).get_deep_value();
        let mut chapters: Vec<(f64, String, String)> = Vec::new();
        if let LoroValue::Map(m) = &nodes {
            for (id, v) in m.iter() {
                if field(v, "deleted_at").is_some_and(|d| !d.is_null()) {
                    continue;
                }
                match as_str(field(v, "kind")) {
                    Some("chapter") => {
                        let order = as_f64(field(v, "book_order")).unwrap_or(f64::INFINITY);
                        let title = as_str(field(v, "title")).unwrap_or("").to_string();
                        chapters.push((order, id.clone(), title));
                    }
                    _ => out.drifts += 1,
                }
            }
        }
        chapters.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        out.chapters = chapters.into_iter().map(|(_, id, t)| (id, t)).collect();
        let count = |root: &str| doc.get_map(root).len();
        out.acts = count(book::ACTS);
        out.elements = count(book::ELEMENTS);
        out.categories = count(book::CATEGORIES);
        out.storylines = count(book::STORYLINES);
        out.relations = count(book::RELATIONS);
        out.materials = count(book::MATERIALS);
        let comments = doc.get_map(book::COMMENTS);
        comments.for_each(|_, v| {
            if let ValueOrContainer::Container(loro::Container::Map(m)) = v {
                match m.get("kind") {
                    Some(ValueOrContainer::Value(LoroValue::String(k))) if k.as_str() == "todo" => {
                        out.todos += 1
                    }
                    _ => out.comments += 1,
                }
            }
        });
        out.drift_groups = doc.get_tree(book::DRIFT_GROUPS).nodes().len();
        out.material_folders = doc.get_tree(book::MATERIAL_FOLDERS).nodes().len();
        out
    }
}

/// Every `deleted_at`-free entity map of `root`, as a value snapshot.
pub fn entities(doc: &LoroDoc, root: &str) -> BTreeMap<String, LoroValue> {
    match doc.get_map(root).get_deep_value() {
        LoroValue::Map(m) => m.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        _ => BTreeMap::new(),
    }
}

/// A list value helper.
pub fn list_of(items: &[&str]) -> LoroValue {
    LoroValue::List(
        items
            .iter()
            .map(|s| LoroValue::from(*s))
            .collect::<Vec<_>>()
            .into(),
    )
}
