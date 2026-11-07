//! dr-shell: Drifting's workspace around the paper (foundation F6).
//!
//! - one navigation model ([`nav`]): the tab tree and its own history; the
//!   page shown, the highlighted cell and Back/Forward are read from it;
//! - the three columns: sidebars that slide out from the corners and split
//!   in two when wide enough ([`panes`]), the tab dock on the paper's top
//!   edge, the Super View stage ([`workspace`]);
//! - one shortcut registry over GPUI actions and the keymap ([`keymap`]);
//! - one declarative settings registry and its file ([`settings`]);
//! - the notification center ([`notifications`]);
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

pub mod actions;
pub mod appearance;
pub mod keymap;
pub mod menus;
pub mod nav;
pub mod notifications;
pub mod panes;
pub mod quit;
pub mod settings;
pub mod stand_in;
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

/// F7's services, for the shell: the deep-link queue and crash reports.
/// Optional so tests and captures run without them.
#[derive(Default)]
pub struct Services {
    pub deep_links: Option<Arc<DeepLinks>>,
    pub crash_reports: Option<CrashReporting>,
}

impl Global for Services {}

/// Installs the shell: strings, settings, shortcuts, menus, the app-wide
/// actions and the quit flow. Call once, after `dr_ui::init`.
pub fn init(info: ShellInfo, services: Services, file: SettingsFile, cx: &mut App) {
    cx.set_global(info);
    cx.set_global(services);
    settings::install(file, cx);
    menus::init(cx);
    quit::install(cx);
    notifications::install(cx);
    workspace::init(cx);
    keymap::apply(&Settings::read(cx).key_bindings(), cx);
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
