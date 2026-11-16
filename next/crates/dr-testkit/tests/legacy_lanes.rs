//! DV2 (`handoff/v5-tracks.md` 「DV2」, `kernel-v5.md` §15 item 31): a book
//! a build from before DV left with an old lane that is only a level is
//! cleared of it once, when the book opens: the lane leaves its view with
//! the places of what lived in it and nothing else changes. The write is the
//! system's (origin `repair`): no undo, no history point, synced as usual.
//! The book is marked, so it is not cleared again, and a lane the author
//! turns off later comes back when it is turned on. The seeds, the sample
//! books and the samples the App writes store nothing when they open.

use std::path::Path;

use dr_doc::v3::BorrowedBookV3;
use dr_model::id::{BookId, EntryId};
use dr_model::v3::{Entry, Membership, TimelinePlacement, TimelineView};
use dr_testkit::samples;
use dr_testkit::seed::{self, DEFAULT_SEED, LevelOnlyLane, Preset};
use dr_workspace::{Actor, Workspace};
use serde_json::{Value, json};

fn open(dir: &Path) -> Workspace {
    Workspace::open_dir(dir, "dv2").unwrap()
}

fn out(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

/// A tiny seed with the old lane ([`seed::with_level_only_lane`]), stored in
/// a new library at `dir` that is closed again.
fn legacy_book(dir: &Path) -> (String, LevelOnlyLane) {
    let mut s = seed::generate_v3(Preset::Tiny, DEFAULT_SEED).unwrap();
    let legacy = seed::with_level_only_lane(&mut s.books[0]).unwrap();
    let lib = dr_store::Library::open(dir, dr_workspace::library_options("dv2")).unwrap();
    s.write_to(&lib).unwrap();
    lib.close().unwrap();
    (s.books[0].book_id().to_string(), legacy)
}

/// What the book document stores, read straight from the library.
#[derive(Debug, PartialEq)]
struct Stored {
    cleared: bool,
    needs_repair: bool,
    entries: Vec<Entry>,
    memberships: Vec<Membership>,
    views: Vec<TimelineView>,
    /// The views as readers show them.
    shown: Vec<TimelineView>,
    children: Vec<EntryId>,
}

fn stored(lib: &dr_store::Library, book: &str, folder: &EntryId) -> Stored {
    let doc = lib.load_copy(&format!("book:{book}")).unwrap();
    let id = BookId::parse(book).unwrap();
    let b = BorrowedBookV3::new(&doc, &id).unwrap();
    let v = b.view();
    Stored {
        cleared: v.level_lanes_cleared(),
        needs_repair: v.needs_repair(),
        entries: v.entries_raw(),
        memberships: v.memberships_raw(),
        views: v.timeline_views_raw(),
        shown: v.timeline_views(),
        children: v
            .children_of(Some(folder))
            .into_iter()
            .map(|e| e.id)
            .collect(),
    }
}

fn stored_closed(dir: &Path, book: &str, folder: &EntryId) -> Stored {
    let lib = dr_store::Library::open(dir, dr_workspace::library_options("dv2")).unwrap();
    let s = stored(&lib, book, folder);
    lib.close().unwrap();
    s
}

fn view<'a>(views: &'a [TimelineView], id: &dr_model::id::TimelineViewId) -> &'a TimelineView {
    views.iter().find(|v| &v.id == id).unwrap()
}

fn lanes(v: &TimelineView) -> Vec<&EntryId> {
    v.lanes.iter().map(|l| &l.entry).collect()
}

fn placed<'a>(v: &'a TimelineView, entry: &EntryId) -> Option<&'a TimelinePlacement> {
    v.placements.iter().find(|p| &p.entry == entry)
}

/// The lanes `timeline_view.list` shows for `view`.
fn shown_lanes(ws: &Workspace, book: &str, view: &str) -> Vec<String> {
    out(ws, "timeline_view.list", json!({"book": book}))
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == view)
        .unwrap()["lanes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["entry"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn opening_a_book_clears_its_old_level_only_lane_once_and_leaves_the_rest() {
    let dir = tempfile::tempdir().unwrap();
    let (book, legacy) = legacy_book(dir.path());
    let doc_id = format!("book:{book}");
    let before = stored_closed(dir.path(), &book, &legacy.lane);
    // As a build before DV left it: the old lane and the places of what
    // lived in it are stored, readers leave them out, and the book is not
    // marked.
    assert!(!before.cleared);
    assert!(before.needs_repair);
    let old = view(&before.views, &legacy.view);
    for lane in [&legacy.lane, &legacy.trashed_lane, &legacy.storyline_off] {
        assert!(lanes(old).contains(&lane), "{lane}");
        assert!(!lanes(view(&before.shown, &legacy.view)).contains(&lane));
    }
    for entry in [&legacy.resident, &legacy.hung, &legacy.trashed_child] {
        assert!(placed(old, entry).is_some(), "{entry}");
    }

    let ws = open(dir.path());
    let seq = ws.library().write_seq().unwrap();
    let rows = ws.library().updates_since(&doc_id, 0).unwrap().len();
    let labels = ws.library().history(&doc_id).unwrap();
    // Listing the projects opens every book.
    out(&ws, "book.list", json!({}));
    let after = stored(ws.library(), &book, &legacy.lane);

    // One write, the system's.
    assert_eq!(ws.library().write_seq().unwrap(), seq + 1);
    let written = ws.library().updates_since(&doc_id, 0).unwrap();
    assert_eq!(written.len(), rows + 1);
    assert_eq!(written.last().unwrap().origin, "repair");
    assert!(after.cleared);
    assert!(!after.needs_repair);

    // The old lane left its view with the place of the chapter that only
    // lived in it.
    let mut want = old.clone();
    want.lanes.retain(|l| l.entry != legacy.lane);
    want.placements.retain(|p| p.entry != legacy.resident);
    assert_eq!(view(&after.views, &legacy.view), &want);
    // The rest is as it was: the other lanes (one with both switches off,
    // one in Recently Deleted) and their places, the chapter hung on a
    // storyline, the other view, the entries, the memberships, 书稿's
    // manual order. Readers show what they showed.
    assert!(placed(&want, &legacy.hung).is_some());
    assert!(placed(&want, &legacy.trashed_child).is_some());
    assert!(lanes(&want).contains(&&legacy.storyline_off));
    assert!(lanes(&want).contains(&&legacy.trashed_lane));
    assert_eq!(
        view(&after.views, &legacy.other_view),
        view(&before.views, &legacy.other_view)
    );
    assert_eq!(after.views.len(), before.views.len());
    assert_eq!(after.entries, before.entries);
    assert_eq!(after.memberships, before.memberships);
    assert_eq!(after.children, before.children);
    assert_eq!(after.shown, before.shown);

    // Not the author's: nothing to undo, no history point.
    assert!(ws.undo(&Actor::User).unwrap().is_none());
    assert!(ws.undo_in(&Actor::User, &book, None).unwrap().is_none());
    assert_eq!(ws.library().history(&doc_id).unwrap(), labels);
    // Synced as usual: the upload carries it.
    let batch = ws.library().export_for_upload(&doc_id).unwrap().unwrap();
    let probe = loro::LoroDoc::new();
    dr_doc::schema::configure(&probe);
    probe.import(&batch.bytes).unwrap();
    assert_eq!(
        probe.oplog_vv(),
        ws.library().load_copy(&doc_id).unwrap().oplog_vv()
    );
    ws.shutdown().unwrap();

    // Once: opening again writes nothing.
    assert_eq!(seed::writes_on_open(dir.path()), Ok(0));
    assert_eq!(stored_closed(dir.path(), &book, &legacy.lane), after);
}

/// After the clearing, a storyline whose 「收别处的条目」 the author turns
/// off stays in the view, read as not in it; the project closes and opens
/// again without writing; turned on again, it is back with its places. So
/// is a lane with its level on whose 「收别处的条目」 is off, which is what
/// the clearing takes out of a book that is not marked.
#[test]
fn a_lane_turned_off_after_the_clearing_comes_back_when_turned_on_after_a_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let (book, legacy) = legacy_book(dir.path());
    let view_id = legacy.view.to_string();
    let ws = open(dir.path());
    out(&ws, "book.list", json!({}));
    let cleared = stored(ws.library(), &book, &legacy.lane);
    assert!(cleared.cleared);
    let lines = [&legacy.storyline, &legacy.storyline_off];
    let hung_on = |s: &Stored, host: &EntryId| -> Vec<TimelinePlacement> {
        let v = view(&s.views, &legacy.view);
        s.memberships
            .iter()
            .filter(|m| &m.host == host)
            .filter_map(|m| placed(v, &m.member).cloned())
            .collect()
    };
    for line in lines {
        assert!(!hung_on(&cleared, line).is_empty(), "{line} has places");
    }
    assert!(shown_lanes(&ws, &book, &view_id).contains(&legacy.storyline.to_string()));

    // The storyline (level off) is turned off; the other one gets its level
    // on while its 「收别处的条目」 stays off.
    out(
        &ws,
        "entry.update",
        json!({"book": book, "id": legacy.storyline, "overrides": {"accept": false}}),
    );
    out(
        &ws,
        "entry.set_level",
        json!({"book": book, "id": legacy.storyline_off, "level": true}),
    );
    let off = stored(ws.library(), &book, &legacy.lane);
    let entries: std::collections::BTreeMap<_, _> = off
        .entries
        .iter()
        .map(|e| (e.id.clone(), e.clone()))
        .collect();
    let templates = {
        let doc = ws.library().load_copy(&format!("book:{book}")).unwrap();
        let id = BookId::parse(&book).unwrap();
        BorrowedBookV3::new(&doc, &id)
            .unwrap()
            .view()
            .templates_map()
    };
    assert!(dr_model::v3::is_level_only_lane(
        &legacy.storyline_off,
        &entries,
        &templates
    ));
    for line in lines {
        assert!(!shown_lanes(&ws, &book, &view_id).contains(&line.to_string()));
    }
    ws.shutdown().unwrap();

    assert_eq!(seed::writes_on_open(dir.path()), Ok(0));
    let ws = open(dir.path());
    out(&ws, "book.list", json!({}));
    assert_eq!(stored(ws.library(), &book, &legacy.lane), off);
    for line in lines {
        out(
            &ws,
            "entry.update",
            json!({"book": book, "id": line, "overrides": {}}),
        );
    }
    let on = stored(ws.library(), &book, &legacy.lane);
    let shown = shown_lanes(&ws, &book, &view_id);
    for line in lines {
        assert!(shown.contains(&line.to_string()), "{line} is back");
        assert_eq!(hung_on(&on, line), hung_on(&cleared, line), "{line}");
        let v = view(&on.shown, &legacy.view);
        for p in hung_on(&on, line) {
            assert!(placed(v, &p.entry).is_some(), "{} shows its place", p.entry);
        }
    }
    ws.shutdown().unwrap();
}

/// The four seeds, the three sample books and the two samples the App
/// writes into a new library store their lanes marked, so opening them
/// writes nothing.
#[test]
fn the_seeds_and_the_sample_books_write_nothing_when_they_open() {
    let check = |dir: &Path, what: &str| {
        let lib = dr_store::Library::open(dir, dr_workspace::library_options("dv2")).unwrap();
        for d in lib.docs(None, Some("book")).unwrap() {
            let doc = lib.load_copy(&d.doc_id).unwrap();
            let id = BookId::parse(d.doc_id.strip_prefix("book:").unwrap()).unwrap();
            let b = BorrowedBookV3::new(&doc, &id).unwrap();
            let v = b.view();
            let has_lanes = v.timeline_views_raw().iter().any(|tv| !tv.lanes.is_empty());
            assert_eq!(v.level_lanes_cleared(), has_lanes, "{what}: {id}");
            assert!(!v.needs_repair(), "{what}: {id}");
        }
        lib.close().unwrap();
        assert_eq!(seed::writes_on_open(dir), Ok(0), "{what}");
    };
    let write = |dir: &Path, books: &[seed::SeededBookV3]| {
        let lib = dr_store::Library::open(dir, dr_workspace::library_options("dv2")).unwrap();
        for b in books {
            seed::write_book_v3(&lib, b).unwrap();
        }
        lib.close().unwrap();
    };
    for preset in Preset::ALL {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            &seed::generate_v3(preset, DEFAULT_SEED).unwrap().books,
        );
        check(dir.path(), preset.name());
    }
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        &[
            samples::pride_and_prejudice_v3().unwrap(),
            samples::a_q_v3().unwrap(),
            samples::slow_clock_v3().unwrap(),
        ],
    );
    check(dir.path(), "sample books");

    let dir = tempfile::tempdir().unwrap();
    let ws = open(dir.path());
    assert!(matches!(
        dr_samples::ensure_built_in(&ws),
        dr_samples::Outcome::Created { .. }
    ));
    ws.shutdown().unwrap();
    check(dir.path(), "built-in samples");
}
