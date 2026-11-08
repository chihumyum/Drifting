//! Per-book query caches, kept current by events.
//!
//! dr-doc's book reads take every entity of a collection from Loro each time
//! (and some re-read other collections for read tolerance: a relation needs
//! every live end). The workspace caches each read and drops exactly what an
//! event makes stale:
//!
//! - a change to a collection invalidates that collection's reads and the
//!   reads that depend on it (relations depend on every kind of end,
//!   elements on categories and assets, nodes on storylines and idea
//!   groups…);
//! - nodes, the most often changed, are cached as a map patched entity by
//!   entity: a rename re-reads one node, not the book.
//!
//! A fill that raced with an invalidation is discarded (each entry carries
//! the generation it was read at), so a cache never keeps a value older than
//! the last event.

use std::any::Any;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, Mutex};

use dr_doc::book::{BookView, Collection};
use dr_model::book::Node;
use dr_model::id::NodeId;

use dr_text::autolink::{LinkMatcher, LinkName, LinkTarget};

use crate::events::EntityChange;
use crate::holder::lock;

/// How many link matchers a book keeps (one per document entity asked for).
const MATCHERS: usize = 32;

/// What is cached.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(crate) enum Key {
    Meta,
    Acts,
    Storylines,
    Categories,
    Elements,
    Patches,
    RelationTypes,
    Relations,
    RelationsRaw,
    Comments,
    Materials,
    Assets,
    DriftGroups,
    MaterialFolders,
    Facts,
    Memory,
    TimePins,
    /// dr-text's `book_link_names` (every element name and alias, every
    /// chapter and idea title): dropped by any change to elements or nodes.
    LinkNames,
}

/// Fields whose change can make an entity appear or disappear for other
/// collections' reads (trash, kind, a patch's element, a relation's ends).
const LIVENESS: &[&str] = &[
    "deleted_at",
    "kind",
    "element",
    "source_node",
    "type",
    "from",
    "to",
    "from_kind",
    "to_kind",
];

/// The cached reads of `c` itself, for a change that cannot affect others.
fn own(c: Collection) -> &'static [Key] {
    use Key::*;
    match c {
        Collection::Nodes | Collection::PlotGrids => &[],
        Collection::RelationTypes => &[RelationTypes, Relations],
        _ => dependents(c),
    }
}

/// Collections whose every change reaches other reads: assets and folders
/// decide what elements and materials show, groups what nodes read, meta is
/// its own read anyway.
fn own_is_narrower_unsafe(c: Collection) -> bool {
    matches!(
        c,
        Collection::Assets
            | Collection::MaterialFolders
            | Collection::DriftGroups
            | Collection::Meta
    )
}

/// Which cached reads a change to `c` makes stale (besides nodes).
fn dependents(c: Collection) -> &'static [Key] {
    use Key::*;
    match c {
        Collection::Meta => &[Meta],
        Collection::Nodes => &[Acts, Relations, Comments, Patches, TimePins],
        Collection::Acts => &[Acts],
        Collection::Storylines => &[Storylines, Relations, Comments],
        Collection::Categories => &[Categories, Elements, Relations, Comments],
        Collection::Elements => &[Elements, Patches, Relations, Comments],
        Collection::Patches => &[Patches, Relations, Comments],
        Collection::RelationTypes => &[RelationTypes, Relations],
        Collection::Relations => &[Relations, RelationsRaw],
        Collection::TimePins => &[TimePins],
        Collection::PlotGrids => &[],
        Collection::Comments => &[Comments, Relations],
        Collection::Materials => &[Materials, Relations, Comments],
        Collection::Assets => &[Assets, Elements, Materials],
        Collection::DriftGroups => &[DriftGroups],
        Collection::MaterialFolders => &[MaterialFolders, Materials],
        Collection::Facts => &[Facts],
        Collection::Memory => &[Memory],
        Collection::WritingDays => &[Meta],
    }
}

type Entry = Arc<dyn Any + Send + Sync>;

#[derive(Default)]
struct State {
    generation: u64,
    entries: HashMap<Key, (u64, Entry)>,
    /// Generation of the last invalidation of each key.
    stamps: HashMap<Key, u64>,
    /// Nodes by id, if loaded.
    nodes: Option<(u64, Arc<BTreeMap<NodeId, Node>>)>,
    /// Nodes to re-read before the map is used; `None` in `nodes_dirty`
    /// position means a full reload is due.
    nodes_dirty: BTreeSet<String>,
    nodes_full: bool,
    nodes_stamp: u64,
    /// Link matchers by the entity whose names they leave out, each with
    /// the `LinkNames` value it was built from (by address).
    matchers: HashMap<String, (usize, Arc<LinkMatcher<LinkTarget>>)>,
}

#[derive(Default)]
pub(crate) struct BookCache {
    state: Mutex<State>,
    hits: std::sync::atomic::AtomicU64,
    misses: std::sync::atomic::AtomicU64,
}

impl BookCache {
    /// Apply a persisted change.
    pub(crate) fn invalidate(&self, changes: &[EntityChange]) {
        let mut s = lock(&self.state);
        s.generation += 1;
        let g = s.generation;
        let mut keys: BTreeSet<Key> = BTreeSet::new();
        for c in changes {
            let liveness = c
                .fields
                .as_ref()
                .is_none_or(|f| f.iter().any(|k| LIVENESS.contains(&k.as_str())));
            let ks = if liveness || own_is_narrower_unsafe(c.collection) {
                dependents(c.collection)
            } else {
                own(c.collection)
            };
            keys.extend(ks.iter().copied());
            if matches!(c.collection, Collection::Elements | Collection::Nodes) {
                keys.insert(Key::LinkNames);
            }
            match (c.collection, &c.id) {
                (Collection::Nodes, Some(id)) => {
                    s.nodes_dirty.insert(id.clone());
                    s.nodes_stamp = g;
                }
                (Collection::Nodes, None) => {
                    s.nodes_full = true;
                    s.nodes_stamp = g;
                }
                (Collection::Storylines, _) | (Collection::DriftGroups, _) if liveness => {
                    s.nodes_full = true;
                    s.nodes_stamp = g;
                }
                _ => {}
            }
        }
        if keys.contains(&Key::LinkNames) {
            s.matchers.clear();
        }
        for k in keys {
            s.entries.remove(&k);
            s.stamps.insert(k, g);
        }
    }

    /// The matcher over `names` (the book's `LinkNames`) without the names
    /// of entity `own`, built once per value of `names`.
    pub(crate) fn matcher(
        &self,
        own: &str,
        names: &Arc<Vec<LinkName<LinkTarget>>>,
    ) -> Arc<LinkMatcher<LinkTarget>> {
        let at = Arc::as_ptr(names) as usize;
        if let Some((a, m)) = lock(&self.state).matchers.get(own)
            && *a == at
        {
            self.hits.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            return m.clone();
        }
        self.misses
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let m = Arc::new(LinkMatcher::new(
            names.iter().filter(|n| n.target.id != own).cloned(),
        ));
        let mut s = lock(&self.state);
        if s.matchers.len() >= MATCHERS {
            s.matchers.clear();
        }
        s.matchers.insert(own.to_string(), (at, m.clone()));
        m
    }

    /// The cached value of `key` when there is one; never fills it.
    pub(crate) fn peek<T: Send + Sync + 'static>(&self, key: Key) -> Option<Arc<T>> {
        let s = lock(&self.state);
        let (_, e) = s.entries.get(&key)?;
        let v = e.clone().downcast::<T>().ok()?;
        self.hits.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Some(v)
    }

    /// The cached value of `key`, or `fill` it from `view`.
    pub(crate) fn get<T: Send + Sync + 'static>(
        &self,
        key: Key,
        view: &BookView<'_>,
        fill: impl FnOnce(&BookView<'_>) -> T,
    ) -> Arc<T> {
        let started = {
            let s = lock(&self.state);
            if let Some((_, e)) = s.entries.get(&key)
                && let Ok(v) = e.clone().downcast::<T>()
            {
                self.hits.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                return v;
            }
            s.generation
        };
        self.misses
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let v = Arc::new(fill(view));
        let mut s = lock(&self.state);
        let stamp = s.stamps.get(&key).copied().unwrap_or(0);
        if stamp <= started {
            s.entries.insert(key, (started, v.clone() as Entry));
        }
        v
    }

    /// Every node (trashed included), by id, patched entity by entity.
    /// A node as last read, without reading (it may be stale; for what
    /// does not change, like its kind, once it is gone from the book).
    pub(crate) fn known_node(&self, id: &NodeId) -> Option<Node> {
        lock(&self.state)
            .nodes
            .as_ref()
            .and_then(|(_, m)| m.get(id).cloned())
    }

    pub(crate) fn nodes(&self, view: &BookView<'_>) -> Arc<BTreeMap<NodeId, Node>> {
        let (started, base, dirty, full) = {
            let mut s = lock(&self.state);
            match &s.nodes {
                Some((_, map)) if !s.nodes_full && s.nodes_dirty.is_empty() => {
                    self.hits.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    return map.clone();
                }
                _ => {}
            }
            let dirty = std::mem::take(&mut s.nodes_dirty);
            let full = std::mem::take(&mut s.nodes_full) || s.nodes.is_none();
            (
                s.generation,
                s.nodes.as_ref().map(|(_, m)| m.clone()),
                dirty,
                full,
            )
        };
        self.misses
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let map: BTreeMap<NodeId, Node> = match (full, base) {
            (false, Some(base)) => {
                let mut m = (*base).clone();
                for id in &dirty {
                    let Ok(nid) = NodeId::parse(id) else { continue };
                    match view.node(&nid) {
                        Some(n) => {
                            m.insert(nid, n);
                        }
                        None => {
                            m.remove(&nid);
                        }
                    }
                }
                m
            }
            _ => view
                .nodes()
                .into_iter()
                .map(|n| (n.id.clone(), n))
                .collect(),
        };
        let map = Arc::new(map);
        let mut s = lock(&self.state);
        if s.nodes_stamp <= started {
            s.nodes = Some((started, map.clone()));
        } else {
            // An event arrived while reading: keep what we read as the base
            // but make sure what it named is read again.
            s.nodes_dirty.extend(dirty);
            if full {
                s.nodes_full = true;
            }
        }
        map
    }

    /// (hits, misses), for measurements.
    pub(crate) fn stats(&self) -> (u64, u64) {
        (
            self.hits.load(std::sync::atomic::Ordering::Relaxed),
            self.misses.load(std::sync::atomic::Ordering::Relaxed),
        )
    }
}
