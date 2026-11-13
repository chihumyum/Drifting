//! Project Home and a writing day from another device. The window reads the
//! book again only when its content changed; a writing day alone reaches
//! this page's numbers on its own.

use std::time::{Duration, Instant};

use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_view_home::v3::Home;
use dr_workspace::{Actor, Workspace as Library};
use gpui::{Entity, TestAppContext, VisualTestContext};
use serde_json::json;

fn fixture() -> (tempfile::TempDir, Library, String) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let store = dr_store::Library::open(&root, dr_workspace::library_options("test")).unwrap();
    let seed = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let book = seed.books[0].book_id().to_string();
    seed.write_to(&store).unwrap();
    store.rebuild_stale_indexes().unwrap();
    store.close().unwrap();
    (dir, Library::open_dir(&root, "test").unwrap(), book)
}

fn wait(cx: &mut VisualTestContext, stage: &str, done: impl Fn(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        cx.executor().advance_clock(Duration::from_millis(40));
        cx.update(|window, _| window.refresh());
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
        if done(cx) {
            break;
        }
        assert!(Instant::now() < deadline, "home timed out: {stage}");
        std::thread::sleep(Duration::from_millis(3));
    }
}

#[gpui::test]
fn another_devices_writing_day_reaches_home(cx: &mut TestAppContext) {
    let (_dir, lib, book) = fixture();
    let day = chrono::NaiveDate::from_ymd_opt(2026, 11, 12).unwrap();
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "test",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(lib.clone()),
                ..Default::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_view_home::init(cx);
        dr_view_home::set_today(day, cx);
    });
    let (ws, cx) = cx.add_window_view(Workspace::new);
    wait(cx, "workspace", |cx| {
        ws.read_with(cx, |ws, _| ws.book.id == book && ws.v3_home.is_some())
    });
    let home: Entity<Home> = ws.read_with(cx, |ws, _| {
        ws.v3_home.clone().unwrap().downcast::<Home>().unwrap()
    });
    let today = |cx: &mut VisualTestContext| {
        home.read_with(cx, |h, _| h.loaded.as_ref().map(|l| l.days.today))
    };
    wait(cx, "numbers", |cx| today(cx).is_some());
    let before = today(cx).unwrap();
    let reads = ws.read_with(cx, |ws, _| ws.book_reads);

    let record = |words: i64| {
        lib.call(
            &Actor::User,
            "writing_day.record",
            json!({"book": book, "device": "device-000000000000000000000002",
                "day": "2026-11-12", "words": words}),
        )
        .unwrap();
    };
    record(310);
    wait(cx, "the writing day reaches Home", |cx| {
        today(cx) == Some(before + 310)
    });
    record(480);
    wait(cx, "the next minute's count reaches Home", |cx| {
        today(cx) == Some(before + 480)
    });
    assert_eq!(
        ws.read_with(cx, |ws, _| ws.book_reads),
        reads,
        "and the window did not read the book again for it"
    );
    lib.close();
}

struct AllSurfaces {
    ws: Entity<Workspace>,
    home: Entity<Home>,
    shelf: Entity<dr_view_shelf::Shelf>,
    book_editor: Entity<dr_shell::workspace::editors::BookEditor>,
    book: String,
}

impl gpui::Render for AllSurfaces {
    fn render(
        &mut self,
        _: &mut gpui::Window,
        cx: &mut gpui::Context<Self>,
    ) -> impl gpui::IntoElement {
        use gpui::{ParentElement as _, Styled as _};
        gpui::div()
            .size_full()
            .child(self.ws.clone())
            .child(self.home.clone())
            .child(self.shelf.clone())
            .child(self.book_editor.clone())
            .child(dr_view_stats::v3_panel::panel(
                "v3-home-quiet-stats",
                &self.book,
                dr_view_stats::v3::Scope::Book,
                dr_i18n::Locale::En,
                dr_i18n::Platform::Mac,
                None,
                cx,
            ))
    }
}

#[gpui::test]
fn side_docs_wake_only_their_own_views_leaving_shell_and_open_editors_still(
    cx: &mut TestAppContext,
) {
    use dr_shell::nav::{Open, Target};
    use dr_shell::workspace::editors::{BookEditor, EditorSettings, PageView};
    use gpui::AppContext as _;
    use std::cell::Cell;
    use std::rc::Rc;

    let (_dir, lib, book) = fixture();
    let manuscript_root = dr_shell::book::Book::load(&lib, &book)
        .unwrap()
        .v3()
        .unwrap()
        .roots[0]
        .clone();
    let prepared_book = BookEditor::prepare(&lib, &book, &manuscript_root).unwrap();
    let today_str = chrono::Local::now().format("%Y-%m-%d").to_string();
    let today_date = chrono::NaiveDate::parse_from_str(&today_str, "%Y-%m-%d").unwrap();
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "test",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(lib.clone()),
                ..Default::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_view_shelf::init(cx);
        dr_view_stats::init(Some(lib.clone()), cx);
        dr_view_home::init(cx);
        dr_view_home::set_today(today_date, cx);
    });

    let shown_book = book.clone();
    let editor_lib = lib.clone();
    let (root, cx) = cx.add_window_view(move |window, cx| {
        let ws = cx.new(|cx| Workspace::new(window, cx));
        let shelf = ws
            .read(cx)
            .shelf
            .clone()
            .expect("bookshelf created")
            .view
            .downcast::<dr_view_shelf::Shelf>()
            .expect("shelf view");
        let home = ws
            .read(cx)
            .v3_home
            .clone()
            .expect("v3 home created")
            .downcast::<Home>()
            .expect("home view");
        let book_editor = cx.new(|cx| {
            BookEditor::with_prepared(
                editor_lib,
                prepared_book,
                EditorSettings::default(),
                window,
                cx,
            )
        });
        AllSurfaces {
            ws,
            home,
            shelf,
            book_editor,
            book: shown_book,
        }
    });
    cx.update(|window, _| window.activate_window());

    let (ws, home, shelf, book_editor) = root.read_with(cx, |r, _| {
        (
            r.ws.clone(),
            r.home.clone(),
            r.shelf.clone(),
            r.book_editor.clone(),
        )
    });

    // Wait for shelf to load and open the book in the workspace.
    wait(cx, "shelf pictures", |cx| {
        shelf.read_with(cx, |s, _| {
            s.data.is_some() && s.art.as_ref().is_some_and(|a| a.books.contains_key(&book))
        })
    });
    cx.update(|window, cx| shelf.update(cx, |s, cx| s.open(&book, window, cx)));
    wait(cx, "book and home loaded", |cx| {
        ws.read_with(cx, |ws, _| ws.book.id == book)
            && home.read_with(cx, |h, _| h.loaded.is_some())
    });
    let stats = cx
        .update(|_, cx| dr_view_stats::v3_panel::view("v3-home-quiet-stats", cx))
        .expect("stats view registered");
    wait(cx, "stats loaded", |cx| {
        stats.read_with(cx, |v, _| v.loaded().is_some())
    });

    // Open both a single-document prose editor (text material) and the
    // whole-book prose editor in kept tabs so both dr-editor views are live.
    let mat_doc = lib
        .library()
        .docs(Some(&book), Some("material"))
        .unwrap()
        .into_iter()
        .next()
        .expect("text material");
    let mat_id: dr_model::id::MaterialId = mat_doc
        .doc_id
        .strip_prefix("material:")
        .unwrap()
        .parse()
        .unwrap();
    let mat_target = Target::Material(mat_id);
    let mat_key = mat_target.key();
    cx.update(|_, cx| ws.update(cx, |ws, cx| ws.open(mat_target, Open::KEEP, cx)));
    wait(cx, "material editor prepared", |cx| {
        ws.read_with(cx, |ws, _| {
            ws.editors
                .get(&mat_key)
                .is_some_and(|p| matches!(p.view, Some(PageView::Doc(_))))
        })
    });

    // Ensure the chapter entry has its first checkpoint bodies created before
    // measuring steady-state side-document writes.
    let chapter = ws.read_with(cx, |ws, _| {
        ws.book
            .v3()
            .unwrap()
            .entries
            .iter()
            .find(|e| e.template.as_deref() == Some("tpl-chapter"))
            .unwrap()
            .id
            .clone()
    });
    lib.call(
        &Actor::User,
        "entry_snapshot.create",
        json!({"book": book, "entry": chapter}),
    )
    .unwrap();
    wait(cx, "indexes catch up", |_| {
        lib.library().stale_index_docs().unwrap().is_empty()
    });
    for _ in 0..15 {
        cx.executor().advance_clock(Duration::from_millis(80));
        cx.update(|window, _| window.refresh());
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
        std::thread::sleep(Duration::from_millis(5));
    }

    // Observe the open ChapterEditor, BookEditor, and both ProseEditors.
    let editor_wakes = Rc::new(Cell::new(0usize));
    let _obs = cx.update(|_, cx| {
        let (doc_editor, doc_prose) = ws.read_with(cx, |ws, cx| {
            let PageView::Doc(de) = ws.editors[&mat_key].view.as_ref().unwrap() else {
                unreachable!()
            };
            (de.clone(), de.read(cx).editor().clone())
        });
        let book_prose = book_editor.read(cx).editor().clone();
        let bump = |cell: &Rc<Cell<usize>>| {
            let cell = cell.clone();
            move |_: &mut gpui::App| cell.set(cell.get() + 1)
        };
        let b1 = bump(&editor_wakes);
        let b2 = bump(&editor_wakes);
        let b3 = bump(&editor_wakes);
        let b4 = bump(&editor_wakes);
        vec![
            cx.observe(&doc_editor, move |_, cx| b1(cx)),
            cx.observe(&doc_prose, move |_, cx| b2(cx)),
            cx.observe(&book_editor, move |_, cx| b3(cx)),
            cx.observe(&book_prose, move |_, cx| b4(cx)),
        ]
    });

    let ws_reads = ws.read_with(cx, |ws, _| ws.book_reads);
    let home_before = home.read_with(cx, |h, _| h.loaded.as_ref().unwrap().days.today);
    let stats_before = stats.read_with(cx, |v, _| v.loaded().unwrap().days.today);
    editor_wakes.set(0);

    // 1. Recording a writing day wakes Stats, Shelf, and Home, while dr-shell
    //    and open prose editors stay completely quiet.
    lib.call(
        &Actor::User,
        "writing_day.record",
        json!({
            "book": book,
            "device": "device-000000000000000000000002",
            "day": today_str,
            "words": 640
        }),
    )
    .unwrap();

    wait(cx, "writing day reaches Home, Stats, and Shelf", |cx| {
        home.read_with(cx, |h, _| h.loaded.as_ref().map(|d| d.days.today))
            == Some(home_before + 640)
            && stats.read_with(cx, |v, _| v.loaded().map(|d| d.days.today))
                == Some(stats_before + 640)
            && shelf.read_with(cx, |s, _| {
                s.art.as_ref().and_then(|a| a.recent(&book).last().copied())
            }) == Some(640)
    });
    assert_eq!(
        ws.read_with(cx, |ws, _| ws.book_reads),
        ws_reads,
        "writing_day.record must not make dr-shell re-read the book"
    );
    assert_eq!(
        editor_wakes.get(),
        0,
        "writing_day.record must not wake open prose editors"
    );

    // Settle after the writing day before testing entry_snapshot.create.
    for _ in 0..15 {
        cx.executor().advance_clock(Duration::from_millis(80));
        cx.update(|window, _| window.refresh());
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
        std::thread::sleep(Duration::from_millis(5));
    }

    let ws_reads = ws.read_with(cx, |ws, _| ws.book_reads);
    let home_reads = home.read_with(cx, |h, _| h.reads());
    let stats_reads = stats.read_with(cx, |v, _| v.reads());
    let shelf_data = shelf.read_with(cx, |s, _| s.data.clone().unwrap());
    let shelf_art = shelf.read_with(cx, |s, _| s.art.clone().unwrap());
    editor_wakes.set(0);

    // 2. Saving checkpoints leaves Stats, Shelf, Home, dr-shell, and open
    //    prose editors completely quiet.
    for _ in 0..3 {
        lib.call(
            &Actor::User,
            "entry_snapshot.create",
            json!({"book": book, "entry": chapter}),
        )
        .unwrap();
        wait(cx, "checkpoint index row", |_| {
            lib.library().stale_index_docs().unwrap().is_empty()
        });
        for _ in 0..12 {
            cx.executor().advance_clock(Duration::from_millis(80));
            cx.update(|window, _| window.refresh());
            cx.run_until_parked();
            cx.update(|window, cx| window.draw(cx).clear(cx));
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    assert_eq!(
        stats.read_with(cx, |v, _| v.reads()),
        stats_reads,
        "entry_snapshot.create must not wake Stats"
    );
    assert_eq!(
        home.read_with(cx, |h, _| h.reads()),
        home_reads,
        "entry_snapshot.create must not wake Project Home"
    );
    assert!(
        shelf.read_with(cx, |s, _| {
            Rc::ptr_eq(s.data.as_ref().unwrap(), &shelf_data)
                && Rc::ptr_eq(s.art.as_ref().unwrap(), &shelf_art)
        }),
        "entry_snapshot.create must not wake Bookshelf"
    );
    assert_eq!(
        ws.read_with(cx, |ws, _| ws.book_reads),
        ws_reads,
        "entry_snapshot.create must not make dr-shell re-read the book"
    );
    assert_eq!(
        editor_wakes.get(),
        0,
        "entry_snapshot.create must not wake open prose editors"
    );

    cx.update(|_, cx| dr_view_stats::release(cx));
    lib.close();
}
