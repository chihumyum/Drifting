//! DW (`handoff/v5-tracks.md`): the book has no start and reads from the
//! root (`kernel-v5.md` §3 「怎么读」): a preorder walk over the whole tree,
//! residents by their folder's order, then what is attached, each entry
//! once; nothing is numbered.
mod common;
use common::*;
use serde_json::{Value, json};

fn id(v: &Value) -> String {
    v["id"].as_str().unwrap().to_owned()
}

/// A root entry of a writing project, by its template.
fn root(e: &Env, b: &str, template: &str) -> String {
    acceptance::novel_root(e.ws(), &b, template)
}

/// The category under 要素 whose new entries default to `element`.
fn category(e: &Env, b: &str, title: &str) -> String {
    e.out("entry.list", json!({"book": b, "all": true}))
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["title"] == title && x["template"] == "tpl-category")
        .map(id)
        .unwrap()
}

fn create(e: &Env, b: &str, parent: &str, template: &str, title: &str) -> String {
    id(&e.out(
        "entry.create",
        json!({"book": b, "parent": parent, "template": template, "title": title}),
    ))
}

fn write(e: &Env, b: &str, owner: &str, text: &str) {
    e.call(
        "module.set_prose",
        json!({"book": b, "owner": owner, "module": "mod-prose", "paragraphs": [{"text": text}]}),
    );
}

/// The entries of `book.sequence` that carry book prose, in order. The App
/// numbers nothing: no entry carries a number.
fn book(e: &Env, b: &str) -> Vec<String> {
    e.out("book.sequence", json!({"book": b}))["entries"]
        .as_array()
        .unwrap()
        .iter()
        .inspect(|row| assert!(row.get("ordinal").is_none(), "{row}"))
        .filter(|row| !row["prose"].as_array().unwrap().is_empty())
        .map(|row| row["entry"]["id"].as_str().unwrap().to_owned())
        .collect()
}

fn move_to(e: &Env, b: &str, entry: &str, parent: Option<&str>, index: usize) {
    e.call(
        "entry.move",
        json!({"book": b, "id": entry, "parent": parent, "index": index}),
    );
}

/// A new writing project: its book is the chapters under 书稿, in order;
/// the prose of 构想 and of the elements is not book prose (DW item 6,
/// author 2026-11-15 night), and nothing is numbered.
#[test]
fn a_new_writing_project_reads_its_chapters_from_the_root() {
    let e = env();
    let b = e.book();
    let ms = root(&e, &b, "tpl-manuscript");
    let ideas = root(&e, &b, "tpl-ideas");
    let c1 = create(&e, &b, &ms, "tpl-chapter", "第一章");
    let c2 = create(&e, &b, &ms, "tpl-chapter", "第二章");
    write(&e, &b, &c1, "一");
    write(&e, &b, &c2, "二");
    let idea = create(&e, &b, &ideas, "tpl-idea", "构想甲");
    write(&e, &b, &idea, "想法");
    let people = category(&e, &b, "人物");
    let person = create(&e, &b, &people, "tpl-character", "某人");
    write(&e, &b, &person, "设定");

    assert_eq!(book(&e, &b), vec![c1, c2]);
    let out = e.out("book.sequence", json!({"book": b}));
    assert_eq!(out["has_book"], true);
    assert!(out.get("root").is_none(), "no book start: {out}");
    assert!(out.get("root_valid").is_none(), "no book start: {out}");
    // The idea and the character are on the walk, without book prose.
    let walked: Vec<&str> = out["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["entry"]["id"].as_str().unwrap())
        .collect();
    assert!(walked.contains(&idea.as_str()) && walked.contains(&person.as_str()));
}

/// A chapter dragged into 构想 stays a chapter in the book, at the place
/// 构想 has in the tree: after what 书稿 holds.
#[test]
fn a_chapter_moved_into_ideas_stays_in_the_book_where_ideas_are() {
    let e = env();
    let b = e.book();
    let ms = root(&e, &b, "tpl-manuscript");
    let ideas = root(&e, &b, "tpl-ideas");
    let c1 = create(&e, &b, &ms, "tpl-chapter", "第一章");
    let c2 = create(&e, &b, &ms, "tpl-chapter", "第二章");
    let c3 = create(&e, &b, &ms, "tpl-chapter", "第三章");
    assert_eq!(book(&e, &b), vec![c1.clone(), c2.clone(), c3.clone()]);

    move_to(&e, &b, &c1, Some(&ideas), 0);
    assert_eq!(book(&e, &b), vec![c2, c3, c1]);
}

/// The root's own order is part of the book: 构想 moved before 书稿 puts
/// its chapter first.
#[test]
fn reordering_the_root_folders_reorders_the_book() {
    let e = env();
    let b = e.book();
    let ms = root(&e, &b, "tpl-manuscript");
    let ideas = root(&e, &b, "tpl-ideas");
    let c1 = create(&e, &b, &ms, "tpl-chapter", "第一章");
    let loose = create(&e, &b, &ideas, "tpl-chapter", "放在构想里的章");
    assert_eq!(book(&e, &b), vec![c1.clone(), loose.clone()]);

    move_to(&e, &b, &ideas, None, 0);
    assert_eq!(book(&e, &b), vec![loose, c1]);
}

/// A book written while it still had a start (an old `book.root`) opens as
/// usual: the stored start is not read, the book reads from the root, and
/// `project.get` says nothing about a start.
#[test]
fn a_stored_old_book_start_is_not_read() {
    let e = env();
    let b = e.book();
    let ms = root(&e, &b, "tpl-manuscript");
    let ideas = root(&e, &b, "tpl-ideas");
    let c1 = create(&e, &b, &ms, "tpl-chapter", "第一章");
    let loose = create(&e, &b, &ideas, "tpl-chapter", "放在构想里的章");
    let start = ideas.clone();
    e.ws()
        .library()
        .open_doc(&format!("book:{b}"), dr_store::OpenDoc::Existing)
        .unwrap()
        .write(dr_store::Origin::Import, move |doc| {
            let project = doc.get_map("project");
            let Some(loro::ValueOrContainer::Container(loro::Container::Map(book))) =
                project.get("book")
            else {
                panic!("the writing project has a book");
            };
            let root: std::collections::HashMap<String, loro::LoroValue> = [
                ("kind".to_owned(), "entry".into()),
                ("entry".to_owned(), start.as_str().into()),
            ]
            .into_iter()
            .collect();
            book.insert("root", root).unwrap();
        })
        .unwrap();

    assert_eq!(book(&e, &b), vec![c1, loose]);
    let project = e.out("project.get", json!({"book": b}));
    assert!(project["book"].is_object(), "{project}");
    assert!(project["book"].get("root").is_none(), "{project}");
    assert!(project.get("book_root_valid").is_none(), "{project}");
}

/// An old caller still passing `root` to `project.update`: the other
/// fields change, the start is ignored and nothing about it is stored.
#[test]
fn project_update_ignores_a_root_and_changes_the_rest() {
    let e = env();
    let b = e.book();
    let ideas = root(&e, &b, "tpl-ideas");
    e.call(
        "project.update",
        json!({"book": b, "root": {"kind": "entry", "entry": ideas}, "word_target": 1234}),
    );
    let project = e.out("project.get", json!({"book": b}));
    assert_eq!(project["book"]["word_target"], 1234);
    assert!(project["book"].get("root").is_none(), "{project}");
    let stored = e.ws().observe(&format!("book:{b}")).unwrap().value;
    assert!(
        stored["project"]["book"].get("root").is_none(),
        "{}",
        stored["project"]["book"]
    );

    // Turning the book off and on again needs no start.
    e.call("project.update", json!({"book": b, "has_book": false}));
    assert!(e.out("project.get", json!({"book": b}))["book"].is_null());
    e.call("project.update", json!({"book": b, "has_book": true}));
    assert!(e.out("project.get", json!({"book": b}))["book"].is_object());
}
