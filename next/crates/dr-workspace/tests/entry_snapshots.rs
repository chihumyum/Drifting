mod common;
use common::*;
use dr_workspace::Actor;
use serde_json::{Value, json};
fn setup() -> (Env, String, String) {
    let e = env();
    let b = e.out("project.create", json!({"name":"Synthetic snapshot"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    for (id, kind) in [("second", "prose"), ("patches", "patches"), ("pairs", "kv")] {
        e.call(
            "entry_template.put_module",
            json!({"book":b,"template":"tpl-chapter","module":{"id":id,"kind":kind,"name":id}}),
        );
    }
    let id=e.out("entry.create",json!({"book":b,"title":"Before","template":"tpl-chapter","bodies":{"mod-prose":"Before A","second":"Before B"}}))["id"].as_str().unwrap().to_owned();
    (e, b, id)
}
fn capture(e: &Env, b: &str, id: &str) -> String {
    e.out("entry_snapshot.create", json!({"book":b,"entry":id}))["id"]
        .as_str()
        .unwrap()
        .to_owned()
}
fn preview(e: &Env, b: &str, id: &str, p: &str) -> Value {
    e.out(
        "entry_snapshot.preview",
        json!({"book":b,"entry":id,"point":p}),
    )
}
fn input(e: &Env, b: &str, id: &str, p: &str) -> Value {
    json!({"book":b,"entry":id,"point":p,"expected":preview(e,b,id,p)["expected"]})
}
fn body(e: &Env, b: &str, id: &str, module: &str) -> Value {
    e.out(
        "module.read_prose",
        json!({"book":b,"owner":id,"module":module}),
    )["paragraphs"]
        .clone()
}
fn edit(e: &Env, b: &str, id: &str) {
    e.call("entry.update", json!({"book":b,"id":id,"title":"After"}));
    for module in ["mod-prose", "second"] {
        call(
            e.ws(),
            &Actor::agent("snapshots", 1, module),
            "module.set_prose",
            json!({"book":b,"owner":id,"module":module,"paragraphs":[{"text":format!("After {module}")}]}),
        );
    }
}
fn data(e: &Env, b: &str, id: &str) -> Vec<Value> {
    [
        format!("book:{b}"),
        format!("body:{id}/mod-prose"),
        format!("body:{id}/second"),
    ]
    .iter()
    .map(|d| {
        let o = e.ws().observe(d).unwrap();
        json!({"version":o.version,"value":o.value})
    })
    .collect()
}
#[test]
fn complete_restore_and_pre_restore_checkpoint_survive_reopen_and_preserve_other_entries() {
    let (mut e, b, id) = setup();
    let other=e.out("entry.create",json!({"book":b,"template":"tpl-chapter","title":"Other","bodies":{"mod-prose":"Other text"}}))["id"].as_str().unwrap().to_owned();
    let patch=e.out("module.put_patch",json!({"book":b,"entry":id,"module":"patches","title":"Before patch","body":"Before patch body"}))["id"].clone();
    e.call("module.put_kv",json!({"book":b,"entry":id,"module":"pairs","row":{"id":"pair","key":"Before key","value":"Before value"}}));
    let p = capture(&e, &b, &id);
    edit(&e, &b, &id);
    e.call("module.put_patch",json!({"book":b,"entry":id,"module":"patches","id":patch,"title":"After patch","body":"After patch body"}));
    e.call("module.put_kv",json!({"book":b,"entry":id,"module":"pairs","row":{"id":"pair","key":"After key","value":"After value"}}));
    let result = e.out("entry_snapshot.restore", input(&e, &b, &id, &p));
    assert_eq!(body(&e, &b, &id, "mod-prose")[0]["text"], "Before A");
    assert_eq!(body(&e, &b, &id, "second")[0]["text"], "Before B");
    assert_eq!(body(&e, &b, &other, "mod-prose")[0]["text"], "Other text");
    let restored = capture(&e, &b, &id);
    let view = preview(&e, &b, &id, &restored);
    assert_eq!(
        view["records"]["patches"][patch.as_str().unwrap()]["body"],
        "Before patch body"
    );
    assert_eq!(
        view["metadata"]["kv:pairs"]["pair"]["value"],
        "Before value"
    );
    e.call(
        "entry_snapshot.restore",
        input(&e, &b, &id, result["before"].as_str().unwrap()),
    );
    assert_eq!(body(&e, &b, &id, "second")[0]["text"], "After second");
    e.reopen();
    assert_eq!(body(&e, &b, &id, "mod-prose")[0]["text"], "After mod-prose");
    assert_eq!(
        preview(&e, &b, &id, &p)["bodies"].as_array().unwrap().len(),
        2
    );
}
#[test]
fn stale_book_or_body_refuses_every_write_and_preserves_new_input() {
    let (e, b, id) = setup();
    let p = capture(&e, &b, &id);
    let stale = input(&e, &b, &id, &p);
    edit(&e, &b, &id);
    let before = data(&e, &b, &id);
    assert!(matches!(
        e.try_call("entry_snapshot.restore", stale),
        Err(dr_workspace::WsError::Conflict(_))
    ));
    same(&data(&e, &b, &id), &before);
    let stale = input(&e, &b, &id, &p);
    e.call(
        "module.set_prose",
        json!({"book":b,"owner":id,"module":"second","paragraphs":[{"text":"new typing"}]}),
    );
    let before = data(&e, &b, &id);
    assert!(e.try_call("entry_snapshot.restore", stale).is_err());
    same(&data(&e, &b, &id), &before);
}
#[test]
fn staged_book_or_body_failure_never_leaks_and_reopens_unchanged() {
    let (mut e, b, id) = setup();
    let p = capture(&e, &b, &id);
    edit(&e, &b, &id);
    for fault in ["snapshot_after_book", "snapshot_after_body"] {
        let before = data(&e, &b, &id);
        let args = input(&e, &b, &id, &p);
        e.faults.arm(fault);
        assert!(e.try_call("entry_snapshot.restore", args).is_err());
        same(&data(&e, &b, &id), &before);
        e.reopen();
        same(&data(&e, &b, &id), &before);
    }
}
#[test]
fn sql_failure_rolls_back_bodies_book_and_pre_restore_checkpoint() {
    let (mut e, b, id) = setup();
    let p = capture(&e, &b, &id);
    edit(&e, &b, &id);
    let before = data(&e, &b, &id);
    e.ws().library().local_transaction(|tx| { tx.execute_batch("CREATE TRIGGER reject_restore BEFORE INSERT ON loro_update WHEN NEW.doc_id LIKE 'book:%' BEGIN SELECT RAISE(ABORT, 'atomic fault'); END;")?; Ok(()) }).unwrap();
    assert!(
        e.try_call("entry_snapshot.restore", input(&e, &b, &id, &p))
            .is_err()
    );
    same(&data(&e, &b, &id), &before);
    e.ws()
        .library()
        .local_transaction(|tx| {
            tx.execute_batch("DROP TRIGGER reject_restore")?;
            Ok(())
        })
        .unwrap();
    e.reopen();
    same(&data(&e, &b, &id), &before);
}
#[test]
fn removed_module_is_previewed_from_history_and_restored_as_retained_content() {
    let (e, b, id) = setup();
    let p = capture(&e, &b, &id);
    edit(&e, &b, &id);
    e.call(
        "entry_template.remove_module",
        json!({"book":b,"template":"tpl-chapter","module":"second"}),
    );
    assert!(
        preview(&e, &b, &id, &p)["template"]["modules"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["id"] == "second")
    );
    e.call("entry_snapshot.restore", input(&e, &b, &id, &p));
    assert_eq!(body(&e, &b, &id, "second")[0]["text"], "Before B");
    assert!(
        e.out("module.list", json!({"book":b,"id":id}))
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["id"] == "second" && m["retained"] == true)
    );
}
#[test]
fn wrong_entry_and_invalid_version_do_not_write() {
    let (e, b, id) = setup();
    let p = capture(&e, &b, &id);
    edit(&e, &b, &id);
    let before = data(&e, &b, &id);
    let mut args = input(&e, &b, &id, &p);
    args["expected"][format!("body:{id}/second")] = json!("invalid");
    assert!(e.try_call("entry_snapshot.restore", args).is_err());
    assert!(
        e.try_call(
            "entry_snapshot.preview",
            json!({"book":b,"entry":"foreign-entry","point":p})
        )
        .is_err()
    );
    same(&data(&e, &b, &id), &before);
}
#[test]
fn journal_undo_restores_all_bodies_and_rejects_later_typing() {
    let (e, b, id) = setup();
    let p = capture(&e, &b, &id);
    edit(&e, &b, &id);
    e.call("entry_snapshot.restore", input(&e, &b, &id, &p));
    e.ws().undo(&Actor::User).unwrap();
    assert_eq!(body(&e, &b, &id, "second")[0]["text"], "After second");
    e.ws().redo(&Actor::User).unwrap();
    assert_eq!(body(&e, &b, &id, "second")[0]["text"], "Before B");
    e.call("entry_snapshot.restore", input(&e, &b, &id, &p));
    let h = e
        .ws()
        .library()
        .open_doc(&format!("body:{id}/second"), dr_store::OpenDoc::Existing)
        .unwrap();
    h.write(dr_store::Origin::User, |d| {
        d.get_text("body").insert(0, "typed").unwrap();
    })
    .unwrap();
    let before = data(&e, &b, &id);
    assert!(e.ws().undo(&Actor::User).is_err());
    same(&data(&e, &b, &id), &before);
}

fn same(actual: &[Value], expected: &[Value]) {
    assert_eq!(actual.len(), expected.len());
    for (i, (a, b)) in actual.iter().zip(expected).enumerate() {
        assert_eq!(
            a["version"], b["version"],
            "document {i}: persisted operations changed"
        );
        let a = a["value"].as_object().unwrap();
        let b = b["value"].as_object().unwrap();
        for key in a.keys().chain(b.keys()) {
            // Proven by unwritten_empty_membership_root_is_not_an_author_write:
            // get_map on this known root creates an in-memory empty root with
            // no operations. No other root or nonempty author value is exempt.
            if key == "memberships"
                && matches!((a.get(key),b.get(key)),(None,Some(v))|(Some(v),None) if v.as_object().is_some_and(|m|m.is_empty()))
            {
                continue;
            }
            assert_eq!(a.get(key), b.get(key), "document {i}, root {key}");
        }
    }
}

#[test]
fn unwritten_empty_membership_root_is_not_an_author_write() {
    let (e, b, _) = setup();
    let doc = format!("book:{b}");
    let h = e
        .ws()
        .library()
        .open_doc(&doc, dr_store::OpenDoc::Existing)
        .unwrap();
    let (before, after, value) = h
        .read(|d| {
            let before = d.oplog_frontiers();
            let value = d.get_map("memberships").get_deep_value();
            (before, d.oplog_frontiers(), value)
        })
        .unwrap();
    assert_eq!(before, after);
    assert_eq!(serde_json::to_value(value).unwrap(), json!({}));
    assert!(
        serde_json::to_value(e.ws().library().load_copy(&doc).unwrap().get_deep_value())
            .unwrap()
            .get("memberships")
            .is_none()
    );
}

fn raw_entry(d: &loro::LoroDoc, id: &str) -> loro::LoroMap {
    let tree = d.get_tree("entries");
    tree.nodes().into_iter().map(|n|tree.get_meta(n).unwrap()).find(|m| {
        matches!(m.get("id"),Some(loro::ValueOrContainer::Value(loro::LoroValue::String(s))) if s.as_str()==id)
    }).unwrap()
}
#[test]
fn hidden_future_fields_grids_and_relations_survive_without_touching_other_entries() {
    let (mut e, b, id) = setup();
    let other = e.out(
        "entry.create",
        json!({"book":b,"template":"tpl-chapter","title":"Other"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let h = e
        .ws()
        .library()
        .open_doc(&format!("book:{b}"), dr_store::OpenDoc::Existing)
        .unwrap();
    let (one, two) = (id.clone(), other.clone());
    h.write(dr_store::Origin::User, move |d| {
        raw_entry(d, &one)
            .ensure_mergeable_map("future")
            .unwrap()
            .insert("hidden", "before")
            .unwrap();
        raw_entry(d, &two)
            .ensure_mergeable_map("future")
            .unwrap()
            .insert("hidden", "other before")
            .unwrap();
        let grid = d
            .get_map("plot_grids")
            .ensure_mergeable_map(&format!("{one}/retained-grid"))
            .unwrap();
        grid.ensure_mergeable_map("cells")
            .unwrap()
            .insert("unknown-row|unknown-col", "hidden cell")
            .unwrap();
        let r = d
            .get_map("relations")
            .ensure_mergeable_map("hidden-relation")
            .unwrap();
        for (k, v) in [
            ("from_kind", "entry"),
            ("from", one.as_str()),
            ("to_kind", "entry"),
            ("to", two.as_str()),
            ("type", "missing-type"),
        ] {
            r.insert(k, v).unwrap();
        }
        r.insert("future", "retained relation").unwrap();
    })
    .unwrap();
    let p = capture(&e, &b, &id);
    let original = preview(&e, &b, &id, &p);
    let (one, two) = (id.clone(), other.clone());
    h.write(dr_store::Origin::User, move |d| {
        raw_entry(d, &one)
            .ensure_mergeable_map("future")
            .unwrap()
            .insert("hidden", "after")
            .unwrap();
        raw_entry(d, &two)
            .ensure_mergeable_map("future")
            .unwrap()
            .insert("hidden", "other after")
            .unwrap();
        d.get_map("relations").delete("hidden-relation").unwrap();
        d.get_map("plot_grids")
            .delete(&format!("{one}/retained-grid"))
            .unwrap();
    })
    .unwrap();
    e.call("entry_snapshot.restore", input(&e, &b, &id, &p));
    let q = capture(&e, &b, &id);
    let now = preview(&e, &b, &id, &q);
    assert_eq!(now["metadata"], original["metadata"]);
    assert_eq!(now["records"], original["records"]);
    assert_eq!(now["metadata"]["future"]["hidden"], "before");
    assert_eq!(
        now["records"]["relations"]["hidden-relation"]["future"],
        "retained relation"
    );
    assert_eq!(
        now["records"]["plot_grids"][format!("{id}/retained-grid")]["cells"]["unknown-row|unknown-col"],
        "hidden cell"
    );
    let q = capture(&e, &b, &other);
    assert_eq!(
        preview(&e, &b, &other, &q)["metadata"]["future"]["hidden"],
        "other after"
    );
    drop(h);
    e.reopen();
    let p = capture(&e, &b, &id);
    let reopened = preview(&e, &b, &id, &p);
    assert_eq!(reopened["metadata"], original["metadata"]);
    assert_eq!(reopened["records"], original["records"]);
}
#[test]
fn body_added_after_checkpoint_is_empty_on_restore_and_recoverable_from_before_point() {
    let (e, b, id) = setup();
    let p = capture(&e, &b, &id);
    e.call("entry_template.put_module",json!({"book":b,"template":"tpl-chapter","module":{"id":"later","kind":"prose","name":"Later"}}));
    e.call(
        "module.set_prose",
        json!({"book":b,"owner":id,"module":"later","paragraphs":[{"text":"Later content"}]}),
    );
    let r = e.out("entry_snapshot.restore", input(&e, &b, &id, &p));
    assert!(
        body(&e, &b, &id, "later")
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["text"] == "")
    );
    e.call(
        "entry_snapshot.restore",
        input(&e, &b, &id, r["before"].as_str().unwrap()),
    );
    assert_eq!(body(&e, &b, &id, "later")[0]["text"], "Later content");
}
#[test]
fn concurrent_restores_from_one_observation_cannot_both_overwrite_successfully() {
    let (e, b, id) = setup();
    let p = capture(&e, &b, &id);
    edit(&e, &b, &id);
    let args = input(&e, &b, &id, &p);
    let ws = e.ws().clone();
    let second = args.clone();
    let gate = std::sync::Arc::new(std::sync::Barrier::new(2));
    let next = gate.clone();
    let worker = std::thread::spawn(move || {
        next.wait();
        ws.call(&Actor::User, "entry_snapshot.restore", second)
    });
    gate.wait();
    let first = e.try_call("entry_snapshot.restore", args);
    let second = worker.join().unwrap();
    assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
    let refused = first.err().or_else(|| second.err()).unwrap();
    assert_eq!(refused.code(), "conflict");
    assert_eq!(body(&e, &b, &id, "mod-prose")[0]["text"], "Before A");
    assert_eq!(body(&e, &b, &id, "second")[0]["text"], "Before B");
}

#[test]
fn missing_default_bodies_and_checkpoint_commit_together_and_respect_caller_guards() {
    let (mut e, b, id) = setup();
    let unwritten = format!("body:{id}/retained-unwritten");
    e.ws()
        .library()
        .register(&unwritten, "body", Some(&b))
        .unwrap();
    e.call("entry_template.put_module",json!({"book":b,"template":"tpl-chapter","module":{"id":"lazy","kind":"prose","name":"Lazy"}}));
    e.call("module.set_prose",json!({"book":b,"owner":"tpl-chapter","template":true,"module":"lazy","paragraphs":[{"text":"Template default"}]}));
    let lazy = format!("body:{id}/lazy");
    let observed = e.ws().observe(&format!("book:{b}")).unwrap();
    let h = e
        .ws()
        .library()
        .open_doc(&format!("book:{b}"), dr_store::OpenDoc::Existing)
        .unwrap();
    let entry = id.clone();
    h.write(dr_store::Origin::User, move |d| {
        raw_entry(d, &entry)
            .insert("title", "Concurrent title")
            .unwrap()
    })
    .unwrap();
    drop(h);
    let before = data(&e, &b, &id);
    let r = e.ws().call_guarded(
        &Actor::User,
        "entry_snapshot.create",
        json!({"book":b,"entry":id}),
        dr_workspace::WritePreconditions::from_observations([observed]),
    );
    assert!(matches!(r, Err(dr_workspace::WsError::Conflict(_))));
    assert!(e.ws().library().doc_info(&lazy).unwrap().is_none());
    assert!(matches!(
        e.ws().library().load_copy(&unwritten),
        Err(dr_store::StoreError::NotFound(_))
    ));
    same(&data(&e, &b, &id), &before);
    e.faults.arm("snapshot_create_after_body");
    assert!(
        e.try_call("entry_snapshot.create", json!({"book":b,"entry":id}))
            .is_err()
    );
    assert!(e.ws().library().doc_info(&lazy).unwrap().is_none());
    assert!(matches!(
        e.ws().library().load_copy(&unwritten),
        Err(dr_store::StoreError::NotFound(_))
    ));
    same(&data(&e, &b, &id), &before);
    e.ws().library().local_transaction(|tx| { tx.execute_batch("CREATE TRIGGER reject_checkpoint BEFORE INSERT ON loro_update WHEN NEW.doc_id LIKE 'book:%' BEGIN SELECT RAISE(ABORT, 'checkpoint fault'); END;")?; Ok(()) }).unwrap();
    assert!(
        e.try_call("entry_snapshot.create", json!({"book":b,"entry":id}))
            .is_err()
    );
    assert!(e.ws().library().doc_info(&lazy).unwrap().is_none());
    assert!(matches!(
        e.ws().library().load_copy(&unwritten),
        Err(dr_store::StoreError::NotFound(_))
    ));
    same(&data(&e, &b, &id), &before);
    e.ws()
        .library()
        .local_transaction(|tx| {
            tx.execute_batch("DROP TRIGGER reject_checkpoint")?;
            Ok(())
        })
        .unwrap();
    let observations = [
        format!("book:{b}"),
        format!("body:{id}/mod-prose"),
        format!("body:{id}/second"),
    ]
    .iter()
    .map(|d| e.ws().observe(d).unwrap())
    .collect::<Vec<_>>();
    let p = e
        .ws()
        .call_guarded(
            &Actor::agent("synthetic", 1, "capture"),
            "entry_snapshot.create",
            json!({"book":b,"entry":id}),
            dr_workspace::WritePreconditions::from_observations(observations),
        )
        .unwrap()["output"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(body(&e, &b, &id, "lazy")[0]["text"], "Template default");
    assert!(e.ws().library().load_copy(&unwritten).is_ok());
    e.reopen();
    assert!(
        preview(&e, &b, &id, &p)["bodies"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["text"].as_str().unwrap().contains("Template default"))
    );
}

#[test]
fn body_registered_after_preview_without_a_book_edit_invalidates_restore() {
    let (mut e, b, id) = setup();
    let p = capture(&e, &b, &id);
    edit(&e, &b, &id);
    let args = input(&e, &b, &id, &p);
    // Register a retained body directly, without changing the book frontier.
    let doc = dr_model::DocId::parse(&format!("body:{id}/hidden-new")).unwrap();
    let genesis = dr_doc::prose::genesis(&doc);
    let h = e
        .ws()
        .library()
        .open_doc(
            &doc.to_string(),
            dr_store::OpenDoc::CreateIfMissing {
                kind: "body",
                book_id: Some(&b),
                genesis: &|d| {
                    d.import(&genesis).unwrap();
                },
            },
        )
        .unwrap();
    h.write(dr_store::Origin::User, |d| {
        d.get_text("body").insert(0, "Later author text").unwrap()
    })
    .unwrap();
    let before = data(&e, &b, &id);
    assert!(matches!(
        e.try_call("entry_snapshot.restore", args),
        Err(dr_workspace::WsError::Conflict(_))
    ));
    same(&data(&e, &b, &id), &before);
    h.close();
    e.reopen();
    assert_eq!(
        body(&e, &b, &id, "hidden-new")[0]["text"],
        "Later author text"
    );
}

fn replace_manifest(e: &Env, b: &str, p: &str, mutate: impl FnOnce(&mut Value)) {
    let h = e
        .ws()
        .library()
        .open_doc(&format!("book:{b}"), dr_store::OpenDoc::Existing)
        .unwrap();
    let id = p.to_owned();
    // Read and edit a stored manifest to model damage, never via the immutable API.
    let text = h
        .read({
            let id = id.clone();
            move |d| match d.get_map("entry_checkpoints").get(&id).unwrap() {
                loro::ValueOrContainer::Value(loro::LoroValue::String(s)) => s.to_string(),
                _ => panic!("manifest"),
            }
        })
        .unwrap();
    let mut value = serde_json::from_str(&text).unwrap();
    mutate(&mut value);
    let encoded = serde_json::to_string(&value).unwrap();
    h.write(dr_store::Origin::User, move |d| {
        d.get_map("entry_checkpoints").insert(&id, encoded).unwrap()
    })
    .unwrap();
}

#[test]
fn damaged_manifest_missing_history_and_cross_book_inputs_never_mutate() {
    let (mut e, b, id) = setup();
    let p = capture(&e, &b, &id);
    edit(&e, &b, &id);
    let other = e.out("project.create", json!({"name":"Other synthetic book"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let other_before = e.ws().observe(&format!("book:{other}")).unwrap();
    let args = input(&e, &b, &id, &p);
    assert!(
        e.try_call(
            "entry_snapshot.restore",
            json!({"book":other,"entry":id,"point":p,"expected":args["expected"]})
        )
        .is_err()
    );
    replace_manifest(&e, &b, &p, |v| {
        v["bodies"]
            .as_object_mut()
            .unwrap()
            .remove(&format!("body:{id}/second"));
    });
    let damaged = data(&e, &b, &id);
    assert!(e.try_call("entry_snapshot.restore", args).is_err());
    same(&data(&e, &b, &id), &damaged);
    // A checksum-valid but unavailable frontier is also rejected before staging.
    let q = capture(&e, &b, &id);
    let args = input(&e, &b, &id, &q);
    replace_manifest(&e, &b, &q, |v| {
        v["bodies"][format!("body:{id}/second")] = json!("bad");
        v["checksum"] = json!("");
        let typed: dr_workspace::commands::v3::snapshots::Point =
            serde_json::from_value(v.clone()).unwrap();
        v["checksum"] = json!(dr_store::digest::sha256_hex(
            &serde_json::to_vec(&typed).unwrap()
        ));
    });
    let damaged = data(&e, &b, &id);
    assert!(e.try_call("entry_snapshot.restore", args).is_err());
    same(&data(&e, &b, &id), &damaged);
    e.reopen();
    same(&data(&e, &b, &id), &damaged);
    assert_eq!(
        e.ws().observe(&format!("book:{other}")).unwrap().value,
        other_before.value
    );
    assert_eq!(body(&e, &b, &id, "second")[0]["text"], "After second");
}

#[test]
fn automatic_captures_follow_interval_and_close_only_changed_entry_content() {
    let (mut e, b, id) = setup();
    let args = json!({"book":b,"entry":id,"reason":"periodic"});
    let first = e.out("entry_snapshot.capture", args.clone());
    assert_eq!(first["reason"], "periodic");
    assert!((dr_store::now_ms() - first["ts"].as_i64().unwrap()).abs() < 10_000);
    edit(&e, &b, &id);
    assert_eq!(e.out("entry_snapshot.capture", args)["id"], first["id"]);
    let close = e.out(
        "entry_snapshot.capture",
        json!({"book":b,"entry":id,"reason":"close"}),
    );
    assert_ne!(close["id"], first["id"]);
    assert_eq!(
        e.out(
            "entry_snapshot.capture",
            json!({"book":b,"entry":id,"reason":"close"})
        )["id"],
        close["id"]
    );
    e.reopen();
    assert_eq!(
        e.out(
            "entry_snapshot.capture",
            json!({"book":b,"entry":id,"reason":"close"})
        )["id"],
        close["id"]
    );
    assert_eq!(
        e.out("entry_snapshot.list", json!({"book":b,"entry":id}))
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn foreign_retained_body_and_agent_restore_are_refused_without_changes() {
    let (mut e, b, id) = setup();
    let p = capture(&e, &b, &id);
    edit(&e, &b, &id);
    let args = input(&e, &b, &id, &p);
    let before = data(&e, &b, &id);
    assert!(
        e.ws()
            .call(
                &Actor::agent("synthetic", 1, "restore"),
                "entry_snapshot.restore",
                args.clone()
            )
            .is_err()
    );
    same(&data(&e, &b, &id), &before);
    e.ws()
        .library()
        .register(&format!("body:{id}/foreign"), "body", Some("another-book"))
        .unwrap();
    assert!(e.try_call("entry_snapshot.restore", args).is_err());
    same(&data(&e, &b, &id), &before);
    e.reopen();
    same(&data(&e, &b, &id), &before);
}

#[test]
fn journal_failure_keeps_a_durable_before_checkpoint_for_real_recovery() {
    let (mut e, b, id) = setup();
    let p = capture(&e, &b, &id);
    edit(&e, &b, &id);
    e.faults.arm("journal");
    let outcome = e.call("entry_snapshot.restore", input(&e, &b, &id, &p));
    assert!(outcome["undo"].is_null());
    let before = outcome["output"]["before"].as_str().unwrap().to_owned();
    assert_eq!(body(&e, &b, &id, "second")[0]["text"], "Before B");
    e.reopen();
    e.call("entry_snapshot.restore", input(&e, &b, &id, &before));
    assert_eq!(body(&e, &b, &id, "mod-prose")[0]["text"], "After mod-prose");
    assert_eq!(body(&e, &b, &id, "second")[0]["text"], "After second");
}

#[test]
fn retention_thins_only_automatic_points_and_never_the_before_recovery_path() {
    let (e, b, id) = setup();
    let manual = capture(&e, &b, &id);
    edit(&e, &b, &id);
    let automatic = e.out(
        "entry_snapshot.capture",
        json!({"book":b,"entry":id,"reason":"close"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let before = e.out("entry_snapshot.restore", input(&e, &b, &id, &manual))["before"]
        .as_str()
        .unwrap()
        .to_owned();
    for point in [&manual, &automatic, &before] {
        replace_manifest(&e, &b, point, |v| {
            v["ts"] = json!(dr_store::now_ms() - 31 * dr_store::history::DAY_MS);
            v["checksum"] = json!("");
            let typed: dr_workspace::commands::v3::snapshots::Point =
                serde_json::from_value(v.clone()).unwrap();
            v["checksum"] = json!(dr_store::digest::sha256_hex(
                &serde_json::to_vec(&typed).unwrap()
            ));
        });
    }
    edit(&e, &b, &id);
    capture(&e, &b, &id);
    let points = e.out("entry_snapshot.list", json!({"book":b,"entry":id}));
    let has = |id: &str| points.as_array().unwrap().iter().any(|p| p["id"] == id);
    assert!(has(&manual));
    assert!(has(&before));
    assert!(!has(&automatic));
    e.call("entry_snapshot.restore", input(&e, &b, &id, &before));
    assert_eq!(body(&e, &b, &id, "second")[0]["text"], "After second");
}

#[test]
fn future_container_types_rich_marks_hidden_memberships_and_shared_templates_roundtrip_exactly() {
    let (mut e, b, id) = setup();
    let patch = e.out(
        "module.put_patch",
        json!({"book":b,"entry":id,"module":"patches","title":"Rich patch","body":"Before patch"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let h = e
        .ws()
        .library()
        .open_doc(&format!("book:{b}"), dr_store::OpenDoc::Existing)
        .unwrap();
    let (entry, patch_id) = (id.clone(), patch.clone());
    h.write(dr_store::Origin::User, move |d| {
        let future = raw_entry(d, &entry).ensure_mergeable_map("future").unwrap();
        let rich = future
            .insert_container("rich", loro::LoroText::new())
            .unwrap();
        rich.insert(0, "Retained rich text").unwrap();
        rich.mark(0..8, "bold", true).unwrap();
        future
            .insert_container("empty", loro::LoroMap::new())
            .unwrap();
        let values = future
            .insert_container("values", loro::LoroMovableList::new())
            .unwrap();
        values.insert(0, "first").unwrap();
        values.insert(1, "second").unwrap();
        let p = d
            .get_map("patches")
            .ensure_mergeable_map(&patch_id)
            .unwrap();
        if let Some(loro::ValueOrContainer::Container(loro::Container::Text(t))) = p.get("body") {
            t.mark(0..6, "italic", true).unwrap();
        }
        let membership = d
            .get_map("memberships")
            .ensure_mergeable_map(&format!("missing-host|{entry}"))
            .unwrap();
        membership.insert("member", entry.as_str()).unwrap();
        membership.insert("future", "hidden author value").unwrap();
    })
    .unwrap();
    let p = capture(&e, &b, &id);
    let bid = dr_model::id::BookId::parse(&b).unwrap();
    let eid = dr_model::id::EntryId::parse(&id).unwrap();
    let raw = |e: &Env| {
        let d = e.ws().library().load_copy(&format!("book:{b}")).unwrap();
        dr_doc::v3::BorrowedBookV3::new(&d, &bid)
            .unwrap()
            .view()
            .entry_owned_raw_state(&eid)
            .unwrap()
    };
    let expected = raw(&e);
    let entry = id.clone();
    let patch_id = patch.clone();
    h.write(dr_store::Origin::User, move |d| {
        let future = raw_entry(d, &entry).ensure_mergeable_map("future").unwrap();
        // The same deep JSON string must not disguise loss of a text container
        // and its attributes; likewise for empty and movable containers.
        future.insert("rich", "Retained rich text").unwrap();
        future.delete("empty").unwrap();
        future
            .insert("values", loro::LoroValue::from(vec!["first", "second"]))
            .unwrap();
        d.get_map("memberships")
            .delete(&format!("missing-host|{entry}"))
            .unwrap();
        if let Some(loro::ValueOrContainer::Container(loro::Container::Text(t))) = d
            .get_map("patches")
            .ensure_mergeable_map(&patch_id)
            .unwrap()
            .get("body")
        {
            t.unmark(0..6, "italic").unwrap();
        }
        d.get_map("templates")
            .ensure_mergeable_map("tpl-chapter")
            .unwrap()
            .insert("future", "shared template after")
            .unwrap();
    })
    .unwrap();
    assert_ne!(raw(&e), expected);
    e.call("entry_snapshot.restore", input(&e, &b, &id, &p));
    assert_eq!(raw(&e), expected);
    let d = e.ws().library().load_copy(&format!("book:{b}")).unwrap();
    assert!(
        serde_json::to_value(d.get_map("templates").get_deep_value()).unwrap()["tpl-chapter"]["future"]
            == "shared template after"
    );
    drop(h);
    drop(d);
    e.reopen();
    assert_eq!(raw(&e), expected);
}
