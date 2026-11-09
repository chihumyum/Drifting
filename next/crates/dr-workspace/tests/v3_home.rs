mod common;
use common::*;
use dr_workspace::{
    Actor,
    commands::{
        BookIn, book as legacy,
        v3::{book, recent},
    },
};
use serde_json::{Value, json};

fn project(e: &Env) -> String {
    e.out(
        "project.create",
        json!({"name":"Synthetic home","summary":"Original summary"}),
    )["id"]
        .as_str()
        .unwrap()
        .into()
}
fn root(e: &Env, b: &str) -> String {
    e.out("entry.list", json!({"book":b,"all":true}))
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["template"] == "tpl-manuscript")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .into()
}
fn chapter(e: &Env, b: &str, parent: &str, title: &str) -> String {
    e.out(
        "entry.create",
        json!({"book":b,"parent":parent,"title":title,"template":"tpl-chapter"}),
    )["id"]
        .as_str()
        .unwrap()
        .into()
}
fn recent_list(e: &Env, b: &str) -> Value {
    e.out("recent.list", json!({"book":b}))
}
fn touch(e: &Env, b: &str, target: Value) {
    let out = e.call("recent.touch", json!({"book":b,"target":target}));
    assert!(out["journal"].is_null());
    assert_eq!(out["undo"], json!([]));
    assert_eq!(out["effects"], json!([]));
}

#[test]
fn v3_home_metadata_updates_selected_fields_and_undo_keeps_independent_changes() {
    let mut e = env();
    let a = project(&e);
    let b = project(&e);
    let before = e.ws().observe(&format!("book:{a}")).unwrap();
    let other = e.ws().observe(&format!("book:{b}")).unwrap();
    let get = e.out("book.get", json!({"book":a}));
    for old_count in ["chapters", "ideas", "elements", "words"] {
        assert!(get.get(old_count).is_none());
    }
    assert_eq!(get["word_target"], dr_model::book::DEFAULT_WORD_TARGET);
    assert_eq!(
        get["daily_word_target"],
        dr_model::book::DEFAULT_DAILY_WORD_TARGET
    );
    let typed = e
        .ws()
        .run::<book::BookGet>(&Actor::User, BookIn { book: a.clone() })
        .unwrap();
    assert_eq!(typed.output.name, "Synthetic home");
    // A caller requesting the old counts must choose the explicit v3 output.
    assert!(
        e.ws()
            .run::<legacy::BookGet>(&Actor::User, BookIn { book: a.clone() })
            .is_err()
    );
    e.call(
        "book.update",
        json!({"book":a,"name":"  Renamed  ","word_target":23456}),
    );
    call(
        e.ws(),
        &Actor::Mirror,
        "book.update",
        json!({"book":a,"summary":"Independent summary","daily_word_target":0}),
    );
    let after = e.ws().observe(&format!("book:{a}")).unwrap();
    let mut expected = before.value.clone();
    expected["meta"]["name"] = json!("Renamed");
    expected["meta"]["summary"] = json!("Independent summary");
    expected["meta"]["word_target"] = json!(23456);
    expected["meta"]["daily_word_target"] = json!(0);
    assert_eq!(
        after.value, expected,
        "only the requested metadata fields change"
    );
    e.reopen();
    e.ws().undo(&Actor::User).unwrap().unwrap();
    expected["meta"]["name"] = before.value["meta"]["name"].clone();
    expected["meta"]
        .as_object_mut()
        .unwrap()
        .remove("word_target");
    assert_eq!(
        e.ws().observe(&format!("book:{a}")).unwrap().value,
        expected
    );
    let get = e.out("book.get", json!({"book":a}));
    assert_eq!(get["word_target"], dr_model::book::DEFAULT_WORD_TARGET);
    assert!(get["daily_word_target"].is_null());
    e.ws().redo(&Actor::User).unwrap().unwrap();
    assert_eq!(
        e.ws().observe(&format!("book:{a}")).unwrap().value,
        after.value
    );
    let before_noop = e.ws().observe(&format!("book:{a}")).unwrap().version;
    let noop = e.call(
        "book.update",
        json!({"book":a,"name":"Renamed","word_target":23456}),
    );
    assert!(noop["journal"].is_null());
    assert_eq!(
        e.ws().observe(&format!("book:{a}")).unwrap().version,
        before_noop
    );
    assert_eq!(
        e.ws().observe(&format!("book:{a}")).unwrap().value,
        after.value
    );
    let valid_version = e.ws().observe(&format!("book:{a}")).unwrap().version;
    for change in [
        json!({"book":a,"name":"Do not save","word_target":-1}),
        json!({"book":a,"name":"  ","summary":"Do not save"}),
    ] {
        assert!(e.try_call("book.update", change).is_err());
        assert_eq!(
            e.ws().observe(&format!("book:{a}")).unwrap().version,
            valid_version
        );
    }
    e.call(
        "book.update",
        json!({"book":a,"word_target":null,"daily_word_target":null}),
    );
    let get = e.out("book.get", json!({"book":a}));
    assert_eq!(get["word_target"], dr_model::book::DEFAULT_WORD_TARGET);
    assert_eq!(
        get["daily_word_target"],
        dr_model::book::DEFAULT_DAILY_WORD_TARGET
    );
    e.ws()
        .run::<legacy::BookUpdate>(
            &Actor::User,
            legacy::BookUpdateIn {
                book: a.clone(),
                name: None,
                summary: Some("Typed update".into()),
                word_target: None,
                daily_word_target: None,
            },
        )
        .unwrap();
    assert_eq!(
        e.out("book.get", json!({"book":a}))["summary"],
        "Typed update"
    );
    assert_eq!(
        e.ws().observe(&format!("book:{b}")).unwrap().value,
        other.value
    );
    assert_eq!(
        e.ws().observe(&format!("book:{b}")).unwrap().version,
        other.version
    );
}

#[test]
fn v3_recent_preserves_modules_retained_pages_locality_and_cross_book_purge() {
    let mut e = env();
    let a = project(&e);
    let b = project(&e);
    let parent = root(&e, &a);
    e.call("entry_template.put_module",json!({"book":a,"template":"tpl-chapter","module":{"id":"second-prose","kind":"prose","name":"Second prose"}}));
    let entry = chapter(&e, &a, &parent, "Synthetic module page");
    e.call("module.set_prose",json!({"book":a,"owner":entry,"module":"second-prose","paragraphs":[{"text":"Retained synthetic passage"}]}));
    let material = e.out(
        "material.create",
        json!({"book":a,"kind":"text","title":"Synthetic note","text":"Synthetic note"}),
    )["id"]
        .clone();
    let other_entry = chapter(&e, &b, &root(&e, &b), "Other book");
    let sentinel=serde_json::to_string_pretty(&json!([{ "book":b,"target":{"kind":"node","id":"synthetic-old-page"},"used_ms":1,"future_field":"preserve" }])).unwrap();
    e.ws()
        .library()
        .local_write(|tx| tx.set_state("ws", "recent", &sentinel, None))
        .unwrap();
    let before_a = e.ws().observe(&format!("book:{a}")).unwrap();
    let before_b = e.ws().observe(&format!("book:{b}")).unwrap();
    let first = json!({"kind":"entry","id":entry,"module":"mod-prose"});
    let second = json!({"kind":"entry","id":entry,"module":"second-prose"});
    let whole = json!({"kind":"entry","id":entry});
    let note = json!({"kind":"material","id":material});
    let about = json!({"kind":"entry","id":parent,"module":"about"});
    for target in [&first, &second, &whole, &note, &about, &first] {
        touch(&e, &a, target.clone());
    }
    touch(
        &e,
        &b,
        json!({"kind":"entry","id":other_entry,"module":"mod-prose"}),
    );
    let list = recent_list(&e, &a);
    assert_eq!(list.as_array().unwrap().len(), 5);
    assert_eq!(list[0]["target"], first);
    assert_eq!(list[1]["target"], about);
    assert_eq!(list[4]["target"], second);
    let typed = e
        .ws()
        .run::<recent::RecentList>(
            &Actor::User,
            recent::RecentListIn {
                book: a.clone(),
                limit: Some(1),
            },
        )
        .unwrap();
    assert_eq!(typed.output[0].target.module.as_deref(), Some("mod-prose"));
    assert_eq!(typed.output.len(), 1);
    assert_eq!(
        e.ws().observe(&format!("book:{a}")).unwrap().version,
        before_a.version
    );
    assert_eq!(
        e.ws().observe(&format!("book:{b}")).unwrap().version,
        before_b.version
    );
    assert_eq!(
        e.ws()
            .library()
            .local_get("ws", "recent")
            .unwrap()
            .as_deref(),
        Some(sentinel.as_str())
    );
    for target in [
        json!({"kind":"entry","id":other_entry}),
        json!({"kind":"entry","id":entry,"module":"unknown"}),
        json!({"kind":"material","id":material,"module":"mod-prose"}),
        json!({"kind":"book","id":a}),
    ] {
        assert!(
            e.try_call("recent.touch", json!({"book":a,"target":target}))
                .is_err()
        );
    }
    assert_eq!(recent_list(&e, &a), list);
    e.call(
        "book.update",
        json!({"book":a,"summary":"Resume after visit"}),
    );
    e.ws().undo(&Actor::User).unwrap().unwrap();
    touch(&e, &a, first.clone());
    e.ws().redo(&Actor::User).unwrap().unwrap();
    assert_eq!(
        e.out("book.get", json!({"book":a}))["summary"],
        "Resume after visit"
    );
    // Removing a module definition keeps its body and the recent navigation target.
    e.call(
        "entry_template.remove_module",
        json!({"book":a,"template":"tpl-chapter","module":"second-prose"}),
    );
    touch(&e, &a, second.clone());
    assert_eq!(recent_list(&e, &a)[0]["target"], second);
    let retained = recent_list(&e, &a);
    e.call("entry.trash", json!({"book":a,"id":entry}));
    assert!(
        recent_list(&e, &a)
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["target"]["id"] != entry)
    );
    e.call("entry.restore", json!({"book":a,"id":entry}));
    assert_eq!(recent_list(&e, &a), retained);
    let other_list = recent_list(&e, &b);
    e.reopen();
    assert_eq!(recent_list(&e, &a), retained);
    assert_eq!(recent_list(&e, &b), other_list);
    e.call("book.trash", json!({"book":a}));
    e.call("book.purge", json!({"book":a}));
    assert!(
        e.ws()
            .library()
            .local_get(recent::SCOPE, &a)
            .unwrap()
            .is_none()
    );
    assert_eq!(recent_list(&e, &b), other_list);
    assert_eq!(
        e.ws()
            .library()
            .local_get("ws", "recent")
            .unwrap()
            .as_deref(),
        Some(sentinel.as_str())
    );
}

#[test]
fn v3_recent_is_bounded_and_unreadable_state_is_not_overwritten() {
    let e = env();
    let a = project(&e);
    let b = project(&e);
    let parent = root(&e, &a);
    let mut entries = Vec::new();
    for n in 0..12 {
        let id = chapter(&e, &a, &parent, &format!("Synthetic recent {n}"));
        touch(&e, &a, json!({"kind":"entry","id":id}));
        entries.push(id);
    }
    let list = recent_list(&e, &a);
    assert_eq!(list.as_array().unwrap().len(), 10);
    assert_eq!(list[0]["target"]["id"], entries[11]);
    assert_eq!(list[9]["target"]["id"], entries[2]);
    let bad = "{broken v3 local state";
    e.ws()
        .library()
        .local_write(|tx| tx.set_state(recent::SCOPE, &a, bad, Some(&a)))
        .unwrap();
    assert!(e.try_call("recent.list", json!({"book":a})).is_err());
    assert!(
        e.try_call(
            "recent.touch",
            json!({"book":a,"target":{"kind":"entry","id":entries[0]}})
        )
        .is_err()
    );
    assert_eq!(
        e.ws()
            .library()
            .local_get(recent::SCOPE, &a)
            .unwrap()
            .as_deref(),
        Some(bad)
    );
    touch(&e, &b, json!({"kind":"entry","id":root(&e,&b)}));
    assert_eq!(recent_list(&e, &b).as_array().unwrap().len(), 1);
}
