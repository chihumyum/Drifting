//! One or more tests per command and query.

mod common;

use common::*;
use dr_workspace::{Actor, WsError, registry};
use serde_json::{Value, json};

fn chapter(e: &Env, book: &str, title: &str) -> String {
    e.out("entry.create", json!({"book": book, "parent": common::acceptance::novel_root(e.ws(), &book, "tpl-manuscript"), "template": "tpl-chapter", "title": title}))["id"]
        .as_str()
        .unwrap()
        .into()
}

#[test]
fn books_create_list_update_trash() {
    let e = env();
    let b = e.book();
    let list = e.out("book.list", json!({}));
    assert_eq!(ids(&list), std::slice::from_ref(&b));
    e.call(
        "book.update",
        json!({"book": b, "name": "Renamed", "word_target": 0, "daily_word_target": 800}),
    );
    let got = e.out("book.get", json!({"book": b}));
    assert_eq!(got["name"], "Renamed");
    assert_eq!(got["word_target"], Value::Null, "0 turns the target off");
    assert_eq!(got["daily_word_target"], 800);
    e.call("book.trash", json!({"book": b}));
    assert!(ids(&e.out("book.list", json!({}))).is_empty());
    assert_eq!(
        ids(&e.out("book.list", json!({"trashed": true}))),
        std::slice::from_ref(&b)
    );
    e.call("book.restore", json!({"book": b}));
    assert_eq!(ids(&e.out("book.list", json!({}))), [b]);
    assert!(matches!(
        e.try_call("project.create", json!({"name": "  "})),
        Err(WsError::Violation(_))
    ));
    assert!(matches!(
        e.try_call("book.get", json!({"book": "nope"})),
        Err(WsError::NotFound { .. })
    ));
}

#[test]
fn comments_with_anchors_and_metadata() {
    let e = env();
    let b = e.book();
    let c = e.out(
        "entry.create", json!({"book": b, "parent": common::acceptance::novel_root(e.ws(), &b, "tpl-manuscript"), "template": "tpl-chapter", "title": "One", "bodies": {"mod-prose": "安娜走进了房间。"}}),
    )["id"]
        .clone();
    let cm = e.out(
        "comment.create",
        json!({"book": b, "kind": "todo", "target": {"kind": "entry", "id": c},
        "module":"mod-prose", "range": [0, 2], "body": "rename?", "priority": "high"}),
    )["id"]
        .clone();
    let got = &e.out("comment.list", json!({"book": b, "kind": "todo"}))[0];
    assert_eq!(
        (
            got["quote"].clone(),
            got["anchored"].clone(),
            got["priority"].clone()
        ),
        (json!("安娜"), json!(true), json!("high"))
    );
    e.call(
        "comment.update",
        json!({"book": b, "id": cm, "status": "resolved", "body": "done"}),
    );
    let got = &e.out("comment.list", json!({"book": b}))[0];
    assert_eq!(
        (got["status"].clone(), got["body"].clone()),
        (json!("resolved"), json!("done"))
    );
    assert!(
        e.out("comment.list", json!({"book": b, "status": "open"}))
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        matches!(
            e.try_call(
                "comment.create",
                json!({"book": b, "block_id": "b1", "body": "x"})
            ),
            Err(WsError::Invalid(_))
        ),
        "a block needs a target"
    );
    e.call("comment.delete", json!({"book": b, "id": cm}));
    assert!(
        e.out("comment.list", json!({"book": b}))
            .as_array()
            .unwrap()
            .is_empty()
    );
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert_eq!(e.out("comment.list", json!({"book": b}))[0]["body"], "done");
}

#[test]
fn materials_folders_and_assets() {
    let e = env();
    let b = e.book();
    let f = e.out("material_folder.create", json!({"book": b, "name": "Refs"}))["id"].clone();
    let sub = e.out(
        "material_folder.create",
        json!({"book": b, "name": "Maps", "parent": f}),
    )["id"]
        .clone();
    assert!(matches!(
        e.try_call(
            "material_folder.update",
            json!({"book": b, "id": f, "parent": sub})
        ),
        Err(WsError::Invalid(_))
    ));
    e.call(
        "material_folder.update",
        json!({"book": b, "id": sub, "name": "Atlas"}),
    );
    let fs = e.out("material_folder.list", json!({"book": b}));
    assert_eq!(field(&fs, "name"), [json!("Refs"), json!("Atlas")]);
    assert_eq!(fs[1]["parent"], f);
    let t = e.out(
        "material.create",
        json!({"book": b, "kind": "text", "title": "Note", "folder": sub, "text": "a note"}),
    )["id"]
        .clone();
    assert_eq!(
        e.out(
            "prose.read",
            json!({"doc": format!("material:{}", t.as_str().unwrap())})
        )["paragraphs"][0]["text"],
        "a note"
    );
    assert!(
        matches!(
            e.try_call(
                "material.create",
                json!({"book": b, "kind": "image", "title": "pic"})
            ),
            Err(WsError::Violation(_))
        ),
        "an image needs its asset"
    );
    let sha = "a".repeat(64);
    e.call("asset.put", json!({"book": b, "id": "asset-1", "kind": "image", "mime": "image/png", "size": 10, "sha256": sha, "width": 2, "height": 2}));
    assert!(matches!(e.try_call("asset.put", json!({"book": b, "id": "asset-1", "kind": "image", "mime": "image/png", "size": 11, "sha256": sha, "width": 2, "height": 2})), Err(WsError::Locked(_))));
    let got = e.out("asset.get", json!({"book": b, "id": "asset-1"}));
    assert_eq!(
        got,
        json!({"id": "asset-1", "kind": "image", "mime": "image/png", "size": 10, "width": 2, "height": 2})
    );
    assert!(matches!(
        e.try_call("asset.get", json!({"book": b, "id": "asset-2"})),
        Err(WsError::NotFound { .. })
    ));
    let img = e.out(
        "material.create",
        json!({"book": b, "kind": "image", "title": "pic", "asset": "asset-1", "place": "first"}),
    )["id"]
        .clone();
    assert_eq!(
        ids(&e.out("material.list", json!({"book": b})))[0],
        img.as_str().unwrap()
    );
    e.call(
        "material.move",
        json!({"book": b, "id": img, "place": "last"}),
    );
    assert_eq!(
        ids(&e.out("material.list", json!({"book": b})))
            .last()
            .unwrap(),
        img.as_str().unwrap()
    );
    e.call(
        "material.update",
        json!({"book": b, "id": t, "description": "about maps", "task_todos": false, "folder": f}),
    );
    let m = e.out("material.list", json!({"book": b, "folder": f}));
    assert_eq!(
        (m[0]["description"].clone(), m[0]["task_todos"].clone()),
        (json!("about maps"), json!(false))
    );
    e.call("material_folder.delete", json!({"book": b, "id": f}));
    assert_eq!(
        e.out("material.list", json!({"book": b, "folder": ""}))
            .as_array()
            .unwrap()
            .len(),
        2
    );
    e.call("material.delete", json!({"book": b, "id": img}));
    assert_eq!(
        e.out("material.list", json!({"book": b}))
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn prose_replace_is_exact() {
    let e = env();
    let b = e.book();
    let c = e.out(
        "entry.create", json!({"book": b, "parent": common::acceptance::novel_root(e.ws(), &b, "tpl-manuscript"), "template": "tpl-chapter", "title": "One", "bodies": {"mod-prose": "他说好。\n她说好。"}}),
    )["id"]
        .clone();
    let doc = format!("body:{}/mod-prose", c.as_str().unwrap());
    assert!(matches!(
        e.try_call(
            "prose.replace",
            json!({"doc": doc, "find": "说好", "replace": "答应"})
        ),
        Err(WsError::Ambiguous(_))
    ));
    assert!(matches!(
        e.try_call(
            "prose.replace",
            json!({"doc": doc, "find": "没有", "replace": "x"})
        ),
        Err(WsError::NotFound { .. })
    ));
    let p = e.out("prose.read", json!({"doc": doc}));
    let block = p["paragraphs"][1]["block_id"].clone();
    let r = e.out(
        "prose.replace",
        json!({"doc": doc, "find": "说好", "replace": "答应", "block_id": block}),
    );
    assert_eq!(r["block_id"], block);
    assert_eq!(
        e.out("prose.read", json!({"doc": doc}))["paragraphs"][1]["text"],
        "她答应。"
    );
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert_eq!(
        e.out("prose.read", json!({"doc": doc}))["paragraphs"][1]["text"],
        "她说好。"
    );
    assert!(matches!(
        e.try_call(
            "prose.replace",
            json!({"doc": doc, "find": "他", "replace": "a\nb"})
        ),
        Err(WsError::Invalid(_))
    ));
}

#[test]
fn prose_restore_goes_back_and_forth() {
    let e = env();
    let b = e.book();
    let c = e.out(
        "entry.create", json!({"book": b, "parent": common::acceptance::novel_root(e.ws(), &b, "tpl-manuscript"), "template": "tpl-chapter", "title": "One", "bodies": {"mod-prose": "原文。"}}),
    )["id"]
        .clone();
    let doc = format!("body:{}/mod-prose", c.as_str().unwrap());
    let v0 = e.out("prose.read", json!({"doc": doc}))["version"].clone();
    e.call(
        "prose.replace",
        json!({"doc": doc, "find": "原文", "replace": "改过"}),
    );
    e.call("prose.restore", json!({"doc": doc, "at": v0}));
    assert_eq!(
        e.out("prose.read", json!({"doc": doc}))["paragraphs"][0]["text"],
        "原文。"
    );
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert_eq!(
        e.out("prose.read", json!({"doc": doc}))["paragraphs"][0]["text"],
        "改过。"
    );
}

#[test]
fn writing_days_sum_devices_and_keep_each_device_to_its_key() {
    let e = env();
    let b = e.book();
    let mac = "device-000000000000000000000001";
    let win = "device-000000000000000000000002";
    let rec = |device: &str, day: &str, words: i64| {
        e.call(
            "writing_day.record",
            json!({"book": b, "device": device, "day": day, "words": words}),
        );
    };
    rec(mac, "2026-11-08", 300);
    rec(win, "2026-11-08", 200);
    rec(mac, "2026-11-07", 50);
    rec(mac, "2026-11-05", 10);
    rec(mac, "2026-11-08", 350);
    let got = e.out(
        "book.writing_days",
        json!({"book": b, "today": "2026-11-08", "days": 4, "device": mac}),
    );
    assert_eq!(
        field(&got["days"], "words"),
        [json!(10), json!(0), json!(50), json!(550)]
    );
    assert_eq!(got["days"][0]["day"], "2026-11-05");
    assert_eq!(got["today"], 550);
    assert_eq!(got["mine_today"], 350);
    assert_eq!(got["week"], 610);
    assert_eq!(got["active_days"], 3);
    assert_eq!(got["streak"], 2);
    // Not undoable: undo leaves the writing day alone.
    assert!(matches!(
        e.try_call(
            "writing_day.record",
            json!({"book": b, "device": "mac|1", "day": "2026-11-08", "words": 1})
        ),
        Err(WsError::Invalid(_))
    ));
    assert!(matches!(
        e.try_call(
            "writing_day.record",
            json!({"book": b, "device": mac, "day": "2026-13-01", "words": 1})
        ),
        Err(WsError::Invalid(_))
    ));
    assert!(matches!(
        e.try_call(
            "writing_day.record",
            json!({"book": b, "device": mac, "day": "2026-11-08", "words": -1})
        ),
        Err(WsError::Invalid(_))
    ));
}

#[test]
fn unknown_commands_and_bad_input() {
    let e = env();
    assert!(matches!(
        e.try_call("nope.nothing", json!({})),
        Err(WsError::UnknownCommand(_))
    ));
    match e.try_call("entry.create", json!({"title": "no book"})) {
        Err(err @ WsError::BadInput { .. }) => assert_eq!(err.code(), "bad_input"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn every_registered_entry_is_exercised_here() {
    // Keep this list in step with the registry: a new command needs a test
    // (here, in editor.rs for what the editor calls, in shelf.rs for the
    // shelf, recent pages and time pins, in points.rs for snapshot history,
    // in workshop.rs for plot grids, patches and templates, in levels.rs for
    // the switch).
    let srcs = [
        include_str!("commands.rs"),
        include_str!("project_shared.rs"),
        include_str!("cutover.rs"),
        include_str!("editor.rs"),
        include_str!("shelf.rs"),
        include_str!("points.rs"),
        include_str!("autolink.rs"),
        include_str!("workshop.rs"),
        include_str!("kernel_v3.rs"),
        include_str!("levels.rs"),
        include_str!("entry_snapshots.rs"),
        include_str!("v3_common.rs"),
        include_str!("v3_home.rs"),
        include_str!("v3_membership.rs"),
        include_str!("v3_timeline_edits.rs"),
        include_str!("../../dr-agent-tools/tests/checkpoints_v3.rs"),
    ];
    let missing: Vec<&str> = registry()
        .iter()
        .map(|s| s.name)
        .filter(|n| !srcs.iter().any(|src| src.contains(&format!("\"{n}\""))))
        .collect();
    assert!(missing.is_empty(), "no test calls {missing:?}");
}

/// M19: a comment can mark a rectangle on an image or a PDF page; it is
/// listed with its region, and refused anywhere else, with a range, or
/// outside the picture.
#[test]
fn region_comments_sit_on_image_and_pdf_materials() {
    let e = env();
    let b = e.out("project.create", json!({"name": "Regions"}))["id"].clone();
    let sha = "b".repeat(64);
    e.call("asset.put", json!({"book": b, "id": "asset-pdf", "kind": "pdf", "mime": "application/pdf", "size": 10, "sha256": sha}));
    let pdf = e.out(
        "material.create",
        json!({"book": b, "kind": "pdf", "title": "notes", "asset": "asset-pdf"}),
    )["id"]
        .clone();
    let note = e.out(
        "material.create",
        json!({"book": b, "kind": "text", "title": "note", "text": "a note"}),
    )["id"]
        .clone();
    let on = |id: &Value| json!({"kind": "material", "id": id});
    let region = json!({"page": 2, "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4});
    let c = e.out(
        "comment.create",
        json!({"book": b, "target": on(&pdf), "region": region, "body": "tide"}),
    )["id"]
        .clone();
    let listed = e.out("comment.list", json!({"book": b}));
    assert_eq!(listed[0]["id"], c);
    assert_eq!(listed[0]["region"], region);
    assert!(!listed[0]["anchored"].as_bool().unwrap());
    let refused = |input: Value| {
        matches!(
            e.try_call("comment.create", input),
            Err(WsError::Invalid(_))
        )
    };
    assert!(refused(
        json!({"book": b, "region": region, "body": "floating"})
    ));
    assert!(refused(
        json!({"book": b, "target": on(&note), "region": region, "body": "text"})
    ));
    let chapter = chapter(&e, b.as_str().unwrap(), "One");
    assert!(refused(
        json!({"book": b, "target": {"kind": "entry", "id": chapter},
                           "region": region, "body": "prose"})
    ));
    assert!(refused(
        json!({"book": b, "target": on(&pdf), "body": "outside",
                           "region": {"x": 0.8, "y": 0.0, "w": 0.5, "h": 0.1}})
    ));
    assert!(refused(
        json!({"book": b, "target": on(&pdf), "body": "both",
                           "region": region, "range": [0, 1]})
    ));
}

#[test]
fn project_facts_are_read_from_the_canonical_catalog_without_creating_a_legacy_writer() {
    let e = env();
    let b = e.book();
    assert!(
        e.out("fact.list", json!({"book":b}))
            .as_array()
            .unwrap()
            .is_empty()
    );
    let id = b.parse().unwrap();
    let h = e
        .ws()
        .library()
        .open_doc(&format!("book:{b}"), dr_store::OpenDoc::Existing)
        .unwrap();
    h.write(dr_store::Origin::Import, move |doc| {
        dr_doc::v3::BorrowedBookV3::new(doc, &id)
            .unwrap()
            .txn()
            .put_fact(&dr_model::shared::KvEntry {
                id: dr_model::id::KvEntryId::parse("imported-fact").unwrap(),
                key: "Genre".into(),
                value: "Synthetic".into(),
                pos: None,
            })
            .unwrap();
    })
    .unwrap();
    assert_eq!(
        e.out("fact.list", json!({"book":b}))[0]["value"],
        "Synthetic"
    );
    let at = e.ws().observe(&format!("book:{b}")).unwrap().version;
    assert_eq!(
        e.out("fact.list", json!({"book":b}))[0]["value"],
        "Synthetic"
    );
    assert_eq!(
        e.ws().observe(&format!("book:{b}")).unwrap().version,
        at,
        "reading facts is not a write"
    );
    let added = e.out(
        "fact.put",
        json!({"book":b,"key":"Canonical writer","value":"x"}),
    );
    assert!(
        e.out("fact.list", json!({"book":b}))
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["id"] == added["id"] && f["value"] == "x")
    );
}
