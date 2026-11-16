//! K5's entry template editor. No v2.2 template routes are registered here.
pub mod model;
pub mod preview;
mod view;

use dr_shell::{nav::Target, pages::ModulePage, strings::t, v3::Rendered, workspace::FillPlace};
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
    dr_shell::v3::add_compact_template_editor(cx, |host, id, full, window, cx| {
        let template = host.book.v3()?.template(id)?.clone();
        let editor =
            cx.new(|cx| TemplateEditor::new(host, Some(template), window, cx).compact(full));
        Some(Rendered::new(editor))
    });
    dr_shell::v3::add_template_creator(cx, |host, _, cx| {
        let Some(shell) = host.workspace.upgrade() else {
            return;
        };
        let compact = shell.read(cx).is_filled(FillPlace::Left);
        let draft = TemplateEditor::new_draft(cx);
        let book = host.book_id.clone();
        let library = host.library.clone();
        let job = cx
            .background_executor()
            .spawn(async move { model::save(&library, &book, None, &draft) });
        cx.spawn(async move |cx| {
            let result = job.await;
            let _ = host.workspace.update(cx, |ws, cx| {
                if ws.book_id != host.book_id
                    || !ws.library.as_ref().is_some_and(|library| {
                        std::ptr::eq(library.library(), host.library.library())
                    })
                {
                    return;
                }
                match result {
                    Ok(template) => {
                        if let Ok(id) = template.id.parse() {
                            ws.template_created(id, compact, cx);
                        }
                    }
                    Err(_) => {
                        ws.toast(t(cx, dr_i18n::keys::common::SAVE_FAILED), cx);
                    }
                }
            });
        })
        .detach();
    });
}
