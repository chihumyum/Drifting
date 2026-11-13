//! K5's entry template editor. No v2.2 template routes are registered here.
pub mod model;
pub mod preview;
mod view;

use dr_shell::{nav::Target, pages::ModulePage};
use gpui::{App, AppContext as _, Focusable as _};
pub use view::TemplateEditor;

pub fn init(cx: &mut App) {
    dr_shell::pages::add_page_view(cx, |target, host, window, cx| {
        let Target::Template(id) = target else {
            return None;
        };
        let template = host.book.v3()?.template(id.as_str())?.clone();
        let editor = cx.new(|cx| TemplateEditor::new(host, Some(template), window, cx));
        let focus = editor.focus_handle(cx);
        Some(ModulePage {
            view: editor.into(),
            focus,
        })
    });
    dr_shell::v3::add_template_creator(cx, |host, window, cx| {
        let editor = cx.new(|cx| TemplateEditor::new(host, None, window, cx));
        let focus = editor.focus_handle(cx);
        window.focus(&focus, cx);
        dr_shell::dialogs::show_in(window.window_handle(), cx, editor.into());
    });
}
