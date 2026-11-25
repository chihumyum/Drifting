//! Turning automatic linking on links what is already written
//! (`kernel-v5.md` §16, the author 2026-11-24): an entry's own switch, a
//! level's, the author's setting; in the background, every link already
//! written left as it was byte for byte, longest names first, never on
//! anyone's undo, never in a document being composed in, carried on after a
//! quit; another device's switch is not backfilled here. And the two things
//! around it: a refused switch names the clash, a project template carries
//! each entry's switch.

mod common;

use std::time::Duration;

use common::*;
use dr_model::kind::EntityKind;
use dr_model::v3::EntityLinkV3;
use dr_workspace::autolink::backfill::SCOPE;
use dr_workspace::{Actor, WritePreconditions, WsError};
use serde_json::{Value, json};

const WAIT: Duration = Duration::from_secs(20);

fn agent() -> Actor {
    Actor::agent("s", 1, "c")
}

fn id_of(v: &Value) -> String {
    v["id"].as_str().unwrap().to_owned()
}

fn settle(e: &Env) {
    assert!(e.ws().wait_for_link_backfill(WAIT), "the backfill settles");
}

/// A character in the writing template's 人物 (its switch starts on).
fn character(e: &Env, b: &str, name: &str) -> String {
    id_of(&acceptance::novel_entry(
        e.ws(),
        b,
        "tpl-character",
        name,
        None,
    ))
}

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

/// A chapter written by `actor` (the author's commands link nothing, an
/// Agent's link the names of the entries whose switch is on).
fn chapter_by(e: &Env, actor: &Actor, b: &str, title: &str, text: &str) -> String {
    let ms = acceptance::novel_root(e.ws(), &b, "tpl-manuscript");
    let id = id_of(
        &call(
            e.ws(),
            actor,
            "entry.create",
            json!({"book": b, "parent": ms, "template": "tpl-chapter", "title": title, "bodies": {"mod-prose": text}}),
        )["output"],
    );
    format!("body:{id}/mod-prose")
}

fn chapter(e: &Env, b: &str, title: &str, text: &str) -> String {
    chapter_by(e, &Actor::User, b, title, text)
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

/// Every raw link mark of `doc`: range, key, value as stored.
fn marks(e: &Env, doc: &str) -> Vec<(std::ops::Range<usize>, String, loro::LoroValue)> {
    let s = e.ws().prose_session(doc).unwrap();
    let r = s.reader();
    let v = r.view();
    v.copy_entity_links_v3(0..v.len())
        .unwrap()
        .marks()
        .iter()
        .map(|(r, k, v)| (r.clone(), k.to_string(), v.clone()))
        .collect()
}

/// The whole stored state of document `doc`: its value and its version.
fn stored(e: &Env, doc: &str) -> (loro::LoroValue, loro::Frontiers) {
    let d = e.ws().library().load_copy(doc).unwrap();
    (d.get_deep_value(), d.oplog_frontiers())
}

/// A link picked with @ on `range` of `doc`, as the editor writes it.
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

fn comment_links(e: &Env, b: &str, id: &str) -> Value {
    e.out("comment.list", json!({"book": b}))
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == id)
        .unwrap()["body"]["links"]
        .clone()
}

fn row(e: &Env, b: &str) -> Option<String> {
    e.ws().library().local_get(SCOPE, b).unwrap()
}

#[test]
fn turning_an_entry_on_links_its_names_written_while_it_was_off_and_nothing_else() {
    let e = env();
    let b = e.book();
    let anna = character(&e, &b, "安娜");
    let misc = create(&e, &b, None, "tpl-group", "杂项");
    let lin = create(&e, &b, Some(&misc), "tpl-character", "林凯");
    let zhong = create(&e, &b, Some(&misc), "tpl-character", "老钟");
    assert!(!switch(&e, &b, &lin) && !switch(&e, &b, &zhong));
    // Written while 林凯 was off: 安娜 is linked, 林凯 is not.
    let doc = chapter_by(&e, &agent(), &b, "一", "安娜见了林凯。林凯笑了，老钟没笑。");
    assert_eq!(links(&e, &doc), [("安娜".into(), anna.clone(), false)]);
    // The author picked one 林凯 with @ in another chapter.
    let doc2 = chapter(&e, &b, "二", "林凯说：林凯回来了。");
    pick(&e, &doc2, 0..2, &lin);
    let anna_mark = marks(&e, &doc);
    let picked_mark = marks(&e, &doc2);
    let untouched = chapter(&e, &b, "三", "这一章没有名字。");
    let untouched_before = stored(&e, &untouched);

    set(&e, &b, &lin, true).unwrap();
    settle(&e);
    // Every 林凯 written is an automatic link now; 安娜's link and the
    // picked one are as they were, byte for byte; 老钟 is off.
    assert_eq!(
        links(&e, &doc),
        [
            ("安娜".into(), anna.clone(), false),
            ("林凯".into(), lin.clone(), false),
            ("林凯".into(), lin.clone(), false),
        ]
    );
    assert!(marks(&e, &doc).contains(&anna_mark[0]));
    assert_eq!(
        links(&e, &doc2),
        [
            ("林凯".into(), lin.clone(), true),
            ("林凯".into(), lin.clone(), false),
        ]
    );
    assert!(marks(&e, &doc2).contains(&picked_mark[0]));
    // A chapter without the name is not written at all.
    assert_eq!(stored(&e, &untouched), untouched_before);
    // Nothing is left to do.
    assert_eq!(row(&e, &b), None);

    // Off and on again: the text stays as it is, byte for byte.
    let after = (stored(&e, &doc), stored(&e, &doc2));
    set(&e, &b, &lin, false).unwrap();
    set(&e, &b, &lin, true).unwrap();
    settle(&e);
    assert_eq!((stored(&e, &doc), stored(&e, &doc2)), after);

    // The undo of the switch is the switch only: the links stay in the text
    // and read as text.
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert!(!switch(&e, &b, &lin));
    assert_eq!((stored(&e, &doc), stored(&e, &doc2)), after);
    let _ = zhong;
}

#[test]
fn a_levels_switch_links_what_lives_below_it_and_the_setting_links_every_entry_on() {
    let e = env();
    let b = e.book();
    let misc = create(&e, &b, None, "tpl-group", "杂项");
    let lin = create(&e, &b, Some(&misc), "tpl-character", "林凯");
    let sub = create(&e, &b, Some(&misc), "tpl-group", "旧人");
    let zhong = create(&e, &b, Some(&sub), "tpl-character", "老钟");
    let doc = chapter(&e, &b, "一", "林凯和老钟。");
    assert!(links(&e, &doc).is_empty());
    set_below(&e, &b, &misc, true).unwrap();
    settle(&e);
    assert_eq!(
        links(&e, &doc),
        [
            ("林凯".into(), lin.clone(), false),
            ("老钟".into(), zhong.clone(), false),
        ]
    );

    // The author's setting: while it is off nothing is linked, a switch
    // turned on included; turned on, every entry whose switch is on, in the
    // prose, the comments and the relation descriptions.
    let anna = character(&e, &b, "安娜");
    let misc2 = create(&e, &b, None, "tpl-group", "外人");
    let fu = create(&e, &b, Some(&misc2), "tpl-character", "阿福");
    e.ws().set_auto_links(false);
    let doc2 = chapter_by(&e, &agent(), &b, "二", "安娜见了阿福和林凯。");
    let note = id_of(&e.out(
        "comment.create",
        json!({"book": b, "body": "安娜和阿福都该出场。"}),
    ));
    let rel = id_of(&e.out(
        "relation_type.create",
        json!({"book": b, "name": "师徒", "description": "安娜教过林凯。", "direction": "directed"}),
    ));
    set(&e, &b, &fu, true).unwrap();
    settle(&e);
    assert!(links(&e, &doc2).is_empty());
    assert_eq!(comment_links(&e, &b, &note), json!([]));

    e.ws().set_auto_links(true);
    settle(&e);
    assert_eq!(
        links(&e, &doc2),
        [
            ("安娜".into(), anna.clone(), false),
            ("阿福".into(), fu.clone(), false),
            ("林凯".into(), lin.clone(), false),
        ]
    );
    assert_eq!(
        comment_links(&e, &b, &note),
        json!([
            {"start": 0, "end": 2, "entry": anna},
            {"start": 3, "end": 5, "entry": fu},
        ])
    );
    let description = e
        .out("relation_type.list", json!({"book": b}))
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == rel)
        .unwrap()["description"]["links"]
        .clone();
    assert_eq!(
        description,
        json!([
            {"start": 0, "end": 2, "entry": anna},
            {"start": 4, "end": 6, "entry": lin},
        ])
    );
}

#[test]
fn the_longest_name_wins_and_only_the_entries_turned_on_are_linked() {
    let e = env();
    let b = e.book();
    // 石桥镇 is on but never linked in this chapter (the author's command
    // links nothing); 石桥 is off until it is turned on.
    let town = character(&e, &b, "石桥镇");
    let misc = create(&e, &b, None, "tpl-group", "杂项");
    let bridge = create(&e, &b, Some(&misc), "tpl-location", "石桥");
    let doc = chapter(&e, &b, "一", "石桥镇的石桥。");
    set(&e, &b, &bridge, true).unwrap();
    settle(&e);
    // 「石桥镇」 is the longer name, not turned on now: left as it is, and
    // the 石桥 in it is not 石桥's.
    assert_eq!(links(&e, &doc), [("石桥".into(), bridge.clone(), false)]);
    let at: Vec<_> = marks(&e, &doc).into_iter().map(|(r, _, _)| r).collect();
    assert_eq!(at, vec![std::ops::Range { start: 4, end: 6 }]);
    let _ = town;
}

#[test]
fn a_document_being_composed_in_waits_and_what_a_quit_left_is_finished_at_the_next_opening() {
    let mut e = env();
    let b = e.book();
    let misc = create(&e, &b, None, "tpl-group", "杂项");
    let lin = create(&e, &b, Some(&misc), "tpl-character", "林凯");
    let doc = chapter(&e, &b, "一", "林凯来了。");
    let doc2 = chapter(&e, &b, "二", "林凯走了。");

    // The author is composing in 「一」: it waits; 「二」 does not.
    let s = e.ws().prose_session(&doc).unwrap();
    s.set_composing(true);
    set(&e, &b, &lin, true).unwrap();
    let deadline = std::time::Instant::now() + WAIT;
    while links(&e, &doc2).is_empty() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(links(&e, &doc2), [("林凯".into(), lin.clone(), false)]);
    std::thread::sleep(Duration::from_millis(300));
    assert!(
        links(&e, &doc).is_empty(),
        "nothing is written while composing"
    );
    assert!(!e.ws().wait_for_link_backfill(Duration::from_millis(50)));
    // What is left is kept on this device.
    let left = row(&e, &b).expect("the book's row");
    assert!(left.contains(&lin), "{left}");

    // The app quits half way: the worker stops; the row stays.
    e.ws().close();
    drop(s);
    assert!(row(&e, &b).is_some());
    e.reopen();
    assert!(row(&e, &b).is_some());
    // The book opens again: it carries on.
    assert!(switch(&e, &b, &lin));
    settle(&e);
    assert_eq!(links(&e, &doc), [("林凯".into(), lin.clone(), false)]);
    assert_eq!(row(&e, &b), None);

    // Composing ends: it is written then.
    let zhong = create(&e, &b, Some(&misc), "tpl-character", "老钟");
    let doc3 = chapter(&e, &b, "三", "老钟来了。");
    let s = e.ws().prose_session(&doc3).unwrap();
    s.set_composing(true);
    set(&e, &b, &zhong, true).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    assert!(links(&e, &doc3).is_empty());
    assert!(!s.can_undo());
    s.set_composing(false);
    settle(&e);
    assert_eq!(links(&e, &doc3), [("老钟".into(), zhong.clone(), false)]);
    // Never on the author's undo.
    assert!(!s.can_undo());
}

/// Creating an auto-linked entry, renaming it, adding an alias, or restoring
/// it from Recently Deleted backfills existing prose in the background.
#[test]
fn a_rename_new_alias_create_or_restore_backfills_existing_prose() {
    let e = env();
    let b = e.book();
    let anna = character(&e, &b, "安娜");
    let doc = chapter(&e, &b, "一", "小安和安妮来了，阿青也来了。");
    e.call(
        "entry.update",
        json!({"book": b, "id": anna, "title": "安妮"}),
    );
    e.call(
        "module.set_field",
        json!({"book": b, "entry": anna, "module": "mod-fields", "field": "aliases", "value": ["小安"]}),
    );
    let qing = character(&e, &b, "阿青");
    settle(&e);
    assert_eq!(
        links(&e, &doc),
        [
            ("小安".into(), anna.clone(), false),
            ("安妮".into(), anna.clone(), false),
            ("阿青".into(), qing.clone(), false),
        ]
    );
    assert_eq!(row(&e, &b), None);

    // Restoring a trashed auto-linked entry backfills prose written while it was trashed.
    e.call("entry.trash", json!({"book": b, "id": qing}));
    let doc2 = chapter(&e, &b, "二", "阿青回来了。");
    assert!(links(&e, &doc2).is_empty());
    e.call("entry.restore", json!({"book": b, "id": qing}));
    settle(&e);
    assert_eq!(links(&e, &doc2), [("阿青".into(), qing, false)]);
}

#[test]
fn an_agent_that_read_the_text_before_reads_it_again() {
    let e = env();
    let b = e.book();
    let misc = create(&e, &b, None, "tpl-group", "杂项");
    let lin = create(&e, &b, Some(&misc), "tpl-character", "林凯");
    let doc = chapter(&e, &b, "一", "林凯来了。");
    let read = e.ws().version(&doc).unwrap();
    set(&e, &b, &lin, true).unwrap();
    settle(&e);
    assert_ne!(e.ws().version(&doc).unwrap(), read);
    let guard = WritePreconditions {
        versions: [(doc.clone(), read)].into(),
        ..WritePreconditions::default()
    };
    let err = e
        .ws()
        .call_guarded(
            &agent(),
            "prose.replace",
            json!({"doc": doc, "find": "来了", "replace": "走了"}),
            guard,
        )
        .unwrap_err();
    assert_eq!(err.code(), "conflict", "{err}");
}

#[test]
fn another_devices_switch_is_not_backfilled_here() {
    use loro::ExportMode;
    let a = env();
    let z = env();
    let b = a.book();
    let misc = create(&a, &b, None, "tpl-group", "杂项");
    let lin = create(&a, &b, Some(&misc), "tpl-character", "林凯");
    let doc = chapter(&a, &b, "一", "林凯来了。");
    let sync = |from: &Env, to: &Env, only_book: bool| {
        let mut docs = from.ws().library().docs(None, None).unwrap();
        // The book first: its prose needs it.
        docs.sort_by_key(|d| !d.doc_id.starts_with("book:"));
        for d in docs {
            if only_book && !d.doc_id.starts_with("book:") {
                continue;
            }
            let Ok(copy) = from.ws().library().load_copy(&d.doc_id) else {
                continue;
            };
            let bytes = copy.export(ExportMode::all_updates()).unwrap();
            let book = d.book_id.clone().unwrap_or_default();
            to.ws()
                .import_remote(&d.doc_id, Some((&d.kind, &book)), bytes, &Actor::Sync)
                .unwrap();
        }
    };
    sync(&a, &z, false);
    assert!(links(&z, &doc).is_empty());
    // Device A turns 林凯 on; Z gets the switch before A's linked text.
    a.ws().set_auto_links(false);
    set(&a, &b, &lin, true).unwrap();
    sync(&a, &z, true);
    settle(&z);
    assert!(switch(&z, &b, &lin));
    assert!(links(&z, &doc).is_empty(), "Z waits for A's text");
    assert_eq!(row(&z, &b), None);
    // A links it; the text comes over with its link.
    a.ws().set_auto_links(true);
    settle(&a);
    assert_eq!(links(&a, &doc), [("林凯".into(), lin.clone(), false)]);
    sync(&a, &z, false);
    settle(&z);
    assert_eq!(links(&z, &doc), [("林凯".into(), lin.clone(), false)]);
}

#[test]
fn a_refused_switch_names_the_name_and_whose_it_is() {
    let e = env();
    let b = e.book();
    let anna = character(&e, &b, "安娜");
    let misc = create(&e, &b, None, "tpl-group", "杂项");
    let other = create(&e, &b, Some(&misc), "tpl-character", "安娜贝尔");
    e.call(
        "module.set_field",
        json!({"book": b, "entry": other, "module": "mod-fields", "field": "aliases", "value": ["小安", "安娜"]}),
    );
    for err in [
        set(&e, &b, &other, true).unwrap_err(),
        set_below(&e, &b, &misc, true).unwrap_err(),
    ] {
        let WsError::Violation(v) = &err else {
            panic!("{err}");
        };
        assert_eq!(v.invariant, "V3-AUTOLINK-NAME-UNIQUE");
        let clash = v.clash.as_ref().expect("the clash");
        assert_eq!(clash.name, "安娜");
        assert_eq!(clash.entry, other);
        assert_eq!(clash.other, anna);
        assert_eq!(clash.other_title, "安娜");
        // An Agent and MCP read the message: both names, the other's id.
        let message = err.to_string();
        for part in ["\"安娜\"", &anna, "V3-AUTOLINK-NAME-UNIQUE"] {
            assert!(message.contains(part), "{message}");
        }
    }
    assert!(!switch(&e, &b, &other));
}

#[test]
fn a_project_template_carries_each_entrys_own_switch() {
    let e = env();
    let a = e.book();
    // 安娜 starts on where she lives and is turned off; 林凯 starts off in
    // a group the author made and is turned on.
    let anna = character(&e, &a, "安娜");
    set(&e, &a, &anna, false).unwrap();
    let misc = create(&e, &a, None, "tpl-group", "杂项");
    let lin = create(&e, &a, Some(&misc), "tpl-character", "林凯");
    set(&e, &a, &lin, true).unwrap();
    settle(&e);
    let saved = e.out(
        "project_template.save",
        json!({"book": a, "name": "带开关", "description": "", "sample_entries": [anna, lin]}),
    );
    let tpl = id_of(&saved);
    let value = e.out("project_template.get", json!({"id": tpl}))["value"].clone();
    let carried = |title: &str| {
        value["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|x| x["title"] == title)
            .unwrap()["auto_link"]
            .clone()
    };
    assert_eq!(carried("安娜"), json!(false));
    assert_eq!(carried("林凯"), json!(true));

    let made = id_of(&e.out(
        "project.create",
        json!({"name": "从模板", "template_id": tpl}),
    ));
    let entries = e.out("entry.list", json!({"book": made, "all": true}));
    let made_switch = |title: &str| {
        entries
            .as_array()
            .unwrap()
            .iter()
            .find(|x| x["title"] == title)
            .unwrap()["auto_link"]
            .as_bool()
            .unwrap()
    };
    assert!(!made_switch("安娜"));
    assert!(made_switch("林凯"));
}
