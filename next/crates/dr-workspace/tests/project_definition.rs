//! The project definition (`kernel-v5.md` §2, §3, §5): projects made from
//! one template, the guards and undo of project writes, the book start that
//! cannot be read, and two devices editing the definition at once.
mod common;
use common::*;
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
    e.out("entry.list", json!({"book": b, "all": true, "trashed": true}))
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
        assert!(!id.starts_with("seed-"), "a seed id was copied as it is: {id}");
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
