//! What the shell (F6) uses: the catalog behind location links, removal
//! events for closing tabs, and the quit hook.

mod common;

use std::sync::{Arc, Mutex};

use common::*;

use dr_workspace::{Actor, NavTarget, RemovedEntity, Workspace, WsEvent};
use loro::ExportMode;
use serde_json::json;

fn id(v: &serde_json::Value) -> String {
    v["id"].as_str().unwrap().to_string()
}

fn chapter(s: &str) -> NavTarget {
    NavTarget::Entry {
        id: dr_model::id::EntryId::parse(s).unwrap(),
        module: None,
    }
}

fn removals(ws: &Workspace) -> (Arc<Mutex<Vec<RemovedEntity>>>, dr_workspace::Subscription) {
    let seen: Arc<Mutex<Vec<RemovedEntity>>> = Arc::default();
    let s = seen.clone();
    let sub = ws.subscribe(move |ev| {
        if let WsEvent::Removed(r) = ev {
            s.lock().unwrap().extend(r.entities.iter().cloned());
        }
    });
    (seen, sub)
}

fn take(seen: &Mutex<Vec<RemovedEntity>>) -> Vec<RemovedEntity> {
    std::mem::take(&mut *seen.lock().unwrap())
}

fn gone(target: NavTarget, purged: bool) -> RemovedEntity {
    RemovedEntity { target, purged }
}

#[test]
fn entry_trash_material_purge_and_book_trash_are_announced() {
    let e = env();
    let b = e.book();
    let c = id(&common::acceptance::novel_entry(
        e.ws(),
        &b,
        "tpl-chapter",
        "One",
        None,
    ));
    let mat = id(&e.out(
        "material.create",
        json!({"book":b,"kind":"text","title":"地图","text":"x"}),
    ));
    let (seen, _sub) = removals(e.ws());
    e.call("entry.update", json!({"book":b,"id":c,"title":"Uno"}));
    assert!(take(&seen).is_empty());
    e.call("entry.trash", json!({"book":b,"id":c}));
    assert_eq!(take(&seen), [gone(chapter(&c), false)]);
    e.call("entry.restore", json!({"book":b,"id":c}));
    assert!(take(&seen).is_empty());
    e.call("material.delete", json!({"book":b,"id":mat}));
    assert_eq!(
        take(&seen),
        [gone(NavTarget::Material(mat.parse().unwrap()), true)]
    );
    e.call("book.trash", json!({"book":b}));
    assert_eq!(take(&seen), [gone(NavTarget::Book, false)]);
}

/// Every stored document of `from`, imported into `to` as sync would.
fn sync(from: &Workspace, to: &Workspace) {
    let mut docs = from.library().docs(None, None).unwrap();
    docs.sort_by_key(|d| (d.kind != "book", d.doc_id.clone()));
    for d in docs {
        let book = d.book_id.clone().unwrap_or_default();
        if let Ok(doc) = from.library().load_copy(&d.doc_id) {
            let bytes = doc.export(ExportMode::all_updates()).unwrap();
            to.import_remote(&d.doc_id, Some((&d.kind, &book)), bytes, &Actor::Sync)
                .unwrap();
        }
    }
}

#[test]
fn removals_from_another_device_are_announced() {
    let a = env();
    let other = env();
    let b = a.book();
    let c = id(&common::acceptance::novel_entry(
        a.ws(),
        &b,
        "tpl-chapter",
        "One",
        None,
    ));
    let mat = id(&a.out(
        "material.create",
        json!({"book":b,"kind":"text","title":"地图","text":"x"}),
    ));
    sync(a.ws(), other.ws());
    other.out("entry.list", json!({"book":b,"all":true}));
    let (seen, _sub) = removals(other.ws());
    a.call("entry.trash", json!({"book":b,"id":c}));
    sync(a.ws(), other.ws());
    assert_eq!(take(&seen), [gone(chapter(&c), false)]);
    a.call("material.delete", json!({"book":b,"id":mat}));
    sync(a.ws(), other.ws());
    assert_eq!(
        take(&seen),
        [gone(NavTarget::Material(mat.parse().unwrap()), true)]
    );
}

#[test]
fn before_quit_indexes_and_closes_what_is_open() {
    let e = env();
    let b = e.book();
    let c = id(&e.out(
        "entry.create", json!({"book": b, "parent": common::acceptance::novel_root(e.ws(), &b, "tpl-manuscript"), "template": "tpl-chapter", "title": "One", "bodies": {"mod-prose": "灯塔亮了。"}}),
    ));
    let d = id(&e.out(
        "entry.create", json!({"book": b, "parent": common::acceptance::novel_root(e.ws(), &b, "tpl-manuscript"), "template": "tpl-chapter", "title": "Two", "bodies": {"mod-prose": "潮水退了。"}}),
    ));
    let session = e
        .ws()
        .prose_session(&format!("body:{d}/mod-prose"))
        .unwrap();
    let report = e.ws().before_quit();
    // The book, the two documents beside it (opened when the book was
    // created) and chapter One close; chapter Two has an editing session.
    assert_eq!(report.in_use, 1, "{report:?}");
    assert_eq!(report.closed, 4, "{report:?}");
    assert!(e.ws().library().stale_index_docs().unwrap().is_empty());
    // Still usable afterwards.
    assert_eq!(
        e.out("prose.read", json!({"doc":format!("body:{c}/mod-prose")}))["paragraphs"][0]["text"],
        "灯塔亮了。"
    );
    session.edit(|t| t.insert_text(0, "又")).unwrap();
    assert_eq!(
        e.out("prose.read", json!({"doc": format!("body:{d}/mod-prose")}))["paragraphs"][0]["text"],
        "又潮水退了。"
    );
}
