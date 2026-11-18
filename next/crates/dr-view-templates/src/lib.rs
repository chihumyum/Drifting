//! K5's entry template editor. No v2.2 template routes are registered here.
pub mod model;
pub mod preview;
mod view;

use dr_shell::{nav::Target, pages::ModulePage, strings::t, v3::Rendered, workspace::FillPlace};
use gpui::{App, AppContext as _, Focusable as _};
pub use view::{TemplateEditor, type_label};

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
    // structure's floating panel with a new template that is stored only
    // once the author changes something in it. Otherwise (the left foot of
    // a column that does not fill) the template is stored at once and its
    // full editor opens in a new pill: a pill stands for a stored template.
    dr_shell::v3::add_template_creator(cx, |host, window, cx| {
        let Some(shell) = host.workspace.upgrade() else {
            return;
        };
        if shell.read(cx).is_filled(FillPlace::Left) {
            shell.update(cx, |ws, cx| ws.new_template_in_structure(window, cx));
            return;
        }
        let draft = TemplateEditor::new_draft(cx);
        let book = host.book_id.clone();
        let library = host.library.clone();
        let job = cx
            .background_executor()
            .spawn(async move { library.create_entry_template_draft(&book, draft) });
        cx.spawn(async move |cx| {
            match job.await {
                Ok(template) => {
                    let initial = template.clone();
                    let opened = host.workspace.update(cx, |ws, cx| {
                        if ws.book_id != host.book_id
                            || !ws.library.as_ref().is_some_and(|library| {
                                std::ptr::eq(library.library(), host.library.library())
                            })
                        {
                            return false;
                        }
                        ws.template_created(template, cx);
                        true
                    });
                    // The window can leave the project before the draft write lands.
                    if !matches!(opened, Ok(true)) {
                        let result = cx
                            .background_executor()
                            .spawn(
                                async move { host.library.discard_entry_template_draft(initial) },
                            )
                            .await;
                        if result.is_err() {
                            let _ = host.workspace.update(cx, |ws, cx| {
                                ws.toast_error(t(cx, dr_i18n::keys::common::SAVE_FAILED), cx);
                            });
                        }
                    }
                }
                Err(_) => {
                    let _ = host.workspace.update(cx, |ws, cx| {
                        ws.toast_error(t(cx, dr_i18n::keys::common::SAVE_FAILED), cx);
                    });
                }
            }
        })
        .detach();
    });
}
