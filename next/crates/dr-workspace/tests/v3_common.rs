mod common;
use common::*;
use serde_json::json;

#[test]
fn writing_days_dispatch_by_version_preserve_other_books_and_do_not_enter_undo() {
    let mut e = env();
    let a = e.out("project.create", json!({"name":"Synthetic writing days A"}))["id"]
        .as_str()
        .unwrap()
        .to_string();
    let b = e.out("project.create", json!({"name":"Synthetic writing days B"}))["id"]
        .as_str()
        .unwrap()
        .to_string();
    let legacy = e.book();
    let device = "device-000000000000000000000001";
    let second = "device-000000000000000000000002";
    let before_b = e.ws().observe(&format!("book:{b}")).unwrap();
    let before_a = e.ws().observe(&format!("book:{a}")).unwrap();
    for (book, who, day, words) in [
        (&a, device, "2026-11-10", 12),
        (&a, second, "2026-11-10", 8),
        (&a, device, "2026-11-09", 4),
        (&legacy, device, "2026-11-10", 3),
    ] {
        let out = e.call(
            "writing_day.record",
            json!({"book":book,"device":who,"day":day,"words":words}),
        );
        assert!(out["journal"].is_null());
        assert!(out["undo"].is_null());
    }
    // The book documents are untouched: the writing days live in
    // `stats:<book>`, beside them.
    let after_a = e.ws().observe(&format!("book:{a}")).unwrap();
    assert_eq!(before_a.value, after_a.value);
    assert_eq!(before_a.version, after_a.version);
    let args = json!({"book":a,"device":device,"day":"2026-11-10","words":12});
    e.call("writing_day.record", args);
    assert_eq!(
        after_a.version,
        e.ws().observe(&format!("book:{a}")).unwrap().version
    );
    for (day, words) in [("2026-02-30", 1), ("2026-11-10", -1), ("2026-1日0", 1)] {
        assert!(
            e.try_call(
                "writing_day.record",
                json!({"book":a,"device":device,"day":day,"words":words})
            )
            .is_err()
        );
    }
    assert_eq!(
        after_a.version,
        e.ws().observe(&format!("book:{a}")).unwrap().version
    );
    let got = e.out(
        "book.writing_days",
        json!({"book":a,"today":"2026-11-10","device":device,"days":2}),
    );
    assert_eq!(got["today"], 20);
    assert_eq!(got["mine_today"], 12);
    assert_eq!(got["week"], 24);
    assert_eq!(got["streak"], 2);
    assert_eq!(got["daily_word_target"], 1500);
    assert_eq!(
        e.out(
            "book.writing_days",
            json!({"book":legacy,"today":"2026-11-10"})
        )["today"],
        3
    );
    assert_eq!(
        before_b.value,
        e.ws().observe(&format!("book:{b}")).unwrap().value
    );
    assert_eq!(
        before_b.version,
        e.ws().observe(&format!("book:{b}")).unwrap().version
    );
    // The compatibility allowance is exact, not a blanket book.* whitelist.
    assert!(
        e.try_call("book.search", json!({"book":a,"query":"Synthetic"}))
            .is_err()
    );
    assert!(e.try_call("book.word_counts", json!({"book":a})).is_err());
    e.reopen();
    assert_eq!(
        got,
        e.out(
            "book.writing_days",
            json!({"book":a,"today":"2026-11-10","device":device,"days":2})
        )
    );
}

fn project(e: &Env) -> String {
    e.out(
        "project.create",
        json!({"name":"Synthetic shared interfaces"}),
    )["id"]
        .as_str()
        .unwrap()
        .into()
}
fn item(v: serde_json::Value) -> String {
    v["id"].as_str().unwrap().into()
}
fn raw(e: &Env, b: &str) -> serde_json::Value {
    e.ws().observe(&format!("book:{b}")).unwrap().value
}
fn undo(e: &Env) {
    e.ws()
        .undo(&dr_workspace::Actor::User)
        .unwrap()
        .expect("undoable");
}

#[test]
fn v3_entry_trash_hides_relations_and_unlocates_comments_and_undo_restores_after_reopen() {
    use dr_model::id::{BookId, CommentId};
    use dr_model::kind::EntityKind;
    use dr_model::shared::EntityRef;
    let mut e = env();
    let b = project(&e);
    let other = project(&e);
    let untouched = raw(&e, &other);
    let entries = e.out("entry.list", json!({"book":b,"all":true}));
    let parent = entries
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["template"] == "tpl-manuscript")
        .unwrap()["id"]
        .clone();
    e.call("entry_template.put_module", json!({"book":b,"template":"tpl-chapter","module":{"id":"test-relations","kind":"relations","name":"Synthetic relations"}}));
    let entry = item(e.out(
        "entry.create",
        json!({"book":b,"parent":parent,"title":"Synthetic entry","template":"tpl-chapter"}),
    ));
    let note = item(e.out(
        "entry.create",
        json!({
            "book": b,
            "title": "Synthetic note",
            "template": "tpl-note",
            "bodies": {"mod-prose": "Preserve my note"}
        }),
    ));
    e.call("entry_relation_type.put", json!({"book":b,"definition":{"id":"test-rel","name":"Synthetic relation","source_kinds":["entry"],"target_kinds":["entry"]}}));
    let _relation = item(e.out("module.put_relation", json!({"book":b,"entry":entry,"module":"test-relations","other":{"kind":"entry","id":note},"relation_type":"test-rel"})));
    let (book, note_id) = (BookId::parse(&b).unwrap(), note.clone());
    let h = e
        .ws()
        .library()
        .open_doc(&format!("book:{b}"), dr_store::OpenDoc::Existing)
        .unwrap();
    h.write(dr_store::Origin::Import, move |doc| {
        let bb = dr_doc::v3::BorrowedBookV3::new(doc, &book).unwrap();
        bb.txn()
            .comment(&CommentId::parse("synthetic-comment").unwrap())
            .unwrap()
            .target(Some(&EntityRef::new(EntityKind::Entry, note_id)))
            .unwrap()
            .body("Preserve this comment")
            .unwrap()
            .quote(Some("quoted passage"))
            .unwrap();
    })
    .unwrap();
    drop(h);
    let prose_doc = format!("body:{note}/mod-prose");
    let prose = e.ws().observe(&prose_doc).unwrap();
    let before_entries = e.out("entry.list", json!({"book":b,"all":true}));
    e.call("entry.trash", json!({"book":b,"id":note}));
    let copy = e.ws().library().load_copy(&format!("book:{b}")).unwrap();
    let book_id = BookId::parse(&b).unwrap();
    let book = dr_doc::v3::BorrowedBookV3::new(&copy, &book_id).unwrap();
    assert!(book.view().relations().is_empty());
    assert_eq!(book.view().relations_raw().len(), 1);
    let comment_info = &e.out("comment.list", json!({"book": b}))[0];
    assert_eq!(comment_info["unlocated"], true);
    assert_eq!(comment_info["body"], "Preserve this comment");
    assert_eq!(comment_info["quote"], "quoted passage");
    assert_eq!(e.ws().observe(&prose_doc).unwrap().value, prose.value);
    e.reopen();
    undo(&e);
    assert_eq!(
        e.out("entry.list", json!({"book":b,"all":true})),
        before_entries
    );
    assert_eq!(
        e.out("comment.list", json!({"book": b}))[0]["unlocated"],
        false
    );
    e.call(
        "entry.update",
        json!({"book":b,"id":note,"title":"Editable after restore"}),
    );
    assert_eq!(
        e.out("entry.get", json!({"book":b,"id":note}))["title"],
        "Editable after restore"
    );
    undo(&e);
    e.ws()
        .redo(&dr_workspace::Actor::User)
        .unwrap()
        .expect("redoable");
    assert_eq!(raw(&e, &other), untouched);
}

#[test]
fn v3_material_level_entries_restore_order_ancestry_and_only_selected_records() {
    let mut e = env();
    let b = project(&e);
    let materials_root = item(e.out(
        "entry.create",
        json!({"book":b,"template":"tpl-group","level":true,"title":"文本素材"}),
    ));
    let a = item(e.out(
        "entry.create",
        json!({"book":b,"parent":materials_root,"template":"tpl-group","level":true,"title":"A"}),
    ));
    let f = item(e.out(
        "entry.create",
        json!({"book":b,"parent":a,"template":"tpl-group","level":true,"title":"Folder"}),
    ));
    let child = item(e.out(
        "entry.create",
        json!({"book":b,"parent":f,"template":"tpl-group","level":true,"title":"Child"}),
    ));
    let note = item(e.out(
        "entry.create",
        json!({"book":b,"parent":f,"template":"tpl-note","title":"Note","bodies":{"mod-prose":"Synthetic"}}),
    ));
    assert!(
        e.try_call("entry.move", json!({"book":b,"id":a,"parent":child}))
            .is_err()
    );
    let snapshot = e.out("entry_history.version", json!({"book":b}))["version"].clone();
    let before = e.out("entry.list", json!({"book":b,"all":true}));
    e.call(
        "entry.move",
        json!({"book":b,"id":child,"parent":materials_root}),
    );
    e.call("entry.move", json!({"book":b,"id":a,"parent":child}));
    e.call(
        "entry_history.restore",
        json!({
            "book": b,
            "at": snapshot,
            "targets": [
                {"collection": "entries", "id": a},
                {"collection": "entries", "id": child}
            ]
        }),
    );
    assert_eq!(e.out("entry.list", json!({"book":b,"all":true})), before);

    let fresh = item(e.out(
        "entry.create",
        json!({"book":b,"parent":materials_root,"template":"tpl-group","level":true,"title":"New"}),
    ));
    e.call("entry.move", json!({"book":b,"id":note,"parent":fresh}));
    let state = raw(&e, &b);
    assert!(
        e.try_call(
            "entry_history.restore",
            json!({"book":b,"at":snapshot,"targets":[{"collection":"entries","id":fresh}]})
        )
        .is_err()
    );
    assert_eq!(raw(&e, &b), state);
    e.reopen();
    undo(&e);
    assert_eq!(e.out("entry.get", json!({"book":b,"id":note}))["parent"], f);
}

fn prose_entry(e: &Env, b: &str) -> String {
    let entries = e.out("entry.list", json!({"book":b,"all":true}));
    let parent = entries
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["template"] == "tpl-manuscript")
        .unwrap()["id"]
        .clone();
    e.call("entry_template.put_module", json!({"book":b,"template":"tpl-chapter","module":{"id":"second-prose","kind":"prose","name":"Second prose"}}));
    let entry = item(e.out(
        "entry.create",
        json!({"book":b,"parent":parent,"title":"Synthetic prose","template":"tpl-chapter"}),
    ));
    for module in ["mod-prose", "second-prose"] {
        e.call("module.set_prose", json!({"book":b,"owner":entry,"module":module,"paragraphs":[{"text":"Synthetic passage"}]}));
    }
    entry
}

#[test]
fn v3_comments_address_modules_validate_anchors_and_restore_after_reopen() {
    use dr_workspace::Actor;
    use dr_workspace::commands::{comment as legacy, v3::comment as v3};
    let mut e = env();
    let b = project(&e);
    let other = project(&e);
    let untouched = raw(&e, &other);
    let entry = prose_entry(&e, &b);
    let target = json!({"kind":"entry","id":entry});
    let typed_create: v3::CommentCreateIn = serde_json::from_value(
        json!({"book":b,"target":target,"module":"mod-prose","body":"First","range":[0,9]}),
    )
    .unwrap();
    let a = e
        .ws()
        .run::<v3::CommentCreate>(&Actor::User, typed_create)
        .unwrap()
        .output
        .id;
    let z = item(e.out(
        "comment.create",
        json!({"book":b,"target":target,"module":"second-prose","body":"Second","range":[0,9]}),
    ));
    let args = |module: &str| json!({"book":b,"target":target,"module":module});
    let list = e.out("comment.list", args("mod-prose"));
    assert_eq!(ids(&list), std::slice::from_ref(&a));
    assert_eq!(list[0]["module"], "mod-prose");
    assert_eq!(list[0]["quote"], "Synthetic");
    let anchors = e.out("comment.anchors", args("mod-prose"));
    assert_eq!(ids(&anchors), std::slice::from_ref(&a));
    let other_anchor = e.out("comment.anchors", args("second-prose"))[0]["anchor"].clone();
    let before = raw(&e, &b);
    assert!(
        e.try_call(
            "comment.reanchor",
            json!({"book":b,"id":a,"anchor":other_anchor})
        )
        .is_err()
    );
    for invalid in [
        json!({"book":b,"target":target,"range":[0,4]}),
        json!({"book":other,"target":target,"module":"mod-prose","range":[0,4]}),
        json!({"book":b,"target":target,"module":"missing-module","range":[0,4]}),
        json!({"book":b,"target":{"kind":"node","id":entry}}),
        json!({"book":b,"module":"mod-prose"}),
        json!({"book":b,"target":target,"module":"mod-prose","block_id":"missing-block"}),
    ] {
        assert!(e.try_call("comment.create", invalid).is_err());
    }
    assert_eq!(raw(&e, &b), before);
    let typed: v3::CommentListIn = serde_json::from_value(args("mod-prose")).unwrap();
    assert_eq!(
        e.ws()
            .run::<v3::CommentList>(&Actor::User, typed)
            .unwrap()
            .output[0]
            .module
            .as_deref(),
        Some("mod-prose")
    );
    assert_eq!(
        <legacy::CommentCreate as dr_workspace::Op>::BOOK_VERSION,
        Some(dr_doc::schema::BOOK_SCHEMA_VERSION)
    );
    let reanchor: legacy::CommentReanchorIn =
        serde_json::from_value(json!({"book":b,"id":a,"anchor":null})).unwrap();
    e.ws()
        .run::<legacy::CommentReanchor>(&Actor::User, reanchor)
        .unwrap();
    assert_eq!(e.out("comment.anchors", args("mod-prose")), json!([]));
    e.call(
        "comment.reanchor",
        json!({"book":b,"id":a,"anchor":anchors[0]["anchor"]}),
    );
    e.call(
        "comment.update",
        json!({"book":b,"id":a,"body":"Edited first","status":"resolved"}),
    );
    assert_eq!(
        e.out("comment.list", args("second-prose"))[0]["body"],
        "Second"
    );
    undo(&e);
    assert_eq!(e.out("comment.list", args("mod-prose"))[0]["body"], "First");
    e.call("entry_template.put_module",json!({"book":b,"template":"tpl-chapter","module":{"id":"test-relations","kind":"relations","name":"Synthetic relations"}}));
    e.call("entry_relation_type.put",json!({"book":b,"definition":{"id":"comment-relation","name":"Synthetic comment relation","source_kinds":["comment"],"target_kinds":["entry"]}}));
    let relation=item(e.out("module.put_relation",json!({"book":b,"entry":entry,"module":"test-relations","other":{"kind":"comment","id":a},"incoming":true,"relation_type":"comment-relation"})));
    e.call("entry.trash", json!({"book":b,"id":entry}));
    let before_relations = raw(&e, &b)["relations"].clone();
    let before_delete = raw(&e, &b)["comments"].clone();
    e.call("comment.delete", json!({"book":b,"id":a}));
    assert!(raw(&e, &b)["relations"][&relation].is_null());
    e.reopen();
    undo(&e);
    assert_eq!(raw(&e, &b)["comments"], before_delete);
    assert_eq!(raw(&e, &b)["relations"], before_relations);
    e.call("entry.restore", json!({"book":b,"id":entry}));
    e.call(
        "comment.update",
        json!({"book":b,"id":a,"body":"Writable after restore"}),
    );
    assert_eq!(
        e.out("comment.list", args("mod-prose"))[0]["body"],
        "Writable after restore"
    );
    e.call("entry.trash", json!({"book":b,"id":entry}));
    assert!(
        e.out("comment.list", args("second-prose"))[0]["unlocated"]
            .as_bool()
            .unwrap()
    );
    e.call("entry.restore", json!({"book":b,"id":entry}));
    assert_eq!(
        ids(&e.out("comment.list", args("second-prose"))),
        std::slice::from_ref(&z)
    );
    e.call(
        "entry_template.remove_module",
        json!({"book":b,"template":"tpl-chapter","module":"second-prose"}),
    );
    assert_eq!(ids(&e.out("comment.anchors", args("second-prose"))), [z]);
    let root = e
        .out("entry.list", json!({"book":b,"all":true}))
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["template"] == "tpl-manuscript")
        .unwrap()["id"]
        .clone();
    e.call("module.set_prose",json!({"book":b,"owner":root,"module":"mod-description","paragraphs":[{"text":"Synthetic description"}]}));
    e.call("comment.create",json!({"book":b,"target":{"kind":"entry","id":root},"module":"mod-description","range":[0,9],"body":"Level comment"}));
    assert_eq!(
        e.out(
            "comment.list",
            json!({"book":b,"target":{"kind":"entry","id":root},"module":"mod-description"})
        )[0]["quote"],
        "Synthetic"
    );
    assert_eq!(raw(&e, &other), untouched);
    let old_book = common::acceptance::empty_source(e.ws().library());
    let before = e.ws().library().head(&format!("book:{old_book}")).unwrap();
    assert!(
        e.try_call(
            "comment.create",
            json!({"book":old_book,"body":"Refused old source"})
        )
        .is_err()
    );
    assert!(
        e.try_call("comment.list", json!({"book":old_book}))
            .is_err()
    );
    assert_eq!(
        e.ws().library().head(&format!("book:{old_book}")).unwrap(),
        before
    );
}

#[test]
fn v3_entry_comments_and_typed_todo_projection_keep_document_scope() {
    use dr_workspace::{
        Actor,
        commands::comment::{CommentProject, CommentProjectIn},
    };
    let e = env();
    let b = project(&e);
    let entry = prose_entry(&e, &b);
    let note = item(e.out(
        "entry.create",
        json!({
            "book": b,
            "template": "tpl-note",
            "title": "Synthetic note",
            "bodies": {"mod-prose": "Synthetic material"}
        }),
    ));
    let note_doc = format!("body:{note}/mod-prose");
    // Refuse a stale imported owner pointing at another book's global document ID.
    let foreign = project(&e);
    let foreign_id = dr_model::id::BookId::parse(&foreign).unwrap();
    let note_id = dr_model::id::EntryId::parse(&note).unwrap();
    let note_tpl = dr_model::id::EntryTemplateId::parse("tpl-note").unwrap();
    let h = e
        .ws()
        .library()
        .open_doc(&format!("book:{foreign}"), dr_store::OpenDoc::Existing)
        .unwrap();
    h.write(dr_store::Origin::Import, move |d| {
        let bb = dr_doc::v3::BorrowedBookV3::new(d, &foreign_id).unwrap();
        bb.txn()
            .entries()
            .create(
                &note_id,
                None,
                "Stale imported owner",
                Some(&note_tpl),
                false,
            )
            .unwrap();
    })
    .unwrap();
    drop(h);
    let foreign_before = raw(&e, &foreign);
    let foreign_version = e.ws().observe(&format!("book:{foreign}")).unwrap().version;
    assert!(
        e.try_call(
            "comment.create",
            json!({"book":foreign,"target":{"kind":"entry","id":note},"module":"mod-prose","range":[0,9]})
        )
        .is_err()
    );
    assert_eq!(raw(&e, &foreign), foreign_before);
    assert_eq!(
        e.ws().observe(&format!("book:{foreign}")).unwrap().version,
        foreign_version
    );
    // Retired material targets and material:<id> prose docs are refused.
    assert!(
        e.try_call(
            "comment.create",
            json!({"book":b,"target":{"kind":"material","id":note},"body":"Retired"})
        )
        .is_err()
    );
    assert!(
        e.try_call(
            "comment.project",
            json!({"doc": format!("material:{note}"), "markers": []})
        )
        .is_err()
    );
    let c = item(e.out(
        "comment.create",
        json!({
            "book": b,
            "target": {"kind": "entry", "id": note},
            "module": "mod-prose",
            "body": "Note comment",
            "range": [0, 9]
        }),
    ));
    assert_eq!(
        e.out(
            "comment.list",
            json!({"book":b,"target":{"kind":"entry","id":note},"module":"mod-prose"})
        )[0]["module"],
        json!("mod-prose")
    );
    let mut projections = Vec::new();
    for doc in [
        format!("body:{entry}/mod-prose"),
        format!("body:{entry}/second-prose"),
        note_doc.clone(),
    ] {
        let session = e.ws().prose_session(&doc).unwrap();
        let block = session
            .reader()
            .view()
            .paragraphs()
            .next()
            .unwrap()
            .id
            .unwrap()
            .to_string();
        drop(session);
        let args = json!({"doc":doc,"markers":[{"block":block,"task":"Synthetic task"}]});
        let mut editing_args = args.clone();
        editing_args["editing"] = block.clone().into();
        let deferred = e.call("comment.project", editing_args.clone());
        assert!(deferred["output"]["created"].as_array().unwrap().is_empty());
        assert!(deferred["journal"].is_null());
        let input: CommentProjectIn = serde_json::from_value(args.clone()).unwrap();
        let got = e.ws().run::<CommentProject>(&Actor::User, input).unwrap();
        assert_eq!(got.output.created.len(), 1);
        let id = got.output.created[0].clone();
        editing_args["markers"][0]["task"] = "Still typing".into();
        let kept = e.call("comment.project", editing_args);
        assert!(kept["output"]["removed"].as_array().unwrap().is_empty());
        assert!(kept["journal"].is_null());
        let listed = e.out("comment.list", json!({"book":b}));
        let projected = listed
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == id)
            .unwrap();
        assert_eq!(projected["body"], "Synthetic task");
        assert_eq!(projected["origin"], "marker");
        let again = e.call("comment.project", args.clone());
        assert!(again["output"]["created"].as_array().unwrap().is_empty());
        assert!(again["journal"].is_null());
        projections.push((doc, args, id));
    }
    let ids: std::collections::BTreeSet<_> = projections.iter().map(|p| &p.2).collect();
    assert_eq!(ids.len(), 3);
    let (_, ref args, ref keep) = projections[1];
    e.call(
        "comment.update",
        json!({"book":b,"id":keep,"body":"Author edited task","status":"resolved"}),
    );
    e.call("comment.project", args.clone());
    assert_eq!(raw(&e, &b)["comments"][keep]["body"], "Author edited task");
    let (doc, _, remove) = &projections[0];
    let set_meta = |metadata: &str| {
        let book = dr_model::id::BookId::parse(&b).unwrap();
        let id = dr_model::id::CommentId::parse(remove).unwrap();
        let metadata = metadata.to_owned();
        let h = e
            .ws()
            .library()
            .open_doc(&format!("book:{b}"), dr_store::OpenDoc::Existing)
            .unwrap();
        h.write(dr_store::Origin::Import, move |d| {
            let bb = dr_doc::v3::BorrowedBookV3::new(d, &book).unwrap();
            bb.txn()
                .comment(&id)
                .unwrap()
                .metadata(Some(&metadata))
                .unwrap();
        })
        .unwrap();
    };
    set_meta(r#"{"kind":"todo-autoparse","prose_vv":{"999":999}}"#);
    let waiting = e.out("comment.project", json!({"doc":doc,"markers":[]}));
    assert_eq!(waiting["waiting"], json!([remove]));
    assert!(!raw(&e, &b)["comments"][remove].is_null());
    set_meta(r#"{"kind":"todo-autoparse","prose_vv":{}}"#);
    e.call("comment.project", json!({"doc":doc,"markers":[]}));
    let state = raw(&e, &b);
    assert!(state["comments"][remove].is_null());
    assert!(!state["comments"][keep].is_null());
    assert!(!state["comments"][&projections[2].2].is_null());
    e.call("entry.trash", json!({"book":b,"id":note}));
    let find_c = || {
        e.out("comment.list", json!({"book": b}))
            .as_array()
            .unwrap()
            .iter()
            .find(|cm| cm["id"] == c)
            .unwrap()
            .clone()
    };
    assert_eq!(find_c()["unlocated"], true);
    undo(&e);
    assert_eq!(find_c()["unlocated"], false);
}

#[test]
fn observations_ignore_unwritten_getter_roots_and_keep_unknown_authored_values() {
    let mut e = env();
    let b = e.book();
    let id = format!("book:{b}");
    let h = e
        .ws()
        .library()
        .open_doc(&id, dr_store::OpenDoc::Existing)
        .unwrap();
    h.write(dr_store::Origin::Import, |doc| {
        let m = doc.get_map("future-author-data");
        m.insert("unknown", "raw-future-value").unwrap();
    })
    .unwrap();
    let before = e.ws().observe(&id).unwrap();
    h.read(|doc| {
        doc.get_map("never-authored-getter").get_deep_value();
    })
    .unwrap();
    assert_eq!(e.ws().observe(&id).unwrap().value, before.value);
    drop(h);
    e.reopen();
    let after = e.ws().observe(&id).unwrap();
    assert_eq!(after.version, before.version);
    assert_eq!(after.value, before.value);
}

#[test]
fn entry_template_field_default_values_validate_and_initialize_new_entries() {
    let mut e = env();
    let b = project(&e);
    let before = e.ws().observe(&format!("book:{b}")).unwrap();

    // Mismatched default_value type or invalid select option is rejected prewrite.
    for bad_def in [
        json!({"id":"f1","name":"年龄","field_type":"number","default_value":"not-a-number"}),
        json!({"id":"f2","name":"状态","field_type":"select","options":["甲","乙"],"default_value":"丙"}),
    ] {
        assert!(
            e.try_call(
                "entry_template.put",
                json!({
                    "book": b,
                    "template": {
                        "id": "tpl-custom-char",
                        "name": "人物",
                        "modules": [{
                            "id": "mod-fields",
                            "kind": "fields",
                            "name": "字段",
                            "pos": "a0",
                            "config": { "defs": [bad_def] }
                        }]
                    }
                }),
            )
            .is_err()
        );
    }
    assert_eq!(
        e.ws().observe(&format!("book:{b}")).unwrap().version,
        before.version
    );

    e.call(
        "entry_template.put",
        json!({
            "book": b,
            "template": {
                "id": "tpl-custom-char",
                "name": "人物",
                "modules": [{
                    "id": "mod-fields",
                    "kind": "fields",
                    "name": "字段",
                    "pos": "a0",
                    "config": {
                        "defs": [
                            {"id":"origin","name":"出身","field_type":"text","pos":"a0","default_value":"未庄"},
                            {"id":"age","name":"年龄","field_type":"number","pos":"a1","default_value":25.0},
                            {"id":"role","name":"身份","field_type":"select","options":["短工","掌柜"],"pos":"a2","default_value":"短工"},
                            {"id":"aliases","name":"别名","field_type":"aliases","pos":"a3","default_value":["阿贵"]},
                            {"id":"notes","name":"备注","field_type":"text","pos":"a4"}
                        ]
                    }
                }]
            }
        }),
    );

    // Make tpl-custom-char the default under the Elements root.
    let elements_root = e
        .out("entry.list", json!({"book": b}))
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["template"] == "tpl-elements")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    e.call(
        "entry.update",
        json!({
            "book": b,
            "id": elements_root,
            "overrides": {
                "default_template": "tpl-custom-char"
            }
        }),
    );

    let created = item(e.out(
        "entry.create",
        json!({
            "book": b,
            "parent": elements_root,
            "template": "tpl-custom-char",
            "title": "阿Q"
        }),
    ));
    e.reopen();
    let got = e.out("entry.get", json!({"book": b, "id": created}));
    assert_eq!(got["fields"]["mod-fields"]["origin"], "未庄");
    assert_eq!(got["fields"]["mod-fields"]["age"], 25.0);
    assert_eq!(got["fields"]["mod-fields"]["role"], "短工");
    assert_eq!(got["fields"]["mod-fields"]["aliases"], json!(["阿贵"]));
    assert!(got["fields"]["mod-fields"]["notes"].is_null());
}

#[test]
fn comment_parts_validate_against_modules_and_degrade_to_unlocated() {
    use dr_doc::prose::EmbedKind;
    use dr_model::id::{AssetId, EmbedId};

    let mut e = env();
    let b = project(&e);
    let root = e
        .out("entry.list", json!({"book": b, "all": true}))
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["template"] == "tpl-manuscript")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();

    e.call(
        "entry_template.put",
        json!({
            "book": b,
            "template": {
                "id": "tpl-parts",
                "name": "Parts",
                "modules": [
                    {"id": "mod-prose", "kind": "prose", "name": "正文", "pos": "a0"},
                    {
                        "id": "mod-fields",
                        "kind": "fields",
                        "name": "字段",
                        "pos": "a1",
                        "config": {
                            "defs": [
                                {"id": "origin", "name": "出身", "field_type": "text", "pos": "a0"},
                                {"id": "age", "name": "年龄", "field_type": "number", "pos": "a1"}
                            ]
                        }
                    },
                    {"id": "mod-kv", "kind": "kv", "name": "键值", "pos": "a2"},
                    {
                        "id": "mod-plot",
                        "kind": "plot_grid",
                        "name": "情节",
                        "pos": "a3",
                        "config": {"default_rows": 2, "default_cols": 2}
                    },
                    {"id": "mod-patches", "kind": "patches", "name": "补丁", "pos": "a4"},
                    {"id": "mod-media", "kind": "media", "name": "媒体", "pos": "a5"}
                ]
            }
        }),
    );

    let entry = item(e.out(
        "entry.create",
        json!({
            "book": b,
            "parent": root,
            "template": "tpl-parts",
            "title": "Parts target",
            "bodies": {"mod-prose": "Opening paragraph"}
        }),
    ));
    let target = json!({"kind": "entry", "id": entry});

    e.call(
        "module.put_kv",
        json!({
            "book": b,
            "entry": entry,
            "module": "mod-kv",
            "row": {"id": "row-1", "key": "线索", "value": "钟表"}
        }),
    );
    let patch = item(e.out(
        "module.put_patch",
        json!({
            "book": b,
            "entry": entry,
            "module": "mod-patches",
            "title": "草稿",
            "body": "补一段雨声"
        }),
    ));

    let entry_id = dr_model::id::EntryId::parse(&entry).unwrap();
    let plot_mod = dr_model::id::ModuleId::parse("mod-plot").unwrap();
    let default_row = dr_model::v3::PlotGridV3::default_row_id(&entry_id, &plot_mod, 1).to_string();
    let default_col = dr_model::v3::PlotGridV3::default_col_id(&entry_id, &plot_mod, 2).to_string();

    let sha = "c".repeat(64);
    e.call(
        "asset.put",
        json!({
            "book": b,
            "id": "asset-map",
            "name": "map.png",
            "kind": "image",
            "mime": "image/png",
            "size": 16,
            "sha256": sha,
            "width": 100,
            "height": 80
        }),
    );
    e.call(
        "module.put_media",
        json!({
            "book": b,
            "entry": entry,
            "module": "mod-media",
            "item": {"id": "media-map-1", "asset": "asset-map", "caption": "Map"}
        }),
    );
    let doc_id = format!("body:{entry}/mod-prose");
    let file_embed = EmbedId::parse("emb-map-1").unwrap();
    let table_embed = EmbedId::parse("emb-tbl-1").unwrap();
    {
        let s = e.ws().prose_session(&doc_id).unwrap();
        let asset_id = AssetId::parse("asset-map").unwrap();
        s.insert_asset_embed(0, &file_embed, &asset_id).unwrap();
        s.edit(move |t| {
            t.insert_embed(0, &table_embed, &EmbedKind::Table)?;
            Ok(())
        })
        .unwrap();
    }

    // Whole non-prose module comment (`part = None`) is valid.
    let c_whole = item(e.out(
        "comment.create",
        json!({
            "book": b,
            "target": target,
            "module": "mod-fields",
            "origin": "reader",
            "body": "Check all fields"
        }),
    ));
    let c_field = item(e.out(
        "comment.create",
        json!({
            "book": b,
            "target": target,
            "module": "mod-fields",
            "part": {"kind": "field", "field": "origin"},
            "body": "Verify hometown"
        }),
    ));
    let c_kv = item(e.out(
        "comment.create",
        json!({
            "book": b,
            "target": target,
            "module": "mod-kv",
            "part": {"kind": "kv_row", "row": "row-1"},
            "body": "Verify clue"
        }),
    ));
    let c_plot = item(e.out(
        "comment.create",
        json!({
            "book": b,
            "target": target,
            "module": "mod-plot",
            "part": {"kind": "plot_cell", "row": default_row, "col": default_col},
            "body": "Verify beat cell"
        }),
    ));
    let c_patch = item(e.out(
        "comment.create",
        json!({
            "book": b,
            "target": target,
            "module": "mod-patches",
            "part": {"kind": "patch", "patch": patch},
            "body": "Verify patch"
        }),
    ));
    let c_embed = item(e.out(
        "comment.create",
        json!({
            "book": b,
            "target": target,
            "module": "mod-prose",
            "part": {
                "kind": "embed",
                "embed": "emb-map-1",
                "region": {"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4}
            },
            "body": "Verify map corner"
        }),
    ));
    let c_media = item(e.out(
        "comment.create",
        json!({
            "book": b,
            "target": target,
            "module": "mod-media",
            "part": {
                "kind": "media",
                "item": "media-map-1",
                "region": {"page": 1, "x": 0.2, "y": 0.3, "w": 0.4, "h": 0.5}
            },
            "body": "Verify media item region"
        }),
    ));

    // Rejections (`COMMENT-PART-IN-MODULE`).
    for bad in [
        // Wrong module kind for part.
        json!({"book": b, "target": target, "module": "mod-prose", "part": {"kind": "field", "field": "origin"}, "body": "bad"}),
        json!({"book": b, "target": target, "module": "mod-fields", "part": {"kind": "kv_row", "row": "row-1"}, "body": "bad"}),
        json!({"book": b, "target": target, "module": "mod-prose", "part": {"kind": "media", "item": "media-map-1"}, "body": "bad"}),
        json!({"book": b, "target": target, "module": "mod-fields", "range": [0, 1], "body": "bad"}),
        // Missing sub-items inside matching module.
        json!({"book": b, "target": target, "module": "mod-fields", "part": {"kind": "field", "field": "missing"}, "body": "bad"}),
        json!({"book": b, "target": target, "module": "mod-kv", "part": {"kind": "kv_row", "row": "missing"}, "body": "bad"}),
        json!({"book": b, "target": target, "module": "mod-plot", "part": {"kind": "plot_cell", "row": default_row, "col": "missing"}, "body": "bad"}),
        json!({"book": b, "target": target, "module": "mod-patches", "part": {"kind": "patch", "patch": "missing"}, "body": "bad"}),
        json!({"book": b, "target": target, "module": "mod-prose", "part": {"kind": "embed", "embed": "missing"}, "body": "bad"}),
        json!({"book": b, "target": target, "module": "mod-media", "part": {"kind": "media", "item": "missing"}, "body": "bad"}),
        // Table embed is not a file embed.
        json!({"book": b, "target": target, "module": "mod-prose", "part": {"kind": "embed", "embed": "emb-tbl-1"}, "body": "bad"}),
        // Combining part with prose range, omitting module, or floating with part.
        json!({"book": b, "target": target, "module": "mod-prose", "part": {"kind": "embed", "embed": "emb-map-1"}, "range": [0, 1], "body": "bad"}),
        json!({"book": b, "target": target, "part": {"kind": "field", "field": "origin"}, "body": "bad"}),
        json!({"book": b, "part": {"kind": "field", "field": "origin"}, "body": "bad"}),
    ] {
        assert!(
            e.try_call("comment.create", bad.clone()).is_err(),
            "accepted {bad}"
        );
    }

    let find = |e: &Env, id: &str| -> serde_json::Value {
        e.out("comment.list", json!({"book": b}))
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == id)
            .unwrap()
            .clone()
    };
    assert_eq!(find(&e, &c_whole)["origin"], "reader");
    for id in [
        &c_whole, &c_field, &c_kv, &c_plot, &c_patch, &c_embed, &c_media,
    ] {
        assert_eq!(find(&e, id)["unlocated"], false, "{id} should be located");
    }

    // Delete each addressed sub-item: comments stay intact and degrade to unlocated.
    e.call(
        "entry_template.put_module",
        json!({
            "book": b,
            "template": "tpl-parts",
            "module": {
                "id": "mod-fields",
                "kind": "fields",
                "name": "字段",
                "pos": "a1",
                "config": {
                    "defs": [
                        {"id": "age", "name": "年龄", "field_type": "number", "pos": "a1"}
                    ]
                }
            }
        }),
    );
    assert_eq!(find(&e, &c_field)["unlocated"], true);
    assert_eq!(find(&e, &c_whole)["unlocated"], false);

    e.call(
        "module.remove_kv",
        json!({"book": b, "entry": entry, "module": "mod-kv", "row": "row-1"}),
    );
    assert_eq!(find(&e, &c_kv)["unlocated"], true);

    e.call(
        "module.put_grid",
        json!({
            "book": b,
            "entry": entry,
            "module": "mod-plot",
            "grid": {
                "cell_w": 220.0,
                "cell_h": 140.0,
                "rows": [{"id": "custom-r1", "pos": "a0", "label": "R1"}],
                "columns": [{"id": "custom-c1", "pos": "a0", "label": "C1"}],
                "cells": []
            }
        }),
    );
    assert_eq!(find(&e, &c_plot)["unlocated"], true);

    e.call(
        "module.remove_patch",
        json!({"book": b, "entry": entry, "module": "mod-patches", "id": patch}),
    );
    assert_eq!(find(&e, &c_patch)["unlocated"], true);

    e.call(
        "module.remove_media",
        json!({"book": b, "entry": entry, "module": "mod-media", "item": "media-map-1"}),
    );
    assert_eq!(find(&e, &c_media)["unlocated"], true);

    {
        let s = e.ws().prose_session(&doc_id).unwrap();
        s.edit(|t| {
            // Delete the two embed paragraphs at the top (`emb-tbl-1` at 0..2, `emb-map-1` at 2..4 -> after first delete 0..2).
            t.delete(0..4)?;
            Ok(())
        })
        .unwrap();
    }
    assert_eq!(find(&e, &c_embed)["unlocated"], true);

    // Checklist task projection via `comment.project` sets `origin = "task"` and syncs checked status.
    let block = {
        let s = e.ws().prose_session(&doc_id).unwrap();
        s.reader()
            .view()
            .paragraphs()
            .next()
            .unwrap()
            .id
            .unwrap()
            .to_string()
    };
    let projected = e.out(
        "comment.project",
        json!({
            "doc": doc_id,
            "markers": [],
            "tasks": [{"block": block, "task": "Checklist item", "checked": false}]
        }),
    );
    let task_id = projected["created"][0].as_str().unwrap().to_string();
    assert_eq!(find(&e, &task_id)["origin"], "task");
    assert_eq!(find(&e, &task_id)["status"], "open");

    e.call(
        "comment.project",
        json!({
            "doc": doc_id,
            "markers": [],
            "tasks": [{"block": block, "task": "Checklist item updated", "checked": true}]
        }),
    );
    assert_eq!(find(&e, &task_id)["body"], "Checklist item updated");
    assert_eq!(find(&e, &task_id)["status"], "resolved");

    // Reopen + verify persistence of CommentPart round-trip in Loro.
    e.reopen();
    assert_eq!(
        find(&e, &c_field)["part"],
        json!({"kind": "field", "field": "origin"})
    );
    assert_eq!(
        find(&e, &c_embed)["part"],
        json!({
            "kind": "embed",
            "embed": "emb-map-1",
            "region": {"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4}
        })
    );
    assert_eq!(
        find(&e, &c_media)["part"],
        json!({
            "kind": "media",
            "item": "media-map-1",
            "region": {"page": 1, "x": 0.2, "y": 0.3, "w": 0.4, "h": 0.5}
        })
    );
}
