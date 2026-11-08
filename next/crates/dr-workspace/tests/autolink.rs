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

/// A chapter the author writes, with `text` (the author's command links
/// nothing).
fn authors_chapter(e: &Env, b: &str, title: &str, text: &str) -> String {
    let id = e.out(
        "chapter.create",
        json!({"book": b, "title": title, "text": text}),
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    format!("node:{id}")
}

#[test]
fn the_plan_leaves_a_name_someone_else_links_exactly() {
    use dr_model::kind::EntityKind;
    use dr_text::autolink::{LinkMatcher, LinkName, LinkTarget};
    use dr_workspace::autolink::{LinkEdit, LinkRun, plan};
    let t = |id: &str| LinkTarget::new(EntityKind::Element, id);
    let names = LinkMatcher::new([
        LinkName::new("安娜", t("new")),
        LinkName::new("沈知微", t("long")),
        LinkName::new("知微", t("short")),
    ]);
    let run = |r: std::ops::Range<usize>, id: &str| LinkRun {
        range: r,
        target: id.into(),
    };
    // 「安娜」 linked to the one who had the name before: theirs.
    assert!(plan("安娜来了", &[run(0..2, "old")], &names, 0..4).is_empty());
    // A link reaching outside the name: left alone too.
    assert!(plan("安娜来了", &[run(0..3, "old")], &names, 0..4).is_empty());
    // A shorter link inside a longer name gives way.
    assert_eq!(
        plan("沈知微", &[run(1..3, "short")], &names, 0..3),
        [
            LinkEdit::Unlink {
                range: 1..3,
                target: "short".into()
            },
            LinkEdit::Link {
                range: 0..3,
                target: t("long")
            },
        ]
    );
    // Half linked to its target: linked whole; outside `within`: nothing.
    assert_eq!(
        plan("安娜", &[run(0..1, "new")], &names, 0..2),
        [LinkEdit::Link {
            range: 0..2,
            target: t("new")
        }]
    );
    assert!(plan("安娜", &[], &names, 0..1).is_empty());
}

#[test]
fn a_new_element_links_itself_in_the_text_already_written() {
    let e = env();
    let b = e.book();
    let one = authors_chapter(&e, &b, "一", "沈知微来了。");
    let two = authors_chapter(&e, &b, "二", "雨。");
    // An editor is open on chapter one, the author typing in it.
    let s = e.ws().prose_session(&one).unwrap();
    s.edit(|t| t.insert_text(6, "她说")).unwrap();
    let o = e.call(
        "element.create",
        json!({"book": b, "name": "沈知微", "aliases": ["知微"]}),
    );
    let id = o["output"]["id"].as_str().unwrap().to_string();
    assert_eq!(links(&e, &one), [("沈知微".to_string(), id.clone())]);
    assert!(links(&e, &two).is_empty());
    assert!(effects(&o).contains(&"updated prose".to_string()));
    // The editor's undo takes back its own typing, not the links.
    assert!(s.undo().unwrap());
    assert_eq!(links(&e, &one), [("沈知微".to_string(), id.clone())]);
    drop(s);
    // The command's undo takes them back, redo brings them again.
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert!(links(&e, &one).is_empty());
    e.ws().redo(&Actor::User).unwrap().unwrap();
    assert_eq!(links(&e, &one), [("沈知微".to_string(), id)]);
}

#[test]
fn a_new_longer_name_takes_over_and_undo_gives_it_back() {
    let e = env();
    let b = e.book();
    let short = element(&e, &b, "知微");
    let doc = chapter(&e, &b, "一", "沈知微来了。");
    assert_eq!(links(&e, &doc), [("知微".to_string(), short.clone())]);
    let long = element(&e, &b, "沈知微");
    assert_eq!(links(&e, &doc), [("沈知微".to_string(), long)]);
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert_eq!(links(&e, &doc), [("知微".to_string(), short)]);
}

#[test]
fn renames_aliases_and_titles_fill_in_their_links() {
    let e = env();
    let b = e.book();
    let anna = element(&e, &b, "安娜");
    let doc = authors_chapter(&e, &b, "一", "安妮和小安去了钟楼。");
    assert!(links(&e, &doc).is_empty());
    e.call(
        "element.update",
        json!({"book": b, "id": anna, "add_aliases": ["小安"]}),
    );
    assert_eq!(links(&e, &doc), [("小安".to_string(), anna.clone())]);
    e.call(
        "element.update",
        json!({"book": b, "id": anna, "name": "安妮"}),
    );
    let mut want = vec![
        ("安妮".to_string(), anna.clone()),
        ("小安".to_string(), anna.clone()),
    ];
    want.sort();
    let mut got = links(&e, &doc);
    got.sort();
    assert_eq!(got, want);
    // A chapter titled with a name in the text links it too.
    let tower = e.out("chapter.create", json!({"book": b, "title": "钟楼"}))["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(links(&e, &doc).contains(&("钟楼".to_string(), tower)));
}

#[test]
fn a_name_someone_had_before_stays_theirs() {
    let e = env();
    let b = e.book();
    let first = element(&e, &b, "安娜");
    let doc = chapter(&e, &b, "一", "安娜来了。");
    assert_eq!(links(&e, &doc), [("安娜".to_string(), first.clone())]);
    // She is renamed; a new element takes the old name. The text still
    // means the first one.
    e.call(
        "element.update",
        json!({"book": b, "id": first, "name": "安妮"}),
    );
    element(&e, &b, "安娜");
    assert_eq!(links(&e, &doc), [("安娜".to_string(), first)]);
}

#[test]
fn backfill_leaves_notes_trash_and_the_setting_alone() {
    let e = env();
    let b = e.book();
    let note = e.out(
        "material.create",
        json!({"book": b, "kind": "text", "title": "笔记", "text": "安娜的笔记。"}),
    );
    let note = format!("material:{}", note["id"].as_str().unwrap());
    let gone = authors_chapter(&e, &b, "旧", "安娜。");
    e.call(
        "chapter.trash",
        json!({"book": b, "id": gone.trim_start_matches("node:")}),
    );
    let off = authors_chapter(&e, &b, "关", "贝雅。");
    element(&e, &b, "安娜");
    assert!(links(&e, &note).is_empty(), "material notes are left alone");
    assert!(links(&e, &gone).is_empty(), "the trash is left alone");
    e.ws().set_auto_links(false);
    element(&e, &b, "贝雅");
    assert!(links(&e, &off).is_empty());
}

#[test]
fn links_go_on_and_off_anchored_ranges() {
    use dr_doc::anchor::Anchor;
    use dr_store::OpenDoc;
    use dr_workspace::dto::AnchorBytes;
    let e = env();
    let b = e.book();
    let anna = element(&e, &b, "安娜");
    let doc = authors_chapter(&e, &b, "一", "她说安娜来了。");
    let h = e.ws().library().open_doc(&doc, OpenDoc::Existing).unwrap();
    let a = h
        .read(|d| Anchor::new(&d.get_text("body"), 2..4))
        .unwrap()
        .unwrap();
    drop(h);
    let input = json!({"links": [{
        "doc": doc,
        "target": {"kind": "element", "id": anna},
        "anchors": [AnchorBytes::from(&a.encode())],
    }]});
    // Typing in front of the range moves nothing.
    let s = e.ws().prose_session(&doc).unwrap();
    s.edit(|t| t.insert_text(0, "那天")).unwrap();
    drop(s);
    let o = e.call("prose.link", input.clone());
    assert_eq!(o["output"]["ranges"], 1);
    assert_eq!(o["output"]["docs"], 1);
    assert_eq!(links(&e, &doc), [("安娜".to_string(), anna.clone())]);
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert!(links(&e, &doc).is_empty());
    e.call("prose.link", input.clone());
    e.call("prose.unlink", input.clone());
    assert!(links(&e, &doc).is_empty());
    // Only what can be linked; anchors of another document are refused.
    let mut bad = input.clone();
    bad["links"][0]["target"]["kind"] = json!("relation");
    assert!(e.try_call("prose.link", bad).is_err());
    let other = authors_chapter(&e, &b, "二", "雨。");
    let mut elsewhere = input.clone();
    elsewhere["links"][0]["doc"] = json!(other);
    assert!(e.try_call("prose.unlink", elsewhere.clone()).is_err());
    // One command for several documents, refused whole when one is wrong.
    let mut both = input.clone();
    both["links"]
        .as_array_mut()
        .unwrap()
        .push(elsewhere["links"][0].clone());
    assert!(e.try_call("prose.link", both).is_err());
    assert!(links(&e, &doc).is_empty());
}

#[test]
fn a_books_link_matcher_is_kept_until_a_name_changes() {
    let e = env();
    let b = e.book();
    let anna = element(&e, &b, "安娜");
    let doc = authors_chapter(&e, &b, "一", "她说安娜来了。");
    let d: dr_model::DocId = doc.parse().unwrap();
    let m1 = e.ws().link_matcher(&d).unwrap().unwrap();
    let m2 = e.ws().link_matcher(&d).unwrap().unwrap();
    assert!(std::sync::Arc::ptr_eq(&m1, &m2));
    // The chapter's own title is left out of its own matcher.
    assert!(m1.find("一").is_empty());
    assert_eq!(m1.find("安娜").len(), 1);
    // A rename makes a new one; so does a new chapter title.
    e.call(
        "element.update",
        json!({"book": b, "id": anna, "name": "安妮"}),
    );
    let m3 = e.ws().link_matcher(&d).unwrap().unwrap();
    assert!(!std::sync::Arc::ptr_eq(&m1, &m3));
    assert!(m3.find("安娜").is_empty());
    assert_eq!(m3.find("安妮").len(), 1);
    e.call("chapter.create", json!({"book": b, "title": "灯塔"}));
    let m4 = e.ws().link_matcher(&d).unwrap().unwrap();
    assert_eq!(m4.find("灯塔").len(), 1);
}

#[test]
fn an_idea_turns_into_an_element_that_takes_its_name() {
    let e = env();
    let b = e.book();
    let u = Actor::User;
    let cat = e.out("category.create", json!({"book": b, "name": "地点"}))["id"].clone();
    e.call(
        "category_template.put",
        json!({"book": b, "category": cat, "key": "位置", "value": ""}),
    );
    // Written before the idea: its title links the idea there.
    let before = authors_chapter(&e, &b, "一", "远处是灯塔。");
    let idea = e.out(
        "idea.create",
        json!({"book": b, "title": "灯塔", "summary": "岬角上", "text": "白色的塔。"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(links(&e, &before), [("灯塔".to_string(), idea.clone())]);
    // Written after: not linked yet (the author's own command).
    let after = authors_chapter(&e, &b, "二", "灯塔亮了。");
    assert!(links(&e, &after).is_empty());

    let done = e.call(
        "idea.to_element",
        json!({"book": b, "id": idea, "category": cat}),
    );
    let el = done["output"]["id"].as_str().unwrap().to_string();
    assert_eq!(done["output"]["name"], "灯塔");
    let row = e.out("element.list", json!({"book": b}))[0].clone();
    assert_eq!(row["summary"], "岬角上");
    assert_eq!(row["category"], cat);
    assert_eq!(row["fields"][0]["key"], "位置");
    let body = field(
        &e.out("prose.read", json!({"doc": format!("element:{el}")}))["paragraphs"],
        "text",
    );
    assert_eq!(body, [json!("白色的塔。")]);
    let trashed = e.out("idea.list", json!({"book": b, "trashed": true}));
    assert_eq!(trashed[0]["trashed"], true);
    // The name is the element's now in text not linked yet; a link to the
    // idea stays where it was (as in 0.1, which deleted the idea).
    assert_eq!(links(&e, &after), [("灯塔".to_string(), el.clone())]);
    assert_eq!(links(&e, &before), [("灯塔".to_string(), idea.clone())]);

    // One undo step: the element goes, the idea and the text come back.
    e.ws().undo(&u).unwrap().unwrap();
    assert!(
        e.out("element.list", json!({"book": b}))
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(e.out("idea.list", json!({"book": b}))[0]["id"], idea);
    assert!(links(&e, &after).is_empty());
    e.ws().redo(&u).unwrap().unwrap();
    assert_eq!(e.out("element.list", json!({"book": b}))[0]["id"], el);

    // A name another element has is refused.
    let other = e.out("idea.create", json!({"book": b, "title": "灯塔 2"}))["id"].clone();
    match e.try_call(
        "idea.to_element",
        json!({"book": b, "id": other, "name": "灯塔"}),
    ) {
        Err(err) => assert_eq!(err.code(), "name_taken"),
        Ok(v) => panic!("{v}"),
    }
}
