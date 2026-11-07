//! The bookshelf on GPUI's test platform, over a real library (two of
//! dr-testkit's sample books, 《慢钟》 and 《阿Q正传》, read through F3): the
//! window opens on it and lists the books with F3's numbers; a card opens
//! its book and ⇧⌘W comes back; a new book is created and opened; a book is
//! renamed, moved to Recently Deleted and restored; a double click on the
//! empty desk starts a new book; Esc closes a dialog.

use std::time::{Duration, Instant};

use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_view_shelf::{Shelf, ShelfDialog};
use dr_workspace::Workspace as Library;
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
    let expected = |book: &str| -> u64 {
        let chapters = lib
            .run::<dr_workspace::commands::chapter::ChapterList>(
                &dr_workspace::Actor::User,
                dr_workspace::commands::ListIn {
                    book: book.to_owned(),
                    trashed: false,
                },
            )
            .unwrap()
            .output;
        let docs: Vec<String> = chapters.iter().map(|c| format!("node:{}", c.id)).collect();
        dr_view_shelf::data::words_of(&lib, &docs)
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
            .run::<dr_workspace::commands::chapter::ChapterList>(
                &dr_workspace::Actor::User,
                dr_workspace::commands::ListIn {
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
