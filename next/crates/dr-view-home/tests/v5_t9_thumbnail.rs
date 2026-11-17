//! T9 (`kernel-v5.md` §9, `W30Home` 乙): the 「结构」 row of the Project
//! Template table draws the structure small, 300 × 226, its head the counts
//! (「16 模板 · 88 条目」), between the targets and 写给 Agent; a click fills
//! the left column into 模板结构.
use std::time::{Duration, Instant};

use dr_shell::{
    Services, Settings, SettingsFile, ShellInfo, Workspace, v3::template_structure::template_meta,
    workspace::FillPlace,
};
use dr_view_home::{clear_save_project_template, v3::Home};
use dr_workspace::Workspace as Library;
use gpui::{Entity, Modifiers, TestAppContext, VisualTestContext, point, px, size};

fn seed_library() -> (tempfile::TempDir, Library, String) {
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
    (dir, lib, book)
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
) -> (Entity<Workspace>, &'a mut VisualTestContext) {
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
        dr_view_home::set_today(chrono::NaiveDate::from_ymd_opt(2026, 11, 15).unwrap(), cx);
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
    wait(vcx, "home", |vcx| {
        home.read_with(vcx, |h, _| h.loaded.is_some())
            && vcx.debug_bounds("v5-home-structure-thumbnail").is_some()
    });
    (ws, vcx)
}

#[gpui::test]
fn the_structure_row_draws_the_board_small_under_its_counts_and_opens_the_structure(
    cx: &mut TestAppContext,
) {
    let (_dir, lib, book) = seed_library();
    let (ws, vcx) = open_workspace(cx, &lib, &book);

    let thumb = vcx.debug_bounds("v5-home-structure-thumbnail").unwrap();
    // The thumbnail is the board as drawn and its margins, never larger
    // (UP, kernel-v5 §15 item 50; it was a fixed 300 × 226 with the board
    // in a corner): 10 round the board, 30 above it for the counts, and
    // no narrower than the counts need (170).
    let board = vcx
        .debug_bounds("v5-home-structure-board")
        .expect("the board");
    assert!(board.size.width <= px(262.0) && board.size.height <= px(194.0));
    assert_eq!(board.origin - thumb.origin, point(px(10.0), px(30.0)));
    assert_eq!(thumb.bottom() - board.bottom(), px(10.0));
    assert!(
        thumb.right() - board.right() == px(10.0) || thumb.size.width == px(170.0),
        "the thumbnail {:?} round the board {:?}",
        thumb.size,
        board.size
    );
    // The head: the counts, 10 in and 6 down.
    let head = vcx
        .debug_bounds("v5-home-structure-meta")
        .expect("the head");
    assert_eq!(head.origin - thumb.origin, point(px(10.0), px(6.0)));
    let (templates, entries, meta) = vcx.update(|_, cx| {
        let book = ws.read(cx).book.clone();
        let v = book.v3().unwrap();
        (
            v.templates
                .iter()
                .filter(|t| t.deleted_at.is_none())
                .count(),
            v.entries.len(),
            template_meta(v, cx),
        )
    });
    assert!(templates > 0 && entries > 0);
    assert_eq!(meta.as_ref(), format!("{templates} 模板 · {entries} 条目"));

    // Where it was: in 项目模板, after the targets, before 写给 Agent.
    let target = vcx
        .debug_bounds("v3-home-daily-target-input")
        .expect("a target");
    let agent = vcx
        .debug_bounds("v3-home-agent-name-input")
        .expect("写给 Agent");
    assert!(thumb.origin.y > target.origin.y);
    assert!(thumb.origin.y + thumb.size.height < agent.origin.y);

    // A click fills the left column into 模板结构.
    vcx.simulate_click(thumb.center(), Modifiers::default());
    wait(vcx, "模板结构", |vcx| {
        ws.read_with(vcx, |ws, cx| {
            ws.is_filled(FillPlace::Left)
                && ws
                    .v3_sidebar
                    .as_ref()
                    .is_some_and(|sb| sb.read(cx).is_in_structure())
        })
    });
}
