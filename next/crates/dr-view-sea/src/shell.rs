//! M24 in the shell (m24-sea.md, 「怎么接」): the app calls [`init`] once,
//! after `dr_shell::init`.
//!
//! - The sea under every window: `dr_shell::pages::set_backdrop` (drawn
//!   first, held by the bookshelf and the full-window waits, ebbing under
//!   the workspace with the sidebars and the Bottom Panel as bare glass).
//! - The first run over the bookshelf (`set_first_run`), with M40's
//!   Markdown folder step while this device has no folder chosen and has not
//!   turned it off.
//! - The workspace tour (`set_guide`): the shell marks its controls under
//!   `dr_shell::pages::anchors`, the device remembers what it has seen
//!   (`guides.seen`, a device value).

use std::rc::Rc;

use dr_shell::Settings;
use dr_shell::pages::{self, Backdrop, FirstRunPage, Guide, SeaHold};
use gpui::{App, AppContext as _, IntoElement as _};

use crate::first_run::FirstRun;
use crate::{HoldKind, Mode, Sea, SeaGlass, char_sea, on_sea, tour};

/// The device value listing the guides this device has shown.
pub const SEEN_KEY: &str = "guides.seen";

/// What this device has seen, in the shell's device values.
struct DeviceSeen;

fn seen(cx: &App) -> Vec<String> {
    Settings::device_memory(cx, SEEN_KEY)
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

impl tour::SeenStore for DeviceSeen {
    fn is_seen(&self, guide: &str, cx: &App) -> bool {
        seen(cx).iter().any(|g| g == guide)
    }

    fn mark_seen(&self, guide: &str, cx: &mut App) {
        let mut all = seen(cx);
        if !all.iter().any(|g| g == guide) {
            all.push(guide.to_owned());
            Settings::set_device_memory(cx, SEEN_KEY, Some(all.into()));
        }
    }

    fn reset(&self, cx: &mut App) {
        Settings::set_device_memory(cx, SEEN_KEY, None);
    }
}

/// Registers the sea, the first run and the tour with the shell.
pub fn init(cx: &mut App) {
    tour::init(cx);
    tour::set_seen_store(cx, DeviceSeen);
    pages::set_backdrop(
        cx,
        Backdrop {
            draw: Rc::new(|window, cx| char_sea(&Sea::of(window, cx)).into_any_element()),
            hold: Rc::new(|kind, window, cx| {
                let kind = match kind {
                    SeaHold::Surface => HoldKind::Surface,
                    SeaHold::Loading => HoldKind::Loading,
                };
                Box::new(Sea::of(window, cx).hold(kind, window))
            }),
            ebbing: Rc::new(|window, cx| Sea::of(window, cx).mode() == Mode::Ebb),
            on_sea: Rc::new(|id, el| {
                on_sea(id, SeaGlass::bare(0.0).hover(false), el).into_any_element()
            }),
        },
    );
    pages::set_first_run(cx, |done, window, cx| {
        let view = cx.new(|cx| FirstRun::new(window, cx, move |window, cx| done(window, cx)));
        let shows = view.downgrade();
        FirstRunPage {
            view: view.into(),
            shows_shelf: Rc::new(move |cx| {
                shows.upgrade().is_none_or(|run| run.read(cx).shows_shelf())
            }),
        }
    });
    pages::set_guide(
        cx,
        Guide {
            anchor: Rc::new(|id, el| tour::anchor(id, el).into_any_element()),
            start: Rc::new(|window, cx| {
                tour::maybe_start(window, cx);
            }),
            layer: Rc::new(tour::layer),
            reset: Rc::new(tour::reset_seen),
        },
    );
}
