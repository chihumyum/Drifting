//! Property tests: random command sequences keep the book's invariants.
//!
//! - One device: random commands (with injected faults and reopening from
//!   disk mixed in); after every step the command-layer invariants hold.
//! - Two devices: each runs random commands on its own copy, then they
//!   exchange everything; both read the same book, and what a merge can
//!   break is tolerated by the readers (flagged name conflicts, hidden
//!   relations).
//!
//! `DR_PROP_CASES` sets the number of cases (default 16).

mod common;

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use common::*;
use dr_workspace::{Actor, Faults, Workspace, WsError};
use loro::ExportMode;
use proptest::prelude::*;
use serde_json::{Value, json};

const NAMES: &[&str] = &["One", "one", "Two", "安娜", "Anna", "anna ", "Two 2", ""];

#[derive(Clone, Debug)]
enum Op {
    Chapter(u8),
    ChapterText(u8),
    RenameChapter(u8, u8),
    MoveChapter(u8, u8),
    /// `chapter.place` (the timeline's drop): a live chapter, a storyline
    /// pick (or none, or off every line), an order and the axis.
    PlaceChapter(u8, u8, u8),
    /// `chapter.spread` on reading order (`false`) or story time.
    Spread(bool),
    TrashChapter(u8),
    RestoreChapter(u8),
    PurgeChapter(u8),
    Element(u8, bool),
    RenameElement(u8, u8),
    AliasElement(u8, u8),
    TrashElement(u8),
    RestoreElement(u8),
    PurgeElement(u8),
    Category(u8),
    SetCategory(u8, u8),
    TrashCategory(u8),
    PurgeCategory(u8),
    Storyline(u8),
    JoinStoryline(u8, u8),
    PurgeStoryline(u8),
    Relate(u8, u8),
    Unrelate(u8),
    Idea(u8),
    Group(u8, Option<u8>),
    MoveIdea(u8, u8),
    /// A live idea turned into a chapter (with a storyline pick) or, odd
    /// second byte, an element.
    ConvertIdea(u8, u8),
    MoveGroup(u8, Option<u8>),
    DeleteGroup(u8),
    Comment(u8),
    ResolveComment(u8),
    Replace(u8),
    /// `todo.project` on a live chapter, the bits of the second byte choosing
    /// which paragraphs carry a marker.
    Project(u8, u8),
    /// A history point at a live chapter's current version (storage takes
    /// its own every 15 minutes; a test cannot wait that long).
    Point(u8),
    /// `history.restore_point` on a live chapter, to its n-th point.
    RestorePoint(u8, u8),
    /// A patch on a live element, from a live chapter when there is one.
    Patch(u8, u8),
    DeletePatch(u8),
    /// A live chapter's plot grid: a cell written, and (odd second byte)
    /// its first row removed.
    PlotCell(u8, u8),
    Undo,
    Redo,
    AgentRename(u8, u8),
    UndoAgent,
    Fault(u8),
    Reopen,
}

fn op() -> impl Strategy<Value = Op> {
    let i = || any::<u8>();
    prop_oneof![
        3 => i().prop_map(Op::Chapter),
        1 => i().prop_map(Op::ChapterText),
        2 => (i(), i()).prop_map(|(a, b)| Op::RenameChapter(a, b)),
        2 => (i(), i()).prop_map(|(a, b)| Op::MoveChapter(a, b)),
        2 => (i(), i(), i()).prop_map(|(a, b, k)| Op::PlaceChapter(a, b, k)),
        1 => any::<bool>().prop_map(Op::Spread),
        1 => i().prop_map(Op::TrashChapter),
        1 => i().prop_map(Op::RestoreChapter),
        1 => i().prop_map(Op::PurgeChapter),
        3 => (i(), any::<bool>()).prop_map(|(a, b)| Op::Element(a, b)),
        2 => (i(), i()).prop_map(|(a, b)| Op::RenameElement(a, b)),
        1 => (i(), i()).prop_map(|(a, b)| Op::AliasElement(a, b)),
        1 => i().prop_map(Op::TrashElement),
        1 => i().prop_map(Op::RestoreElement),
        1 => i().prop_map(Op::PurgeElement),
        1 => i().prop_map(Op::Category),
        1 => (i(), i()).prop_map(|(a, b)| Op::SetCategory(a, b)),
        1 => i().prop_map(Op::TrashCategory),
        1 => i().prop_map(Op::PurgeCategory),
        1 => i().prop_map(Op::Storyline),
        1 => (i(), i()).prop_map(|(a, b)| Op::JoinStoryline(a, b)),
        1 => i().prop_map(Op::PurgeStoryline),
        3 => (i(), i()).prop_map(|(a, b)| Op::Relate(a, b)),
        1 => i().prop_map(Op::Unrelate),
        2 => i().prop_map(Op::Idea),
        1 => (i(), proptest::option::of(i())).prop_map(|(a, b)| Op::Group(a, b)),
        1 => (i(), i()).prop_map(|(a, b)| Op::MoveIdea(a, b)),
        1 => (i(), i()).prop_map(|(a, k)| Op::ConvertIdea(a, k)),
        1 => (i(), proptest::option::of(i())).prop_map(|(a, b)| Op::MoveGroup(a, b)),
        1 => i().prop_map(Op::DeleteGroup),
        1 => i().prop_map(Op::Comment),
        1 => i().prop_map(Op::ResolveComment),
        1 => i().prop_map(Op::Replace),
        2 => (i(), i()).prop_map(|(a, m)| Op::Project(a, m)),
        1 => i().prop_map(Op::Point),
        1 => (i(), i()).prop_map(|(a, n)| Op::RestorePoint(a, n)),
        1 => (i(), i()).prop_map(|(a, c)| Op::Patch(a, c)),
        1 => i().prop_map(Op::DeletePatch),
        1 => (i(), i()).prop_map(|(a, k)| Op::PlotCell(a, k)),
        2 => Just(Op::Undo),
        1 => Just(Op::Redo),
        1 => (i(), i()).prop_map(|(a, b)| Op::AgentRename(a, b)),
        1 => Just(Op::UndoAgent),
        1 => i().prop_map(Op::Fault),
        1 => Just(Op::Reopen),
    ]
}

fn pick(v: &[String], i: u8) -> Option<String> {
    (!v.is_empty()).then(|| v[i as usize % v.len()].clone())
}

fn name(i: u8) -> &'static str {
    NAMES[i as usize % NAMES.len()]
}

/// A list query's output, without what each device derives on its own
/// (`chapter.list`'s words come from the derived index, which catches up
/// in the background; its `updated_at` is when this device stored the
/// newest change).
fn list(ws: &Workspace, cmd: &str, input: Value) -> Value {
    let mut out = call(ws, &Actor::User, cmd, input)["output"].clone();
    if let Some(rows) = out.as_array_mut() {
        for row in rows.iter_mut().filter_map(Value::as_object_mut) {
            row.remove("words");
            row.remove("updated_at");
        }
    }
    out
}

/// Run one op; command errors the rules allow are fine, anything else fails.
fn run(ws: &Workspace, faults: &Faults, book: &str, op: &Op, agent_turn: &mut u32) -> bool {
    let b = book;
    let chapters = || {
        ids(&list(
            ws,
            "chapter.list",
            json!({"book": b, "trashed": true}),
        ))
    };
    let live_chapters = || ids(&list(ws, "chapter.list", json!({"book": b})));
    let elements = || {
        ids(&list(
            ws,
            "element.list",
            json!({"book": b, "trashed": true}),
        ))
    };
    let live_elements = || ids(&list(ws, "element.list", json!({"book": b})));
    let categories = || {
        ids(&list(
            ws,
            "category.list",
            json!({"book": b, "trashed": true}),
        ))
    };
    let storylines = || ids(&list(ws, "storyline.list", json!({"book": b})));
    let ideas = || ids(&list(ws, "idea.list", json!({"book": b})));
    let groups = || ids(&list(ws, "idea_group.list", json!({"book": b})));
    let relations = || ids(&list(ws, "relation.list", json!({"book": b})));
    let comments = || ids(&list(ws, "comment.list", json!({"book": b})));
    let u = Actor::User;
    let rtype = || -> dr_workspace::Result<String> {
        let ts = list(ws, "relation_type.list", json!({"book": b}));
        Ok(
            match ts
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["locked"] == json!(false))
            {
                Some(t) => t["id"].as_str().unwrap().to_string(),
                None => ws.call(
                    &u,
                    "relation_type.create",
                    json!({"book": b, "name": "r", "orientation": "symmetric",
                "source_kinds": ["element", "node"], "target_kinds": ["element", "node"]}),
                )?["output"]["id"]
                    .as_str()
                    .unwrap()
                    .to_string(),
            },
        )
    };
    let c = |cmd: &str, input: Value| ws.call(&u, cmd, input).map(|_| ());
    let r: dr_workspace::Result<()> = match op {
        Op::Chapter(n) => c("chapter.create", json!({"book": b, "title": name(*n)})),
        Op::ChapterText(n) => c(
            "chapter.create",
            json!({"book": b, "title": name(*n), "text": "一段。\n安娜在这里。"}),
        ),
        Op::RenameChapter(i, n) => match pick(&chapters(), *i) {
            Some(id) => c(
                "chapter.update",
                json!({"book": b, "id": id, "title": name(*n)}),
            ),
            None => Ok(()),
        },
        Op::MoveChapter(i, j) => match (pick(&live_chapters(), *i), pick(&live_chapters(), *j)) {
            (Some(a), Some(x)) if a != x => c(
                "chapter.move",
                json!({"book": b, "id": a, "place": {"after": x}}),
            ),
            _ => Ok(()),
        },
        Op::PlaceChapter(i, j, k) => match pick(&live_chapters(), *i) {
            Some(id) => {
                let axis = if k % 2 == 0 { "book" } else { "narrative" };
                let order = f64::from(*k) * 2.5 - 50.0;
                let mut input = json!({"book": b, "id": id, "axis": axis, "order": order});
                match j % 3 {
                    0 => {}
                    1 => input["storyline"] = Value::Null,
                    _ => {
                        if let Some(s) = pick(&storylines(), *j / 3) {
                            input["storyline"] = json!(s);
                        }
                    }
                }
                c("chapter.place", input)
            }
            None => Ok(()),
        },
        Op::Spread(narrative) => c(
            "chapter.spread",
            json!({"book": b, "axis": if *narrative { "narrative" } else { "book" }}),
        ),
        Op::TrashChapter(i) => match pick(&chapters(), *i) {
            Some(id) => c("chapter.trash", json!({"book": b, "id": id})),
            None => Ok(()),
        },
        Op::RestoreChapter(i) => match pick(&chapters(), *i) {
            Some(id) => c("chapter.restore", json!({"book": b, "id": id})),
            None => Ok(()),
        },
        Op::PurgeChapter(i) => match pick(&chapters(), *i) {
            Some(id) => c("chapter.purge", json!({"book": b, "id": id})),
            None => Ok(()),
        },
        Op::Element(n, numbered) => c(
            "element.create",
            json!({"book": b, "name": name(*n), "numbered": numbered}),
        ),
        Op::RenameElement(i, n) => match pick(&elements(), *i) {
            Some(id) => c(
                "element.update",
                json!({"book": b, "id": id, "name": name(*n)}),
            ),
            None => Ok(()),
        },
        Op::AliasElement(i, n) => match pick(&elements(), *i) {
            Some(id) => c(
                "element.update",
                json!({"book": b, "id": id, "add_aliases": [name(*n)]}),
            ),
            None => Ok(()),
        },
        Op::TrashElement(i) => match pick(&elements(), *i) {
            Some(id) => c("element.trash", json!({"book": b, "id": id})),
            None => Ok(()),
        },
        Op::RestoreElement(i) => match pick(&elements(), *i) {
            Some(id) => c("element.restore", json!({"book": b, "id": id})),
            None => Ok(()),
        },
        Op::PurgeElement(i) => match pick(&elements(), *i) {
            Some(id) => c("element.purge", json!({"book": b, "id": id})),
            None => Ok(()),
        },
        Op::Category(n) => c("category.create", json!({"book": b, "name": name(*n)})),
        Op::SetCategory(i, j) => match (
            pick(&live_elements(), *i),
            pick(&ids(&list(ws, "category.list", json!({"book": b}))), *j),
        ) {
            (Some(e), Some(cat)) => c(
                "element.update",
                json!({"book": b, "id": e, "category": cat}),
            ),
            _ => Ok(()),
        },
        Op::TrashCategory(i) => match pick(&categories(), *i) {
            Some(id) => c("category.trash", json!({"book": b, "id": id})),
            None => Ok(()),
        },
        Op::PurgeCategory(i) => match pick(&categories(), *i) {
            Some(id) => c("category.purge", json!({"book": b, "id": id})),
            None => Ok(()),
        },
        Op::Storyline(n) => c("storyline.create", json!({"book": b, "name": name(*n)})),
        Op::JoinStoryline(i, j) => match (pick(&live_chapters(), *i), pick(&storylines(), *j)) {
            (Some(ch), Some(s)) => c(
                "chapter.update",
                json!({"book": b, "id": ch, "add_storylines": [s.clone()], "primary_storyline": s}),
            ),
            _ => Ok(()),
        },
        Op::PurgeStoryline(i) => match pick(&storylines(), *i) {
            Some(id) => c("storyline.purge", json!({"book": b, "id": id})),
            None => Ok(()),
        },
        Op::Relate(i, j) => {
            let ends: Vec<(String, String)> = live_chapters()
                .into_iter()
                .map(|x| ("node".to_string(), x))
                .chain(
                    live_elements()
                        .into_iter()
                        .map(|x| ("element".to_string(), x)),
                )
                .collect();
            if ends.len() < 2 {
                Ok(())
            } else {
                let a = &ends[*i as usize % ends.len()];
                let z = &ends[*j as usize % ends.len()];
                match rtype() {
                    Ok(t) => c(
                        "relation.create",
                        json!({"book": b, "from": {"kind": a.0, "id": a.1}, "to": {"kind": z.0, "id": z.1}, "relation_type": t}),
                    ),
                    Err(e) => Err(e),
                }
            }
        }
        Op::Unrelate(i) => match pick(&relations(), *i) {
            Some(id) => c("relation.delete", json!({"book": b, "id": id})),
            None => Ok(()),
        },
        Op::Idea(n) => c("idea.create", json!({"book": b, "title": name(*n)})),
        Op::Group(n, p) => {
            let parent = p.and_then(|p| pick(&groups(), p));
            c(
                "idea_group.create",
                json!({"book": b, "name": format!("g{n}"), "parent": parent}),
            )
        }
        Op::MoveIdea(i, g) => match (pick(&ideas(), *i), pick(&groups(), *g)) {
            (Some(id), Some(g)) => c("idea.update", json!({"book": b, "id": id, "group": g})),
            _ => Ok(()),
        },
        Op::ConvertIdea(i, k) => match pick(&ideas(), *i) {
            Some(id) if k % 2 == 1 => c("idea.to_element", json!({"book": b, "id": id})),
            Some(id) => {
                let mut input = json!({"book": b, "id": id});
                if let Some(s) = pick(&storylines(), *k / 2) {
                    input["storyline"] = json!(s);
                }
                c("idea.to_chapter", input)
            }
            None => Ok(()),
        },
        Op::MoveGroup(i, p) => match pick(&groups(), *i) {
            Some(id) => c(
                "idea_group.update",
                json!({"book": b, "id": id, "parent": p.and_then(|p| pick(&groups(), p))}),
            ),
            None => Ok(()),
        },
        Op::DeleteGroup(i) => match pick(&groups(), *i) {
            Some(id) => c("idea_group.delete", json!({"book": b, "id": id})),
            None => Ok(()),
        },
        Op::Comment(i) => {
            let target = pick(&live_chapters(), *i).map(|id| json!({"kind": "node", "id": id}));
            c(
                "comment.create",
                json!({"book": b, "target": target, "body": "note", "kind": "todo"}),
            )
        }
        Op::ResolveComment(i) => match pick(&comments(), *i) {
            Some(id) => c(
                "comment.update",
                json!({"book": b, "id": id, "status": "resolved"}),
            ),
            None => Ok(()),
        },
        Op::Replace(i) => match pick(&live_chapters(), *i) {
            Some(id) => c(
                "prose.replace",
                json!({"doc": format!("node:{id}"), "find": "安娜", "replace": "安娜·卡"}),
            ),
            None => Ok(()),
        },
        Op::Project(i, mask) => match pick(&live_chapters(), *i) {
            Some(id) => {
                let doc = format!("node:{id}");
                let paras = list(ws, "prose.read", json!({"doc": doc}))["paragraphs"].clone();
                let markers: Vec<Value> = paras
                    .as_array()
                    .unwrap()
                    .iter()
                    .enumerate()
                    .filter(|(k, _)| (mask >> (k % 8)) & 1 == 1)
                    .filter_map(|(_, p)| p["block_id"].as_str())
                    .map(|blk| json!({"block": blk, "task": marker_task(blk)}))
                    .collect();
                c("todo.project", json!({"doc": doc, "markers": markers}))
            }
            None => Ok(()),
        },
        Op::Point(i) => {
            if let Some(id) = pick(&live_chapters(), *i) {
                let doc = format!("node:{id}");
                let lib = ws.library();
                if let Some(head) = lib.head(&doc).unwrap() {
                    let ts = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_millis() as i64;
                    lib.label_at(
                        &doc,
                        &head.frontiers,
                        "periodic",
                        ts,
                        dr_store::history::LabelRetention::Thinned,
                    )
                    .unwrap();
                }
            }
            Ok(())
        }
        Op::RestorePoint(i, n) => match pick(&live_chapters(), *i) {
            Some(id) => {
                let doc = format!("node:{id}");
                let points = list(ws, "history.points", json!({"doc": doc}))["points"].clone();
                let ids: Vec<String> = points
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|p| p["id"].to_string())
                    .collect();
                match pick(&ids, *n) {
                    Some(p) => c(
                        "history.restore_point",
                        json!({"doc": doc, "point": p.parse::<i64>().unwrap()}),
                    ),
                    None => Ok(()),
                }
            }
            None => Ok(()),
        },
        Op::Patch(i, j) => match pick(&live_elements(), *i) {
            Some(el) => {
                let source = pick(&live_chapters(), *j);
                c(
                    "patch.create",
                    json!({"book": b, "element": el, "title": name(*j), "body": "补", "source": source}),
                )
            }
            None => Ok(()),
        },
        Op::DeletePatch(i) => {
            let all: Vec<String> = live_elements()
                .iter()
                .flat_map(|el| ids(&list(ws, "patch.list", json!({"book": b, "element": el}))))
                .collect();
            match pick(&all, *i) {
                Some(id) => c("patch.delete", json!({"book": b, "id": id})),
                None => Ok(()),
            }
        }
        Op::PlotCell(i, k) => match pick(&live_chapters(), *i) {
            Some(ch) => {
                // An armed fault may hit the create: allowed like any other.
                if let Err(e) = c("plot_grid.create", json!({"book": b, "node": ch})) {
                    return finish(op, Err(e));
                }
                let g = list(ws, "plot_grid.get", json!({"book": b, "node": ch}));
                let (rows, cols) = (ids(&g["rows"]), ids(&g["columns"]));
                match (pick(&rows, *k), pick(&cols, k / 3)) {
                    (Some(r), Some(col)) => {
                        let r1 = c(
                            "plot_grid.cell",
                            json!({"book": b, "node": ch, "row": r, "column": col, "text": name(*k)}),
                        );
                        if k % 2 == 1 && r1.is_ok() {
                            c(
                                "plot_grid.line_remove",
                                json!({"book": b, "node": ch, "axis": "row", "id": rows[0]}),
                            )
                        } else {
                            r1
                        }
                    }
                    _ => Ok(()),
                }
            }
            None => Ok(()),
        },
        Op::Undo => ws.undo(&u).map(|_| ()),
        Op::Redo => ws.redo(&u).map(|_| ()),
        Op::AgentRename(i, n) => match pick(&live_chapters(), *i) {
            Some(id) => {
                *agent_turn += 1;
                ws.call(
                    &Actor::agent("prop", *agent_turn, "c"),
                    "chapter.update",
                    json!({"book": b, "id": id, "title": name(*n), "summary": "agent"}),
                )
                .map(|_| ())
            }
            None => Ok(()),
        },
        Op::UndoAgent => {
            if *agent_turn > 0 {
                c(
                    "history.undo_agent",
                    json!({"session": "prop", "turn": *agent_turn}),
                )
            } else {
                Ok(())
            }
        }
        Op::Fault(k) => {
            faults.arm(["after_prose", "in_book", "journal"][*k as usize % 3]);
            Ok(())
        }
        Op::Reopen => return true,
    };
    finish(op, r)
}

/// Command errors the rules allow are fine, anything else fails.
fn finish(op: &Op, r: dr_workspace::Result<()>) -> bool {
    match r {
        Ok(())
        | Err(WsError::NameTaken { .. })
        | Err(WsError::Invalid(_))
        | Err(WsError::Violation(_))
        | Err(WsError::NotFound { .. })
        | Err(WsError::Ambiguous(_))
        | Err(WsError::Fault(_)) => {}
        Err(e) => panic!("{op:?}: {e} ({})", e.code()),
    }
    false
}

/// The invariants commands keep on one device.
/// The task text the property tests type after a marker in block `blk`: a
/// function of the block, so two devices project the same seed.
fn marker_task(blk: &str) -> String {
    format!("t-{}", blk.chars().take(6).collect::<String>())
}

/// PROJECTED-TODO-ID: a TODO projected from a marker has the id its
/// document and block give, and its body is the task it was seeded with,
/// once (two devices that projected it before syncing do not double it).
fn check_projections(ws: &Workspace, b: &str) {
    use dr_model::DocId;
    use dr_model::id::{BlockId, CommentId};
    use dr_model::kind::ProjectionKind;
    let todos = list(ws, "comment.list", json!({"book": b, "kind": "todo"}));
    for t in todos.as_array().unwrap() {
        if t["projection"] != "marker" || t["target"].is_null() {
            continue;
        }
        let blk = t["target_block"]
            .as_str()
            .expect("a projected TODO names its block");
        let doc = DocId::parse(&format!("node:{}", t["target"]["id"].as_str().unwrap())).unwrap();
        let want =
            CommentId::for_projection(&ProjectionKind::Marker, &doc, &BlockId::parse(blk).unwrap());
        assert_eq!(t["id"], want.as_str(), "projected TODO id");
        assert_eq!(t["body"], marker_task(blk).as_str(), "projected TODO body");
    }
}

/// Plot grids keep a row and a column, and their cells name them; every
/// listed patch belongs to its element and comes from a node that exists.
fn check_workshop(ws: &Workspace, b: &str) {
    for ch in ids(&list(ws, "chapter.list", json!({"book": b}))) {
        let g = list(ws, "plot_grid.get", json!({"book": b, "node": ch}));
        if g["exists"] == true {
            let (rows, cols) = (ids(&g["rows"]), ids(&g["columns"]));
            assert!(
                !rows.is_empty() && !cols.is_empty(),
                "a plot grid keeps a row and a column"
            );
            for cell in g["cells"].as_array().unwrap() {
                assert!(rows.contains(&cell["row"].as_str().unwrap().to_string()));
                assert!(cols.contains(&cell["column"].as_str().unwrap().to_string()));
            }
        }
    }
    let nodes: HashSet<String> = ids(&list(
        ws,
        "chapter.list",
        json!({"book": b, "trashed": true}),
    ))
    .into_iter()
    .chain(ids(&list(
        ws,
        "idea.list",
        json!({"book": b, "trashed": true}),
    )))
    .collect();
    for el in ids(&list(ws, "element.list", json!({"book": b}))) {
        for p in list(ws, "patch.list", json!({"book": b, "element": el}))
            .as_array()
            .unwrap()
        {
            assert_eq!(p["element"], el.as_str());
            if let Some(src) = p["source"].as_str() {
                assert!(nodes.contains(src), "a patch's source exists");
            }
        }
    }
}

fn check_single(ws: &Workspace, b: &str) {
    check_projections(ws, b);
    check_workshop(ws, b);
    let key = |s: &str| s.trim().to_lowercase();
    let unique = |what: &str, names: Vec<String>| {
        let mut seen = HashSet::new();
        for n in names {
            assert!(seen.insert(key(&n)), "{what} {n:?} is not unique");
        }
    };
    let chapters = list(ws, "chapter.list", json!({"book": b}));
    let ideas = list(ws, "idea.list", json!({"book": b}));
    // TITLE-SUFFIX: chapters and ideas share one namespace.
    unique(
        "node title",
        field(&chapters, "title")
            .into_iter()
            .chain(field(&ideas, "title"))
            .map(|v| v.as_str().unwrap().to_string())
            .collect(),
    );
    unique(
        "storyline",
        field(&list(ws, "storyline.list", json!({"book": b})), "name")
            .into_iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect(),
    );
    unique(
        "category",
        field(&list(ws, "category.list", json!({"book": b})), "name")
            .into_iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect(),
    );
    // ELEMENT-NAME-UNIQUE, names and aliases together.
    let els = list(ws, "element.list", json!({"book": b}));
    let mut names = Vec::new();
    for e in els.as_array().unwrap() {
        assert_eq!(e["name_conflict"], Value::Null, "no conflict on one device");
        names.push(e["name"].as_str().unwrap().to_string());
        names.extend(
            e["aliases"]
                .as_array()
                .unwrap()
                .iter()
                .map(|a| a.as_str().unwrap().to_string()),
        );
    }
    unique(
        "element name",
        names.into_iter().filter(|n| !n.trim().is_empty()).collect(),
    );
    check_tolerant(ws, b);
    // CHAPTER-HAS-ORDER.
    for ch in chapters.as_array().unwrap() {
        assert!(ch["book_order"].is_number(), "chapter without book order");
    }
    // TREE-DEPTH.
    let groups = list(ws, "idea_group.list", json!({"book": b}));
    let parent: BTreeMap<String, Option<String>> = groups
        .as_array()
        .unwrap()
        .iter()
        .map(|g| {
            (
                g["id"].as_str().unwrap().into(),
                g["parent"].as_str().map(String::from),
            )
        })
        .collect();
    for g in parent.keys() {
        let mut d = 1;
        let mut cur = parent[g].clone();
        while let Some(p) = cur {
            d += 1;
            cur = parent.get(&p).cloned().flatten();
        }
        assert!(d <= 2, "idea group {g} is {d} levels deep");
    }
}

/// What holds after any merge too: reads are tolerant.
fn check_tolerant(ws: &Workspace, b: &str) {
    check_workshop(ws, b);
    check_projections(ws, b);
    let lib = ws.library();
    let live: HashSet<String> = ids(&list(ws, "chapter.list", json!({"book": b})))
        .into_iter()
        .chain(ids(&list(ws, "element.list", json!({"book": b}))))
        .chain(ids(&list(ws, "idea.list", json!({"book": b}))))
        .collect();
    for r in list(ws, "relation.list", json!({"book": b}))
        .as_array()
        .unwrap()
    {
        for end in ["from", "to"] {
            assert!(
                live.contains(r[end]["id"].as_str().unwrap()),
                "a shown relation has a live end"
            );
        }
        assert_ne!(r["from"], r["to"]);
    }
    // CROSS-DOC-ORDER: every entity's prose document is stored.
    for (cmd, prefix) in [
        ("chapter.list", "node"),
        ("element.list", "element"),
        ("idea.list", "node"),
    ] {
        for id in ids(&list(ws, cmd, json!({"book": b, "trashed": true}))) {
            assert!(
                lib.doc_info(&format!("{prefix}:{id}")).unwrap().is_some(),
                "{prefix}:{id} has no prose document"
            );
        }
    }
    for cm in list(ws, "comment.list", json!({"book": b}))
        .as_array()
        .unwrap()
    {
        if let Some(t) = cm["target"].as_object() {
            let shown = live.contains(t["id"].as_str().unwrap());
            assert_eq!(
                cm["unlocated"],
                json!(!shown),
                "a comment's target is shown or it is unlocated"
            );
        }
    }
    // Element name conflicts after a merge: one keeps the name.
    let els = list(ws, "element.list", json!({"book": b}));
    let mut by_key: BTreeMap<String, Vec<&Value>> = BTreeMap::new();
    for e in els.as_array().unwrap() {
        by_key
            .entry(e["name"].as_str().unwrap().trim().to_lowercase())
            .or_default()
            .push(e);
    }
    for (k, v) in by_key {
        if k.is_empty() {
            continue;
        }
        let free = v.iter().filter(|e| e["name_conflict"].is_null()).count();
        assert!(free <= 1, "{k:?}: {free} elements claim the name");
    }
}

fn cases() -> u32 {
    std::env::var("DR_PROP_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(16)
}

proptest! {
    #![proptest_config(ProptestConfig { cases: cases(), ..ProptestConfig::default() })]

    #[test]
    fn random_commands_keep_the_invariants(ops in prop::collection::vec(op(), 1..36)) {
        play(&ops);
    }

    #[test]
    fn two_devices_merge_into_one_readable_book(
        a_ops in prop::collection::vec(op(), 1..24),
        b_ops in prop::collection::vec(op(), 1..24),
    ) {
        let a = env();
        let z = env();
        let book = a.book();
        // One chapter both devices start from, so both can edit and
        // project the same paragraphs.
        a.call(
            "chapter.create",
            json!({"book": book, "title": "共有", "text": "一段。\n安娜在这里。\n第三段。"}),
        );
        sync(a.ws(), z.ws());
        let (mut ta, mut tz) = (0, 0);
        for op in a_ops.iter().filter(|o| !matches!(o, Op::Reopen | Op::Fault(_))) {
            run(a.ws(), &a.faults, &book, op, &mut ta);
        }
        for op in b_ops.iter().filter(|o| !matches!(o, Op::Reopen | Op::Fault(_))) {
            run(z.ws(), &z.faults, &book, op, &mut tz);
        }
        sync(a.ws(), z.ws());
        sync(z.ws(), a.ws());
        sync(a.ws(), z.ws());
        for cmd in ["chapter.list", "element.list", "relation.list", "comment.list", "storyline.list", "category.list", "idea.list", "idea_group.list"] {
            let input = json!({"book": book, "trashed": true});
            let input = if cmd == "relation.list" || cmd == "comment.list" || cmd == "idea_group.list" { json!({"book": book}) } else { input };
            prop_assert_eq!(list(a.ws(), cmd, input.clone()), list(z.ws(), cmd, input), "{} differs after the merge", cmd);
        }
        check_tolerant(a.ws(), &book);
        check_tolerant(z.ws(), &book);
    }
}

/// Run `ops` on one device, checking after every step and after reopening.
fn play(ops: &[Op]) {
    let mut e = env();
    let b = e.book();
    let mut turn = 0;
    let snapshot = |e: &Env| {
        [
            "chapter.list",
            "element.list",
            "storyline.list",
            "category.list",
            "idea.list",
        ]
        .iter()
        .map(|c| list(e.ws(), c, json!({"book": b, "trashed": true})))
        .chain(
            ["relation.list", "comment.list", "idea_group.list"]
                .iter()
                .map(|c| list(e.ws(), c, json!({"book": b}))),
        )
        .collect::<Vec<_>>()
    };
    for op in ops {
        if run(e.ws(), &e.faults, &b, op, &mut turn) {
            let before = snapshot(&e);
            e.faults.disarm();
            e.reopen();
            assert_eq!(snapshot(&e), before, "reopened from disk");
        }
        check_single(e.ws(), &b);
    }
    e.faults.disarm();
    let before = snapshot(&e);
    e.reopen();
    assert_eq!(snapshot(&e), before, "reopened from disk at the end");
    check_single(e.ws(), &b);
}

/// A chapter converted back to its idea is still a live node. A projection
/// made after conversion keeps its location; it is not an orphan merely
/// because the node moved out of chapter.list.
#[test]
fn regression_projected_todo_stays_located_when_conversion_is_undone() {
    let e = env();
    let book = e.book();
    let mut turn = 0;
    for op in [Op::Idea(0), Op::ConvertIdea(0, 2), Op::Project(1, 197)] {
        run(e.ws(), &e.faults, &book, &op, &mut turn);
    }
    let chapter = ids(&list(e.ws(), "chapter.list", json!({"book": book})))[0].clone();
    let before = list(e.ws(), "comment.list", json!({"book": book}));
    assert!(!before.as_array().unwrap().is_empty());
    run(e.ws(), &e.faults, &book, &Op::Undo, &mut turn);
    assert!(ids(&list(e.ws(), "idea.list", json!({"book": book}))).contains(&chapter));
    let after = list(e.ws(), "comment.list", json!({"book": book}));
    assert_eq!(before, after);
    for comment in after.as_array().unwrap() {
        assert_eq!(comment["target"], json!({"kind": "node", "id": chapter}));
        assert_eq!(comment["unlocated"], false);
    }
    check_single(e.ws(), &book);
}

#[test]
fn regression_cache_after_purges_and_reopen() {
    use Op::*;
    play(&[
        DeleteGroup(231),
        Element(251, false),
        SetCategory(176, 74),
        Relate(52, 90),
        TrashChapter(191),
        Relate(2, 187),
        Group(172, None),
        ChapterText(49),
        Idea(158),
        Element(97, true),
        MoveGroup(118, None),
        RenameElement(202, 13),
        AliasElement(200, 250),
        RestoreChapter(193),
        PurgeStoryline(73),
        PurgeCategory(71),
        MoveIdea(92, 67),
        Reopen,
    ]);
}

/// Send every stored document of `from` to `to`, as the sync service would.
fn sync(from: &Workspace, to: &Workspace) {
    for d in from.library().docs(None, None).unwrap() {
        let book = d.book_id.clone().unwrap_or_default();
        match from.library().load_copy(&d.doc_id) {
            Ok(doc) => {
                let bytes = doc.export(ExportMode::all_updates()).unwrap();
                to.import_remote(&d.doc_id, Some((&d.kind, &book)), bytes, &Actor::Sync)
                    .unwrap();
            }
            Err(dr_store::StoreError::NotFound(_)) => {
                to.library()
                    .register(&d.doc_id, &d.kind, d.book_id.as_deref())
                    .unwrap();
            }
            Err(e) => panic!("{e}"),
        }
    }
}

#[test]
fn concurrent_creates_of_one_name_are_flagged_not_lost() {
    let a = env();
    let z = env();
    let book = a.book();
    sync(a.ws(), z.ws());
    call(
        a.ws(),
        &Actor::User,
        "element.create",
        json!({"book": book, "name": "Anna"}),
    );
    call(
        z.ws(),
        &Actor::User,
        "element.create",
        json!({"book": book, "name": "anna"}),
    );
    call(
        a.ws(),
        &Actor::User,
        "chapter.create",
        json!({"book": book, "title": "Same"}),
    );
    call(
        z.ws(),
        &Actor::User,
        "chapter.create",
        json!({"book": book, "title": "Same"}),
    );
    sync(a.ws(), z.ws());
    sync(z.ws(), a.ws());
    let els = list(a.ws(), "element.list", json!({"book": book}));
    assert_eq!(els.as_array().unwrap().len(), 2, "both kept");
    assert_eq!(
        els.as_array()
            .unwrap()
            .iter()
            .filter(|e| !e["name_conflict"].is_null())
            .count(),
        1,
        "one flagged"
    );
    assert_eq!(
        field(
            &list(a.ws(), "chapter.list", json!({"book": book})),
            "title"
        ),
        [json!("Same"), json!("Same")],
        "a merge may duplicate titles; both shown"
    );
    check_tolerant(a.ws(), &book);
    // The next rename on either device resolves it with a suffix.
    let ch = ids(&list(a.ws(), "chapter.list", json!({"book": book})));
    let r = call(
        a.ws(),
        &Actor::User,
        "chapter.update",
        json!({"book": book, "id": ch[1], "title": "Same"}),
    );
    assert_eq!(r["output"]["name"], "Same 2");
    let _ = Arc::new(());
}

/// Found by the 3000-case run: closing right after a command could meet
/// dr-store's background index rebuild holding a document for a moment,
/// and the close was refused (`DocumentsOpen`). Shutdown now retries.
#[test]
fn regression_shutdown_during_the_index_rebuild() {
    use Op::*;
    for _ in 0..20 {
        play(&[MoveGroup(137, None), Undo]);
    }
}
