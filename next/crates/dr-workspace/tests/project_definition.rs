//! The project definition (`kernel-v5.md` §2, §3, §5): projects made from
//! one template, the guards and undo of project writes, the book start that
//! cannot be read, and two devices editing the definition at once.
mod common;
use common::*;
use dr_workspace::{Actor, RecordKey, WritePreconditions, WsError};
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// A small synthetic project template: a folder with a card under it, the
/// folder as the book start, a tab and a view's lane.
fn cards_template() -> Value {
    json!({
        "project": {
            "source": {"id": "synthetic-cards", "version": 1},
            "agent": {"name": "合成卡片", "description": "合成说明", "instructions": "按主题归档"},
            "book": {"root": {"kind": "entry", "entry": "seed-folder"}},
            "tabs": [
                {"id": "seed-tab", "name": "卡片", "mount": {"kind": "entry", "entry": "seed-folder"}}
            ]
        },
        "templates": [
            {
                "id": "tpl-folder",
                "name": "文件夹",
                "level": true,
                "modules": [
                    {"id": "mod-about", "kind": "prose", "name": "说明", "config": {"in_book": false}}
                ]
            },
            {
                "id": "tpl-card",
                "name": "卡片",
                "modules": [
                    {"id": "mod-prose", "kind": "prose", "name": "正文"}
                ]
            }
        ],
        "entries": [
            {"id": "seed-folder", "title": "全部卡片", "template": "tpl-folder", "level": true},
            {"id": "seed-card", "parent": "seed-folder", "title": "第一张", "template": "tpl-card"}
        ],
        "views": [
            {"id": "seed-view", "name": "排列", "lanes": [{"entry": "seed-folder"}]}
        ]
    })
}

fn create_from(e: &Env, name: &str, template: &Value) -> String {
    e.out(
        "project.create",
        json!({"name": name, "template": template}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn entry_ids(e: &Env, b: &str) -> BTreeSet<String> {
    e.out(
        "entry.list",
        json!({"book": b, "all": true, "trashed": true}),
    )
    .as_array()
    .unwrap()
    .iter()
    .map(|x| x["id"].as_str().unwrap().to_owned())
    .collect()
}

fn entry_titled(e: &Env, b: &str, title: &str) -> String {
    e.out("entry.list", json!({"book": b, "all": true}))
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["title"] == title)
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn prose(e: &Env, b: &str, owner: &str) -> String {
    e.out(
        "module.read_prose",
        json!({"book": b, "owner": owner, "module": "mod-prose"}),
    )["paragraphs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["text"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>()
        .join("\n")
}

/// DX 3: every project made from one template gets its own entry, view and
/// tab ids, so the two never share a body document and purging one leaves
/// the other's text alone.
#[test]
fn two_projects_from_one_template_share_no_entry_or_document() {
    let e = env();
    let template = cards_template();
    let a = create_from(&e, "甲", &template);
    let b = create_from(&e, "乙", &template);

    let (ids_a, ids_b) = (entry_ids(&e, &a), entry_ids(&e, &b));
    assert_eq!(ids_a.len(), 2);
    assert!(ids_a.is_disjoint(&ids_b), "{ids_a:?} {ids_b:?}");
    for id in ids_a.iter().chain(&ids_b) {
        assert!(
            !id.starts_with("seed-"),
            "a seed id was copied as it is: {id}"
        );
    }
    let docs = |b: &str| -> BTreeSet<String> {
        e.ws()
            .library()
            .docs(Some(b), None)
            .unwrap()
            .into_iter()
            .filter(|d| d.doc_id.starts_with("body:"))
            .map(|d| d.doc_id)
            .collect()
    };
    let (docs_a, docs_b) = (docs(&a), docs(&b));
    assert_eq!(docs_a.len(), 2, "{docs_a:?}");
    assert!(docs_a.is_disjoint(&docs_b), "{docs_a:?} {docs_b:?}");

    // References follow the fresh ids: the book start, the tab, the lane.
    for book in [&a, &b] {
        let folder = entry_titled(&e, book, "全部卡片");
        let card = entry_titled(&e, book, "第一张");
        let got = e.out("entry.get", json!({"book": book, "id": card}));
        assert_eq!(got["parent"], folder);
        let project = e.out("project.get", json!({"book": book}));
        assert_eq!(
            project["book"]["root"],
            json!({"kind": "entry", "entry": folder})
        );
        assert_eq!(project["book_root_valid"], true);
        assert_eq!(project["tabs"][0]["mount"]["entry"], folder);
        assert_ne!(project["tabs"][0]["id"], "seed-tab");
        let views = e.out("timeline_view.list", json!({"book": book}));
        assert_ne!(views[0]["id"], "seed-view");
        assert_eq!(views[0]["lanes"][0]["entry"], folder);
    }

    // The text of one stays when the other is purged.
    let card_a = entry_titled(&e, &a, "第一张");
    let card_b = entry_titled(&e, &b, "第一张");
    e.call(
        "module.set_prose",
        json!({"book": a, "owner": card_a, "module": "mod-prose", "paragraphs": [{"text": "甲的正文。"}]}),
    );
    e.call(
        "module.set_prose",
        json!({"book": b, "owner": card_b, "module": "mod-prose", "paragraphs": [{"text": "乙的正文。"}]}),
    );
    e.call("book.trash", json!({"book": b}));
    e.call("book.purge", json!({"book": b}));
    assert_eq!(prose(&e, &a, &card_a), "甲的正文。");
}

/// DX 4: a guarded writer that read the book settings (`project/book`) may
/// change the book start and the word targets, by command and by history;
/// one holding a read from before someone else's change is refused.
#[test]
fn a_writer_that_read_the_book_settings_may_change_them_and_a_stale_one_may_not() {
    let e = env();
    let b = e.book();
    let ideas = acceptance::novel_root(e.ws(), &b, "tpl-ideas");
    let ms = acceptance::novel_root(e.ws(), &b, "tpl-manuscript");
    let doc = format!("book:{b}");
    let agent = Actor::agent("dx-guard", 1, "project.update");
    let read = || {
        WritePreconditions::from_records(
            e.ws()
                .observe_records(&doc, &[RecordKey::record("project", "book")])
                .unwrap(),
        )
    };
    let at = e.out("entry_history.version", json!({"book": b}))["version"].clone();
    e.ws()
        .call_guarded(
            &agent,
            "project.update",
            json!({"book": b, "root": {"kind": "entry", "entry": ideas}}),
            read(),
        )
        .unwrap();
    e.ws()
        .call_guarded(
            &agent,
            "project.update",
            json!({"book": b, "word_target": 1234, "daily_word_target": 56}),
            read(),
        )
        .unwrap();
    let project = e.out("project.get", json!({"book": b}));
    assert_eq!(project["book"]["root"]["entry"], ideas);
    assert_eq!(project["book"]["word_target"], 1234);
    assert_eq!(project["book"]["daily_word_target"], 56);

    // Restoring the start from history, guarded by the same read.
    e.ws()
        .call_guarded(
            &agent,
            "entry_history.restore",
            json!({"book": b, "at": at, "targets": [{"collection": "project", "id": "book/root"}]}),
            read(),
        )
        .unwrap();
    assert_eq!(
        e.out("project.get", json!({"book": b}))["book"]["root"]["entry"],
        ms
    );

    // A read taken before the author's change is stale.
    let stale = read();
    e.call("project.update", json!({"book": b, "word_target": 999}));
    match e.ws().call_guarded(
        &agent,
        "project.update",
        json!({"book": b, "daily_word_target": 77}),
        stale,
    ) {
        Err(WsError::Conflict(m)) => assert!(m.contains("stale observation"), "{m}"),
        other => panic!("expected a stale observation, got {other:?}"),
    }
    let project = e.out("project.get", json!({"book": b}));
    assert_eq!(project["book"]["word_target"], 999);
    assert_eq!(project["book"]["daily_word_target"], 56);
}

/// DX 5: a book start that cannot be read (restored from history to a
/// version when the book was off, so only the targets are left) reads as
/// no book content, not as the whole project; nothing picks one for the
/// author.
#[test]
fn a_book_start_that_cannot_be_read_reads_as_no_book_content() {
    let e = env();
    let b = e.book();
    let ms = acceptance::novel_root(e.ws(), &b, "tpl-manuscript");
    let ideas = acceptance::novel_root(e.ws(), &b, "tpl-ideas");
    e.out(
        "entry.create",
        json!({"book": b, "parent": ms, "template": "tpl-chapter", "title": "第一章", "bodies": {"mod-prose": "正文。"}}),
    );
    e.out(
        "entry.create",
        json!({"book": b, "parent": ideas, "template": "tpl-idea", "title": "一个构想", "bodies": {"mod-prose": "构想。"}}),
    );
    e.call("project.update", json!({"book": b, "has_book": false}));
    let off = e.out("entry_history.version", json!({"book": b}))["version"].clone();
    e.call(
        "project.update",
        json!({"book": b, "has_book": true, "root": {"kind": "entry", "entry": ms}, "word_target": 5000}),
    );
    let on = e.out("book.sequence", json!({"book": b}));
    assert_eq!(on["root_valid"], true);
    assert_eq!(on["entries"].as_array().unwrap().len(), 2);

    e.call(
        "entry_history.restore",
        json!({"book": b, "at": off, "targets": [{"collection": "project", "id": "book/root"}]}),
    );
    let project = e.out("project.get", json!({"book": b}));
    assert!(!project["book"].is_null(), "the book is still on");
    assert_eq!(project["book"]["word_target"], 5000);
    assert_eq!(project["book_root_valid"], false);
    let seq = e.out("book.sequence", json!({"book": b}));
    assert_eq!(seq["has_book"], true);
    assert_eq!(seq["root_valid"], false);
    assert_eq!(seq["entries"], json!([]), "not the whole project");

    // Undo brings the start back; the author can also pick one again.
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert_eq!(
        e.out("book.sequence", json!({"book": b}))["root_valid"],
        true
    );
}

fn tabs(e: &Env, b: &str) -> Vec<(String, String)> {
    e.out("project.get", json!({"book": b}))["tabs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| {
            (
                t["id"].as_str().unwrap().to_owned(),
                t["name"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

/// DX 7: creating, renaming, moving and removing a tab, and changing the
/// book start, are each one undo step.
#[test]
fn every_tab_write_and_the_book_start_undo_in_one_step() {
    let e = env();
    let b = e.book();
    let undo = || e.ws().undo(&Actor::User).unwrap().unwrap();
    let before = tabs(&e, &b);
    assert_eq!(before.len(), 4);

    let made = e.out(
        "tab.put",
        json!({"book": b, "name": "全项目", "mount": {"kind": "root"}}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(tabs(&e, &b).len(), 5);
    undo();
    assert_eq!(tabs(&e, &b), before, "creating");

    e.call(
        "tab.put",
        json!({"book": b, "id": before[0].0, "name": "正文"}),
    );
    assert_eq!(tabs(&e, &b)[0].1, "正文");
    undo();
    assert_eq!(tabs(&e, &b), before, "renaming");

    e.call(
        "tab.move",
        json!({"book": b, "id": before[0].0, "place": "last"}),
    );
    assert_eq!(tabs(&e, &b)[3].0, before[0].0);
    undo();
    assert_eq!(tabs(&e, &b), before, "moving");

    e.call("tab.remove", json!({"book": b, "id": before[1].0}));
    assert_eq!(tabs(&e, &b).len(), 3);
    undo();
    assert_eq!(tabs(&e, &b), before, "removing");

    let root = e.out("project.get", json!({"book": b}))["book"]["root"].clone();
    e.call(
        "project.update",
        json!({"book": b, "root": {"kind": "root"}}),
    );
    undo();
    assert_eq!(
        e.out("project.get", json!({"book": b}))["book"]["root"],
        root,
        "the book start"
    );
    let _ = made;
}

/// Every stored document of `from` imported into `to`, the book first.
fn sync(from: &Env, to: &Env) {
    use loro::ExportMode;
    let mut docs = from.ws().library().docs(None, None).unwrap();
    docs.sort_by_key(|d| (d.kind != "book", d.doc_id.clone()));
    for d in docs {
        if from.ws().library().head(&d.doc_id).unwrap().is_none() {
            continue;
        }
        let bytes = from
            .ws()
            .library()
            .load_copy(&d.doc_id)
            .unwrap()
            .export(ExportMode::all_updates())
            .unwrap();
        to.ws()
            .import_remote(
                &d.doc_id,
                Some((&d.kind, d.book_id.as_deref().unwrap_or(""))),
                bytes,
                &Actor::Sync,
            )
            .unwrap();
    }
}

/// DX 7: two devices change the project definition and the tabs at once;
/// after they merge, both devices' changes are there, on both.
#[test]
fn two_devices_editing_the_definition_and_the_tabs_keep_both_sides() {
    let (a, z) = (env(), env());
    let b = a.book();
    sync(&a, &z);
    let first = tabs(&a, &b);
    let (t0, t1) = (first[0].0.clone(), first[1].0.clone());
    // A: a word target, then renames the first tab and adds one.
    a.call("project.update", json!({"book": b, "word_target": 1000}));
    a.call("tab.put", json!({"book": b, "id": t0, "name": "正文"}));
    let added = a.out(
        "tab.put",
        json!({"book": b, "name": "全项目", "mount": {"kind": "root"}}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    // Z, at the same time: moves that first tab last, removes another,
    // writes new guidance and a daily target.
    z.call("tab.move", json!({"book": b, "id": t0, "place": "last"}));
    z.call("tab.remove", json!({"book": b, "id": t1}));
    z.call(
        "project.update",
        json!({"book": b, "agent": {"name": "合成", "description": "", "instructions": "先读大纲。"}, "daily_word_target": 50}),
    );
    sync(&a, &z);
    sync(&z, &a);
    for dev in [&a, &z] {
        let project = dev.out("project.get", json!({"book": b}));
        assert_eq!(project["book"]["word_target"], 1000);
        assert_eq!(project["book"]["daily_word_target"], 50);
        assert_eq!(project["agent"]["instructions"], "先读大纲。");
        let now = tabs(dev, &b);
        assert!(now.iter().all(|(id, _)| id != &t1), "removed on Z: {now:?}");
        assert!(
            now.iter().any(|(id, _)| id == &added),
            "added on A: {now:?}"
        );
        let renamed = now.iter().position(|(id, _)| id == &t0).unwrap();
        assert_eq!(now[renamed].1, "正文", "renamed on A: {now:?}");
        let last_before_added = now
            .iter()
            .filter(|(id, _)| id != &added)
            .next_back()
            .unwrap();
        assert_eq!(last_before_added.0, t0, "moved last on Z: {now:?}");
    }
}

/// DX 8: the home settings save the project's name, profile and word
/// targets as one write: one undo takes all of it back, and a refused
/// write saves none of it.
#[test]
fn name_profile_and_targets_are_one_write() {
    let e = env();
    let b = e.book();
    let book = |e: &Env| e.out("book.get", json!({"book": b}));
    let before = book(&e);
    e.call(
        "project.update",
        json!({"book": b, "name": " 新名字 ", "summary": "合成简介", "word_target": 4321, "daily_word_target": 12}),
    );
    let after = book(&e);
    assert_eq!(
        (
            &after["name"],
            &after["summary"],
            &after["word_target"],
            &after["daily_word_target"]
        ),
        (
            &json!("新名字"),
            &json!("合成简介"),
            &json!(4321),
            &json!(12)
        )
    );
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert_eq!(book(&e), before, "one undo takes all of it back");

    // Without a book there are no targets: the whole write is refused.
    e.call("project.update", json!({"book": b, "has_book": false}));
    assert!(
        e.try_call(
            "project.update",
            json!({"book": b, "name": "又一个", "word_target": 10}),
        )
        .is_err()
    );
    assert_eq!(book(&e)["name"], before["name"], "nothing was saved");
}
