//! Snapshot history (M09): history points of a prose document, a preview
//! of one, and restoring one per entity.

mod common;

use common::*;
use dr_model::prose::Heading;
use dr_store::history::LabelRetention;
use dr_workspace::{Actor, WsError};
use serde_json::{Value, json};

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

/// A history point at the document's current stored version, `ago_ms` in
/// the past (storage dates its own points; a test cannot wait 15 minutes).
fn point_now(e: &Env, doc: &str, ago_ms: i64) -> i64 {
    let lib = e.ws().library();
    let head = lib.head(doc).unwrap().unwrap();
    let ts = now_ms() - ago_ms;
    assert!(
        lib.label_at(
            doc,
            &head.frontiers,
            "periodic",
            ts,
            LabelRetention::Thinned
        )
        .unwrap()
    );
    ts
}

/// The point taken at `ts`.
fn point_at(e: &Env, doc: &str, ts: i64) -> Value {
    points(e, doc)["points"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["ts"] == ts)
        .unwrap_or_else(|| panic!("no point at {ts}: {}", points(e, doc)))
        .clone()
}

fn points(e: &Env, doc: &str) -> Value {
    e.out("history.points", json!({"doc": doc}))
}

/// The point whose excerpt starts with `text`.
fn point_with(e: &Env, doc: &str, text: &str) -> Value {
    points(e, doc)["points"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["excerpt"].as_str().unwrap().starts_with(text))
        .unwrap_or_else(|| panic!("no point starting {text:?}: {}", points(e, doc)))
        .clone()
}

fn texts(e: &Env, doc: &str) -> Vec<Value> {
    field(
        &e.out("prose.read", json!({"doc": doc}))["paragraphs"],
        "text",
    )
}

#[test]
fn points_preview_and_restore_a_chapter() {
    let e = env();
    let b = e.book();
    let c = e.out(
        "chapter.create",
        json!({"book": b, "title": "One", "summary": "first", "text": "第一段。\n第二段。"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    let doc = format!("node:{c}");
    let s = e.ws().prose_session(&doc).unwrap();
    s.edit(|t| t.set_heading(0, Some(Heading::H1))).unwrap();
    let ts = point_now(&e, &doc, 20 * 60_000);

    // The author writes on and renames the chapter.
    e.call(
        "prose.replace",
        json!({"doc": doc, "find": "第一段", "replace": "改过的第一段"}),
    );
    e.call(
        "chapter.update",
        json!({"book": b, "id": c, "title": "Renamed", "summary": "second"}),
    );
    let list = points(&e, &doc);
    assert_eq!(list["doc"], json!(doc));
    let all = list["points"].as_array().unwrap();
    assert!(
        all.windows(2)
            .all(|w| w[0]["ts"].as_i64() >= w[1]["ts"].as_i64()),
        "newest first: {list}"
    );
    let p = point_at(&e, &doc, ts);
    assert_eq!(p["kind"], "auto");
    assert_eq!(p["title"], "One", "the title then");
    assert_eq!(p["excerpt"], "第一段。 第二段。");
    assert_eq!(p["words"], 6);

    // Preview: paragraphs with their levels, and the owner's fields then.
    let pv = e.out("history.preview", json!({"doc": doc, "point": p["id"]}));
    assert_eq!(
        pv["paragraphs"],
        json!([{"heading": 1, "text": "第一段。"}, {"heading": null, "text": "第二段。"}])
    );
    assert_eq!(pv["title"], "One");
    assert_eq!(pv["summary"], "first");
    assert_eq!(pv["same_as_now"], false);

    // Restore: the prose and the chapter's fields go back; nothing else.
    let out = e.call(
        "history.restore_point",
        json!({"doc": doc, "point": p["id"]}),
    );
    assert_eq!(out["output"]["prose"], true);
    assert_eq!(out["output"]["fields"], json!(["title", "summary"]));
    assert_eq!(texts(&e, &doc), [json!("第一段。"), json!("第二段。")]);
    let ch = &e.out("chapter.list", json!({"book": b}))[0];
    assert_eq!(
        (ch["title"].clone(), ch["summary"].clone()),
        (json!("One"), json!("first"))
    );
    // The version before the restore became a point of its own.
    let before = point_with(&e, &doc, "改过的第一段");
    assert_eq!(before["kind"], "restore");
    assert_eq!(before["title"], "Renamed");
    // The preview of the restored point now matches the prose.
    let pv = e.out("history.preview", json!({"doc": doc, "point": p["id"]}));
    assert_eq!(pv["same_as_now"], true);

    // One step of the object-level undo takes the whole restore back.
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert_eq!(
        texts(&e, &doc),
        [json!("改过的第一段。"), json!("第二段。")]
    );
    let ch = &e.out("chapter.list", json!({"book": b}))[0];
    assert_eq!(ch["title"], "Renamed");
    // And redo brings it again.
    e.ws().redo(&Actor::User).unwrap().unwrap();
    assert_eq!(texts(&e, &doc)[0], "第一段。");
    assert_eq!(e.out("chapter.list", json!({"book": b}))[0]["title"], "One");

    // The editor's own undo leaves the restore alone (an author's command).
    assert!(
        !s.can_undo() || {
            s.undo().unwrap();
            texts(&e, &doc)[0] == "第一段。"
        }
    );
}

#[test]
fn restoring_the_current_version_changes_nothing() {
    let e = env();
    let b = e.book();
    let c = e.out(
        "chapter.create",
        json!({"book": b, "title": "One", "text": "a"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    let doc = format!("node:{c}");
    point_now(&e, &doc, 0);
    let p = point_with(&e, &doc, "a");
    let out = e.call(
        "history.restore_point",
        json!({"doc": doc, "point": p["id"]}),
    );
    assert_eq!(out["output"]["prose"], false);
    assert_eq!(out["output"]["fields"], json!([]));
    assert!(out["effects"].as_array().unwrap().is_empty());
}

#[test]
fn an_element_keeps_a_name_another_has_taken_since() {
    let e = env();
    let b = e.book();
    let el = e.out(
        "element.create",
        json!({"book": b, "name": "Anna", "summary": "old"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    let doc = format!("element:{el}");
    let s = e.ws().prose_session(&doc).unwrap();
    s.edit(|t| t.insert_text(0, "她来了。")).unwrap();
    let ts = point_now(&e, &doc, 30 * 60_000);
    e.call(
        "element.update",
        json!({"book": b, "id": el, "name": "Bea", "summary": "new"}),
    );
    e.call("element.create", json!({"book": b, "name": "Anna"}));
    let p = point_at(&e, &doc, ts);
    assert_eq!(p["title"], "Anna");
    let out = e.out(
        "history.restore_point",
        json!({"doc": doc, "point": p["id"]}),
    );
    assert_eq!(out["fields"], json!(["summary"]));
    assert_eq!(out["skipped"], json!(["name", "aliases"]));
    let list = e.out("element.list", json!({"book": b}));
    let me = list
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == el)
        .unwrap();
    assert_eq!(
        (me["name"].clone(), me["summary"].clone()),
        (json!("Bea"), json!("old"))
    );
}

#[test]
fn history_refuses_what_is_not_there() {
    let e = env();
    let b = e.book();
    assert!(matches!(
        e.try_call("history.points", json!({"doc": format!("book:{b}")})),
        Err(WsError::Invalid(_))
    ));
    // A chapter nobody has typed in has no history yet.
    let empty = e.out("chapter.create", json!({"book": b, "title": "Empty"}))["id"]
        .as_str()
        .unwrap()
        .to_string();
    let none = e.out("history.points", json!({"doc": format!("node:{empty}")}));
    assert_eq!(
        (none["words"].clone(), none["points"].clone()),
        (json!(0), json!([]))
    );
    let c = e.out(
        "chapter.create",
        json!({"book": b, "title": "One", "text": "a"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    let doc = format!("node:{c}");
    assert!(matches!(
        e.try_call("history.preview", json!({"doc": doc, "point": 999_999})),
        Err(WsError::NotFound { .. })
    ));
    assert!(matches!(
        e.try_call("history.restore_point", json!({"doc": doc})),
        Err(WsError::Invalid(_))
    ));
}

#[test]
fn a_restored_title_someone_took_since_gets_a_suffix() {
    let e = env();
    let b = e.book();
    let c = e.out(
        "chapter.create",
        json!({"book": b, "title": "Rain", "text": "雨。"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    let doc = format!("node:{c}");
    let ts = point_now(&e, &doc, 10 * 60_000);
    e.call(
        "chapter.update",
        json!({"book": b, "id": c, "title": "Storm"}),
    );
    e.call("chapter.create", json!({"book": b, "title": "Rain"}));
    let p = point_at(&e, &doc, ts);
    let out = e.call(
        "history.restore_point",
        json!({"doc": doc, "point": p["id"]}),
    );
    assert!(effects(&out).contains(&"renamed node".to_string()), "{out}");
    let titles = field(&e.out("chapter.list", json!({"book": b})), "title");
    assert_eq!(titles, [json!("Rain 2"), json!("Rain")]);
}
