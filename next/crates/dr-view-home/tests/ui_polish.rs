//! UP (visual polish): Project Home's 继续写 rows keep the page's left edge.
//! A text button in Home's column used to be stretched to the column's width
//! and centred its name in the middle of the sheet.

use std::time::{Duration, Instant};

use dr_shell::{Services, Settings, SettingsFile, ShellInfo, Workspace};
use dr_view_home::{clear_save_project_template, v3::Home};
use dr_workspace::Workspace as Library;
use gpui::{Entity, TestAppContext, VisualTestContext, px, size};

fn seed_library() -> (tempfile::TempDir, std::path::PathBuf, Library, String) {
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
    let lib = Library::open_dir(&root, "test").unwrap();
    (dir, root, lib, book)
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

fn open_workspace<'a>(
    cx: &'a mut TestAppContext,
    lib: &Library,
    book: &str,
) -> (Entity<Workspace>, Entity<Home>, &'a mut VisualTestContext) {
    let day = chrono::NaiveDate::from_ymd_opt(2026, 11, 15).unwrap();
    cx.executor().allow_parking();
    cx.update(|cx| {
        let mut settings = SettingsFile::in_memory();
        settings
            .set(
                dr_shell::settings::registry::UI_LOCALE,
                "zh-CN".into(),
                None,
            )
            .unwrap();
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
                book: Some(book.to_owned()),
                ..Default::default()
            },
            settings,
            cx,
        );
        Settings::update(cx, |s| {
            s.set(
                dr_shell::settings::registry::UI_LOCALE,
                "zh-CN".into(),
                None,
            )
            .unwrap();
        });
        clear_save_project_template(cx);
        dr_view_home::init(cx);
        dr_view_home::set_today(day, cx);
    });
    let (ws, vcx) = cx.add_window_view(Workspace::new);
    vcx.simulate_resize(size(px(1280.0), px(1400.0)));
    vcx.update(|window, _| window.activate_window());
    wait(vcx, "workspace book ready", |vcx| {
        ws.read_with(vcx, |ws, _| {
            ws.book.id == book && ws.book.v3().is_some() && ws.v3_home.is_some()
        })
    });
    ws.update(vcx, |ws, cx| ws.open_home(cx));
    let home: Entity<Home> = ws.read_with(vcx, |ws, _| {
        ws.v3_home.clone().unwrap().downcast::<Home>().unwrap()
    });
    wait(vcx, "home initial numbers", |vcx| {
        home.read_with(vcx, |h, _| h.loaded.is_some())
            && vcx.debug_bounds("v3-home-project-template").is_some()
    });
    (ws, home, vcx)
}

#[gpui::test]
fn continue_rows_start_at_the_column_edge_and_keep_their_width(cx: &mut TestAppContext) {
    let (_dir, _root, lib, book) = seed_library();
    let (_ws, _home, vcx) = open_workspace(cx, &lib, &book);
    wait(vcx, "a page to continue", |vcx| {
        vcx.debug_bounds("v3-home-continue-0-row").is_some()
    });
    let words = vcx.debug_bounds("v3-home-words").unwrap();
    let block = vcx.debug_bounds("v3-home-project-template").unwrap();
    let row = vcx.debug_bounds("v3-home-continue-0-row").unwrap();
    // The text button's own 6px inset at most; not centred in the column.
    assert!(
        row.left() - words.left() <= px(1.0),
        "continue row at {:?}, the column starts at {:?}",
        row.left(),
        words.left()
    );
    assert!(
        row.size.width < block.size.width / 2.0,
        "continue row {:?} wide in a column of {:?}",
        row.size.width,
        block.size.width
    );
}
