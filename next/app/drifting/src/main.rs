//! The Drifting desktop app (the Rust + GPUI rewrite).
//!
//! The entry point wires F7's platform services (the MCP bridge first, then
//! crash reports, logs, the single running copy, deep links), F3's
//! workspace over the library, dr-ui's assets and fonts, and hands the
//! window to the shell (F6, `dr-shell`).
//! See docs/rust-rewrite/foundations/f6-shell.md.

mod about;
mod check;
mod identity;
mod probe;

use std::path::Path;

use dr_platform::DeepLinks;
use dr_platform::crash::CrashConfig;
use dr_shell::{Services, SettingsFile, ShellInfo};
use gpui::App;
use gpui_platform::application;

/// The development switch: `DRIFTING_APPEARANCE=light|dark` forces one
/// appearance without touching the system setting or the stored theme.
pub const APPEARANCE_ENV: &str = "DRIFTING_APPEARANCE";
/// The development switch: `DRIFTING_BOOK=<id or name>` opens that book
/// straight away instead of the bookshelf.
pub const BOOK_ENV: &str = "DRIFTING_BOOK";
/// The library's folder inside the app's data folder (F2's `library.sqlite`,
/// `assets/`, …). The data folder itself is the 0.1 client's for the release
/// identity, so the new library keeps to a folder of its own.
pub const LIBRARY_DIR: &str = "library";

fn forced_appearance() -> Option<dr_ui::Appearance> {
    match std::env::var(APPEARANCE_ENV).ok().as_deref().map(str::trim) {
        Some("light") => Some(dr_ui::Appearance::Light),
        Some("dark") => Some(dr_ui::Appearance::Dark),
        None | Some("" | "system") => None,
        Some(other) => {
            eprintln!("{APPEARANCE_ENV}={other:?} is not light, dark or system; ignored");
            None
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // External Agents run this executable as `drifting --mcp --connection
    // <file>` (the 0.1 contract in their configs). Route it before anything
    // else: no crash reporter, no single-instance lock, no window.
    if let dr_platform::cli::Launch::Mcp(connection) = dr_platform::cli::parse(&args) {
        if let Err(error) = connection
            .map_err(str::to_owned)
            .and_then(|file| run_mcp_bridge(&file))
        {
            eprintln!("{}{error}", dr_platform::cli::MCP_ERROR_PREFIX);
            std::process::exit(1);
        }
        return;
    }

    probe::start();
    let platform = dr_platform::Identity::current();
    let dirs = dr_platform::AppDirs::for_identity(platform).ok();
    // The settings file holds the crash-report consent, which `crash::init`
    // needs before anything else runs. Reading it is plain file I/O.
    let settings = match &dirs {
        Some(dirs) => SettingsFile::open(&dirs.data),
        None => SettingsFile::in_memory(),
    };
    let consent = settings.bool(dr_shell::settings::registry::CRASH_REPORTS);
    // First: in the crash-reporter process this never returns.
    let crash_reports = dr_platform::crash::init(CrashConfig::for_build(
        platform,
        dirs.as_ref(),
        env!("CARGO_PKG_VERSION"),
        option_env!("DRIFTING_BUILD_COMMIT"),
        consent,
    ));
    dr_platform::logging::init(&dr_platform::logging::LogConfig::for_build(
        dirs.as_ref().map(|dirs| dirs.logs.as_path()),
    ));
    crash_reports.log_status();

    // Windows: a second launch hands its arguments (a link) to the running
    // copy and exits. macOS: Launch Services does this itself.
    let Some(instance) = dr_platform::single_instance::acquire(platform, &args).primary() else {
        return;
    };
    // The library opens on its own thread while AppKit launches; the shell
    // takes it once the app is ready. Without one the window still opens,
    // with no book.
    let library = dirs.as_ref().map(|dirs| {
        let root = dirs.data.join(LIBRARY_DIR);
        std::thread::Builder::new()
            .name("library-open".into())
            .spawn(move || {
                let started = std::time::Instant::now();
                let opened = dr_workspace::Workspace::open_dir(&root, env!("CARGO_PKG_VERSION"));
                (opened, started.elapsed())
            })
    });
    let deep_links = DeepLinks::new(platform.url_scheme);
    deep_links.push_args(&args);
    instance.listen({
        let deep_links = deep_links.clone();
        move |args| {
            deep_links.push_args(args);
        }
    });

    let app = application().with_assets(dr_ui::Assets::new());
    probe::platform_created();
    app.on_open_urls({
        let deep_links = deep_links.clone();
        move |urls| {
            deep_links.push_all(urls);
        }
    });
    // macOS keeps the app running when its last window closes; clicking the
    // Dock icon opens the workspace again.
    app.on_reopen(|cx| {
        if cx.windows().is_empty() {
            open_workspace(cx);
        }
    });
    app.run(move |cx: &mut App| {
        probe::app_ready();
        if let Err(missing) = dr_ui::init(cx) {
            // dr-ui never falls back to system fonts; say what to run.
            log::error!("{missing}");
            eprintln!("{missing}");
            cx.quit();
            return;
        }
        let info = ShellInfo {
            app_name: identity::APP_NAME,
            bundle_id: identity::BUNDLE_ID,
            version: env!("CARGO_PKG_VERSION"),
            url_scheme: platform.url_scheme,
            forced_appearance: forced_appearance(),
        };
        let library = match library {
            Some(Ok(thread)) => match thread.join() {
                Ok((Ok(lib), took)) => {
                    probe::library_opened(took);
                    Some(lib)
                }
                Ok((Err(error), _)) => {
                    log::error!(
                        "the library could not be opened: {error} ({})",
                        error.code()
                    );
                    None
                }
                Err(_) => {
                    log::error!("opening the library panicked");
                    None
                }
            },
            Some(Err(error)) => {
                log::error!("could not start opening the library: {error}");
                None
            }
            None => None,
        };
        let services = Services {
            deep_links: Some(deep_links),
            crash_reports: Some(crash_reports),
            library,
            book: std::env::var(BOOK_ENV)
                .ok()
                .filter(|b| !b.trim().is_empty()),
        };
        dr_shell::init(info, services, settings, cx);
        // Stage 2 pages: the bookshelf opens first, Project Home is the
        // paper under no tab.
        dr_view_shelf::init(cx);
        dr_view_home::init(cx);
        // F8's debug bridge, in `--features debug-bridge` builds only.
        #[cfg(feature = "debug-bridge")]
        dr_debug_bridge::start(cx);
        probe::shell_ready();
        cx.on_action(about::open);
        if !cfg!(target_os = "macos") {
            cx.on_window_closed(|cx, _| {
                if cx.windows().is_empty() {
                    dr_shell::quit::request(cx);
                }
            })
            .detach();
        }
        open_workspace(cx);
        cx.activate(true);
        check::start(cx);
    });
}

/// The stdio bridge to a running Drifting, M32's (the 0.1 version is
/// `local::cli` in `src-tauri/src/mcp_server.rs`).
fn run_mcp_bridge(_connection: &Path) -> Result<(), String> {
    Err("this build has no MCP bridge yet".into())
}

fn open_workspace(cx: &mut App) {
    if let Err(error) = dr_shell::open_workspace(cx, probe::window_opened) {
        log::error!("could not open the workspace: {error:#}");
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
