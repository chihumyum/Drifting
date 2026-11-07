//! What the shell (F6) uses: the catalog behind location links, removal
//! events for closing tabs, and the quit hook.

mod common;

use std::sync::{Arc, Mutex};

use common::*;
use dr_model::id::{ElementId, NodeId};
use dr_workspace::{Actor, LinkGroup, NavTarget, RemovedEntity, Workspace, WsEvent};
use loro::ExportMode;
use serde_json::json;

fn id(v: &serde_json::Value) -> String {
    v["id"].as_str().unwrap().to_string()
}

fn chapter(s: &str) -> NavTarget {
    NavTarget::Chapter(NodeId::parse(s).unwrap())
}

#[test]
fn the_catalog_finds_live_entities_by_name_and_id() {
    let e = env();
    let b = e.book();
    let rain = id(&e.out("chapter.create", json!({"book": b, "title": "雨夜"})));
    // Two of the same title (only a merge makes them: commands add a
    // suffix): both found, so the link says it is ambiguous.
    let other = env();
    sync(e.ws(), other.ws());
    let t1 = id(&e.out("chapter.create", json!({"book": b, "title": "双生"})));
    let t2 = id(&other.out("chapter.create", json!({"book": b, "title": "双生"})));
    sync(other.ws(), e.ws());
    let idea = id(&e.out("idea.create", json!({"book": b, "title": "雾里的钟声"})));
    let el = id(&e.out("element.create", json!({"book": b, "name": "安娜"})));
    let cat = id(&e.out("category.create", json!({"book": b, "name": "人物"})));
    let line = id(&e.out("storyline.create", json!({"book": b, "name": "潮汐"})));
    let c = e.ws().catalog(&b).unwrap();
    assert_eq!(c.book_id(), b);
    assert_eq!(c.by_name(LinkGroup::Chapters, " 雨夜 "), [chapter(&rain)]);
    assert!(
        c.by_name(LinkGroup::Drifts, "雨夜").is_empty(),
        "groups are apart"
    );
    assert_eq!(
        c.by_name(LinkGroup::Drifts, "雾里的钟声"),
        [NavTarget::Idea(NodeId::parse(&idea).unwrap())]
    );
    let mut twins = c.by_name(LinkGroup::Chapters, "双生");
    twins.sort_by_key(|t| t.key());
    let mut want = vec![chapter(&t1), chapter(&t2)];
    want.sort_by_key(|t| t.key());
    assert_eq!(twins, want);
    assert_eq!(
        c.by_id(LinkGroup::Elements, &el),
        Some(NavTarget::Element(ElementId::parse(&el).unwrap()))
    );
    assert!(c.by_id(LinkGroup::Categories, &cat).is_some());
    assert!(c.by_id(LinkGroup::Storylines, &line).is_some());
    assert_eq!(c.by_name(LinkGroup::Categories, "人物").len(), 1);
    // An id from another group, a bad id, an empty name: nothing.
    assert_eq!(c.by_id(LinkGroup::Drifts, &rain), None);
    assert_eq!(c.by_id(LinkGroup::Chapters, "no such"), None);
    assert!(c.by_name(LinkGroup::Chapters, "  ").is_empty());
    assert_eq!(c.title(&chapter(&rain)).as_deref(), Some("雨夜"));
    assert_eq!(c.title(&NavTarget::Book).as_deref(), Some("Test Book"));
    // The trash hides things from links; a rename is seen at once.
    e.call("chapter.trash", json!({"book": b, "id": rain}));
    assert!(c.by_name(LinkGroup::Chapters, "雨夜").is_empty());
    assert!(!c.exists(&chapter(&rain)));
    e.call(
        "element.update",
        json!({"book": b, "id": el, "name": "安娜·卡"}),
    );
    assert_eq!(c.by_name(LinkGroup::Elements, "安娜·卡").len(), 1);
    assert!(e.ws().catalog("no-such-book").is_err());
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
fn trashing_and_purging_are_announced() {
    let e = env();
    let b = e.book();
    let c = id(&e.out("chapter.create", json!({"book": b, "title": "One"})));
    let el = id(&e.out("element.create", json!({"book": b, "name": "安娜"})));
    let mat = id(&e.out(
        "material.create",
        json!({"book": b, "kind": "text", "title": "地图", "text": "x"}),
    ));
    e.out("chapter.list", json!({"book": b}));
    let (seen, _sub) = removals(e.ws());
    // A rename removes nothing.
    e.call(
        "chapter.update",
        json!({"book": b, "id": c, "title": "Uno"}),
    );
    assert!(take(&seen).is_empty());
    e.call("chapter.trash", json!({"book": b, "id": c}));
    assert_eq!(take(&seen), [gone(chapter(&c), false)]);
    e.call("chapter.restore", json!({"book": b, "id": c}));
    assert!(take(&seen).is_empty(), "a restore removes nothing");
    e.call("chapter.trash", json!({"book": b, "id": c}));
    take(&seen);
    e.call("chapter.purge", json!({"book": b, "id": c}));
    assert_eq!(take(&seen), [gone(chapter(&c), true)]);
    // An Agent's removal is announced the same way.
    let agent = Actor::agent("s", 1, "c");
    call(
        e.ws(),
        &agent,
        "element.trash",
        json!({"book": b, "id": el}),
    );
    assert_eq!(
        take(&seen),
        [gone(NavTarget::Element(el.parse().unwrap()), false)]
    );
    e.call("material.delete", json!({"book": b, "id": mat}));
    assert_eq!(
        take(&seen),
        [gone(NavTarget::Material(mat.parse().unwrap()), true)]
    );
    e.call("book.trash", json!({"book": b}));
    assert_eq!(take(&seen), [gone(NavTarget::Book, false)]);
}

/// Every stored document of `from`, imported into `to` as sync would.
fn sync(from: &Workspace, to: &Workspace) {
    for d in from.library().docs(None, None).unwrap() {
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
    let c = id(&a.out("chapter.create", json!({"book": b, "title": "One"})));
    let d = id(&a.out("chapter.create", json!({"book": b, "title": "Two"})));
    let f = id(&a.out("chapter.create", json!({"book": b, "title": "Three"})));
    sync(a.ws(), other.ws());
    let (seen, _sub) = removals(other.ws());
    // Trashed there: still stored, so named with its kind.
    a.call("chapter.trash", json!({"book": b, "id": c}));
    sync(a.ws(), other.ws());
    assert_eq!(take(&seen), [gone(chapter(&c), false)]);
    // Trashed and deleted for good there, never read here: its kind went
    // with it, so it is named both ways.
    a.call("chapter.trash", json!({"book": b, "id": d}));
    a.call("chapter.purge", json!({"book": b, "id": d}));
    sync(a.ws(), other.ws());
    let mut got = take(&seen);
    got.sort_by_key(|r| r.target.key());
    let nid = NodeId::parse(&d).unwrap();
    assert_eq!(
        got,
        [
            gone(NavTarget::Chapter(nid.clone()), true),
            gone(NavTarget::Idea(nid), true)
        ]
    );
    // Once this device has read the chapters, the kind is known.
    other.out("chapter.list", json!({"book": b}));
    a.call("chapter.trash", json!({"book": b, "id": f}));
    a.call("chapter.purge", json!({"book": b, "id": f}));
    sync(a.ws(), other.ws());
    assert_eq!(take(&seen), [gone(chapter(&f), true)]);
}

#[test]
fn before_quit_indexes_and_closes_what_is_open() {
    let e = env();
    let b = e.book();
    let c = id(&e.out(
        "chapter.create",
        json!({"book": b, "title": "One", "text": "灯塔亮了。"}),
    ));
    let d = id(&e.out(
        "chapter.create",
        json!({"book": b, "title": "Two", "text": "潮水退了。"}),
    ));
    let session = e.ws().prose_session(&format!("node:{d}")).unwrap();
    let report = e.ws().before_quit();
    // The book and chapter One close; chapter Two has an editing session.
    assert_eq!((report.closed, report.in_use), (2, 1), "{report:?}");
    assert!(e.ws().library().stale_index_docs().unwrap().is_empty());
    // Still usable afterwards.
    let hits = e.out("book.search", json!({"book": b, "query": "灯塔亮"}));
    assert_eq!(hits[0]["owner"], c.as_str());
    session.edit(|t| t.insert_text(0, "又")).unwrap();
    assert_eq!(
        e.out("prose.read", json!({"doc": format!("node:{d}")}))["paragraphs"][0]["text"],
        "又潮水退了。"
    );
}
