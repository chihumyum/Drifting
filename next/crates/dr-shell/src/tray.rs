//! Windows notification area integration for the shell (M43).
//!
//! Connects [`dr_platform::tray::TrayController`] to GPUI's foreground event
//! loop, main-window close policy, single-instance wakeups, and interface
//! language changes while remaining inert on macOS and in tests that do not
//! install a controller.

use std::sync::Arc;

use dr_i18n::Locale;
use dr_platform::tray::{
    TrayCommand, TrayController, TrayLabels, WindowCloseContext, WindowCloseDecision,
};
use gpui::{App, Global, Task, Window};

use crate::Settings;

struct TrayGlobal {
    controller: Arc<TrayController>,
    _task: Task<()>,
}

impl Global for TrayGlobal {}

/// Installs `controller` on the shell's foreground loop, synchronizes its menu
/// labels with the current interface language, and starts draining commands
/// emitted by the notification area icon, its context menu, or a second
/// instance launch.
pub fn install(controller: Arc<TrayController>, cx: &mut App) {
    apply_locale(&controller, Settings::locale(cx));
    let (tx, mut rx) = futures::channel::mpsc::unbounded::<()>();
    controller.set_waker({
        let tx = tx.clone();
        move || {
            let _ = tx.unbounded_send(());
        }
    });
    let _ = tx.unbounded_send(());

    let runner = controller.clone();
    let task = cx.spawn(async move |cx| {
        use futures::StreamExt as _;
        while rx.next().await.is_some() {
            let commands = runner.drain_commands();
            if commands.is_empty() {
                continue;
            }
            cx.update(|cx| {
                for command in commands {
                    dispatch(command, cx);
                }
            });
        }
    });

    cx.set_global(TrayGlobal {
        controller,
        _task: task,
    });
}

/// Returns the installed notification area controller, if any.
pub fn controller(cx: &App) -> Option<Arc<TrayController>> {
    cx.try_global::<TrayGlobal>().map(|g| g.controller.clone())
}

/// Whether an installed controller manages main-window close requests.
pub fn manages_window_close(cx: &App) -> bool {
    controller(cx).is_some_and(|c| c.manages_window_close())
}

/// Whether the process currently has a live notification area icon that keeps
/// the app resident when no visible window remains.
pub fn keeps_in_notification_area(cx: &App) -> bool {
    controller(cx).is_some_and(|c| c.has_notification_icon())
}

/// Updates the notification area menu labels to match `locale`.
pub fn sync_locale(locale: Locale, cx: &App) {
    if let Some(controller) = controller(cx) {
        apply_locale(&controller, locale);
    }
}

fn apply_locale(controller: &TrayController, locale: Locale) {
    let labels = TrayLabels::for_locale(locale.code());
    if let Err(error) = controller.set_labels(labels.open, labels.quit) {
        log::warn!("could not update tray labels: {error}");
    }
}

pub(crate) fn handle_window_close(
    context: WindowCloseContext,
    cx: &App,
) -> Option<WindowCloseDecision> {
    controller(cx)
        .filter(|c| c.manages_window_close())
        .map(|c| c.handle_window_close(context))
}

pub(crate) fn cancel_quit(cx: &App) {
    if let Some(controller) = controller(cx) {
        controller.cancel_quit();
    }
}

pub(crate) fn hide_window(window: &Window) {
    #[cfg(windows)]
    if let Some(hwnd) = win32_hwnd(window) {
        TrayController::hide_hwnd(hwnd);
    }
    #[cfg(not(windows))]
    let _ = window;
}

pub(crate) fn restore_window(window: &Window) {
    #[cfg(windows)]
    if let Some(hwnd) = win32_hwnd(window) {
        TrayController::restore_hwnd(hwnd);
    }
    #[cfg(not(windows))]
    let _ = window;
}

#[cfg(windows)]
fn win32_hwnd(window: &Window) -> Option<isize> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let handle = HasWindowHandle::window_handle(window).ok()?;
    match handle.as_raw() {
        RawWindowHandle::Win32(win32) => Some(win32.hwnd.get()),
        _ => None,
    }
}

fn dispatch(command: TrayCommand, cx: &mut App) {
    match command {
        TrayCommand::RestoreWindow => {
            if let Err(error) = crate::open_workspace(cx, |_, _| {}) {
                log::error!("could not restore workspace from notification area: {error:#}");
            }
            cx.activate(true);
        }
        TrayCommand::QuitApp => {
            crate::quit::request(cx);
        }
    }
}
