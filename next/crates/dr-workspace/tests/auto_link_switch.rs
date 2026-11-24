//! Each entry's own 「自动链接」 (`kernel-v5.md` §16): off unless someone
//! turned it on; a level's switch carries what lives below it and sets what
//! is made there; turning an entry off hides the automatic links to it and
//! leaves the text as it was, byte for byte; a link picked with @ shows
//! whatever the switches say; the readers of the index (mentions, the
//! relation graph) follow the same rule, and so do comments.

mod common;

use common::*;
use dr_model::kind::EntityKind;
use dr_model::v3::{EntityLinkV3, LinkShow};
use dr_workspace::Actor;
use serde_json::{Value, json};

fn agent() -> Actor {
    Actor::agent("s", 1, "c")
}

/// How long a test waits for the links a switch turned on asks for.
const WAIT: std::time::Duration = std::time::Duration::from_secs(20);

fn by_agent(e: &Env, name: &str, input: Value) -> Value {
    call(e.ws(), &agent(), name, input)["output"].clone()
}

fn id_of(v: &Value) -> String {
    v["id"].as_str().unwrap().to_owned()
}

/// A character in the writing template's 人物, as the author makes it.
fn character(e: &Env, b: &str, name: &str) -> String {
    id_of(&acceptance::novel_entry(
        e.ws(),
        b,
        "tpl-character",
        name,
        None,
    ))
}

/// An entry of `template` living under `parent` (`None`: the outermost
/// level), with the switch it starts with.
fn create(e: &Env, b: &str, parent: Option<&str>, template: &str, title: &str) -> String {
    id_of(&e.out(
        "entry.create",
        json!({"book": b, "parent": parent, "template": template, "title": title}),
    ))
}

fn switch(e: &Env, b: &str, id: &str) -> bool {
    e.out("entry.get", json!({"book": b, "id": id}))["auto_link"]
        .as_bool()
        .unwrap()
}

fn set(e: &Env, b: &str, id: &str, on: bool) -> dr_workspace::Result<Value> {
    e.try_call(
        "entry.set_auto_link",
        json!({"book": b, "id": id, "auto_link": on}),
    )
}

fn set_below(e: &Env, b: &str, id: &str, on: bool) -> dr_workspace::Result<Value> {
    e.try_call(
        "entry.set_below_auto_link",
        json!({"book": b, "id": id, "auto_link": on}),
    )
}

/// A chapter the Agent writes, with `text` (its names linked as it writes).
fn chapter(e: &Env, b: &str, title: &str, text: &str) -> String {
    let ms = acceptance::novel_root(e.ws(), &b, "tpl-manuscript");
    let id = id_of(&by_agent(
        e,
        "entry.create",
        json!({"book": b, "parent": ms, "template": "tpl-chapter", "title": title, "bodies": {"mod-prose": text}}),
    ));
    format!("body:{id}/mod-prose")
}

/// The links stored in `doc`: linked text, target, picked with @.
fn links(e: &Env, doc: &str) -> Vec<(String, String, bool)> {
    let s = e.ws().prose_session(doc).unwrap();
    let r = s.reader();
    let v = r.view();
    let text: Vec<char> = v.plain_text().chars().collect();
    v.entity_links_v3()
        .into_iter()
        .map(|(range, l)| (text[range].iter().collect(), l.target, l.manual))
        .collect()
}

/// What each link of `doc` shows as now, by the one rule.
fn shown(e: &Env, b: &str, doc: &str) -> Vec<(String, LinkShow)> {
    let id = dr_model::id::BookId::parse(b).unwrap();
    let raw = e.ws().library().load_copy(&format!("book:{b}")).unwrap();
    let book = dr_doc::v3::BorrowedBookV3::new(&raw, &id).unwrap();
    let states = dr_model::v3::LinkEntries::of(book.view().graph().entries.values());
    links(e, doc)
        .into_iter()
        .map(|(text, target, manual)| (text, states.show(&target, manual, e.ws().auto_links())))
        .collect()
}

/// The whole stored state of document `doc`: its value and its version.
fn stored(e: &Env, doc: &str) -> (loro::LoroValue, loro::Frontiers) {
    let d = e.ws().library().load_copy(doc).unwrap();
    (d.get_deep_value(), d.oplog_frontiers())
}

/// A link picked with @ on `range` of `doc`, written as the editor writes it.
fn pick(e: &Env, doc: &str, range: std::ops::Range<usize>, target: &str) {
    let link = EntityLinkV3 {
        target: target.to_owned(),
        kind: EntityKind::Entry,
        module: None,
        block: None,
        end_block: None,
        manual: true,
    };
    e.ws()
        .prose_session(doc)
        .unwrap()
        .edit(move |t| t.link_entity_v3(range, &link))
        .unwrap();
}

#[test]
fn a_new_entry_links_only_when_its_own_switch_is_on() {
    let e = env();
    let b = e.book();
    // The writing template's 人物 starts what is made in it linked.
    let anna = character(&e, &b, "安娜");
    assert!(switch(&e, &b, &anna));
    // A level the author made at the outermost level sets nothing: off.
    let misc = create(&e, &b, None, "tpl-group", "杂项");
    let lin = create(&e, &b, Some(&misc), "tpl-character", "林凯");
    assert!(!switch(&e, &b, &lin));
    // Asked for, the switch is what the caller says.
    let quiet = id_of(&e.out(
        "entry.create",
        json!({"book": b, "parent": acceptance::novel_root(e.ws(), &b, "tpl-elements"), "template": "tpl-character", "title": "老钟", "auto_link": false}),
    ));
    assert!(!switch(&e, &b, &quiet));

    let doc = chapter(&e, &b, "一", "安娜和林凯。");
    assert_eq!(links(&e, &doc), [("安娜".into(), anna.clone(), false)]);
    // Turned on, its names link from now on, and what was written while it
    // was off gets its links (in the background: `auto_link_backfill.rs`).
    set(&e, &b, &lin, true).unwrap();
    assert!(switch(&e, &b, &lin));
    assert!(e.ws().wait_for_link_backfill(WAIT));
    assert_eq!(
        links(&e, &doc),
        [
            ("安娜".into(), anna.clone(), false),
            ("林凯".into(), lin.clone(), false)
        ]
    );
    let doc2 = chapter(&e, &b, "二", "林凯回来了。");
    assert_eq!(links(&e, &doc2), [("林凯".into(), lin.clone(), false)]);
    // Moving it and switching its template leave the switch alone.
    e.call("entry.move", json!({"book": b, "id": lin, "parent": null}));
    e.call(
        "entry.update",
        json!({"book": b, "id": lin, "template": "tpl-location"}),
    );
    assert!(switch(&e, &b, &lin));
    // One step back is the switch off again.
    e.call("entry.move", json!({"book": b, "id": lin, "parent": misc}));
    set(&e, &b, &lin, false).unwrap();
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert!(switch(&e, &b, &lin));
}

#[test]
fn turning_an_entry_off_hides_its_automatic_links_and_leaves_the_text_byte_for_byte() {
    let e = env();
    let b = e.book();
    let anna = character(&e, &b, "安娜");
    let doc = chapter(&e, &b, "一", "安娜来了。");
    assert_eq!(shown(&e, &b, &doc), [("安娜".into(), LinkShow::Live)]);
    let before = stored(&e, &doc);

    set(&e, &b, &anna, false).unwrap();
    // The link is still in the text, as it was; it reads as text.
    assert_eq!(stored(&e, &doc), before);
    assert_eq!(links(&e, &doc), [("安娜".into(), anna.clone(), false)]);
    assert_eq!(shown(&e, &b, &doc), [("安娜".into(), LinkShow::Plain)]);
    // Its names no longer link.
    let doc2 = chapter(&e, &b, "二", "安娜又来了。");
    assert!(links(&e, &doc2).is_empty());

    set(&e, &b, &anna, true).unwrap();
    assert!(e.ws().wait_for_link_backfill(WAIT));
    assert_eq!(stored(&e, &doc), before);
    assert_eq!(shown(&e, &b, &doc), [("安娜".into(), LinkShow::Live)]);
    // What was written while it was off is linked after the fact (in the
    // background: `auto_link_backfill.rs`); what was linked stays as it was.
    assert_eq!(links(&e, &doc2), [("安娜".into(), anna.clone(), false)]);

    // The author's setting does the same for every automatic link.
    e.ws().set_auto_links(false);
    assert_eq!(shown(&e, &b, &doc), [("安娜".into(), LinkShow::Plain)]);
    e.ws().set_auto_links(true);
    assert!(e.ws().wait_for_link_backfill(WAIT));
    assert_eq!(stored(&e, &doc), before);
}

#[test]
fn a_link_picked_with_at_shows_whatever_the_switches_say() {
    let e = env();
    let b = e.book();
    let misc = create(&e, &b, None, "tpl-group", "杂项");
    let lin = create(&e, &b, Some(&misc), "tpl-character", "林凯");
    let doc = chapter(&e, &b, "一", "林凯来了。");
    assert!(links(&e, &doc).is_empty());
    pick(&e, &doc, 0..2, &lin);
    assert_eq!(links(&e, &doc), [("林凯".into(), lin.clone(), true)]);
    assert_eq!(shown(&e, &b, &doc), [("林凯".into(), LinkShow::Live)]);
    e.ws().set_auto_links(false);
    assert_eq!(shown(&e, &b, &doc), [("林凯".into(), LinkShow::Live)]);
    e.ws().set_auto_links(true);
    // The automatic rule leaves it alone: turning the entry on links no
    // name the picked link covers, and an Agent writing around it adds a
    // link of its own and keeps the picked one.
    set(&e, &b, &lin, true).unwrap();
    assert!(e.ws().wait_for_link_backfill(WAIT));
    assert_eq!(links(&e, &doc), [("林凯".into(), lin.clone(), true)]);
    by_agent(
        &e,
        "prose.replace",
        json!({"doc": doc, "find": "来了。", "replace": "来了，林凯笑了。"}),
    );
    assert_eq!(
        links(&e, &doc),
        [
            ("林凯".into(), lin.clone(), true),
            ("林凯".into(), lin.clone(), false)
        ]
    );
    // Off again: the picked one shows, the automatic one reads as text.
    set(&e, &b, &lin, false).unwrap();
    assert_eq!(
        shown(&e, &b, &doc),
        [
            ("林凯".into(), LinkShow::Live),
            ("林凯".into(), LinkShow::Plain)
        ]
    );
    // An entry in Recently Deleted: the picked link is gone, as any.
    e.call("entry.trash", json!({"book": b, "id": lin}));
    assert_eq!(shown(&e, &b, &doc)[0], ("林凯".into(), LinkShow::Gone));
}

#[test]
fn a_levels_switch_carries_what_lives_below_and_sets_what_is_made_there() {
    let e = env();
    let b = e.book();
    let misc = create(&e, &b, None, "tpl-group", "杂项");
    let a = create(&e, &b, Some(&misc), "tpl-character", "林凯");
    let sub = create(&e, &b, Some(&misc), "tpl-group", "旧人");
    let c = create(&e, &b, Some(&sub), "tpl-character", "老钟");
    for id in [&a, &sub, &c] {
        assert!(!switch(&e, &b, id));
    }
    let out = set_below(&e, &b, &misc, true).unwrap()["output"].clone();
    let mut changed: Vec<String> = out["changed"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    changed.sort();
    let mut want = vec![a.clone(), c.clone()];
    want.sort();
    assert_eq!(changed, want);
    // The group inside keeps its own switch: its template does not follow.
    assert!(switch(&e, &b, &a) && switch(&e, &b, &c) && !switch(&e, &b, &sub));
    // What is made in it from now on starts linked, inside the group too.
    let d = create(&e, &b, Some(&sub), "tpl-character", "小满");
    assert!(switch(&e, &b, &d));
    let level = e.out("entry.get", json!({"book": b, "id": misc}));
    assert_eq!(level["overrides"]["auto_link"], true);
    // Each entry can change afterwards on its own.
    set(&e, &b, &a, false).unwrap();
    assert!(!switch(&e, &b, &a) && switch(&e, &b, &c));

    // Off: every one below goes off and new ones start off; one undo is
    // the whole step.
    set_below(&e, &b, &misc, false).unwrap();
    for id in [&a, &c, &d] {
        assert!(!switch(&e, &b, id));
    }
    assert!(!switch(
        &e,
        &b,
        &create(&e, &b, Some(&misc), "tpl-character", "阿福")
    ));
    e.ws().undo(&Actor::User).unwrap().unwrap(); // the entry made last
    e.ws().undo(&Actor::User).unwrap().unwrap(); // the level's switch
    assert!(!switch(&e, &b, &a) && switch(&e, &b, &c) && switch(&e, &b, &d));
    let level = e.out("entry.get", json!({"book": b, "id": misc}));
    assert_eq!(level["overrides"]["auto_link"], true);

    // Only a level has entries living below it.
    let err = set_below(&e, &b, &a, true).unwrap_err();
    assert!(err.to_string().contains("level"), "{err}");
}

#[test]
fn names_are_unique_among_the_entries_that_link() {
    let e = env();
    let b = e.book();
    character(&e, &b, "安娜");
    let misc = create(&e, &b, None, "tpl-group", "杂项");
    // Off, a second 安娜 claims nothing.
    let other = create(&e, &b, Some(&misc), "tpl-character", "安娜");
    assert!(!switch(&e, &b, &other));
    // Turning it on would give the name to two: refused, nothing changes.
    let err = set(&e, &b, &other, true).unwrap_err();
    assert!(err.to_string().contains("V3-AUTOLINK-NAME-UNIQUE"), "{err}");
    let err = set_below(&e, &b, &misc, true).unwrap_err();
    assert!(err.to_string().contains("V3-AUTOLINK-NAME-UNIQUE"), "{err}");
    assert!(!switch(&e, &b, &other));
    let level = e.out("entry.get", json!({"book": b, "id": misc}));
    assert!(level["overrides"]["auto_link"].is_null());
}

#[test]
fn mentions_and_the_relation_graph_count_the_links_that_show() {
    let e = env();
    let b = e.book();
    let anna = character(&e, &b, "安娜");
    let lin = character(&e, &b, "林凯");
    let doc = chapter(&e, &b, "一", "安娜见了林凯。");
    let doc2 = chapter(&e, &b, "二", "林凯走了。");
    set(&e, &b, &lin, false).unwrap();
    // A picked link counts whatever its entry's switch says.
    let doc3 = chapter(&e, &b, "三", "又见林凯。");
    pick(&e, &doc3, 2..4, &lin);
    let mentions = |id: &str| {
        e.out("entry.mentions", json!({"book": b, "entry": id}))["total"]
            .as_u64()
            .unwrap()
    };
    assert_eq!(mentions(&anna), 1);
    assert_eq!(mentions(&lin), 1, "only the link picked with @");
    let graph = e.ws().entry_cooccurrences(&b).unwrap();
    assert_eq!(graph.mentions.get(&lin), Some(&1));
    assert!(
        graph.pairs.is_empty(),
        "林凯's automatic link reads as text"
    );

    set(&e, &b, &lin, true).unwrap();
    assert_eq!(mentions(&lin), 3);
    let graph = e.ws().entry_cooccurrences(&b).unwrap();
    assert_eq!(graph.mentions.get(&lin), Some(&3));
    assert_eq!(graph.pairs.len(), 1);

    // The author's setting: only links picked with @ count.
    e.ws().set_auto_links(false);
    assert_eq!(mentions(&anna), 0);
    assert_eq!(mentions(&lin), 1);
    let graph = e.ws().entry_cooccurrences(&b).unwrap();
    assert!(graph.pairs.is_empty() && !graph.mentions.contains_key(&anna));
    e.ws().set_auto_links(true);
    let _ = (doc, doc2);
}

#[test]
fn comment_links_picked_with_at_are_kept_as_such_and_follow_the_switches() {
    let e = env();
    let b = e.book();
    let anna = character(&e, &b, "安娜");
    let misc = create(&e, &b, None, "tpl-group", "杂项");
    let lin = create(&e, &b, Some(&misc), "tpl-character", "林凯");
    let body = |id: &str| {
        e.out("comment.list", json!({"book": b}))
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == id)
            .unwrap()["body"]
            .clone()
    };
    // 安娜 is linked by the plan, 林凯 is picked with @ (it is off).
    let c = id_of(&e.out(
        "comment.create",
        json!({"book": b, "body": {"text": "安娜见了林凯。", "links": [{"start": 4, "end": 6, "entry": lin}]}}),
    ));
    assert_eq!(
        body(&c)["links"],
        json!([
            {"start": 0, "end": 2, "entry": anna},
            {"start": 4, "end": 6, "entry": lin, "manual": true}
        ])
    );
    // 安娜 off: her automatic link reads as text, the picked one stays.
    set(&e, &b, &anna, false).unwrap();
    assert_eq!(
        body(&c)["links"],
        json!([{"start": 4, "end": 6, "entry": lin, "manual": true}])
    );
    // A plain edit elsewhere keeps the link the writer could not see.
    e.call(
        "comment.update",
        json!({"book": b, "id": c, "body": "那天安娜见了林凯。"}),
    );
    set(&e, &b, &anna, true).unwrap();
    assert_eq!(
        body(&c)["links"],
        json!([
            {"start": 2, "end": 4, "entry": anna},
            {"start": 6, "end": 8, "entry": lin, "manual": true}
        ])
    );
}
