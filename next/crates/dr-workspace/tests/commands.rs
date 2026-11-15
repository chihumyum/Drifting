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
    // Marker and checklist comments are only projected from prose: a caller
    // cannot write those origins (DY fix 7).
    for origin in ["marker", "task"] {
        assert!(matches!(
            e.try_call(
                "comment.create",
                json!({"book": b, "origin": origin, "target": {"kind": "entry", "id": c},
                "module":"mod-prose", "range": [0, 2], "body": "x"}),
            ),
            Err(WsError::Invalid(_))
        ));
    }
    let cm = e.out(
        "comment.create",
        json!({"book": b, "origin": "manual", "target": {"kind": "entry", "id": c},
        "module":"mod-prose", "range": [0, 2], "body": "rename?"}),
    )["id"]
        .clone();
    let got = &e.out("comment.list", json!({"book": b, "origin": "manual"}))[0];
    assert_eq!(
        (got["quote"].clone(), got["anchored"].clone()),
        (json!("安娜"), json!(true))
    );
    // A comment has no priority (`kernel-v5.md` §7).
    assert!(got.get("priority").is_none(), "{got}");
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
    assert!(got["created_at"].as_i64().is_some());
    assert_eq!(got["id"], "asset-1");
    assert_eq!(got["name"], "harbor.png");
    assert_eq!(got["kind"], "image");
    assert_eq!(got["mime"], "image/png");
    assert_eq!(got["size"], 10);
    assert_eq!(got["sha256"], sha);
    assert_eq!(got["width"], 2);
    assert_eq!(got["height"], 2);
    // In no folder of the library and not in Recently Deleted (DY fix 14).
    assert!(got["folder"].is_null(), "{got}");
    assert!(got["deleted_at"].is_null(), "{got}");
    assert_eq!(got["usages"], json!([]));
    let listed = e.out("asset.list", json!({"book": b}));
    assert_eq!(listed, json!([got]));
    assert!(matches!(
        e.try_call("asset.get", json!({"book": b, "id": "asset-2"})),
        Err(WsError::NotFound { .. })
    ));

    e.call(
        "entry_template.put",
        json!({
            "book": b,
            "template": {
                "id": "tpl-custom-media",
                "name": "自定义媒体",
                "modules": [{"id": "mod-media", "kind": "media", "name": "附件"}]
            }
        }),
    );
    let media_entry = e.out(
        "entry.create",
        json!({
            "book": b,
            "template": "tpl-custom-media",
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
    e.call(
        "entry_template.put",
        json!({
            "book": b,
            "template": {
                "id": "tpl-custom-media",
                "name": "自定义媒体",
                "modules": [{"id": "mod-media", "kind": "media", "name": "附件"}]
            }
        }),
    );
    let media_entry = e.out(
        "entry.create",
        json!({
            "book": b,
            "template": "tpl-custom-media",
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
    // the switch, in project_definition.rs for the project and its tabs).
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
        include_str!("project_definition.rs"),
        include_str!("../../dr-agent-tools/tests/checkpoints_v3.rs"),
    ];
    let missing: Vec<&str> = registry()
        .iter()
        .map(|s| s.name)
        .filter(|n| !srcs.iter().any(|src| src.contains(&format!("\"{n}\""))))
        .collect();
    assert!(missing.is_empty(), "no test calls {missing:?}");
}

/// M19 / v5 §7: a comment can mark a rectangle on an image or a PDF page of a
/// file in a `media` module (named by the file: a file is in a media module
/// once) or a prose `embed`; it is listed with its region, and refused
/// anywhere else, with a range, or outside `[0, 1]`.
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
    e.call(
        "entry_template.put",
        json!({
            "book": b,
            "template": {
                "id": "tpl-custom-media",
                "name": "自定义媒体",
                "modules": [{"id": "mod-media", "kind": "media", "name": "附件"}]
            }
        }),
    );
    let pdf_entry = e.out(
        "entry.create",
        json!({
            "book": b,
            "template": "tpl-custom-media",
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
            "template": "tpl-note",
            "title": "note",
            "bodies": {"mod-prose": "a note"}
        }),
    )["id"]
        .clone();
    let on = |id: &Value| json!({"kind": "entry", "id": id});
    let region = json!({"page": 2, "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4});
    let part = json!({"kind": "media", "asset": "asset-pdf", "region": region});
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
    let refused = |input: Value| e.try_call("comment.create", input).unwrap_err();
    // DY fix 14: each refusal is the error it should be.
    assert!(matches!(
        refused(json!({"book": b, "part": part, "body": "floating"})),
        WsError::Invalid(_)
    ));
    assert!(matches!(
        refused(
            json!({"book": b, "target": on(&note), "module": "mod-prose", "part": part, "body": "text"})
        ),
        WsError::Violation(_)
    ));
    let chapter = chapter(&e, b.as_str().unwrap(), "One");
    assert!(matches!(
        refused(
            json!({"book": b, "target": {"kind": "entry", "id": chapter},
                           "part": part, "body": "no-module"})
        ),
        WsError::Invalid(_)
    ));
    assert!(matches!(
        refused(
            json!({"book": b, "target": on(&pdf_entry), "module": "mod-media", "body": "outside",
                           "part": {"kind": "media", "asset": "asset-pdf", "region": {"page": 1, "x": 0.8, "y": 0.0, "w": 0.5, "h": 0.1}}})
        ),
        WsError::Invalid(_)
    ));
    assert!(matches!(
        refused(
            json!({"book": b, "target": on(&pdf_entry), "module": "mod-media", "body": "both",
                           "part": part, "range": [0, 1]})
        ),
        WsError::Invalid(_)
    ));
    assert!(matches!(
        refused(
            json!({"book": b, "target": on(&pdf_entry), "module": "mod-media", "body": "gone",
                           "part": {"kind": "media", "asset": "asset-not-here"}})
        ),
        WsError::NotFound { .. }
    ));
    // DY fix 18: a region on a PDF names its page.
    assert!(matches!(
        refused(
            json!({"book": b, "target": on(&pdf_entry), "module": "mod-media", "body": "no page",
                           "part": {"kind": "media", "asset": "asset-pdf", "region": {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2}}})
        ),
        WsError::Invalid(_)
    ));
    assert!(matches!(
        refused(
            json!({"book": b, "target": {"kind": "asset", "id": "asset-pdf"}, "body": "no page",
                       "part": {"kind": "region", "region": {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2}}})
        ),
        WsError::Invalid(_)
    ));
    // The file embed the test is named for: a region on a picture embedded in
    // prose, listed with it; an embed that is not there is refused.
    e.call(
        "asset.put",
        json!({"book": b, "id": "asset-pic", "name": "pic.png", "kind": "image",
               "mime": "image/png", "size": 10, "sha256": "c".repeat(64), "width": 4, "height": 3}),
    );
    let doc = format!("body:{chapter}/mod-prose");
    e.ws()
        .prose_session(&doc)
        .unwrap()
        .insert_asset_embed(
            0,
            &dr_model::id::EmbedId::parse("emb-pic").unwrap(),
            &dr_model::id::AssetId::parse("asset-pic").unwrap(),
        )
        .unwrap();
    let embed_part = json!({"kind": "embed", "embed": "emb-pic",
                            "region": {"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4}});
    let on_embed = e.out(
        "comment.create",
        json!({"book": b, "target": on(&json!(chapter)), "module": "mod-prose",
               "part": embed_part, "body": "钟楼"}),
    )["id"]
        .clone();
    let listed = e.out("comment.list", json!({"book": b}));
    let got = listed
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == on_embed)
        .unwrap();
    assert_eq!(got["part"], embed_part);
    assert_eq!(got["unlocated"], false);
    assert!(matches!(
        refused(
            json!({"book": b, "target": on(&json!(chapter)), "module": "mod-prose", "body": "x",
                       "part": {"kind": "embed", "embed": "emb-none"}})
        ),
        WsError::NotFound { .. }
    ));
    assert!(matches!(
        refused(
            json!({"book": b, "target": on(&json!(chapter)), "module": "mod-prose", "body": "x",
                       "part": {"kind": "embed", "embed": "emb-pic",
                                "region": {"page": 1, "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4}}})
        ),
        WsError::Invalid(_)
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

#[test]
fn asset_library_keeps_unreferenced_and_tracks_usages_trash_restore_purge() {
    use dr_model::id::{AssetId, EmbedId};
    use dr_store::asset::{SourceImport, Variant};

    let mut e = env();
    let b = e.book();

    // New "写书" project has no top-level "素材" entry and no tpl-materials / tpl-media.
    let roots = e.out("entry.list", json!({"book": b}));
    let root_titles: Vec<&str> = roots
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["title"].as_str().unwrap())
        .collect();
    assert_eq!(root_titles, ["书稿", "构想", "要素", "故事线"]);
    let tpl_ids = ids(&e.out("entry_template.list", json!({"book": b})));
    assert!(
        !tpl_ids
            .iter()
            .any(|t| t == "tpl-materials" || t == "tpl-media")
    );
    assert!(tpl_ids.iter().any(|t| t == "tpl-note"));

    // Import real bytes into storage and put an unreferenced asset into the asset library.
    let src_file = e.dir.path().join("north-map.png");
    std::fs::write(&src_file, b"\x89PNG\r\n\x1a\nsynthetic-map-bytes").unwrap();
    let stored = e
        .ws()
        .library()
        .import_asset(&SourceImport {
            book_id: &b,
            asset_id: "asset-lib-1",
            source: &src_file,
            mime: "image/png",
            ext: "png",
            dimensions: Some((4, 3)),
            limit: 1024 * 1024,
        })
        .unwrap();
    let stored_path = stored.path.clone();
    assert!(stored_path.exists());

    e.call(
        "asset.put",
        json!({
            "book": b,
            "id": "asset-lib-1",
            "name": "北岸地图.png",
            "kind": "image",
            "mime": stored.mime,
            "size": stored.size,
            "sha256": stored.sha256,
            "width": 4,
            "height": 3
        }),
    );

    // Unreferenced file survives workspace close & reopen (ASSET-LIBRARY-KEEPS-UNREFERENCED).
    e.reopen();
    let listed = e.out("asset.list", json!({"book": b}));
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["id"], "asset-lib-1");
    assert_eq!(listed[0]["name"], "北岸地图.png");
    assert!(listed[0]["folder"].is_null(), "at the top of the library");
    assert!(listed[0]["created_at"].is_i64());
    assert!(listed[0]["deleted_at"].is_null());
    assert_eq!(listed[0]["usages"], json!([]));
    assert!(
        e.ws()
            .library()
            .asset("asset-lib-1", Variant::Source)
            .unwrap()
            .is_some()
    );

    // Rename + Undo/Redo preserves binary identity (AST-IMMUTABLE).
    e.call(
        "asset.rename",
        json!({"book": b, "id": "asset-lib-1", "name": "北岸详图.png"}),
    );
    assert_eq!(
        e.out("asset.get", json!({"book": b, "id": "asset-lib-1"}))["name"],
        "北岸详图.png"
    );
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert_eq!(
        e.out("asset.get", json!({"book": b, "id": "asset-lib-1"}))["name"],
        "北岸地图.png"
    );
    e.ws().redo(&Actor::User).unwrap().unwrap();
    assert_eq!(
        e.out("asset.get", json!({"book": b, "id": "asset-lib-1"}))["name"],
        "北岸详图.png"
    );

    // Embed into 2 prose bodies, attach to 1 media module, and link 1 relation.
    let manuscript = common::acceptance::novel_root(e.ws(), &b, "tpl-manuscript");
    let ch1 = e.out(
        "entry.create",
        json!({"book": b, "parent": manuscript, "template": "tpl-chapter", "title": "第一章", "bodies": {"mod-prose": "甲"}}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let ch2 = e.out(
        "entry.create",
        json!({"book": b, "parent": manuscript, "template": "tpl-chapter", "title": "第二章", "bodies": {"mod-prose": "乙"}}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let doc1 = format!("body:{ch1}/mod-prose");
    let doc2 = format!("body:{ch2}/mod-prose");
    let aid = AssetId::parse("asset-lib-1").unwrap();
    e.ws()
        .prose_session(&doc1)
        .unwrap()
        .insert_asset_embed(0, &EmbedId::parse("emb-ch1").unwrap(), &aid)
        .unwrap();
    e.ws()
        .prose_session(&doc2)
        .unwrap()
        .insert_asset_embed(0, &EmbedId::parse("emb-ch2").unwrap(), &aid)
        .unwrap();

    e.call(
        "entry_template.put",
        json!({
            "book": b,
            "template": {
                "id": "tpl-gallery",
                "name": "图册",
                "modules": [{"id": "mod-media", "kind": "media", "name": "附件"}]
            }
        }),
    );
    let gallery = e.out(
        "entry.create",
        json!({"book": b, "template": "tpl-gallery", "title": "附图"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    e.call(
        "module.put_media",
        json!({
            "book": b,
            "entry": gallery,
            "module": "mod-media",
            "item": {"id": "m-1", "asset": "asset-lib-1", "caption": "海岸线"}
        }),
    );
    let generic_rt = format!("system:generic-association:{b}");
    let rel = e.out(
        "relation.create",
        json!({
            "book": b,
            "relation_type": generic_rt,
            "from": {"kind": "entry", "id": ch1},
            "to": {"kind": "asset", "id": "asset-lib-1"}
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let usages = e.out("asset.list", json!({"book": b}))[0]["usages"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(usages.len(), 4);
    assert_eq!(usages.iter().filter(|u| u["kind"] == "embed").count(), 2);
    assert_eq!(
        usages
            .iter()
            .filter(|u| u["kind"] == "media" && u["entry"] == gallery && u["item"] == "m-1")
            .count(),
        1
    );
    assert_eq!(
        usages
            .iter()
            .filter(|u| u["kind"] == "relation" && u["relation"] == rel)
            .count(),
        1
    );

    // Live asset cannot be purged before trashing.
    assert!(matches!(
        e.try_call("asset.purge", json!({"book": b, "id": "asset-lib-1"})),
        Err(WsError::Invalid(_))
    ));

    // Trash moves to Recently Deleted; embeds and media read as placeholders, relation hides, bytes remain.
    e.call("asset.trash", json!({"book": b, "id": "asset-lib-1"}));
    assert_eq!(e.out("asset.list", json!({"book": b})), json!([]));
    let trashed_list = e.out("asset.list", json!({"book": b, "trashed": true}));
    assert_eq!(trashed_list.as_array().unwrap().len(), 1);
    assert!(trashed_list[0]["deleted_at"].is_i64());
    assert_eq!(
        e.out("prose.shape", json!({"doc": doc1}))["missing_embeds"],
        json!(["asset-lib-1"])
    );
    assert_eq!(
        e.out("prose.shape", json!({"doc": doc2}))["missing_embeds"],
        json!(["asset-lib-1"])
    );
    assert_eq!(
        e.out(
            "module.read",
            json!({"book": b, "entry": gallery, "module": "mod-media"})
        )["media"][0]["missing"],
        true
    );
    assert_eq!(e.out("relation.list", json!({"book": b})), json!([]));
    assert!(stored_path.exists());

    // Restore brings everything back; undo of trash also restores.
    e.call("asset.restore", json!({"book": b, "id": "asset-lib-1"}));
    assert!(e.out("prose.shape", json!({"doc": doc1}))["missing_embeds"].is_null());
    assert!(e.out("prose.shape", json!({"doc": doc2}))["missing_embeds"].is_null());
    assert!(
        e.out(
            "module.read",
            json!({"book": b, "entry": gallery, "module": "mod-media"})
        )["media"][0]["missing"]
            .is_null()
    );
    assert_eq!(
        e.out("relation.list", json!({"book": b}))
            .as_array()
            .unwrap()
            .len(),
        1
    );

    e.call("asset.trash", json!({"book": b, "id": "asset-lib-1"}));
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert_eq!(
        e.out("asset.list", json!({"book": b}))
            .as_array()
            .unwrap()
            .len(),
        1
    );

    // Trash + Purge permanently removes manifest record, dangling relation, and stored bytes.
    e.call("asset.trash", json!({"book": b, "id": "asset-lib-1"}));
    e.call("asset.purge", json!({"book": b, "id": "asset-lib-1"}));
    assert!(matches!(
        e.try_call("asset.get", json!({"book": b, "id": "asset-lib-1"})),
        Err(WsError::NotFound { .. })
    ));
    assert_eq!(
        e.out("asset.list", json!({"book": b, "trashed": true})),
        json!([])
    );
    assert!(
        e.ws()
            .library()
            .asset("asset-lib-1", Variant::Source)
            .unwrap()
            .is_none()
    );
    assert!(!stored_path.exists());
}

/// Real bytes for `asset` in `book`, recorded in its asset library.
fn stored_asset(e: &Env, book: &str, asset: &str, name: &str, bytes: &[u8]) -> Value {
    use dr_store::asset::SourceImport;
    let src = e.dir.path().join(format!("{asset}.png"));
    std::fs::write(&src, bytes).unwrap();
    let stored = e
        .ws()
        .library()
        .import_asset(&SourceImport {
            book_id: book,
            asset_id: asset,
            source: &src,
            mime: "image/png",
            ext: "png",
            dimensions: Some((2, 2)),
            limit: 1 << 20,
        })
        .unwrap();
    e.call(
        "asset.put",
        json!({
            "book": book, "id": asset, "name": name, "kind": "image",
            "mime": stored.mime, "size": stored.size, "sha256": stored.sha256,
            "width": 2, "height": 2
        }),
    );
    json!({"path": stored.path, "sha256": stored.sha256, "size": stored.size})
}

/// DY fix 1: purging a trashed file retires the undo steps that would bring
/// its record back, and history refuses to revive a purged record, so the
/// library never shows a file whose bytes are gone.
#[test]
fn a_purged_file_does_not_come_back_through_undo_or_entry_history() {
    use dr_store::asset::Variant;
    let mut e = env();
    let b = e.book();
    // A step that has nothing to do with the file, made before its steps.
    let ch = chapter(&e, &b, "一");
    e.call(
        "entry.update",
        json!({"book": b, "id": ch, "title": "改过的"}),
    );
    stored_asset(
        &e,
        &b,
        "asset-gone",
        "gone.png",
        b"\x89PNG\r\n\x1a\npurged-bytes",
    );
    e.call(
        "asset.rename",
        json!({"book": b, "id": "asset-gone", "name": "renamed.png"}),
    );
    let before = e.out("entry_history.version", json!({"book": b}))["version"].clone();
    e.call("asset.trash", json!({"book": b, "id": "asset-gone"}));
    e.call("asset.purge", json!({"book": b, "id": "asset-gone"}));
    // The retired steps stay retired across a restart, and only they are:
    // Undo passes over the trash and the rename to the step before them.
    e.reopen();
    let undone = e.ws().undo_in(&Actor::User, &b, None).unwrap();
    assert_eq!(
        undone.map(|u| u.entry.command),
        Some("entry.update".to_owned()),
        "neither the trash nor the rename is undone into an empty file"
    );
    assert_eq!(
        e.out("entry.get", json!({"book": b, "id": ch}))["title"],
        "一"
    );
    assert!(matches!(
        e.try_call("asset.get", json!({"book": b, "id": "asset-gone"})),
        Err(WsError::NotFound { .. })
    ));
    assert_eq!(
        e.out("asset.list", json!({"book": b, "trashed": true})),
        json!([])
    );
    let revived = e.try_call(
        "entry_history.restore",
        json!({"book": b, "at": before, "targets": [{"collection": "assets", "id": "asset-gone"}]}),
    );
    assert!(
        matches!(revived, Err(WsError::NotFound { .. })),
        "{revived:?}"
    );
    assert!(
        e.ws()
            .library()
            .asset("asset-gone", Variant::Source)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        e.out("asset.list", json!({"book": b, "trashed": true})),
        json!([])
    );
}

/// DY fix 12: a book's purge deletes only its own bytes, never another
/// book's file stored under the same id (a record that arrived by sync).
#[test]
fn purging_a_file_never_deletes_another_books_bytes() {
    use dr_store::asset::Variant;
    let e = env();
    let a = e.book();
    let c = e.book();
    let stored = stored_asset(
        &e,
        &a,
        "asset-shared",
        "map.png",
        b"\x89PNG\r\n\x1a\nshared",
    );
    let record = dr_model::shared::Asset {
        id: dr_model::id::AssetId::parse("asset-shared").unwrap(),
        name: "map.png".into(),
        kind: dr_model::kind::AssetKind::Image,
        mime: "image/png".into(),
        size: stored["size"].as_i64().unwrap(),
        sha256: stored["sha256"].as_str().unwrap().into(),
        width: Some(2),
        height: Some(2),
        created_at: None,
        folder: None,
        pos: None,
        deleted_at: None,
        trashed_with: None,
    };
    let id = c.parse().unwrap();
    e.ws()
        .library()
        .open_doc(&format!("book:{c}"), dr_store::OpenDoc::Existing)
        .unwrap()
        .write(dr_store::Origin::Import, move |doc| {
            dr_doc::v3::BorrowedBookV3::new(doc, &id)
                .unwrap()
                .txn()
                .put_asset(&record)
                .unwrap();
        })
        .unwrap();
    e.call("asset.trash", json!({"book": c, "id": "asset-shared"}));
    e.call("asset.purge", json!({"book": c, "id": "asset-shared"}));
    assert!(std::path::Path::new(stored["path"].as_str().unwrap()).exists());
    assert!(
        e.ws()
            .library()
            .asset("asset-shared", Variant::Source)
            .unwrap()
            .is_some_and(|r| r.book_id == a)
    );
    assert_eq!(
        e.out("asset.get", json!({"book": a, "id": "asset-shared"}))["name"],
        "map.png"
    );
}

/// DY fix 13: entry history refuses a restore that would trash (or leave
/// absent) an entry that still has live entries under it, both when the
/// entry did not exist yet and when it was in the trash then.
#[test]
fn entry_history_refuses_to_trash_an_entry_with_live_children() {
    let e = env();
    let b = e.book();
    let manuscript = common::acceptance::novel_root(e.ws(), &b, "tpl-manuscript");
    let version = |e: &Env| e.out("entry_history.version", json!({"book": b}))["version"].clone();
    let restore = |e: &Env, at: &Value, id: &str| {
        e.try_call(
            "entry_history.restore",
            json!({"book": b, "at": at, "targets": [{"collection": "entries", "id": id}]}),
        )
    };
    let before_group = version(&e);
    let group = e.out(
        "entry.create",
        json!({"book": b, "parent": manuscript, "template": "tpl-group", "title": "第一卷"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let child = chapter_in(&e, &b, &group, "一");
    let refused = restore(&e, &before_group, &group);
    assert!(matches!(refused, Err(WsError::Invalid(_))), "{refused:?}");
    // In the trash then, with a chapter under it now.
    let other = e.out(
        "entry.create",
        json!({"book": b, "parent": manuscript, "template": "tpl-group", "title": "第二卷"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    e.call("entry.trash", json!({"book": b, "id": other}));
    let trashed_then = version(&e);
    e.call("entry.restore", json!({"book": b, "id": other}));
    chapter_in(&e, &b, &other, "二");
    let refused = restore(&e, &trashed_then, &other);
    assert!(matches!(refused, Err(WsError::Invalid(_))), "{refused:?}");
    for id in [&group, &other, &child] {
        assert!(
            e.out("entry.get", json!({"book": b, "id": id}))["deleted_at"].is_null(),
            "{id} untouched"
        );
    }
}

/// DY fix 13: an entry restored into the trash is not asked whether its
/// parent can still hold entries (it does not live there any more).
#[test]
fn entry_history_restores_an_entry_into_the_trash_under_a_parent_that_is_no_level() {
    let e = env();
    let b = e.book();
    let manuscript = common::acceptance::novel_root(e.ws(), &b, "tpl-manuscript");
    let folder = e.out(
        "entry.create",
        json!({"book": b, "parent": manuscript, "template": "tpl-group", "title": "第一卷"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let child = chapter_in(&e, &b, &folder, "一");
    e.call(
        "entry.update",
        json!({"book": b, "id": child, "title": "一（旧）"}),
    );
    e.call("entry.trash", json!({"book": b, "id": child}));
    let trashed_then = e.out("entry_history.version", json!({"book": b}))["version"].clone();
    e.call("entry.restore", json!({"book": b, "id": child}));
    e.call(
        "entry.update",
        json!({"book": b, "id": child, "title": "一（新）"}),
    );
    // The folder's switch off: what lived in it goes to Recently Deleted.
    e.call(
        "entry.set_level",
        json!({"book": b, "id": folder, "level": false}),
    );
    e.call(
        "entry_history.restore",
        json!({"book": b, "at": trashed_then, "targets": [{"collection": "entries", "id": child}]}),
    );
    let got = e.out("entry.get", json!({"book": b, "id": child}));
    assert_eq!(got["title"], "一（旧）");
    assert!(got["deleted_at"].is_i64());
    assert_eq!(got["parent"], folder.as_str());
}

fn chapter_in(e: &Env, book: &str, parent: &str, title: &str) -> String {
    e.out(
        "entry.create",
        json!({"book": book, "parent": parent, "template": "tpl-chapter", "title": title}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// DY fix 2: an image field holding a file is one of the file's usages; while
/// the file is in Recently Deleted the field reads as a placeholder; purging
/// the file clears the field so no value points at bytes that are gone.
#[test]
fn image_fields_are_file_usages_placeholders_and_are_cleared_on_purge() {
    let e = env();
    let b = e.book();
    stored_asset(&e, &b, "asset-face", "face.png", b"\x89PNG\r\n\x1a\nface");
    e.call(
        "entry_template.put",
        json!({"book": b, "template": {
            "id": "tpl-portrait", "name": "肖像",
            "modules": [{"id": "mod-fields", "kind": "fields", "name": "资料", "config": {
                "defs": [{"id": "f-face", "name": "头像", "field_type": "image"},
                         {"id": "f-note", "name": "备注", "field_type": "text"}]
            }}]
        }}),
    );
    let who = e.out(
        "entry.create",
        json!({"book": b, "template": "tpl-portrait", "title": "安"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let target = json!({"book": b, "entry": who, "module": "mod-fields"});
    let set = |field: &str, value: Value| {
        let mut input = target.clone();
        input["field"] = json!(field);
        input["value"] = value;
        e.call("module.set_field", input);
    };
    set("f-face", json!("asset-face"));
    set("f-note", json!("备注"));
    let usages = e.out("asset.get", json!({"book": b, "id": "asset-face"}))["usages"].clone();
    assert_eq!(
        usages,
        json!([{"kind": "field", "entry": who, "module": "mod-fields", "field": "f-face"}])
    );
    assert_eq!(
        e.out(
            "asset.get",
            json!({"book": b, "id": "asset-face", "usages": false})
        )["usages"],
        json!([])
    );
    e.call("asset.trash", json!({"book": b, "id": "asset-face"}));
    let got = e.out("entry.get", json!({"book": b, "id": who}));
    assert_eq!(got["missing_files"], json!({"mod-fields": ["f-face"]}));
    assert_eq!(got["fields"]["mod-fields"]["f-face"], "asset-face");
    assert_eq!(
        e.out("module.read", target.clone())["missing_files"],
        json!(["f-face"])
    );
    e.call("asset.restore", json!({"book": b, "id": "asset-face"}));
    assert!(e.out("entry.get", json!({"book": b, "id": who}))["missing_files"].is_null());
    assert_eq!(
        e.out("module.read", target.clone())["missing_files"],
        json!([])
    );
    e.call("asset.trash", json!({"book": b, "id": "asset-face"}));
    e.call("asset.purge", json!({"book": b, "id": "asset-face"}));
    let got = e.out("entry.get", json!({"book": b, "id": who}));
    assert!(got["fields"]["mod-fields"].get("f-face").is_none(), "{got}");
    assert_eq!(got["fields"]["mod-fields"]["f-note"], "备注");
    assert!(got["missing_files"].is_null());
}

// ---- Step 8 of the data layer (`kernel-v5.md` §6, §7, §11) -------------

/// Import `bytes` as `asset` of `book` and record it: the `asset.put` output
/// and where the bytes are.
fn put_bytes(e: &Env, book: &str, asset: &str, name: &str, bytes: &[u8]) -> (Value, Value) {
    use dr_store::asset::SourceImport;
    let src = e.dir.path().join(format!("{asset}.png"));
    std::fs::write(&src, bytes).unwrap();
    let stored = e
        .ws()
        .library()
        .import_asset(&SourceImport {
            book_id: book,
            asset_id: asset,
            source: &src,
            mime: "image/png",
            ext: "png",
            dimensions: Some((2, 2)),
            limit: 1 << 20,
        })
        .unwrap();
    let out = e.out(
        "asset.put",
        json!({
            "book": book, "id": asset, "name": name, "kind": "image",
            "mime": stored.mime, "size": stored.size, "sha256": stored.sha256,
            "width": 2, "height": 2
        }),
    );
    (
        out,
        json!({"path": stored.path, "sha256": stored.sha256, "size": stored.size}),
    )
}

fn new_folder(e: &Env, book: &str, name: &str, parent: Option<&str>) -> String {
    e.out(
        "asset_folder.create",
        json!({"book": book, "name": name, "parent": parent}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// The ids of the live files of `folder` (`None`: the top), in manual order.
fn files_in(e: &Env, book: &str, folder: Option<&str>) -> Vec<String> {
    let mut files: Vec<(String, String)> = e
        .out("asset.list", json!({"book": book}))
        .as_array()
        .unwrap()
        .iter()
        .filter(|a| a["folder"].as_str() == folder)
        .map(|a| {
            (
                a["pos"].as_str().unwrap_or_default().to_owned(),
                a["id"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    files.sort();
    files.into_iter().map(|(_, id)| id).collect()
}

/// The names of the live folders in `parent` (`None`: the top), in manual order.
fn folders_in(e: &Env, book: &str, parent: Option<&str>) -> Vec<String> {
    let mut rows: Vec<(String, String)> = e
        .out("asset_folder.list", json!({"book": book}))
        .as_array()
        .unwrap()
        .iter()
        .filter(|f| f["parent"].as_str() == parent)
        .map(|f| {
            (
                f["pos"].as_str().unwrap().to_owned(),
                f["name"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    rows.sort();
    rows.into_iter().map(|(_, name)| name).collect()
}

/// Step 8: folders of the asset library nest, are renamed, moved and ordered
/// by hand; files go into them in order (`asset.put` with a folder, or
/// `asset.move`); all of it is there after a reopen. A folder never goes
/// under itself (`ASSET-FOLDER-TREE`).
#[test]
fn asset_folders_nest_rename_move_and_keep_their_order_across_reopen() {
    let mut e = env();
    let b = e.book();
    let refs = new_folder(&e, &b, "参考图", None);
    let coast = new_folder(&e, &b, "东岸", Some(&refs));
    let misc = new_folder(&e, &b, "杂项", None);
    e.call(
        "asset_folder.rename",
        json!({"book": b, "id": coast, "name": "东海岸"}),
    );
    for parent in [&coast, &refs] {
        assert!(matches!(
            e.try_call(
                "asset_folder.move",
                json!({"book": b, "id": refs, "parent": parent})
            ),
            Err(WsError::Violation(_))
        ));
    }
    e.call(
        "asset_folder.move",
        json!({"book": b, "id": misc, "parent": null, "index": 0}),
    );
    for (id, bytes) in [
        ("asset-f1", &b"\x89PNG\r\n\x1a\nfolder-one"[..]),
        ("asset-f2", b"\x89PNG\r\n\x1a\nfolder-two"),
        ("asset-f3", b"\x89PNG\r\n\x1a\nfolder-three"),
    ] {
        put_bytes(&e, &b, id, &format!("{id}.png"), bytes);
    }
    e.call(
        "asset.move",
        json!({"book": b, "id": "asset-f1", "folder": coast}),
    );
    e.call(
        "asset.move",
        json!({"book": b, "id": "asset-f2", "folder": coast, "index": 0}),
    );
    assert!(matches!(
        e.try_call(
            "asset.move",
            json!({"book": b, "id": "asset-f3", "folder": "asset-folder-none"})
        ),
        Err(WsError::NotFound { .. })
    ));
    // A file recorded straight into a folder goes last there.
    e.call(
        "asset.put",
        json!({"book": b, "id": "asset-f4", "name": "四.png", "kind": "image",
               "mime": "image/png", "size": 10, "sha256": "d".repeat(64),
               "width": 2, "height": 2, "folder": coast}),
    );
    let check = |e: &Env| {
        assert_eq!(folders_in(e, &b, None), ["杂项", "参考图"]);
        assert_eq!(folders_in(e, &b, Some(&refs)), ["东海岸"]);
        assert_eq!(
            files_in(e, &b, Some(&coast)),
            ["asset-f2", "asset-f1", "asset-f4"]
        );
        assert_eq!(files_in(e, &b, None), ["asset-f3"]);
        assert_eq!(
            e.out(
                "asset.get",
                json!({"book": b, "id": "asset-f1", "usages": false})
            )["folder"],
            coast.as_str()
        );
    };
    check(&e);
    e.reopen();
    check(&e);
}

/// Step 8: a folder goes to Recently Deleted with its files and folders in
/// one step (`ASSET-FOLDER-TRASH`), and the prose using one of its files
/// shows a placeholder; one undo brings all of it back, and so does
/// restoring the folder. A file that was in Recently Deleted already keeps
/// its own time and stays there.
#[test]
fn trashing_a_folder_takes_its_files_and_folders_and_comes_back_both_ways() {
    let e = env();
    let b = e.book();
    let outer = new_folder(&e, &b, "外", None);
    let inner = new_folder(&e, &b, "内", Some(&outer));
    put_bytes(&e, &b, "asset-in", "in.png", b"\x89PNG\r\n\x1a\ninner-file");
    put_bytes(
        &e,
        &b,
        "asset-out",
        "out.png",
        b"\x89PNG\r\n\x1a\nouter-file",
    );
    put_bytes(
        &e,
        &b,
        "asset-old",
        "old.png",
        b"\x89PNG\r\n\x1a\nalready-gone",
    );
    for (id, folder) in [
        ("asset-in", &inner),
        ("asset-out", &outer),
        ("asset-old", &outer),
    ] {
        e.call("asset.move", json!({"book": b, "id": id, "folder": folder}));
    }
    let ch = chapter(&e, &b, "一");
    let doc = format!("body:{ch}/mod-prose");
    e.ws()
        .prose_session(&doc)
        .unwrap()
        .insert_asset_embed(
            0,
            &dr_model::id::EmbedId::parse("emb-in").unwrap(),
            &dr_model::id::AssetId::parse("asset-in").unwrap(),
        )
        .unwrap();
    e.call("asset.trash", json!({"book": b, "id": "asset-old"}));
    let all_back = |e: &Env| {
        assert_eq!(folders_in(e, &b, None), ["外"]);
        assert_eq!(folders_in(e, &b, Some(&outer)), ["内"]);
        assert_eq!(files_in(e, &b, Some(&inner)), ["asset-in"]);
        assert_eq!(files_in(e, &b, Some(&outer)), ["asset-out"]);
        assert!(e.out("prose.shape", json!({"doc": doc}))["missing_embeds"].is_null());
        let old = e.out(
            "asset.get",
            json!({"book": b, "id": "asset-old", "usages": false}),
        );
        assert!(old["deleted_at"].is_i64(), "still in Recently Deleted");
    };
    let all_gone = |e: &Env| {
        assert_eq!(e.out("asset_folder.list", json!({"book": b})), json!([]));
        let trashed = e.out("asset_folder.list", json!({"book": b, "trashed": true}));
        assert_eq!(trashed.as_array().unwrap().len(), 2);
        assert!(
            trashed
                .as_array()
                .unwrap()
                .iter()
                .all(|f| f["deleted_at"].is_i64())
        );
        assert_eq!(e.out("asset.list", json!({"book": b})), json!([]));
        assert_eq!(
            e.out("prose.shape", json!({"doc": doc}))["missing_embeds"],
            json!(["asset-in"])
        );
    };
    all_back(&e);
    e.call("asset_folder.trash", json!({"book": b, "id": outer}));
    all_gone(&e);
    e.ws().undo(&Actor::User).unwrap().unwrap();
    all_back(&e);
    e.call("asset_folder.trash", json!({"book": b, "id": outer}));
    all_gone(&e);
    e.call("asset_folder.restore", json!({"book": b, "id": outer}));
    all_back(&e);
}

/// Step 8: purging a folder from Recently Deleted purges every folder and
/// file in it and deletes the files' bytes; a live folder is not purged.
#[test]
fn purging_a_folder_deletes_the_bytes_of_its_files() {
    use dr_store::asset::Variant;
    let e = env();
    let b = e.book();
    let folder = new_folder(&e, &b, "废稿", None);
    let sub = new_folder(&e, &b, "更旧", Some(&folder));
    let (_, stored) = put_bytes(
        &e,
        &b,
        "asset-purged",
        "p.png",
        b"\x89PNG\r\n\x1a\npurge-me",
    );
    e.call(
        "asset.move",
        json!({"book": b, "id": "asset-purged", "folder": sub}),
    );
    let path = std::path::PathBuf::from(stored["path"].as_str().unwrap());
    assert!(path.exists());
    assert!(matches!(
        e.try_call("asset_folder.purge", json!({"book": b, "id": folder})),
        Err(WsError::Invalid(_))
    ));
    e.call("asset_folder.trash", json!({"book": b, "id": folder}));
    e.call("asset_folder.purge", json!({"book": b, "id": folder}));
    assert_eq!(
        e.out("asset_folder.list", json!({"book": b, "trashed": true})),
        json!([])
    );
    assert_eq!(
        e.out("asset.list", json!({"book": b, "trashed": true})),
        json!([])
    );
    assert!(
        e.ws()
            .library()
            .asset("asset-purged", Variant::Source)
            .unwrap()
            .is_none()
    );
    assert!(!path.exists());
    assert!(
        e.ws().undo_in(&Actor::User, &b, None).unwrap().is_none(),
        "nothing brings an empty file back"
    );
}

/// A folder trashed with its files is one undo step. Purging one of those
/// files from Recently Deleted takes only that file out of the step: Undo
/// still brings the folder and the other file back, and never the purged
/// one.
#[test]
fn purging_one_file_of_a_trashed_folder_leaves_the_rest_of_the_step_undoable() {
    let e = env();
    let b = e.book();
    let folder = new_folder(&e, &b, "一组", None);
    put_bytes(&e, &b, "asset-stay", "留.png", b"\x89PNG\r\n\x1a\nstays");
    put_bytes(&e, &b, "asset-go", "走.png", b"\x89PNG\r\n\x1a\ngoes");
    for id in ["asset-stay", "asset-go"] {
        e.call("asset.move", json!({"book": b, "id": id, "folder": folder}));
    }
    e.call("asset_folder.trash", json!({"book": b, "id": folder}));
    e.call("asset.purge", json!({"book": b, "id": "asset-go"}));
    let undone = e.ws().undo_in(&Actor::User, &b, None).unwrap();
    assert_eq!(
        undone.map(|u| u.entry.command),
        Some("asset_folder.trash".to_owned())
    );
    assert_eq!(folders_in(&e, &b, None), ["一组"]);
    assert_eq!(files_in(&e, &b, Some(&folder)), ["asset-stay"]);
    assert_eq!(
        e.out("asset.list", json!({"book": b, "trashed": true}))
            .as_array()
            .unwrap()
            .len(),
        1,
        "the purged file is not back"
    );
}

/// Step 8: prose can link to a file. The link is one of the file's usages
/// and in the book's index; while the file is in Recently Deleted the link
/// reads as plain text (`missing_links`, `FILE-REFS-LIVE`), and on restore
/// it is a link again.
#[test]
fn a_prose_link_to_a_file_is_a_usage_and_reads_as_text_while_the_file_is_trashed() {
    use dr_model::kind::EntityKind;
    use dr_model::v3::EntityLinkV3;
    let e = env();
    let b = e.book();
    put_bytes(
        &e,
        &b,
        "asset-linked",
        "map.png",
        b"\x89PNG\r\n\x1a\nlinked-map",
    );
    let manuscript = common::acceptance::novel_root(e.ws(), &b, "tpl-manuscript");
    let ch = e.out(
        "entry.create",
        json!({"book": b, "parent": manuscript, "template": "tpl-chapter", "title": "一",
               "bodies": {"mod-prose": "参见地图"}}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let doc = format!("body:{ch}/mod-prose");
    let link = EntityLinkV3 {
        target: "asset-linked".into(),
        kind: EntityKind::Asset,
        module: None,
        block: None,
        end_block: None,
    };
    e.ws()
        .prose_session(&doc)
        .unwrap()
        .edit(move |t| t.link_entity_v3(2..4, &link))
        .unwrap();
    let usages = e.out("asset.get", json!({"book": b, "id": "asset-linked"}))["usages"].clone();
    assert_eq!(
        usages,
        json!([{"kind": "link", "entry": ch, "module": "mod-prose",
                "block": usages[0]["block"]}]),
        "{usages}"
    );
    assert!(usages[0]["block"].is_string(), "the paragraph it is in");
    // `asset.get` brought the index up to date.
    let rows = e
        .ws()
        .library()
        .entry_module_references_in_book(&b)
        .unwrap();
    assert!(rows.iter().any(|r| r.target_kind == "asset"
        && r.target_id == "asset-linked"
        && r.kind == dr_store::index::RefKind::Link
        && r.source_entry == ch));
    let shape = e.out("prose.shape", json!({"doc": doc}));
    assert_eq!(shape["file_links"], json!(["asset-linked"]));
    assert!(shape["missing_links"].is_null());
    e.call("asset.trash", json!({"book": b, "id": "asset-linked"}));
    assert_eq!(
        e.out("prose.shape", json!({"doc": doc}))["missing_links"],
        json!(["asset-linked"])
    );
    e.call("asset.restore", json!({"book": b, "id": "asset-linked"}));
    assert!(e.out("prose.shape", json!({"doc": doc}))["missing_links"].is_null());
}

/// Step 8: the same bytes are one file of the library (`ASSET-BYTES-UNIQUE`).
/// Put again under another id they give back the file already there (the
/// second copy of the bytes is dropped); when that file is in Recently
/// Deleted it is restored, not added again.
#[test]
fn the_same_bytes_put_again_give_back_the_file_already_there() {
    use dr_store::asset::Variant;
    let e = env();
    let b = e.book();
    let bytes = b"\x89PNG\r\n\x1a\nsame-bytes-twice";
    let (first, _) = put_bytes(&e, &b, "asset-first", "a.png", bytes);
    assert_eq!(first["id"], "asset-first");
    let (again, _) = put_bytes(&e, &b, "asset-second", "b.png", bytes);
    assert_eq!(again["id"], "asset-first");
    let listed = e.out("asset.list", json!({"book": b, "trashed": true}));
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["name"], "a.png");
    assert!(
        e.ws()
            .library()
            .asset("asset-second", Variant::Source)
            .unwrap()
            .is_none(),
        "the second copy of the bytes is not kept"
    );
    e.call("asset.trash", json!({"book": b, "id": "asset-first"}));
    let (third, _) = put_bytes(&e, &b, "asset-third", "c.png", bytes);
    assert_eq!(third["id"], "asset-first");
    let listed = e.out("asset.list", json!({"book": b, "trashed": true}));
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert!(listed[0]["deleted_at"].is_null(), "restored");
}

/// The same bytes put again when their file went to Recently Deleted with
/// its folder: the file comes back to the top of the library (its folder
/// cannot hold it), live; the folder stays where it is, and one undo puts
/// the file back with it.
#[test]
fn the_same_bytes_bring_a_file_back_out_of_a_trashed_folder() {
    let e = env();
    let b = e.book();
    let folder = new_folder(&e, &b, "废稿", None);
    let bytes = b"\x89PNG\r\n\x1a\nwent-with-its-folder";
    put_bytes(&e, &b, "asset-kept", "a.png", bytes);
    e.call(
        "asset.move",
        json!({"book": b, "id": "asset-kept", "folder": folder}),
    );
    e.call("asset_folder.trash", json!({"book": b, "id": folder}));
    assert_eq!(e.out("asset.list", json!({"book": b})), json!([]));
    let (again, _) = put_bytes(&e, &b, "asset-again", "b.png", bytes);
    assert_eq!(again["id"], "asset-kept");
    assert_eq!(files_in(&e, &b, None), ["asset-kept"]);
    let all = e.out("asset.list", json!({"book": b, "trashed": true}));
    assert_eq!(all.as_array().unwrap().len(), 1, "no second file");
    assert!(all[0]["deleted_at"].is_null());
    assert_eq!(
        e.out("asset_folder.list", json!({"book": b})),
        json!([]),
        "the folder stays in Recently Deleted"
    );
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert_eq!(e.out("asset.list", json!({"book": b})), json!([]));
    e.call("asset_folder.restore", json!({"book": b, "id": folder}));
    assert_eq!(files_in(&e, &b, Some(&folder)), ["asset-kept"]);
}

/// A file whose record is here while its bytes are not (the record synced
/// before them): the same bytes put on this device are not folded into it,
/// which would delete the only copy this device holds. They are a file of
/// their own.
#[test]
fn the_same_bytes_are_not_folded_into_a_file_whose_bytes_are_not_here() {
    use dr_store::asset::Variant;
    let e = env();
    let b = e.book();
    let bytes = b"\x89PNG\r\n\x1a\nrecord-before-bytes";
    put_bytes(&e, &b, "asset-remote", "a.png", bytes);
    // As when the record came through sync and its bytes have not.
    assert!(
        e.ws()
            .library()
            .remove_book_asset(&b, "asset-remote")
            .unwrap()
    );
    let (out, _) = put_bytes(&e, &b, "asset-local", "b.png", bytes);
    assert_eq!(out["id"], "asset-local");
    assert!(
        e.ws()
            .library()
            .asset("asset-local", Variant::Source)
            .unwrap()
            .is_some(),
        "the bytes this device holds are kept"
    );
    let mut listed: Vec<String> = e
        .out("asset.list", json!({"book": b}))
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["id"].as_str().unwrap().to_owned())
        .collect();
    listed.sort();
    assert_eq!(listed, ["asset-local", "asset-remote"]);
}

/// Step 8: an entry's own arrangement of a media module overrides the
/// template's; cleared, the entry falls back to the template's. The
/// template is never changed; an unknown arrangement is refused.
#[test]
fn an_entrys_own_media_arrangement_overrides_the_templates_and_falls_back() {
    let mut e = env();
    let b = e.book();
    e.call(
        "entry_template.put",
        json!({
            "book": b,
            "template": {
                "id": "tpl-gallery",
                "name": "图册",
                "modules": [{"id": "mod-media", "kind": "media", "name": "图",
                             "config": {"arrangement": "grid"}}]
            }
        }),
    );
    let gallery = e.out(
        "entry.create",
        json!({"book": b, "template": "tpl-gallery", "title": "附图"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let at = json!({"book": b, "entry": gallery, "module": "mod-media"});
    // (the arrangement, whether it is the entry's own; `own_arrangement` is
    // left out when false).
    let read = |e: &Env| {
        let m = e.out("module.read", at.clone());
        (
            m["arrangement"].clone(),
            m["own_arrangement"].as_bool().unwrap_or(false),
        )
    };
    assert_eq!(read(&e), (json!("grid"), false));
    let set = |e: &Env, arrangement: Value| {
        let mut input = at.clone();
        input["arrangement"] = arrangement;
        e.try_call("module.set_arrangement", input)
    };
    set(&e, json!("list")).unwrap();
    assert_eq!(read(&e), (json!("list"), true));
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert_eq!(read(&e), (json!("grid"), false));
    e.ws().redo(&Actor::User).unwrap().unwrap();
    assert!(matches!(
        set(&e, json!("carousel")),
        Err(WsError::Invalid(_))
    ));
    e.reopen();
    assert_eq!(read(&e), (json!("list"), true));
    let templates = e.out("entry_template.list", json!({"book": b}));
    let template = templates
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == "tpl-gallery")
        .unwrap();
    assert_eq!(
        template["modules"][0]["config"]["arrangement"], "grid",
        "{template}"
    );
    set(&e, Value::Null).unwrap();
    assert_eq!(read(&e), (json!("grid"), false));
}

/// Step 8: a file is in one media module at most once (`MEDIA-ASSET-ONCE`):
/// a second item holding it is refused, updating the item itself is not, and
/// another entry's module may hold it too.
#[test]
fn a_file_goes_into_a_media_module_once() {
    let e = env();
    let b = e.book();
    e.call(
        "asset.put",
        json!({"book": b, "id": "asset-once", "name": "一次.png", "kind": "image",
               "mime": "image/png", "size": 10, "sha256": "e".repeat(64),
               "width": 2, "height": 2}),
    );
    e.call(
        "entry_template.put",
        json!({"book": b, "template": {"id": "tpl-gallery", "name": "图册",
               "modules": [{"id": "mod-media", "kind": "media", "name": "图"}]}}),
    );
    let gallery = |title: &str| {
        e.out(
            "entry.create",
            json!({"book": b, "template": "tpl-gallery", "title": title}),
        )["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let (one, two) = (gallery("一"), gallery("二"));
    let put = |entry: &str, item: &str, caption: &str| {
        e.try_call(
            "module.put_media",
            json!({"book": b, "entry": entry, "module": "mod-media",
                   "item": {"id": item, "asset": "asset-once", "caption": caption}}),
        )
    };
    put(&one, "m-1", "第一次").unwrap();
    assert!(matches!(
        put(&one, "m-2", "第二次"),
        Err(WsError::Violation(_))
    ));
    put(&one, "m-1", "改了说明").unwrap();
    put(&two, "m-1", "别的条目").unwrap();
    let media = e.out(
        "module.read",
        json!({"book": b, "entry": one, "module": "mod-media"}),
    )["media"]
        .clone();
    assert_eq!(media.as_array().unwrap().len(), 1);
    assert_eq!(media[0]["caption"], "改了说明");
}

/// Step 8: an embedded image's size, alignment and caption are stored and
/// read back the same after a reopen; a PDF embed is a card and takes none
/// of them, and an unknown size is refused.
#[test]
fn an_embedded_images_size_alignment_and_caption_persist_and_a_pdf_has_none() {
    use dr_doc::prose::{EmbedView, FileEmbedLook};
    use dr_model::id::{AssetId, EmbedId};
    use dr_model::v3::{EmbedAlign, EmbedSize};
    let mut e = env();
    let b = e.book();
    e.call(
        "asset.put",
        json!({"book": b, "id": "asset-look", "name": "钟楼.png", "kind": "image",
               "mime": "image/png", "size": 10, "sha256": "f".repeat(64),
               "width": 4, "height": 3}),
    );
    e.call(
        "asset.put",
        json!({"book": b, "id": "asset-card", "name": "志.pdf", "kind": "pdf",
               "mime": "application/pdf", "size": 10, "sha256": "a".repeat(64)}),
    );
    let ch = chapter(&e, &b, "一");
    let doc = format!("body:{ch}/mod-prose");
    let (img, pdf) = (
        EmbedId::parse("emb-look").unwrap(),
        EmbedId::parse("emb-card").unwrap(),
    );
    let look = FileEmbedLook {
        size: Some(EmbedSize::Small),
        align: Some(EmbedAlign::Right),
        caption: "钟楼的平面".into(),
    };
    {
        let s = e.ws().prose_session(&doc).unwrap();
        s.insert_asset_embed(0, &img, &AssetId::parse("asset-look").unwrap())
            .unwrap();
        s.insert_asset_embed(0, &pdf, &AssetId::parse("asset-card").unwrap())
            .unwrap();
        s.set_file_embed_look(&img, &look).unwrap();
        assert!(matches!(
            s.set_file_embed_look(&pdf, &look),
            Err(WsError::Invalid(_))
        ));
        let huge = FileEmbedLook {
            size: Some(EmbedSize::parse("huge")),
            ..FileEmbedLook::default()
        };
        assert!(matches!(
            s.set_file_embed_look(&img, &huge),
            Err(WsError::Invalid(_))
        ));
    }
    e.reopen();
    let reader = e.ws().prose_session(&doc).unwrap().reader();
    let view = reader.view();
    match view.embed(&img) {
        Some(EmbedView::Asset { look: got, .. }) => assert_eq!(got, look),
        other => panic!("{other:?}"),
    }
    match view.embed(&pdf) {
        Some(EmbedView::Asset { look: got, .. }) => assert!(got.is_empty(), "{got:?}"),
        other => panic!("{other:?}"),
    }
}

/// Step 8 (`FILE-REFS-LIVE`): while a file is in Recently Deleted the
/// relations to it read as not there and the comments straight on it are
/// unlocated; restored, both are back.
#[test]
fn a_trashed_file_hides_its_relations_and_unlocates_its_comments_until_restored() {
    let e = env();
    let b = e.book();
    e.call(
        "asset.put",
        json!({"book": b, "id": "asset-rel", "name": "图.png", "kind": "image",
               "mime": "image/png", "size": 10, "sha256": "9".repeat(64),
               "width": 2, "height": 2}),
    );
    let ch = chapter(&e, &b, "一");
    e.call(
        "relation.create",
        json!({"book": b, "relation_type": format!("system:generic-association:{b}"),
               "from": {"kind": "entry", "id": ch}, "to": {"kind": "asset", "id": "asset-rel"}}),
    );
    let c = e.out(
        "comment.create",
        json!({"book": b, "target": {"kind": "asset", "id": "asset-rel"}, "body": "这块",
               "part": {"kind": "region", "region": {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2}}}),
    )["id"]
        .clone();
    let state = |e: &Env| {
        let rels = e
            .out("relation.list", json!({"book": b}))
            .as_array()
            .unwrap()
            .len();
        let comment = e
            .out("comment.list", json!({"book": b}))
            .as_array()
            .unwrap()
            .iter()
            .find(|x| x["id"] == c)
            .cloned()
            .expect("the comment is kept");
        (rels, comment["unlocated"].clone())
    };
    assert_eq!(state(&e), (1, json!(false)));
    e.call("asset.trash", json!({"book": b, "id": "asset-rel"}));
    assert_eq!(state(&e), (0, json!(true)));
    e.call("asset.restore", json!({"book": b, "id": "asset-rel"}));
    assert_eq!(state(&e), (1, json!(false)));
}

/// Step 8 (`kernel-v5.md` §7): a comment on a whole entry (no module) and one
/// on a whole module (no part, no range) are written and there after a
/// reopen.
#[test]
fn comments_on_a_whole_entry_and_a_whole_module_persist() {
    let mut e = env();
    let b = e.book();
    let ch = chapter(&e, &b, "一");
    let on = json!({"kind": "entry", "id": ch});
    let whole_entry = e.out(
        "comment.create",
        json!({"book": b, "target": on, "body": "整章再理一遍"}),
    )["id"]
        .clone();
    let whole_module = e.out(
        "comment.create",
        json!({"book": b, "target": on, "module": "mod-prose", "body": "正文太散"}),
    )["id"]
        .clone();
    e.reopen();
    let listed = e.out("comment.list", json!({"book": b}));
    let find = |id: &Value| {
        listed
            .as_array()
            .unwrap()
            .iter()
            .find(|c| &c["id"] == id)
            .cloned()
            .unwrap()
    };
    let entry = find(&whole_entry);
    assert_eq!(
        (
            &entry["target"],
            &entry["module"],
            &entry["part"],
            &entry["anchored"]
        ),
        (&on, &Value::Null, &Value::Null, &json!(false))
    );
    assert_eq!(entry["body"], "整章再理一遍");
    let module = find(&whole_module);
    assert_eq!(
        (
            &module["target"],
            &module["module"],
            &module["part"],
            &module["anchored"]
        ),
        (&on, &json!("mod-prose"), &Value::Null, &json!(false))
    );
    assert_eq!(module["unlocated"], false);
}
