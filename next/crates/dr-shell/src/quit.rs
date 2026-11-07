//! Quitting.
//!
//! GPUI on macOS only hooks `applicationWillTerminate`, and gives the quit
//! callbacks 200 ms in all (`SHUTDOWN_TIMEOUT`); `app.run` never returns, so
//! nothing in `main` is dropped. So the work happens before the quit:
//!
//! 1. [`request`] (⌘Q, the menu) runs every hook registered with
//!    [`before_quit`] (F2/F3's saving and the hand-over, sync's last push),
//!    then writes the settings file, then calls `cx.quit()`;
//! 2. the quit callback itself only sends queued crash reports, waiting at
//!    most 100 ms (f7-platform.md, 「退出时能做多少」).
//!
//! A quit the system starts (log out, the Dock's Quit) skips step 1. Every
//! commit is on disk already (simplifications.md, section 1, item 6) and the
//! settings file is written 300 ms after each change, so at most that much
//! of a layout change is lost.

use std::time::Duration;

use gpui::{App, Global};

use crate::{Services, Settings};

/// The longest the quit callback waits for crash reports.
pub const CRASH_FLUSH: Duration = Duration::from_millis(100);

type Hook = Box<dyn FnMut(&mut App)>;

#[derive(Default)]
struct Hooks(Vec<Hook>);

impl Global for Hooks {}

/// Runs `hook` when the author quits, before the app goes.
pub fn before_quit(cx: &mut App, hook: impl FnMut(&mut App) + 'static) {
    cx.default_global::<Hooks>().0.push(Box::new(hook));
}

/// Saves, hands over, then quits. Runs once the current dispatch is over:
/// ⌘Q arrives while a window is checked out, and saving needs every window.
pub fn request(cx: &mut App) {
    cx.defer(run);
}

fn run(cx: &mut App) {
    let mut hooks = std::mem::take(&mut cx.default_global::<Hooks>().0);
    for hook in &mut hooks {
        hook(cx);
    }
    cx.default_global::<Hooks>().0 = hooks;
    crate::workspace::save_all_layouts(cx);
    Settings::flush(cx);
    cx.quit();
}

pub(crate) fn install(cx: &mut App) {
    cx.on_app_quit(|cx| {
        if let Some(reports) = cx
            .try_global::<Services>()
            .and_then(|s| s.crash_reports.as_ref())
        {
            reports.flush(CRASH_FLUSH);
        }
        async {}
    })
    .detach();
}
