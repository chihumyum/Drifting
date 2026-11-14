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
    e.call("book.update", json!({"book": b, "name": "Renamed"}));
    e.call(
        "project.update",
        json!({"book": b, "word_target": 0, "daily_word_target": 800}),
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
        json!({"book": b, "origin": "marker", "target": {"kind": "entry", "id": c},
        "module":"mod-prose", "range": [0, 2], "body": "rename?", "priority": "high"}),
    )["id"]
        .clone();
    let got = &e.out("comment.list", json!({"book": b, "origin": "marker"}))[0];
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
fn assets_and_media_modules() {
    let e = env();
    let b = e.book();
    let sha = "a".repeat(64);
    e.call(
        "asset.put",
        json!({
            "book": b,
            "id": "asset-1",
            "kind": "image",
            "mime": "image/png",
            "size": 10,
            "sha256": sha,
            "width": 2,
            "height": 2
        }),
    );
    // Idempotent re-put of the same file can supply a missing display name.
    e.call(
        "asset.put",
        json!({
            "book": b,
            "id": "asset-1",
            "name": "harbor.png",
            "kind": "image",
            "mime": "image/png",
            "size": 10,
            "sha256": sha,
            "width": 2,
            "height": 2
        }),
    );
    // Diverging bytes/dimensions on an existing asset id are rejected (`AST-IMMUTABLE`).
    assert!(matches!(
        e.try_call(
            "asset.put",
            json!({
                "book": b,
                "id": "asset-1",
                "kind": "image",
                "mime": "image/png",
                "size": 11,
                "sha256": sha,
                "width": 2,
                "height": 2
            })
        ),
        Err(WsError::Locked(_))
    ));
    // Shape validation (`AST-SHAPE`): bad sha256 or image without dimensions is rejected.
    assert!(matches!(
        e.try_call(
            "asset.put",
            json!({
                "book": b,
                "id": "asset-bad-sha",
                "kind": "pdf",
                "mime": "application/pdf",
                "size": 10,
                "sha256": "short"
            })
        ),
        Err(WsError::Violation(_))
    ));
    assert!(matches!(
        e.try_call(
            "asset.put",
            json!({
                "book": b,
                "id": "asset-no-dim",
                "kind": "image",
                "mime": "image/png",
                "size": 10,
                "sha256": sha
            })
        ),
        Err(WsError::Violation(_))
    ));
    let got = e.out("asset.get", json!({"book": b, "id": "asset-1"}));
    assert_eq!(
        got,
        json!({
            "id": "asset-1",
            "name": "harbor.png",
            "kind": "image",
            "mime": "image/png",
            "size": 10,
            "sha256": sha,
            "width": 2,
            "height": 2
        })
    );
    let listed = e.out("asset.list", json!({"book": b}));
    assert_eq!(listed, json!([got]));
    assert!(matches!(
        e.try_call("asset.get", json!({"book": b, "id": "asset-2"})),
        Err(WsError::NotFound { .. })
    ));

    let materials_root = common::acceptance::novel_root(e.ws(), &b, "tpl-materials");
    let media_entry = e.out(
        "entry.create",
        json!({
            "book": b,
            "parent": materials_root,
            "template": "tpl-media",
            "title": "港湾照片"
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    e.call(
        "module.put_media",
        json!({
            "book": b,
            "entry": media_entry,
            "module": "mod-media",
            "item": {
                "id": "item-1",
                "asset": "asset-1",
                "caption": "北岸灯塔",
                "pos": "a0"
            }
        }),
    );
    let mod_data = e.out(
        "module.read",
        json!({"book": b, "entry": media_entry, "module": "mod-media"}),
    );
    assert_eq!(
        mod_data["media"],
        json!([{
            "id": "item-1",
            "asset": "asset-1",
            "caption": "北岸灯塔",
            "pos": "a0"
        }])
    );
    e.call(
        "module.remove_media",
        json!({"book": b, "entry": media_entry, "module": "mod-media", "item": "item-1"}),
    );
    assert!(
        e.out(
            "module.read",
            json!({"book": b, "entry": media_entry, "module": "mod-media"})
        )["media"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert_eq!(
        e.out("entry.get", json!({"book": b, "id": media_entry}))["media"]["mod-media"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn media_items_and_prose_embeds_require_registered_assets_and_tolerate_missing_on_read() {
    use dr_model::id::{AssetId, BookId, EmbedId, EntryId, MediaItemId, ModuleId};
    use dr_model::v3::MediaItem;

    let e = env();
    let b = e.book();
    let materials_root = common::acceptance::novel_root(e.ws(), &b, "tpl-materials");
    let media_entry = e.out(
        "entry.create",
        json!({
            "book": b,
            "parent": materials_root,
            "template": "tpl-media",
            "title": "海图"
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_string();

    // Command layer rejects unregistered assets in `module.put_media`.
    assert!(matches!(
        e.try_call(
            "module.put_media",
            json!({
                "book": b,
                "entry": media_entry,
                "module": "mod-media",
                "item": {"id": "item-missing", "asset": "asset-missing", "caption": "missing"}
            })
        ),
        Err(WsError::NotFound { .. })
    ));

    // Editor session rejects unregistered assets in `insert_asset_embed`, then accepts registered ones.
    let note_entry = e.out(
        "entry.create",
        json!({
            "book": b,
            "parent": materials_root,
            "template": "tpl-note",
            "title": "航行笔记",
            "bodies": {"mod-prose": "记录"}
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    let doc_id = format!("body:{note_entry}/mod-prose");
    let session = e.ws().prose_session(&doc_id).unwrap();
    let emb_id = EmbedId::parse("emb-1").unwrap();
    let unregistered = AssetId::parse("asset-missing").unwrap();
    assert!(matches!(
        session.insert_asset_embed(0, &emb_id, &unregistered),
        Err(WsError::NotFound { .. })
    ));

    let sha = "d".repeat(64);
    e.call(
        "asset.put",
        json!({
            "book": b,
            "id": "asset-ok",
            "name": "chart.png",
            "kind": "image",
            "mime": "image/png",
            "size": 24,
            "sha256": sha,
            "width": 16,
            "height": 16
        }),
    );
    let registered = AssetId::parse("asset-ok").unwrap();
    session.insert_asset_embed(0, &emb_id, &registered).unwrap();
    assert_eq!(
        e.out("prose.shape", json!({"doc": doc_id}))["embeds"],
        json!(["asset-ok"])
    );

    // Sync/import tolerance: a media item or prose embed referencing a missing asset reads without panic
    // and reports `missing: true` on `MediaItem`.
    let book_id = BookId::parse(&b).unwrap();
    let entry_id = EntryId::parse(&media_entry).unwrap();
    let h = e
        .ws()
        .library()
        .open_doc(&format!("book:{b}"), dr_store::OpenDoc::Existing)
        .unwrap();
    h.write(dr_store::Origin::Sync, move |doc| {
        let bb = dr_doc::v3::BorrowedBookV3::new(doc, &book_id).unwrap();
        bb.txn()
            .entries()
            .entry(&entry_id)
            .unwrap()
            .put_media(
                &ModuleId::parse("mod-media").unwrap(),
                &MediaItem {
                    id: MediaItemId::parse("item-dangling").unwrap(),
                    asset: AssetId::parse("asset-dangling").unwrap(),
                    caption: "dangling".into(),
                    pos: None,
                },
            )
            .unwrap();
    })
    .unwrap();
    let emb_dangling = EmbedId::parse("emb-dangling").unwrap();
    session
        .edit(move |txn| {
            txn.insert_embed(
                0,
                &emb_dangling,
                &dr_doc::prose::EmbedKind::Asset(AssetId::parse("asset-dangling").unwrap()),
            )?;
            Ok(())
        })
        .unwrap();

    let read_mod = e.out(
        "module.read",
        json!({"book": b, "entry": media_entry, "module": "mod-media"}),
    );
    assert_eq!(read_mod["media"][0]["asset"], "asset-dangling");
    assert_eq!(read_mod["media"][0]["missing"], true);
    let read_entry = e.out("entry.get", json!({"book": b, "id": media_entry}));
    assert_eq!(read_entry["media"]["mod-media"][0]["missing"], true);
    assert_eq!(
        e.out("prose.shape", json!({"doc": doc_id}))["embeds"],
        json!(["asset-dangling", "asset-ok"])
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

/// M19 / v5 §7: a comment can mark a rectangle on an image or a PDF page in a
/// `media` module item (or a prose `embed`); it is listed with its region, and
/// refused anywhere else, with a range, or outside `[0, 1]`.
#[test]
fn region_comments_sit_on_media_items_and_file_embeds() {
    let e = env();
    let b = e.out("project.create", json!({"name": "Regions"}))["id"].clone();
    let sha = "b".repeat(64);
    e.call(
        "asset.put",
        json!({
            "book": b,
            "id": "asset-pdf",
            "name": "notes.pdf",
            "kind": "pdf",
            "mime": "application/pdf",
            "size": 10,
            "sha256": sha
        }),
    );
    let materials_root = common::acceptance::novel_root(e.ws(), &b, "tpl-materials");
    let pdf_entry = e.out(
        "entry.create",
        json!({
            "book": b,
            "parent": materials_root,
            "template": "tpl-media",
            "title": "notes"
        }),
    )["id"]
        .clone();
    e.call(
        "module.put_media",
        json!({
            "book": b,
            "entry": pdf_entry,
            "module": "mod-media",
            "item": {"id": "pdf-item-1", "asset": "asset-pdf", "caption": "notes"}
        }),
    );
    let note = e.out(
        "entry.create",
        json!({
            "book": b,
            "parent": materials_root,
            "template": "tpl-note",
            "title": "note",
            "bodies": {"mod-prose": "a note"}
        }),
    )["id"]
        .clone();
    let on = |id: &Value| json!({"kind": "entry", "id": id});
    let region = json!({"page": 2, "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4});
    let part = json!({"kind": "media", "item": "pdf-item-1", "region": region});
    let c = e.out(
        "comment.create",
        json!({
            "book": b,
            "target": on(&pdf_entry),
            "module": "mod-media",
            "part": part,
            "body": "tide"
        }),
    )["id"]
        .clone();
    let listed = e.out("comment.list", json!({"book": b}));
    assert_eq!(listed[0]["id"], c);
    assert_eq!(listed[0]["part"], part);
    assert!(!listed[0]["anchored"].as_bool().unwrap());
    let refused = |input: Value| e.try_call("comment.create", input).is_err();
    assert!(refused(
        json!({"book": b, "part": part, "body": "floating"})
    ));
    assert!(refused(
        json!({"book": b, "target": on(&note), "module": "mod-prose", "part": part, "body": "text"})
    ));
    let chapter = chapter(&e, b.as_str().unwrap(), "One");
    assert!(refused(
        json!({"book": b, "target": {"kind": "entry", "id": chapter},
                           "part": part, "body": "no-module"})
    ));
    assert!(refused(
        json!({"book": b, "target": on(&pdf_entry), "module": "mod-media", "body": "outside",
                           "part": {"kind": "media", "item": "pdf-item-1", "region": {"x": 0.8, "y": 0.0, "w": 0.5, "h": 0.1}}})
    ));
    assert!(refused(
        json!({"book": b, "target": on(&pdf_entry), "module": "mod-media", "body": "both",
                           "part": part, "range": [0, 1]})
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

#[test]
fn layout_side_doc_put_get_and_clear() {
    let e = env();
    let b = e.book();
    let ideas = common::acceptance::novel_root(e.ws(), &b, "tpl-ideas");
    let card = e.out(
        "entry.create",
        json!({"book": b, "parent": ideas, "template": "tpl-idea", "title": "Idea"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    e.call(
        "layout.put",
        json!({"book": b, "scope": ideas, "mode": "board", "positions": { &card: [12.0, 34.0] }}),
    );
    assert_eq!(
        e.out(
            "layout.get",
            json!({"book": b, "scope": ideas, "mode": "board"})
        )[&card],
        json!([12.0, 34.0])
    );
    e.call(
        "layout.clear",
        json!({"book": b, "scope": ideas, "mode": "board", "entries": [&card]}),
    );
    assert_eq!(
        e.out(
            "layout.get",
            json!({"book": b, "scope": ideas, "mode": "board"})
        ),
        json!({})
    );
}
