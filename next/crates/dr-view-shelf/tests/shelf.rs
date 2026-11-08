//! The bookshelf on GPUI's test platform, over a real library (two of
//! dr-testkit's sample books, 《慢钟》 and 《阿Q正传》, read through F3): the
//! window opens on it and lists the books with F3's numbers; a card opens
//! its book and ⇧⌘W comes back; a new book is created and opened; a book is
//! renamed, moved to Recently Deleted and restored; Recently Deleted counts
//! the days left and deletes a book for good; the books due go two minutes
//! after the shelf shows; a double click on the empty desk starts a new
//! book; Esc closes a dialog; each card carries its cover, its genre and
//! its last 30 days, the heat map follows the card under the pointer, and
//! the round button turns every cover; on the sea of characters a press on
//! the bare desk rings through it and a sample lands once, waiting until it
//! is opened.

use std::time::{Duration, Instant};

use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_view_shelf::{PURGE_EXPIRED_AFTER, Shelf, ShelfDialog, art};
use dr_view_shelf_art::{CoverStyle, cover_is_dark, cover_key};
use dr_workspace::{
    Actor, Workspace as Library,
    commands::{
        BookIn, ListIn,
        book::{BookTrash, FactPut, FactPutIn},
        chapter::ChapterList,
        stats::{WritingDayIn, WritingDayRecord},
    },
};
use gpui::{
    Entity, Modifiers, MouseButton, MouseDownEvent, MouseUpEvent, TestAppContext,
    VisualTestContext, point, px,
};

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

/// A library holding 《慢钟》 and 《阿Q正传》.
fn library() -> (tempfile::TempDir, Library) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let lib = dr_store::Library::open(&root, dr_workspace::library_options(VERSION)).unwrap();
    for book in [
        dr_testkit::samples::slow_clock().unwrap(),
        dr_testkit::samples::a_q().unwrap(),
    ] {
        dr_testkit::seed::write_book(&lib, &book).unwrap();
    }
    lib.close().unwrap();
    (dir, Library::open_dir(&root, VERSION).unwrap())
}

fn setup(cx: &mut TestAppContext, library: Library) -> (Entity<Workspace>, &mut VisualTestContext) {
    // F3 reads and delivers events on its own threads.
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
        dr_view_shelf::init(cx);
    });
    let (view, cx) = cx.add_window_view(Workspace::new);
    cx.run_until_parked();
    (view, cx)
}

/// Runs the app until `done` holds, at most ten seconds.
fn wait_for(cx: &mut VisualTestContext, done: impl Fn(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out");
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

/// Waits until the shelf has been read (again) and `done` holds for it.
fn shelf_until(
    shelf: &Entity<Shelf>,
    cx: &mut VisualTestContext,
    done: impl Fn(&dr_view_shelf::data::ShelfData) -> bool,
) {
    wait_for(cx, |cx| {
        cx.update(|window, _| window.refresh());
        shelf.read_with(cx, |s, _| s.data.as_deref().is_some_and(&done))
    });
}

#[gpui::test]
fn the_window_opens_on_the_shelf_with_every_book(cx: &mut TestAppContext) {
    let (_dir, library) = library();
    let lib = library.clone();
    let (view, cx) = setup(cx, library);
    assert!(view.read_with(cx, |ws, _| ws.shelf_open && ws.book_id.is_empty()));
    let shelf = shelf_of(&view, cx);
    // A freshly seeded library builds its derived indexes in the background;
    // the shelf reads again as each one lands (dr-store's `index` changes).
    lib.library().rebuild_stale_indexes().unwrap();
    // The live chapters' words in the derived index, as F3 lists them.
    let expected = |book: &str| -> u64 {
        lib.run::<ChapterList>(
            &Actor::User,
            ListIn {
                book: book.to_owned(),
                trashed: false,
            },
        )
        .unwrap()
        .output
        .iter()
        .map(|c| c.words)
        .sum()
    };
    shelf_until(&shelf, cx, |d| {
        d.books.len() == 2 && d.books.iter().all(|b| b.words == expected(&b.id))
    });
    let data = shelf.read_with(cx, |s, _| s.data.clone().unwrap());
    let names: Vec<&str> = data.books.iter().map(|b| b.name.as_str()).collect();
    assert!(
        names.contains(&"慢钟") && names.iter().any(|n| n.starts_with("阿Q正传")),
        "{names:?}"
    );
    for book in &data.books {
        // The counts are F3's, the words the chapters' in the derived index.
        let chapters = lib
            .run::<ChapterList>(
                &Actor::User,
                ListIn {
                    book: book.id.clone(),
                    trashed: false,
                },
            )
            .unwrap()
            .output;
        assert_eq!(book.chapters as usize, chapters.len());
        assert_eq!(book.words, expected(&book.id));
        assert!(book.words > 0, "{} has words", book.name);
        assert!(book.edited_ms.is_some());
    }
    assert!(data.trashed.is_empty());
    // Every state draws.
    cx.update(|window, _| window.refresh());
    cx.run_until_parked();
}

#[gpui::test]
fn a_card_opens_its_book_and_cmd_shift_w_or_the_red_light_comes_back(cx: &mut TestAppContext) {
    let (_dir, library) = library();
    let (view, cx) = setup(cx, library);
    let shelf = shelf_of(&view, cx);
    shelf_until(&shelf, cx, |d| d.books.len() == 2);
    let book = shelf.read_with(cx, |s, _| s.data.as_ref().unwrap().books[1].clone());
    cx.update(|window, cx| shelf.update(cx, |s, cx| s.open(&book.id, window, cx)));
    wait_for(cx, |cx| view.read_with(cx, |ws, _| ws.book.id == book.id));
    view.read_with(cx, |ws, _| {
        assert!(!ws.shelf_open);
        assert_eq!(ws.book.name, book.name);
        // A book opened the first time shows its Home.
        assert!(ws.nav.current().is_none());
    });
    // ⇧⌘W: back to the shelf.
    let keys = if cfg!(target_os = "macos") {
        "cmd-shift-w"
    } else {
        "ctrl-shift-w"
    };
    cx.simulate_keystrokes(keys);
    assert!(view.read_with(cx, |ws, _| ws.shelf_open));
    // The other book from there.
    let other = shelf.read_with(cx, |s, _| s.data.as_ref().unwrap().books[0].clone());
    cx.update(|window, cx| shelf.update(cx, |s, cx| s.open(&other.id, window, cx)));
    wait_for(cx, |cx| view.read_with(cx, |ws, _| ws.book.id == other.id));
    assert!(view.read_with(cx, |ws, _| !ws.shelf_open && ws.book_id == other.id));
    // The red light in a book goes back to the shelf and keeps the window;
    // on the shelf it closes the window.
    assert!(!cx.simulate_close());
    assert!(view.read_with(cx, |ws, _| ws.shelf_open));
    assert!(cx.simulate_close());
}

#[gpui::test]
fn a_new_book_is_created_and_opened(cx: &mut TestAppContext) {
    let (_dir, library) = library();
    let (view, cx) = setup(cx, library);
    let shelf = shelf_of(&view, cx);
    shelf_until(&shelf, cx, |d| d.books.len() == 2);
    cx.update(|window, cx| shelf.update(cx, |s, cx| s.start_create(window, cx)));
    assert_eq!(
        shelf.read_with(cx, |s, _| s.dialog()),
        Some(ShelfDialog::Create)
    );
    let (name, summary) = shelf.read_with(cx, |s, _| s.form_fields().unwrap());
    cx.update(|_, cx| {
        name.update(cx, |f, cx| f.set_text("雾港", cx));
        summary.update(cx, |f, cx| f.set_text("守塔人的女儿回到旧港。", cx));
    });
    // Enter in the name field creates it.
    cx.simulate_keystrokes("enter");
    wait_for(cx, |cx| view.read_with(cx, |ws, _| ws.book.name == "雾港"));
    assert_eq!(shelf.read_with(cx, |s, _| s.dialog()), None);
    assert!(view.read_with(cx, |ws, _| !ws.shelf_open));
    // Back on the shelf, it is there with its summary.
    cx.update(|window, cx| view.update(cx, |ws, cx| ws.show_shelf(window, cx)));
    shelf_until(&shelf, cx, |d| d.books.len() == 3);
    let made = shelf.read_with(cx, |s, _| {
        s.data
            .as_ref()
            .unwrap()
            .books
            .iter()
            .find(|b| b.name == "雾港")
            .cloned()
            .unwrap()
    });
    assert_eq!(made.summary, "守塔人的女儿回到旧港。");
    assert_eq!(made.chapters, 0);
}

#[gpui::test]
fn a_book_is_renamed_trashed_and_restored(cx: &mut TestAppContext) {
    let (_dir, library) = library();
    let (view, cx) = setup(cx, library);
    let shelf = shelf_of(&view, cx);
    shelf_until(&shelf, cx, |d| d.books.len() == 2);
    let book = shelf.read_with(cx, |s, _| {
        s.data
            .as_ref()
            .unwrap()
            .books
            .iter()
            .find(|b| b.name == "慢钟")
            .cloned()
            .unwrap()
    });
    // Edit: the dialog starts with the name and summary.
    cx.update(|window, cx| shelf.update(cx, |s, cx| s.start_edit(book.clone(), window, cx)));
    assert_eq!(
        shelf.read_with(cx, |s, _| s.dialog()),
        Some(ShelfDialog::Edit(book.id.clone()))
    );
    let (name, summary) = shelf.read_with(cx, |s, _| s.form_fields().unwrap());
    assert_eq!(name.read_with(cx, |f, _| f.text()), "慢钟");
    assert_eq!(summary.read_with(cx, |f, _| f.text()), book.summary);
    cx.update(|_, cx| name.update(cx, |f, cx| f.set_text("慢钟（二稿）", cx)));
    cx.update(|window, cx| shelf.update(cx, |s, cx| s.submit_form(window, cx)));
    shelf_until(&shelf, cx, |d| {
        d.books.iter().any(|b| b.name == "慢钟（二稿）")
    });
    assert_eq!(shelf.read_with(cx, |s, _| s.dialog()), None);
    assert!(
        view.read_with(cx, |ws, _| ws.shelf_open),
        "editing stays on the shelf"
    );

    // Move to Recently Deleted: asks first, then it leaves the shelf.
    let renamed = shelf.read_with(cx, |s, _| {
        s.data
            .as_ref()
            .unwrap()
            .books
            .iter()
            .find(|b| b.id == book.id)
            .cloned()
            .unwrap()
    });
    cx.update(|window, cx| shelf.update(cx, |s, cx| s.ask_trash(renamed, window, cx)));
    assert_eq!(
        shelf.read_with(cx, |s, _| s.dialog()),
        Some(ShelfDialog::Trash(book.id.clone()))
    );
    cx.update(|window, cx| shelf.update(cx, |s, cx| s.confirm_trash(window, cx)));
    shelf_until(&shelf, cx, |d| d.books.len() == 1 && d.trashed.len() == 1);
    assert_eq!(shelf.read_with(cx, |s, _| s.dialog()), None);
    // Thirty days to go, as F3 counts them.
    let gone = shelf.read_with(cx, |s, _| s.data.as_ref().unwrap().trashed[0].clone());
    assert_eq!(gone.id, book.id);
    assert_eq!(gone.days_left, Some(30));

    // Recently Deleted lists it; restoring brings it back.
    cx.update(|window, cx| shelf.update(cx, |s, cx| s.open_deleted(window, cx)));
    assert_eq!(
        shelf.read_with(cx, |s, _| s.dialog()),
        Some(ShelfDialog::RecentlyDeleted)
    );
    cx.update(|window, cx| shelf.update(cx, |s, cx| s.restore(&book.id, window, cx)));
    shelf_until(&shelf, cx, |d| d.books.len() == 2 && d.trashed.is_empty());
}

#[gpui::test]
fn recently_deleted_deletes_a_book_for_good(cx: &mut TestAppContext) {
    let (_dir, library) = library();
    let lib = library.clone();
    let (view, cx) = setup(cx, library);
    let shelf = shelf_of(&view, cx);
    shelf_until(&shelf, cx, |d| d.books.len() == 2);
    let id = shelf.read_with(cx, |s, _| s.data.as_ref().unwrap().books[0].id.clone());
    // Trashed elsewhere (the Agent, another window): the shelf follows.
    lib.run::<BookTrash>(&Actor::User, BookIn { book: id.clone() })
        .unwrap();
    shelf_until(&shelf, cx, |d| d.trashed.len() == 1);
    let gone = shelf.read_with(cx, |s, _| s.data.as_ref().unwrap().trashed[0].clone());
    cx.update(|window, cx| shelf.update(cx, |s, cx| s.open_deleted(window, cx)));
    // 「立即删除」 asks first; Esc steps back to the list, not out of it.
    cx.update(|window, cx| shelf.update(cx, |s, cx| s.ask_purge(gone.clone(), window, cx)));
    assert_eq!(
        shelf.read_with(cx, |s, _| s.dialog()),
        Some(ShelfDialog::Purge(id.clone()))
    );
    cx.simulate_keystrokes("escape");
    assert_eq!(
        shelf.read_with(cx, |s, _| s.dialog()),
        Some(ShelfDialog::RecentlyDeleted)
    );
    // Confirmed: it is gone for good, and the list shows again.
    cx.update(|window, cx| shelf.update(cx, |s, cx| s.ask_purge(gone.clone(), window, cx)));
    cx.update(|window, cx| shelf.update(cx, |s, cx| s.confirm_purge(window, cx)));
    shelf_until(&shelf, cx, |d| d.books.len() == 1 && d.trashed.is_empty());
    assert_eq!(
        shelf.read_with(cx, |s, _| s.dialog()),
        Some(ShelfDialog::RecentlyDeleted)
    );
    let left = lib
        .run::<dr_workspace::commands::book::BookShelf>(
            &Actor::User,
            dr_workspace::commands::book::ListBooksIn { trashed: true },
        )
        .unwrap()
        .output;
    assert!(left.iter().all(|b| b.info.id != id));
    // Esc on the list closes it.
    cx.simulate_keystrokes("escape");
    assert_eq!(shelf.read_with(cx, |s, _| s.dialog()), None);
}

#[gpui::test]
fn the_books_due_go_two_minutes_after_the_shelf_shows(cx: &mut TestAppContext) {
    let (_dir, library) = library();
    let (view, cx) = setup(cx, library);
    let shelf = shelf_of(&view, cx);
    shelf_until(&shelf, cx, |d| d.books.len() == 2);
    let runs = |cx: &mut VisualTestContext| shelf.read_with(cx, |s, _| s.expired_runs);
    cx.executor()
        .advance_clock(PURGE_EXPIRED_AFTER - Duration::from_secs(1));
    cx.run_until_parked();
    assert_eq!(runs(cx), 0);
    cx.executor().advance_clock(Duration::from_secs(2));
    wait_for(cx, |cx| runs(cx) == 1);
    // In a book, the bookshelf does not count.
    let book = shelf.read_with(cx, |s, _| s.data.as_ref().unwrap().books[0].id.clone());
    cx.update(|window, cx| shelf.update(cx, |s, cx| s.open(&book, window, cx)));
    wait_for(cx, |cx| view.read_with(cx, |ws, _| ws.book.id == book));
    cx.executor().advance_clock(PURGE_EXPIRED_AFTER * 2);
    cx.run_until_parked();
    assert_eq!(runs(cx), 1);
    // Back on the shelf for less than two minutes: nothing; it counts
    // afresh each time it comes up.
    cx.update(|window, cx| view.update(cx, |ws, cx| ws.show_shelf(window, cx)));
    cx.run_until_parked();
    cx.executor().advance_clock(Duration::from_secs(60));
    cx.update(|window, cx| shelf.update(cx, |s, cx| s.open(&book, window, cx)));
    cx.run_until_parked();
    cx.update(|window, cx| view.update(cx, |ws, cx| ws.show_shelf(window, cx)));
    cx.run_until_parked();
    cx.executor().advance_clock(Duration::from_secs(90));
    cx.run_until_parked();
    assert_eq!(runs(cx), 1);
    cx.executor().advance_clock(Duration::from_secs(31));
    wait_for(cx, |cx| runs(cx) == 2);
}

#[gpui::test]
fn a_double_click_on_the_empty_desk_starts_a_book_and_esc_closes_it(cx: &mut TestAppContext) {
    let (_dir, library) = library();
    let (view, cx) = setup(cx, library);
    let shelf = shelf_of(&view, cx);
    shelf_until(&shelf, cx, |d| d.books.len() == 2);
    // Far down the books column, below the cards.
    let size = cx.update(|window, _| window.viewport_size());
    let at = point(size.width - px(60.0), size.height - px(30.0));
    for click_count in [1, 2] {
        cx.simulate_event(MouseDownEvent {
            position: at,
            modifiers: Modifiers::default(),
            button: MouseButton::Left,
            click_count,
            first_mouse: false,
        });
        cx.simulate_event(MouseUpEvent {
            position: at,
            modifiers: Modifiers::default(),
            button: MouseButton::Left,
            click_count,
        });
    }
    cx.run_until_parked();
    assert_eq!(
        shelf.read_with(cx, |s, _| s.dialog()),
        Some(ShelfDialog::Create)
    );
    // Esc in the name field closes it; nothing is created.
    cx.simulate_keystrokes("escape");
    assert_eq!(shelf.read_with(cx, |s, _| s.dialog()), None);
    cx.run_until_parked();
    assert_eq!(
        shelf.read_with(cx, |s, _| s.data.as_ref().unwrap().books.len()),
        2
    );
}

#[gpui::test]
fn without_a_library_the_shelf_is_empty_and_the_account_menu_works(cx: &mut TestAppContext) {
    cx.update(|cx| {
        dr_shell::init(info(), Services::default(), SettingsFile::in_memory(), cx);
        dr_view_shelf::init(cx);
    });
    let (view, cx) = cx.add_window_view(Workspace::new);
    cx.run_until_parked();
    assert!(view.read_with(cx, |ws, _| ws.shelf_open));
    let shelf = shelf_of(&view, cx);
    let data = shelf.read_with(cx, |s, _| s.data.clone().unwrap());
    assert!(data.books.is_empty());
    // The account menu opens from the account cell; Esc closes it.
    cx.update(|window, cx| shelf.update(cx, |s, cx| s.toggle_menu(window, cx)));
    cx.run_until_parked();
    assert!(shelf.read_with(cx, |s, _| s.menu_open()));
    cx.simulate_keystrokes("escape");
    assert!(!shelf.read_with(cx, |s, _| s.menu_open()));
}

#[gpui::test]
fn the_cards_carry_their_covers_and_days_and_the_button_turns_them(cx: &mut TestAppContext) {
    let (_dir, library) = library();
    let lib = library.clone();
    let books = lib
        .run::<dr_workspace::commands::book::BookList>(&Actor::User, Default::default())
        .unwrap()
        .output;
    let slow = books.iter().find(|b| b.name == "慢钟").unwrap().id.clone();
    // A genre for the cover's foot, and two writing days.
    lib.run::<FactPut>(
        &Actor::User,
        FactPutIn {
            book: slow.clone(),
            id: None,
            key: "体裁".into(),
            value: " 悬疑 ".into(),
            place: None,
            pos: None,
        },
    )
    .unwrap();
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    for (day, words) in [(today.clone(), 420), (yesterday(&today), 80)] {
        lib.run::<WritingDayRecord>(
            &Actor::User,
            WritingDayIn {
                book: slow.clone(),
                device: "device-0123456789abcdef01234567".into(),
                day,
                words,
            },
        )
        .unwrap();
    }
    let (view, cx) = setup(cx, library);
    cx.update(|window, _| window.activate_window());
    let shelf = shelf_of(&view, cx);
    wait_for(cx, |cx| {
        cx.update(|window, _| window.refresh());
        shelf.read_with(cx, |s, _| {
            s.art.as_ref().is_some_and(|a| {
                a.books.len() == 2 && a.books.values().all(|b| b.cover.chapters > 0)
            })
        })
    });
    let art_now = shelf.read_with(cx, |s, _| s.art.clone().unwrap());
    let book = &art_now.books[&slow];
    assert_eq!(book.genre.as_deref(), Some("悬疑"));
    let recent = art_now.recent(&slow);
    assert_eq!(recent.len(), 30);
    assert_eq!(&recent[28..], [80, 420]);
    // The cover is drawn off the main thread, in the default style.
    assert_eq!(cx.update(|_, cx| art::cover_style(cx)), CoverStyle::Topo);
    let key = cover_key(&slow, CoverStyle::Topo, &book.cover);
    wait_for(cx, |cx| {
        cx.update(|window, _| window.refresh());
        cx.update(|_, cx| cover_is_dark(&key, cx)).is_some()
    });
    // The pointer on the card: the heat map shows that book alone.
    let card = cx
        .debug_bounds(Box::leak(format!("shelf-card-{slow}").into_boxed_str()))
        .expect("the card is drawn");
    cx.simulate_mouse_move(card.center(), None, Modifiers::none());
    cx.run_until_parked();
    assert_eq!(
        shelf.read_with(cx, |s, _| s.pointed.clone()),
        Some(slow.clone())
    );
    // The round button turns every cover to the next style.
    let turn = cx
        .debug_bounds("shelf-cover-style")
        .expect("the button is drawn");
    cx.simulate_click(turn.center(), Modifiers::none());
    cx.run_until_parked();
    assert_eq!(
        cx.update(|_, cx| art::cover_style(cx)),
        CoverStyle::Topo.next()
    );
    assert_eq!(shelf.read_with(cx, |s, _| s.dialog()), None);
    let key = cover_key(&slow, CoverStyle::Topo.next(), &book.cover);
    wait_for(cx, |cx| {
        cx.update(|window, _| window.refresh());
        cx.update(|_, cx| cover_is_dark(&key, cx)).is_some()
    });
}

/// The day before `day` (`YYYY-MM-DD`).
fn yesterday(day: &str) -> String {
    let d = chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").unwrap();
    (d - chrono::Duration::days(1))
        .format("%Y-%m-%d")
        .to_string()
}

#[gpui::test]
fn on_the_sea_the_desk_rings_and_a_sample_lands_until_opened(cx: &mut TestAppContext) {
    use dr_view_sea::{HoldKind, Sea, first_run};

    let (_dir, library) = library();
    let lib = library.clone();
    let books = lib
        .run::<dr_workspace::commands::book::BookList>(&Actor::User, Default::default())
        .unwrap()
        .output;
    let slow = books.iter().find(|b| b.name == "慢钟").unwrap().id.clone();
    let (view, cx) = setup_on_sea(cx, library);
    // 《慢钟》 is a sample this launch wrote; the shell holds the sea while
    // the shelf shows (here the test does).
    cx.update(|_, cx| first_run::note_samples_created(vec![slow.clone()], cx));
    let hold = cx.update(|window, cx| Sea::of(window, cx).hold(HoldKind::Surface, window));
    let shelf = shelf_of(&view, cx);
    shelf_until(&shelf, cx, |d| d.books.len() == 2);
    wait_for(cx, |cx| {
        cx.update(|window, cx| {
            window.refresh();
            Sea::of(window, cx).is_on()
        })
    });
    // Its card lands once it is drawn, and waits for the author.
    wait_for(cx, |cx| {
        cx.update(|window, cx| {
            window.refresh();
            !first_run::sample_on_shelf(&slow, cx).landing
        })
    });
    assert!(cx.update(|_, cx| first_run::sample_on_shelf(&slow, cx).waiting));
    // A press on the bare desk, far below the cards, rings through the sea.
    let size = cx.update(|window, _| window.viewport_size());
    let at = point(size.width - px(60.0), size.height - px(30.0));
    cx.simulate_event(MouseDownEvent {
        position: at,
        modifiers: Modifiers::default(),
        button: MouseButton::Left,
        click_count: 1,
        first_mouse: false,
    });
    cx.simulate_event(MouseUpEvent {
        position: at,
        modifiers: Modifiers::default(),
        button: MouseButton::Left,
        click_count: 1,
    });
    assert!(cx.update(|window, cx| Sea::of(window, cx).is_moving()));
    assert_eq!(shelf.read_with(cx, |s, _| s.dialog()), None);
    // Opened, the sample waits no longer.
    let card = cx
        .debug_bounds(Box::leak(format!("shelf-card-{slow}").into_boxed_str()))
        .expect("the sample's card");
    cx.simulate_click(card.center(), Modifiers::none());
    cx.run_until_parked();
    assert!(!cx.update(|_, cx| first_run::sample_on_shelf(&slow, cx).waiting));
    drop(hold);
}

/// The sea under the whole window, the workspace over it (what the shell's
/// backdrop will do, M24).
struct OnSeaRoot {
    ws: Entity<Workspace>,
}

impl gpui::Render for OnSeaRoot {
    fn render(
        &mut self,
        window: &mut gpui::Window,
        cx: &mut gpui::Context<Self>,
    ) -> impl gpui::IntoElement {
        use gpui::{ParentElement as _, Styled as _};
        let sea = dr_view_sea::Sea::of(window, cx);
        gpui::div()
            .size_full()
            .relative()
            .child(dr_view_sea::char_sea(&sea))
            .child(
                gpui::div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full()
                    .child(self.ws.clone()),
            )
    }
}

fn setup_on_sea(
    cx: &mut TestAppContext,
    library: Library,
) -> (Entity<Workspace>, &mut VisualTestContext) {
    use gpui::AppContext as _;
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
        dr_view_shelf::init(cx);
    });
    let (root, cx) = cx.add_window_view(|window, cx| OnSeaRoot {
        ws: cx.new(|cx| Workspace::new(window, cx)),
    });
    cx.update(|window, _| window.activate_window());
    cx.run_until_parked();
    let ws = root.read_with(cx, |r, _| r.ws.clone());
    (ws, cx)
}
