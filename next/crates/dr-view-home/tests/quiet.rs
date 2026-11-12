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
