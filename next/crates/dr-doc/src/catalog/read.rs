//! Tree normalization and snapshots shared by import replay and canonical v3.
use super::fields::F;
use crate::schema::book_v3 as book;
use dr_model::id::*;
use dr_model::shared::*;
use loro::{LoroDoc, LoroTree, LoroValue, TreeID, TreeParentId};
use std::collections::{HashMap, HashSet};
/// An entity's stored fields at some version, for restoring them
/// (`BookTxn::restore_fields`). Read from a detached copy at a history point.
#[derive(Clone, Debug)]
pub struct EntitySnapshot {
    value: LoroValue,
    texts: HashSet<String>,
}
impl EntitySnapshot {
    /// The stored value of one field (a set or a key/value list reads as a
    /// map, a rich text as its plain text). `None` when the field is absent.
    pub fn field(&self, key: &str) -> Option<&LoroValue> {
        F(&self.value).get(key)
    }

    pub(crate) fn value(&self, key: &str) -> Option<&LoroValue> {
        self.field(key)
    }

    pub(crate) fn is_text(&self, key: &str) -> bool {
        self.texts.contains(key)
    }

    /// The stored keys.
    pub fn keys(&self) -> Vec<String> {
        match &self.value {
            LoroValue::Map(m) => {
                let mut v: Vec<String> = m.keys().cloned().collect();
                v.sort();
                v
            }
            _ => Vec::new(),
        }
    }

    /// The fields that differ between `self` (before) and `after`, by key:
    /// `(key, before, after)`, `None` for an absent field. For comparing an
    /// entity before an Agent write, after it, and now.
    pub fn diff(
        &self,
        after: &EntitySnapshot,
    ) -> Vec<(String, Option<LoroValue>, Option<LoroValue>)> {
        let mut keys: Vec<String> = self.keys();
        keys.extend(after.keys());
        keys.sort();
        keys.dedup();
        keys.into_iter()
            .filter_map(|k| {
                let (a, b) = (self.field(&k), after.field(&k));
                (a != b).then(|| (k, a.cloned(), b.cloned()))
            })
            .collect()
    }
}
fn entities(doc: &LoroDoc, root: &str) -> Vec<(String, LoroValue)> {
    match doc.get_map(root).get_deep_value() {
        LoroValue::Map(m) => {
            let mut v: Vec<(String, LoroValue)> =
                m.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
            v.sort_by(|a, b| a.0.cmp(&b.0));
            v
        }
        _ => Vec::new(),
    }
}
/// One node of a tree read at the domain level.
pub(crate) struct ForestNode {
    pub(crate) id: String,
    pub(crate) parent: Option<String>,
    pub(crate) meta: LoroValue,
    /// Every live tree node carrying this domain id (the kept one first).
    pub(crate) tree_ids: Vec<TreeID>,
    pub(crate) pos: String,
}
/// A tree read by domain id. Normally each domain id has one tree node, but
/// two devices can create a node for the same id (two imports that did not
/// dedupe): then the first by tree id is kept for name and parent, and the
/// children of every copy are its children. Nodes are listed depth first from
/// the roots, parents before children, siblings in tree order; a node only
/// reachable through a cycle of copies (possible at the domain level, never in
/// Loro's own tree) is not listed, and readers treat it as missing.
pub(crate) fn forest(tree: &LoroTree) -> Vec<ForestNode> {
    let nodes = tree
        .get_nodes(false)
        .into_iter()
        .filter_map(|n| {
            Some((
                n.id,
                n.parent,
                tree.get_meta(n.id).ok()?.get_deep_value(),
                tree.fractional_index(n.id).unwrap_or_default(),
            ))
        })
        .collect();
    normalize_forest(nodes)
}
/// The exact same duplicate-ID and ordering rules, over an atomic deep-value
/// snapshot rather than repeated reads of an internally mutable LoroTree.
pub(crate) fn forest_value(value: &LoroValue) -> Vec<ForestNode> {
    let mut nodes = Vec::new();
    let mut stack = vec![value];
    while let Some(value) = stack.pop() {
        let LoroValue::List(items) = value else {
            continue;
        };
        for node in items.iter() {
            let f = F(node);
            if let Some(children) = f.get("children") {
                stack.push(children);
            }
            let Some(tree_id) = f
                .opt_string("id")
                .and_then(|id| TreeID::try_from(id.as_str()).ok())
            else {
                continue;
            };
            let parent = f
                .opt_string("parent")
                .and_then(|id| TreeID::try_from(id.as_str()).ok())
                .map_or(TreeParentId::Root, TreeParentId::Node);
            if let Some(meta) = f.get("meta") {
                nodes.push((tree_id, parent, meta.clone(), f.string("fractional_index")));
            }
        }
    }
    normalize_forest(nodes)
}
fn normalize_forest(mut nodes: Vec<(TreeID, TreeParentId, LoroValue, String)>) -> Vec<ForestNode> {
    nodes.sort_by_key(|n| n.0);
    let mut dom: HashMap<TreeID, String> = HashMap::new();
    let mut kept: HashMap<String, (TreeID, TreeParentId, LoroValue, String)> = HashMap::new();
    let mut copies: HashMap<String, Vec<TreeID>> = HashMap::new();
    for (tree_id, parent, v, pos) in nodes {
        let Some(id) = F(&v).opt_string("id") else {
            continue;
        };
        dom.insert(tree_id, id.clone());
        copies.entry(id.clone()).or_default().push(tree_id);
        kept.entry(id).or_insert((tree_id, parent, v, pos));
    }
    let parent_of = |id: &str| -> Option<String> {
        let (_, parent, _, _) = &kept[id];
        match parent {
            TreeParentId::Node(p) => dom.get(p).filter(|d| d.as_str() != id).cloned(),
            _ => None,
        }
    };
    // Children per parent domain id, in tree order (fractional index, then
    // tree id), merged over every copy of the parent.
    let mut children: HashMap<Option<String>, Vec<(String, TreeID, String)>> = HashMap::new();
    for (id, (t, _, _, key)) in &kept {
        children
            .entry(parent_of(id))
            .or_default()
            .push((key.clone(), *t, id.clone()));
    }
    for v in children.values_mut() {
        v.sort();
    }
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut stack: Vec<String> = children
        .get(&None)
        .map(|v| v.iter().rev().map(|(_, _, id)| id.clone()).collect())
        .unwrap_or_default();
    while let Some(id) = stack.pop() {
        if !seen.insert(id.clone()) {
            continue;
        }
        if let Some(kids) = children.get(&Some(id.clone())) {
            for (_, _, k) in kids.iter().rev() {
                stack.push(k.clone());
            }
        }
        let (_, _, meta, pos) = kept[&id].clone();
        out.push(ForestNode {
            parent: parent_of(&id),
            tree_ids: copies.remove(&id).unwrap_or_default(),
            meta,
            pos,
            id,
        });
    }
    out
}
#[derive(Clone, Copy)]
pub(crate) struct CatalogView<'a> {
    pub(crate) doc: &'a LoroDoc,
}
impl CatalogView<'_> {
    pub fn assets(&self) -> Vec<Asset> {
        entities(self.doc, book::ASSETS)
            .iter()
            .filter_map(|(id, v)| {
                let f = F(v);
                Some(Asset {
                    id: AssetId::parse(id).ok()?,
                    kind: f.kind("kind")?,
                    mime: f.string("mime"),
                    size: f.i64("size").unwrap_or(0),
                    sha256: f.string("sha256"),
                    width: f.i64("width"),
                    height: f.i64("height"),
                })
            })
            .collect()
    }
    pub(crate) fn tree(&self, root: &str) -> LoroTree {
        self.doc.get_tree(root)
    }
    pub(crate) fn tree_index(&self, root: &str) -> HashMap<String, Vec<TreeID>> {
        forest(&self.tree(root))
            .into_iter()
            .map(|n| (n.id, n.tree_ids))
            .collect()
    }
    pub fn entity_snapshot(&self, root: &str, id: &str) -> Option<EntitySnapshot> {
        let loro::ValueOrContainer::Container(loro::Container::Map(m)) =
            self.doc.get_map(root).get(id)?
        else {
            return None;
        };
        let mut texts = HashSet::new();
        m.for_each(|k, v| {
            if matches!(
                v,
                loro::ValueOrContainer::Container(loro::Container::Text(_))
            ) {
                texts.insert(k.to_string());
            }
        });
        Some(EntitySnapshot {
            value: m.get_deep_value(),
            texts,
        })
    }
}
