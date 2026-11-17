//! UP (visual polish): Project Home's 继续写 rows keep the page's left edge.
//! A text button in Home's column used to be stretched to the column's width
//! and centred its name in the middle of the sheet.

use std::time::{Duration, Instant};

use dr_shell::{Services, Settings, SettingsFile, ShellInfo, Workspace};
use dr_view_home::{clear_save_project_template, v3::Home};
use dr_workspace::{Actor, Workspace as Library};
use gpui::{Entity, TestAppContext, VisualTestContext, px, size};
use serde_json::{Value, json};

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

/// A long page name stays inside the column: the row gives way at the
/// column's edge (its words end in 「…」) instead of running past the sheet.
#[gpui::test]
fn a_long_page_name_under_continue_stays_inside_the_column(cx: &mut TestAppContext) {
    let (_dir, _root, lib, book) = seed_library();
    // The page under 继续写 is the latest-written chapter: give every
    // chapter of the seed a name far wider than the column.
    let long = "很长的章名".repeat(30);
    let entries: Value = lib
        .call(
            &Actor::User,
            "entry.list",
            json!({"book": book, "all": true}),
        )
        .unwrap()["output"]
        .clone();
    for e in entries.as_array().unwrap() {
        if e["template"] == "tpl-chapter" {
            lib.call(
                &Actor::User,
                "entry.update",
                json!({"book": book, "id": e["id"], "title": long}),
            )
            .unwrap();
        }
    }
    let (_ws, _home, vcx) = open_workspace(cx, &lib, &book);
    wait(vcx, "the long page to continue", |vcx| {
        vcx.debug_bounds("v3-home-continue-0")
            .is_some_and(|button| button.size.width > px(300.0))
    });
    let block = vcx.debug_bounds("v3-home-project-template").unwrap();
    let button = vcx.debug_bounds("v3-home-continue-0").unwrap();
    assert!(
        button.right() <= block.right() + px(0.5),
        "the page's name ends at {:?}, the column at {:?}",
        button.right(),
        block.right()
    );
}

/// A tall stack of unused templates makes the board narrow. The counts
/// still need their natural localized width, rather than the old fixed
/// 150px inside a 170px thumbnail. Check the actual text element's bounds,
/// not a second copy of the thumbnail's width calculation.
fn narrow_thumbnail_keeps_its_counts(cx: &mut TestAppContext, locale: &str) {
    let (_dir, _root, lib, book) = seed_library();
    for i in 0..32 {
        lib.call(
            &Actor::User,
            "entry_template.put",
            json!({
                "book": book,
                "template": {
                    "id": format!("tpl-up-unused-{i}"),
                    "name": format!("合成空置模板{i}"),
                    "level": false,
                    "linkable": false,
                    "modules": [],
                    "settings": {}
                }
            }),
        )
        .unwrap();
    }
    let (ws, _home, vcx) = open_workspace(cx, &lib, &book);
    vcx.update(|_, cx| {
        Settings::update(cx, |file| {
            file.set(dr_shell::settings::registry::UI_LOCALE, locale.into(), None)
                .unwrap();
        });
    });
    wait(vcx, "localized thumbnail counts", |cx| {
        cx.debug_bounds("v5-home-structure-meta-text").is_some()
    });
    let text = vcx.debug_bounds("v5-home-structure-meta-text").unwrap();
    let thumb = vcx.debug_bounds("v5-home-structure-thumbnail").unwrap();
    let board = vcx.debug_bounds("v5-home-structure-board").unwrap();
    let meta = vcx.update(|_, cx| {
        dr_shell::v3::template_structure::template_meta(ws.read(cx).book.v3().unwrap(), cx)
    });
    assert!(meta.contains(if locale == "de" {
        "Vorlagen"
    } else {
        "templates"
    }));
    assert!(
        board.size.width < px(150.0),
        "the narrow-board case: {board:?}"
    );
    assert!(
        text.size.width > px(150.0),
        "{locale} {meta:?} needs more than the former count space: {text:?}"
    );
    assert!(text.left() >= thumb.left() + px(10.0));
    assert!(
        text.right() <= thumb.right() - px(10.0),
        "{locale} {meta:?} ends at {:?}, past the thumbnail's inner edge {:?}",
        text.right(),
        thumb.right() - px(10.0)
    );
    assert!(
        thumb.size.width < px(300.0),
        "keep P9's compact frame, not the former 300px box"
    );
    assert_eq!(thumb.bottom() - board.bottom(), px(10.0));
}

#[gpui::test]
fn a_narrow_thumbnail_keeps_english_counts_inside_its_frame(cx: &mut TestAppContext) {
    narrow_thumbnail_keeps_its_counts(cx, "en");
}

#[gpui::test]
fn a_narrow_thumbnail_keeps_german_counts_inside_its_frame(cx: &mut TestAppContext) {
    narrow_thumbnail_keeps_its_counts(cx, "de");
}
