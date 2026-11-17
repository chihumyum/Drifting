//! UP (visual polish): the full template editor clears the title bar's
//! band.
use std::time::{Duration, Instant};

use dr_shell::{
    Services, SettingsFile, ShellInfo, Workspace as Shell,
    nav::{Open, Target},
    v3::{self, Rendered},
};
use dr_workspace::Workspace;
use gpui::{
    App, AppContext as _, Context, Entity, IntoElement, Render, TestAppContext, VisualTestContext,
    Window, div, px, size,
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
        let _ = dr_ui::init(cx);
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "0.2.0-dev",
                url_scheme: "drifting-next-dev",
                forced_appearance: Some(dr_ui::Appearance::Light),
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
        // Panels open and fill at once: the clicks land where they are drawn.
        dr_shell::Settings::update(cx, |f| {
            f.set(
                dr_shell::settings::registry::REDUCE_MOTION,
                serde_json::json!(true),
                None,
            )
        })
        .unwrap();
        for display in ["list", "board", "grid", "island"] {
            v3::add_level_display(cx, display, |_, _, cx| Rendered::new(cx.new(|_| DummyPart)));
        }
        v3::add_level_settings(cx, |_, _, cx| Rendered::new(cx.new(|_| DummyPart)));
        dr_view_templates::init(cx);
    });
    let (view, cx) = cx.add_window_view(Shell::new);
    cx.update(|window, _| window.activate_window());
    cx.simulate_resize(size(px(1600.0), px(1000.0)));
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
        pump(cx);
        if view.read_with(cx, |ws, cx| done(ws, cx)) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(2));
    }
}

#[gpui::test]
fn the_full_template_editor_starts_below_the_title_bar(cx: &mut TestAppContext) {
    let (_dir, lib, id) = seed();
    let (view, cx) = open(cx, &lib, &id);
    wait(&view, cx, "the book", |ws, _| ws.book.v3().is_some());
    let template = view.read_with(cx, |ws, _| {
        ws.book.v3().unwrap().templates.first().unwrap().id.clone()
    });
    view.update(cx, |ws, cx| {
        ws.open(Target::Template(template.parse().unwrap()), Open::KEEP, cx)
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    let head = loop {
        pump(cx);
        if let Some(head) = cx.debug_bounds("k5-head") {
            break head;
        }
        assert!(Instant::now() < deadline, "the template editor's head");
    };
    // The Tab dock's marks and pills sit in the title bar's band over the
    // paper; the head's name, 已保存, 还原 and 保存 sat in it too.
    assert!(
        head.top() >= px(dr_shell::workspace::TITLEBAR_HEIGHT),
        "the head starts at {:?}",
        head.top()
    );
}
