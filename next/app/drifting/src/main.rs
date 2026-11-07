//! The Drifting desktop app (the Rust + GPUI rewrite).
//!
//! Spike P0-A's skeleton: the main window with a custom titlebar, the menu bar,
//! light and dark following the system, and development probes. F6 (`dr-shell`)
//! takes it from here; see docs/rust-rewrite/spikes/p0-a-skeleton.md.

mod about;
mod appearance;
mod identity;
mod logging;
mod main_window;
mod menus;
mod probe;
mod titlebar;

use gpui::App;
use gpui_platform::application;

use crate::appearance::AppearanceSetting;
use crate::main_window::MainWindow;

fn main() {
    probe::start();
    logging::init();
    let appearance = AppearanceSetting::from_env();

    let app = application();
    probe::platform_created();
    // macOS keeps the app running when its last window closes; clicking the
    // Dock icon then opens a new main window.
    app.on_reopen(|cx| {
        if cx.windows().is_empty() {
            open_main_window(cx);
        }
    });
    app.run(move |cx: &mut App| {
        probe::app_ready();
        cx.set_global(appearance);
        menus::init(cx);
        cx.on_action(about::open);
        cx.on_action(main_window::open_settings);
        if !cfg!(target_os = "macos") {
            cx.on_window_closed(|cx, _| {
                if cx.windows().is_empty() {
                    cx.quit();
                }
            })
            .detach();
        }

        open_main_window(cx);
        cx.activate(true);
    });
}

fn open_main_window(cx: &mut App) {
    if let Err(error) = MainWindow::open_or_activate(cx) {
        log::error!("could not open the main window: {error:#}");
    }
}
