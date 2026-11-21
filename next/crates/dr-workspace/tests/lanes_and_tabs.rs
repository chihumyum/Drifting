//! DV (`handoff/v5-tracks.md`, `kernel-v5.md` §15 item 15, §16 「泳道」,
//! §17): a lane is an entry that takes entries from elsewhere
//! (「收别处的条目」), and it holds only what is hung on it; an entry with
//! only its level switch on cannot go into a view. A Tab cannot mount a
//! view. A book written before this keeps what it stored: an old lane that
//! is only a level reads as not in the view, an old Tab on a view reads as
//! gone, and nothing is deleted.
mod common;
use common::*;
use dr_doc::v3::BorrowedBookV3;
use dr_model::id::{BookId, EntryId, TabId, TimelineViewId};
use dr_model::v3::{FlattenFrom, ProjectTab, TabMount};
use dr_workspace::WsError;
use serde_json::{Value, json};

fn id(v: &Value) -> String {
    v["id"].as_str().unwrap().to_owned()
}

fn root(e: &Env, b: &str, template: &str) -> String {
    acceptance::novel_root(e.ws(), &b, template)
}

fn create(e: &Env, b: &str, parent: Option<&str>, template: &str, title: &str) -> String {
    id(&e.out(
        "entry.create",
        json!({"book": b, "parent": parent, "template": template, "title": title}),
    ))
}

fn refused(e: &Env, name: &str, input: Value, invariant: &str) {
    match e.try_call(name, input.clone()) {
        Err(WsError::Violation(v)) => assert_eq!(v.invariant, invariant, "{name} {input}"),
        other => panic!("{name} {input}: expected {invariant}, got {other:?}"),
    }
}

/// The writing project's own view.
fn the_view(e: &Env, b: &str) -> String {
    id(&e.out("timeline_view.list", json!({"book": b}))[0])
}

/// The view `view` as `timeline_view.list` shows it.
fn shown(e: &Env, b: &str, view: &str) -> Value {
    e.out("timeline_view.list", json!({"book": b}))
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == view)
        .cloned()
        .unwrap()
}

fn shown_lanes(e: &Env, b: &str, view: &str) -> Vec<String> {
    shown(e, b, view)["lanes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["entry"].as_str().unwrap().to_owned())
        .collect()
}

fn shown_at(e: &Env, b: &str, view: &str, entry: &str) -> Option<f64> {
    shown(e, b, view)["placements"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["entry"] == entry)
        .map(|p| p["at"].as_f64().unwrap())
}

/// The book document as stored, whatever the readers show.
fn stored(e: &Env, b: &str) -> Value {
    e.ws().observe(&format!("book:{b}")).unwrap().value
}

/// Writes the book directly, as a build from before DV could have.
fn write_raw(e: &Env, b: &str, f: impl FnOnce(&mut dr_doc::v3::BookTxnV3<'_>) + Send + 'static) {
    let book = BookId::parse(b).unwrap();
    e.ws()
        .library()
        .open_doc(&format!("book:{b}"), dr_store::OpenDoc::Existing)
        .unwrap()
        .write(dr_store::Origin::Import, move |doc| {
            let borrowed = BorrowedBookV3::new(doc, &book).unwrap();
            f(&mut borrowed.txn());
        })
        .unwrap();
}

/// Reads the book document directly.
fn read_raw<T: Send + 'static>(
    e: &Env,
    b: &str,
    f: impl FnOnce(dr_doc::v3::BookViewV3<'_>) -> T + Send + 'static,
) -> T {
    let book = BookId::parse(b).unwrap();
    e.ws()
        .library()
        .open_doc(&format!("book:{b}"), dr_store::OpenDoc::Existing)
        .unwrap()
        .read(move |doc| f(BorrowedBookV3::new(doc, &book).unwrap().view()))
        .unwrap()
}

fn below(e: &Env, b: &str, entry: &str, part: &str) -> Vec<String> {
    e.out("entry.get", json!({"book": b, "id": entry}))["below"][part]
        .as_array()
        .map(|rows| rows.iter().map(id).collect())
        .unwrap_or_default()
}

/// What is hung on `host` (its valid memberships).
fn hung_on(e: &Env, b: &str, host: &str) -> Vec<String> {
    e.out("membership.list", json!({"book": b}))
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["host"] == host)
        .map(|m| m["member"].as_str().unwrap().to_owned())
        .collect()
}

/// Only an entry that takes entries from elsewhere goes into a view. 书稿
/// (level on, 「收别处的条目」 off) is refused whichever command puts it in;
/// a chapter (both off) is refused as before; a storyline (level off,
/// 「收别处的条目」 on) goes in.
#[test]
fn an_entry_with_only_its_level_on_cannot_become_a_lane() {
    let e = env();
    let b = e.book();
    let view = the_view(&e, &b);
    let ms = root(&e, &b, "tpl-manuscript");
    let lines = root(&e, &b, "tpl-storylines");
    let chapter = create(&e, &b, Some(&ms), "tpl-chapter", "第一章");
    let line = create(&e, &b, Some(&lines), "tpl-storyline", "主线");

    refused(
        &e,
        "timeline_view.add_lane",
        json!({"book": b, "view": view, "lane": ms}),
        "V3-TIMELINE-LANE-ENABLED",
    );
    refused(
        &e,
        "timeline_view.add_lane",
        json!({"book": b, "view": view, "lane": chapter}),
        "V3-TIMELINE-LANE-ENABLED",
    );
    let mut with_folder = shown(&e, &b, &view);
    with_folder["lanes"] = json!([{"entry": ms}]);
    refused(
        &e,
        "timeline_view.put",
        json!({"book": b, "view": with_folder}),
        "V3-TIMELINE-LANE-ENABLED",
    );
    assert!(shown_lanes(&e, &b, &view).is_empty());
    assert!(
        stored(&e, &b)["timeline_views"][&view]["lanes"]
            .get(&ms)
            .is_none()
    );

    e.call(
        "timeline_view.add_lane",
        json!({"book": b, "view": view, "lane": line}),
    );
    assert_eq!(shown_lanes(&e, &b, &view), vec![line]);
}

/// A storyline with its level off and 「收别处的条目」 on is a lane as
/// before: the chapters hung on it go on the scale and are read along it,
/// on its page and when the lane is read whole; where they live and the
/// order there do not change.
#[test]
fn a_storyline_is_a_lane_and_its_hung_chapters_follow_the_scale() {
    let e = env();
    let b = e.book();
    let view = the_view(&e, &b);
    let ms = root(&e, &b, "tpl-manuscript");
    let lines = root(&e, &b, "tpl-storylines");
    let c1 = create(&e, &b, Some(&ms), "tpl-chapter", "第一章");
    let c2 = create(&e, &b, Some(&ms), "tpl-chapter", "第二章");
    let c3 = create(&e, &b, Some(&ms), "tpl-chapter", "第三章");
    let line = create(&e, &b, Some(&lines), "tpl-storyline", "主线");
    e.call(
        "timeline_view.add_lane",
        json!({"book": b, "view": view, "lane": line}),
    );
    for c in [&c1, &c2, &c3] {
        e.call(
            "membership.add",
            json!({"book": b, "host": line, "member": c}),
        );
        assert!(shown_at(&e, &b, &view, c).is_some(), "{c} is on the scale");
    }
    // Along the scale: 第三章, 第一章, 第二章.
    for (c, at) in [(&c3, 1.0), (&c1, 2.0), (&c2, 3.0)] {
        e.call(
            "timeline_view.place",
            json!({"book": b, "view": view, "entry": c, "lane": line, "at": at}),
        );
    }
    let along = vec![c3.clone(), c1.clone(), c2.clone()];
    assert_eq!(below(&e, &b, &line, "members"), along);
    // Read whole from the lane (the whole-book view opened on it).
    let from = FlattenFrom::Lane {
        view: TimelineViewId::parse(&view).unwrap(),
        entry: EntryId::parse(&line).unwrap(),
    };
    let lane_read = read_raw(&e, &b, move |v| {
        v.structure_snapshot()
            .sequence(&from, false)
            .unwrap()
            .iter()
            .map(|row| row.entry.id.to_string())
            .collect::<Vec<_>>()
    });
    assert_eq!(lane_read, along);
    // The chapters still live in 书稿, in their manual order.
    assert_eq!(below(&e, &b, &ms, "children"), vec![c1, c2, c3]);
}

/// An entry with both switches on (the act track's 幕) is a lane that holds
/// only what is hung on it: an entry that only lives under it gets no place
/// on the scale, moving an entry in or reordering inside it changes the
/// manual order and writes no place, and the lane leaving its last view
/// leaves the manual order alone.
#[test]
fn a_lane_with_both_switches_holds_only_what_is_hung_on_it() {
    let e = env();
    let b = e.book();
    let view = the_view(&e, &b);
    let act = create(&e, &b, None, "tpl-act-track", "幕");
    e.call(
        "timeline_view.add_lane",
        json!({"book": b, "view": view, "lane": act}),
    );
    let hung = id(&e.out(
        "entry.create",
        json!({"book": b, "host": act, "title": "挂上的构想"}),
    ));
    let lives = create(&e, &b, Some(&act), "tpl-idea", "住着的构想");
    assert!(shown_at(&e, &b, &view, &hung).is_some());
    assert_eq!(shown_at(&e, &b, &view, &lives), None);
    assert!(
        stored(&e, &b)["timeline_views"][&view]["placements"]
            .get(&lives)
            .is_none()
    );
    // What lives here and is hung here is listed once, under the entries
    // living here (`kernel-v5.md` §16 「条目页」); the membership says it is
    // hung on the lane.
    assert_eq!(hung_on(&e, &b, &act), vec![hung.clone()]);
    assert_eq!(
        below(&e, &b, &act, "children"),
        vec![hung.clone(), lives.clone()]
    );

    // Moving in with an index is a move in the manual order only.
    let ideas = root(&e, &b, "tpl-ideas");
    let moved = create(&e, &b, Some(&ideas), "tpl-idea", "搬来的构想");
    e.call(
        "entry.move",
        json!({"book": b, "id": moved, "parent": act, "index": 0}),
    );
    assert_eq!(
        below(&e, &b, &act, "children"),
        vec![moved.clone(), hung.clone(), lives.clone()]
    );
    assert_eq!(shown_at(&e, &b, &view, &moved), None);
    e.call(
        "entry.move",
        json!({"book": b, "id": lives, "parent": act, "index": 0}),
    );
    assert_eq!(
        below(&e, &b, &act, "children"),
        vec![lives.clone(), moved.clone(), hung.clone()]
    );

    // Leaving the last view writes the members' order back, not the folder's.
    let at_hung = shown_at(&e, &b, &view, &hung);
    e.call(
        "timeline_view.remove_lane",
        json!({"book": b, "view": view, "lane": act}),
    );
    assert!(at_hung.is_some());
    assert_eq!(
        below(&e, &b, &act, "children"),
        vec![lives, moved, hung.clone()]
    );
    assert_eq!(hung_on(&e, &b, &act), vec![hung]);
}

/// A lane that is only a level, stored in an open book (as 书稿 put into a
/// view before DV; such a book is cleared of it once when it opens, DV2,
/// `dr-testkit`'s `legacy_lanes`), keeps what it stored: the old lane and
/// the places of its chapters stay in the book, but the view does not show
/// the lane, 书稿 orders its chapters by hand, and the book reads in that
/// order. Writes that do not add it again (renaming the view, adding another
/// lane) go through and keep it; taking it out works and changes no manual
/// order.
#[test]
fn an_old_lane_that_is_only_a_level_reads_as_not_in_the_view_and_nothing_is_lost() {
    let e = env();
    let b = e.book();
    let view = the_view(&e, &b);
    let ms = root(&e, &b, "tpl-manuscript");
    let lines = root(&e, &b, "tpl-storylines");
    let c1 = create(&e, &b, Some(&ms), "tpl-chapter", "第一章");
    let c2 = create(&e, &b, Some(&ms), "tpl-chapter", "第二章");
    for (c, text) in [(&c1, "一"), (&c2, "二")] {
        e.call(
            "module.set_prose",
            json!({"book": b, "owner": c, "module": "mod-prose", "paragraphs": [{"text": text}]}),
        );
    }
    let (vid, folder) = (
        TimelineViewId::parse(&view).unwrap(),
        EntryId::parse(&ms).unwrap(),
    );
    let (p1, p2) = (EntryId::parse(&c1).unwrap(), EntryId::parse(&c2).unwrap());
    write_raw(&e, &b, move |t| {
        // The scale had 第二章 before 第一章.
        t.timeline_view(&vid)
            .unwrap()
            .put_lane(&folder, Some(&dr_model::pos::PosKey::first()))
            .unwrap()
            .put_placement(&p2, 1.0, None)
            .unwrap()
            .put_placement(&p1, 2.0, None)
            .unwrap();
    });
    let raw_view = |e: &Env| stored(e, &b)["timeline_views"][&view].clone();
    assert!(raw_view(&e)["lanes"].get(&ms).is_some());

    assert!(shown_lanes(&e, &b, &view).is_empty());
    assert_eq!(shown_at(&e, &b, &view, &c1), None);
    assert_eq!(below(&e, &b, &ms, "children"), vec![c1.clone(), c2.clone()]);
    let book: Vec<String> = e.out("book.sequence", json!({"book": b}))["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| !row["prose"].as_array().unwrap().is_empty())
        .map(|row| row["entry"]["id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(book, vec![c1.clone(), c2.clone()]);

    e.call(
        "timeline_view.rename",
        json!({"book": b, "view": view, "name": "另一种排法"}),
    );
    let line = create(&e, &b, Some(&lines), "tpl-storyline", "主线");
    e.call(
        "timeline_view.add_lane",
        json!({"book": b, "view": view, "lane": line}),
    );
    assert_eq!(shown_lanes(&e, &b, &view), vec![line.clone()]);
    let kept = raw_view(&e);
    assert!(kept["lanes"].get(&ms).is_some(), "{kept}");
    assert!(kept["placements"].get(&c1).is_some(), "{kept}");
    assert!(kept["placements"].get(&c2).is_some(), "{kept}");
    // Moving a chapter inside 书稿 is a manual move.
    e.call(
        "entry.move",
        json!({"book": b, "id": c2, "parent": ms, "index": 0}),
    );
    assert_eq!(below(&e, &b, &ms, "children"), vec![c2.clone(), c1.clone()]);

    e.call(
        "timeline_view.remove_lane",
        json!({"book": b, "view": view, "lane": ms}),
    );
    assert!(raw_view(&e)["lanes"].get(&ms).is_none());
    assert_eq!(below(&e, &b, &ms, "children"), vec![c2, c1]);
    assert_eq!(shown_lanes(&e, &b, &view), vec![line]);
}

/// A Tab cannot mount a view. A Tab a book stored on a view before reads as
/// gone (the view is still there), stays stored, and can be taken away; the
/// other three kinds of Tab mount as before.
#[test]
fn a_tab_cannot_mount_a_view_and_an_old_one_reads_gone() {
    let e = env();
    let b = e.book();
    let view = the_view(&e, &b);
    refused(
        &e,
        "tab.put",
        json!({"book": b, "mount": {"kind": "view", "view": view}}),
        "TAB-MOUNT-VALID",
    );
    let tabs = |e: &Env| {
        e.out("project.get", json!({"book": b}))["tabs"]
            .as_array()
            .unwrap()
            .clone()
    };
    assert!(tabs(&e).iter().all(|t| t["mount"]["kind"] != "view"));
    e.call("tab.put", json!({"book": b, "mount": {"kind": "book"}}));

    let vid = TimelineViewId::parse(&view).unwrap();
    write_raw(&e, &b, move |t| {
        t.project()
            .put_tab(&ProjectTab {
                id: TabId::parse("tab-old-view").unwrap(),
                pos: None,
                mount: TabMount::View { view: vid },
                gone_title: None,
            })
            .unwrap();
    });
    let old: Vec<Value> = tabs(&e)
        .into_iter()
        .filter(|t| t["id"] == "tab-old-view")
        .collect();
    assert_eq!(old.len(), 1, "{old:?}");
    assert_eq!(old[0]["mount"], json!({"kind": "view", "view": view}));
    assert_eq!(old[0]["mount_valid"], false);
    assert!(
        tabs(&e)
            .iter()
            .filter(|t| t["id"] != "tab-old-view")
            .all(|t| t["mount_valid"] == true)
    );
    // The view itself is still there.
    assert!(shown(&e, &b, &view)["deleted_at"].is_null());
    assert!(
        stored(&e, &b)["project"]["tabs"]
            .get("tab-old-view")
            .is_some()
    );

    e.call("tab.remove", json!({"book": b, "id": "tab-old-view"}));
    assert!(tabs(&e).iter().all(|t| t["id"] != "tab-old-view"));
}

/// Saving a project as a template leaves a Tab on a view out: a template's
/// Tabs mount the root, an entry or the book. The other Tabs go in.
#[test]
fn saving_a_project_with_a_tab_on_a_view_leaves_that_tab_out() {
    let e = env();
    let b = e.book();
    let view = the_view(&e, &b);
    e.call("tab.put", json!({"book": b, "mount": {"kind": "book"}}));
    let vid = TimelineViewId::parse(&view).unwrap();
    write_raw(&e, &b, move |t| {
        t.project()
            .put_tab(&ProjectTab {
                id: TabId::parse("tab-old-view").unwrap(),
                pos: None,
                mount: TabMount::View { view: vid },
                gone_title: None,
            })
            .unwrap();
    });
    let shown_tabs = e.out("project.get", json!({"book": b}))["tabs"]
        .as_array()
        .unwrap()
        .len();
    let saved = e.out(
        "project_template.save",
        json!({"book": b, "name": "有视图 Tab 的项目"}),
    );
    let template = e.out("project_template.get", json!({"id": saved["id"]}));
    let kinds: Vec<&str> = template["value"]["project"]["tabs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["mount"]["kind"].as_str().unwrap())
        .collect();
    assert!(!kinds.contains(&"view"), "{kinds:?}");
    assert_eq!(kinds.len(), shown_tabs - 1, "{kinds:?}");
    assert!(kinds.contains(&"book"), "{kinds:?}");

    // A project made from it has no Tab on a view, and every Tab shows.
    let made = e.out(
        "project.create",
        json!({"name": "从模板建", "template_id": saved["id"]}),
    );
    let tabs = e.out("project.get", json!({"book": made["id"]}))["tabs"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(tabs.len(), shown_tabs - 1);
    assert!(tabs.iter().all(|t| t["mount"]["kind"] != "view"));
    assert!(tabs.iter().all(|t| t["mount_valid"] == true));
}

/// DV2 (`kernel-v5.md` §15 item 31): a new writing project, and one made
/// from a project template, store nothing when they open again. Their view
/// has no lane, so the book is not marked and there is nothing to clear;
/// the first lane put in marks it in the same write, and it still opens
/// without a write.
#[test]
fn the_writing_project_writes_nothing_when_it_opens_and_its_first_lane_marks_it() {
    let mut e = env();
    let b = e.book();
    let saved = e.out(
        "project_template.save",
        json!({"book": b, "name": "写书另存"}),
    );
    let made = id(&e.out(
        "project.create",
        json!({"name": "从模板建", "template_id": saved["id"]}),
    ));
    let opens_quietly = |e: &mut Env| {
        e.reopen();
        let seq = e.ws().library().write_seq().unwrap();
        for book in [&b, &made] {
            for name in ["project.get", "entry.list", "timeline_view.list"] {
                e.out(name, json!({"book": book}));
            }
        }
        assert_eq!(e.ws().library().write_seq().unwrap(), seq);
    };
    opens_quietly(&mut e);
    for book in [&b, &made] {
        assert!(
            stored(&e, book)["meta"]
                .get("level_lanes_cleared")
                .is_none()
        );
    }

    let lines = root(&e, &b, "tpl-storylines");
    let line = create(&e, &b, Some(&lines), "tpl-storyline", "主线");
    let view = the_view(&e, &b);
    e.call(
        "timeline_view.add_lane",
        json!({"book": b, "view": view, "lane": line}),
    );
    assert_eq!(stored(&e, &b)["meta"]["level_lanes_cleared"], true);
    opens_quietly(&mut e);
    assert_eq!(shown_lanes(&e, &b, &view), vec![line]);
}
