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
    let after_a = e.ws().observe(&format!("book:{a}")).unwrap();
    let mut expected = before_a.value.clone();
    expected["writing_days"] = after_a.value["writing_days"].clone();
    assert_eq!(expected, after_a.value);
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
fn v3_material_delete_restores_hidden_relations_comments_and_live_text_after_reopen() {
    use dr_model::book::EntityRef;
    use dr_model::id::{BookId, CommentId};
    use dr_model::kind::EntityKind;
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
    let material = item(e.out("material.create", json!({"book":b,"kind":"text","title":"Synthetic note","text":"Preserve my note","description":"Original description"})));
    e.call("entry_relation_type.put", json!({"book":b,"definition":{"id":"test-rel","name":"Synthetic relation","source_kinds":["entry"],"target_kinds":["material"]}}));
    let relation = item(e.out("module.put_relation", json!({"book":b,"entry":entry,"module":"test-relations","other":{"kind":"material","id":material},"relation_type":"test-rel"})));
    // Imported comments exercise the raw v3 record until the command adapter batch lands.
    let (book, mat) = (BookId::parse(&b).unwrap(), material.clone());
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
            .target(Some(&EntityRef::new(EntityKind::Material, mat)))
            .unwrap()
            .body("Preserve this comment")
            .unwrap()
            .quote(Some("quoted passage"))
            .unwrap();
    })
    .unwrap();
    drop(h);
    e.call("entry.trash", json!({"book":b,"id":entry}));
    let copy = e.ws().library().load_copy(&format!("book:{b}")).unwrap();
    let book_id = BookId::parse(&b).unwrap();
    let book = dr_doc::v3::BorrowedBookV3::new(&copy, &book_id).unwrap();
    assert!(book.view().relations().is_empty());
    assert_eq!(book.view().relations_raw().len(), 1);
    let before = raw(&e, &b);
    let prose = e.ws().observe(&format!("material:{material}")).unwrap();
    e.call("material.delete", json!({"book":b,"id":material}));
    let gone = raw(&e, &b);
    assert!(gone["relations"][&relation].is_null());
    assert!(gone["comments"]["synthetic-comment"]["target"].is_null());
    assert_eq!(
        gone["comments"]["synthetic-comment"]["body"],
        "Preserve this comment"
    );
    assert_eq!(
        gone["comments"]["synthetic-comment"]["quote"],
        "quoted passage"
    );
    assert_eq!(
        e.ws()
            .observe(&format!("material:{material}"))
            .unwrap()
            .value,
        prose.value
    );
    e.reopen();
    undo(&e);
    for name in ["materials", "comments", "relations"] {
        assert_eq!(raw(&e, &b)[name], before[name], "{name}");
    }
    e.call(
        "material.update",
        json!({"book":b,"id":material,"description":"Editable after restore"}),
    );
    assert_eq!(
        e.out("material.list", json!({"book":b}))[0]["description"],
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
fn v3_material_folders_restore_order_ancestry_and_only_selected_records() {
    let mut e = env();
    let b = project(&e);
    let a = item(e.out("material_folder.create", json!({"book":b,"name":"A"})));
    let f = item(e.out(
        "material_folder.create",
        json!({"book":b,"name":"Folder","parent":a}),
    ));
    let child = item(e.out(
        "material_folder.create",
        json!({"book":b,"name":"Child","parent":f}),
    ));
    let mat = item(e.out(
        "material.create",
        json!({"book":b,"kind":"text","folder":f,"text":"Synthetic"}),
    ));
    let before = e.out("material_folder.list", json!({"book":b}));
    let mats = e.out("material.list", json!({"book":b}));
    assert!(
        e.try_call(
            "material_folder.update",
            json!({"book":b,"id":a,"parent":child})
        )
        .is_err()
    );
    e.call("material_folder.delete", json!({"book":b,"id":f}));
    assert_eq!(e.out("material.list", json!({"book":b}))[0]["folder"], a);
    e.reopen();
    undo(&e);
    assert_eq!(e.out("material_folder.list", json!({"book":b})), before);
    assert_eq!(e.out("material.list", json!({"book":b})), mats);
    e.ws()
        .redo(&dr_workspace::Actor::User)
        .unwrap()
        .expect("redoable");
    undo(&e);
    let snapshot = e.out("entry_history.version", json!({"book":b}))["version"].clone();
    e.call(
        "material_folder.update",
        json!({"book":b,"id":child,"parent":null}),
    );
    e.call(
        "material_folder.update",
        json!({"book":b,"id":a,"parent":child}),
    );
    e.call("entry_history.restore", json!({"book":b,"at":snapshot,"targets":[{"collection":"material_folders","id":a},{"collection":"material_folders","id":child}]}));
    assert_eq!(e.out("material_folder.list", json!({"book":b})), before);

    let fresh = item(e.out("material_folder.create", json!({"book":b,"name":"New"})));
    e.call("material.update", json!({"book":b,"id":mat,"folder":fresh}));
    let state = raw(&e, &b);
    assert!(
        e.try_call(
            "entry_history.restore",
            json!({"book":b,"at":snapshot,"targets":[{"collection":"material_folders","id":fresh}]})
        )
        .is_err()
    );
    assert_eq!(raw(&e, &b), state);
    e.call("material.move", json!({"book":b,"id":mat,"place":"first"}));
    e.call(
        "material_folder.update",
        json!({"book":b,"id":child,"name":"Renamed","parent":null}),
    );
    undo(&e);
    assert_eq!(
        e.out("material_folder.list", json!({"book":b}))
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["id"] == child)
            .unwrap()["parent"],
        f
    );
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
    let old: legacy::CommentCreateIn =
        serde_json::from_value(json!({"book":b,"target":target})).unwrap();
    assert!(
        e.ws()
            .run::<legacy::CommentCreate>(&Actor::User, old)
            .is_err()
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
    e.call("module.set_prose",json!({"book":b,"owner":root,"module":"about","paragraphs":[{"text":"Synthetic description"}]}));
    e.call("comment.create",json!({"book":b,"target":{"kind":"entry","id":root},"module":"about","range":[0,9],"body":"Level comment"}));
    assert_eq!(
        e.out(
            "comment.list",
            json!({"book":b,"target":{"kind":"entry","id":root},"module":"about"})
        )[0]["quote"],
        "Synthetic"
    );
    assert_eq!(raw(&e, &other), untouched);
    let old_book = e.book();
    e.call(
        "comment.create",
        json!({"book":old_book,"body":"Legacy floating"}),
    );
    assert!(
        e.out("comment.list", json!({"book":old_book}))[0]
            .get("module")
            .is_none()
    );
}

#[test]
fn v3_material_comments_and_typed_todo_projection_keep_document_scope() {
    use dr_workspace::{
        Actor,
        commands::comment::{TodoProject, TodoProjectIn},
    };
    let e = env();
    let b = project(&e);
    let entry = prose_entry(&e, &b);
    let mat = item(e.out(
        "material.create",
        json!({"book":b,"kind":"text","text":"Synthetic material"}),
    ));
    let material_doc = format!("material:{mat}");
    // Refuse a stale imported owner pointing at another book's global document ID.
    let foreign = project(&e);
    let foreign_id = dr_model::id::BookId::parse(&foreign).unwrap();
    let material_id = dr_model::id::MaterialId::parse(&mat).unwrap();
    let h = e
        .ws()
        .library()
        .open_doc(&format!("book:{foreign}"), dr_store::OpenDoc::Existing)
        .unwrap();
    h.write(dr_store::Origin::Import, move |d| {
        let bb = dr_doc::v3::BorrowedBookV3::new(d, &foreign_id).unwrap();
        bb.txn()
            .material(&material_id)
            .unwrap()
            .kind(&dr_model::kind::MaterialKind::Text)
            .unwrap()
            .title("Stale imported owner")
            .unwrap();
    })
    .unwrap();
    drop(h);
    // Reading material metadata opens its empty assets/folder roots without a commit.
    assert_eq!(
        e.out("material.list", json!({"book":foreign}))[0]["id"],
        mat
    );
    let foreign_before = raw(&e, &foreign);
    let foreign_version = e.ws().observe(&format!("book:{foreign}")).unwrap().version;
    assert!(
        e.try_call(
            "comment.create",
            json!({"book":foreign,"target":{"kind":"material","id":mat},"range":[0,9]})
        )
        .is_err()
    );
    assert_eq!(raw(&e, &foreign), foreign_before);
    assert_eq!(
        e.ws().observe(&format!("book:{foreign}")).unwrap().version,
        foreign_version
    );
    let c=item(e.out("comment.create",json!({"book":b,"target":{"kind":"material","id":mat},"body":"Material comment","range":[0,9]})));
    assert_eq!(
        e.out(
            "comment.list",
            json!({"book":b,"target":{"kind":"material","id":mat}})
        )[0]["module"],
        serde_json::Value::Null
    );
    assert!(
        e.try_call(
            "comment.create",
            json!({"book":b,"target":{"kind":"material","id":mat},"module":"mod-prose"})
        )
        .is_err()
    );
    let mut projections = Vec::new();
    for doc in [
        format!("body:{entry}/mod-prose"),
        format!("body:{entry}/second-prose"),
        material_doc.clone(),
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
        let deferred = e.call("todo.project", editing_args.clone());
        assert!(deferred["output"]["created"].as_array().unwrap().is_empty());
        assert!(deferred["journal"].is_null());
        let input: TodoProjectIn = serde_json::from_value(args.clone()).unwrap();
        let got = e.ws().run::<TodoProject>(&Actor::User, input).unwrap();
        assert_eq!(got.output.created.len(), 1);
        let id = got.output.created[0].clone();
        editing_args["markers"][0]["task"] = "Still typing".into();
        let kept = e.call("todo.project", editing_args);
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
        let again = e.call("todo.project", args.clone());
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
    e.call("todo.project", args.clone());
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
    let waiting = e.out("todo.project", json!({"doc":doc,"markers":[]}));
    assert_eq!(waiting["waiting"], json!([remove]));
    assert!(!raw(&e, &b)["comments"][remove].is_null());
    set_meta(r#"{"kind":"todo-autoparse","prose_vv":{}}"#);
    e.call("todo.project", json!({"doc":doc,"markers":[]}));
    let state = raw(&e, &b);
    assert!(state["comments"][remove].is_null());
    assert!(!state["comments"][keep].is_null());
    assert!(!state["comments"][&projections[2].2].is_null());
    e.call("material.delete", json!({"book":b,"id":mat}));
    assert!(raw(&e, &b)["comments"][&c]["target"].is_null());
    undo(&e);
    assert_eq!(raw(&e, &b)["comments"][&c]["target"], mat);
}
