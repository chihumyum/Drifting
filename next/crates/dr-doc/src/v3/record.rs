//! The stored state of one independently guarded part of a v3 book document
//! (`docs/rust-rewrite/foundations/f3-write-guards.md`).
//!
//! A book document holds every structural collection of a book, so its
//! frontier moves on any write. A write guard compares the part a write
//! depends on instead: this module reads that part's own stored state, hidden
//! and retained fields included, straight from the document it is given. It
//! never exports, imports or decodes the rest of the book.

use std::collections::HashMap;

use loro::{Container, LoroDoc, LoroMap, LoroTree, LoroValue, TreeID, TreeParentId};
use serde_json::{Value, json};

use super::CollectionV3;
use super::read::BookViewV3;

/// One part of a v3 book document.
///
/// `path` walks from the collection's root: empty is the whole collection,
/// one segment is a record (a map key, or the domain id of a tree node), more
/// segments are a value inside that record. A shorter path contains every
/// longer one that starts with it.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct RecordKeyV3 {
    pub collection: CollectionV3,
    pub path: Vec<String>,
    /// Tree collections only: the ordered resident children of the node at
    /// `path` (empty: the roots) instead of the node's own state.
    pub children: bool,
}

impl RecordKeyV3 {
    pub fn collection(collection: CollectionV3) -> Self {
        Self {
            collection,
            path: Vec::new(),
            children: false,
        }
    }

    pub fn record(collection: CollectionV3, id: impl Into<String>) -> Self {
        Self {
            collection,
            path: vec![id.into()],
            children: false,
        }
    }

    pub fn children(collection: CollectionV3, parent: Option<&str>) -> Self {
        Self {
            collection,
            path: parent.map(str::to_owned).into_iter().collect(),
            children: true,
        }
    }

    /// The same key, one or more segments deeper.
    pub fn at<S: Into<String>>(mut self, segments: impl IntoIterator<Item = S>) -> Self {
        self.path.extend(segments.into_iter().map(Into::into));
        self
    }

    /// Whether a fresh read of `self` is also a fresh read of `other`.
    pub fn contains(&self, other: &RecordKeyV3) -> bool {
        self.collection == other.collection
            && !self.children
            && !other.children
            && other.path.starts_with(&self.path)
    }

    /// Whether this key names something a v3 book document can hold.
    pub fn is_valid(&self) -> bool {
        if self.children {
            self.collection.is_tree() && self.path.len() <= 1
        } else {
            true
        }
    }
}

impl std::fmt::Display for RecordKeyV3 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.collection.root())?;
        for segment in &self.path {
            write!(f, "/{segment}")?;
        }
        if self.children {
            f.write_str("/*")?;
        }
        Ok(())
    }
}

/// What a guard compares, and what a caller may inspect.
#[derive(Clone, Debug, PartialEq)]
pub struct RecordStateV3 {
    /// The stored content of the record, hidden and retained fields included:
    /// its deep value (for an entry, with its residence). Two reads are the
    /// same record state exactly when this is equal. One read of each record
    /// is all it takes, so a view can afford the digest of everything it
    /// shows; what it leaves out is how a nested value is stored (as a
    /// container or a plain value) and the formatting of nested text.
    /// Every object in it is in key order, whatever order its keys were
    /// written in and however Loro holds them: equal content is equal bytes.
    pub raw: Value,
    /// The plain deep value queries decode (`null` when absent), so a caller
    /// can tell whether a filtered read showed everything that is stored.
    pub value: Value,
    single: bool,
}

impl RecordStateV3 {
    /// The value, when this state is one plain stored value, or nothing
    /// stored (`null`). `None` for every container (a record, a list, a
    /// text), for a value inside a plain map or below a container that is
    /// not a map, and for an entry id with more than one node: writing it
    /// would replace something this state does not name.
    pub fn single(&self) -> Option<&Value> {
        self.single.then_some(&self.value)
    }
}

/// How the addressed value is stored.
#[derive(Clone, Copy, PartialEq)]
enum Stored {
    Absent,
    Plain,
    Container,
    /// Inside a plain value, or below a text, list or tree.
    Inside,
}

/// A Loro value as plain JSON, every object in key order.
///
/// Loro hands a map value over as a hash map, and a JSON object here keeps
/// the order it was filled in. Left alone, the bytes of a record state would
/// follow how that hash map happened to be built, not what it holds. The
/// order is fixed here, by construction, so that equal content always
/// serializes to equal bytes.
fn plain(value: &LoroValue) -> Value {
    match value {
        LoroValue::Map(map) => {
            let mut entries: Vec<(&String, &LoroValue)> = map.iter().collect();
            entries.sort_unstable_by_key(|(key, _)| *key);
            Value::Object(
                entries
                    .into_iter()
                    .map(|(key, value)| (key.clone(), plain(value)))
                    .collect(),
            )
        }
        LoroValue::List(list) => Value::Array(list.iter().map(plain).collect()),
        other => serde_json::to_value(other).expect("Loro values serialize"),
    }
}

/// The content at `path` below `map` (`None`: nothing there), and how it is
/// stored.
fn walk(map: &LoroMap, path: &[String]) -> (Option<Value>, Stored) {
    let Some((first, rest)) = path.split_first() else {
        return (Some(plain(&map.get_deep_value())), Stored::Container);
    };
    match map.get(first) {
        None => (None, Stored::Absent),
        Some(loro::ValueOrContainer::Value(value)) if rest.is_empty() => {
            (Some(plain(&value)), Stored::Plain)
        }
        Some(found) if rest.is_empty() => (Some(plain(&found.get_deep_value())), Stored::Container),
        Some(loro::ValueOrContainer::Container(Container::Map(inner))) => walk(&inner, rest),
        // Inside a plain value: content, but not a stored value of its own.
        Some(loro::ValueOrContainer::Value(value)) => {
            let mut current = Some(&value);
            for segment in rest {
                current = match current {
                    Some(LoroValue::Map(m)) => m.get(segment.as_str()),
                    _ => None,
                };
            }
            (current.map(plain), Stored::Inside)
        }
        // A text, list or tree has no keyed children to select.
        Some(loro::ValueOrContainer::Container(_)) => (None, Stored::Inside),
    }
}

/// Present content and absence never read the same, whatever is stored.
fn content(found: Option<Value>) -> Value {
    match found {
        Some(value) => json!({"is": value}),
        None => json!({"absent": true}),
    }
}

fn state(found: Option<Value>, stored: Stored) -> RecordStateV3 {
    RecordStateV3 {
        value: found.clone().unwrap_or(Value::Null),
        raw: content(found),
        single: matches!(stored, Stored::Absent | Stored::Plain),
    }
}

/// Reads record states of one book document, indexing each tree once.
pub struct RecordReaderV3<'a> {
    doc: &'a LoroDoc,
    trees: HashMap<CollectionV3, TreeIndex>,
}

struct TreeIndex {
    tree: LoroTree,
    /// Domain id of every live tree node.
    domain: HashMap<TreeID, String>,
    /// Live tree nodes carrying a domain id, in tree-id order.
    nodes: HashMap<String, Vec<TreeID>>,
}

impl TreeIndex {
    fn new(tree: LoroTree) -> Self {
        let mut raw = tree.get_nodes(false);
        raw.sort_by_key(|n| n.id);
        let mut domain = HashMap::new();
        let mut nodes: HashMap<String, Vec<TreeID>> = HashMap::new();
        for node in raw {
            let Some(loro::ValueOrContainer::Value(LoroValue::String(id))) =
                tree.get_meta(node.id).ok().and_then(|m| m.get("id"))
            else {
                continue;
            };
            domain.insert(node.id, id.to_string());
            nodes.entry(id.to_string()).or_default().push(node.id);
        }
        Self {
            tree,
            domain,
            nodes,
        }
    }

    fn parent(&self, node: TreeID) -> Option<&str> {
        match self.tree.parent(node)? {
            TreeParentId::Node(parent) => self.domain.get(&parent).map(String::as_str),
            _ => None,
        }
    }

    fn child_ids(&self, parent: Option<TreeID>) -> Vec<Value> {
        let parent = parent.map_or(TreeParentId::Root, TreeParentId::Node);
        self.tree
            .children(parent)
            .unwrap_or_default()
            .into_iter()
            .map(|child| match self.domain.get(&child) {
                Some(id) => Value::String(id.clone()),
                // A node without a domain id is not an entry, but it does
                // occupy a place among its siblings.
                None => json!({"node": child.to_string()}),
            })
            .collect()
    }
}

impl<'a> RecordReaderV3<'a> {
    pub fn new(view: &BookViewV3<'a>) -> Self {
        Self {
            doc: view.doc,
            trees: HashMap::new(),
        }
    }

    fn tree(&mut self, collection: CollectionV3) -> &TreeIndex {
        let doc = self.doc;
        self.trees
            .entry(collection)
            .or_insert_with(|| TreeIndex::new(doc.get_tree(collection.root())))
    }

    /// The stored state `key` names. An invalid key reads as absent.
    pub fn state(&mut self, key: &RecordKeyV3) -> RecordStateV3 {
        if !key.is_valid() {
            return state(None, Stored::Absent);
        }
        if key.collection.is_tree() {
            self.tree_state(key)
        } else {
            let (found, stored) = walk(&self.doc.get_map(key.collection.root()), &key.path);
            state(found, stored)
        }
    }

    fn tree_state(&mut self, key: &RecordKeyV3) -> RecordStateV3 {
        let index = self.tree(key.collection);
        let order = |children: Vec<Value>| RecordStateV3 {
            raw: json!({"children": children}),
            value: Value::Array(children),
            single: false,
        };
        let Some((id, rest)) = key.path.split_first() else {
            if key.children {
                return order(index.child_ids(None));
            }
            // The whole tree: every node's metadata, and where it hangs.
            return state(
                Some(plain(&index.tree.get_value_with_meta())),
                Stored::Container,
            );
        };
        // Two devices can each create a node for one domain id. Every copy is
        // part of the record: a guard must notice a change to any of them.
        let Some(copies) = index.nodes.get(id) else {
            return state(None, Stored::Absent);
        };
        if key.children {
            return order(
                copies
                    .iter()
                    .flat_map(|node| index.child_ids(Some(*node)))
                    .collect(),
            );
        }
        let mut raw = Vec::new();
        let mut first = None;
        for node in copies {
            let Ok(meta) = index.tree.get_meta(*node) else {
                continue;
            };
            let (found, stored) = if rest.is_empty() {
                let own =
                    json!({"meta": plain(&meta.get_deep_value()), "parent": index.parent(*node)});
                (Some(own), Stored::Container)
            } else {
                walk(&meta, rest)
            };
            raw.push(content(found.clone()));
            first.get_or_insert((found, stored));
        }
        let (found, stored) = first.unwrap_or((None, Stored::Absent));
        RecordStateV3 {
            raw: json!({"nodes": raw}),
            // The first copy is the one readers show.
            value: found.unwrap_or(Value::Null),
            single: copies.len() == 1 && matches!(stored, Stored::Absent | Stored::Plain),
        }
    }
}

impl<'a> BookViewV3<'a> {
    /// The stored state of one part of this book document.
    pub fn record_state(&self, key: &RecordKeyV3) -> RecordStateV3 {
        RecordReaderV3::new(self).state(key)
    }
}

#[cfg(test)]
mod tests {
    use dr_model::Origin;
    use dr_model::id::{BookId, EntryId, EntryTemplateId, ModuleId, PatchId};

    use super::*;
    use crate::v3::novel::{NovelRootEntries, TPL_CHAPTER, apply_novel_project_template};
    use crate::v3::{BookDocV3, CollectionV3 as C};

    fn book() -> (BookDocV3, NovelRootEntries) {
        let mut doc = BookDocV3::create(BookId::parse("b-records").unwrap(), 1).unwrap();
        let (roots, _) = doc.edit(Origin::User, apply_novel_project_template);
        (doc, roots.unwrap())
    }

    fn chapter(doc: &mut BookDocV3, parent: &EntryId, id: &str, title: &str) -> EntryId {
        let id = EntryId::parse(id).unwrap();
        let template = EntryTemplateId::parse(TPL_CHAPTER).unwrap();
        let (r, _) = doc.edit(Origin::User, |t| {
            t.entries()
                .create(&id, Some(parent), title, Some(&template))?;
            Ok(())
        });
        r.unwrap();
        id
    }

    fn raw(doc: &BookDocV3, key: &RecordKeyV3) -> Value {
        doc.view().record_state(key).raw
    }

    /// What a digest is taken over.
    fn bytes(doc: &BookDocV3, key: &RecordKeyV3) -> String {
        let raw = raw(doc, key);
        assert_key_order(&raw);
        serde_json::to_string(&raw).unwrap()
    }

    fn assert_key_order(value: &Value) {
        match value {
            Value::Object(map) => {
                let keys: Vec<&String> = map.keys().collect();
                assert!(keys.windows(2).all(|pair| pair[0] < pair[1]), "{keys:?}");
                map.values().for_each(assert_key_order);
            }
            Value::Array(items) => items.iter().for_each(assert_key_order),
            _ => {}
        }
    }

    const NAMES: usize = 48;

    fn name(i: usize) -> String {
        format!("key-{:02}-{}", (i * 37) % NAMES, "x".repeat(i % 5))
    }

    /// The same record of a map collection, a nested map included, written
    /// in one of two orders; the second also writes and deletes other keys
    /// on the way.
    fn write_record(doc: &BookDocV3, id: &str, scrambled: bool) {
        let loro = doc.view().doc;
        let record = loro
            .get_map(C::Facts.root())
            .ensure_mergeable_map(id)
            .unwrap();
        let nested = record.ensure_mergeable_map("nested").unwrap();
        let mut order: Vec<usize> = (0..NAMES).collect();
        if scrambled {
            order.reverse();
            for i in 0..NAMES {
                record.insert(&format!("gone-{i}"), true).unwrap();
                nested.insert(&format!("gone-{i}"), true).unwrap();
            }
            loro.commit();
        }
        for i in order {
            record.insert(&name(i), i as i64).unwrap();
            nested.insert(&name(i), format!("value {i}")).unwrap();
            if scrambled && i % 3 == 0 {
                record.delete(&format!("gone-{i}")).unwrap();
                loro.commit();
            }
        }
        if scrambled {
            for i in 0..NAMES {
                record.delete(&format!("gone-{i}")).unwrap();
                nested.delete(&format!("gone-{i}")).unwrap();
            }
        }
        loro.commit();
    }

    #[test]
    fn a_map_value_reads_in_key_order_however_it_is_held() {
        let entries = || (0..NAMES).map(|i| (name(i), LoroValue::from(i as i64)));
        let small = LoroValue::from(entries().collect::<HashMap<_, _>>());
        // The same content in a table of another size, filled in another
        // order with other keys coming and going.
        let mut held = loro::LoroMapValue::from(HashMap::<String, LoroValue>::new());
        let table = held.make_mut();
        table.reserve(4096);
        for i in 0..NAMES {
            table.insert(format!("gone-{i}"), LoroValue::from(true));
        }
        let mut reversed: Vec<_> = entries().collect();
        reversed.reverse();
        for (key, value) in reversed {
            table.insert(key, value);
        }
        for i in 0..NAMES {
            table.remove(&format!("gone-{i}"));
        }
        let large = LoroValue::Map(held);
        assert_eq!(small, large);
        // The premise: the two hand their keys over in different orders,
        // which is what serializing them as they come would write down.
        let held_order = |value: &LoroValue| match value {
            LoroValue::Map(map) => map.keys().cloned().collect::<Vec<_>>(),
            _ => unreachable!(),
        };
        assert_ne!(held_order(&small), held_order(&large));

        let nest = |inner: &LoroValue| {
            LoroValue::from(HashMap::from([
                ("list".to_owned(), LoroValue::from(vec![inner.clone()])),
                ("map".to_owned(), inner.clone()),
            ]))
        };
        let (a, b) = (plain(&nest(&small)), plain(&nest(&large)));
        assert_key_order(&a);
        assert_eq!(
            serde_json::to_string(&a).unwrap(),
            serde_json::to_string(&b).unwrap()
        );
    }

    #[test]
    fn the_same_content_is_the_same_bytes_whatever_order_it_was_written_in() {
        let (first, _) = book();
        let (second, _) = book();
        write_record(&first, "f-order", false);
        write_record(&second, "f-order", true);
        let record = RecordKeyV3::record(C::Facts, "f-order");
        for key in [
            record.clone(),
            record.clone().at(["nested"]),
            RecordKeyV3::collection(C::Facts),
        ] {
            assert_eq!(bytes(&first, &key), bytes(&second, &key), "{key}");
        }
        // One more key is other content.
        let before = bytes(&second, &record);
        second
            .view()
            .doc
            .get_map(C::Facts.root())
            .ensure_mergeable_map("f-order")
            .unwrap()
            .insert("one-more", 1)
            .unwrap();
        second.view().doc.commit();
        assert_ne!(before, bytes(&second, &record));
    }

    #[test]
    fn a_record_reads_the_same_before_and_after_its_containers_are_decoded() {
        let (mut doc, roots) = book();
        let entry = chapter(&mut doc, &roots.manuscript, "e-lazy", "Lazy");
        write_record(&doc, "f-lazy", true);
        let keys = [
            RecordKeyV3::record(C::Facts, "f-lazy"),
            RecordKeyV3::record(C::Facts, "f-lazy").at(["nested"]),
            RecordKeyV3::collection(C::Facts),
            RecordKeyV3::record(C::Entries, entry.as_str()),
            RecordKeyV3::record(C::Entries, roots.manuscript.as_str()),
            RecordKeyV3::children(C::Entries, Some(roots.manuscript.as_str())),
            RecordKeyV3::collection(C::Entries),
            RecordKeyV3::collection(C::Templates),
        ];
        let read = |doc: &BookDocV3| keys.each_ref().map(|key| bytes(doc, key));
        let written = read(&doc);

        // A document loaded from a snapshot decodes a container only when
        // something needs its state: this first read comes before that.
        let loaded =
            BookDocV3::load(doc.book_id().clone(), 7, &[doc.export_snapshot().unwrap()]).unwrap();
        let lazy = read(&loaded);
        assert_eq!(written, lazy);

        // Reads through the typed view, key lookups and a write next to the
        // record all decode what they touch.
        let loro = loaded.view().doc;
        let facts = loro.get_map(C::Facts.root());
        let record = facts.ensure_mergeable_map("f-lazy").unwrap();
        assert!(record.get(&name(1)).is_some());
        loaded.view().templates();
        record.insert("passing", true).unwrap();
        loro.commit();
        record.delete("passing").unwrap();
        loro.commit();
        facts
            .ensure_mergeable_map("f-other")
            .unwrap()
            .insert("k", 1)
            .unwrap();
        loro.commit();
        facts.delete("f-other").unwrap();
        loro.commit();
        let mut loaded = loaded;
        chapter(&mut loaded, &roots.ideas, "e-elsewhere", "Elsewhere");
        let decoded = read(&loaded);
        // The entry created elsewhere is in the whole tree, and nowhere else.
        assert_eq!(lazy[..6], decoded[..6]);
        assert_ne!(lazy[6], decoded[6]);
        assert_eq!(lazy[7], decoded[7]);
    }

    #[test]
    fn a_record_state_is_its_own_stored_state_only() {
        let (mut doc, roots) = book();
        let entry = chapter(&mut doc, &roots.manuscript, "e-owner", "Owner");
        let module = ModuleId::parse("mod-patches").unwrap();
        let (p, q) = (
            PatchId::parse("p-one").unwrap(),
            PatchId::parse("p-two").unwrap(),
        );
        let put = |doc: &mut BookDocV3, id: &PatchId, title: &str, body: &str| {
            let (r, _) = doc.edit(Origin::User, |t| {
                t.patch(id)?
                    .entry(&entry)?
                    .module(&module)?
                    .title(Some(title))?
                    .body(body)?;
                Ok(())
            });
            r.unwrap();
        };
        put(&mut doc, &p, "one", "first body");
        put(&mut doc, &q, "two", "second body");
        let record = RecordKeyV3::record(C::Patches, p.as_str());
        let title = record.clone().at(["title"]);
        let body = record.clone().at(["body"]);
        let all = RecordKeyV3::collection(C::Patches);
        let before = [&record, &title, &body, &all].map(|k| raw(&doc, k));
        // The body is a text: its content is its string, and it is not one
        // plain value an expected value could stand for.
        assert_eq!(before[2], json!({"is": "first body"}));
        assert_eq!(doc.view().record_state(&body).value, "first body");
        assert!(doc.view().record_state(&body).single().is_none());
        assert_eq!(
            doc.view().record_state(&title).single(),
            Some(&json!("one"))
        );

        // Another record of the same collection.
        put(&mut doc, &q, "two", "second body, edited");
        let other = [&record, &title, &body, &all].map(|k| raw(&doc, k));
        assert_eq!(before[..3], other[..3]);
        assert_ne!(before[3], other[3]);

        // One field of this record.
        put(&mut doc, &p, "one, renamed", "first body");
        let own = [&record, &title, &body].map(|k| raw(&doc, k));
        assert_ne!(other[0], own[0]);
        assert_ne!(other[1], own[1]);
        assert_eq!(other[2], own[2]);
    }

    #[test]
    fn an_entry_record_is_its_metadata_and_residence_and_children_are_an_order() {
        let (mut doc, roots) = book();
        let a = chapter(&mut doc, &roots.manuscript, "e-a", "A");
        let b = chapter(&mut doc, &roots.manuscript, "e-b", "B");
        let entry = |id: &EntryId| RecordKeyV3::record(C::Entries, id.as_str());
        let children = |id: &EntryId| RecordKeyV3::children(C::Entries, Some(id.as_str()));
        let state = doc.view().record_state(&entry(&a));
        assert_eq!(state.value["meta"]["title"], "A");
        assert_eq!(state.value["parent"], roots.manuscript.as_str());
        assert_eq!(
            doc.view().record_state(&children(&roots.manuscript)).value,
            json!(["e-a", "e-b"])
        );
        let before = (
            raw(&doc, &entry(&a)),
            raw(&doc, &entry(&b)),
            raw(&doc, &children(&roots.manuscript)),
            raw(&doc, &children(&roots.ideas)),
        );

        // A sibling's own change is neither this entry's nor the order's.
        let (r, _) = doc.edit(Origin::User, |t| {
            t.entries().entry(&b)?.title("B, renamed")?;
            Ok(())
        });
        r.unwrap();
        assert_eq!(before.0, raw(&doc, &entry(&a)));
        assert_ne!(before.1, raw(&doc, &entry(&b)));
        assert_eq!(before.2, raw(&doc, &children(&roots.manuscript)));

        // A move changes the entry's residence and both orders.
        let (r, _) = doc.edit(Origin::User, |t| {
            t.entries().move_to(&a, Some(&roots.ideas))
        });
        r.unwrap();
        assert_ne!(before.0, raw(&doc, &entry(&a)));
        assert_ne!(before.2, raw(&doc, &children(&roots.manuscript)));
        assert_ne!(before.3, raw(&doc, &children(&roots.ideas)));
        assert_eq!(
            raw(&doc, &entry(&a).at(["title"])),
            json!({"nodes": [{"is": "A"}]})
        );
    }

    #[test]
    fn every_copy_of_one_entry_id_is_part_of_its_record() {
        let (mut doc, roots) = book();
        let mut remote =
            BookDocV3::load(doc.book_id().clone(), 42, &[doc.export_snapshot().unwrap()]).unwrap();
        // Two devices each create a node for the same id, then merge.
        let id = chapter(&mut doc, &roots.manuscript, "e-twice", "Here");
        chapter(&mut remote, &roots.ideas, "e-twice", "There");
        doc.import(
            &remote.export_updates_since(&doc.version()).unwrap(),
            Origin::Sync,
        )
        .unwrap();
        let key = RecordKeyV3::record(C::Entries, id.as_str());
        let state = doc.view().record_state(&key);
        let nodes = state.raw["nodes"].as_array().unwrap();
        assert_eq!(nodes.len(), 2, "{}", state.raw);
        let mut titles: Vec<&str> = nodes
            .iter()
            .map(|n| n["is"]["meta"]["title"].as_str().unwrap())
            .collect();
        titles.sort_unstable();
        assert_eq!(titles, ["Here", "There"]);

        // The same content on another device is the same state.
        remote
            .import(
                &doc.export_updates_since(&remote.version()).unwrap(),
                Origin::Sync,
            )
            .unwrap();
        for key in [
            key.clone(),
            RecordKeyV3::collection(C::Entries),
            RecordKeyV3::children(C::Entries, None),
            RecordKeyV3::collection(C::Templates),
        ] {
            assert_eq!(raw(&doc, &key), raw(&remote, &key), "{key}");
        }
    }

    #[test]
    fn what_is_not_stored_reads_as_absent() {
        let (doc, roots) = book();
        let absent = json!({"absent": true});
        for key in [
            RecordKeyV3::record(C::Patches, "p-none"),
            RecordKeyV3::record(C::Entries, "e-none"),
            RecordKeyV3::children(C::Entries, Some("e-none")),
            // Only a tree has children, and only of a node.
            RecordKeyV3::children(C::Patches, None),
            RecordKeyV3::children(C::Entries, Some(roots.manuscript.as_str())).at(["deeper"]),
        ] {
            let state = doc.view().record_state(&key);
            assert_eq!(state.raw, absent, "{key}");
            assert!(state.value.is_null(), "{key}");
        }
        // An entry that exists, without the value: the node is there.
        let key = RecordKeyV3::record(C::Entries, roots.manuscript.as_str()).at(["no-such-field"]);
        let state = doc.view().record_state(&key);
        assert_eq!(state.raw, json!({"nodes": [absent]}), "{key}");
        assert_eq!(state.single(), Some(&Value::Null));
        // Below a plain value there is nothing stored on its own: not a
        // single value, so an expected value never matches it.
        let key =
            RecordKeyV3::record(C::Entries, roots.manuscript.as_str()).at(["title", "deeper"]);
        let state = doc.view().record_state(&key);
        assert_eq!(state.raw, json!({"nodes": [absent]}), "{key}");
        assert!(state.value.is_null() && state.single().is_none(), "{key}");
        let title = RecordKeyV3::record(C::Entries, roots.manuscript.as_str()).at(["title"]);
        assert!(
            doc.view()
                .record_state(&title)
                .single()
                .is_some_and(Value::is_string)
        );
        // A collection nothing was ever written to is empty, read or not.
        let empty = raw(&doc, &RecordKeyV3::collection(C::Patches));
        doc.view().patches();
        assert_eq!(empty, raw(&doc, &RecordKeyV3::collection(C::Patches)));
        assert_eq!(empty, json!({"is": {}}));

        let record = RecordKeyV3::record(C::TimelineViews, "v");
        assert!(RecordKeyV3::collection(C::TimelineViews).contains(&record));
        assert!(record.contains(&record.clone().at(["lanes", "e"])));
        assert!(!record.clone().at(["name"]).contains(&record));
        assert!(!record.contains(&RecordKeyV3::record(C::TimelineViews, "w")));
        assert!(
            !RecordKeyV3::collection(C::Entries).contains(&RecordKeyV3::children(C::Entries, None))
        );
        assert_eq!(
            record.at(["lanes", "e"]).to_string(),
            "timeline_views/v/lanes/e"
        );
    }
}
