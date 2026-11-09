//! V3 manuscript page: every active body module, in manuscript tree order.
use dr_editor::BookEditor;
use dr_shell::pages::{ModulePage, PageEditorRef, PageHost, PageViewHost};
use gpui::{prelude::*, *};
use std::rc::Rc;

pub struct WholeBook {
    host: PageViewHost,
    focus: FocusHandle,
    editor: Option<Entity<BookEditor>>,
    loading: Option<Task<()>>,
    failed: bool,
    _links: Option<Subscription>,
}

pub fn register(cx: &mut App) {
    dr_shell::pages::add_page_view(cx, |target, host, window, cx| {
        if *target != dr_shell::nav::Target::Book || host.book.v3().is_none() {
            return None;
        }
        let view = cx.new(|cx| WholeBook::new(host, window, cx));
        Some(ModulePage {
            focus: view.read(cx).focus.clone(),
            view: view.into(),
        })
    });
}

impl WholeBook {
    pub fn new(host: PageViewHost, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus = cx.focus_handle();
        cx.on_focus(&focus, window, |v, window, cx| v.focus_editor(window, cx))
            .detach();
        let mut view = Self {
            host,
            focus,
            editor: None,
            loading: None,
            failed: false,
            _links: None,
        };
        view.load(window, cx);
        view
    }

    pub fn editor(&self) -> Option<Entity<BookEditor>> {
        self.editor.clone()
    }

    fn focus_editor(&self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(e) = &self.editor {
            let prose = e.read(cx).editor().clone();
            window.defer(cx, move |window, cx| {
                prose.focus_handle(cx).focus(window, cx)
            });
        }
    }

    fn load(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.failed = false;
        let host = self.host.clone();
        let prepared =
            cx.background_spawn(async move { BookEditor::prepare(&host.library, &host.book_id) });
        self.loading = Some(cx.spawn_in(window, async move |this, cx| {
            let ready = prepared.await;
            this.update_in(cx, |v, window, cx| {
                v.loading = None;
                match ready {
                    Ok(prepared) => {
                        let settings = dr_shell::workspace::editors::editor_settings(cx);
                        let editor = cx.new(|cx| {
                            BookEditor::with_prepared(
                                v.host.library.clone(),
                                prepared,
                                settings,
                                window,
                                cx,
                            )
                        });
                        let host = PageHost {
                            workspace: v.host.workspace.clone(),
                            library: v.host.library.clone(),
                            book: v.host.book_id.clone(),
                            editor: PageEditorRef::Book(editor.downgrade()),
                        };
                        let theme = dr_ui::Theme::of(window, cx);
                        let base = dr_shell::workspace::editors::base_style(&theme);
                        let looks = dr_shell::workspace::editors::decor_looks(&theme, &base);
                        editor.update(cx, |e, cx| {
                            use dr_i18n::keys::k4_pages as k;
                            let labels = [k::BODY, k::H1, k::H2, k::H3, k::QUOTE, k::RULE]
                                .map(|k| dr_shell::t(cx, k));
                            let entries = dr_shell::t(cx, k::ENTRIES);
                            e.assist().update(cx, |a, _| {
                                a.set_block_labels(labels);
                                a.set_entry_label(entries);
                            });
                            e.set_base_style(base, cx);
                            e.set_decor_looks(looks, cx);
                            e.set_chrome(Some(Rc::new(crate::Chrome::new(host))), cx);
                        });
                        let assist = editor.read(cx).assist().clone();
                        v._links = Some(crate::v3::bind_links(&assist, &v.host, window, cx));
                        v.editor = Some(editor);
                        if v.focus.is_focused(window) {
                            v.focus_editor(window, cx);
                        }
                    }
                    Err(error) => {
                        log::warn!("v3 manuscript: {error}");
                        v.failed = true;
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }
}

impl Focusable for WholeBook {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}
impl Render for WholeBook {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("v3-whole-book")
            .track_focus(&self.focus)
            .size_full()
            .min_h_0()
            .children(self.editor.clone())
            .when(self.failed, |d| {
                d.child(dr_shell::t(cx, dr_i18n::keys::markdown_share::LOAD_FAILED))
                    .child(
                        dr_ui::components::Button::new(
                            "retry-book",
                            dr_shell::t(cx, dr_i18n::keys::markdown_share::RETRY),
                        )
                        .on_click(cx.listener(|v, _, w, cx| v.load(w, cx))),
                    )
            })
    }
}
