//! UP (visual polish) regressions in the shell.
use std::time::{Duration, Instant};

use dr_shell::{
    Services, SettingsFile, ShellInfo, Workspace as Shell,
    v3::{self, Rendered},
    workspace::FillPlace,
};
use dr_workspace::Workspace;
use gpui::{
    App, AppContext as _, Context, Entity, IntoElement, Render, TestAppContext, VisualTestContext,
    Window, div,
};

fn seed() -> (tempfile::TempDir, Workspace, String) {
    let dir = tempfile::tempdir().unwrap();
    let store =
        dr_store::Library::open(dir.path(), dr_workspace::library_options("0.2.0-dev")).unwrap();
    let made = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let id = made.books[0].book_id().to_string();
    made.write_to(&store).unwrap();
    store.close().unwrap();
    let ws = Workspace::open_dir(dir.path(), "0.2.0-dev").unwrap();
    (dir, ws, id)
}

struct DummyPart;
impl Render for DummyPart {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
    }
}

fn open<'a>(
    cx: &'a mut TestAppContext,
    lib: &Workspace,
    id: &str,
) -> (Entity<Shell>, &'a mut VisualTestContext) {
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "0.2.0-dev",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(lib.clone()),
                book: Some(id.to_owned()),
                ..Default::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_shell::strings::Strings::install(dr_i18n::Locale::ZhCn, cx);
        for display in ["list", "board", "grid", "island"] {
            v3::add_level_display(cx, display, |_, _, cx| Rendered::new(cx.new(|_| DummyPart)));
        }
        v3::add_level_settings(cx, |_, _, cx| Rendered::new(cx.new(|_| DummyPart)));
    });
    let (view, cx) = cx.add_window_view(Shell::new);
    cx.update(|window, _| window.activate_window());
    (view, cx)
}

fn pump(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.run_until_parked();
}

fn wait(
    view: &Entity<Shell>,
    cx: &mut VisualTestContext,
    what: &str,
    done: impl Fn(&Shell, &App) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.executor().advance_clock(Duration::from_millis(40));
        pump(cx);
        if view.read_with(cx, |ws, cx| done(ws, cx)) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// The paper's corner (the timeline's bamboo, the page tools, the incense
/// stick) stands at the paper's bottom right. A side panel filled over the
/// whole middle column leaves no paper, and the corner stood on that panel's
/// own foot instead: over the left column's 进模板结构 and 新建模板.
#[gpui::test]
fn a_fill_over_the_paper_takes_the_corner_with_the_paper(cx: &mut TestAppContext) {
    let (_dir, lib, id) = seed();
    let (view, cx) = open(cx, &lib, &id);
    wait(&view, cx, "the book", |ws, _| ws.book.v3().is_some());
    assert!(
        cx.debug_bounds("paper-corner").is_some(),
        "the corner by the paper"
    );
    for place in [FillPlace::Left, FillPlace::Right] {
        cx.update(|window, cx| {
            view.update(cx, |ws, cx| {
                ws.enter_fill(place, window, cx);
            })
        });
        wait(&view, cx, "the filled column", |ws, _| {
            ws.is_filled(place) && ws.fill_progress(place) >= 1.0
        });
        assert!(
            cx.debug_bounds("paper-corner").is_none(),
            "{place:?} filled over the paper, the corner went with it"
        );
        cx.update(|window, cx| view.update(cx, |ws, cx| ws.exit_fill(window, cx)));
        wait(&view, cx, "the paper again", |ws, _| ws.filled().is_none());
        assert!(
            cx.debug_bounds("paper-corner").is_some(),
            "the corner is back"
        );
    }
}
