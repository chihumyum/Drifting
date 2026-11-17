//! UP's six-step guide in the real Workspace/Home/sidebars on GPUI's test
//! platform. These layout and keyboard tests are not native-window acceptance.

use std::time::{Duration, Instant};

use dr_shell::{
    Services, Settings, SettingsFile, ShellInfo, Workspace,
    nav::{Open, Target},
    settings::registry,
    workspace::FillPlace,
};
use dr_view_sea::tour::{self, TourState};
use dr_workspace::{Actor, Workspace as Library, WorkspaceOptions};
use gpui::{
    Bounds, Entity, Focusable as _, Modifiers, Pixels, TestAppContext, VisualTestContext, px, size,
};
use serde_json::json;

fn fixture() -> (tempfile::TempDir, Library, [String; 2]) {
    let dir = tempfile::tempdir().unwrap();
    let store = dr_store::Library::open(
        &dir.path().join("library"),
        dr_workspace::library_options("0.2.0-dev"),
    )
    .unwrap();
    let books = [0, 1].map(|extra| {
        let seed = dr_testkit::seed::generate_v3(
            dr_testkit::seed::Preset::Tiny,
            dr_testkit::seed::DEFAULT_SEED + extra,
        )
        .unwrap();
        let id = seed.books[0].book_id().to_string();
        seed.write_to(&store).unwrap();
        id
    });
    assert_ne!(books[0], books[1]);
    store.rebuild_stale_indexes().unwrap();
    let lib = Library::open(store, WorkspaceOptions::default()).unwrap();
    (dir, lib, books)
}

fn setup<'a>(
    cx: &'a mut TestAppContext,
    lib: &Library,
    book: &str,
    settings: SettingsFile,
) -> (Entity<Workspace>, &'a mut VisualTestContext) {
    setup_with_tour(cx, lib, book, settings, true)
}

fn setup_with_tour<'a>(
    cx: &'a mut TestAppContext,
    lib: &Library,
    book: &str,
    mut settings: SettingsFile,
    install_tour: bool,
) -> (Entity<Workspace>, &'a mut VisualTestContext) {
    cx.executor().allow_parking();
    settings.set_device_memory(dr_shell::workspace::FIRST_RUN_DONE, Some(json!(true)));
    settings
        .set(registry::UI_LOCALE, json!("zh-CN"), None)
        .unwrap();
    settings
        .set(registry::REDUCE_MOTION, json!(true), None)
        .unwrap();
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
                book: Some(book.to_owned()),
                ..Default::default()
            },
            settings,
            cx,
        );
        dr_view_shelf::init(cx);
        dr_view_home::init(cx);
        dr_view_page::init(cx);
        dr_view_elements::init(cx);
        dr_view_timeline::init(cx);
        if install_tour {
            dr_view_sea::shell::init(cx);
        }
    });
    let (ws, vcx) = cx.add_window_view(Workspace::new);
    vcx.simulate_resize(size(px(1440.0), px(900.0)));
    vcx.update(|window, _| window.activate_window());
    (ws, vcx)
}

fn frames(cx: &mut VisualTestContext) {
    for _ in 0..3 {
        cx.run_until_parked();
        cx.update(|window, cx| {
            window.simulate_next_frame(cx);
            window.refresh();
            window.draw(cx).clear(cx);
        });
    }
    cx.run_until_parked();
}

fn wait(cx: &mut VisualTestContext, why: &str, done: impl Fn(&mut VisualTestContext) -> bool) {
    let end = Instant::now() + Duration::from_secs(15);
    loop {
        frames(cx);
        if done(cx) {
            return;
        }
        assert!(Instant::now() < end, "workspace tour: {why}");
        cx.executor().advance_clock(Duration::from_millis(30));
        std::thread::sleep(Duration::from_millis(3));
    }
}

fn current(cx: &mut VisualTestContext) -> Option<TourState> {
    cx.update(|window, cx| tour::current(window, cx))
}

fn step(cx: &mut VisualTestContext, id: &str) -> TourState {
    wait(cx, id, |cx| current(cx).is_some_and(|s| s.id == id));
    current(cx).unwrap()
}

fn click(cx: &mut VisualTestContext, id: &'static str) {
    wait(cx, id, |cx| cx.debug_bounds(id).is_some());
    let at = cx.debug_bounds(id).unwrap().center();
    cx.simulate_mouse_move(at, None, Modifiers::default());
    cx.simulate_click(at, Modifiers::default());
    frames(cx);
}

fn union(cx: &mut VisualTestContext, ids: &[&'static str]) -> Bounds<Pixels> {
    tour::geometry::union(ids.iter().map(|id| cx.debug_bounds(id).expect(id))).unwrap()
}

fn secondary(key: &str) -> String {
    format!(
        "{}-{key}",
        if cfg!(target_os = "macos") {
            "cmd"
        } else {
            "ctrl"
        }
    )
}

#[gpui::test]
fn six_steps_follow_real_controls_fallbacks_and_keyboard_focus(cx: &mut TestAppContext) {
    let (_dir, lib, [book, _]) = fixture();
    let (ws, cx) = setup(cx, &lib, &book, SettingsFile::in_memory());
    let first = step(cx, "tabs");
    if !first.fallback {
        click(cx, "toggle-left");
    }
    let closed = step(cx, "tabs");
    assert!(closed.fallback);
    assert_eq!(closed.target, cx.debug_bounds("toggle-left").unwrap());
    click(cx, "toggle-left");
    wait(cx, "left Tab ring", |cx| {
        current(cx).is_some_and(|s| !s.fallback)
    });
    assert_eq!(
        current(cx).unwrap().target,
        cx.debug_bounds("v3-tab-row").unwrap()
    );

    // The actual KB action takes the keyboard; Esc belongs to the sidebar,
    // not to the still-visible tour. Then its real Next button takes it back.
    cx.simulate_keystrokes(&secondary("shift-l"));
    wait(cx, "left keyboard", |cx| {
        cx.update(|window, cx| ws.read(cx).keyboard_in_left(window, cx))
    });
    cx.simulate_keystrokes("escape");
    frames(cx);
    assert!(!cx.update(|window, cx| ws.read(cx).keyboard_in_left(window, cx)));
    assert_eq!(current(cx).unwrap().id, "tabs");
    assert!(!cx.update(|_, cx| tour::is_seen(cx)));

    click(cx, "tour-next");
    let moons = step(cx, "moons");
    let moon_halves = union(cx, &["toggle-left", "fill-left"]);
    assert!(moons.target.contains(&moon_halves.origin));
    assert!(moons.target.right() >= moon_halves.right());
    click(cx, "fill-left");
    assert!(ws.read_with(cx, |ws, _| ws.is_filled(FillPlace::Left)));
    assert!(current(cx).is_none());
    click(cx, "fill-left");
    step(cx, "tabs");
    click(cx, "tour-next");
    step(cx, "moons");
    click(cx, "tour-next");
    let create = step(cx, "create");
    assert_eq!(
        create.target,
        cx.debug_bounds("v3-home-create-row").unwrap()
    );
    assert!(create.target.size.height > px(0.0));
    click(cx, "tour-next");
    let timeline = step(cx, "timeline");
    assert_eq!(
        timeline.target,
        cx.debug_bounds("corner-timeline-home").unwrap()
    );
    click(cx, "tour-next");
    let agent = step(cx, "agent");
    if !agent.fallback {
        click(cx, "toggle-right");
    }
    assert!(current(cx).unwrap().fallback);
    assert_eq!(
        current(cx).unwrap().target,
        cx.debug_bounds("toggle-right").unwrap()
    );
    click(cx, "toggle-right");
    wait(cx, "Agent segment", |cx| {
        current(cx).is_some_and(|s| s.id == "agent" && !s.fallback)
    });
    let agent = current(cx).unwrap();
    assert_eq!(
        agent.target,
        cx.debug_bounds("right-primary-tabs-Agent").unwrap(),
        "the Agent ring wraps only its own segment"
    );
    click(cx, "right-primary-tabs-Agent");
    assert_eq!(
        ws.read_with(cx, |ws, _| ws.right.panes.focused_tab()),
        dr_shell::workspace::RightTab::Companion
    );
    let all_tabs = cx.debug_bounds("right-primary-tabs").unwrap();
    assert!(
        agent.target.size.width < all_tabs.size.width / 2.0,
        "only Agent, not all five RL tabs"
    );
    cx.simulate_resize(size(px(1100.0), px(900.0)));
    frames(cx);
    assert_eq!(
        current(cx).unwrap().id,
        "agent",
        "resizing must keep a still-visible step"
    );
    assert_eq!(
        current(cx).unwrap().target,
        cx.debug_bounds("right-primary-tabs-Agent").unwrap()
    );
    click(cx, "tour-next");
    let home = step(cx, "home");
    assert_eq!(
        home.target,
        union(cx, &["projects", "home", "notifications"])
    );
    // Last step's real Done button persists the device-wide seen state.
    click(cx, "tour-next");
    assert!(cx.update(|_, cx| tour::is_seen(cx)));
    assert!(!cx.update(|window, cx| tour::is_running(window, cx)));
}

#[gpui::test]
fn a_project_without_create_actions_skips_the_empty_home_row(cx: &mut TestAppContext) {
    let (_dir, lib, [book, _]) = fixture();
    let templates = lib
        .call(&Actor::User, "entry_template.list", json!({"book":book}))
        .unwrap()["output"]
        .as_array()
        .unwrap()
        .clone();
    for mut template in templates {
        template["verbs"] = json!([]);
        lib.call(
            &Actor::User,
            "entry_template.put",
            json!({"book":book,"template":template}),
        )
        .unwrap();
    }
    let (ws, cx) = setup(cx, &lib, &book, SettingsFile::in_memory());
    step(cx, "tabs");
    assert!(ws.read_with(cx, |ws, _| dr_view_home::v3::actions(&ws.book).is_empty()));
    click(cx, "tour-next");
    step(cx, "moons");
    click(cx, "tour-next");
    assert_eq!(
        current(cx).unwrap().id,
        "timeline",
        "an empty creation row is not a target"
    );
    click(cx, "tour-back");
    assert_eq!(current(cx).unwrap().id, "moons");
}

#[gpui::test]
fn seen_survives_books_and_settings_restart_and_reset_reopens_the_same_book(
    cx: &mut TestAppContext,
) {
    let mut restarted = cx.new_app();
    let mut other_device = cx.new_app();
    let (dir, lib, [a, b]) = fixture();
    let device = dir.path().join("device");
    let (ws, vcx) = setup(cx, &lib, &a, SettingsFile::open(&device));
    step(vcx, "tabs");
    vcx.simulate_keystrokes("escape");
    frames(vcx);
    assert!(vcx.update(|_, cx| tour::is_seen(cx)));
    ws.update_in(vcx, |ws, window, cx| ws.open_book(&b, window, cx));
    wait(vcx, "second book loaded", |cx| {
        ws.read_with(cx, |ws, _| ws.book.id == b && !ws.sea.waiting())
    });
    vcx.executor().advance_clock(tour::START_DELAY * 2);
    frames(vcx);
    assert!(
        !vcx.update(|window, cx| tour::is_running(window, cx)),
        "one device, not once per book"
    );
    vcx.update(|_, cx| Settings::flush(cx));
    let disk = SettingsFile::open(&device);
    assert_eq!(
        disk.device_memory(dr_view_sea::shell::SEEN_KEY),
        Some(&json!([tour::WORKSPACE_TOUR_ID]))
    );

    let (ws2, vcx2) = setup(&mut restarted, &lib, &b, disk);
    wait(vcx2, "restarted book loaded", |cx| {
        ws2.read_with(cx, |ws, _| ws.book.id == b && !ws.sea.waiting())
    });
    vcx2.executor().advance_clock(tour::START_DELAY * 2);
    frames(vcx2);
    assert!(
        !vcx2.update(|window, cx| tour::is_running(window, cx)),
        "loaded SettingsFile remembers completion"
    );
    vcx2.update(|window, cx| {
        dr_shell::settings::open_section(registry::Section::Appearance, window, cx)
    });
    click(vcx2, "replay-guides");
    assert!(!vcx2.update(|_, cx| tour::is_seen(cx)));
    vcx2.simulate_keystrokes("escape");
    wait(vcx2, "settings closed", |cx| {
        ws2.read_with(cx, |ws, _| ws.settings.is_none())
    });
    frames(vcx2);
    assert!(
        !vcx2.update(|window, cx| tour::is_running(window, cx)),
        "reset waits for the next book open"
    );
    ws2.update_in(vcx2, |ws, window, cx| assert!(ws.show_shelf(window, cx)));
    ws2.update_in(vcx2, |ws, window, cx| ws.open_book(&b, window, cx));
    step(vcx2, "tabs");
    vcx2.simulate_keystrokes("escape");
    frames(vcx2);
    assert!(vcx2.update(|_, cx| tour::is_seen(cx)));

    let (_, fresh) = setup(
        &mut other_device,
        &lib,
        &a,
        SettingsFile::open(&dir.path().join("other-device")),
    );
    step(fresh, "tabs");
    assert!(
        !fresh.update(|_, cx| tour::is_seen(cx)),
        "a different settings file gets its own first tour"
    );
}

#[gpui::test]
fn a_tour_does_not_take_settings_focus_during_its_start_delay(cx: &mut TestAppContext) {
    let (_dir, lib, [book, _]) = fixture();
    let (ws, cx) = setup(cx, &lib, &book, SettingsFile::in_memory());
    wait(cx, "book ready before guide delay", |cx| {
        ws.read_with(cx, |ws, _| ws.book.id == book && !ws.sea.waiting())
    });
    ws.update_in(cx, |ws, window, cx| ws.open_settings(window, cx));
    frames(cx);
    cx.executor().advance_clock(tour::START_DELAY * 2);
    frames(cx);
    assert!(current(cx).is_none());
    assert!(cx.update(|window, cx| {
        ws.read(cx)
            .settings
            .as_ref()
            .unwrap()
            .read(cx)
            .focus_handle(cx)
            .contains_focused(window, cx)
    }));
    cx.simulate_keystrokes("escape");
    wait(cx, "settings closed", |cx| {
        ws.read_with(cx, |ws, _| ws.settings.is_none())
    });
    step(cx, "tabs");
}

#[gpui::test]
fn changing_books_during_the_tour_returns_focus_to_the_current_book(cx: &mut TestAppContext) {
    let (_dir, lib, [a, b]) = fixture();
    let chapter =
        dr_testkit::seed::acceptance::entries_by_template(&lib, &a, "tpl-chapter")[0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
    let (ws, cx) = setup_with_tour(cx, &lib, &a, SettingsFile::in_memory(), false);
    wait(cx, "first book ready", |cx| {
        ws.read_with(cx, |ws, _| ws.book.id == a && !ws.sea.waiting())
    });
    let target = Target::Entry {
        id: chapter.parse().unwrap(),
        module: Some("mod-prose".parse().unwrap()),
    };
    ws.update(cx, |ws, cx| ws.open(target.clone(), Open::KEEP, cx));
    wait(cx, "first editor", |cx| {
        ws.read_with(cx, |ws, _| ws.editor_of(&target).is_some())
    });
    let editor = ws.read_with(cx, |ws, _| ws.editor_of(&target).unwrap().clone());
    let old_focus = cx.update(|window, cx| {
        let focus = editor.read(cx).editor().focus_handle(cx);
        focus.focus(window, cx);
        focus
    });
    // Register the real tour after the old page has focus, so its stored
    // destination is definitely this editor rather than the workspace root.
    cx.update(|_, cx| dr_view_sea::shell::init(cx));
    step(cx, "tabs");
    ws.update_in(cx, |ws, window, cx| ws.open_book(&b, window, cx));
    assert!(
        current(cx).is_none(),
        "old guide is put away while the next book opens"
    );
    wait(cx, "current book", |cx| {
        ws.read_with(cx, |ws, _| ws.book.id == b && !ws.sea.waiting())
    });
    step(cx, "tabs");
    cx.simulate_keystrokes("escape");
    frames(cx);
    assert!(
        !cx.update(|window, cx| old_focus.contains_focused(window, cx)),
        "never return to the old book's editor"
    );
    assert!(cx.update(|window, cx| ws.read(cx).focus_handle().contains_focused(window, cx)));
    assert!(cx.update(|_, cx| tour::is_seen(cx)));
}
