//! The project definition (`kernel-v5.md` §2, §3, §5): projects made from
//! one template, the guards and undo of project writes, and two devices
//! editing the definition at once. The book has no start (DW).
mod common;
use common::*;
use dr_workspace::{Actor, RecordKey, WritePreconditions, WsError};
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// A small synthetic project template: a folder with a card under it, a
/// tab and a view's lane. Its book still names a start and its tab a
/// `name`, as seeds written before the book lost its start and tabs their
/// names do: both are read and ignored.
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
                // A lane of the template's view takes entries from
                // elsewhere (DV, 2026-11-16).
                "settings": {"accept": true},
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

    // References follow the fresh ids: the tab, the lane. The old start is
    // not kept.
    for book in [&a, &b] {
        let folder = entry_titled(&e, book, "全部卡片");
        let card = entry_titled(&e, book, "第一张");
        let got = e.out("entry.get", json!({"book": book, "id": card}));
        assert_eq!(got["parent"], folder);
        let project = e.out("project.get", json!({"book": book}));
        assert!(project["book"].is_object(), "{project}");
        assert!(project["book"].get("root").is_none(), "{project}");
        // 「全部」 is added first (the template has no root tab), with its
        // fixed id; the template's tab follows, with a fresh id and no name.
        assert_eq!(project["tabs"].as_array().unwrap().len(), 2);
        assert_eq!(project["tabs"][0]["id"], "tab-all");
        assert_eq!(project["tabs"][0]["mount"], json!({"kind": "root"}));
        assert_eq!(project["tabs"][1]["mount"]["entry"], folder);
        assert_ne!(project["tabs"][1]["id"], "seed-tab");
        assert!(project["tabs"][1].get("name").is_none(), "{project}");
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
/// change the word targets, by command and by history; one holding a read
/// from before someone else's change is refused.
#[test]
fn a_writer_that_read_the_book_settings_may_change_them_and_a_stale_one_may_not() {
    let e = env();
    let b = e.book();
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
            json!({"book": b, "word_target": 1234, "daily_word_target": 56}),
            read(),
        )
        .unwrap();
    let project = e.out("project.get", json!({"book": b}));
    assert_eq!(project["book"]["word_target"], 1234);
    assert_eq!(project["book"]["daily_word_target"], 56);

    // Restoring a target from history, guarded by the same read.
    e.ws()
        .call_guarded(
            &agent,
            "entry_history.restore",
            json!({"book": b, "at": at, "targets": [{"collection": "project", "id": "book/word_target"}]}),
            read(),
        )
        .unwrap();
    assert_ne!(
        e.out("project.get", json!({"book": b}))["book"]["word_target"],
        1234
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

/// DW: the book has no start, so history has none to bring back: the key an
/// older book stored its start under is no history target.
#[test]
fn an_old_book_start_is_no_history_target() {
    let e = env();
    let b = e.book();
    let at = e.out("entry_history.version", json!({"book": b}))["version"].clone();
    e.call("project.update", json!({"book": b, "word_target": 5000}));
    match e.try_call(
        "entry_history.restore",
        json!({"book": b, "at": at, "targets": [{"collection": "project", "id": "book/root"}]}),
    ) {
        Err(WsError::Invalid(m)) => assert!(m.contains("project history key"), "{m}"),
        other => panic!("expected a refusal, got {other:?}"),
    }
    assert_eq!(
        e.out("project.get", json!({"book": b}))["book"]["word_target"],
        5000
    );
}

/// The tabs `project.get` shows: id and mount, in order.
fn tabs(e: &Env, b: &str) -> Vec<(String, Value)> {
    e.out("project.get", json!({"book": b}))["tabs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| (t["id"].as_str().unwrap().to_owned(), t["mount"].clone()))
        .collect()
}

fn refused(e: &Env, name: &str, input: Value, invariant: &str) -> String {
    match e.try_call(name, input.clone()) {
        Err(WsError::Violation(v)) => {
            assert_eq!(v.invariant, invariant, "{name} {input}");
            v.detail
        }
        other => panic!("{name} {input}: expected {invariant}, got {other:?}"),
    }
}

fn root_entry(e: &Env, b: &str, title: &str) -> String {
    entry_titled(e, b, title)
}

/// DZ: a new writing project's tabs are 「全部」 (the root, under its fixed
/// id), 书稿, 构想, 要素, 故事线, in that order; none has a name, and no tab is
/// chosen yet.
#[test]
fn a_new_writing_project_has_all_first_then_four_tabs() {
    let e = env();
    let b = e.book();
    let project = e.out("project.get", json!({"book": b}));
    let mounts: Vec<Value> = tabs(&e, &b).into_iter().map(|(_, m)| m).collect();
    let entry = |title: &str| json!({"kind": "entry", "entry": root_entry(&e, &b, title)});
    assert_eq!(
        mounts,
        [
            json!({"kind": "root"}),
            entry("书稿"),
            entry("构想"),
            entry("要素"),
            entry("故事线"),
        ]
    );
    assert_eq!(project["tabs"][0]["id"], "tab-all");
    for t in project["tabs"].as_array().unwrap() {
        assert!(t.get("name").is_none(), "{t}");
        assert_eq!(t["mount_valid"], true, "{t}");
    }
    assert!(project["selected_tab"].is_null());
}

/// DZ: one thing is mounted on one tab. Mounting an entry that has a tab
/// again is refused, naming that tab; so is mounting the root, which
/// 「全部」 has. 「全部」 cannot be removed; another tab can, in one undo step.
#[test]
fn a_thing_is_mounted_on_one_tab_and_all_stays() {
    let e = env();
    let b = e.book();
    let undo = || e.ws().undo(&Actor::User).unwrap().unwrap();
    let before = tabs(&e, &b);
    let ms = root_entry(&e, &b, "书稿");
    let detail = refused(
        &e,
        "tab.put",
        json!({"book": b, "mount": {"kind": "entry", "entry": ms}}),
        "TAB-MOUNT-ONCE",
    );
    assert!(detail.contains(&before[1].0), "{detail}");
    let detail = refused(
        &e,
        "tab.put",
        json!({"book": b, "mount": {"kind": "root"}}),
        "TAB-MOUNT-ONCE",
    );
    assert!(detail.contains("tab-all"), "{detail}");
    refused(
        &e,
        "tab.remove",
        json!({"book": b, "id": "tab-all"}),
        "TAB-ROOT-ALWAYS",
    );
    assert_eq!(tabs(&e, &b), before);

    // A new tab is new: `tab.put` takes no id and no name, and gives back
    // only the new id.
    let made = e.out(
        "tab.put",
        json!({"book": b, "mount": {"kind": "book"}, "place": "first"}),
    );
    assert_eq!(made.as_object().unwrap().len(), 1, "{made}");
    let made = made["id"].as_str().unwrap().to_owned();
    assert_eq!(tabs(&e, &b)[0].0, made);
    refused(
        &e,
        "tab.put",
        json!({"book": b, "mount": {"kind": "book"}}),
        "TAB-MOUNT-ONCE",
    );
    e.call("tab.remove", json!({"book": b, "id": made}));
    assert_eq!(tabs(&e, &b), before);
    undo();
    assert_eq!(tabs(&e, &b)[0].0, made);
    undo();
    assert_eq!(tabs(&e, &b), before);
}

/// DX 7: creating, moving and removing a tab are each one undo step. (Tabs
/// have no names since DZ: there is no renaming; the book has no start
/// since DW.)
#[test]
fn every_tab_write_undoes_in_one_step() {
    let e = env();
    let b = e.book();
    let undo = || e.ws().undo(&Actor::User).unwrap().unwrap();
    let before = tabs(&e, &b);
    assert_eq!(before.len(), 5);

    e.call("tab.put", json!({"book": b, "mount": {"kind": "book"}}));
    assert_eq!(tabs(&e, &b).len(), 6);
    undo();
    assert_eq!(tabs(&e, &b), before, "creating");

    e.call(
        "tab.move",
        json!({"book": b, "id": before[1].0, "place": "last"}),
    );
    assert_eq!(tabs(&e, &b)[4].0, before[1].0);
    undo();
    assert_eq!(tabs(&e, &b), before, "moving");

    e.call("tab.remove", json!({"book": b, "id": before[2].0}));
    assert_eq!(tabs(&e, &b).len(), 4);
    undo();
    assert_eq!(tabs(&e, &b), before, "removing");
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
    let (t0, t1) = (first[1].0.clone(), first[2].0.clone());
    // A: a word target, then adds a tab.
    a.call("project.update", json!({"book": b, "word_target": 1000}));
    let added = a.out("tab.put", json!({"book": b, "mount": {"kind": "book"}}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    // Z, at the same time: moves the first tab after 「全部」 last, removes
    // another, writes new guidance and a daily target.
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
        let last_before_added = now.iter().rfind(|(id, _)| id != &added).unwrap();
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

/// One commit written straight on the holder of `book:<b>`, as another
/// device's sync would bring it (a book from before DZ, say).
fn raw_book_write(e: &Env, b: &str, f: impl FnOnce(&loro::LoroDoc) + Send + 'static) {
    e.ws()
        .library()
        .open_doc(&format!("book:{b}"), dr_store::OpenDoc::Existing)
        .unwrap()
        .write(dr_store::Origin::Sync, f)
        .unwrap();
}

/// The tab records stored in the book, sorted (「全部」 only when stored).
fn stored_tabs(e: &Env, b: &str) -> Vec<(String, Value)> {
    let book = dr_model::id::BookId::parse(b).unwrap();
    e.ws()
        .read_book_v3(b, move |doc, _| {
            Ok(dr_doc::v3::BorrowedBookV3::new(doc, &book)
                .unwrap()
                .view()
                .stored_tabs()
                .into_iter()
                .map(|t| (t.id.to_string(), serde_json::to_value(&t.mount).unwrap()))
                .collect())
        })
        .unwrap()
}

/// A book from before DZ: no tab stored at the root.
fn without_all(e: &Env, b: &str) {
    let book = dr_model::id::BookId::parse(b).unwrap();
    raw_book_write(e, b, move |d| {
        dr_doc::v3::BorrowedBookV3::new(d, &book)
            .unwrap()
            .txn()
            .project()
            .remove_tab(&dr_model::v3::all_tab_id())
            .unwrap();
    });
}

/// DZ: a book with no tab at the root reads 「全部」 first, under its fixed
/// id, without storing it; `tab.move` stores it. Two devices that each move
/// it write one record, and both read one 「全部」 in the same place.
#[test]
fn a_book_without_all_reads_it_first_and_stores_it_once_moved() {
    let (a, z) = (env(), env());
    let b = a.book();
    without_all(&a, &b);
    let shown = tabs(&a, &b);
    assert_eq!(shown.len(), 5);
    assert_eq!(shown[0], ("tab-all".to_owned(), json!({"kind": "root"})));
    assert_eq!(stored_tabs(&a, &b), shown[1..].to_vec(), "only read in");
    sync(&a, &z);
    assert_eq!(tabs(&z, &b), shown, "every device reads the same 「全部」");

    // Moving it stores it; undo takes it back to being read in.
    a.call(
        "tab.move",
        json!({"book": b, "id": "tab-all", "place": "last"}),
    );
    assert_eq!(tabs(&a, &b)[4].0, "tab-all");
    assert_eq!(stored_tabs(&a, &b).len(), 5);
    a.ws().undo(&Actor::User).unwrap().unwrap();
    assert_eq!(tabs(&a, &b), shown);
    assert_eq!(stored_tabs(&a, &b).len(), 4);

    // Both devices move it at once: one record, one 「全部」.
    a.call(
        "tab.move",
        json!({"book": b, "id": "tab-all", "place": "last"}),
    );
    z.call(
        "tab.move",
        json!({"book": b, "id": "tab-all", "place": {"after": shown[1].0}}),
    );
    sync(&a, &z);
    sync(&z, &a);
    let (on_a, on_z) = (tabs(&a, &b), tabs(&z, &b));
    assert_eq!(on_a, on_z);
    assert_eq!(on_a.len(), 5);
    assert_eq!(
        on_a.iter().filter(|(_, m)| m["kind"] == "root").count(),
        1,
        "{on_a:?}"
    );
    let stored = stored_tabs(&a, &b);
    assert_eq!(
        stored.iter().filter(|(id, _)| id == "tab-all").count(),
        1,
        "{stored:?}"
    );
    assert_eq!(stored.len(), 5);
}

/// DZ: two devices mount the same entry at once; after they merge, both read
/// one tab for it, the first by `(pos, id)`. Removing it removes the other
/// device's record too, so nothing takes its place; one undo brings both
/// back.
#[test]
fn two_devices_mounting_one_entry_read_one_tab() {
    let (a, z) = (env(), env());
    let b = a.book();
    let ms = root_entry(&a, &b, "书稿");
    let folder = a.out(
        "entry.create",
        json!({"book": b, "parent": ms, "title": "卷一", "template": "tpl-group"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    sync(&a, &z);
    let mount = json!({"kind": "entry", "entry": folder});
    let on_a = a.out("tab.put", json!({"book": b, "mount": mount}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let on_z = z.out("tab.put", json!({"book": b, "mount": mount}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    sync(&a, &z);
    sync(&z, &a);
    let merged = tabs(&a, &b);
    assert_eq!(merged, tabs(&z, &b));
    let with = |list: &[(String, Value)]| -> Vec<String> {
        list.iter()
            .filter(|(_, m)| *m == mount)
            .map(|(id, _)| id.clone())
            .collect()
    };
    let kept = with(&merged);
    assert_eq!(kept.len(), 1, "{merged:?}");
    assert!(kept[0] == on_a || kept[0] == on_z);
    assert_eq!(with(&stored_tabs(&a, &b)).len(), 2, "both records stay");
    // A third device's write is refused like any repeat.
    refused(
        &a,
        "tab.put",
        json!({"book": b, "mount": mount}),
        "TAB-MOUNT-ONCE",
    );

    a.call("tab.remove", json!({"book": b, "id": kept[0]}));
    assert!(with(&tabs(&a, &b)).is_empty(), "nothing takes its place");
    assert!(with(&stored_tabs(&a, &b)).is_empty());
    a.ws().undo(&Actor::User).unwrap().unwrap();
    assert_eq!(with(&tabs(&a, &b)), kept);
    assert_eq!(with(&stored_tabs(&a, &b)).len(), 2);
}

/// DZ: a tab stored with an old `name` reads as usual, without it, and
/// moving it keeps working.
#[test]
fn a_tab_stored_with_an_old_name_reads_as_usual() {
    let e = env();
    let b = e.book();
    let before = tabs(&e, &b);
    let first = before[1].0.clone();
    let id = first.clone();
    raw_book_write(&e, &b, move |d| {
        let tabs = d.get_map("project").ensure_mergeable_map("tabs").unwrap();
        tabs.ensure_mergeable_map(&id)
            .unwrap()
            .insert("name", "旧的名字")
            .unwrap();
    });
    let project = e.out("project.get", json!({"book": b}));
    assert_eq!(tabs(&e, &b), before);
    assert!(project["tabs"][1].get("name").is_none(), "{project}");
    e.call("tab.move", json!({"book": b, "id": first, "place": "last"}));
    assert_eq!(tabs(&e, &b)[4].0, first);
}

/// DZ: the tab the project is on. `tab.select` takes a live tab (「全部」
/// read in included) and refuses one that is not there; `project.get` gives
/// it as `selected_tab`; a removed tab reads as none, and comes back with
/// the tab.
#[test]
fn the_selected_tab_is_a_live_tab_and_a_gone_one_reads_as_none() {
    let e = env();
    let b = e.book();
    let selected = || e.out("project.get", json!({"book": b}))["selected_tab"].clone();
    assert!(selected().is_null());
    match e.try_call("tab.select", json!({"book": b, "id": "tab-missing"})) {
        Err(err) => assert_eq!(err.code(), "not_found", "{err}"),
        other => panic!("{other:?}"),
    }
    let ideas = tabs(&e, &b)[2].0.clone();
    e.call("tab.select", json!({"book": b, "id": ideas}));
    assert_eq!(selected(), json!(ideas));
    e.call("tab.remove", json!({"book": b, "id": ideas}));
    assert!(selected().is_null(), "a removed tab reads as none");
    match e.try_call("tab.select", json!({"book": b, "id": ideas})) {
        Err(err) => assert_eq!(err.code(), "not_found", "{err}"),
        other => panic!("{other:?}"),
    }
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert_eq!(selected(), json!(ideas), "the tab came back");

    // 「全部」 read in, not stored, can be chosen.
    without_all(&e, &b);
    e.call("tab.select", json!({"book": b, "id": "tab-all"}));
    assert_eq!(selected(), json!("tab-all"));
    assert!(stored_tabs(&e, &b).iter().all(|(id, _)| id != "tab-all"));
}

/// DZ: the tab the project is on follows the project: chosen on one device,
/// it is the one on the other; chosen on both at once, both agree after
/// they merge.
#[test]
fn two_devices_merged_are_on_the_same_tab() {
    let (a, z) = (env(), env());
    let b = a.book();
    sync(&a, &z);
    let shown = tabs(&a, &b);
    a.call("tab.select", json!({"book": b, "id": shown[3].0}));
    sync(&a, &z);
    let selected = |dev: &Env| dev.out("project.get", json!({"book": b}))["selected_tab"].clone();
    assert_eq!(selected(&z), json!(shown[3].0));

    a.call("tab.select", json!({"book": b, "id": shown[1].0}));
    z.call("tab.select", json!({"book": b, "id": shown[4].0}));
    sync(&a, &z);
    sync(&z, &a);
    let on_a = selected(&a);
    assert_eq!(on_a, selected(&z));
    assert!(
        on_a == json!(shown[1].0) || on_a == json!(shown[4].0),
        "{on_a}"
    );
}

/// T2: turning the book off keeps its two targets in the project; turning
/// it on again, after the project was opened anew too, brings them back.
/// While it is off nothing reads them. Each switch is one undo step, and a
/// target changed on another device while the book was off is there when
/// it is turned on.
#[test]
fn turning_the_book_off_keeps_its_targets_for_when_it_is_on_again() {
    let mut e = env();
    let b = e.book();
    let targets = |e: &Env| {
        let p = e.out("project.get", json!({"book": b}));
        (
            p["book"]["word_target"].clone(),
            p["book"]["daily_word_target"].clone(),
        )
    };
    e.call(
        "project.update",
        json!({"book": b, "word_target": 4321, "daily_word_target": 12}),
    );
    e.call("project.update", json!({"book": b, "has_book": false}));
    let off = e.out("project.get", json!({"book": b}));
    assert!(off["book"].is_null(), "a book turned off reads as none");
    assert_eq!(
        e.out("book.sequence", json!({"book": b}))["has_book"],
        false
    );
    assert!(
        e.try_call("project.update", json!({"book": b, "word_target": 1}))
            .is_err(),
        "no targets are set while the book is off"
    );

    e.reopen();
    assert!(e.out("project.get", json!({"book": b}))["book"].is_null());
    e.call("project.update", json!({"book": b, "has_book": true}));
    assert_eq!(targets(&e), (json!(4321), json!(12)));

    // One undo turns it off again, the next one on, the targets kept.
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert!(e.out("project.get", json!({"book": b}))["book"].is_null());
    e.ws().redo(&Actor::User).unwrap().unwrap();
    assert_eq!(targets(&e), (json!(4321), json!(12)));

    // Two devices: one turns the book off while the other sets a target.
    let z = env();
    sync(&e, &z);
    e.call("project.update", json!({"book": b, "has_book": false}));
    z.call("project.update", json!({"book": b, "word_target": 777}));
    sync(&e, &z);
    sync(&z, &e);
    for dev in [&e, &z] {
        assert!(dev.out("project.get", json!({"book": b}))["book"].is_null());
    }
    e.call("project.update", json!({"book": b, "has_book": true}));
    assert_eq!(targets(&e), (json!(777), json!(12)));
}
