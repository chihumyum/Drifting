//! Automatic entity links in text other writers put in
//! (`dr_workspace::autolink`): an Agent's names wholly inside its new text
//! are linked in the same commit; the author's text around it is never
//! touched; undo takes the links back with the text; the author's own
//! commands link nothing (the editor links what the author types).

mod common;

use common::*;
use dr_workspace::Actor;
use serde_json::{Value, json};

fn agent() -> Actor {
    Actor::agent("s", 1, "c")
}

/// `name` as the Agent of session "s", turn 1.
fn by_agent(e: &Env, name: &str, input: Value) -> Value {
    call(e.ws(), &agent(), name, input)["output"].clone()
}

/// The entity links of `doc` as (linked text, target id).
fn links(e: &Env, doc: &str) -> Vec<(String, String)> {
    let s = e.ws().prose_session(doc).unwrap();
    let r = s.reader();
    let v = r.view();
    let text: Vec<char> = v.plain_text().chars().collect();
    let mut out: Vec<(String, String)> = v
        .entity_links()
        .into_iter()
        .map(|(range, l)| (text[range].iter().collect(), l.target))
        .collect();
    out.sort();
    out
}

fn element(e: &Env, b: &str, name: &str) -> String {
    e.out("element.create", json!({"book": b, "name": name}))["id"]
        .as_str()
        .unwrap()
        .to_string()
}

/// A chapter the Agent writes, with `text`.
fn chapter(e: &Env, b: &str, title: &str, text: &str) -> String {
    let id = by_agent(
        e,
        "chapter.create",
        json!({"book": b, "title": title, "text": text}),
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    format!("node:{id}")
}

#[test]
fn an_agents_text_gets_its_names_linked_and_the_authors_does_not() {
    let e = env();
    let b = e.book();
    let anna = element(&e, &b, "安娜");
    // The author's chapter: the author's words, not linked by a command.
    let id = e.out(
        "chapter.create",
        json!({"book": b, "title": "雨夜", "text": "安娜站在门口。"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    let doc = format!("node:{id}");
    assert!(links(&e, &doc).is_empty());
    let out = e.out(
        "prose.replace",
        json!({"doc": doc, "find": "门口", "replace": "门口等安娜"}),
    );
    assert_eq!(out["linked"], 0, "the author's command links nothing");
    // The Agent writes next to the author's text: only its own 安娜.
    let out = by_agent(
        &e,
        "prose.replace",
        json!({"doc": doc, "find": "等安娜", "replace": "，安娜的伞还在滴水"}),
    );
    assert_eq!(out["linked"], 1);
    let got = links(&e, &doc);
    assert_eq!(got, [("安娜".to_string(), anna)]);
    let text = e.out("prose.read", json!({"doc": doc}))["paragraphs"][0]["text"].clone();
    assert_eq!(text, "安娜站在门口，安娜的伞还在滴水。");
    // Not the author's 安娜 at the start: the link is the Agent's one.
    let s = e.ws().prose_session(&doc).unwrap();
    let ranges: Vec<_> = s
        .reader()
        .view()
        .entity_links()
        .into_iter()
        .map(|(r, _)| r)
        .collect();
    assert_eq!(ranges, vec![std::ops::Range { start: 7, end: 9 }]);
    drop(s);
    // The Agent's undo takes the text and its link back.
    e.call("history.undo_agent", json!({"session": "s", "turn": 1}));
    assert!(links(&e, &doc).is_empty());
}

#[test]
fn undoing_the_command_takes_its_links_with_it() {
    let e = env();
    let b = e.book();
    element(&e, &b, "沈知微");
    let doc = chapter(&e, &b, "一", "她来了。");
    by_agent(
        &e,
        "prose.replace",
        json!({"doc": doc, "find": "她", "replace": "沈知微"}),
    );
    assert_eq!(links(&e, &doc).len(), 1);
    // The Agent's own journal step.
    e.ws().undo(&agent()).unwrap().unwrap();
    assert!(links(&e, &doc).is_empty());
    assert_eq!(
        e.out("prose.read", json!({"doc": doc}))["paragraphs"][0]["text"],
        "她来了。"
    );
}

#[test]
fn titles_link_and_a_page_never_links_itself() {
    let e = env();
    let b = e.book();
    let first = chapter(&e, &b, "钟楼", "");
    let first_id = first.trim_start_matches("node:").to_string();
    // A chapter's text naming another chapter links it; its own title not.
    let doc = chapter(&e, &b, "雨夜", "雨夜里有人去了钟楼。");
    assert_eq!(links(&e, &doc), [("钟楼".to_string(), first_id)]);
    // The longest name wins, and names never overlap.
    let short = element(&e, &b, "知微");
    let long = element(&e, &b, "沈知微");
    let doc = chapter(&e, &b, "二", "沈知微和知微");
    let mut want = vec![("沈知微".to_string(), long), ("知微".to_string(), short)];
    want.sort();
    assert_eq!(links(&e, &doc), want);
}

#[test]
fn a_name_across_the_edge_of_the_new_text_stays_unlinked() {
    let e = env();
    let b = e.book();
    element(&e, &b, "安娜");
    let doc = chapter(&e, &b, "一", "安来了。");
    // The replaced passage 「安娜来」 holds the whole name.
    let out = by_agent(
        &e,
        "prose.replace",
        json!({"doc": doc, "find": "安来", "replace": "安娜来"}),
    );
    assert_eq!(out["linked"], 1);
    // 「安」 was there before, 「娜」 is new: split across the edge.
    let doc2 = chapter(&e, &b, "二", "安来了。");
    let out = by_agent(
        &e,
        "prose.replace",
        json!({"doc": doc2, "find": "来", "replace": "娜来"}),
    );
    assert_eq!(out["linked"], 0);
    assert!(links(&e, &doc2).is_empty());
}

#[test]
fn the_authors_setting_turns_it_off() {
    let e = env();
    let b = e.book();
    element(&e, &b, "安娜");
    e.ws().set_auto_links(false);
    let doc = chapter(&e, &b, "一", "安娜。");
    assert!(links(&e, &doc).is_empty());
    let out = by_agent(
        &e,
        "prose.replace",
        json!({"doc": doc, "find": "。", "replace": "，安娜。"}),
    );
    assert_eq!(out["linked"], 0);
    e.ws().set_auto_links(true);
    let out = by_agent(
        &e,
        "prose.replace",
        json!({"doc": doc, "find": "，安娜。", "replace": "，又是安娜。"}),
    );
    assert_eq!(out["linked"], 1);
}

#[test]
fn trashed_elements_are_not_linked() {
    let e = env();
    let b = e.book();
    let anna = element(&e, &b, "安娜");
    e.call("element.trash", json!({"book": b, "id": anna}));
    let doc = chapter(&e, &b, "一", "安娜。");
    assert!(links(&e, &doc).is_empty());
}

#[test]
fn every_page_an_agent_creates_with_text_links_names() {
    let e = env();
    let b = e.book();
    let anna = element(&e, &b, "安娜");
    let note = by_agent(
        &e,
        "material.create",
        json!({"book": b, "kind": "text", "title": "笔记", "text": "安娜的笔记。"}),
    );
    let doc = format!("material:{}", note["id"].as_str().unwrap());
    assert_eq!(links(&e, &doc), [("安娜".to_string(), anna.clone())]);
    let line = by_agent(
        &e,
        "storyline.create",
        json!({"book": b, "name": "主线", "text": "安娜的线。"}),
    );
    let doc = format!("storyline:{}", line["id"].as_str().unwrap());
    assert_eq!(links(&e, &doc), [("安娜".to_string(), anna)]);
}
