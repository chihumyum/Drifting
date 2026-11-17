//! The first-run Markdown folder step plugs into the existing welcome flow.

use dr_view_sea::first_run::{self, Done, FolderSource, FolderStep, Step};
use gpui::{App, SharedString, Window};
use std::rc::Rc;

struct FolderPicker;

impl FolderSource for FolderPicker {
    fn chosen(&self, cx: &App) -> Option<SharedString> {
        dr_shell::mirror::folder(cx).map(|path| path.display().to_string().into())
    }

    fn choose(&self, _: &mut Window, cx: &mut App) {
        dr_shell::mirror::choose(cx);
    }

    fn turn_off(&self, done: Done, window: &mut Window, cx: &mut App) {
        let handle = window.window_handle();
        dr_shell::mirror::ask_turn_off_then(cx, move |cx| {
            let done = done.clone();
            let _ = handle.update(cx, |_, window, cx| done(window, cx));
        });
    }
}

pub fn init(cx: &mut App) {
    dr_shell::mirror::init(cx);
    first_run::add_step(cx, |_, cx| {
        (dr_shell::mirror::folder(cx).is_none() && dr_shell::mirror::is_on(cx))
            .then(|| Rc::new(FolderStep::new(Rc::new(FolderPicker))) as Rc<dyn Step>)
    });
}
