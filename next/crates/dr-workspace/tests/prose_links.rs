//! `prose.link` and `prose.unlink` (`kernel-v5.md` §16 「自动链接」): a link
//! put on an entry is the author's kind (`manual`, the value a pick with @
//! writes), so it shows whatever the switches say and automatic linking
//! leaves it alone; the undo of either (`prose.restore_links`) puts back on
//! every run it changed exactly what was there — no link, an automatic link
//! or one made by hand — and refuses when another writer changed that link
//! since. A link carrying more than its target is left as it is.

mod common;

use common::*;
use dr_model::id::ModuleId;
use dr_model::kind::EntityKind;
use dr_model::v3::{EntityLinkV3, LinkShow};
use dr_workspace::Actor;
use dr_workspace::dto::AnchorBytes;
use serde_json::{Value, json};
use std::ops::Range;

fn agent() -> Actor {
    Actor::agent("s", 1, "c")
}

/// The whole outcome of the Agent's call.
fn by_agent(e: &Env, name: &str, input: Value) -> Value {
    call(e.ws(), &agent(), name, input)
}

fn id_of(v: &Value) -> String {
    v["id"].as_str().unwrap().to_owned()
}

/// A character in the writing template's 人物: its 「自动链接」 is on.
fn character(e: &Env, b: &str, name: &str) -> String {
    id_of(&acceptance::novel_entry(
        e.ws(),
        b,
        "tpl-character",
        name,
        None,
    ))
}

/// A character in a group the author made: its 「自动链接」 is off.
fn quiet_character(e: &Env, b: &str, name: &str) -> String {
    let misc = id_of(&e.out(
        "entry.create",
        json!({"book": b, "parent": null, "template": "tpl-group", "title": format!("{name}的组")}),
    ));
    id_of(&e.out(
        "entry.create",
        json!({"book": b, "parent": misc, "template": "tpl-character", "title": name}),
    ))
}

fn set(e: &Env, b: &str, id: &str, on: bool) {
    e.call(
        "entry.set_auto_link",
        json!({"book": b, "id": id, "auto_link": on}),
    );
}

/// A chapter the Agent writes, with `text` (the names of entries switched
/// on linked as it writes).
fn chapter(e: &Env, b: &str, title: &str, text: &str) -> String {
    let ms = acceptance::novel_root(e.ws(), &b, "tpl-manuscript");
    let id = id_of(
        &by_agent(
            e,
            "entry.create",
            json!({"book": b, "parent": ms, "template": "tpl-chapter", "title": title, "bodies": {"mod-prose": text}}),
        )["output"],
    );
    format!("body:{id}/mod-prose")
}

/// The links stored in `doc`: linked text, target, made by hand.
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

/// The whole stored state of `doc`, marks included: its value and the
/// body's rich text, every mark with its value.
fn stored(e: &Env, doc: &str) -> (loro::LoroValue, Vec<loro::TextDelta>) {
    let d = e.ws().library().load_copy(doc).unwrap();
    (
        d.get_deep_value(),
        d.get_text(dr_doc::schema::prose::BODY).to_delta(),
    )
}

/// The raw stored values of the link to `target` on `range` of `doc`.
fn values(
    e: &Env,
    doc: &str,
    range: Range<usize>,
    target: &str,
) -> Vec<(Range<usize>, Option<loro::LoroValue>)> {
    let s = e.ws().prose_session(doc).unwrap();
    let r = s.reader();
    r.view().entity_link_values(range, target).unwrap()
}

fn anchor(e: &Env, doc: &str, range: Range<usize>) -> Value {
    let s = e.ws().prose_session(doc).unwrap();
    let r = s.reader();
    let a = r.view().anchor(range).unwrap();
    serde_json::to_value(AnchorBytes::from(&a.encode())).unwrap()
}

/// The input of `prose.link` or `prose.unlink` for `ranges` of `doc`.
fn on_all(e: &Env, doc: &str, kind: &str, target: &str, ranges: Vec<Range<usize>>) -> Value {
    let anchors: Vec<Value> = ranges.into_iter().map(|r| anchor(e, doc, r)).collect();
    json!({"links": [{"doc": doc, "target": {"kind": kind, "id": target}, "anchors": anchors}]})
}

/// [`on_all`] for one range.
fn on(e: &Env, doc: &str, kind: &str, target: &str, range: Range<usize>) -> Value {
    on_all(e, doc, kind, target, vec![range])
}

/// A link written the way the editor writes one picked with @, or (with a
/// module) a link into one of the target's modules.
fn pick(e: &Env, doc: &str, range: Range<usize>, target: &str, module: Option<&str>) {
    let link = EntityLinkV3 {
        target: target.to_owned(),
        kind: EntityKind::Entry,
        module: module.map(|m| ModuleId::parse(m).unwrap()),
        block: None,
        end_block: None,
        manual: module.is_none(),
    };
    e.ws()
        .prose_session(doc)
        .unwrap()
        .edit(move |t| t.link_entity_v3(range, &link))
        .unwrap();
}

/// 「安娜来了，安娜笑了，安娜走了。」 with the first 安娜 linked
/// automatically, the second picked with @ and the third not linked.
fn three_ways(e: &Env, b: &str) -> (String, String) {
    let anna = character(e, b, "安娜");
    let doc = chapter(e, b, "一", "安娜来了，安娜笑了。");
    // The author's own command links nothing (the editor links what the
    // author types).
    e.call(
        "prose.replace",
        json!({"doc": doc, "find": "笑了。", "replace": "笑了，安娜走了。"}),
    );
    pick(e, &doc, 5..7, &anna, None);
    assert_eq!(
        links(e, &doc),
        [
            ("安娜".into(), anna.clone(), false),
            ("安娜".into(), anna.clone(), true)
        ]
    );
    (anna, doc)
}

#[test]
fn a_link_put_on_an_entry_is_the_authors_and_shows_whatever_the_switches_say() {
    let e = env();
    let b = e.book();
    let lin = quiet_character(&e, &b, "林凯");
    let doc = chapter(&e, &b, "一", "林凯来了。");
    assert!(links(&e, &doc).is_empty());

    let out = by_agent(&e, "prose.link", on(&e, &doc, "entry", &lin, 0..2));
    assert_eq!(out["output"], json!({"ranges": 1, "docs": 1}));
    assert_eq!(links(&e, &doc), [("林凯".into(), lin.clone(), true)]);
    // Its entry's switch is off, and the author's setting may be off: it
    // is a link either way.
    assert_eq!(shown(&e, &b, &doc), [("林凯".into(), LinkShow::Live)]);
    e.ws().set_auto_links(false);
    assert_eq!(shown(&e, &b, &doc), [("林凯".into(), LinkShow::Live)]);
    e.ws().set_auto_links(true);

    // The value is the one a pick with @ writes.
    let picked = chapter(&e, &b, "二", "林凯来了。");
    pick(&e, &picked, 0..2, &lin, None);
    assert_eq!(
        values(&e, &doc, 0..2, &lin),
        values(&e, &picked, 0..2, &lin)
    );

    // Automatic linking leaves it alone: with the entry on, an Agent writing
    // next to it links its own name and keeps this one as it is.
    set(&e, &b, &lin, true);
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
    set(&e, &b, &lin, false);
    assert_eq!(
        shown(&e, &b, &doc),
        [
            ("林凯".into(), LinkShow::Live),
            ("林凯".into(), LinkShow::Plain)
        ]
    );
}

/// A file of the asset library has no switch: its link is written as the
/// editor writes one (no `manual`), and its undo takes it off again.
#[test]
fn a_link_to_a_file_is_written_as_the_editor_writes_it() {
    use dr_store::asset::SourceImport;
    let e = env();
    let b = e.book();
    let src = e.dir.path().join("map.png");
    std::fs::write(&src, b"\x89PNG\r\n\x1a\nap-map").unwrap();
    let file = e
        .ws()
        .library()
        .import_asset(&SourceImport {
            book_id: &b,
            asset_id: "asset-ap-map",
            source: &src,
            mime: "image/png",
            ext: "png",
            dimensions: Some((2, 2)),
            limit: 1 << 20,
        })
        .unwrap();
    e.call(
        "asset.put",
        json!({
            "book": b, "id": "asset-ap-map", "name": "map.png", "kind": "image",
            "mime": file.mime, "size": file.size, "sha256": file.sha256,
            "width": 2, "height": 2
        }),
    );
    let doc = chapter(&e, &b, "一", "参见地图。");
    let before = stored(&e, &doc);
    by_agent(
        &e,
        "prose.link",
        on(&e, &doc, "asset", "asset-ap-map", 2..4),
    );
    let file = loro::LoroValue::Map(vec![("kind".to_owned(), "asset".into())].into());
    assert_eq!(
        values(&e, &doc, 0..5, "asset-ap-map"),
        vec![(0..2, None), (2..4, Some(file)), (4..5, None)]
    );
    e.ws().undo(&agent()).unwrap().unwrap();
    assert_eq!(stored(&e, &doc), before);
}

#[test]
fn the_undo_of_a_link_puts_back_no_link_an_automatic_one_or_one_made_by_hand() {
    let e = env();
    let b = e.book();
    let (anna, doc) = three_ways(&e, &b);
    let before = stored(&e, &doc);
    let picked = values(&e, &doc, 5..7, &anna)[0].1.clone();

    // Each way on its own, then all three in one range.
    for (range, changed) in [(10..12, 1), (0..2, 1), (5..7, 0), (0..12, 1)] {
        let out = by_agent(
            &e,
            "prose.link",
            on(&e, &doc, "entry", &anna, range.clone()),
        );
        assert_eq!(out["output"]["ranges"], changed, "{range:?}");
        // Wherever it ran, the link is the one made by hand now.
        assert_eq!(
            values(&e, &doc, range.clone(), &anna),
            vec![(range.clone(), picked.clone())],
            "{range:?}"
        );
        let after = stored(&e, &doc);
        if changed == 0 {
            // Nothing changed: nothing to undo.
            assert_eq!(after, before);
            assert_eq!(out["undo"], json!([]), "{out}");
            continue;
        }
        assert_eq!(out["undo"][0]["command"], "prose.restore_links", "{out}");
        e.ws().undo(&agent()).unwrap().unwrap();
        assert_eq!(stored(&e, &doc), before, "{range:?}");
        e.ws().redo(&agent()).unwrap().unwrap();
        assert_eq!(stored(&e, &doc), after, "{range:?}");
        e.ws().undo(&agent()).unwrap().unwrap();
        assert_eq!(stored(&e, &doc), before, "{range:?}");
    }
    // The automatic one is automatic again: it follows its entry's switch.
    set(&e, &b, &anna, false);
    assert_eq!(
        shown(&e, &b, &doc),
        [
            ("安娜".into(), LinkShow::Plain),
            ("安娜".into(), LinkShow::Live)
        ]
    );
}

#[test]
fn unlinking_takes_off_automatic_and_hand_made_links_and_its_undo_puts_them_back() {
    let e = env();
    let b = e.book();
    let (anna, doc) = three_ways(&e, &b);
    let before = stored(&e, &doc);
    let out = by_agent(&e, "prose.unlink", on(&e, &doc, "entry", &anna, 0..12));
    assert_eq!(out["output"], json!({"ranges": 1, "docs": 1}));
    assert!(links(&e, &doc).is_empty());
    let after = stored(&e, &doc);
    e.ws().undo(&agent()).unwrap().unwrap();
    assert_eq!(stored(&e, &doc), before);
    assert_eq!(
        links(&e, &doc),
        [
            ("安娜".into(), anna.clone(), false),
            ("安娜".into(), anna.clone(), true)
        ]
    );
    e.ws().redo(&agent()).unwrap().unwrap();
    assert_eq!(stored(&e, &doc), after);
    // A range with no link to it changes nothing.
    let out = by_agent(&e, "prose.unlink", on(&e, &doc, "entry", &anna, 0..2));
    assert_eq!(out["output"]["ranges"], 0);
    assert_eq!(out["undo"], json!([]));
}

/// What the Agent's result says to undo is a call like any other: run as it
/// stands (an Agent's receipt replayed), it puts back what was there, and
/// what that run says to undo puts the link back on.
#[test]
fn the_undo_in_the_result_replays_as_it_stands() {
    let e = env();
    let b = e.book();
    let (anna, doc) = three_ways(&e, &b);
    let before = stored(&e, &doc);
    let out = by_agent(&e, "prose.link", on(&e, &doc, "entry", &anna, 0..12));
    let after = stored(&e, &doc);
    let replay = |undo: &Value| -> Value {
        let calls = undo.as_array().unwrap();
        assert_eq!(calls.len(), 1, "{undo}");
        // Through JSON text, as a receipt keeps it.
        let input: Value = serde_json::from_str(&calls[0]["input"].to_string()).unwrap();
        call(
            e.ws(),
            &agent(),
            calls[0]["command"].as_str().unwrap(),
            input,
        )
    };
    let undone = replay(&out["undo"]);
    assert_eq!(stored(&e, &doc), before);
    replay(&undone["undo"]);
    assert_eq!(stored(&e, &doc), after);
    // Run once more after it already took effect: nothing left to do.
    let again = call(
        e.ws(),
        &agent(),
        "prose.restore_links",
        undone["undo"][0]["input"].clone(),
    );
    assert_eq!(again["output"]["ranges"], 0);
    assert_eq!(stored(&e, &doc), after);
}

#[test]
fn a_link_into_a_module_is_left_as_it_is() {
    let e = env();
    let b = e.book();
    let anna = character(&e, &b, "安娜");
    set(&e, &b, &anna, false);
    let doc = chapter(&e, &b, "一", "安娜来了。");
    pick(&e, &doc, 0..2, &anna, Some("mod-prose"));
    let before = stored(&e, &doc);
    for command in ["prose.link", "prose.unlink"] {
        let refused = e
            .ws()
            .call(&agent(), command, on(&e, &doc, "entry", &anna, 0..4));
        assert!(refused.is_err(), "{command}");
        assert_eq!(stored(&e, &doc), before, "{command}");
    }
}

/// The undo puts a run back only where the link still reads what the write
/// left: a run another writer already put back is left alone, a run whose
/// text is gone is skipped, and a link changed otherwise refuses the undo.
#[test]
fn the_undo_leaves_what_another_writer_changed_since() {
    let e = env();
    let b = e.book();
    let (anna, doc) = three_ways(&e, &b);
    let before = stored(&e, &doc);

    // The author takes part of the new link off again: the undo puts back
    // the rest.
    by_agent(&e, "prose.link", on(&e, &doc, "entry", &anna, 10..12));
    e.ws()
        .prose_session(&doc)
        .unwrap()
        .edit({
            let anna = anna.clone();
            move |t| t.unlink_entity(10..11, &anna)
        })
        .unwrap();
    e.ws().undo(&agent()).unwrap().unwrap();
    assert_eq!(stored(&e, &doc), before);

    // The author makes it a link into a module: the undo is refused and
    // changes nothing.
    by_agent(&e, "prose.link", on(&e, &doc, "entry", &anna, 10..12));
    pick(&e, &doc, 10..12, &anna, Some("mod-prose"));
    let changed = stored(&e, &doc);
    let refused = e.ws().undo(&agent());
    assert!(
        matches!(refused, Err(dr_workspace::WsError::Conflict(_))),
        "{refused:?}"
    );
    assert_eq!(stored(&e, &doc), changed);

    // Text typed inside the span is part of it; text deleted is skipped.
    let e = env();
    let b = e.book();
    let (anna, doc) = three_ways(&e, &b);
    by_agent(
        &e,
        "prose.link",
        on_all(&e, &doc, "entry", &anna, vec![0..2, 10..12]),
    );
    e.ws()
        .prose_session(&doc)
        .unwrap()
        .edit(|t| {
            t.delete(10..12)?;
            t.insert_text(1, "小")
        })
        .unwrap();
    e.ws().undo(&agent()).unwrap().unwrap();
    let auto = encode(&anna, false);
    assert_eq!(
        values(&e, &doc, 0..3, &anna),
        vec![(0..3, Some(auto))],
        "安小娜 is the automatic link it was"
    );
    assert_eq!(
        links(&e, &doc),
        [
            ("安小娜".into(), anna.clone(), false),
            ("安娜".into(), anna.clone(), true)
        ]
    );
}

fn encode(target: &str, manual: bool) -> loro::LoroValue {
    dr_doc::prose::v3::encode_entity_link(
        &EntityLinkV3 {
            target: target.to_owned(),
            kind: EntityKind::Entry,
            module: None,
            block: None,
            end_block: None,
            manual,
        },
        None,
    )
    .unwrap()
}

/// `prose.restore_links` takes only what it can put back exactly: link
/// values that are objects (or null), an entry's or a file's id, a prose
/// document; a link it would put back needs its target.
#[test]
fn restore_links_refuses_what_it_cannot_put_back() {
    let e = env();
    let b = e.book();
    let (anna, doc) = three_ways(&e, &b);
    let before = stored(&e, &doc);
    let span = |expected: Value, value: Value| json!({"links": [{"doc": doc, "target": anna, "spans": [{"anchor": anchor(&e, &doc, 10..12), "expected": expected, "value": value}]}]});
    let manual = Value::from(encode(&anna, true));
    for bad in [
        span(Value::Null, json!("entry")),
        span(Value::Null, json!({"kind": "entry", "n": u64::MAX})),
        {
            let mut v = span(Value::Null, manual.clone());
            v["links"][0]["target"] = json!("");
            v
        },
        {
            let mut v = span(Value::Null, manual.clone());
            v["links"][0]["doc"] = json!(format!("book:{b}"));
            v
        },
    ] {
        assert!(
            e.try_call("prose.restore_links", bad.clone()).is_err(),
            "{bad}"
        );
        assert_eq!(stored(&e, &doc), before, "{bad}");
    }
    // A link to an entry deleted for good is not put back: not found.
    let gone = quiet_character(&e, &b, "老钟");
    let mut purged = span(Value::Null, Value::from(encode(&gone, true)));
    purged["links"][0]["target"] = json!(gone);
    e.call("entry.trash", json!({"book": b, "id": gone}));
    e.call("entry.purge", json!({"book": b, "id": gone}));
    assert!(matches!(
        e.try_call("prose.restore_links", purged),
        Err(dr_workspace::WsError::NotFound { .. })
    ));
    assert_eq!(stored(&e, &doc), before);
    // A good one, as the author: written, and undone.
    let out = e.call("prose.restore_links", span(Value::Null, manual));
    assert_eq!(out["output"]["ranges"], 1);
    assert_eq!(links(&e, &doc).len(), 3);
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert_eq!(stored(&e, &doc), before);
}
