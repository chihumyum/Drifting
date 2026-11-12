//! The bookshelf and the commits to a book's document that are not its
//! content: a writing day (the heat map and each card's last thirty days
//! show them) and a saved entry checkpoint (nothing on the shelf does).

use std::time::{Duration, Instant};

use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_view_shelf::Shelf;
use dr_workspace::{
    Actor, Workspace as Library,
    commands::{
        stats::{WritingDayIn, WritingDayRecord},
        v3::snapshots,
    },
};
use gpui::{Entity, TestAppContext, VisualTestContext};

const VERSION: &str = "0.2.0-dev";

/// A library holding 《慢钟》 and 《阿Q正传》.
fn library() -> (tempfile::TempDir, Library) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let lib = dr_store::Library::open(&root, dr_workspace::library_options(VERSION)).unwrap();
    for book in [
        dr_testkit::samples::slow_clock().unwrap(),
        dr_testkit::samples::a_q().unwrap(),
    ] {
        dr_testkit::seed::write_book_v3(&lib, &dr_testkit::seed::book_to_v3(&book).unwrap())
            .unwrap();
    }
    lib.rebuild_stale_indexes().unwrap();
    lib.close().unwrap();
    (dir, Library::open_dir(&root, VERSION).unwrap())
}

fn setup(cx: &mut TestAppContext, library: Library) -> (Entity<Workspace>, &mut VisualTestContext) {
    // F3 reads and delivers events on its own threads.
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: VERSION,
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(library),
                ..Services::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_view_shelf::init(cx);
    });
    let (view, cx) = cx.add_window_view(Workspace::new);
    cx.run_until_parked();
    (view, cx)
}

/// Runs the app until `done` holds, at most ten seconds.
fn wait_for(cx: &mut VisualTestContext, what: &str, done: impl Fn(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.update(|window, _| window.refresh());
        cx.run_until_parked();
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "{what}");
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn shelf_of(view: &Entity<Workspace>, cx: &mut VisualTestContext) -> Entity<Shelf> {
    view.read_with(cx, |ws, _| ws.shelf.clone())
        .expect("the bookshelf is made")
        .view
        .downcast::<Shelf>()
        .expect("the bookshelf is dr-view-shelf's")
}

fn slow_clock(lib: &Library) -> String {
    lib.run::<dr_workspace::commands::book::BookList>(&Actor::User, Default::default())
        .unwrap()
        .output
        .iter()
        .find(|b| b.name == "慢钟")
        .unwrap()
        .id
        .clone()
}

/// Today's words on the card of `book` (the last of its thirty days).
fn today_on_card(shelf: &Entity<Shelf>, cx: &mut VisualTestContext, book: &str) -> Option<u64> {
    shelf.read_with(cx, |s, _| {
        s.art.as_ref().and_then(|a| a.recent(book).last().copied())
    })
}

#[gpui::test]
fn a_writing_day_reaches_the_heat_map_and_the_card(cx: &mut TestAppContext) {
    let (_dir, library) = library();
    let lib = library.clone();
    let (view, cx) = setup(cx, library);
    cx.update(|window, _| window.activate_window());
    let shelf = shelf_of(&view, cx);
    let book = slow_clock(&lib);
    wait_for(cx, "the shelf's pictures are read", |cx| {
        shelf.read_with(cx, |s, _| {
            s.art.as_ref().is_some_and(|a| a.books.len() == 2)
        })
    });
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let record = |words: i64| {
        lib.run::<WritingDayRecord>(
            &Actor::User,
            WritingDayIn {
                book: book.clone(),
                device: "device-0123456789abcdef01234567".into(),
                day: today.clone(),
                words,
            },
        )
        .unwrap();
    };
    record(54_321);
    wait_for(cx, "the writing day reaches the card", |cx| {
        today_on_card(&shelf, cx, &book) == Some(54_321)
    });
    assert_eq!(
        shelf.read_with(cx, |s, _| s
            .art
            .as_ref()
            .unwrap()
            .year
            .total
            .last()
            .copied()),
        Some(54_321),
        "and the heat map of every book together"
    );
    record(54_400);
    wait_for(cx, "the next minute's count reaches the card", |cx| {
        today_on_card(&shelf, cx, &book) == Some(54_400)
    });
}

/// Lets everything asked of the shelf so far finish: the index rows behind
/// the last commits, then any read of the shelf and its pictures.
fn settle(cx: &mut VisualTestContext, lib: &Library) {
    wait_for(cx, "every index row catches up", |_| {
        lib.library().stale_index_docs().unwrap().is_empty()
    });
    for _ in 0..60 {
        cx.update(|window, _| window.refresh());
        cx.run_until_parked();
        std::thread::sleep(Duration::from_millis(5));
    }
    cx.run_until_parked();
}

#[gpui::test]
fn a_saved_checkpoint_does_not_make_the_shelf_read_again(cx: &mut TestAppContext) {
    let (_dir, library) = library();
    let lib = library.clone();
    let (view, cx) = setup(cx, library);
    cx.update(|window, _| window.activate_window());
    let shelf = shelf_of(&view, cx);
    let book = slow_clock(&lib);
    let doc = format!("book:{book}");
    wait_for(cx, "the shelf's pictures are read", |cx| {
        shelf.read_with(cx, |s, _| {
            s.art.as_ref().is_some_and(|a| a.books.len() == 2)
        })
    });
    let entry = dr_shell::book::Book::load(&lib, &book)
        .unwrap()
        .v3()
        .unwrap()
        .entries
        .iter()
        .find(|e| e.template.as_deref() == Some("tpl-chapter"))
        .expect("a chapter")
        .id
        .to_string();
    // An entry's first point also creates the bodies its template gives it
    // and it has not written yet: prose documents, which the shelf counts.
    // Save that one first.
    let save = || {
        let before = (
            lib.version(&doc).unwrap(),
            lib.library().docs(Some(&book), None).unwrap(),
        );
        lib.run::<snapshots::Create>(
            &Actor::User,
            snapshots::EntryIn {
                book: book.clone(),
                entry: entry.clone(),
            },
        )
        .unwrap();
        let after = (
            lib.version(&doc).unwrap(),
            lib.library().docs(Some(&book), None).unwrap(),
        );
        (before.0 != after.0, before.1 == after.1)
    };
    save();
    settle(cx, &lib);
    let read = shelf.read_with(cx, |s, _| s.data.clone().unwrap());

    // From here a point is one manifest in the book document and nothing
    // else: a commit to the book, its index row written again after it.
    for _ in 0..3 {
        assert_eq!(save(), (true, true), "a commit to the book and no document");
        settle(cx, &lib);
    }
    assert!(
        shelf.read_with(cx, |s, _| std::rc::Rc::ptr_eq(
            s.data.as_ref().unwrap(),
            &read
        )),
        "a saved checkpoint is nothing the shelf shows"
    );

    // The book's content still is.
    lib.run::<dr_workspace::commands::v3::book::BookUpdate>(
        &Actor::User,
        dr_workspace::commands::v3::book::BookUpdateIn {
            book: book.clone(),
            name: None,
            summary: Some("Synthetic summary".into()),
            word_target: None,
            daily_word_target: None,
        },
    )
    .unwrap();
    wait_for(cx, "a new summary reaches the shelf", |cx| {
        shelf.read_with(cx, |s, _| {
            s.data.as_ref().is_some_and(|d| {
                d.books
                    .iter()
                    .any(|b| b.id == book && b.summary == "Synthetic summary")
            })
        })
    });
}
