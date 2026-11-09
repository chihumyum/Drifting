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
    .map(|d| e.ws().observe(d).unwrap().value)
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
    for (i, (a, b)) in actual.iter().zip(expected).enumerate() {
        let a = a.as_object().unwrap();
        let b = b.as_object().unwrap();
        for key in a.keys().chain(b.keys()) {
            assert_eq!(a.get(key), b.get(key), "document {i}, root {key}");
        }
    }
}

fn raw_entry(d: &loro::LoroDoc, id: &str) -> loro::LoroMap {
    let tree = d.get_tree("entries");
    tree.nodes().into_iter().map(|n|tree.get_meta(n).unwrap()).find(|m| {
        matches!(m.get("id"),Some(loro::ValueOrContainer::Value(loro::LoroValue::String(s))) if s.as_str()==id)
    }).unwrap()
}
#[test]
fn hidden_future_fields_grids_and_relations_survive_without_touching_other_entries() {
    let (e, b, id) = setup();
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
