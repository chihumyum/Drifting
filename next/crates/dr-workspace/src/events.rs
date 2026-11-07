//! The workspace event bus.
//!
//! One source: dr-store's library bus, which delivers every persisted Loro
//! change of every open document and every committed local-table change
//! (dr-store's own and the workspace journal's, announced through
//! `Library::notify_local`). The workspace turns them into fine-grained
//! events — which book, which entities; which prose document, which ranges
//! and paragraphs — and hands them to subscribers. View models consume these
//! events only: there is no optimistic update and no rollback, because a
//! command returns after its commit is durable and its events delivered.
//!
//! Events arrive on the thread that persisted the change (a document holder
//! thread for Loro changes). A subscriber must not block on a document
//! holder; hand work to another thread if it needs one.

use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;
use std::sync::{Arc, Mutex, Weak};

use dr_doc::book::Collection;
use dr_model::DocId;
use dr_model::id::{BlockId, BookId};
use dr_store::{ContainerChange, LocalChange, Origin};
use loro::event::Diff;
use loro::{ContainerID, Index, TextDelta};

use crate::bridge::lock;

/// One changed thing in a book document: a whole collection (`id: None`,
/// e.g. a tree move or a meta field) or one entity (its key in the
/// collection).
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct EntityChange {
    pub collection: Collection,
    pub id: Option<String>,
    /// The entity's fields that changed, when known (`None`: the entity was
    /// created or removed, or the change could not be narrowed).
    pub fields: Option<Vec<String>>,
}

/// A persisted change to a book document.
#[derive(Clone, Debug)]
pub struct BookChanged {
    pub book: BookId,
    /// The update row that made it durable.
    pub seq: i64,
    pub origin: Origin,
    pub changes: Vec<EntityChange>,
}

/// A persisted change to a prose document.
#[derive(Clone, Debug)]
pub struct ProseChanged {
    pub doc: DocId,
    pub book: Option<BookId>,
    pub seq: i64,
    pub origin: Origin,
    /// Changed ranges of the body, in characters after the change (an
    /// insertion's range covers the new text; a deletion is an empty range
    /// where the text was). Merged and sorted.
    pub ranges: Vec<Range<usize>>,
    /// Paragraphs (block ids) the ranges touch, when the workspace has the
    /// document open; empty otherwise.
    pub blocks: Vec<BlockId>,
    /// Tables or embeds changed.
    pub embeds: bool,
}

#[derive(Clone, Debug)]
pub enum WsEvent {
    Book(BookChanged),
    Prose(ProseChanged),
    /// A local-only table changed (dr-store's assets, settlements, derived
    /// index, sync state, and the workspace journal).
    Local(LocalChange),
}

fn root_name(id: &ContainerID) -> Option<&str> {
    match id {
        ContainerID::Root { name, .. } => Some(name.as_str()),
        ContainerID::Normal { .. } => None,
    }
}

/// Which entities of a book document a persisted change touched. The same
/// rule as dr-doc's `BookEvent` (path[0] is the root collection, path[1] the
/// entity key), applied to dr-store's owned diffs.
pub(crate) fn book_changes(changes: &[ContainerChange]) -> Vec<EntityChange> {
    // (collection, entity) -> changed fields; `None` once it is whole.
    let mut out: BTreeMap<(Collection, Option<String>), Option<BTreeSet<String>>> = BTreeMap::new();
    let mut add = |c: Collection, id: Option<String>, fields: Option<Vec<String>>| {
        let e = out.entry((c, id)).or_insert_with(|| Some(BTreeSet::new()));
        match (e.as_mut(), fields) {
            (Some(set), Some(f)) => set.extend(f),
            _ => *e = None,
        }
    };
    for c in changes {
        let root = c
            .path
            .first()
            .and_then(|(id, _)| root_name(id))
            .or_else(|| root_name(&c.target));
        let Some(collection) = root.and_then(Collection::from_root) else {
            continue;
        };
        let key = |i: usize| {
            c.path.get(i).and_then(|(_, idx)| match idx {
                Index::Key(k) => Some(k.to_string()),
                _ => None,
            })
        };
        if let Some(id) = key(1) {
            // The entity's own map changed (fields), or one of its child
            // containers (a set, a list, a text) under field `path[2]`.
            let fields = match (key(2), &c.diff) {
                (Some(f), _) => Some(vec![f]),
                (None, Diff::Map(m)) if c.path.len() == 2 => {
                    Some(m.updated.keys().map(|k| k.to_string()).collect())
                }
                _ => None,
            };
            add(collection, Some(id), fields);
            continue;
        }
        match &c.diff {
            Diff::Map(m) if collection != Collection::Meta && !collection.is_tree() => {
                for k in m.updated.keys() {
                    add(collection, Some(k.to_string()), None);
                }
            }
            Diff::Map(m) if collection == Collection::Meta => {
                add(
                    collection,
                    None,
                    Some(m.updated.keys().map(|k| k.to_string()).collect()),
                );
            }
            _ => add(collection, None, None),
        }
    }
    out.into_iter()
        .map(|((collection, id), fields)| EntityChange {
            collection,
            id,
            fields: fields.map(|f| f.into_iter().collect()),
        })
        .collect()
}

/// Changed body ranges (after the change) and whether embeds changed.
pub(crate) fn prose_ranges(changes: &[ContainerChange]) -> (Vec<Range<usize>>, bool) {
    let mut ranges: Vec<Range<usize>> = Vec::new();
    let mut embeds = false;
    for c in changes {
        let root = c
            .path
            .first()
            .and_then(|(id, _)| root_name(id))
            .or_else(|| root_name(&c.target));
        match root {
            Some(r) if r == dr_doc::schema::prose::BODY => {
                if let Diff::Text(delta) = &c.diff {
                    let mut pos = 0usize;
                    for d in delta {
                        match d {
                            TextDelta::Retain { retain, attributes } => {
                                if attributes.is_some() {
                                    ranges.push(pos..pos + retain);
                                }
                                pos += retain;
                            }
                            TextDelta::Insert { insert, .. } => {
                                let n = insert.chars().count();
                                ranges.push(pos..pos + n);
                                pos += n;
                            }
                            TextDelta::Delete { .. } => ranges.push(pos..pos),
                        }
                    }
                }
            }
            Some(r) if r == dr_doc::schema::prose::EMBEDS => embeds = true,
            _ => {}
        }
    }
    ranges.sort_by_key(|r| (r.start, r.end));
    let mut merged: Vec<Range<usize>> = Vec::new();
    for r in ranges {
        match merged.last_mut() {
            Some(last) if r.start <= last.end => last.end = last.end.max(r.end),
            _ => merged.push(r),
        }
    }
    (merged, embeds)
}

/// The block ids of the paragraphs `ranges` touch, from the paragraph ends
/// (newline positions, sorted) and their ids.
pub(crate) fn touched_blocks(
    blocks: &[dr_doc::prose::BlockRef],
    ranges: &[Range<usize>],
) -> Vec<BlockId> {
    let mut out = BTreeSet::new();
    for r in ranges {
        // The first paragraph whose newline is at or after the start.
        let first = blocks.partition_point(|b| b.newline < r.start);
        for b in &blocks[first.min(blocks.len())..] {
            if let Some(id) = &b.id {
                out.insert(id.clone());
            }
            if b.newline >= r.end {
                break;
            }
        }
    }
    out.into_iter().collect()
}

type Listener = Arc<dyn Fn(&WsEvent) + Send + Sync>;

#[derive(Default)]
pub(crate) struct BusInner {
    next: u64,
    listeners: Vec<(u64, Listener)>,
}

pub(crate) type Bus = Arc<Mutex<BusInner>>;

/// Unsubscribes when dropped.
pub struct Subscription {
    bus: Weak<Mutex<BusInner>>,
    id: u64,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(bus) = self.bus.upgrade() {
            lock(&bus).listeners.retain(|(id, _)| *id != self.id);
        }
    }
}

pub(crate) fn subscribe(bus: &Bus, f: Listener) -> Subscription {
    let mut b = lock(bus);
    b.next += 1;
    let id = b.next;
    b.listeners.push((id, f));
    Subscription {
        bus: Arc::downgrade(bus),
        id,
    }
}

pub(crate) fn publish(bus: &Bus, event: &WsEvent) {
    let listeners: Vec<Listener> = lock(bus).listeners.iter().map(|(_, l)| l.clone()).collect();
    for l in listeners {
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| l(event))).is_err() {
            log::error!("a workspace event listener panicked");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dr_doc::prose::BlockRef;

    fn b(id: &str, nl: usize) -> BlockRef {
        BlockRef {
            id: Some(BlockId::parse(id).unwrap()),
            newline: nl,
        }
    }

    #[test]
    fn ranges_map_to_paragraphs() {
        // "ab\ncd\nef\n": newlines at 2, 5, 8.
        let blocks = [b("p1", 2), b("p2", 5), b("p3", 8)];
        let ids = |r: Range<usize>| {
            touched_blocks(&blocks, &[r])
                .into_iter()
                .map(|b| b.to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(0..1), ["p1"]);
        assert_eq!(ids(3..3), ["p2"]);
        assert_eq!(ids(1..4), ["p1", "p2"]);
        assert_eq!(ids(6..8), ["p3"]);
        assert_eq!(ids(2..3), ["p1", "p2"]);
    }
}
