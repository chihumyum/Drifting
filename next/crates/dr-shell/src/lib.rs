//! dr-shell: Drifting's workspace around the paper (foundation F6).
//!
//! - one navigation model ([`nav`]): the tab tree and its own history; the
//!   page shown, the highlighted cell and Back/Forward are read from it;
//! - the open book from F3's queries and events ([`book`]);
//! - the three columns: sidebars that slide out from the corners and split
//!   in two when wide enough ([`panes`]), the tab dock on the paper's top
//!   edge, the Super View stage ([`workspace`]);
//! - one shortcut registry over GPUI actions and the keymap ([`keymap`]);
//! - one declarative settings registry and its file ([`settings`]);
//! - the notification center ([`notifications`]);
//! - dialogs other crates draw, such as feedback ([`dialogs`]);
//! - the quit flow ([`quit`]): saving and handing over happen before
//!   `cx.quit()`, the quit callback only flushes crash reports.
//!
//! Everything it draws comes from `dr-ui`; every word from `dr-i18n`.
//! docs/rust-rewrite/foundations/f6-shell.md has the design and the numbers.
//!
//! ```ignore
//! application().with_assets(dr_ui::Assets::new()).run(|cx| {
//!     dr_ui::init(cx)?;
//!     dr_shell::init(ShellInfo { .. }, Services { .. }, settings_file, cx);
//!     dr_shell::open_workspace(cx, |window, cx| { /* first-frame probe */ })?;
//! });
//! ```

pub mod account;
pub mod actions;
pub mod appearance;
pub mod book;
pub mod dialogs;
mod export_memory;
pub mod keymap;
pub mod library;
pub mod menus;
pub mod mirror;
pub mod nav;
pub mod notifications;
pub mod pages;
pub mod panes;
pub mod quit;
pub mod release;
pub mod settings;
pub mod strings;
pub mod workspace;

use std::sync::Arc;

use dr_platform::DeepLinks;
use dr_platform::crash::CrashReporting;
use gpui::{App, AppContext as _, Global, Window, WindowHandle};

pub use settings::{Settings, SettingsFile};
pub use strings::{Strings, t};
pub use workspace::Workspace;

/// What the shell needs to know about the app it runs in.
#[derive(Clone, Copy, Debug)]
pub struct ShellInfo {
    pub app_name: &'static str,
    pub bundle_id: &'static str,
    pub version: &'static str,
    /// The scheme of the operating-system links this build registered.
    pub url_scheme: &'static str,
    /// `DRIFTING_APPEARANCE`: a development override of the theme setting,
    /// never stored.
    pub forced_appearance: Option<dr_ui::Appearance>,
}

impl Global for ShellInfo {}

/// What the shell is given: F7's deep-link queue and crash reports, F3's
/// workspace over the library. Optional so tests and captures run without
/// them.
#[derive(Default)]
pub struct Services {
    pub deep_links: Option<Arc<DeepLinks>>,
    pub crash_reports: Option<CrashReporting>,
    pub library: Option<dr_workspace::Workspace>,
    /// The book to open instead of the one opened last (`DRIFTING_BOOK`, a
    /// development override: an id or a name).
    pub book: Option<String>,
}

impl Global for Services {}

/// Installs the shell: strings, settings, shortcuts, menus, the app-wide
/// actions and the quit flow. Call once, after `dr_ui::init`.
pub fn init(info: ShellInfo, services: Services, file: SettingsFile, cx: &mut App) {
    // M40: the Markdown folder makes a last pass and stops before anything
    // lets go of the library.
    quit::before_quit(cx, mirror::stop);
    // Before quitting, F3 brings the open documents' search index up to date
    // and lets each one close (nothing is lost without it). The hook finds
    // the library when it runs: holding a handle would keep it open.
    if services.library.is_some() {
        quit::before_quit(cx, |cx| {
            let Some(lib) = cx.try_global::<Services>().and_then(|s| s.library.clone()) else {
                return;
            };
            let report = lib.before_quit();
            log::info!(
                "library: {} documents closed ({} in use) in {:.0} ms",
                report.closed,
                report.in_use,
                report.ms
            );
        });
    }
    // M07: the writing-day recorder and the Stats tab over the library,
    // stored before quitting.
    dr_view_stats::init(services.library.clone(), cx);
    // M18: the Review tab and the comment composer's shortcut.
    dr_view_review::init(services.library.clone(), cx);
    keymap::add_bindings(cx, dr_view_review::bindings);
    quit::before_quit(cx, |cx| {
        dr_view_stats::flush(cx);
        dr_view_stats::release(cx);
        dr_view_review::release(cx);
    });
    cx.set_global(info);
    cx.set_global(services);
    settings::install(file, cx);
    menus::init(cx);
    quit::install(cx);
    notifications::install(cx);
    workspace::init(cx);
    // M06's search panel: ↑↓ through the hits.
    keymap::add_bindings(cx, dr_view_search::key_bindings);
    // The find bar: ⇧Enter, ⌘G / ⇧⌘G.
    keymap::add_bindings(cx, workspace::find::key_bindings);
    // F4e: ⌘⇧H highlights in material notes (the editor's own key, not one
    // the author rebinds: the 0.1 note's Mod-Shift-H).
    keymap::add_bindings(cx, dr_editor::highlight::key_bindings);
    keymap::apply(&Settings::read(cx).key_bindings(), cx);
    export_memory::init(cx);
    // M40: the Markdown folder over the library, when one is chosen.
    mirror::restart(cx);
}

/// Opens the workspace window, or brings the open one forward.
/// `on_open` runs once the window exists (the app's first-frame probe).
pub fn open_workspace(
    cx: &mut App,
    on_open: impl FnOnce(&mut Window, &mut App) + 'static,
) -> anyhow::Result<WindowHandle<Workspace>> {
    if let Some(handle) = cx
        .windows()
        .into_iter()
        .find_map(|window| window.downcast::<Workspace>())
    {
        handle.update(cx, |_, window, _| window.activate_window())?;
        return Ok(handle);
    }
    let options = workspace::window_options(cx);
    let handle = cx.open_window(options, |window, cx| {
        let view = cx.new(|cx| Workspace::new(window, cx));
        on_open(window, cx);
        view
    })?;
    Ok(handle)
}
