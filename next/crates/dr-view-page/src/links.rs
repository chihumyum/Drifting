//! G1's mounted editor navigation. Async block lookup retains the originating
//! library/book and checks them again before opening a versioned shell URL.
use gpui::App;

pub fn init(cx: &mut App) {
    dr_editor::links::set_clipboard_refusal(cx, |cx| {
        dr_shell::workspace::with_workspace(cx, |ws, _, cx| {
            let text = dr_shell::t(cx, dr_i18n::keys::k4_pages::SAVE_FAILED);
            ws.toast(text, cx);
        });
    });
    dr_editor::links::set_v3_opener(cx, |library, book, link, cx| {
        if dr_shell::release::is_releasing(cx) {
            return;
        }
        let library = library.clone();
        let book = book.to_owned();
        let scope = std::ptr::from_ref(library.library()) as usize;
        let window = dr_shell::workspace::active_workspace(cx);
        let resolved = cx.background_executor().spawn(async move {
            dr_editor::v3_link::resolve(&library, &book, &link).map(|address| (book, address))
        });
        cx.spawn(async move |cx| {
            let Ok((book, address)) = resolved.await else {
                return;
            };
            let Some(window) = window else {
                return;
            };
            cx.update(|cx| {
                dr_shell::workspace::update_workspace(window, cx, move |ws, window, cx| {
                    if dr_shell::release::is_releasing(cx)
                        || ws.book_id != book
                        || ws
                            .library
                            .as_ref()
                            .is_none_or(|lib| std::ptr::from_ref(lib.library()) as usize != scope)
                    {
                        return;
                    }
                    let href = address.format("drifting");
                    ws.open_link(&href, window, cx);
                })
            });
        })
        .detach();
    });
}
