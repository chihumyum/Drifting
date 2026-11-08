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
use gpui::{App, AppContext as _, IntoElement as _, SharedString, Window};

use crate::first_run::{self, Done, FirstRun, FolderSource, FolderStep};
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

/// M40's folder for the first run's step.
struct ShellFolder;

impl FolderSource for ShellFolder {
    fn chosen(&self, cx: &App) -> Option<SharedString> {
        dr_shell::mirror::folder(cx).map(|f| f.display().to_string().into())
    }

    fn choose(&self, window: &mut Window, cx: &mut App) {
        let picked = cx.prompt_for_paths(gpui::PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: None,
        });
        let handle = window.window_handle();
        cx.spawn(async move |cx| {
            let Ok(Ok(Some(paths))) = picked.await else {
                return;
            };
            if let Some(folder) = paths.into_iter().next() {
                cx.update(|cx| {
                    dr_shell::mirror::set_folder(folder, cx);
                    handle.update(cx, |_, window, _| window.refresh()).ok();
                });
            }
        })
        .detach();
    }

    fn turn_off(&self, done: Done, window: &mut Window, cx: &mut App) {
        let handle = window.window_handle();
        dr_shell::mirror::ask_turn_off_then(cx, move |cx| {
            let done = done.clone();
            handle.update(cx, |_, window, cx| done(window, cx)).ok();
        });
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
    first_run::add_step(cx, |_, cx| {
        let answered = dr_shell::mirror::folder(cx).is_some() || !dr_shell::mirror::is_on(cx);
        (!answered)
            .then(|| Rc::new(FolderStep::new(Rc::new(ShellFolder))) as Rc<dyn first_run::Step>)
    });
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
