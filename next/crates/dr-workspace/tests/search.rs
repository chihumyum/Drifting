//! `entry.search` and `entry.mentions`: the Agent's ways into a long book's
//! text (`dr_workspace::commands::v3::search`). Chinese phrases through the
//! index's full-text search (three characters and more) and its substring
//! scan (one or two), a phrase across a bold mark, a name and its alias,
//! the trash, pages, and links read from the derived references.

mod common;

use std::collections::HashMap;

use common::*;
use dr_model::prose::InlineStyle;
use dr_workspace::Actor;
use serde_json::{Value, json};

fn agent() -> Actor {
    Actor::agent("s", 1, "c")
}

fn entry(
    e: &Env,
    actor: &Actor,
    b: &str,
    template: &str,
    title: &str,
    text: Option<&str>,
) -> String {
    acceptance::novel_entry_as(actor, e.ws(), b, template, title, text)["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn prose_doc(id: &str) -> String {
    format!("body:{id}/mod-prose")
}

fn search(e: &Env, b: &str, mut args: Value) -> Value {
    args["book"] = json!(b);
    e.out("entry.search", args)
}

fn mentions(e: &Env, b: &str, mut args: Value) -> Value {
    args["book"] = json!(b);
    e.out("entry.mentions", args)
}

/// `(in, entry, module, paragraph)` of each hit, in order.
fn places(found: &Value) -> Vec<(String, String, Option<String>, Option<u64>)> {
    found["hits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| {
            (
                h["in"].as_str().unwrap().to_owned(),
                h["entry"].as_str().unwrap().to_owned(),
                h["module"].as_str().map(str::to_owned),
                h["paragraph"].as_u64(),
            )
        })
        .collect()
}

/// Where each entry is in the entry tree (depth first), as entry.list lists it.
fn tree_rank(e: &Env, b: &str) -> HashMap<String, usize> {
    e.out(
        "entry.list",
        json!({"book": b, "all": true, "trashed": true}),
    )
    .as_array()
    .unwrap()
    .iter()
    .enumerate()
    .map(|(i, x)| (x["id"].as_str().unwrap().to_owned(), i))
    .collect()
}

fn block_id(e: &Env, doc: &str, paragraph: usize) -> Value {
    e.out("prose.read", json!({"doc": doc}))["paragraphs"][paragraph]["block_id"].clone()
}

/// A character with an alias, a summary and a key/value row, and two
/// chapters the author wrote (so nothing in them is linked).
struct Book {
    e: Env,
    b: String,
    anna: String,
    one: String,
    two: String,
}

fn book() -> Book {
    let e = env();
    let b = e.book();
    let anna = entry(&e, &Actor::User, &b, "tpl-character", "安娜", None);
    let fields = json!({"book": b, "entry": anna, "module": "mod-fields"});
    let mut set = fields.clone();
    set["field"] = json!("aliases");
    set["value"] = json!(["小安"]);
    e.call("module.set_field", set);
    let mut set = fields;
    set["field"] = json!("summary");
    set["value"] = json!("灯塔看守人的女儿");
    e.call("module.set_field", set);
    e.call(
        "module.put_kv",
        json!({"book": b, "entry": anna, "module": "mod-kv",
               "row": {"id": "row-home", "key": "住处", "value": "灯塔下的石屋"}}),
    );
    let one = entry(
        &e,
        &Actor::User,
        &b,
        "tpl-chapter",
        "第一章 雨夜",
        Some("雨夜里，小安点亮了灯塔。\n她回到灯塔下的石屋。"),
    );
    let two = entry(
        &e,
        &Actor::User,
        &b,
        "tpl-chapter",
        "第二章",
        Some("灯塔熄了。\nThe Lighthouse keeper slept."),
    );
    // Bold on 点亮了灯: phrases below start before it and end inside it,
    // or start inside it and end after it.
    let session = e.ws().prose_session(&prose_doc(&one)).unwrap();
    session
        .edit(|t| t.set_style(6..10, &InlineStyle::Bold))
        .unwrap();
    drop(session);
    Book {
        e,
        b,
        anna,
        one,
        two,
    }
}

#[test]
fn a_chinese_phrase_is_found_in_prose_and_short_texts_in_tree_order() {
    let Book {
        e, b, anna, one, ..
    } = book();
    let before = e.ws().observe(&format!("book:{b}")).unwrap().version;
    // Six characters: the index's full-text search for the prose, the same
    // literal match in the key/value row.
    let found = search(&e, &b, json!({"query": "灯塔下的石屋"}));
    let rank = tree_rank(&e, &b);
    let mut want = vec![
        (
            "row".to_owned(),
            anna.clone(),
            Some("mod-kv".to_owned()),
            None,
        ),
        (
            "prose".to_owned(),
            one.clone(),
            Some("mod-prose".to_owned()),
            Some(1),
        ),
    ];
    want.sort_by_key(|w| rank[&w.1]);
    assert_eq!(places(&found), want);
    assert!(found.get("next").is_none());
    let prose = found["hits"]
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h["in"] == "prose")
        .unwrap();
    assert_eq!(prose["doc"], prose_doc(&one));
    assert_eq!(prose["title"], "第一章 雨夜");
    assert_eq!(prose["module_name"], "正文");
    assert_eq!(prose["block_id"], block_id(&e, &prose_doc(&one), 1));
    assert_eq!(prose["snippet"], "她回到灯塔下的石屋。");
    let row = found["hits"]
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h["in"] == "row")
        .unwrap();
    assert_eq!(row["snippet"], "住处 灯塔下的石屋");
    // Across the bold mark, both ways: the index keeps the plain text.
    for query in ["小安点亮了", "了灯塔。"] {
        let found = search(&e, &b, json!({"query": query}));
        assert_eq!(
            places(&found),
            [(
                "prose".to_owned(),
                one.clone(),
                Some("mod-prose".to_owned()),
                Some(0)
            )],
            "{query}"
        );
        assert_eq!(found["hits"][0]["snippet"], "雨夜里，小安点亮了灯塔。");
    }
    // A field's value, with the field it is in.
    let found = search(&e, &b, json!({"query": "灯塔看守人"}));
    assert_eq!(
        places(&found),
        [(
            "field".to_owned(),
            anna.clone(),
            Some("mod-fields".to_owned()),
            None
        )]
    );
    assert_eq!(found["hits"][0]["field"], "summary");
    assert_eq!(found["hits"][0]["field_name"], "摘要");
    assert_eq!(found["hits"][0]["module_name"], "基本属性");
    // Searching writes nothing.
    assert_eq!(
        e.ws().observe(&format!("book:{b}")).unwrap().version,
        before
    );
}

#[test]
fn one_and_two_characters_a_name_and_its_alias() {
    let Book {
        e,
        b,
        anna,
        one,
        two,
    } = book();
    // Two characters: the title and the paragraph of one chapter, the title
    // first.
    let found = search(&e, &b, json!({"query": "雨夜"}));
    assert_eq!(
        places(&found),
        [
            ("title".to_owned(), one.clone(), None, None),
            (
                "prose".to_owned(),
                one.clone(),
                Some("mod-prose".to_owned()),
                Some(0)
            ),
        ]
    );
    assert_eq!(found["hits"][0]["snippet"], "第一章 雨夜");
    // The alias is a field value of the character and a word in the prose.
    let found = search(&e, &b, json!({"query": "小安"}));
    let rank = tree_rank(&e, &b);
    let mut want = vec![
        (
            "field".to_owned(),
            anna.clone(),
            Some("mod-fields".to_owned()),
            None,
        ),
        (
            "prose".to_owned(),
            one.clone(),
            Some("mod-prose".to_owned()),
            Some(0),
        ),
    ];
    want.sort_by_key(|w| rank[&w.1]);
    assert_eq!(places(&found), want);
    let alias = found["hits"]
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h["in"] == "field")
        .unwrap();
    assert_eq!(alias["field"], "aliases");
    assert_eq!(alias["snippet"], "小安");
    // The name itself is the title of the character.
    let found = search(&e, &b, json!({"query": "安娜"}));
    assert_eq!(places(&found), [("title".to_owned(), anna, None, None)]);
    // One character: every paragraph and title holding it, in tree order.
    let found = search(&e, &b, json!({"query": "塔", "limit": 50}));
    let got = places(&found);
    assert!(got.contains(&(
        "prose".to_owned(),
        two.clone(),
        Some("mod-prose".to_owned()),
        Some(0)
    )));
    assert_eq!(
        got.iter()
            .filter(|p| p.0 == "prose" && p.1 == one)
            .map(|p| p.3)
            .collect::<Vec<_>>(),
        [Some(0), Some(1)]
    );
    assert!(got.windows(2).all(|w| rank[&w[0].1] <= rank[&w[1].1]));
    // Case-insensitive, matched as written (not split into words).
    let found = search(&e, &b, json!({"query": "LIGHTHOUSE KEEPER"}));
    assert_eq!(
        places(&found),
        [(
            "prose".to_owned(),
            two.clone(),
            Some("mod-prose".to_owned()),
            Some(1)
        )]
    );
    assert_eq!(found["hits"][0]["snippet"], "The Lighthouse keeper slept.");
    assert!(places(&search(&e, &b, json!({"query": "keeper Lighthouse"}))).is_empty());
    assert!(places(&search(&e, &b, json!({"query": "  "}))).is_empty());
}

#[test]
fn patches_and_plot_cells_are_searched_in_their_modules() {
    let Book {
        e, b, anna, one, ..
    } = book();
    e.call(
        "module.put_patch",
        json!({"book": b, "entry": anna, "module": "mod-patches",
               "title": "第五章以后", "body": "她不再去码头"}),
    );
    e.call(
        "module.put_grid",
        json!({"book": b, "entry": one, "module": "mod-plot-grid", "grid": {
            "cell_w": 220.0, "cell_h": 140.0,
            "rows": [{"id": "r1", "pos": "a0", "label": "码头线"}],
            "columns": [{"id": "c1", "pos": "a0", "label": "清晨"}],
            "cells": [{"row": "r1", "column": "c1", "text": "去码头等船"}]
        }}),
    );
    let found = search(&e, &b, json!({"query": "码头"}));
    let rank = tree_rank(&e, &b);
    let mut want = vec![
        (
            "plot".to_owned(),
            one.clone(),
            Some("mod-plot-grid".to_owned()),
            None,
        ),
        (
            "plot".to_owned(),
            one.clone(),
            Some("mod-plot-grid".to_owned()),
            None,
        ),
        (
            "patch".to_owned(),
            anna.clone(),
            Some("mod-patches".to_owned()),
            None,
        ),
    ];
    want.sort_by_key(|w| rank[&w.1]);
    assert_eq!(places(&found), want);
    let snippets: Vec<&str> = found["hits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["snippet"].as_str().unwrap())
        .collect();
    assert!(snippets.contains(&"第五章以后 她不再去码头"));
    assert!(snippets.contains(&"码头线"));
    assert!(snippets.contains(&"去码头等船"));
}

#[test]
fn the_trash_is_searched_only_when_asked() {
    let Book { e, b, two, .. } = book();
    assert_eq!(
        places(&search(&e, &b, json!({"query": "灯塔熄了"}))).len(),
        1
    );
    e.call("entry.trash", json!({"book": b, "id": two}));
    assert!(places(&search(&e, &b, json!({"query": "灯塔熄了"}))).is_empty());
    assert!(places(&search(&e, &b, json!({"query": "第二章"}))).is_empty());
    let found = search(&e, &b, json!({"query": "灯塔熄了", "trashed": true}));
    assert_eq!(
        places(&found),
        [(
            "prose".to_owned(),
            two.clone(),
            Some("mod-prose".to_owned()),
            Some(0)
        )]
    );
    assert_eq!(found["hits"][0]["trashed"], true);
    // A live entry's hit says nothing about the trash.
    let found = search(&e, &b, json!({"query": "雨夜", "trashed": true}));
    assert!(found["hits"][0].get("trashed").is_none());
}

#[test]
fn pages_follow_from_and_next() {
    let e = env();
    let b = e.book();
    let text: Vec<String> = (0..60).map(|n| format!("第{n}次钟声响起。")).collect();
    let id = entry(
        &e,
        &Actor::User,
        &b,
        "tpl-chapter",
        "钟楼",
        Some(&text.join("\n")),
    );
    // Two characters (the substring scan) and three (full-text search).
    for query in ["钟声", "钟声响"] {
        let first = search(&e, &b, json!({"query": query}));
        assert_eq!(first["hits"].as_array().unwrap().len(), 20, "{query}");
        assert_eq!(first["next"], 20);
        let mut all = places(&first);
        let mut from = first["next"].as_u64();
        while let Some(at) = from {
            let page = search(&e, &b, json!({"query": query, "from": at, "limit": 15}));
            assert!(page["hits"].as_array().unwrap().len() <= 15);
            all.extend(places(&page));
            from = page["next"].as_u64();
        }
        assert_eq!(
            all,
            (0..60)
                .map(|n| (
                    "prose".to_owned(),
                    id.clone(),
                    Some("mod-prose".to_owned()),
                    Some(n)
                ))
                .collect::<Vec<_>>(),
            "{query}"
        );
        // At most 50 a page, at least one.
        let most = search(&e, &b, json!({"query": query, "limit": 999}));
        assert_eq!(most["hits"].as_array().unwrap().len(), 50);
        assert_eq!(most["next"], 50);
        let least = search(&e, &b, json!({"query": query, "limit": 0}));
        assert_eq!(least["hits"].as_array().unwrap().len(), 1);
        assert_eq!(least["next"], 1);
        let past = search(&e, &b, json!({"query": query, "from": 60}));
        assert!(places(&past).is_empty());
        assert!(past.get("next").is_none());
    }
}

#[test]
fn an_agents_new_text_is_found_at_once() {
    let Book { e, b, two, .. } = book();
    let doc = prose_doc(&two);
    call(
        e.ws(),
        &agent(),
        "prose.replace",
        json!({"doc": doc, "find": "灯塔熄了", "replace": "灯塔在午夜熄灭了"}),
    );
    let found = search(&e, &b, json!({"query": "午夜熄灭"}));
    assert_eq!(
        places(&found),
        [(
            "prose".to_owned(),
            two,
            Some("mod-prose".to_owned()),
            Some(0)
        )]
    );
    assert!(places(&search(&e, &b, json!({"query": "灯塔熄了"}))).is_empty());
}

#[test]
fn mentions_list_the_paragraphs_that_link_to_an_entry() {
    let Book {
        e, b, anna, one, ..
    } = book();
    // The Agent's text: its names and aliases are linked as it writes them.
    let three = entry(
        &e,
        &agent(),
        &b,
        "tpl-chapter",
        "第三章",
        Some("小安推开门。\n雨很大。\n后来安娜说，小安是她小时候的名字。"),
    );
    let zhou = entry(
        &e,
        &agent(),
        &b,
        "tpl-character",
        "老周",
        Some("老周认识安娜。"),
    );
    let rank = tree_rank(&e, &b);
    let out = mentions(&e, &b, json!({"entry": anna}));
    assert_eq!(out["entry"], anna);
    assert_eq!(out["title"], "安娜");
    assert_eq!(out["total"], 3);
    assert_eq!(out["links"], 4);
    assert!(out.get("next").is_none());
    let got: Vec<(String, Option<u64>, u64, String)> = out["mentions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| {
            (
                m["entry"].as_str().unwrap().to_owned(),
                m["paragraph"].as_u64(),
                m["links"].as_u64().unwrap(),
                m["snippet"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    let mut want = vec![
        (three.clone(), Some(0), 1, "小安推开门。".to_owned()),
        (
            three.clone(),
            Some(2),
            2,
            "后来安娜说，小安是她小时候的名字。".to_owned(),
        ),
        (zhou.clone(), Some(0), 1, "老周认识安娜。".to_owned()),
    ];
    want.sort_by_key(|w| (rank[&w.0], w.1));
    assert_eq!(got, want);
    let first =
        &out["mentions"].as_array().unwrap()[got.iter().position(|g| g.0 == three).unwrap()];
    assert_eq!(first["doc"], prose_doc(&three));
    assert_eq!(first["module"], "mod-prose");
    assert_eq!(first["module_name"], "正文");
    assert_eq!(first["title"], "第三章");
    assert_eq!(first["block_id"], block_id(&e, &prose_doc(&three), 0));
    // The author's own 小安 in chapter one is not linked: search finds it,
    // mentions do not.
    assert!(got.iter().all(|g| g.0 != one));
    assert!(
        places(&search(&e, &b, json!({"query": "小安点亮"})))
            .iter()
            .any(|p| p.1 == one)
    );
    // Pages.
    let page = mentions(&e, &b, json!({"entry": anna, "limit": 2}));
    assert_eq!(page["mentions"].as_array().unwrap().len(), 2);
    assert_eq!(page["next"], 2);
    assert_eq!(page["total"], 3);
    let last = mentions(&e, &b, json!({"entry": anna, "from": 2, "limit": 2}));
    assert_eq!(last["mentions"].as_array().unwrap().len(), 1);
    assert!(last.get("next").is_none());
    assert_eq!(
        [
            &page["mentions"][0],
            &page["mentions"][1],
            &last["mentions"][0]
        ],
        [
            &out["mentions"][0],
            &out["mentions"][1],
            &out["mentions"][2]
        ]
    );
    // The trash: left out unless asked.
    e.call("entry.trash", json!({"book": b, "id": zhou}));
    let out = mentions(&e, &b, json!({"entry": anna}));
    assert_eq!(out["total"], 2);
    let out = mentions(&e, &b, json!({"entry": anna, "trashed": true}));
    assert_eq!(out["total"], 3);
    let trashed: Vec<&Value> = out["mentions"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["trashed"] == true)
        .collect();
    assert_eq!(trashed.len(), 1);
    assert_eq!(trashed[0]["entry"], zhou);
    // An entry nothing links to, and one that is not there.
    let none = mentions(&e, &b, json!({"entry": three}));
    assert_eq!(
        (none["total"].clone(), none["links"].clone()),
        (json!(0), json!(0))
    );
    assert!(
        e.try_call(
            "entry.mentions",
            json!({"book": b, "entry": "0192f0a0-0000-7000-8000-000000000000"})
        )
        .is_err()
    );
}
