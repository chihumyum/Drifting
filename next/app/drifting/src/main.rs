//! The Drifting desktop app (the Rust + GPUI rewrite).
//!
//! Spike P0-A's skeleton: the main window with a custom titlebar, the menu bar,
//! light and dark following the system, and development probes. F6 (`dr-shell`)
//! takes it from here; see docs/rust-rewrite/spikes/p0-a-skeleton.md.

mod about;
mod appearance;
mod identity;
mod main_window;
mod menus;
mod probe;
mod titlebar;

use std::sync::Arc;

use dr_platform::DeepLinks;
use dr_platform::crash::{CrashConfig, CrashReporting};
use gpui::{App, Global};
use gpui_platform::application;

use crate::appearance::AppearanceSetting;
use crate::main_window::MainWindow;

/// F7's services, for the shell (F6) to take: the deep-link queue and crash
/// follow-ups.
pub struct Platform {
    pub deep_links: Arc<DeepLinks>,
    pub crash_reports: CrashReporting,
}

impl Global for Platform {}

fn main() {
    probe::start();
    let platform = dr_platform::Identity::current();
    let dirs = dr_platform::AppDirs::for_identity(platform).ok();
    // First: in the crash-reporter process this never returns. Consent comes
    // from Settings once F6 stores it (and the first launch says so); until
    // then reports stay off.
    let crash_reports = dr_platform::crash::init(CrashConfig::for_build(
        platform,
        dirs.as_ref(),
        env!("CARGO_PKG_VERSION"),
        option_env!("DRIFTING_BUILD_COMMIT"),
        false,
    ));
    dr_platform::logging::init(&dr_platform::logging::LogConfig::for_build(
        dirs.as_ref().map(|dirs| dirs.logs.as_path()),
    ));
    crash_reports.log_status();

    // Windows: a second launch hands its arguments (a `drifting:` link) to the
    // running copy and exits. macOS: Launch Services does this itself.
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(instance) = dr_platform::single_instance::acquire(platform, &args).primary() else {
        return;
    };
    let deep_links = DeepLinks::new(platform.url_scheme);
    deep_links.push_args(&args);
    instance.listen({
        let deep_links = deep_links.clone();
        move |args| {
            deep_links.push_args(args);
        }
    });

    let appearance = AppearanceSetting::from_env();

    let app = application();
    probe::platform_created();
    app.on_open_urls({
        let deep_links = deep_links.clone();
        move |urls| {
            deep_links.push_all(urls);
        }
    });
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
        cx.set_global(Platform {
            deep_links,
            crash_reports,
        });
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

#[cfg(test)]
mod tests {
    #[test]
    fn the_platform_services_run_under_the_apps_identity() {
        let platform = dr_platform::Identity::current();
        assert_eq!(platform.bundle_id, crate::identity::BUNDLE_ID);
        assert_eq!(platform.product_name, crate::identity::APP_NAME);
    }
}
