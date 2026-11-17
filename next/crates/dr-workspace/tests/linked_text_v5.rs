//! Editing a comment or a relation's description keeps the links the writer
//! could not see or did not send (`kernel-v5.md` §19 「描述和批注里的链接」),
//! automatic links follow the prose rule of §16, and the planner uses the
//! book's cached names.

mod common;
use common::*;
use dr_workspace::Actor;
use serde_json::{Value, json};

struct Book {
    env: Env,
    book: String,
}

impl Book {
    fn new() -> Self {
        let env = env();
        let book = env.book();
        Self { env, book }
    }

    fn entry(&self, template: &str, title: &str) -> String {
        acceptance::novel_entry(self.env.ws(), &self.book, template, title, None)["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn comment(&self, body: Value) -> String {
        self.env
            .out("comment.create", json!({"book":self.book,"body":body}))["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn edit(&self, id: &str, body: Value) {
        self.env.call(
            "comment.update",
            json!({"book":self.book,"id":id,"body":body}),
        );
    }

    fn body(&self, id: &str) -> Value {
        body_on(&self.env, &self.book, id)
    }

    fn relation(&self, description: Value) -> String {
        self.env.out(
            "relation_type.create",
            json!({"book":self.book,"name":"相识","description":description}),
        )["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn describe(&self, id: &str, description: Value) {
        self.env.call(
            "relation_type.set_description",
            json!({"book":self.book,"id":id,"description":description}),
        );
    }

    fn description(&self, id: &str) -> Value {
        self.env
            .out("relation_type.list", json!({"book":self.book}))
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == id)
            .unwrap()["description"]
            .clone()
    }

    fn trash(&self, entry: &str) {
        self.env
            .call("entry.trash", json!({"book":self.book,"id":entry}));
    }

    fn restore(&self, entry: &str) {
        self.env
            .call("entry.restore", json!({"book":self.book,"id":entry}));
    }
}

fn body_on(env: &Env, book: &str, id: &str) -> Value {
    env.out("comment.list", json!({"book":book}))
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == id)
        .unwrap()["body"]
        .clone()
}

fn link(start: usize, end: usize, entry: &str) -> Value {
    json!({"start":start,"end":end,"entry":entry})
}

/// The review composer sends plain text: an edit elsewhere keeps the link to
/// an entry in Recently Deleted (shown as plain text) and the visible one,
/// and the hidden one comes back with the entry.
#[test]
fn a_plain_edit_elsewhere_keeps_a_hidden_link_and_restore_brings_it_back() {
    let f = Book::new();
    let lin = f.entry("tpl-character", "阿林");
    let zhong = f.entry("tpl-character", "老钟");
    let c = f.comment(json!("阿林见过老钟。"));
    assert_eq!(
        f.body(&c)["links"],
        json!([link(0, 2, &lin), link(4, 6, &zhong)])
    );
    f.trash(&zhong);
    assert_eq!(
        f.body(&c),
        json!({"text":"阿林见过老钟。","links":[link(0, 2, &lin)]})
    );

    f.edit(&c, json!("那天阿林见过老钟。"));
    assert_eq!(
        f.body(&c),
        json!({"text":"那天阿林见过老钟。","links":[link(2, 4, &lin)]})
    );
    f.restore(&zhong);
    assert_eq!(
        f.body(&c),
        json!({"text":"那天阿林见过老钟。","links":[link(2, 4, &lin), link(6, 8, &zhong)]})
    );
}

/// A writer that sends links (the RL card) states the visible ones; the hidden
/// one it never saw is kept, on comments and on descriptions alike.
#[test]
fn a_linked_edit_keeps_the_hidden_link_and_drops_a_visible_one_left_out() {
    let f = Book::new();
    let lin = f.entry("tpl-character", "阿林");
    let zhong = f.entry("tpl-character", "老钟");
    let c = f.comment(json!("阿林见过老钟。"));
    let r = f.relation(json!("阿林见过老钟。"));
    f.trash(&zhong);
    let read = f.body(&c);
    assert_eq!(read, f.description(&r));
    let mut echoed = read.clone();
    echoed["text"] = json!("阿林见过老钟，后来走了。");
    f.edit(&c, echoed.clone());
    f.describe(&r, echoed);
    f.restore(&zhong);
    let kept = json!({
        "text":"阿林见过老钟，后来走了。",
        "links":[link(0, 2, &lin), link(4, 6, &zhong)],
    });
    assert_eq!(f.body(&c), kept);
    assert_eq!(f.description(&r), kept);
    // A visible link the writer leaves out comes off (with the setting off,
    // its name is not linked again).
    f.env.ws().set_auto_links(false);
    let e = f.comment(json!({"text":"阿林来了","links":[link(0, 2, &lin)]}));
    f.edit(&e, json!({"text":"阿林来了。","links":[]}));
    assert_eq!(f.body(&e), json!({"text":"阿林来了。","links":[]}));
}

/// The composer's plain edit keeps an explicit link (here to an entry whose
/// name is never linked by itself) on the words it leaves alone, and a link
/// whose words the edit changes comes off.
#[test]
fn a_plain_edit_keeps_explicit_links_on_unchanged_words_only() {
    let f = Book::new();
    let note = f.entry("tpl-note", "书签");
    let zhu = f.entry("tpl-character", "小竹");
    let c = f.comment(json!({
        "text":"书签夹在小竹的书里",
        "links":[link(0, 2, &note)],
    }));
    assert_eq!(
        f.body(&c)["links"],
        json!([link(0, 2, &note), link(4, 6, &zhu)])
    );
    f.edit(&c, json!("书签夹在小竹的书里。"));
    assert_eq!(
        f.body(&c)["links"],
        json!([link(0, 2, &note), link(4, 6, &zhu)])
    );
    f.edit(&c, json!("书笺夹在小竹的书里。"));
    assert_eq!(f.body(&c)["links"], json!([link(4, 6, &zhu)]));
}

/// A renamed entry reads under its new title; a plain edit of what was read
/// keeps the link and stores the new spelling.
#[test]
fn a_plain_edit_of_a_renamed_link_keeps_it() {
    let f = Book::new();
    let zhong = f.entry("tpl-character", "老钟");
    let c = f.comment(json!("老钟来了"));
    f.env.call(
        "entry.update",
        json!({"book":f.book,"id":zhong,"title":"钟伯"}),
    );
    f.edit(&c, json!("钟伯来了。"));
    assert_eq!(
        f.body(&c),
        json!({"text":"钟伯来了。","links":[link(0, 2, &zhong)]})
    );
}

fn sync_docs(from: &dr_workspace::Workspace, to: &dr_workspace::Workspace) {
    let mut docs = from.library().docs(None, None).unwrap();
    docs.sort_by_key(|d| (d.kind != "book", d.doc_id.clone()));
    for d in docs {
        if from.library().head(&d.doc_id).unwrap().is_none() {
            continue;
        }
        let bytes = from
            .library()
            .load_copy(&d.doc_id)
            .unwrap()
            .export(loro::ExportMode::all_updates())
            .unwrap();
        to.import_remote(
            &d.doc_id,
            Some((&d.kind, d.book_id.as_deref().unwrap_or(""))),
            bytes,
            &Actor::Sync,
        )
        .unwrap();
    }
}

/// Two devices edit both ends of a comment while its link's entry is in
/// Recently Deleted: both edits and the link survive the merge, and the link
/// comes back on both devices with the entry.
#[test]
fn concurrent_edits_on_two_devices_keep_the_hidden_link() {
    let one = Book::new();
    let two = env();
    let zhong = one.entry("tpl-character", "老钟");
    let c = one.comment(json!("见过 老钟 一面"));
    one.trash(&zhong);
    sync_docs(one.env.ws(), two.ws());
    one.edit(&c, json!("那年 见过 老钟 一面"));
    two.call(
        "comment.update",
        json!({"book":one.book,"id":c,"body":"见过 老钟 一面 就走了"}),
    );
    sync_docs(one.env.ws(), two.ws());
    sync_docs(two.ws(), one.env.ws());
    one.restore(&zhong);
    sync_docs(one.env.ws(), two.ws());
    let want = json!({"text":"那年 见过 老钟 一面 就走了","links":[link(6, 8, &zhong)]});
    assert_eq!(one.body(&c), want);
    assert_eq!(body_on(&two, &one.book, &c), want);
}

/// Automatic links follow the prose rule (`kernel-v5.md` §16): a shorter
/// name's link gives way to a longer name over it on the next edit, while a
/// link the author picked with @ stays.
#[test]
fn a_longer_name_takes_over_an_automatic_link_but_not_a_pick() {
    let f = Book::new();
    let bridge = f.entry("tpl-character", "石桥");
    let c = f.comment(json!("石桥镇很远"));
    let r = f.relation(json!("石桥镇很远"));
    assert_eq!(f.body(&c)["links"], json!([link(0, 2, &bridge)]));
    let town = f.entry("tpl-location", "石桥镇");
    // No backfill: the old link stays until the text is edited.
    assert_eq!(f.body(&c)["links"], json!([link(0, 2, &bridge)]));
    f.edit(&c, json!("石桥镇很远。"));
    let mut read = f.description(&r);
    read["text"] = json!("石桥镇很远。");
    f.describe(&r, read);
    for got in [f.body(&c), f.description(&r)] {
        assert_eq!(got["links"], json!([link(0, 3, &town)]));
    }
    let picked = f.comment(json!({"text":"石桥镇很远","links":[link(0, 2, &bridge)]}));
    assert_eq!(f.body(&picked)["links"], json!([link(0, 2, &bridge)]));
    // Once saved, the pick is an existing link like any other.
    f.edit(&picked, json!("石桥镇很远。"));
    assert_eq!(f.body(&picked)["links"], json!([link(0, 3, &town)]));
}

/// Comment writes plan with the book's compiled matcher: it is built once
/// for the book's names and comment writes, which change no name, leave it.
#[test]
fn comment_writes_reuse_the_books_cached_matcher() {
    let f = Book::new();
    let lin = f.entry("tpl-character", "阿林");
    let (_, _, before) = f.env.ws().book_link_cache(&f.book).unwrap();
    let agent = Actor::agent("synthetic", 1, "create");
    let id = call(
        f.env.ws(),
        &agent,
        "comment.create",
        json!({"book":f.book,"body":"阿林来了"}),
    )["output"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    f.edit(&id, json!("阿林又来了"));
    f.relation(json!("阿林"));
    let (_, _, after) = f.env.ws().book_link_cache(&f.book).unwrap();
    assert!(std::sync::Arc::ptr_eq(&before, &after));
    assert_eq!(f.body(&id)["links"], json!([link(0, 2, &lin)]));
}
