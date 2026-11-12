//! The Stats tab and the commits to the book document that are not its
//! content: a writing day (this tab shows them) and a saved entry checkpoint
//! (it does not).

use std::time::{Duration, Instant};

use dr_view_stats::v3::Scope;
use dr_workspace::{Actor, Workspace};
use gpui::{Context, ParentElement as _, Render, Styled as _, VisualTestContext, Window};
use serde_json::{Value, json};

const TAB: &str = "v3-stats-quiet";

fn fixture() -> (tempfile::TempDir, Workspace, String) {
    let dir = tempfile::tempdir().unwrap();
    let store =
        dr_store::Library::open(dir.path(), dr_workspace::library_options("0.2.0-dev")).unwrap();
    let made = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let book = made.books[0].book_id().to_string();
    made.write_to(&store).unwrap();
    for doc in store.docs(Some(&book), None).unwrap() {
        store.reindex_doc(&doc.doc_id).unwrap();
    }
    store.close().unwrap();
    let ws = Workspace::open_dir(dir.path(), "0.2.0-dev").unwrap();
    (dir, ws, book)
}

fn call(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

struct Root {
    book: String,
}

impl Render for Root {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl gpui::IntoElement {
        gpui::div()
            .size_full()
            .child(dr_view_stats::v3_panel::panel(
                TAB,
                &self.book,
                Scope::Book,
                dr_i18n::Locale::En,
                dr_i18n::Platform::Mac,
                None,
                cx,
            ))
    }
}

/// Runs the app (the tab reads 300 ms after it is asked to) until `done`.
fn wait(cx: &mut VisualTestContext, what: &str, done: impl Fn(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        cx.executor().advance_clock(Duration::from_millis(50));
        cx.run_until_parked();
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "{what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[gpui::test]
fn the_tab_follows_a_writing_day(cx: &mut gpui::TestAppContext) {
    let (_dir, ws, book) = fixture();
    let today = dr_view_stats::clock::today().to_string();
    cx.executor().allow_parking();
    cx.update(|cx| dr_view_stats::init(Some(ws.clone()), cx));
    let shown = book.clone();
    let (_root, cx) = cx.add_window_view(move |_, _| Root { book: shown });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let view = cx
        .update(|_, cx| dr_view_stats::v3_panel::view(TAB, cx))
        .unwrap();
    let today_words =
        |cx: &mut VisualTestContext| view.read_with(cx, |v, _| v.loaded().map(|d| d.days.today));
    wait(cx, "the tab reads the book", |cx| today_words(cx).is_some());
    let before = today_words(cx).unwrap();

    // Another device's words for today (this device's own show from the
    // recorder's tally before they are stored).
    call(
        &ws,
        "writing_day.record",
        json!({"book": book, "device": "device-000000000000000000000002",
            "day": today, "words": 310}),
    );
    wait(cx, "the writing day reaches the tab", |cx| {
        today_words(cx) == Some(before + 310)
    });
    call(
        &ws,
        "writing_day.record",
        json!({"book": book, "device": "device-000000000000000000000002",
            "day": today, "words": 480}),
    );
    wait(cx, "the next minute's count reaches the tab", |cx| {
        today_words(cx) == Some(before + 480)
    });
    cx.update(|_, cx| dr_view_stats::release(cx));
}

/// Lets everything asked of the tab so far finish: the index rows behind
/// the last commits, the tab's 300 ms wait and its read.
fn settle(cx: &mut VisualTestContext, ws: &Workspace) {
    wait(cx, "every index row catches up", |_| {
        ws.library().stale_index_docs().unwrap().is_empty()
    });
    for _ in 0..12 {
        cx.executor().advance_clock(Duration::from_millis(100));
        cx.run_until_parked();
        std::thread::sleep(Duration::from_millis(5));
    }
    cx.run_until_parked();
}

#[gpui::test]
fn a_saved_checkpoint_does_not_make_the_tab_read_again(cx: &mut gpui::TestAppContext) {
    let (_dir, ws, book) = fixture();
    let doc = format!("book:{book}");
    let entry = dr_view_stats::v3::load(&ws, &book, Scope::Book)
        .unwrap()
        .documents[0]
        .entry
        .clone()
        .unwrap();
    cx.executor().allow_parking();
    cx.update(|cx| dr_view_stats::init(Some(ws.clone()), cx));
    let shown = book.clone();
    let (_root, cx) = cx.add_window_view(move |_, _| Root { book: shown });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let view = cx
        .update(|_, cx| dr_view_stats::v3_panel::view(TAB, cx))
        .unwrap();
    let reads = |cx: &mut VisualTestContext| view.read_with(cx, |v, _| v.reads());
    wait(cx, "the tab reads the book", |cx| {
        view.read_with(cx, |v, _| v.loaded().is_some())
    });
    // An entry's first point also creates the bodies its template gives it
    // and it has not written yet: prose documents, which this tab counts.
    // Save that one first.
    let save = || {
        let before = (
            ws.version(&doc).unwrap(),
            ws.library().docs(Some(&book), None).unwrap(),
        );
        call(
            &ws,
            "entry_snapshot.create",
            json!({"book": book, "entry": entry}),
        );
        let after = (
            ws.version(&doc).unwrap(),
            ws.library().docs(Some(&book), None).unwrap(),
        );
        (before.0 != after.0, before.1 == after.1)
    };
    save();
    settle(cx, &ws);
    let before = reads(cx);

    // From here a point is one manifest in the book document and nothing
    // else: a commit to the book, its index row written again after it.
    for _ in 0..3 {
        assert_eq!(save(), (true, true), "a commit to the book and no document");
        settle(cx, &ws);
    }
    assert_eq!(
        reads(cx),
        before,
        "a saved checkpoint is nothing this tab shows"
    );

    // The book's content still is.
    call(
        &ws,
        "book.update",
        json!({"book": book, "word_target": 54_321}),
    );
    wait(cx, "a new target reaches the tab", |cx| {
        view.read_with(cx, |v, _| {
            v.loaded().is_some_and(|d| d.word_target == Some(54_321))
        })
    });
    assert!(reads(cx) > before);
    cx.update(|_, cx| dr_view_stats::release(cx));
}
