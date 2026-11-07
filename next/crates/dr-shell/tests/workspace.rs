//! The workspace on GPUI's test platform: shortcuts reach their actions
//! through the keymap, Esc closes layers one at a time, rebinding takes
//! effect at once, deep links open pages, the layout comes back.

use std::sync::Arc;

use dr_platform::DeepLinks;
use dr_shell::nav::{Open, Page, Target};
use dr_shell::settings::registry;
use dr_shell::workspace::{Layer, SuperView};
use dr_shell::{Services, Settings, SettingsFile, ShellInfo, Workspace};
use gpui::{Entity, TestAppContext, VisualTestContext};
use serde_json::Value;

const SCHEME: &str = "drifting-next-dev";

fn info() -> ShellInfo {
    ShellInfo {
        app_name: "Drifting Next",
        bundle_id: "cc.drifting.next.dev",
        version: "0.2.0-dev",
        url_scheme: SCHEME,
        forced_appearance: None,
    }
}

fn setup(
    cx: &mut TestAppContext,
    file: SettingsFile,
    links: Option<Arc<DeepLinks>>,
) -> (Entity<Workspace>, &mut VisualTestContext) {
    cx.update(|cx| {
        dr_shell::init(
            info(),
            Services {
                deep_links: links,
                crash_reports: None,
            },
            file,
            cx,
        );
    });
    let (view, cx) = cx.add_window_view(Workspace::new);
    cx.run_until_parked();
    (view, cx)
}

/// The tests write the primary modifier as `cmd-`; elsewhere it is Ctrl.
fn keys(cx: &mut VisualTestContext, strokes: &str) {
    let strokes = if cfg!(target_os = "macos") {
        strokes.to_owned()
    } else {
        strokes.replace("cmd-", "ctrl-")
    };
    cx.simulate_keystrokes(&strokes);
}

fn chapter(n: u8) -> Target {
    Target::Chapter(format!("ch-{n}").parse().unwrap())
}

#[gpui::test]
fn shortcuts_go_back_and_forward_through_the_keymap(cx: &mut TestAppContext) {
    let (view, cx) = setup(cx, SettingsFile::in_memory(), None);
    view.update(cx, |ws, cx| {
        ws.open(chapter(1), Open::KEEP, cx);
        ws.open(chapter(2), Open::KEEP, cx);
    });
    keys(cx, "cmd-[");
    assert_eq!(
        view.read_with(cx, |ws, _| ws.nav.page()),
        Page::Target(chapter(1))
    );
    keys(cx, "cmd-]");
    assert_eq!(
        view.read_with(cx, |ws, _| ws.nav.page()),
        Page::Target(chapter(2))
    );
    // ⌘⌥← and ⇧⌘[ both go to the previous tab; ⌘W closes it.
    keys(cx, "cmd-alt-left");
    assert_eq!(
        view.read_with(cx, |ws, _| ws.nav.page()),
        Page::Target(chapter(1))
    );
    keys(cx, "cmd-shift-]");
    assert_eq!(
        view.read_with(cx, |ws, _| ws.nav.page()),
        Page::Target(chapter(2))
    );
    keys(cx, "cmd-w");
    assert_eq!(view.read_with(cx, |ws, _| ws.nav.tabs().len()), 1);
    // ⌘N goes home; ⌘⌥2 opens the whole book.
    keys(cx, "cmd-n");
    assert_eq!(view.read_with(cx, |ws, _| ws.nav.page()), Page::Home);
    keys(cx, "cmd-alt-2");
    assert_eq!(
        view.read_with(cx, |ws, _| ws.nav.page()),
        Page::Target(Target::Book)
    );
}

#[gpui::test]
fn escape_closes_one_layer_at_a_time(cx: &mut TestAppContext) {
    let (view, cx) = setup(cx, SettingsFile::in_memory(), None);
    keys(cx, "cmd-alt-4");
    assert_eq!(
        view.read_with(cx, |ws, _| ws.super_view),
        Some(SuperView::Elements)
    );
    view.update_in(cx, |ws, window, cx| ws.open_settings(window, cx));
    view.update(cx, |ws, cx| {
        ws.notifications_open = true;
        cx.notify();
    });
    cx.run_until_parked();
    let top = |cx: &mut VisualTestContext| view.read_with(cx, |ws, _| ws.top_layer());
    assert_eq!(top(cx), Some(Layer::Notifications));
    view.update_in(cx, |ws, window, cx| ws.dismiss(window, cx));
    assert_eq!(top(cx), Some(Layer::Settings));
    // The settings search field has the focus: its Esc clears, then closes.
    keys(cx, "escape");
    cx.run_until_parked();
    assert_eq!(top(cx), Some(Layer::SuperView));
    keys(cx, "escape");
    assert_eq!(top(cx), None);
    // ⌘⌥4 twice toggles; ⌘[ closes a Super View before going back.
    view.update(cx, |ws, cx| ws.open(chapter(1), Open::KEEP, cx));
    keys(cx, "cmd-alt-3");
    keys(cx, "cmd-[");
    assert_eq!(
        view.read_with(cx, |ws, _| (ws.super_view, ws.nav.page())),
        (None, Page::Target(chapter(1)))
    );
}

#[gpui::test]
fn a_rebound_shortcut_takes_effect_at_once_and_is_stored(cx: &mut TestAppContext) {
    let (view, cx) = setup(cx, SettingsFile::in_memory(), None);
    view.update(cx, |ws, cx| {
        ws.open(chapter(1), Open::KEEP, cx);
        ws.open(chapter(2), Open::KEEP, cx);
    });
    cx.update(|_, cx| {
        Settings::update(cx, |file| {
            file.set_key_binding("goBack", Some("alt-secondary-b"))
        });
        let overrides = Settings::read(cx).key_bindings();
        dr_shell::keymap::apply(&overrides, cx);
    });
    keys(cx, "cmd-[");
    assert_eq!(
        view.read_with(cx, |ws, _| ws.nav.page()),
        Page::Target(chapter(2)),
        "the old key no longer goes back"
    );
    keys(cx, "cmd-alt-b");
    assert_eq!(
        view.read_with(cx, |ws, _| ws.nav.page()),
        Page::Target(chapter(1))
    );
    let stored = cx.update(|_, cx| Settings::read(cx).key_bindings());
    assert_eq!(stored["goBack"], "alt-secondary-b");
}

#[gpui::test]
fn sidebars_open_with_their_shortcuts_and_slide(cx: &mut TestAppContext) {
    let (view, cx) = setup(cx, SettingsFile::in_memory(), None);
    assert!(
        !view.read_with(cx, |ws, _| ws.left.open),
        "new layouts start with both closed"
    );
    view.update_in(cx, |ws, window, cx| ws.toggle_left(window, cx));
    let (open, target) = view.read_with(cx, |ws, _| (ws.left.open, ws.left.reveal.to));
    assert!(open);
    assert_eq!(target, 1.0);
}

#[gpui::test]
fn a_deep_link_opens_its_page_on_the_main_thread(cx: &mut TestAppContext) {
    let links = DeepLinks::new(SCHEME);
    let (view, cx) = setup(cx, SettingsFile::in_memory(), Some(links.clone()));
    // In the app the waker fires on whichever thread delivered the link and
    // the channel brings it to the main thread; the test scheduler only
    // allows its own thread, so the push happens here.
    links.push_all([format!(
        "{SCHEME}://open/stand-in-book/chapters/id-ch-3/prose.md#L5-L7"
    )]);
    cx.run_until_parked();
    assert_eq!(
        view.read_with(cx, |ws, _| ws.nav.page()),
        Page::Target(chapter(3))
    );
    let lines = view.update(cx, |ws, _| ws.nav.take_reveal(&chapter(3)));
    assert_eq!(lines.map(|l| (l.start, l.end)), Some((5, Some(7))));
    // A document-form link by name, from text.
    let opened = view.update_in(cx, |ws, window, cx| {
        ws.open_link("drifting:chapters/船票/prose.md", window, cx)
    });
    assert!(opened);
    assert_eq!(
        view.read_with(cx, |ws, _| ws.nav.page()),
        Page::Target(chapter(5))
    );
    // Another book's link does not navigate.
    let opened = view.update_in(cx, |ws, window, cx| {
        ws.open_link(
            &format!("{SCHEME}://open/other/chapters/id-ch-1/prose.md"),
            window,
            cx,
        )
    });
    assert!(!opened);
}

#[gpui::test]
fn the_layout_is_stored_per_book_and_comes_back(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (view, vcx) = setup(cx, SettingsFile::open(dir.path()), None);
    view.update_in(vcx, |ws, window, cx| {
        ws.open(chapter(2), Open::KEEP, cx);
        ws.open(chapter(4), Open::PREVIEW, cx);
        ws.toggle_right(window, cx);
    });
    // As ⌘Q does: after the dispatch, when no window is checked out.
    vcx.update(|_, cx| {
        cx.defer(|cx| {
            dr_shell::workspace::save_all_layouts(cx);
            Settings::flush(cx);
        })
    });
    vcx.run_until_parked();
    let saved = SettingsFile::open(dir.path());
    let layout = saved.layout("stand-in-book").cloned().expect("stored");
    assert_eq!(layout["right"]["open"], Value::Bool(true));
    // A new window over the same file restores the tabs and the page.
    let mut fresh = cx.new_app();
    let (again, vcx2) = setup(&mut fresh, saved, None);
    let (tabs, page, right) = again.read_with(vcx2, |ws, _| {
        (ws.nav.tabs().len(), ws.nav.page(), ws.right.open)
    });
    assert_eq!((tabs, right), (2, true));
    assert_eq!(page, Page::Target(chapter(4)));
}

#[gpui::test]
fn settings_take_effect_and_reach_the_file(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (_view, cx) = setup(cx, SettingsFile::open(dir.path()), None);
    cx.update(|window, cx| {
        Settings::update(cx, |f| f.set(registry::THEME, Value::from("dark"), None)).unwrap();
        Settings::update(cx, |f| {
            f.set(registry::TEXT_SIZE, Value::from("large"), None)
        })
        .unwrap();
        Settings::update(cx, |f| f.set(registry::UI_LOCALE, Value::from("en"), None)).unwrap();
        let theme = dr_ui::Theme::of(window, cx);
        assert_eq!(theme.appearance, dr_ui::Appearance::Dark);
        assert_eq!(theme.scale, dr_ui::tokens::TextSize::Large.scale());
        assert_eq!(
            dr_shell::t(cx, dr_i18n::keys::right_sidebar::tabs::COMPANION),
            "Agent"
        );
    });
    // Written after the delay, not at once.
    assert!(!dir.path().join("settings.json").exists());
    cx.executor()
        .advance_clock(dr_shell::settings::SAVE_DELAY * 2);
    cx.run_until_parked();
    let raw: Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("settings.json")).unwrap()).unwrap();
    assert_eq!(raw["account"]["appearance.theme"], "dark");
    assert_eq!(raw["device"]["appearance.interface_text_size"], "large");
}

#[gpui::test]
fn quitting_runs_the_hooks_and_writes_the_file_first(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (_view, cx) = setup(cx, SettingsFile::open(dir.path()), None);
    let ran = std::rc::Rc::new(std::cell::Cell::new(false));
    let seen = ran.clone();
    cx.update(|_, cx| {
        Settings::update(cx, |f| f.set(registry::TYPEWRITER, Value::Bool(true), None)).unwrap();
        dr_shell::quit::before_quit(cx, move |_| seen.set(true));
        dr_shell::quit::request(cx);
    });
    cx.run_until_parked();
    assert!(ran.get());
    let raw: Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("settings.json")).unwrap()).unwrap();
    assert_eq!(
        raw["account"]["editor.typewriter_mode"], true,
        "written before the quit, not after"
    );
}

#[gpui::test]
fn the_shell_draws_every_layer(cx: &mut TestAppContext) {
    // A smoke test: render each state once without panicking.
    let (view, cx) = setup(cx, SettingsFile::in_memory(), None);
    view.update_in(cx, |ws, window, cx| {
        ws.toggle_left(window, cx);
        ws.toggle_right(window, cx);
        ws.open(chapter(1), Open::KEEP, cx);
        ws.open(chapter(2), Open::PREVIEW, cx);
        ws.nav.activate(0);
        ws.nav.split_with(1, dr_shell::nav::Side::Right);
        ws.dock_locked = true;
    });
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    view.update_in(cx, |ws, window, cx| {
        ws.toggle_super_view(SuperView::ReviewMaterials, cx);
        ws.open_settings(window, cx);
        ws.notifications_open = true;
    });
    cx.update(|_, cx| {
        dr_shell::notifications::Notifications::post(
            dr_shell::notifications::Source::Update,
            "Drifting 0.2.1",
            cx,
        );
    });
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
}

#[gpui::test]
fn the_tabs_under_a_super_view_do_not_answer_the_keyboard(cx: &mut TestAppContext) {
    let (view, cx) = setup(cx, SettingsFile::in_memory(), None);
    view.update(cx, |ws, cx| {
        ws.open(chapter(1), Open::KEEP, cx);
        ws.open(chapter(2), Open::KEEP, cx);
    });
    keys(cx, "cmd-alt-5");
    keys(cx, "cmd-w");
    keys(cx, "cmd-alt-left");
    let (tabs, page) = view.read_with(cx, |ws, _| (ws.nav.tabs().len(), ws.nav.page()));
    assert_eq!((tabs, page), (2, Page::Target(chapter(2))));
}
