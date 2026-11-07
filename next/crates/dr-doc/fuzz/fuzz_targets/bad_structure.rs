//! Well-formed Loro documents with a damaged structure: text without its
//! final newline, paragraph marks on letters, block ids of the wrong type,
//! entity fields of the wrong type, entities that are not maps, trees whose
//! nodes repeat a domain id, a second device's concurrent writes. Written with
//! the raw Loro API (what a buggy or newer version could produce), then
//! loaded, read and edited through dr-doc. Nothing may panic.

#![no_main]

use arbitrary::Arbitrary;
use dr_doc::book::BookDoc;
use dr_doc::prose::ProseDoc;
use dr_model::id::BookId;
use dr_model::{DocId, Origin};
use libfuzzer_sys::fuzz_target;
use loro::{ExportMode, LoroDoc, LoroValue, TreeParentId};

#[path = "common.rs"]
mod common;

#[derive(Arbitrary, Debug, Clone)]
enum Val {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(u8),
    Bin(Vec<u8>),
    List(Vec<u8>),
    Map(u8, u8),
}

impl Val {
    fn loro(&self) -> LoroValue {
        match self {
            Val::Null => LoroValue::Null,
            Val::Bool(b) => (*b).into(),
            Val::Int(i) => (*i).into(),
            Val::Float(f) => (*f).into(),
            Val::Str(s) => STRS[*s as usize % STRS.len()].into(),
            Val::Bin(b) => b.clone().into(),
            Val::List(l) => LoroValue::List(
                l.iter()
                    .map(|i| LoroValue::from(STRS[*i as usize % STRS.len()]))
                    .collect::<Vec<_>>()
                    .into(),
            ),
            Val::Map(k, v) => LoroValue::Map(
                vec![(
                    KEYS[*k as usize % KEYS.len()].to_string(),
                    LoroValue::from(STRS[*v as usize % STRS.len()]),
                )]
                .into(),
            ),
        }
    }
}

const STRS: &[&str] = &[
    "", "chapter", "drift", "element", "node", "material", "library_item", "n0", "n1", "e0",
    "e1", "g0", "g1", "rt", "symmetric", "directed", "todo", "0@1", "a|2026-11-07",
    "mac|2026-02-30", "r0/c0", "\n", "\u{FFFC}", "😀", "x/y", "comment", "2", "image", "pdf",
    "a0", "a00", "Zz", "marker", "note_task", "resolved", "converted", "copilot",
];
const KEYS: &[&str] = &[
    "kind", "title", "book_order", "narrative_order", "status", "group", "storylines",
    "primary_storyline", "deleted_at", "name", "from_kind", "from", "to_kind", "to", "type",
    "orientation", "source_kinds", "target_kinds", "locked", "system_key", "anchor", "start",
    "end", "target_kind", "target", "asset", "folder", "order", "facts", "key", "value", "cells",
    "rows", "cols", "pos", "cell_w", "id", "bid", "heading", "indent", "align", "list", "embed",
    "entity:e0", "entity:", "bold", "link", "code", "highlight", "todo", "checked", "v", "doc",
    "book", "pos", "region", "snapshots", "quote", "projection", "projection_block", "pin_x",
    "pin_y", "word_target", "daily_word_target", "description", "color", "x", "y", "w", "h",
    "page", "block", "text", "agent_conversation",
];
const ROOTS: &[&str] = &[
    "meta", "nodes", "acts", "storylines", "categories", "elements", "patches", "relation_types",
    "relations", "time_pins", "plot_grids", "comments", "materials", "assets", "facts", "memory",
    "writing_days", "embeds",
];

#[derive(Arbitrary, Debug)]
enum Op {
    Insert { at: u16, s: u8 },
    Delete { at: u16, len: u8 },
    Mark { at: u16, len: u8, key: u8, val: Val },
    Field { root: u8, entity: u8, key: u8, val: Val },
    SubField { root: u8, entity: u8, sub: u8, key: u8, val: Val },
    RootValue { root: u8, key: u8, val: Val },
    TreeCreate { which: bool, parent: Option<u8>, id: u8 },
    TreeMove { which: bool, node: u8, parent: Option<u8> },
    TreeDelete { which: bool, node: u8 },
    SwitchPeer,
    Commit,
}

fn build(ops: &[Op], doc_id: &str) -> Vec<Vec<u8>> {
    let a = LoroDoc::new();
    dr_doc::schema::configure(&a);
    let b = LoroDoc::new();
    dr_doc::schema::configure(&b);
    a.set_peer_id(11).unwrap();
    b.set_peer_id(12).unwrap();
    let mut cur = &a;
    let mut nodes: Vec<loro::TreeID> = Vec::new();
    for op in ops.iter().take(200) {
        let text = cur.get_text("body");
        let len = text.len_unicode();
        match op {
            Op::Insert { at, s } => {
                let _ = text.insert(*at as usize % (len + 1), STRS[*s as usize % STRS.len()]);
            }
            Op::Delete { at, len: n } => {
                if len > 0 {
                    let at = *at as usize % len;
                    let _ = text.delete(at, (*n as usize).min(len - at));
                }
            }
            Op::Mark { at, len: n, key, val } => {
                if len > 0 {
                    let at = *at as usize % len;
                    let end = (at + 1 + *n as usize).min(len);
                    let _ = text.mark(at..end, KEYS[*key as usize % KEYS.len()], val.loro());
                }
            }
            Op::Field { root, entity, key, val } => {
                let m = cur.get_map(ROOTS[*root as usize % ROOTS.len()]);
                if let Ok(e) = m.ensure_mergeable_map(STRS[*entity as usize % STRS.len()]) {
                    let _ = e.insert(KEYS[*key as usize % KEYS.len()], val.loro());
                }
            }
            Op::SubField { root, entity, sub, key, val } => {
                let m = cur.get_map(ROOTS[*root as usize % ROOTS.len()]);
                if let Ok(e) = m.ensure_mergeable_map(STRS[*entity as usize % STRS.len()])
                    && let Ok(s) = e.ensure_mergeable_map(KEYS[*sub as usize % KEYS.len()])
                {
                    let _ = s.insert(KEYS[*key as usize % KEYS.len()], val.loro());
                }
            }
            Op::RootValue { root, key, val } => {
                let m = cur.get_map(ROOTS[*root as usize % ROOTS.len()]);
                let _ = m.insert(KEYS[*key as usize % KEYS.len()], val.loro());
            }
            Op::TreeCreate { which, parent, id } => {
                let tree = cur.get_tree(if *which { "drift_groups" } else { "material_folders" });
                let p = match parent.and_then(|p| nodes.get(p as usize % nodes.len().max(1))) {
                    Some(p) => TreeParentId::Node(*p),
                    None => TreeParentId::Root,
                };
                if let Ok(t) = tree.create(p) {
                    if let Ok(meta) = tree.get_meta(t) {
                        let _ = meta.insert("id", STRS[*id as usize % STRS.len()]);
                        let _ = meta.insert("name", "n");
                    }
                    nodes.push(t);
                }
            }
            Op::TreeMove { which, node, parent } => {
                let tree = cur.get_tree(if *which { "drift_groups" } else { "material_folders" });
                if let Some(t) = nodes.get(*node as usize % nodes.len().max(1)) {
                    let p = match parent.and_then(|p| nodes.get(p as usize % nodes.len().max(1))) {
                        Some(p) => TreeParentId::Node(*p),
                        None => TreeParentId::Root,
                    };
                    let _ = tree.mov(*t, p);
                }
            }
            Op::TreeDelete { which, node } => {
                let tree = cur.get_tree(if *which { "drift_groups" } else { "material_folders" });
                if let Some(t) = nodes.get(*node as usize % nodes.len().max(1)) {
                    let _ = tree.delete(*t);
                }
            }
            Op::SwitchPeer => {
                cur.commit();
                cur = if std::ptr::eq(cur, &a) { &b } else { &a };
            }
            Op::Commit => cur.commit(),
        }
    }
    a.commit();
    b.commit();
    // Sometimes the damaged document claims to be another one.
    let _ = doc_id;
    vec![
        a.export(ExportMode::all_updates()).unwrap_or_default(),
        b.export(ExportMode::Snapshot).unwrap_or_default(),
    ]
}

fuzz_target!(|ops: Vec<Op>| {
    let blobs = build(&ops, "node:fuzz");
    let id = DocId::parse("node:fuzz").unwrap();
    if let Ok(mut d) = ProseDoc::load(id.clone(), 7, &blobs) {
        common::exercise_prose(&mut d, &[3, 1, 4, 1, 5, 9, 2, 6]);
    }
    let note = DocId::parse("material:fuzz").unwrap();
    if let Ok(mut d) = ProseDoc::load(note, 7, &blobs) {
        common::exercise_prose(&mut d, &[2, 7, 1, 8, 2, 8]);
    }
    let mut d = ProseDoc::create(id, 7).unwrap();
    for b in &blobs {
        let _ = d.import(b, Origin::Sync);
    }
    common::exercise_prose(&mut d, &[0, 0, 1, 2]);
    if let Ok(mut b) = BookDoc::load(BookId::parse("fuzz").unwrap(), 7, &blobs) {
        common::exercise_book(&mut b);
    }
});
