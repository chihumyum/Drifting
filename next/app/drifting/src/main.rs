//! The Drifting desktop app (the Rust + GPUI rewrite).
//!
//! The entry point wires F7's platform services (the MCP bridge first, then
//! crash reports, logs, the single running copy, deep links), F3's
//! workspace over the library with this device's identity (`library`),
//! dr-ui's assets and fonts, and hands the window to the shell (F6,
//! `dr-shell`) with the views it hosts (bookshelf, Project Home, feedback,
//! updates).
//! See docs/rust-rewrite/foundations/f6-shell.md.

mod about;
mod check;
#[cfg(test)]
mod data_folder_tests;
mod identity;
mod library;
mod markdown_folder;
mod probe;
mod sync;

use std::path::Path;

use dr_platform::DeepLinks;
use dr_platform::crash::CrashConfig;
use dr_shell::{Services, SettingsFile, ShellInfo};
use gpui::{App, AppContext as _};
use gpui_platform::application;

/// The development switch: `DRIFTING_APPEARANCE=light|dark` forces one
/// appearance without touching the system setting or the stored theme.
pub const APPEARANCE_ENV: &str = "DRIFTING_APPEARANCE";
/// The development switch: `DRIFTING_BOOK=<id or name>` opens that book
/// straight away instead of the bookshelf.
pub const BOOK_ENV: &str = "DRIFTING_BOOK";

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
    // `dirs.own` holds this client's files. Under the release identity
    // `dirs.data` is the 0.1 client's folder: only the MCP connection files
    // (`dr_view_agent::mcp`) and the import's search for the 0.1 libraries
    // use it (dr-platform's `paths`).
    let dirs = dr_platform::AppDirs::for_identity(platform).ok();
    // The settings file holds the crash-report consent, which `crash::init`
    // needs before anything else runs. Reading it is plain file I/O.
    let settings = match &dirs {
        Some(dirs) => SettingsFile::open(&dirs.own),
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
    // The library opens on its own thread while AppKit launches, with this
    // device's identity from the data folder (`library::open_active`); the
    // shell takes it once the app is ready. Without one the window still
    // opens, on the page that says the library could not be opened.
    let library = dirs.as_ref().map(|dirs| {
        let data = dirs.own.clone();
        std::thread::Builder::new()
            .name("library-open".into())
            .spawn(move || {
                let started = std::time::Instant::now();
                let opened = library::open_active(&data, env!("CARGO_PKG_VERSION"));
                (opened, started.elapsed())
            })
    });
    let deep_links = DeepLinks::new(platform.url_scheme);
    deep_links.push_args(&args);
    let tray_slot: std::sync::Arc<
        std::sync::Mutex<Option<std::sync::Arc<dr_platform::tray::TrayController>>>,
    > = std::sync::Arc::new(std::sync::Mutex::new(None));
    let second_instance_pending = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    instance.listen({
        let deep_links = deep_links.clone();
        let tray_slot = tray_slot.clone();
        let second_instance_pending = second_instance_pending.clone();
        move |args| {
            deep_links.push_args(args);
            // The slot stays locked while the launch is noted, and the main
            // thread fills it under the same lock, so a launch that arrives
            // while the controller is being installed is not lost between
            // the two.
            let slot = tray_slot.lock().unwrap_or_else(|e| e.into_inner());
            match slot.as_ref() {
                Some(tray) => tray.notify_second_instance(),
                None => second_instance_pending.store(true, std::sync::atomic::Ordering::SeqCst),
            }
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
        // Without a library the window shows the page that says why
        // (`dr_shell::library_failure`), never an empty bookshelf.
        let data = dirs.as_ref().map(|dirs| dirs.own.as_path());
        let (library, library_failure) = match library {
            Some(Ok(thread)) => match thread.join() {
                Ok((Ok(lib), took)) => {
                    probe::library_opened(took);
                    (Some(lib), None)
                }
                Ok((Err(error), _)) => {
                    let code = library::open_failure_code(&error);
                    log::error!("the library could not be opened: {error} ({code})");
                    crash_reports.report_integrity(&format!("library-open-failed:{code}"));
                    (None, Some(library::failure(&error, data)))
                }
                Err(_) => {
                    log::error!("opening the library panicked");
                    crash_reports.report_integrity("library-open-panicked");
                    (None, Some(library::other_failure("panicked", data)))
                }
            },
            Some(Err(error)) => {
                log::error!("could not start opening the library: {error}");
                (None, Some(library::other_failure("not-started", data)))
            }
            None => {
                log::error!("there is no data folder, so no library");
                (None, Some(library::other_failure("no-data-folder", None)))
            }
        };
        let services = Services {
            deep_links: Some(deep_links),
            crash_reports: Some(crash_reports),
            library,
            library_failure,
            book: std::env::var(BOOK_ENV)
                .ok()
                .filter(|b| !b.trim().is_empty()),
        };
        dr_shell::init(info, services, settings, cx);
        let locale = dr_shell::Settings::locale(cx);
        match dr_platform::tray::TrayController::install(
            platform,
            dr_platform::tray::TrayLabels::for_locale(locale.code()),
        ) {
            Ok(tray) => {
                {
                    let mut slot = tray_slot.lock().unwrap_or_else(|e| e.into_inner());
                    if second_instance_pending.swap(false, std::sync::atomic::Ordering::SeqCst) {
                        tray.notify_second_instance();
                    }
                    *slot = Some(tray.clone());
                }
                dr_shell::tray::install(tray, cx);
            }
            Err(error) => {
                log::warn!("could not install notification area controller: {error}");
            }
        }
        // The 0.1 libraries' own MCP folders too (`libraries/<id>/mcp`), for
        // the books of the library their owner has here (`mcp_v1_owner`).
        // A development build finds no 0.1 folder unless one is named.
        let v1 = dr_view_import::v1_data_dir().map(|data| dr_view_agent::mcp::V1 {
            data,
            owner_of: std::sync::Arc::new(mcp_v1_owner),
        });
        dr_view_agent::mcp::init(platform, dirs.as_ref(), v1, cx);
        dr_view_agent::init(platform, cx);
        // ⌘Q hides the app before the quit hooks run (F7).
        dr_shell::quit::hide_first(cx);
        // M35: Hosted account sign-in, first-run welcome step, and account library isolation.
        dr_view_account::init(
            sync::account_service_for_build(platform, dirs.as_ref().map(|dirs| dirs.own.as_path())),
            cx,
        );
        // M36: automatic Hosted Sync v2 runtime, paper status mark, and release drain.
        sync::init(platform, cx);
        // M24: the sea under the windows, the first run, the tour.
        dr_view_sea::shell::init(cx);
        markdown_folder::init(cx);
        // Stage 2 pages: the bookshelf opens first, Project Home is the
        // paper under no tab; the element and category pages' fields go
        // around their text (M11).
        dr_view_shelf::init(cx);
        dr_view_home::init(cx);
        // HC: the Agent's suggestion cards on Project Home.
        dr_view_home::set_agent_cards(cx, |host, _, cx| {
            let cards = cx.new(|cx| dr_view_agent::home_cards::HomeCards::new(host.workspace, cx));
            dr_view_home::AgentCards::new(
                cards,
                dr_view_agent::home_cards::HomeCards::drawn,
                dr_view_agent::home_cards::HomeCards::shown,
            )
        });
        // M03: the chapter page's head and end around every editor.
        dr_view_page::init(cx);
        dr_view_elements::init(cx);
        dr_view_templates::init(cx);
        // M16: the 构想 panel in the left sidebar, an idea's ⋯ rows.
        // M14 and M15: the Bottom Panel's timeline (⌘J) and the chapter in
        // front's plot planner.
        dr_view_timeline::init(cx);
        dr_view_plot::init(cx);
        // M19: image and PDF materials open in their viewer, not an editor.
        dr_view_material::init(cx);
        // M22: Island / Relate layouts inside Left Tab Fill on canonical v3.
        dr_view_element_overview::init(cx);
        // RL: the right sidebar's 「关系」.
        dr_view_relations::init(cx);
        // M39: the feedback dialog (`SendFeedback`, a crash follow-up in the
        // notification center), by mail unless built with the Hosted service.
        dr_view_feedback::init(
            dr_view_feedback::Service::for_build(
                platform,
                dirs.as_ref().map(|dirs| dirs.own.as_path()),
                env!("CARGO_PKG_VERSION"),
            ),
            cx,
        );
        // The account module started before the dialog was registered:
        // hand over the session and the reply-to address it already has.
        if let Some((token, email)) = cx.try_global::<dr_view_account::Service>().map(|s| {
            (
                s.inner.current_token(),
                dr_view_account::account_email(&s.state),
            )
        }) {
            dr_view_feedback::Service::set_session(token, cx);
            dr_view_feedback::Service::set_account_email(email, cx);
        }
        // M10: the bookshelf's 「导入 · Drifting 0.1」.
        dr_view_import::init(cx);
        // M41: .driftingproject from 全部项目, importing documents, backup
        // and restore.
        dr_view_transfer::init(cx);
        // M41's restore swaps the library under the running app with the
        // shell's `library::replace` (close what holds it, restore, reopen;
        // the old one comes back on failure).
        dr_view_transfer::backup::set_replace(
            cx,
            std::rc::Rc::new(|staged, mut progress, cx| {
                let (tx, rx) = futures::channel::oneshot::channel();
                dr_shell::library::replace(
                    cx,
                    move |root, options| {
                        dr_store::Library::restore_staged_with(
                            root,
                            &staged,
                            options,
                            &mut progress,
                        )
                        .map(|(lib, _)| lib)
                        .map_err(|e| e.to_string())
                    },
                    move |result, _| drop(tx.send(result)),
                );
                cx.background_executor()
                    .spawn(async move { rx.await.unwrap_or_else(|_| Err("cancelled".into())) })
            }),
        );
        // M36: final outbound sync drain after all editors/checkpoints settle,
        // before the library closes or the app quits.
        sync::register_final_drain(cx);
        // M42: updates, checked after launch and every three hours, installed
        // as the app quits. Last, so its quit hook runs after the others
        // have saved.
        dr_view_update::init(
            dr_view_update::Service::for_build(
                platform,
                dirs.as_ref().map(|dirs| dirs.own.as_path()),
                env!("CARGO_PKG_VERSION"),
            ),
            cx,
        );
        // F8's debug bridge, in `--features debug-bridge` builds only.
        #[cfg(feature = "debug-bridge")]
        dr_debug_bridge::start(cx);
        probe::shell_ready();
        cx.on_action(about::open);
        if !cfg!(target_os = "macos") {
            cx.on_window_closed(|cx, _| {
                if cx.windows().is_empty() && !dr_shell::tray::keeps_in_notification_area(cx) {
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
fn run_mcp_bridge(connection: &Path) -> Result<(), String> {
    dr_mcp::bridge::run(connection)
}

/// Who owns the library at `root`, by this app's `libraries.json` (the
/// import's rule, `reimport::library_owner`): the 0.1 libraries' MCP folders
/// of that owner reach its books (`dr_mcp::v1`). A library the registry does
/// not name as the active one has no owner here, and reaches none.
fn mcp_v1_owner(root: &Path) -> Option<dr_mcp::v1::Owner> {
    match dr_view_import::reimport::library_owner(root).ok()? {
        dr_account::LibraryOwner::Local => Some(dr_mcp::v1::Owner::Local),
        dr_account::LibraryOwner::Account { subject } => Some(dr_mcp::v1::Owner::Account(subject)),
    }
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
