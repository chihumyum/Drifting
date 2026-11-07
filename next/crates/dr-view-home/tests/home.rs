//! Project Home on GPUI's test platform, over a real library (the
//! showcase's 《慢钟》 and one of its shelf books, read through F3): the
//! numbers are F3's and the derived index's, today's words and the streak
//! come from the writing days, the name is changed in place, the word
//! targets from 设定, a prose change moves a chapter to the top of 继续写,
//! and the pages the window opens are recorded and lead 继续写.

use std::rc::Rc;
use std::time::{Duration, Instant};

use chrono::NaiveDate;
use dr_shell::nav::{Open, Target};
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_view_home::{Home, HomeView, continue_page, opened_more};
use dr_workspace::{
    Actor, Workspace as Library,
    commands::{
        BookIn, ListIn,
        book::BookGet,
        chapter::ChapterList,
        prose::{ProseRead, ProseReadIn, ProseReplace, ProseReplaceIn},
    },
};
use gpui::{Entity, TestAppContext, VisualTestContext};

const VERSION: &str = "0.2.0-dev";

fn info() -> ShellInfo {
    ShellInfo {
        app_name: "Drifting Next",
        bundle_id: "cc.drifting.next.dev",
        version: VERSION,
        url_scheme: "drifting-next-dev",
        forced_appearance: None,
    }
}

/// A library holding 《慢钟》, and the id of its book.
fn library() -> (tempfile::TempDir, Library, String) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let lib = dr_store::Library::open(&root, dr_workspace::library_options(VERSION)).unwrap();
    let book = dr_testkit::samples::slow_clock().unwrap();
    dr_testkit::seed::write_book(&lib, &book).unwrap();
    lib.close().unwrap();
    let ws = Library::open_dir(&root, VERSION).unwrap();
    let id = book.book.book_id().to_string();
    (dir, ws, id)
}

fn setup(
    cx: &mut TestAppContext,
    library: Library,
    today: NaiveDate,
) -> (Entity<Workspace>, &mut VisualTestContext) {
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            info(),
            Services {
                library: Some(library),
                ..Services::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        // No bookshelf: the window opens straight into the book, on Home.
        dr_view_home::init(cx);
        dr_view_home::set_today(today, cx);
    });
    let (view, cx) = cx.add_window_view(Workspace::new);
    cx.run_until_parked();
    (view, cx)
}

fn wait_for(cx: &mut VisualTestContext, done: impl Fn(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.update(|window, _| window.refresh());
        cx.run_until_parked();
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out");
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// Waits for the book and Home's numbers for it; returns Home.
fn home_ready(view: &Entity<Workspace>, cx: &mut VisualTestContext) -> Entity<Home> {
    wait_for(cx, |cx| {
        view.read_with(cx, |ws, _| !ws.book.is_empty() && ws.home.is_some())
    });
    let home = view
        .read_with(cx, |ws, _| ws.home.clone())
        .unwrap()
        .downcast::<Home>()
        .expect("Home is dr-view-home's");
    wait_for(cx, |cx| {
        let book = view.read_with(cx, |ws, _| ws.book.id.clone());
        home.read_with(cx, |h, _| h.stats.as_ref().is_some_and(|s| s.book == book))
    });
    home
}

fn t0_day() -> NaiveDate {
    chrono::DateTime::from_timestamp(dr_testkit::seed::T0, 0)
        .unwrap()
        .date_naive()
}

#[gpui::test]
fn home_reads_the_books_numbers(cx: &mut TestAppContext) {
    let (_dir, library, id) = library();
    let lib = library.clone();
    let (view, cx) = setup(cx, library, t0_day());
    let home = home_ready(&view, cx);
    let book = view.read_with(cx, |ws, _| ws.book.clone());
    assert_eq!(book.id, id);
    // Words are the chapters' in the derived index. A freshly seeded
    // library builds it in the background; Home reads again as each
    // chapter's index lands.
    lib.library().rebuild_stale_indexes().unwrap();
    let words = || -> u64 {
        lib.run::<ChapterList>(
            &Actor::User,
            ListIn {
                book: id.clone(),
                trashed: false,
            },
        )
        .unwrap()
        .output
        .iter()
        .map(|c| c.words)
        .sum()
    };
    let expected = words();
    assert!(expected > 0);
    wait_for(cx, |cx| {
        home.read_with(cx, |h, _| {
            h.stats.as_ref().is_some_and(|s| s.words == expected)
        })
    });
    let stats = home.read_with(cx, |h, _| h.stats.clone().unwrap());
    assert_eq!(stats.chapter_words.len(), book.chapters.len());
    assert_eq!(stats.chapter_edited.len(), book.chapters.len());
    // Targets and summary are F3's.
    let detail = lib
        .run::<BookGet>(&Actor::User, BookIn { book: id.clone() })
        .unwrap()
        .output;
    assert_eq!(stats.word_target, detail.info.word_target);
    assert_eq!(stats.daily_target, detail.info.daily_word_target);
    assert_eq!(stats.summary, detail.info.summary);
    // Every chapter is a candidate to continue, the newest edit first.
    let recent = dr_view_home::recent(&book, Some(&stats));
    assert_eq!(recent.len(), book.chapters.len());
    let newest = stats.chapter_edited.values().max().copied();
    assert_eq!(stats.chapter_edited.get(&recent[0].id).copied(), newest);
    // Nothing opened on this device yet: 继续写 is the chapter changed
    // last, with nothing under it.
    assert!(stats.opened.is_empty());
    assert_eq!(
        continue_page(&book, Some(&stats)),
        recent[0].id.parse().ok().map(Target::Chapter)
    );
    assert!(opened_more(&book, Some(&stats), None).is_empty());
}

#[gpui::test]
fn the_pages_opened_lead_continue(cx: &mut TestAppContext) {
    let (_dir, library, _) = library();
    let (view, cx) = setup(cx, library, t0_day());
    let home = home_ready(&view, cx);
    let book = view.read_with(cx, |ws, _| ws.book.clone());
    let chapter = |i: usize| Target::Chapter(book.chapters[i].id.parse().unwrap());
    let element = Target::Element(book.elements[0].id.parse().unwrap());
    // The window opens a chapter, an element, then another chapter.
    for target in [chapter(2), element.clone(), chapter(0)] {
        view.update(cx, |ws, cx| ws.open(target, Open::KEEP, cx));
        cx.run_until_parked();
    }
    // Back on Home: the chapter opened last leads, the others follow,
    // newest first.
    view.update(cx, |ws, cx| {
        ws.nav.go_home();
        cx.notify();
    });
    wait_for(cx, |cx| {
        home.read_with(cx, |h, _| {
            h.stats.as_ref().is_some_and(|s| s.opened.len() == 3)
        })
    });
    let stats = home.read_with(cx, |h, _| h.stats.clone().unwrap());
    assert_eq!(continue_page(&book, Some(&stats)), Some(chapter(0)));
    let more: Vec<Target> = opened_more(&book, Some(&stats), Some(&chapter(0)))
        .into_iter()
        .map(|(t, _)| t)
        .collect();
    assert_eq!(more, vec![element, chapter(2)]);
}

#[gpui::test]
fn a_prose_change_moves_its_chapter_to_continue(cx: &mut TestAppContext) {
    let (_dir, library, _) = library();
    let lib = library.clone();
    let (view, cx) = setup(cx, library, t0_day());
    let home = home_ready(&view, cx);
    let book = view.read_with(cx, |ws, _| ws.book.clone());
    // The last chapter in reading order that has prose gets a new word.
    let read = |doc: &str| {
        lib.run::<ProseRead>(
            &Actor::User,
            ProseReadIn {
                doc: doc.to_owned(),
                from: 0,
                limit: None,
            },
        )
        .unwrap()
        .output
        .paragraphs
        .into_iter()
        .find(|p| p.text.chars().count() > 4)
    };
    let (last, first) = book
        .chapters
        .iter()
        .rev()
        .find_map(|c| read(&format!("node:{}", c.id)).map(|p| (c.clone(), p)))
        .expect("a chapter with prose");
    let doc = format!("node:{}", last.id);
    let find: String = first.text.chars().take(4).collect();
    // `chapter.list` dates changes to the second: the edit lands in a
    // later one than the seeding.
    std::thread::sleep(Duration::from_millis(1100));
    lib.run::<ProseReplace>(
        &Actor::User,
        ProseReplaceIn {
            doc,
            find: find.clone(),
            replace: format!("{find}钟声"),
            block_id: first.block_id.clone(),
        },
    )
    .unwrap();
    wait_for(cx, |cx| {
        home.read_with(cx, |h, _| {
            h.stats
                .as_ref()
                .is_some_and(|s| dr_view_home::recent(&book, Some(s))[0].id == last.id)
        })
    });
}

#[gpui::test]
fn the_name_changes_in_place(cx: &mut TestAppContext) {
    let (_dir, library, _) = library();
    let (view, cx) = setup(cx, library, t0_day());
    let home = home_ready(&view, cx);
    // The name is a frameless field on the page all along.
    let field = home.read_with(cx, |h, _| h.title_field());
    wait_for(cx, |cx| field.read_with(cx, |f, _| f.text()) == "慢钟");
    let renaming =
        |cx: &mut VisualTestContext| cx.update(|window, cx| home.read(cx).renaming(window, cx));
    assert!(!renaming(cx));
    // Enter saves and leaves the field.
    cx.update(|window, cx| home.update(cx, |h, cx| h.start_rename(window, cx)));
    assert!(renaming(cx));
    cx.update(|_, cx| field.update(cx, |f, cx| f.set_text("慢钟·二稿", cx)));
    cx.simulate_keystrokes("enter");
    wait_for(cx, |cx| {
        view.read_with(cx, |ws, _| ws.book.name == "慢钟·二稿")
    });
    assert!(!renaming(cx));
    // Esc puts the name back.
    cx.update(|window, cx| home.update(cx, |h, cx| h.start_rename(window, cx)));
    cx.update(|_, cx| field.update(cx, |f, cx| f.set_text("别的名字", cx)));
    cx.simulate_keystrokes("escape");
    cx.run_until_parked();
    assert!(!renaming(cx));
    assert_eq!(field.read_with(cx, |f, _| f.text()), "慢钟·二稿");
    assert_eq!(
        view.read_with(cx, |ws, _| ws.book.name.clone()),
        "慢钟·二稿"
    );
    // Leaving the field saves too (the 0.1 title saves on blur).
    // Focus listeners run when a drawn frame sees the focus change.
    let frame = |cx: &mut VisualTestContext| {
        cx.update(|window, cx| window.draw(cx).clear(cx));
        cx.run_until_parked();
    };
    cx.update(|window, _| window.activate_window());
    cx.update(|window, cx| home.update(cx, |h, cx| h.start_rename(window, cx)));
    frame(cx);
    cx.update(|_, cx| field.update(cx, |f, cx| f.set_text("慢钟·三稿", cx)));
    cx.update(|window, cx| view.read(cx).focus_handle().clone().focus(window, cx));
    frame(cx);
    wait_for(cx, |cx| {
        view.read_with(cx, |ws, _| ws.book.name == "慢钟·三稿")
    });
    // An empty name keeps the old one.
    cx.update(|window, cx| home.update(cx, |h, cx| h.start_rename(window, cx)));
    cx.update(|_, cx| field.update(cx, |f, cx| f.set_text("  ", cx)));
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    assert_eq!(field.read_with(cx, |f, _| f.text()), "慢钟·三稿");
    assert_eq!(
        view.read_with(cx, |ws, _| ws.book.name.clone()),
        "慢钟·三稿"
    );
}

#[gpui::test]
fn settings_show_the_targets_and_the_summary(cx: &mut TestAppContext) {
    let (_dir, library, id) = library();
    let lib = library.clone();
    let (view, cx) = setup(cx, library, t0_day());
    let home = home_ready(&view, cx);
    cx.update(|window, cx| home.update(cx, |h, cx| h.set_view(HomeView::Settings, window, cx)));
    assert_eq!(home.read_with(cx, |h, _| h.view), HomeView::Settings);
    // A target written through F3 (as the number field does) comes back.
    lib.run::<dr_workspace::commands::book::BookUpdate>(
        &Actor::User,
        dr_workspace::commands::book::BookUpdateIn {
            book: id.clone(),
            name: None,
            summary: None,
            word_target: Some(50_000),
            daily_word_target: Some(0),
        },
    )
    .unwrap();
    wait_for(cx, |cx| {
        home.read_with(cx, |h, _| {
            h.stats
                .as_ref()
                .is_some_and(|s| s.word_target == Some(50_000) && s.daily_target.is_none())
        })
    });
    let book = view.read_with(cx, |ws, _| ws.book.clone());
    assert!(Rc::strong_count(&book) >= 1);
}

#[gpui::test]
fn today_and_the_streak_come_from_the_writing_days(cx: &mut TestAppContext) {
    let (_dir, library, id) = library();
    let lib = library.clone();
    // Read the book's writing days directly to know what to expect.
    let doc = lib.library().load_copy(&format!("book:{id}")).unwrap();
    let reader = dr_doc::book::BookReader::from_loro(id.parse().unwrap(), &doc).unwrap();
    let days = reader.view().writing_days();
    let Some(last) = days.iter().map(|d| d.day.as_str().to_owned()).max() else {
        // 《慢钟》 has no writing days: today is 0 and so is the streak.
        let (view, cx) = setup(cx, library, t0_day());
        let home = home_ready(&view, cx);
        let stats = home.read_with(cx, |h, _| h.stats.clone().unwrap());
        assert_eq!((stats.today, stats.streak), (0, 0));
        return;
    };
    let day = NaiveDate::parse_from_str(&last, "%Y-%m-%d").unwrap();
    let words: i64 = days
        .iter()
        .filter(|d| d.day.as_str() == last)
        .map(|d| d.words)
        .sum();
    let (view, cx) = setup(cx, library, day);
    let home = home_ready(&view, cx);
    let stats = home.read_with(cx, |h, _| h.stats.clone().unwrap());
    assert_eq!(stats.today, words);
    assert!(stats.streak >= 1);
}
