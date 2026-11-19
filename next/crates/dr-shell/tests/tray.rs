//! M43 notification area shell integration: window close policy
//! (`ReturnToShelf`, `HideToTray`, `QuitProcess`), single-instance and tray
//! restore wakeups, headless degradation when no taskbar icon exists, and
//! interface language synchronization.

use std::cell::Cell;
use std::rc::Rc;

use dr_platform::identity::DEVELOPMENT;
use dr_platform::tray::{TrayController, TrayLabels};
use dr_shell::pages::{self, ShelfPage};
use dr_shell::settings::registry;
use dr_shell::{Services, Settings, SettingsFile, ShellInfo, Workspace, quit, release, tray};
use dr_testkit::seed::{self, Preset};
use dr_workspace::Workspace as Library;
use futures::FutureExt as _;
use gpui::{AppContext as _, Context, IntoElement, Render, TestAppContext, Window, div};

const VERSION: &str = "m43-tray-test";

struct DummyShelf;

impl Render for DummyShelf {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
    }
}

fn setup_shell(cx: &mut TestAppContext) -> (tempfile::TempDir, String) {
    cx.executor().allow_parking();
    let dir = tempfile::tempdir().unwrap();
    let made = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
    let book_id = made.books[0].book_id().to_string();
    let lib = Library::open_dir(dir.path(), VERSION).unwrap();
    made.write_to(lib.library()).unwrap();
    cx.update(|cx| {
        let _ = dr_ui::init(cx);
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: VERSION,
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(lib),
                ..Services::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        pages::set_shelf(cx, |_, _, cx| ShelfPage {
            view: cx.new(|_| DummyShelf).into(),
            bell: None,
        });
    });
    (dir, book_id)
}

fn close_library(cx: &mut TestAppContext) {
    cx.update(|cx| {
        if let Some(lib) = cx.global::<Services>().library.as_ref() {
            lib.close();
        }
    });
}

#[gpui::test]
fn inert_controller_leaves_macos_window_close_unchanged(cx: &mut TestAppContext) {
    let (_dir, book_id) = setup_shell(cx);
    let controller = TrayController::with_platform(&DEVELOPMENT, TrayLabels::default(), false);
    // Do not install the Windows controller: default shell matches macOS.
    drop(controller);

    let handle = cx
        .update(|cx| dr_shell::open_workspace(cx, |_, _| {}))
        .unwrap();
    cx.run_until_parked();

    handle
        .update(cx, |ws, window, cx| {
            assert!(ws.shelf_open);
            ws.open_book(&book_id, window, cx);
        })
        .unwrap();
    cx.run_until_parked();

    let weak = cx.update(|cx| handle.entity(cx).unwrap().downgrade());
    let should_close = cx
        .update_window(*handle, |_, window, cx| {
            Workspace::should_close_window(&weak, window, cx)
        })
        .unwrap();
    assert!(should_close);
    close_library(cx);
}

#[gpui::test]
fn windows_tray_returns_to_shelf_hides_restores_and_tracks_locale(cx: &mut TestAppContext) {
    let (_dir, book_id) = setup_shell(cx);
    let controller = TrayController::with_platform(&DEVELOPMENT, TrayLabels::default(), true);
    cx.update(|cx| {
        Settings::update(cx, |f| f.set(registry::UI_LOCALE, "en".into(), None).ok());
        tray::install(controller.clone(), cx);
    });
    assert_eq!(controller.labels().open, "Open Drifting");

    let handle = cx
        .update(|cx| dr_shell::open_workspace(cx, |_, _| {}))
        .unwrap();
    let weak = cx.update(|cx| handle.entity(cx).unwrap().downgrade());
    cx.run_until_parked();

    // Open a book from the shelf.
    handle
        .update(cx, |ws, window, cx| {
            assert!(ws.shelf_open);
            ws.open_book(&book_id, window, cx);
        })
        .unwrap();
    cx.run_until_parked();
    assert!(!handle.read_with(cx, |ws, _| ws.shelf_open).unwrap());

    // First close while a book is open returns to the shelf without hiding.
    let should_close = cx
        .update_window(*handle, |_, window, cx| {
            Workspace::should_close_window(&weak, window, cx)
        })
        .unwrap();
    assert!(!should_close);
    assert!(handle.read_with(cx, |ws, _| ws.shelf_open).unwrap());
    assert!(controller.window_visible());

    // Second close on the shelf hides to the notification area.
    let should_close = cx
        .update_window(*handle, |_, window, cx| {
            Workspace::should_close_window(&weak, window, cx)
        })
        .unwrap();
    assert!(!should_close);
    assert!(!controller.window_visible());

    // A second instance launch wakes the tray command loop and restores visibility.
    controller.notify_second_instance();
    cx.run_until_parked();
    assert!(controller.window_visible());

    // Hide again, then restore via tray left click.
    let _ = cx
        .update_window(*handle, |_, window, cx| {
            Workspace::should_close_window(&weak, window, cx)
        })
        .unwrap();
    assert!(!controller.window_visible());
    controller.notify_left_click();
    cx.run_until_parked();
    assert!(controller.window_visible());

    // Changing UI_LOCALE in Settings updates the tray menu labels immediately.
    cx.update(|cx| {
        Settings::update(cx, |f| {
            f.set(registry::UI_LOCALE, "zh-CN".into(), None).ok()
        });
    });
    assert_eq!(controller.labels().open, "打开 Drifting");
    assert_eq!(controller.labels().quit, "退出 Drifting");

    cx.update(|cx| {
        Settings::update(cx, |f| f.set(registry::UI_LOCALE, "ja".into(), None).ok());
    });
    assert_eq!(controller.labels().open, "Drifting を開く");
    assert_eq!(controller.labels().quit, "Drifting を終了");

    close_library(cx);
}

#[gpui::test]
fn windows_without_notification_icon_quits_instead_of_hiding_and_cancels_on_failed_release(
    cx: &mut TestAppContext,
) {
    let (_dir, _book_id) = setup_shell(cx);
    let controller = TrayController::with_platform(&DEVELOPMENT, TrayLabels::default(), false);
    let fail_release = Rc::new(Cell::new(true));
    let fail_flag = fail_release.clone();
    let quit_ran = Rc::new(Cell::new(false));
    let quit_flag = quit_ran.clone();

    cx.update(|cx| {
        tray::install(controller.clone(), cx);
        release::before_release(cx, move |_| {
            let fail = fail_flag.get();
            async move {
                if fail {
                    Err("blocked by unsent state".into())
                } else {
                    Ok(())
                }
            }
            .boxed_local()
        });
        quit::before_quit(cx, move |_| {
            quit_flag.set(true);
        });
    });

    let handle = cx
        .update(|cx| dr_shell::open_workspace(cx, |_, _| {}))
        .unwrap();
    let weak = cx.update(|cx| handle.entity(cx).unwrap().downgrade());
    cx.run_until_parked();

    // Closing on the shelf without a tray icon requests a flushed quit rather
    // than hiding into an unreachable invisible state.
    let should_close = cx
        .update_window(*handle, |_, window, cx| {
            Workspace::should_close_window(&weak, window, cx)
        })
        .unwrap();
    assert!(!should_close);
    assert!(controller.window_visible());
    assert!(controller.is_quitting());

    // Because `before_release` rejected the quit, `is_quitting` is cleared so
    // subsequent close attempts still run cleanly.
    cx.run_until_parked();
    assert!(!quit_ran.get());
    assert!(!controller.is_quitting());

    // Once the release blocker clears, Quit from the tray menu runs the full
    // shutdown barrier.
    fail_release.set(false);
    controller.notify_menu_quit();
    cx.run_until_parked();
    assert!(quit_ran.get());

    close_library(cx);
}
