//! K5's entry template editor. No v2.2 template routes are registered here.
pub mod model;
pub mod preview;
mod view;

use dr_shell::{nav::Target, pages::ModulePage, v3::Rendered, workspace::FillPlace};
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
    dr_shell::v3::add_compact_template_editor(cx, |host, window, cx| {
        let template = match &host.template {
            Some(id) => Some(host.page.book.v3()?.template(id)?.clone()),
            None => None,
        };
        let page = host.page.clone();
        let editor = cx.new(|cx| TemplateEditor::new(page, template, window, cx).compact(host));
        let kept = editor.clone();
        Some(Rendered::new(editor).on_leave(move |cx| {
            // After the shell is done taking the panel away.
            let editor = kept.clone();
            cx.defer(move |cx| editor.update(cx, |editor, cx| editor.settle(cx)));
        }))
    });
    // 「新建模板」 (`kernel-v5.md` §9). While the left column fills, the
    // structure's floating panel; otherwise the full editor. Either way the
    // template is stored only once the author changes something in it, so
    // closing it untouched leaves nothing behind.
    dr_shell::v3::add_template_creator(cx, |host, window, cx| {
        let Some(shell) = host.workspace.upgrade() else {
            return;
        };
        if shell.read(cx).is_filled(FillPlace::Left) {
            shell.update(cx, |ws, cx| ws.new_template_in_structure(window, cx));
            return;
        }
        let editor = cx.new(|cx| TemplateEditor::new(host, None, window, cx));
        let focus = editor.focus_handle(cx);
        window.focus(&focus, cx);
        dr_shell::dialogs::show_in(window.window_handle(), cx, editor.into());
    });
}
